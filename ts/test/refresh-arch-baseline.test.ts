/**
 * `scripts/refresh-arch-baseline.mjs` — the refresh the CLI stopped providing (#749).
 *
 * `harness check-arch --update-baseline --allow-regress --reason "…"` does not
 * rewrite `baselines.json` at CLI 11.x. It writes a per-PR allowance and says so
 * (`baselines.json stays byte-identical to the base`) while still printing
 * `✓ Baseline updated successfully.`. So the repo's `refresh-baseline` label ran
 * a command that could not do the thing the label is named for, and the guard
 * was widened to accept the allowance rather than the refresh.
 *
 * This script performs the refresh directly, and the shape matters as much as
 * the number: it moves `metrics[<category>].value` ONLY, leaving `violationIds`
 * untouched. That is what separates a refresh from the wholesale
 * `--update-baseline` behaviour #689 objected to — the aggregate ceiling moves
 * and not one violation is banked, so a pre-existing violation stays
 * pre-existing and a new one stays new.
 *
 * Exit codes follow the repo's gate convention (#508):
 *   0 = refreshed, 1 = nothing to refresh, 2 = usage, 3 = abstention.
 * The 1-vs-3 split is the point: "the report says no metric regressed" and "I
 * could not read the report" are different facts, and collapsing them is how a
 * refresh that never ran reports success.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCapture } from './subprocess-testkit.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'refresh-arch-baseline.mjs');

/** A baseline with two metrics, each carrying violation identities. */
function baselineFixture() {
  return {
    version: 1,
    updatedAt: '2026-08-10T17:40:14.869Z',
    updatedFrom: '0174b05c',
    metrics: {
      'module-size': { value: 26965, violationIds: ['a', 'b'] },
      complexity: { value: 88, violationIds: ['c'] },
    },
  };
}

/** A `check-arch --json` report in which one metric regressed. */
function reportFixture(regressions: unknown[]) {
  return {
    passed: false,
    mode: 'baseline',
    totalViolations: 19,
    newViolations: [],
    resolvedViolations: [],
    preExisting: [],
    regressions,
    thresholdViolations: [],
  };
}

let dir: string;
let baselinePath: string;
let reportPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'refresh-arch-'));
  baselinePath = join(dir, 'baselines.json');
  reportPath = join(dir, 'report.json');
  writeFileSync(baselinePath, JSON.stringify(baselineFixture(), null, 2));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * Runs the script, returning its exit code and merged output.
 *
 * `failureStatus: -1` so a signal kill cannot be mistaken for one of the
 * script's own exit codes — 1 and 3 are both meaningful here, and reporting
 * either for a child that left no status would invent a verdict.
 */
function run(args: string[]): { code: number; out: string } {
  const result = runCapture('node', [SCRIPT, ...args], { failureStatus: -1 });
  return { code: result.status, out: result.output };
}

function readBaseline() {
  return JSON.parse(readFileSync(baselinePath, 'utf-8'));
}

describe('refresh-arch-baseline', () => {
  it('moves the regressed metric to its measured current value', () => {
    writeFileSync(
      reportPath,
      JSON.stringify(
        reportFixture([
          {
            category: 'module-size',
            baselineValue: 26965,
            currentValue: 32960,
            delta: 5995,
          },
        ]),
      ),
    );

    const { code } = run([reportPath, '--baseline', baselinePath]);

    expect(code).toBe(0);
    expect(readBaseline().metrics['module-size'].value).toBe(32960);
  });

  it('banks nothing — violationIds survive the refresh untouched', () => {
    // The load-bearing assertion. A refresh that also rewrote violationIds
    // would convert every pre-existing violation into an accepted one, which
    // is the half of `--update-baseline` #689 was right to refuse.
    writeFileSync(
      reportPath,
      JSON.stringify(
        reportFixture([
          {
            category: 'module-size',
            baselineValue: 26965,
            currentValue: 32960,
            delta: 5995,
          },
        ]),
      ),
    );

    run([reportPath, '--baseline', baselinePath]);

    expect(readBaseline().metrics['module-size'].violationIds).toEqual([
      'a',
      'b',
    ]);
  });

  it('leaves metrics that did not regress alone', () => {
    writeFileSync(
      reportPath,
      JSON.stringify(
        reportFixture([
          {
            category: 'module-size',
            baselineValue: 26965,
            currentValue: 32960,
            delta: 5995,
          },
        ]),
      ),
    );

    run([reportPath, '--baseline', baselinePath]);

    expect(readBaseline().metrics.complexity).toEqual({
      value: 88,
      violationIds: ['c'],
    });
  });

  it('refreshes every regressed metric, not just the first', () => {
    writeFileSync(
      reportPath,
      JSON.stringify(
        reportFixture([
          { category: 'module-size', currentValue: 32960 },
          { category: 'complexity', currentValue: 91 },
        ]),
      ),
    );

    expect(run([reportPath, '--baseline', baselinePath]).code).toBe(0);
    const m = readBaseline().metrics;
    expect([m['module-size'].value, m.complexity.value]).toEqual([32960, 91]);
  });

  it('exits 1 and writes nothing when no metric regressed', () => {
    // Distinct from an abstention: the report was read and it says there is
    // nothing to do, which means the label was applied unnecessarily.
    writeFileSync(reportPath, JSON.stringify(reportFixture([])));
    const before = readFileSync(baselinePath, 'utf-8');

    const { code, out } = run([reportPath, '--baseline', baselinePath]);

    expect(code).toBe(1);
    expect(out).toMatch(/no metric regressed/i);
    expect(readFileSync(baselinePath, 'utf-8')).toBe(before);
  });

  it('abstains (3) when the report is missing', () => {
    const { code, out } = run([
      join(dir, 'nope.json'),
      '--baseline',
      baselinePath,
    ]);
    expect(code).toBe(3);
    expect(out).toMatch(/abstain/i);
  });

  it('abstains (3) when the report lacks the regressions field', () => {
    // Guessing "nothing regressed" from an absent field would be a fabricated
    // green — the same shape as reading a missing count as zero.
    writeFileSync(reportPath, JSON.stringify({ passed: false }));
    const { code } = run([reportPath, '--baseline', baselinePath]);
    expect(code).toBe(3);
  });

  it('abstains (3) rather than inventing a value when currentValue is absent', () => {
    writeFileSync(
      reportPath,
      JSON.stringify(reportFixture([{ category: 'module-size' }])),
    );
    const before = readFileSync(baselinePath, 'utf-8');

    const { code } = run([reportPath, '--baseline', baselinePath]);

    expect(code).toBe(3);
    expect(readFileSync(baselinePath, 'utf-8')).toBe(before);
  });

  it('abstains (3) on a category the baseline does not carry', () => {
    writeFileSync(
      reportPath,
      JSON.stringify(
        reportFixture([{ category: 'not-a-metric', currentValue: 5 }]),
      ),
    );
    expect(run([reportPath, '--baseline', baselinePath]).code).toBe(3);
  });

  it('exits 2 on usage error', () => {
    expect(run([]).code).toBe(2);
  });

  it('refuses to lower a metric, which would slacken the ratchet', () => {
    // A refresh moves the floor to meet reality; it must never move it DOWN to
    // a value below what is recorded, which would silently widen the gate.
    writeFileSync(
      reportPath,
      JSON.stringify(
        reportFixture([{ category: 'module-size', currentValue: 100 }]),
      ),
    );
    const before = readFileSync(baselinePath, 'utf-8');

    const { code, out } = run([reportPath, '--baseline', baselinePath]);

    expect(code).toBe(3);
    expect(out).toMatch(/below/i);
    expect(readFileSync(baselinePath, 'utf-8')).toBe(before);
  });
});
