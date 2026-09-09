#!/usr/bin/env node
// canary-cassandra -- vacuous-test detection (#755).
//
// Finds tests that PASS WITHOUT PROVING ANYTHING: an assertion that compares a
// value with itself (VAC-001), a test that never invokes the target it claims
// to cover (VAC-002), and a test whose every assertion is an absence observed
// on a bystander (VAC-003).
//
//   <paths>    files or directories to scan (default: the current directory).
//   --json     emit machine-readable findings instead of human text.
//   --strict   exit 1 when there are findings (default is advisory: exit 0).
//
// Deterministic: no LLM, no network, no test execution. The rules themselves
// live in the engine (`core/vacuity-scanner`), which is also what `canary
// vacuity-check` and the promotion gate run -- see engine.mjs for why this one
// skill delegates where its three siblings self-host.
//
// Invoked via `canary skills run canary-cassandra -- [paths] [--json] [--strict]`.

import fs from 'node:fs';

import {
  createParser,
  formatUsageError,
  EXIT_USAGE,
} from '../../../lib/parse-args.mjs';
import { loadEngine } from './engine.mjs';

export const SCHEMA_VERSION = 1;

const PREFIX = 'canary-cassandra:';

/** Reserved CLI-wide: exit 3 means "abstained -- verified zero items". */
const EXIT_ABSTAINED = 3;

// U+2192 written as an escape so this source stays ASCII, matching the family.
const ARROW = '\u{2192}';

const USAGE =
  'usage: canary-cassandra [-h] [--json] [--strict] [--] [path ...]\n' +
  '\n' +
  'Vacuous-test detection: finds tests that pass without proving anything.\n' +
  '\n' +
  'positional arguments:\n' +
  '  path        files or directories to scan (default: the current directory)\n' +
  '\n' +
  'options:\n' +
  '  -h, --help  show this help message and exit\n' +
  '  --json      emit machine-readable findings instead of human text\n' +
  '  --strict    exit 1 when there are findings (default is advisory: exit 0)\n' +
  '\n' +
  'rules:\n' +
  '  VAC-001 (critical)  assertion compares a value with itself\n' +
  '  VAC-002 (warning)   the test never invokes the target it covers\n' +
  '  VAC-003 (warning)   every assertion is an absence, on a bystander\n' +
  '\n' +
  'The denominator is TESTS read, not files. A zero denominator exits 3 under\n' +
  '--strict; it is never reported as a clean scan.';

/**
 * The `--` terminator and a lone `-` come with declaring positionals, so a file
 * literally named `--json` stays reachable. Shared with the other skill CLIs
 * via `lib/parse-args.mjs`; `test/skill-cli-conformance.test.ts` asserts this
 * export exists so a hand-rolled parser cannot land.
 */
export const CLI_SPEC = {
  prog: 'canary-cassandra',
  booleans: { '--json': 'json', '--strict': 'strict' },
  positionals: { key: 'paths', defaults: ['.'] },
};

const parseArgs = createParser(CLI_SPEC);

// Resolved once, at load, so `main` stays synchronous like every sibling's --
// the conformance suite calls `main(argv)` and reads a number back. A failed
// resolution is carried, not thrown: `--help` must answer even with no engine.
const ENGINE = await loadEngine();

/** Every test file the given paths contribute, de-duplicated and ordered. */
function collectFiles(paths, engine) {
  const seen = new Set();
  const files = [];
  for (const entry of paths) {
    const found = engine.isDir(entry)
      ? engine.collectTestFiles(entry)
      : [entry];
    for (const file of found) {
      if (seen.has(file)) continue;
      seen.add(file);
      files.push(file);
    }
  }
  return files;
}

/** Run the engine scanner over each file, accumulating one gate result. */
function scanFiles(files, engine) {
  const findings = [];
  const skipped = [];
  let checked = 0;
  for (const file of files) {
    const r = engine.scanVacuity(file);
    checked += r.checked;
    findings.push(...r.findings);
    if (r.skipped) skipped.push(...r.skipped);
  }
  return { checked, findings, skipped };
}

/** The sibling finding envelope, plus the two fields only cassandra has. */
function toJson(f) {
  return {
    file: f.file,
    line: f.line,
    rule_id: f.rule,
    severity: f.severity,
    // `snippet` in the sibling envelope is "the locus, in one line". For a
    // vacuity finding that is the test, not the source line: the defect is the
    // test as a whole, and a single line of it reads as a lint hit.
    snippet: f.test,
    why: f.message,
    suggestion: f.suggestion,
    fidelity: f.fidelity ?? null,
  };
}

function summary(result, filesScanned, outcome) {
  const bySeverity = {};
  for (const f of result.findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
  }
  return {
    files_scanned: filesScanned,
    // The denominator that matters. A healthy `files_scanned` over zero tests
    // is the subtler zero, and the one a file-counting scanner prints a clean
    // tick on.
    tests_checked: result.checked,
    abstained: outcome.abstained,
    findings: result.findings.length,
    by_severity: bySeverity,
    skipped: result.skipped.length,
  };
}

function renderText(result, outcome) {
  const lines = [];
  for (const f of result.findings) {
    const tier = f.fidelity ? ` [${f.fidelity}]` : '';
    lines.push(
      `[${f.severity.toUpperCase()}] ${f.file}:${f.line} (${f.rule})${tier}`,
    );
    lines.push(`  ${f.test}: ${f.message}`);
    lines.push(`  ${ARROW} ${f.suggestion}`);
    lines.push('');
  }
  lines.push(outcome.summaryLine);
  if (outcome.abstained) {
    lines.push(
      'No test was read, so nothing here is proven. Point at a directory ' +
        'holding test files, or pass one directly.',
    );
  } else if (!result.findings.length) {
    lines.push(
      'Advisory by default. Re-run with --strict to fail on findings.',
    );
  }
  return lines.join('\n');
}

/** Exit 1 with a named reason. "Cannot verify" is a finding, not a skip. */
function fail(message) {
  console.error(`${PREFIX} ${message}`);
  return 1;
}

/** Emit the result in the caller's mode. */
function report(result, files, outcome, json) {
  if (!json) {
    console.log(renderText(result, outcome));
    return;
  }
  console.log(
    JSON.stringify(
      {
        schema_version: SCHEMA_VERSION,
        findings: result.findings.map(toJson),
        skipped: result.skipped,
        summary: summary(result, files.length, outcome),
      },
      null,
      2,
    ),
  );
}

/**
 * Scan the given paths.
 *
 * Returns the scan plus its gate outcome, or a numeric exit code when nothing
 * could be scanned at all -- an unresolvable engine and a missing path are
 * FAILURES, never a clean result with an empty finding list.
 */
function scan(paths) {
  if (!ENGINE.ok) return fail(ENGINE.error);
  for (const entry of paths) {
    if (!fs.existsSync(entry)) return fail(`path not found: ${entry}`);
  }
  const files = collectFiles(paths, ENGINE);
  const result = scanFiles(files, ENGINE);
  if (files.length === 0) {
    result.skipped.push({
      name: paths.join(', '),
      reason: `no test file matched (looked for ${ENGINE.SCANNABLE_DESC})`,
    });
  }
  // The same helper the engine's own surfaces use, rather than a hand-copied
  // abstention line: this CLI already imports the engine, so the doctrine is
  // enforced by the code instead of by convention.
  const outcome = ENGINE.gateOutcome(
    {
      checked: result.checked,
      findings: result.findings,
      skipped: result.skipped,
    },
    'advisory',
    { noun: 'test(s)' },
  );
  return { files, result, outcome };
}

export function main(argv = []) {
  const { positionals: paths, opts, help, error } = parseArgs(argv);

  // Usage resolves before any filesystem or engine work, so `--help` answers
  // even in an install where the engine never resolved.
  if (help) {
    console.log(USAGE);
    return 0;
  }
  if (error) {
    console.error(formatUsageError(CLI_SPEC.prog, error));
    return EXIT_USAGE;
  }

  const scanned = scan(paths);
  if (typeof scanned === 'number') return scanned;
  const { files, result, outcome } = scanned;
  report(result, files, outcome, opts.json);

  // Advisory by default (D3): findings are loud, the exit is not. Under
  // --strict the exit-code contract applies, and a collapsed denominator takes
  // EXIT_ABSTAINED (3) -- distinct from 1, "found something real".
  if (!opts.strict) return 0;
  if (outcome.abstained) return EXIT_ABSTAINED;
  return result.findings.length ? 1 : 0;
}

// Direct execution (the skill runner execs this file via its shebang).
//
// `process.exitCode` rather than `process.exit()`: a `--json` payload over a
// large suite exceeds the pipe buffer, and `process.exit` tears the process
// down mid-write, truncating it to ~64KB. Truncated JSON that still exits 0 is
// a machine-readable result a consumer cannot parse but a shell reads as
// success -- the exact class of quiet failure the whole family guards against.
// Setting the code lets node drain stdout and exit with the same status.
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2));
}
