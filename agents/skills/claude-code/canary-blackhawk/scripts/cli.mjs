#!/usr/bin/env node
// canary-blackhawk -- temporal-dependency linter for test files.
//
// Statically flags tests that depend on wall-clock time, a real delay, or the
// local timezone: the ones that pass all day and fail at midnight, across a DST
// boundary, or on Feb 29.
//
//   <paths>    files or directories to scan (default: the current directory).
//   --json     emit machine-readable findings instead of human text.
//   --strict   exit 1 when there are findings (default is advisory: exit 0).
//
// Tier-0 deterministic analysis -- no LLM, no network, no secrets, no
// dependency on any other skill.
//
// Invoked via `canary skills run canary-blackhawk -- [paths] [--json] [--strict]`.

import fs from 'node:fs';
import { scanPaths, toJson } from './scanner.mjs';
import { RULES } from './rules.mjs';

export const SCHEMA_VERSION = 1;

const PREFIX = 'canary-blackhawk:';

// --- no-silent-abstention (#508 D2, skill-CLI convention half) ---------------
//
// Skill CLIs are deliberately self-contained -- no engine import, no shared
// module -- so they cannot call `gateOutcome`. They honour the doctrine by
// CONVENTION instead, emitting the same greppable line the engine helper does.
// The skill-layer conformance registry (agents/skills/test/gate-conformance.
// test.ts) is what holds them to it: a row whose fixture collapses the
// denominator and asserts the loud outcome.
//
// U+26A0 / U+2014 are written as escapes so this source stays ASCII, matching
// ts/src/core/gate-result.ts.
const ABSTAINED_LINE =
  '\u{26A0} Abstained \u{2014} verified zero items; this is not a pass.';

// The rules block is GENERATED from RULES, never hand-typed: a new rule shows
// up in --help the moment it is registered, so the help text cannot drift
// behind the linter as rules are added.
const USAGE =
  'usage: canary-blackhawk [-h] [--json] [--strict] [--] [path ...]\n' +
  '\n' +
  'Temporal-dependency linter for test files: flags tests that depend on the\n' +
  'wall clock, a real delay, or the local timezone.\n' +
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
  RULES.map((r) => `  ${r.ruleId} (${r.severity})`).join('\n');

function summary(result) {
  const bySeverity = {};
  for (const f of result.findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
  }
  return {
    files_scanned: result.filesScanned,
    findings: result.findings.length,
    by_severity: bySeverity,
    suppressed: result.suppressed ?? 0,
  };
}

// A trailing "N suppressed" note keeps inline-ignored lines visible but out of
// the actionable total - the pattern the PR-guardian sticky comment uses.
function suppressedNote(result) {
  const n = result.suppressed ?? 0;
  return n ? `\n${n} suppressed (inline blackhawk-ignore).` : '';
}

function renderText(result) {
  const count = result.findings.length;
  const files = result.filesScanned;
  const fp = files === 1 ? '' : 's';
  // #508: zero findings over zero scanned files is an ABSENT result, not a
  // clean one. Findings outrank abstention (a finding proves a file was read),
  // so this is checked only on the no-findings path.
  if (!count && !files) {
    return (
      `${ABSTAINED_LINE} No file matched the given paths, so there is ` +
      'nothing to report. Point at a directory that holds test files, or ' +
      'pass a file directly.'
    );
  }
  if (!count) {
    return (
      `No temporal-dependency findings (${files} file${fp} scanned).` +
      suppressedNote(result)
    );
  }
  const sp = count === 1 ? '' : 's';
  const lines = [
    `${count} temporal-dependency finding${sp} in ${files} file${fp}:`,
    '',
  ];
  for (const f of result.findings) {
    lines.push(`  ${f.file}:${f.line}  [${f.severity}] ${f.ruleId}`);
    lines.push(`      ${f.snippet}`);
    lines.push(`      why: ${f.why}`);
  }
  lines.push('');
  lines.push(
    'Advisory by default. Re-run with --strict to fail the step on findings.',
  );
  return lines.join('\n') + suppressedNote(result);
}

/**
 * Match argparse's contract for the two exit paths a hand-rolled loop has to
 * honour: `-h`/`--help` prints usage and exits 0; an unknown flag exits 2. A
 * bare `--` is the end-of-options terminator, after which every token is a
 * path (so a file literally named `--json` is reachable). A lone `-` stays a
 * positional, as argparse treats it.
 */
function parseArgs(argv) {
  const paths = [];
  const opts = { json: false, strict: false, help: false, error: null };
  let noMoreFlags = false;
  for (const arg of argv) {
    if (noMoreFlags) {
      paths.push(arg);
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      opts.help = true;
      return { paths, opts };
    } else if (arg === '--') noMoreFlags = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--strict') opts.strict = true;
    else if (arg.startsWith('-') && arg !== '-') {
      opts.error = `unrecognized arguments: ${arg}`;
      return { paths, opts };
    } else paths.push(arg);
  }
  return { paths: paths.length ? paths : ['.'], opts };
}

export function main(argv = []) {
  const { paths, opts } = parseArgs(argv);

  // Usage and parse errors resolve before any filesystem work, so `--help`
  // never reports a missing path and a typo never half-runs a scan.
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  if (opts.error) {
    console.error(`${PREFIX} ${opts.error}`);
    return 2;
  }

  for (const entry of paths) {
    if (!fs.existsSync(entry)) {
      console.error(`${PREFIX} path not found: ${entry}`);
      return 1;
    }
  }

  const result = scanPaths(paths);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          schema_version: SCHEMA_VERSION,
          findings: result.findings.map(toJson),
          summary: summary(result),
        },
        null,
        2,
      ),
    );
  } else {
    console.log(renderText(result));
  }

  // Advisory by default (D3). Under --strict the CLI carries an exit-code
  // contract, so a collapsed denominator inherits EXIT_ABSTAINED (3) -- distinct
  // from 1 ("found something real"), so CI can tell them apart.
  if (opts.strict && !result.filesScanned) return 3;
  return opts.strict && result.findings.length ? 1 : 0;
}

// Direct execution (the skill runner execs this file via its shebang).
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
