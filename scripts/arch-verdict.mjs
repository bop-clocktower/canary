#!/usr/bin/env node
// Classifies a `harness check-arch --json` report into the ONE thing a reader
// actually needs from it: is this failure mine, or is it the ratchet? (#626)
//
// Two harness commands read the same architecture data and disagree, both
// correctly:
//
//   harness check-arch      -> absolute count. 28 issues, exit 1.
//   harness ci check --json -> the ratchet delta. {"name":"arch","status":
//                              "pass","issues":[]}, exit 0.
//
// The `arch` entry in the CI report is `{name, status, issues, durationMs}`
// and carries ZERO error-severity issues whether the failure is a genuine new
// violation or a stale baseline. So a red `arch` looks identical in the two
// cases that want opposite responses:
//
//   new violations introduced by the diff  -> fix the code
//   pre-existing debt tripping the ratchet -> refresh the baseline
//
// That misreading happened three times in one day (#584, #598, #621). The
// distinguishing data exists — `check-arch --json` has `newViolations`,
// `preExisting` and `regressions` — it just never reaches the reader. This
// module is the single place that reads those fields, shared by the CI
// summariser (`harness-report-summary.mjs --arch`) and by a local run, so the
// two paths can never drift into different verdicts on the same report.
//
// As a CLI it is also the local command `check-arch` cannot be: a clean tree
// and a baseline trip both exit 0, so running it costs nothing and the
// ratchet's reasoning gets read.
//
// Exit codes follow the repo's gate convention (#508):
//   0 = no new violations (clean, or a pre-existing-only baseline trip)
//   1 = REGRESSION — this change introduced violations
//   2 = usage error
//   3 = ABSTENTION — the report is missing, truncated, or lacks the ratchet
//       fields, so nothing was classified. Guessing "no new violations" from
//       an absent field would be a fabricated green.
//
//   node scripts/arch-verdict.mjs [arch-report.json]
//
// Produce the input with:  harness check-arch --json > arch-report.json
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** New violations listed before the remainder is summarised. */
const NEW_DETAIL_CAP = 25;

const BASELINE_PATH = '.harness/arch/baselines.json';
const ALLOWANCE_DIR = '.harness/arch/allowances/';

/** The first harness major that reads `.harness/arch/allowances/` at all. */
const ALLOWANCE_MIN_MAJOR = 11;

/**
 * Reads and parses a `check-arch --json` report.
 *
 * @returns {{ok: true, report: object} | {ok: false, reason: string}}
 */
export function loadArchReport(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (error) {
    return { ok: false, reason: `cannot read ${path}: ${error.message}` };
  }
  try {
    return { ok: true, report: JSON.parse(raw) };
  } catch (error) {
    return {
      ok: false,
      reason: `${path} is not parseable JSON (${raw.length} bytes) — likely truncated: ${error.message}`,
    };
  }
}

function count(value) {
  return Array.isArray(value) ? value.length : 0;
}

/**
 * Classifies a parsed report.
 *
 * `newViolations` and `regressions` are the two ways a change can be at fault;
 * everything else that fails is the ratchet firing on debt that was already
 * there. A report missing `newViolations` is classified `unknown` rather than
 * defaulting to zero — a harness major that renames the field must surface as
 * an abstention, not as a clean bill of health.
 *
 * @returns {{verdict: 'clean'|'regression'|'baseline'|'unknown', reason?: string,
 *   newCount: number, regressionCount: number, preExistingCount: number,
 *   totalViolations: number, mode: string, newViolations: object[],
 *   regressions: object[]}}
 */
export function classifyArchReport(report) {
  const shape = {
    newCount: count(report?.newViolations),
    regressionCount: count(report?.regressions),
    preExistingCount: count(report?.preExisting),
    totalViolations: Number(report?.totalViolations ?? 0),
    mode: String(report?.mode ?? 'unknown'),
    newViolations: Array.isArray(report?.newViolations)
      ? report.newViolations
      : [],
    regressions: Array.isArray(report?.regressions) ? report.regressions : [],
  };
  if (!Array.isArray(report?.newViolations)) {
    return {
      ...shape,
      verdict: 'unknown',
      reason:
        'the report carries no `newViolations` array — the new-vs-pre-existing split cannot be read from it',
    };
  }
  if (shape.newCount > 0 || shape.regressionCount > 0) {
    return { ...shape, verdict: 'regression' };
  }
  if (report?.passed === true) return { ...shape, verdict: 'clean' };
  return { ...shape, verdict: 'baseline' };
}

function describeViolation(v) {
  const where = v?.file ? `${v.file} — ` : '';
  return `  ${where}${v?.detail ?? JSON.stringify(v)}`;
}

// #689 trap 1. This line used to read `module-size 26965 -> 28178`, and the
// arrow invited everyone to subtract. They should not: the LEFT operand is the
// value recorded in `baselines.json`, NOT the value on `main`. Every allowance
// merged since the baseline was last refreshed sits inside that gap, so the
// implied "delta" overstates the PR's own growth by the whole accumulated
// total — and the error GROWS over the repo's life. In the #680/#682/#683/#687
// batch the real contributions were +55 and +88 while the arrow implied ~1200
// for both, which is precisely how four authors concluded their own change was
// the problem. The operands are named, the arrow is gone, and the sentence says
// out loud what the number is not.
function describeRegression(r) {
  if (r?.metric === undefined)
    return `  metric regression: ${JSON.stringify(r)}`;
  const from = r.from ?? '?';
  const to = r.to ?? '?';
  return (
    `  metric regression: ${r.metric} is ${to} now, against ${from} recorded in ${BASELINE_PATH}.` +
    ` That pair is NOT this change's delta — the left operand is the baseline, which every allowance` +
    ` merged since it was last refreshed already sits above. Measure your own contribution against the` +
    ` merge base before believing the gap.`
  );
}

/**
 * The version of the harness CLI in play, or `undefined` when it cannot be
 * read. `HARNESS_CLI_VERSION` overrides the probe — CI already knows what it
 * installed, and the tests need a seam that does not depend on the machine.
 */
function detectHarnessCliVersion() {
  const declared = process.env.HARNESS_CLI_VERSION;
  if (declared !== undefined && declared !== '') return declared.trim();
  try {
    return execFileSync('harness', ['--version'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * #689 trap 2: allowances are silently inert below harness 11.
 *
 * Under `@10` the CLI ignores `.harness/arch/allowances/` entirely, so a
 * correctly written allowance appears to do nothing at all and the author
 * concludes the mechanism is wrong rather than the toolchain. Every workflow
 * pins `@11`; a local install can differ without saying so. An unreadable
 * version is reported rather than assumed green — guessing "probably fine"
 * here is the abstention-as-pass shape this repo keeps closing.
 */
function allowanceSupportLines(version) {
  const major = Number.parseInt(String(version ?? '').replace(/^v/, ''), 10);
  if (Number.isNaN(major)) {
    return [
      `  NOTE: could not determine the running harness CLI version (unknown: ${version ?? 'not found on PATH'}).` +
        ` Allowances need >= ${ALLOWANCE_MIN_MAJOR}; below that the file is ignored and a correct allowance looks like a no-op.`,
    ];
  }
  if (major >= ALLOWANCE_MIN_MAJOR) return [];
  return [
    `  WARNING: the running harness CLI is ${version}, which ignores ${ALLOWANCE_DIR} entirely.` +
      ` Write the allowance against >= ${ALLOWANCE_MIN_MAJOR} or it will read as having no effect. CI pins @${ALLOWANCE_MIN_MAJOR}.`,
  ];
}

// `preExisting` is deliberately absent from every rendered sentence. On `main`
// it holds 94 baselined ids while `totalViolations` is 28 — they count
// different things, and printing them side by side would invite exactly the
// misreading this script exists to end. `totalViolations` is the one number
// that matches what `harness check-arch` prints to a human.
function regressionLines(v) {
  const lines = [
    `arch — REGRESSION: ${v.newCount} new violation(s) and ${v.regressionCount} metric regression(s) came from this change (${v.totalViolations} violation(s) in total).`,
  ];
  // Only a NEW violation is a code fix. A metric that grew is handled below,
  // by an allowance — telling the author of a legitimate refactor to "fix the
  // code" is how #689 started.
  if (v.newCount > 0) {
    lines.push('  Fix the code. Refreshing the baseline would bank it.');
  }
  for (const item of v.newViolations.slice(0, NEW_DETAIL_CAP)) {
    lines.push(describeViolation(item));
  }
  const hidden = v.newCount - NEW_DETAIL_CAP;
  if (hidden > 0) lines.push(`  … +${hidden} more new violation(s)`);
  for (const item of v.regressions) lines.push(describeRegression(item));
  // A metric regression is the case the allowance mechanism exists for — a
  // refactor that legitimately grows module-size cannot be "fixed" in code, and
  // this is the branch every one of #680/#682/#683/#687 actually landed in.
  if (v.regressionCount > 0) {
    lines.push(
      `  A metric that grew for a defensible reason is recorded, not fixed: add ${ALLOWANCE_DIR}<slug>.json` +
        ` with the absolute value and the argument for it.`,
      ...allowanceSupportLines(detectHarnessCliVersion()),
    );
  }
  return lines;
}

// #689. The old third line sent the reader to the `refresh-baseline` label,
// which is NOT how this repo clears architecture growth — six per-PR allowance
// files live on `main` (#674, #663, #670, #669, #660, #633) and the label is
// the rare maintainer escalation. Four independent workers read that line in a
// single afternoon and all four stopped at the wrong conclusion; one of them
// had verified the failure against a pristine `main` worktree first and was
// misled anyway. Correct methodology cannot save a reader from an instrument
// that misnames its own mechanism, so the mechanism is named first here.
function baselineLines(v) {
  return [
    `arch — BASELINE TRIP: ${v.newCount} new violation(s) from this change; the ratchet is firing on ${v.totalViolations} pre-existing violation(s) already recorded in the baseline.`,
    '  Nothing in this diff introduced them, so there is no code fix here.',
    `  The route for this repo is a per-PR allowance: add ${ALLOWANCE_DIR}<slug>.json` +
      ` stating the absolute value you measured and why the growth is worth it. Copy the shape of an` +
      ` existing file there, or let \`harness check-arch --update-baseline --allow-regress --reason "..."\` write it.`,
    `  Refreshing ${BASELINE_PATH} wholesale — the \`refresh-baseline\` label — is the rarer maintainer` +
      ` escalation, not the default: it banks every pre-existing violation at once and erases the per-PR record of who accepted what.`,
    ...allowanceSupportLines(detectHarnessCliVersion()),
  ];
}

/** Human-readable lines for a verdict. `unknown` is rendered by the caller. */
export function archVerdictLines(v) {
  if (v.verdict === 'regression') return regressionLines(v);
  if (v.verdict === 'baseline') return baselineLines(v);
  return [
    `arch — clean: ${v.totalViolations} threshold violation(s), none new (mode: ${v.mode}).`,
  ];
}

/** GitHub annotations — one per verdict, since the arch check emits none. */
export function archAnnotations(v) {
  if (v.verdict === 'regression') {
    return [
      `::error title=harness arch::${v.newCount} new architecture violation(s) introduced by this change — fix the code, do not refresh the baseline`,
    ];
  }
  if (v.verdict === 'baseline') {
    return [
      `::warning title=harness arch::baseline trip — 0 new violations, ${v.totalViolations} pre-existing; record a per-PR allowance in ${ALLOWANCE_DIR} (the refresh-baseline label is the rarer maintainer escalation, not the default)`,
    ];
  }
  return [];
}

const EXIT_BY_VERDICT = { clean: 0, baseline: 0, regression: 1, unknown: 3 };

function main() {
  const path = process.argv[2] ?? 'arch-report.json';
  if (path.startsWith('-')) {
    console.error('usage: arch-verdict.mjs [arch-report.json]');
    process.exit(2);
  }
  const loaded = loadArchReport(path);
  if (!loaded.ok) {
    console.log(`::error title=Arch verdict unavailable::${loaded.reason}`);
    console.error(`ABSTAINED: ${loaded.reason}`);
    process.exit(3);
  }
  const verdict = classifyArchReport(loaded.report);
  if (verdict.verdict === 'unknown') {
    const reason = `${path}: ${verdict.reason}`;
    console.log(`::error title=Arch verdict unavailable::${reason}`);
    console.error(`ABSTAINED: ${reason}`);
    process.exit(3);
  }
  for (const line of archVerdictLines(verdict)) console.log(line);
  for (const line of archAnnotations(verdict)) console.log(line);
  process.exit(EXIT_BY_VERDICT[verdict.verdict]);
}

// Importable as a module (the CI summariser shares the classifier) and
// executable as a CLI. `process.argv[1]` is this file only in the latter case.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
