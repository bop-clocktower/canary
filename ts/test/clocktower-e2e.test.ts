/**
 * End-to-end proof that `canary history record` feeds the #610 consumers
 * (#1125). A Playwright report recorded where `.canary/critical-areas.json`
 * maps its spec file yields `area` on every test and `failure_category` on
 * every failed and flaky one (G1, G2, G8). Without the file, `area` abstains
 * with a note. The positive test goes red the day either writer path
 * regresses -- which is the day the documented gap list must change.
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

/** Maps the fixture's one spec file (`checkout.spec.ts`) to an area. */
const AREAS = { areas: [{ path: 'src/checkout.ts', risk_score: 0.9 }] };

async function recordThenGaps(
  areas?: unknown,
): Promise<{ code: number; recStderr: string; gaps: Gap[] }> {
  if (areas !== undefined) {
    mkdirSync(join(tmp, '.canary'), { recursive: true });
    writeFileSync(
      join(tmp, '.canary', 'critical-areas.json'),
      JSON.stringify(areas),
      'utf-8',
    );
  }
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
  return { code: res.code, recStderr: rec.stderr, gaps: body.consumers };
}

function find(gaps: Gap[], id: string): Gap {
  const gap = gaps.find((g) => g.id === id);
  if (!gap) throw new Error(`no consumer ${id}`);
  return gap;
}

describe('history gaps over a store written by history record', () => {
  it('feeds flaky-area, screech-cluster and failure-categories when critical-areas.json maps the spec (G1, G2, G8 closed)', async () => {
    const { code, recStderr, gaps } = await recordThenGaps(AREAS);
    expect(recStderr).not.toContain('area not recorded');
    const area = find(gaps, 'flaky-area');
    expect(area.status).toBe('fed');
    expect(area.coverage[0]).toMatchObject({ carried: 3, applicable: 3 });
    expect(find(gaps, 'screech-cluster').status).toBe('fed');
    const categories = find(gaps, 'failure-categories');
    expect(categories.status).toBe('fed');
    // The failure AND the flake now carry error text (G8) and a category.
    expect(
      categories.coverage.map((c) => [c.field, c.carried, c.applicable]),
    ).toEqual([
      ['error_text', 2, 2],
      ['failure_category', 2, 2],
    ]);
    // Every counted consumer is fed; order-ttff is opt-in and skipped.
    expect(code).toBe(0);
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

  it('keeps area dark, and says so, when critical-areas.json is absent', async () => {
    const { code, recStderr, gaps } = await recordThenGaps();
    expect(recStderr).toContain('note: area not recorded');
    expect(recStderr).toContain('.canary/critical-areas.json');
    expect(find(gaps, 'flaky-area').status).toBe('dark');
    const cluster = find(gaps, 'screech-cluster');
    expect(cluster.status).toBe('dark');
    // Only the hard failure: screech's isFailure does not count a flake.
    expect(
      cluster.coverage.map((c) => [c.field, c.carried, c.applicable]),
    ).toEqual([
      ['area', 0, 1],
      ['failure_category', 1, 1],
    ]);
    expect(find(gaps, 'failure-categories').status).toBe('fed');
    expect(code).toBe(1);
  });

  it('reports order-ttff dark on a store recorded without --order-plan', async () => {
    const { gaps } = await recordThenGaps();
    const ttff = find(gaps, 'order-ttff');
    expect(ttff.status).toBe('dark');
    expect(ttff.coverage[0]).toMatchObject({ carried: 0, applicable: 1 });
  });
});
