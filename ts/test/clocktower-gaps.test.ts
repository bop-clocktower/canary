/** Per-consumer field coverage over a history store (#610). */
import { describe, expect, it } from 'vitest';

import type { Consumer } from '../src/analysis/clocktower/consumers.js';
import { CONSUMERS } from '../src/analysis/clocktower/consumers.js';
import { analyzeGaps } from '../src/analysis/clocktower/gaps.js';
import type { RunRecord, TestResultRecord } from '../src/history/record.js';

const BRANCH: Consumer = {
  id: 'needs-branch',
  surface: 'x',
  requirements: [
    { field: 'branch', scope: 'run', carried: (r) => Boolean(r.branch) },
  ],
};

const AREA: Consumer = {
  id: 'needs-area',
  surface: 'x',
  requirements: [
    {
      field: 'area',
      scope: 'test',
      carried: (_r, t) => Boolean(t?.area),
    },
  ],
};

const CATEGORY: Consumer = {
  id: 'needs-category',
  surface: 'x',
  requirements: [
    {
      field: 'failure_category',
      scope: 'failed-test',
      carried: (_r, t) => Boolean(t?.failure_category),
    },
  ],
};

function run(extra: Partial<RunRecord> = {}): RunRecord {
  return { run_id: `r${Math.random()}`, suite: 's', ...extra };
}

function t(status: string, extra: Partial<TestResultRecord> = {}) {
  return { test_name: 'n', status, ...extra };
}

function gapOf(records: RunRecord[], consumers: Consumer[], id?: string) {
  const report = analyzeGaps(records, consumers);
  return report.consumers.find((c) => c.id === (id ?? consumers[0]!.id))!;
}

describe('analyzeGaps', () => {
  it('reports fed when every run carries every required field', () => {
    const gap = gapOf(
      [run({ branch: 'main' }), run({ branch: 'dev' })],
      [BRANCH],
    );
    expect(gap.status).toBe('fed');
    expect(gap.coverage).toEqual([
      { field: 'branch', scope: 'run', carried: 2, applicable: 2 },
    ]);
  });

  it('reports dark when no run carries a required field', () => {
    expect(gapOf([run(), run()], [BRANCH]).status).toBe('dark');
  });

  it('reports partial with carried/applicable when some runs carry it', () => {
    const gap = gapOf([run({ branch: 'main' }), run()], [BRANCH]);
    expect(gap.status).toBe('partial');
    expect(gap.coverage[0]).toMatchObject({ carried: 1, applicable: 2 });
  });

  it('counts test-scope requirements over every test in every run', () => {
    const gap = gapOf(
      [
        run({ tests: [t('passed', { area: 'a' }), t('failed')] }),
        run({ tests: [t('skipped', { area: 'b' })] }),
      ],
      [AREA],
    );
    expect(gap.coverage[0]).toMatchObject({ carried: 2, applicable: 3 });
  });

  it('counts failed-test requirements only over failed and flaky tests', () => {
    const gap = gapOf(
      [
        run({
          tests: [
            t('passed'),
            t('failed', { failure_category: 'timeout' }),
            t('flaky'),
            t('skipped'),
          ],
        }),
      ],
      [CATEGORY],
    );
    expect(gap.coverage[0]).toMatchObject({ carried: 1, applicable: 2 });
    expect(gap.status).toBe('partial');
  });

  it('reports unmeasured, never fed, when the store has no failed tests', () => {
    const report = analyzeGaps([run({ tests: [t('passed'), t('skipped')] })]);
    const gap = report.consumers.find((c) => c.id === 'failure-categories')!;
    expect(gap.status).toBe('unmeasured');
    expect(gap.coverage[0]).toMatchObject({ carried: 0, applicable: 0 });
  });

  it('lets unmeasured outrank dark when one requirement has no denominator', () => {
    const both: Consumer = {
      id: 'both',
      surface: 'x',
      requirements: [...BRANCH.requirements, ...CATEGORY.requirements],
    };
    expect(gapOf([run({ tests: [t('passed')] })], [both]).status).toBe(
      'unmeasured',
    );
  });

  it('treats a run without a tests array as zero tests', () => {
    const report = analyzeGaps([run()], [AREA]);
    expect(report.tests).toBe(0);
    expect(report.consumers[0]!.status).toBe('unmeasured');
  });

  it('totals runs and tests across the store', () => {
    const report = analyzeGaps(
      [
        run({ tests: [t('passed'), t('failed')] }),
        run({ tests: [t('flaky')] }),
      ],
      [BRANCH],
    );
    expect(report).toMatchObject({ runs: 2, tests: 3 });
  });

  it('carries optIn through to the gap', () => {
    const optIn: Consumer = { ...BRANCH, optIn: '--order-plan' };
    expect(gapOf([run()], [optIn]).optIn).toBe('--order-plan');
    expect(gapOf([run()], [BRANCH])).not.toHaveProperty('optIn');
  });

  it('analyses every declared consumer by default', () => {
    expect(analyzeGaps([run()]).consumers.map((c) => c.id)).toEqual(
      CONSUMERS.map((c) => c.id),
    );
  });
});
