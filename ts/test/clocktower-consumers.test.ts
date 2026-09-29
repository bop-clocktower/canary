/**
 * The consumer table behind `canary history gaps` (#610).
 *
 * Two kinds of test live here. The mirror rows pin each requirement's scope to
 * the source line that reads the field -- a named place to look when a consumer
 * changes what it reads. The predicate tests are the ones that bite: each one
 * feeds a requirement a value the named consumer would use and a value it
 * would refuse or ignore, so a predicate that drifts from its consumer goes
 * red rather than silently reporting a field as fed.
 */
import { describe, expect, it } from 'vitest';

import { CONSUMERS } from '../src/analysis/clocktower/consumers.js';
import type { RunRecord, TestResultRecord } from '../src/history/record.js';

function consumer(id: string) {
  const found = CONSUMERS.find((c) => c.id === id);
  if (!found) throw new Error(`no consumer ${id}`);
  return found;
}

function requirement(id: string, field: string) {
  const found = consumer(id).requirements.find((r) => r.field === field);
  if (!found) throw new Error(`no requirement ${id}.${field}`);
  return found;
}

const RUN: RunRecord = { run_id: 'r1', suite: 's' };

function test(extra: Partial<TestResultRecord>): TestResultRecord {
  return { test_name: 't', status: 'failed', ...extra };
}

/** Does `id.field` count a run carrying `value` in `field`? */
function onRun(id: string, field: string, value: unknown): boolean {
  return requirement(id, field).carried({ ...RUN, [field]: value });
}

/** Does `id.field` count a test carrying `value` in `field`? */
function onTest(id: string, field: string, value: unknown): boolean {
  return requirement(id, field).carried(RUN, test({ [field]: value }));
}

/** Is a test with this status in `id.field`'s denominator at all? */
function inScope(id: string, field: string, status: string): boolean {
  const req = requirement(id, field);
  return req.where === undefined || req.where(test({ status }));
}

describe('clocktower consumer table', () => {
  it('declares the nine consumers with unique ids', () => {
    expect(CONSUMERS.map((c) => c.id)).toEqual([
      'screech-range',
      'screech-cluster',
      'ci-ready-runtime',
      'flaky-retry',
      'flaky-area',
      'failure-categories',
      'order',
      'rewind',
      'order-ttff',
    ]);
  });

  it('gives every consumer at least one requirement', () => {
    for (const c of CONSUMERS) expect(c.requirements.length).toBeGreaterThan(0);
  });

  it.each([
    ['screech-range', 'branch', 'run', 'canary-screech/scripts/history.mjs:68'],
    ['screech-range', 'commit_sha', 'run', 'screech/scripts/redness.mjs:46'],
    ['screech-range', 'timestamp', 'run', 'screech/scripts/history.mjs:71'],
    ['screech-range', 'failed', 'run', 'screech/scripts/redness.mjs:16'],
    ['screech-cluster', 'area', 'failed-test', 'screech/cluster.mjs:47'],
    ['screech-cluster', 'failure_category', 'failed-test', 'cluster.mjs:29'],
    ['ci-ready-runtime', 'duration_ms', 'run', 'ts/src/core/ci-ready.ts:180'],
    ['flaky-retry', 'reporter_format', 'run', 'ts/src/util/flake-window.ts'],
    ['flaky-area', 'area', 'test', 'ts/src/history/flake/rows.ts:65'],
    [
      'failure-categories',
      'error_text',
      'failed-test',
      'analysis/engine.ts:49',
    ],
    ['failure-categories', 'failure_category', 'failed-test', 'engine.ts:57'],
    ['order', 'test_file', 'test', 'ts/src/analysis/order/rank.ts:166'],
    ['order', 'duration_ms', 'test', 'ts/src/analysis/order/rank.ts:166'],
    ['rewind', 'commit_sha', 'run', 'ts/src/analysis/rewind/plan.ts:79'],
    ['rewind', 'reporter_format', 'run', 'ts/src/analysis/rewind/plan.ts:86'],
    ['rewind', 'test_file', 'failed-test', 'analysis/rewind/plan.ts:67'],
    ['order-ttff', 'order', 'run', 'ts/src/analysis/order/ttff-report.ts:36'],
  ])('%s reads %s at %s scope (%s)', (id, field, scope) => {
    expect(requirement(id, field).scope).toBe(scope);
  });

  it('screech-range needs a non-empty branch, commit and timestamp', () => {
    for (const field of ['branch', 'commit_sha', 'timestamp']) {
      expect(onRun('screech-range', field, 'x')).toBe(true);
      expect(onRun('screech-range', field, '')).toBe(false);
      expect(onRun('screech-range', field, null)).toBe(false);
    }
  });

  it('screech-range needs a numeric failed count, as isRed reads it', () => {
    expect(onRun('screech-range', 'failed', 0)).toBe(true);
    expect(onRun('screech-range', 'failed', 3)).toBe(true);
    expect(onRun('screech-range', 'failed', null)).toBe(false);
    expect(requirement('screech-range', 'failed').carried(RUN)).toBe(false);
  });

  it('screech-cluster needs area and category on each failed test', () => {
    for (const field of ['area', 'failure_category']) {
      expect(onTest('screech-cluster', field, 'checkout')).toBe(true);
      expect(onTest('screech-cluster', field, '')).toBe(false);
      expect(onTest('screech-cluster', field, null)).toBe(false);
    }
  });

  it('screech-cluster counts failed tests only, not flaky ones (isFailure)', () => {
    for (const field of ['area', 'failure_category']) {
      expect(inScope('screech-cluster', field, 'failed')).toBe(true);
      expect(inScope('screech-cluster', field, 'flaky')).toBe(false);
    }
  });

  it('flaky-area treats a null, empty or absent area as not carried', () => {
    const area = requirement('flaky-area', 'area');
    expect(area.carried(RUN, test({ area: null }))).toBe(false);
    expect(area.carried(RUN, test({ area: '' }))).toBe(false);
    expect(area.carried(RUN, test({}))).toBe(false);
    expect(area.carried(RUN, test({ area: 'checkout' }))).toBe(true);
  });

  it('counts reporter_format only for playwright or junit (#604)', () => {
    expect(onRun('flaky-retry', 'reporter_format', 'playwright')).toBe(true);
    expect(onRun('flaky-retry', 'reporter_format', 'junit')).toBe(true);
    expect(onRun('flaky-retry', 'reporter_format', 'vitest')).toBe(false);
    // Unknown to flake-window is not capable: it may never emit `flaky`.
    expect(onRun('flaky-retry', 'reporter_format', 'mocha')).toBe(false);
    expect(onRun('flaky-retry', 'reporter_format', null)).toBe(false);
    expect(requirement('flaky-retry', 'reporter_format').carried(RUN)).toBe(
      false,
    );
  });

  it('counts a run duration only when ci-ready would: positive and finite', () => {
    expect(onRun('ci-ready-runtime', 'duration_ms', 1)).toBe(true);
    expect(onRun('ci-ready-runtime', 'duration_ms', 0)).toBe(false);
    expect(onRun('ci-ready-runtime', 'duration_ms', -5)).toBe(false);
    expect(onRun('ci-ready-runtime', 'duration_ms', Number.NaN)).toBe(false);
    expect(onRun('ci-ready-runtime', 'duration_ms', Infinity)).toBe(false);
    expect(onRun('ci-ready-runtime', 'duration_ms', null)).toBe(false);
  });

  it('failure-categories needs error_text and a category on failed tests', () => {
    expect(onTest('failure-categories', 'error_text', 'boom')).toBe(true);
    expect(onTest('failure-categories', 'error_text', '')).toBe(false);
    expect(onTest('failure-categories', 'error_text', null)).toBe(false);
    expect(onTest('failure-categories', 'failure_category', 'timeout')).toBe(
      true,
    );
    expect(onTest('failure-categories', 'failure_category', null)).toBe(false);
  });

  it('order needs a test_file and a numeric test duration', () => {
    expect(onTest('order', 'test_file', 'a.spec.ts')).toBe(true);
    expect(onTest('order', 'test_file', '')).toBe(false);
    expect(onTest('order', 'duration_ms', 0)).toBe(true);
    expect(onTest('order', 'duration_ms', null)).toBe(false);
    expect(onTest('order', 'duration_ms', '12')).toBe(false);
  });

  it('rewind refuses a local or absent commit, as plan.ts does', () => {
    expect(onRun('rewind', 'commit_sha', 'c'.repeat(40))).toBe(true);
    expect(onRun('rewind', 'commit_sha', 'local')).toBe(false);
    expect(onRun('rewind', 'commit_sha', null)).toBe(false);
  });

  it('rewind counts only runners it has a replay command for', () => {
    expect(onRun('rewind', 'reporter_format', 'vitest')).toBe(true);
    expect(onRun('rewind', 'reporter_format', 'playwright')).toBe(true);
    expect(onRun('rewind', 'reporter_format', 'junit')).toBe(false);
    expect(onRun('rewind', 'reporter_format', null)).toBe(false);
  });

  it('rewind needs a repo-relative test_file inside the repository', () => {
    expect(onTest('rewind', 'test_file', 'tests/a.spec.ts')).toBe(true);
    expect(onTest('rewind', 'test_file', '/abs/a.spec.ts')).toBe(false);
    expect(onTest('rewind', 'test_file', '../out/a.spec.ts')).toBe(false);
    expect(onTest('rewind', 'test_file', '')).toBe(false);
  });

  it('order-ttff needs an order object carrying both TTFF estimates', () => {
    const order = (ordered: unknown, baseline: unknown) => ({
      ttff_ordered_ms_estimate: ordered,
      ttff_baseline_ms_estimate: baseline,
    });
    expect(onRun('order-ttff', 'order', order(1, 2))).toBe(true);
    expect(onRun('order-ttff', 'order', order(null, 2))).toBe(false);
    expect(onRun('order-ttff', 'order', order(1, null))).toBe(false);
    expect(onRun('order-ttff', 'order', null)).toBe(false);
    expect(onRun('order-ttff', 'order', 'yes')).toBe(false);
  });

  it('never counts a test-scope field without a test', () => {
    expect(requirement('flaky-area', 'area').carried(RUN)).toBe(false);
  });

  it('marks only order-ttff as opt-in via --order-plan', () => {
    const optIns = CONSUMERS.filter((c) => c.optIn !== undefined);
    expect(optIns.map((c) => [c.id, c.optIn])).toEqual([
      ['order-ttff', '--order-plan'],
    ]);
  });
});
