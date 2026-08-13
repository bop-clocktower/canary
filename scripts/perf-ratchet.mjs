#!/usr/bin/env node
/**
 * Performance ratchet (#717).
 *
 * Reads the output of `harness check-perf` and compares its violation count
 * against the triaged baseline in `.harness/perf-baseline.json`. Above the
 * baseline, the build fails.
 *
 * Why this exists: `check-perf` was referenced by no workflow in
 * `.github/workflows/` at all, so its 237 violations at 8c865b5 protected
 * nothing and its output was not evidence of anything. This is the same wiring
 * `entropy-ratchet.mjs` gave `harness cleanup` in #544 — an absolute ceiling
 * that may fall and never rise — and it is a ratchet rather than strict-at-zero
 * for the same reason: 237 findings is a real backlog, and a gate that blocks
 * every PR on day one gets demoted to advisory within a week, which is how a
 * blocking gate becomes wallpaper.
 *
 * ## Why the parse is defensive
 *
 * `harness cleanup` has `--findings-json` and emits a machine contract line.
 * `check-perf` has no such flag (CLI 11.1.1 offers only `--structural`,
 * `--coupling`, `--size`, `--severity`), so this script parses human-readable
 * output — which has a failure mode the JSON contract does not:
 *
 *     x Validation failed (237 issues)   <- carries its own denominator
 *     v validation passed                <- carries NOTHING
 *
 * A genuinely clean tree prints the second line. So does a run that measured
 * nothing. Measured on the same tree in the same minute at 8c865b5:
 *
 *     harness check-perf              -> x Validation failed (237 issues)
 *     harness check-perf --coupling   -> v validation passed
 *     harness check-perf --size       -> v validation passed
 *
 * The 237 is 209 structural + 26 coupling-ratio + 2 import-count findings.
 * `--structural` correctly reports its 209; `--coupling` reports a *pass* over
 * the 28 findings that are its own subject. The narrowing flags do not narrow
 * the check, they silence it into a green tick. Filed upstream; until it is
 * fixed, the flags are unusable here.
 *
 * This matters concretely rather than theoretically, because scoping the gate
 * to `--coupling` is the obvious way to make check-perf blockable on day one:
 * 28 findings is a tractable backlog and 237 is not. So there are two guards:
 *
 *   1. An IMPLAUSIBLE ZERO is an abstention (see `isImplausibleCollapse`). A
 *      repo carrying a 237-violation baseline does not reach 0 in one PR. A
 *      cliff that steep is the signature of a check that stopped measuring.
 *   2. `ts/test/workflow-false-green.test.ts` asserts the wired invocation
 *      carries no narrowing flag, so the trap cannot be entered upstream of
 *      this script.
 *
 * Neither is sufficient alone: guard 1 goes quiet once the baseline is
 * ratcheted near zero, and guard 2 cannot see an upstream change to what a
 * bare `check-perf` measures.
 *
 * Usage:
 *   harness check-perf > report.txt 2>&1 || true
 *   node scripts/perf-ratchet.mjs --report report.txt
 *
 * Exit codes follow the repo's gate convention (#508):
 *   0 = verified — violations are at or under the baseline
 *   1 = the ratchet fired — violations grew past the baseline
 *   2 = error — the baseline file is missing or unreadable
 *   3 = ABSTENTION — nothing was measured, or the zero is implausible
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASELINE = join(REPO_ROOT, '.harness', 'perf-baseline.json');

/**
 * Slack above which the baseline is stale enough to mention. Not a failure —
 * a codebase that got better should never turn the build red — but an
 * unratcheted ratchet is just a number in a file.
 */
const NUDGE_SLACK = 20;

/**
 * Below this baseline, the implausible-collapse guard switches off entirely.
 * A project carrying a handful of violations can legitimately clear them in
 * one change, and refusing to believe a real zero would make the gate
 * impossible to ever satisfy — the failure mode this whole file exists to
 * avoid, just pointing the other way.
 */
const COLLAPSE_GUARD_MIN_BASELINE = 20;

/**
 * The fraction of the baseline below which a sudden drop reads as a check that
 * stopped measuring rather than a codebase that improved. Deliberately loose:
 * a real paydown lands somewhere in the top of the range (the 2026-08-13
 * entropy paydown moved 296 -> 281, about 5%), so anything that removes three
 * quarters of the findings in one step is not a paydown.
 */
const COLLAPSE_RATIO = 0.25;

function parseArgs(argv) {
  const args = { report: null, baseline: DEFAULT_BASELINE };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--report') args.report = argv[i + 1];
    else if (argv[i] === '--baseline') args.baseline = argv[i + 1];
  }
  return args;
}

/**
 * Pull the violation count out of a `harness check-perf` run.
 *
 * Returns the integer count, `0` for an explicit pass line, or `null` when the
 * output matches neither shape — which the caller must treat as an abstention,
 * never as zero. A bare `Validation failed` with no parseable count is `null`
 * too: a header that stopped carrying its denominator is an unmeasured run.
 */
function violationsFrom(text) {
  const failure = /Validation failed\s*\((\d+)\s+issues?\)/i.exec(text);
  if (failure) return Number.parseInt(failure[1], 10);
  if (/validation passed/i.test(text)) return 0;
  return null;
}

/**
 * Is this drop too steep to be real work? See `COLLAPSE_RATIO`. Only consulted
 * when the baseline is large enough for the question to be meaningful.
 */
function isImplausibleCollapse(violations, maxViolations) {
  if (maxViolations < COLLAPSE_GUARD_MIN_BASELINE) return false;
  return violations < maxViolations * COLLAPSE_RATIO;
}

function fail(code, message) {
  console.error(message);
  process.exit(code);
}

/**
 * The triaged ceiling, or exit 2.
 *
 * Read before the report, deliberately. A broken baseline is an operator error
 * to fix in one file; an unmeasured run is a gate that did not run. Resolving
 * the baseline first keeps a 2 from surfacing as a 3 and sending the reader to
 * the wrong place entirely.
 */
function readBaseline(baseline) {
  let maxViolations;
  try {
    const parsed = JSON.parse(readFileSync(baseline, 'utf8'));
    maxViolations = parsed.maxViolations;
  } catch (err) {
    fail(2, `perf-ratchet: cannot read baseline ${baseline}: ${err.message}`);
  }
  if (!Number.isInteger(maxViolations)) {
    fail(2, `perf-ratchet: ${baseline} has no integer "maxViolations".`);
  }
  return maxViolations;
}

/**
 * The measured violation count, or exit 3.
 *
 * Every path out of here that is not a real number is an ABSTENTION, because
 * every one of them means the check did not measure the codebase: an absent
 * report, an unparseable one, or a collapse too steep to be real work.
 */
function readViolations(report, maxViolations) {
  let text;
  try {
    text = readFileSync(report, 'utf8');
  } catch (err) {
    // Unreadable report is an ABSTENTION, not an error: the step that produces
    // it redirects stdout, so a missing file means check-perf died before
    // writing anything — nothing was measured.
    fail(
      3,
      `perf-ratchet: ABSTAINED — cannot read report ${report}: ${err.message}\n` +
        'The check-perf step most likely failed before producing output. Read ' +
        'the step log; do NOT treat an absent report as zero violations.',
    );
  }

  const violations = violationsFrom(text);
  if (violations === null) {
    fail(
      3,
      'perf-ratchet: ABSTAINED — the report has neither a "Validation failed ' +
        '(N issues)" header nor a "validation passed" line, so nothing was ' +
        'measured. This is the #544 shape: the check most likely failed at ' +
        'startup (`Could not resolve entry points` means `performance.' +
        'entryPoints` went missing from harness.config.json — see ADR 0012). ' +
        'Read the step log; do NOT treat an unparseable report as zero.',
    );
  }

  if (isImplausibleCollapse(violations, maxViolations)) {
    fail(
      3,
      `perf-ratchet: ABSTAINED — ${violations} violations against a baseline ` +
        `of ${maxViolations} is too steep a drop to be real work.\n` +
        'Check the invocation FIRST: `check-perf --coupling` and ' +
        '`--size` report "validation passed" over findings they should be ' +
        'reporting, so a narrowed run looks exactly like a clean one. The ' +
        'gate must call a bare `harness check-perf` with no narrowing flag.\n' +
        'If the drop is genuine, lower "maxViolations" in the baseline in the ' +
        'same commit that earned it, and this stops firing.',
    );
  }

  return violations;
}

/** Compare the measurement to the ceiling and report. Exits 1 when it fires. */
function applyRatchet(violations, maxViolations, baseline) {
  if (violations > maxViolations) {
    fail(
      1,
      `perf-ratchet: FAILED — ${violations} performance violations, baseline ` +
        `is ${maxViolations} (+${violations - maxViolations}).\n` +
        'Either fix the new violations (complexity, nesting depth, function ' +
        'and file length, coupling ratio, import count) or split the file ' +
        'that grew. Raising "maxViolations" to make this pass is the one move ' +
        'that is never the right one.',
    );
  }

  const headroom = maxViolations - violations;
  console.log(
    `perf-ratchet: OK — ${violations} violations, baseline ${maxViolations} ` +
      `(${headroom} of headroom).`,
  );
  if (headroom > NUDGE_SLACK) {
    console.log(
      `perf-ratchet: violations are ${headroom} under the baseline. Please ` +
        `lower "maxViolations" in ${baseline} to ${violations} so the gate ` +
        'keeps its teeth.',
    );
  }
}

function main() {
  const { report, baseline } = parseArgs(process.argv.slice(2));
  if (!report) fail(2, 'perf-ratchet: --report <file> is required.');

  const maxViolations = readBaseline(baseline);
  const violations = readViolations(report, maxViolations);
  applyRatchet(violations, maxViolations, baseline);
}

main();
