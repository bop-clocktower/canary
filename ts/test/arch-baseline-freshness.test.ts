/**
 * The arch baseline floor must not drift far below the ceiling the allowances
 * have already accepted (#736, #703).
 *
 * `harness check-arch` compares a metric against the HIGHER of two numbers: the
 * baseline in `.harness/arch/baselines.json`, widened by
 * `architecture.regressionTolerance` (a fraction of the baseline, default 1%),
 * and the highest matching per-PR allowance. The allowance side is what
 * actually moves — one file per growing PR — while the baseline side only moves
 * when a human edits it.
 *
 * So the two drift apart silently, and the tolerance is the casualty. It is a
 * fraction OF THE BASELINE, which means a stale floor shrinks the absorber in
 * absolute terms exactly when a growing repo needs it most. Measured on
 * 2026-08-22: the floor stood at 26965 (last moved 2026-08-10) against a
 * 32960 ceiling — a 5995 gap, with the absorber worth 270. Every ordinary PR
 * therefore had to hand-write an allowance, and the directory grew to 22 files
 * whose bespoke justifications read as 22 people absorbing one stale constant.
 *
 * This test is the thing that was missing: it fails the moment the gap outgrows
 * the tolerance, which is the moment the absorber stops absorbing. It would
 * have fired when the gap first passed ~270, rather than at 5995.
 *
 * It deliberately does NOT run `check-arch`. Both operands are checked-in
 * files, so the check is deterministic, offline, and costs nothing — and the
 * measured count is not what is being guarded here. What is guarded is the
 * relationship between two numbers this repo maintains by hand.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASELINE_PATH = join(REPO_ROOT, '.harness', 'arch', 'baselines.json');
const ALLOWANCE_DIR = join(REPO_ROOT, '.harness', 'arch', 'allowances');
const CONFIG_PATH = join(REPO_ROOT, 'harness.config.json');

/** The CLI's own default when `architecture.regressionTolerance` is unset. */
const DEFAULT_REGRESSION_TOLERANCE = 0.01;

/** The metric this repo actually accumulates growth in. */
const METRIC = 'module-size';

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

/** The floor: the value recorded in `baselines.json` for the metric. */
function baselineValue(): number {
  const metrics = readJson(BASELINE_PATH).metrics as Record<
    string,
    { value: number }
  >;
  return metrics[METRIC].value;
}

/**
 * Every allowance value recorded for the metric, highest first.
 *
 * An allowance without the metric is normal — a PR can trip a different
 * category — so those are filtered rather than treated as zero, which would
 * silently drag a max() down.
 */
function allowanceValues(): number[] {
  return readdirSync(ALLOWANCE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const categories = readJson(join(ALLOWANCE_DIR, f)).categories as
        Record<string, number> | undefined;
      return categories?.[METRIC];
    })
    .filter((v): v is number => typeof v === 'number')
    .sort((a, b) => b - a);
}

/** `architecture.regressionTolerance`, or the CLI's default when unset. */
function regressionTolerance(): number {
  const architecture = readJson(CONFIG_PATH).architecture as
    { regressionTolerance?: number } | undefined;
  return architecture?.regressionTolerance ?? DEFAULT_REGRESSION_TOLERANCE;
}

describe('arch baseline floor tracks the accepted ceiling (#736)', () => {
  it('reads both operands from real files', () => {
    // A zero denominator here would make the assertion below vacuously true:
    // an empty allowance directory has no maximum, and a missing metric would
    // compare undefined against undefined.
    expect(Number.isFinite(baselineValue())).toBe(true);
    expect(allowanceValues().length).toBeGreaterThan(0);
  });

  it('keeps the floor within one tolerance-width of the highest allowance', () => {
    const floor = baselineValue();
    const ceiling = allowanceValues()[0];
    const absorber = floor * regressionTolerance();

    // Below the floor is fine and needs no refresh — that is the ratchet
    // working. Only a ceiling that has climbed AWAY from the floor is drift.
    const gap = Math.max(0, ceiling - floor);

    expect(
      gap,
      `The arch baseline floor (${floor}) is ${gap} below the highest accepted ` +
        `allowance (${ceiling}), but regressionTolerance only absorbs ` +
        `${absorber.toFixed(1)}. Every ordinary PR must therefore hand-write an ` +
        `allowance. Refresh the floor: set metrics["${METRIC}"].value in ` +
        `.harness/arch/baselines.json to ${ceiling} and leave violationIds ` +
        `untouched, so the aggregate ceiling moves without banking any ` +
        `violation. Note the value only takes effect once it is on the base ` +
        `branch — check-arch resolves the baseline from git, not the worktree.`,
    ).toBeLessThanOrEqual(absorber);
  });
});
