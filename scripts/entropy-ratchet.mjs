#!/usr/bin/env node
/**
 * Entropy ratchet (#544).
 *
 * Reads the output of `harness cleanup --findings-json` and compares its
 * findings count against the triaged baseline in
 * `.harness/entropy-baseline.json`. Above the baseline, the build fails.
 *
 * Why a baseline rather than strict-at-zero: the residual is dominated by
 * findings the analyzer's model cannot get right on this repo — exports whose
 * only consumers are `*.test.ts` files (which the analyzer excludes from its
 * own snapshot, so their imports never count as usage), synthetic fixture
 * projects that exist precisely to be scanned, and per-skill script trees that
 * are invoked by workflow YAML rather than imported. Deleting live code to
 * chase a zero is a far worse outcome than carrying a documented number, and
 * the repo's dogfooding convention (see `harness-quality.yml`, the strict
 * blackhawk/savant steps) is to ratchet only after triage.
 *
 * Why "no number" fails: the step this replaces spent months green because
 * `harness cleanup` exited 2 at startup and `continue-on-error: true` swallowed
 * it. A ratchet that reads a missing count as zero findings would rebuild that
 * exact hiding place one layer up, so an absent contract line is an ABSTENTION
 * and exits non-zero.
 *
 * Usage:
 *   harness cleanup --findings-json > report.txt || true
 *   node scripts/entropy-ratchet.mjs --report report.txt
 *
 * Exit codes follow the repo's gate convention (#508):
 *   0 = verified — findings are at or under the baseline
 *   1 = the ratchet fired — findings grew past the baseline
 *   2 = error — the baseline file is missing or unreadable
 *   3 = ABSTENTION — no findings line in the input, so nothing was measured
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASELINE = join(REPO_ROOT, '.harness', 'entropy-baseline.json');

/**
 * The deliberate gap between the ceiling and the measured count, when the
 * baseline does not declare its own `maxHeadroom`.
 *
 * This is BOTH the slack above which the baseline is stale enough to mention
 * AND the gap the nudge tells you to leave. Those were two different numbers
 * (25 here, 10 in the baseline's prose and in `ts/test/entropy-ratchet.test.ts`)
 * and the disagreement had teeth: a gap of 11-25 was a hard test failure that
 * this script considered fine and said nothing about, so the red test and the
 * green gate pointed in opposite directions. Worse, the nudge used to say
 * `lower to ${findings}` — a ceiling pinned exactly to the measurement, which
 * is the zero-headroom state the baseline calls "how a blocking gate becomes
 * wallpaper". Following this tool's own advice produced the state the file
 * forbids.
 *
 * Nudging is still never a failure: a codebase that got cleaner must not turn
 * the build red. But an unratcheted ratchet is just a number in a file.
 */
const DEFAULT_MAX_HEADROOM = 10;

function parseArgs(argv) {
  const args = { report: null, baseline: DEFAULT_BASELINE, cliVersion: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--report') args.report = argv[i + 1];
    else if (argv[i] === '--baseline') args.baseline = argv[i + 1];
    else if (argv[i] === '--cli-version') args.cliVersion = argv[i + 1];
  }
  return args;
}

/**
 * Pull the findings count out of a `harness cleanup --findings-json` run.
 *
 * The contract line (`{"findings":N,"v":1,"check":"cleanup"}`) is emitted as
 * the LAST line of stdout, but the human-readable findings list precedes it and
 * other checks may share the stream, so scan every line and keep the last one
 * that is both well-formed and stamped `check: "cleanup"`. Returns `null` when
 * there is no such line — the caller must treat that as an abstention.
 */
function findingsFrom(text) {
  let found = null;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (parsed?.check !== 'cleanup') continue;
    if (!Number.isInteger(parsed.findings)) continue;
    found = parsed.findings;
  }
  return found;
}

function fail(code, message) {
  console.error(message);
  process.exit(code);
}

function main() {
  const { report, baseline, cliVersion } = parseArgs(process.argv.slice(2));

  if (!report) fail(2, 'entropy-ratchet: --report <file> is required.');

  let maxFindings;
  let maxHeadroom = DEFAULT_MAX_HEADROOM;
  let baselineCli = null;
  try {
    const parsed = JSON.parse(readFileSync(baseline, 'utf8'));
    maxFindings = parsed.maxFindings;
    if (typeof parsed.harnessCli === 'string') baselineCli = parsed.harnessCli;
    // The baseline owns its own headroom when it declares one, so this script
    // and `ts/test/entropy-ratchet.test.ts` cannot drift to two values.
    if (typeof parsed.maxHeadroom === 'number')
      maxHeadroom = parsed.maxHeadroom;
  } catch (err) {
    fail(
      2,
      `entropy-ratchet: cannot read baseline ${baseline}: ${err.message}`,
    );
  }
  if (!Number.isInteger(maxFindings)) {
    fail(2, `entropy-ratchet: ${baseline} has no integer "maxFindings".`);
  }

  let text;
  try {
    text = readFileSync(report, 'utf8');
  } catch (err) {
    fail(2, `entropy-ratchet: cannot read report ${report}: ${err.message}`);
  }

  const findings = findingsFrom(text);
  if (findings === null) {
    fail(
      3,
      'entropy-ratchet: ABSTAINED — no `--findings-json` contract line in the ' +
        'entropy report, so nothing was measured. This is the #544 shape: the ' +
        'scan most likely failed at startup. Read the step log; do NOT treat ' +
        'an absent count as zero findings.',
    );
  }

  // #744. The count above is only meaningful next to the identity of the
  // analyzer that produced it, and the workflows pin a FLOATING
  // `@harness-engineering/cli@11`, so that analyzer changes with no commit
  // here. It moved twice: 11.1.1 -> 11.2.0 took the count 281 -> 257, and
  // 11.2.0 -> 11.3.0 took it 257 -> 147 while the ceiling stood at 267. Every
  // offline guard stayed green through both, because they compare the baseline
  // against itself and a floating minor clears a MAJOR check by construction.
  //
  // A disagreement is an ABSTENTION, never a pass and never a failure: the
  // measurement is not comparable to the ceiling, so there is nothing to
  // compare. Re-measure, and update the baseline in the same PR.
  if (baselineCli !== null && cliVersion !== baselineCli) {
    fail(
      3,
      `entropy-ratchet: ABSTAINED — this baseline's ${maxFindings} ceiling was ` +
        `calibrated against harness CLI ${baselineCli}, but ` +
        (cliVersion === null
          ? 'the caller did not say which version produced this report ' +
            '(pass `--cli-version`).'
          : `this report was produced by ${cliVersion}.`) +
        `\nThe measured ${findings} is therefore not comparable to the ` +
        'ceiling — an analyzer that changes its own false-positive model moves ' +
        'this count with no change to the codebase, in either direction.\n' +
        'Re-measure in a clean worktree and update "measuredCount" and ' +
        '"harnessCli" in the baseline in the SAME PR. Do not silence this by ' +
        'deleting "harnessCli".',
    );
  }

  if (findings > maxFindings) {
    fail(
      1,
      `entropy-ratchet: FAILED — ${findings} entropy findings, baseline is ` +
        `${maxFindings} (+${findings - maxFindings}).\n` +
        'Either fix the new findings, or — if they are false positives from ' +
        "the analyzer's entry-point model — declare the new entry point in " +
        '`entropy.entryPoints` in harness.config.json. Raising ' +
        '`maxFindings` to make this pass is the one move that is never the ' +
        'right one.',
    );
  }

  const headroom = maxFindings - findings;
  console.log(
    `entropy-ratchet: OK — ${findings} findings, baseline ${maxFindings} ` +
      `(${headroom} of headroom).`,
  );
  if (headroom > maxHeadroom) {
    console.log(
      `entropy-ratchet: findings are ${headroom} under the baseline. Please ` +
        `lower "maxFindings" in ${baseline} to ${findings + maxHeadroom} ` +
        `(the measured ${findings} plus ${maxHeadroom} of headroom) so the ` +
        'gate keeps its teeth.',
    );
  }
}

main();
