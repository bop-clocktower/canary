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

/** A well-formed integer literal, sign optional. Used for --seed. */
const INT_RE = /^[+-]?\d+$/;

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
 * Match argparse's contract for the exit paths a hand-rolled loop has to
 * honour: `-h`/`--help` prints usage and exits 0; an unknown flag exits 2. A
 * bare `--` is the end-of-options terminator, after which every token is a
 * path; a lone `-` stays a positional, as argparse treats it.
 */
function parseArgs(argv) {
  const paths = [];
  const opts = {
    json: false,
    strict: false,
    confirm: false,
    seed: undefined,
    help: false,
    error: null,
  };
  let noMoreFlags = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (noMoreFlags) {
      paths.push(arg);
      continue;
    }
    // `--flag=value`, matching canary-instrument and canary-fail-fast so all
    // four ported CLIs accept the same two spellings.
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const inlineFlag = eq !== -1 ? arg.slice(0, eq) : null;

    if (arg === '-h' || arg === '--help') {
      opts.help = true;
      return { paths, opts };
    } else if (arg === '--') noMoreFlags = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--strict') opts.strict = true;
    else if (arg === '--confirm') opts.confirm = true;
    else if (arg === '--seed' || inlineFlag === '--seed') {
      // --seed is a DETERMINISM flag, so every bad spelling has to be loud.
      // `Number(argv[i + 1])` used to yield NaN for BOTH a missing value and a
      // non-numeric one; NaN then failed the `Number.isFinite` guard in main
      // and fell through to `Math.floor(Math.random() * 1e6)` -- the one flag
      // whose whole purpose is reproducibility, silently randomizing at exit 0.
      let raw;
      if (inlineFlag === '--seed') {
        raw = arg.slice(eq + 1); // `--seed=-5` keeps its sign
      } else {
        const next = argv[i + 1];
        // A leading '-' normally means "this is the next flag, not my value",
        // but negative seeds are legitimate -- so a token that is itself a
        // well-formed integer counts as the value. Without this, `--seed -5`
        // died with "expected one argument" (a false statement: an argument
        // WAS supplied) while `--seed=-5` worked, splitting two spellings the
        // SKILL.md calls equivalent.
        if (
          next === undefined ||
          (next.startsWith('-') && !INT_RE.test(next))
        ) {
          opts.error = `argument --seed: expected one argument`;
          return { paths, opts };
        }
        raw = next;
        i += 1;
      }
      // Validate the VALUE, not just its presence: reject anything that is not
      // a finite integer ('abc', '3.7', '1e999', '', '0x10') the way argparse's
      // `type=int` would, instead of letting it decay to a random seed.
      if (!INT_RE.test(raw)) {
        opts.error = `argument --seed: invalid int value: '${raw}'`;
        return { paths, opts };
      }
      // Syntactically an integer is not enough: Number() silently rounds past
      // 2^53-1, so `--seed 9007199254740993` would RUN with ...992 -- the seed
      // used differing from the seed asked for, which is the exact class of
      // lie this flag must not tell. (Bigger values reach 1e26, which
      // runner.mjs interpolates as `--randomly-seed=1e+26` and pytest-randomly
      // rejects at runtime.)
      const parsed = Number(raw);
      if (!Number.isSafeInteger(parsed)) {
        opts.error = `argument --seed: seed out of safe integer range: '${raw}'`;
        return { paths, opts };
      }
      opts.seed = parsed;
    } else if (arg.startsWith('-') && arg !== '-') {
      opts.error = `unrecognized arguments: ${arg}`;
      return { paths, opts };
    } else paths.push(arg);
  }
  return { paths: paths.length ? paths : ['.'], opts };
}

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
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
