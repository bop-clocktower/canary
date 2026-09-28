/**
 * The consumer table behind `canary history gaps` (#610).
 *
 * Each mirror row pins a consumer requirement to the source line that reads the
 * field, so a consumer that changes what it reads has an obvious place to be
 * reflected here -- the table is the one thing that must track it.
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

describe('clocktower consumer table', () => {
  it('declares the eight initial consumers with unique ids', () => {
    expect(CONSUMERS.map((c) => c.id)).toEqual([
      'screech',
      'ci-ready-runtime',
      'flaky-retry',
      'area-health',
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
    ['screech', 'branch', 'run', 'canary-screech/scripts/history.mjs:68'],
    ['screech', 'commit_sha', 'run', 'canary-screech/scripts/redness.mjs:46'],
    ['screech', 'timestamp', 'run', 'canary-screech/scripts/history.mjs:57'],
    ['ci-ready-runtime', 'duration_ms', 'run', 'ts/src/core/ci-ready.ts:179'],
    ['flaky-retry', 'reporter_format', 'run', 'ts/src/history/flake/window.ts'],
    ['area-health', 'area', 'test', 'ts/src/analysis/reports.ts:121'],
    [
      'failure-categories',
      'failure_category',
      'failed-test',
      'ts/src/analysis/engine.ts:57',
    ],
    ['order', 'test_file', 'test', 'ts/src/analysis/order/rank.ts:166'],
    ['order', 'duration_ms', 'test', 'ts/src/analysis/order/rank.ts:166'],
    ['rewind', 'replay', 'run', 'ts/src/analysis/rewind/plan.ts:125'],
    ['rewind', 'start_index', 'test', 'ts/src/analysis/rewind/plan.ts:170'],
    ['order-ttff', 'order', 'run', 'ts/src/analysis/order/ttff-report.ts:36'],
  ])('%s reads %s at %s scope (%s)', (id, field, scope) => {
    expect(requirement(id, field).scope).toBe(scope);
  });

  it('treats a null, empty or absent area as not carried', () => {
    const area = requirement('area-health', 'area');
    expect(area.carried(RUN, test({ area: null }))).toBe(false);
    expect(area.carried(RUN, test({ area: '' }))).toBe(false);
    expect(area.carried(RUN, test({}))).toBe(false);
    expect(area.carried(RUN, test({ area: 'checkout' }))).toBe(true);
  });

  it('counts reporter_format only for playwright or junit (#604)', () => {
    const fmt = requirement('flaky-retry', 'reporter_format');
    const run = (reporter_format: string | null): RunRecord => ({
      ...RUN,
      reporter_format,
    });
    expect(fmt.carried(run('playwright'))).toBe(true);
    expect(fmt.carried(run('junit'))).toBe(true);
    expect(fmt.carried(run('vitest'))).toBe(false);
    expect(fmt.carried(run(null))).toBe(false);
    expect(fmt.carried(RUN)).toBe(false);
  });

  it('counts duration_ms only when it is a finite number', () => {
    const dur = requirement('ci-ready-runtime', 'duration_ms');
    expect(dur.carried({ ...RUN, duration_ms: null })).toBe(false);
    expect(dur.carried({ ...RUN, duration_ms: Number.NaN })).toBe(false);
    expect(dur.carried({ ...RUN, duration_ms: 0 })).toBe(true);
  });

  it('never counts a test-scope field without a test', () => {
    expect(requirement('area-health', 'area').carried(RUN)).toBe(false);
  });

  it('marks only order-ttff as opt-in via --order-plan', () => {
    const optIns = CONSUMERS.filter((c) => c.optIn !== undefined);
    expect(optIns.map((c) => [c.id, c.optIn])).toEqual([
      ['order-ttff', '--order-plan'],
    ]);
  });
});
