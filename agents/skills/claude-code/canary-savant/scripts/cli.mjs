#!/usr/bin/env node
// canary-savant -- order-dependence and isolation detector (Tier-1 static scan).
//
// Phase 1 ships the always-on static "suspect" tier: an AST-lite scan that
// flags the shared-state smells that predict order-dependent tests -- module-
// level mutables written by tests, setup without teardown, mutated process
// singletons, order-coupled names -- with no test execution. The opt-in
// dynamic confirmer (--confirm) lands in a later phase.
//
//   <paths>    files or directories to scan (default: the current directory).
//   --json     emit machine-readable findings instead of human text.
//   --strict   exit 1 when there are findings (default is advisory: exit 0).
//
// Tier-0 in the real sense -- no LLM, no network, no secrets, no dependency on
// any other skill.
//
// Invoked via `canary skills run canary-savant -- [paths] [--json] [--strict]`.

import fs from 'node:fs';
import { scanPaths, toJson } from './scanner.mjs';
import { confirm, locatePolluters, realPolluterSeams } from './runner.mjs';
import { RULES } from './rules.mjs';
import {
  createParser,
  formatUsageError,
  EXIT_USAGE,
} from '../../../lib/parse-args.mjs';

export const SCHEMA_VERSION = 1;

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

const PREFIX = 'canary-savant:';

// The rules block is GENERATED from RULES, never hand-typed, so a new rule
// appears in --help the moment it is registered.
const USAGE =
  'usage: canary-savant [-h] [--json] [--strict] [--confirm] [--seed N] [--]\n' +
  '                     [path ...]\n' +
  '\n' +
  'Order-dependence and isolation detector: flags the shared-state smells that\n' +
  'predict order-dependent tests, and optionally confirms them dynamically.\n' +
  '\n' +
  'positional arguments:\n' +
  '  path        files or directories to scan (default: the current directory)\n' +
  '\n' +
  'options:\n' +
  '  -h, --help  show this help message and exit\n' +
  '  --json      emit machine-readable findings instead of human text\n' +
  '  --strict    exit 1 when there are findings (default is advisory: exit 0)\n' +
  '  --confirm   run the opt-in Tier-2 dynamic confirmer (executes the suite)\n' +
  '  --seed N    shuffle seed for --confirm (default: random)\n' +
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
// the actionable total - the pattern canary-blackhawk (#393) and the
// PR-guardian sticky comment use.
function suppressedNote(result) {
  const n = result.suppressed ?? 0;
  return n ? `\n${n} suppressed (inline savant-ignore).` : '';
}

function renderText(result) {
  const count = result.findings.length;
  const files = result.filesScanned;
  const fp = files === 1 ? '' : 's';
  // #508: zero suspects over zero scanned files is an ABSENT result, not a
  // clean one. Findings outrank abstention, so this is the no-findings path.
  if (!count && !files) {
    return (
      `${ABSTAINED_LINE} No file matched the given paths, so there is ` +
      'nothing to report. Point at a directory that holds test files, or ' +
      'pass a file directly.'
    );
  }
  if (!count) {
    return (
      `No order-dependence suspects (${files} file${fp} scanned).` +
      suppressedNote(result)
    );
  }
  const sp = count === 1 ? '' : 's';
  const lines = [
    `${count} order-dependence suspect${sp} in ${files} file${fp}:`,
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
 * savant takes paths, so it gets the `--` end-of-options terminator and treats
 * a lone `-` as a positional, as argparse does.
 *
 * `--seed` is the flag that made the shared int type worth having: a bad value
 * used to decay to `Math.floor(Math.random() * 1e6)` at exit 0, silently
 * randomizing the one flag whose entire purpose is reproducibility. The shared
 * parser rejects a non-integer AND an integer past the safe range (#479).
 */
export const CLI_SPEC = {
  prog: 'canary-savant',
  booleans: {
    '--json': 'json',
    '--strict': 'strict',
    '--confirm': 'confirm',
  },
  values: { '--seed': { key: 'seed', type: 'int' } },
  positionals: { key: 'paths', defaults: ['.'] },
};

const parseArgs = createParser(CLI_SPEC);

export function renderConfirm(dyn) {
  if (
    dyn.status === 'no_plugin' ||
    dyn.status === 'baseline_red' ||
    dyn.status === 'unknown_framework'
  ) {
    return `\nTier 2 (dynamic): skipped - ${dyn.message}`;
  }
  const lines = [`\nTier 2 (dynamic): seed ${dyn.seed}`];
  if (!dyn.victims.length) {
    lines.push('  No order-dependence confirmed under this seed.');
  } else {
    let namedAny = false;
    for (const v of dyn.victims) {
      lines.push(`  order-dependent: ${v.victim}`);
      if (v.polluter) {
        lines.push(`    polluted by: ${v.polluter}`);
        if (v.reproduce) lines.push(`    reproduce: ${v.reproduce}`);
        namedAny = true;
      } else if (v.note) {
        lines.push(`    ${v.note}`);
      } else if (v.exhausted) {
        lines.push(
          `    no single culprit isolated; smallest reproducing prefix: ` +
            `${v.minimalPrefix?.length ?? '?'} test(s)`,
        );
      }
    }
    if (!namedAny && dyn.reproduce) {
      lines.push(`  reproduce: ${dyn.reproduce}`);
    }
    if (dyn.framework === 'vitest') {
      lines.push(
        '  (vitest: victims detected; polluter bisect is pytest-only)',
      );
    }
  }
  if (dyn.nondeterministic.length) {
    lines.push(
      `  (${dyn.nondeterministic.length} nondeterministic flake(s) - not order, handed off)`,
    );
  }
  return lines.join('\n');
}

export function main(argv = []) {
  const { positionals: paths, opts, help, error } = parseArgs(argv);

  // Usage and parse errors resolve before any filesystem work, so `--help`
  // never reports a missing path and a typo never half-runs a scan.
  if (help) {
    console.log(USAGE);
    return 0;
  }
  if (error) {
    console.error(formatUsageError(CLI_SPEC.prog, error));
    return EXIT_USAGE;
  }

  for (const entry of paths) {
    if (!fs.existsSync(entry)) {
      console.error(`${PREFIX} path not found: ${entry}`);
      return 1;
    }
  }

  const result = scanPaths(paths);

  let dyn;
  if (opts.confirm) {
    const seed = Number.isFinite(opts.seed)
      ? opts.seed
      : Math.floor(Math.random() * 1e6);
    dyn = confirm(paths, { seed });
    // Phase 3: name the polluter behind each confirmed victim. pytest only -
    // vitest has no CLI-driven ordered per-test execution, so it gets victim
    // detection (Phase 2) but not polluter bisection.
    if (
      dyn.status === 'ok' &&
      dyn.victims.length &&
      dyn.framework === 'pytest'
    ) {
      dyn.victims = locatePolluters(
        dyn.victims,
        dyn.order,
        realPolluterSeams(paths),
      );
    }
  }

  if (opts.json) {
    const payload = {
      schema_version: SCHEMA_VERSION,
      findings: result.findings.map(toJson),
      summary: summary(result),
    };
    if (dyn) {
      payload.dynamic = {
        status: dyn.status,
        seed: dyn.seed,
        victims: dyn.victims,
        nondeterministic: dyn.nondeterministic,
        reproduce: dyn.reproduce,
        ...(dyn.message ? { message: dyn.message } : {}),
      };
    }
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(renderText(result) + (dyn ? renderConfirm(dyn) : ''));
  }

  const hasViolation =
    result.findings.length > 0 || (dyn?.victims.length ?? 0) > 0;
  // Advisory by default (D3); --strict inherits EXIT_ABSTAINED (3) on a
  // collapsed denominator, distinct from 1 ("found something real").
  if (opts.strict && !result.filesScanned) return 3;
  return opts.strict && hasViolation ? 1 : 0;
}

// Direct execution (the skill runner execs this file via its shebang).
//
// `process.exitCode`, not `process.exit()`: a large `--json` payload exceeds
// the pipe buffer, and `process.exit` tears the process down mid-write, leaving
// truncated JSON that still exits 0 (#791).
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2));
}
