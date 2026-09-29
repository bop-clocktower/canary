/**
 * End-to-end reproduction of the #610 gap list against the REAL writer.
 *
 * A store written by `canary history record` from a Playwright report carries
 * no `area` and no `failure_category` on any test (G1, G2): the format readers
 * never set them, while `analyze area-health` and the failure-category reports
 * read them. This test records a run through the production writer and asks
 * `history gaps` about it, so it goes red the day a writer starts filling
 * either field -- which is the day the documented gap list must change.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

const CI_ENV = {
  GITHUB_REPOSITORY: 'acme/widgets',
  GITHUB_REF_NAME: 'main',
  GITHUB_SHA: 'a'.repeat(40),
};

/** Synthetic Playwright `json` reporter output: one pass, one flake, one fail. */
function playwrightReport(): unknown {
  const test = (status: string, attempts: string[]): unknown => ({
    status,
    projectName: 'chromium',
    results: attempts.map((s) => ({
      status: s,
      duration: 100,
      ...(s === 'failed' ? { error: { message: 'expected 3, got 4' } } : {}),
    })),
  });
  return {
    stats: { startTime: '2026-09-01T12:00:00.000Z', duration: 900 },
    suites: [
      {
        title: 'checkout.spec.ts',
        file: 'checkout.spec.ts',
        suites: [
          {
            title: 'cart',
            specs: [
              { title: 'adds', tests: [test('expected', ['passed'])] },
              { title: 'totals', tests: [test('flaky', ['failed', 'passed'])] },
              { title: 'coupon', tests: [test('unexpected', ['failed'])] },
            ],
          },
        ],
      },
    ],
  };
}

interface Coverage {
  field: string;
  carried: number;
  applicable: number;
}
interface Gap {
  id: string;
  status: string;
  coverage: Coverage[];
}

let tmp: string;
beforeEach(() => {
  tmp = mkTmp();
});
afterEach(() => {
  rmTmp(tmp);
});

async function recordThenGaps(): Promise<{ code: number; gaps: Gap[] }> {
  const src = join(tmp, 'pw.json');
  mkdirSync(dirname(src), { recursive: true });
  writeFileSync(src, JSON.stringify(playwrightReport()), 'utf-8');
  const rec = await invokeCanary(['history', 'record', src, '--suite', 'web'], {
    cwd: tmp,
    env: CI_ENV,
  });
  expect(rec.code).toBe(0);
  const res = await invokeCanary(['history', 'gaps', '--json'], {
    cwd: tmp,
    env: CI_ENV,
  });
  const body = JSON.parse(res.stdout) as { consumers: Gap[] };
  return { code: res.code, gaps: body.consumers };
}

function find(gaps: Gap[], id: string): Gap {
  const gap = gaps.find((g) => g.id === id);
  if (!gap) throw new Error(`no consumer ${id}`);
  return gap;
}

describe('history gaps over a store written by history record', () => {
  it('reproduces G1 and G2 on a store written by history record from a Playwright report', async () => {
    const { code, gaps } = await recordThenGaps();
    expect(code).toBe(1);
    const area = find(gaps, 'flaky-area');
    expect(area.status).toBe('dark');
    expect(area.coverage[0]).toMatchObject({ carried: 0, applicable: 3 });
    const categories = find(gaps, 'failure-categories');
    expect(categories.status).toBe('dark');
    // One failed test plus one flaky: the only rows a category means anything
    // on. The reader keeps error text for the failure and drops it for the
    // flake, so common-failures sees half its rows before the category gap.
    expect(categories.coverage).toEqual([
      { field: 'error_text', scope: 'failed-test', carried: 1, applicable: 2 },
      {
        field: 'failure_category',
        scope: 'failed-test',
        carried: 0,
        applicable: 2,
      },
    ]);
  });

  it('reports the fields the writer does fill as fed', async () => {
    const { gaps } = await recordThenGaps();
    expect(find(gaps, 'flaky-retry').status).toBe('fed');
    // The real writer always stamps the run's failed count (#610 review).
    expect(find(gaps, 'screech-range').status).toBe('fed');
    expect(find(gaps, 'ci-ready-runtime').status).toBe('fed');
    expect(find(gaps, 'order').status).toBe('fed');
    expect(find(gaps, 'rewind').status).toBe('fed');
  });

  it('reports the screech owning-area and cluster half as dark (C1)', async () => {
    const { gaps } = await recordThenGaps();
    const cluster = find(gaps, 'screech-cluster');
    expect(cluster.status).toBe('dark');
    // Only the hard failure: screech's isFailure does not count a flake.
    expect(
      cluster.coverage.map((c) => [c.field, c.carried, c.applicable]),
    ).toEqual([
      ['area', 0, 1],
      ['failure_category', 0, 1],
    ]);
  });

  it('reports order-ttff dark on a store recorded without --order-plan', async () => {
    const { gaps } = await recordThenGaps();
    const ttff = find(gaps, 'order-ttff');
    expect(ttff.status).toBe('dark');
    expect(ttff.coverage[0]).toMatchObject({ carried: 0, applicable: 1 });
  });
});
