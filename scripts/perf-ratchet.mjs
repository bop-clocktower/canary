#!/usr/bin/env node
/**
 * Performance ratchet (#717).
 *
 * Reads the output of `harness check-perf` and compares its violation count
 * against the triaged baseline in `.harness/perf-baseline.json`. Above the
 * baseline, the build fails.
 *
 * Why this exists: `check-perf` ran in no workflow, so its 237 violations at
 * 8c865b5 protected nothing. Same wiring `entropy-ratchet.mjs` gave `harness
 * cleanup` in #544 — a ceiling that may fall and never rise — and a ratchet
 * rather than strict-at-zero because a gate that blocks every PR on day one
 * gets demoted to advisory within a week.
 *
 * ## Why the parse is defensive
 *
 * `check-perf` has no `--findings-json`, so this parses human-readable output:
 *
 *     x Validation failed (237 issues)   <- carries its own denominator
 *     v validation passed                <- carries NOTHING
 *
 * A clean tree prints the second line. So does a run that measured nothing —
 * and so do `--coupling` and `--size`, which report a pass over the findings
 * that are their own subject (ADR 0014). Hence two guards, neither sufficient
 * alone: an IMPLAUSIBLE ZERO is an abstention here (`isImplausibleCollapse`),
 * and `ts/test/workflow-false-green.test.ts` asserts the wired invocation
 * carries no narrowing flag.
 *
 * ## Two rules, not one (#812, porting #703)
 *
 * An absolute ceiling makes headroom a shared, non-renewable budget no branch
 * can see, so two independently-green branches collide and whichever merges
 * second is blamed for violations it did not add. The perf ceiling reached
 * zero headroom on 2026-09-09 (233 measured against 233). When the caller
 * supplies `--base-report` — the same check run against the PR's merge base —
 * this also fails on the delta the branch itself introduced, which is
 * order-independent. The ceiling stays as a BACKSTOP; either rule can fail.
 * The workflow must scan both sides with the same resolved CLI and keep the
 * base worktree outside the checkout; `ts/test/perf-ratchet.test.ts` asserts
 * both against the YAML.
 *
 * Usage:
 *   harness check-perf > report.txt 2>&1 || true
 *   node scripts/perf-ratchet.mjs --report report.txt \
 *     [--base-report base-report.txt] [--cli-version 12.6.0]
 *
 * Exit codes follow the repo's gate convention (#508):
 *   0 = verified — at or under the baseline, and at or under the merge base
 *   1 = the ratchet fired — violations grew past the baseline or the base
 *   2 = error — the baseline file is missing or unreadable
 *   3 = ABSTENTION — nothing was measured on either side, or a zero is
 *       implausible. A base that could not be measured is not a base of zero.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAllowances, requireNoDelta } from './lib/perf-delta.mjs';
import { fail, readViolations } from './lib/perf-report.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASELINE = join(REPO_ROOT, '.harness', 'perf-baseline.json');

/**
 * Slack above which the baseline is stale enough to mention. Never a failure:
 * a codebase that got better must not turn the build red.
 */
const NUDGE_SLACK = 20;

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

function parseArgs(argv) {
  const args = {
    report: null,
    baseReport: null,
    baseline: DEFAULT_BASELINE,
    cliVersion: null,
    reportRoot: null,
    baseReportRoot: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--report') args.report = argv[i + 1];
    else if (argv[i] === '--base-report') args.baseReport = argv[i + 1];
    else if (argv[i] === '--baseline') args.baseline = argv[i + 1];
    else if (argv[i] === '--cli-version') args.cliVersion = argv[i + 1];
    else if (argv[i] === '--report-root') args.reportRoot = argv[i + 1];
    else if (argv[i] === '--base-report-root')
      args.baseReportRoot = argv[i + 1];
  }
  return args;
}

/**
 * The triaged ceiling, or exit 2. Read BEFORE the report: a broken baseline is
 * an operator error to fix in one file, an unmeasured run is a gate that did
 * not run, and resolving the baseline first keeps a 2 from surfacing as a 3.
 */
function readBaseline(baseline) {
  let maxViolations;
  let harnessCli = null;
  let allowances = [];
  try {
    const parsed = JSON.parse(readFileSync(baseline, 'utf8'));
    maxViolations = parsed.maxViolations;
    if (typeof parsed.harnessCli === 'string') harnessCli = parsed.harnessCli;
    allowances = parsed.deltaAllowances ?? [];
  } catch (err) {
    fail(2, `perf-ratchet: cannot read baseline ${baseline}: ${err.message}`);
  }
  if (!Number.isInteger(maxViolations)) {
    fail(2, `perf-ratchet: ${baseline} has no integer "maxViolations".`);
  }
  return {
    maxViolations,
    harnessCli,
    allowances: readAllowances(allowances, baseline),
  };
}

/**
 * Abstain unless the CLI that produced this report is the one the ceiling was
 * calibrated against (#744). The workflows pin a FLOATING major, so the
 * analyzer behind this absolute count changes with no commit here, and the
 * offline guards compare the baseline against itself. Deliberately NOT the
 * collapse guard's job: that catches a detector going dark, this catches an
 * instrument that is merely different — the quieter failure that happened.
 */
function requireMatchingInstrument(harnessCli, cliVersion, maxViolations) {
  if (harnessCli === null || cliVersion === harnessCli) return;
  fail(
    3,
    `perf-ratchet: ABSTAINED — this baseline's ${maxViolations} ceiling was ` +
      `calibrated against harness CLI ${harnessCli}, but ` +
      (cliVersion === null
        ? 'the caller did not say which version produced this report ' +
          '(pass `--cli-version`).'
        : `this report was produced by ${cliVersion}.`) +
      '\nThe measurement is therefore not comparable to the ceiling.\n' +
      'Re-measure in a clean worktree and update "measuredCount" and ' +
      '"harnessCli" in the baseline in the SAME PR. Do not silence this by ' +
      'deleting "harnessCli".',
  );
}

/**
 * The delta rule (#812): fail when this branch adds violations its merge base
 * did not have. Called BEFORE the absolute backstop, because it names what
 * this branch actually did — a branch that inherits an over-ceiling base
 * should read "you added 2" first, not a total it did not cause.
 */

/** Compare the measurement to the ceiling and report. Exits 1 when it fires. */
function applyRatchet(violations, maxViolations, baseline) {
  if (violations > maxViolations) {
    fail(
      1,
      `perf-ratchet: FAILED (absolute backstop) — ${violations} performance ` +
        `violations, baseline is ${maxViolations} ` +
        `(+${violations - maxViolations}).\n` +
        'Either fix the new violations (complexity, nesting depth, function ' +
        'and file length, coupling ratio, import count) or split the file ' +
        'that grew. Raising "maxViolations" is the one move that is never right.',
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
  const {
    report,
    baseReport,
    baseline,
    cliVersion,
    reportRoot,
    baseReportRoot,
  } = parseArgs(process.argv.slice(2));
  if (!report) fail(2, 'perf-ratchet: --report <file> is required.');

  const { maxViolations, harnessCli, allowances } = readBaseline(baseline);
  const violations = readViolations(report, maxViolations, 'head');
  requireMatchingInstrument(harnessCli, cliVersion, maxViolations);
  if (baseReport !== null)
    requireNoDelta(baseReport, violations, maxViolations, {
      report,
      allowances,
      roots: { head: reportRoot, base: baseReportRoot },
    });
  applyRatchet(violations, maxViolations, baseline);
}

main();
