/**
 * Reading a `harness check-perf` report, and the abstentions that guard it.
 *
 * Split out of `perf-ratchet.mjs` (#850): once identity comparison landed, that
 * script tripped its own file-length and complexity thresholds — the gate
 * caught its own change, which is exactly the behaviour #850 argued for. These
 * are the primitives that turn report text into a number, plus the two guards
 * that refuse to turn an unmeasured run into a zero.
 */

import { readFileSync } from 'node:fs';

/**
 * Below this baseline the implausible-collapse guard switches off: a handful
 * of violations can legitimately clear in one change, and refusing to believe
 * a real zero would make the gate impossible to ever satisfy.
 */
const COLLAPSE_GUARD_MIN_BASELINE = 20;

/**
 * The fraction of the baseline below which a sudden drop reads as a check that
 * stopped measuring rather than a codebase that improved. Deliberately loose:
 * a real paydown is a few percent (296 -> 281 on 2026-08-13), so removing
 * three quarters of the findings in one step is not a paydown.
 */
const COLLAPSE_RATIO = 0.25;

export function fail(code, message) {
  console.error(message);
  process.exit(code);
}

/**
 * Pull the violation count out of a `harness check-perf` run.
 *
 * Returns the integer count, `0` for an explicit pass line, or `null` when the
 * output matches neither shape — which the caller must treat as an abstention,
 * never as zero. A bare `Validation failed` with no parseable count is `null`
 * too: a header that stopped carrying its denominator is an unmeasured run.
 */
export function violationsFrom(text) {
  const failure = /Validation failed\s*\((\d+)\s+issues?\)/i.exec(text);
  if (failure) return Number.parseInt(failure[1], 10);
  if (/validation passed/i.test(text)) return 0;
  return null;
}

/**
 * Is this drop too steep to be real work? See `COLLAPSE_RATIO`. Only consulted
 * when the baseline is large enough for the question to be meaningful.
 */
export function isImplausibleCollapse(violations, maxViolations) {
  if (maxViolations < COLLAPSE_GUARD_MIN_BASELINE) return false;
  return violations < maxViolations * COLLAPSE_RATIO;
}

/**
 * The raw text of one report, or exit 3. `label` names which side this is —
 * one message for "head produced nothing" and "base produced nothing" is how
 * a delta gate goes dark with nobody able to tell which half. An unreadable
 * report is an ABSTENTION, not an error: the workflow step redirects stdout,
 * so a missing file means check-perf died before writing anything.
 */
export function readReportText(path, label) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    return fail(
      3,
      `perf-ratchet: ABSTAINED — cannot read ${label} report ${path}: ` +
        `${err.message}\nThe check-perf step most likely failed before ` +
        'producing output. Read the step log; do NOT treat an absent report ' +
        'as zero violations.',
    );
  }
}

/**
 * The measured violation count for one side, or exit 3. Every non-numeric
 * path is an ABSTENTION, because each means the check did not measure the
 * codebase: an unparseable report, or a collapse too steep to be real work.
 */
export function readViolations(path, maxViolations, label) {
  const violations = violationsFrom(readReportText(path, label));
  if (violations === null) {
    fail(
      3,
      `perf-ratchet: ABSTAINED — the ${label} perf report has neither a ` +
        '"Validation failed (N issues)" header nor a "validation passed" ' +
        'line, so nothing was measured. This is the #544 shape: the check ' +
        'most likely failed at startup (`Could not resolve entry points` ' +
        'means `performance.entryPoints` went missing from ' +
        'harness.config.json — see ADR 0012). Read the step log; do NOT ' +
        'treat an unparseable report as zero.',
    );
  }

  if (isImplausibleCollapse(violations, maxViolations)) {
    fail(
      3,
      `perf-ratchet: ABSTAINED — ${violations} violations in the ${label} ` +
        `perf report against a baseline of ${maxViolations} is too steep a ` +
        'drop to be real work.\nCheck the invocation FIRST: `check-perf ' +
        '--coupling` and `--size` report "validation passed" over findings ' +
        'they should be reporting, so a narrowed run looks exactly like a ' +
        'clean one. The gate must call a bare `harness check-perf` with no ' +
        'narrowing flag.\nIf the drop is genuine, lower "maxViolations" in ' +
        'the baseline in the same commit that earned it, and this stops firing.',
    );
  }

  return violations;
}
