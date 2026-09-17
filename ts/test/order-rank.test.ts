/**
 * `canary order` ranking core (#460 phase 2). Proposal criteria 3 (permutation,
 * property-tested, with a mutant that must fail), 4 (cold start), 5 (planted
 * failure) and 6 (explainability).
 */

import { describe, expect, it } from 'vitest';

import {
  assertPermutation,
  buildOrderPlan,
  type OrderInput,
  type OrderPlan,
} from '../src/analysis/order/rank.js';
import type { RunRecord } from '../src/history/record.js';

function run(
  i: number,
  failing: string[],
  files: string[],
  suite = 's',
): RunRecord {
  return {
    run_id: `r${i}`,
    suite,
    timestamp: `2026-09-${String(10 + i).padStart(2, '0')}T00:00:00+00:00`,
    tests: files.map((f) => ({
      test_name: `${f} t`,
      test_file: f,
      status: failing.includes(f) ? 'failed' : 'passed',
      duration_ms: 10,
    })),
  };
}

const files = (n: number): string[] =>
  Array.from(
    { length: n },
    (_, i) => `test/f${String(i).padStart(2, '0')}.test.ts`,
  );

const input = (over: Partial<OrderInput> = {}): OrderInput => ({
  suite: 's',
  files: files(5),
  runs: [],
  changed: null,
  imports: null,
  ...over,
});

const order = (plan: OrderPlan): string[] =>
  plan.entries.map((e) => e.test_file);

/** Small seeded PRNG so the property test is reproducible. */
function prng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 2 ** 32;
    return s / 2 ** 32;
  };
}

describe('criterion 3: the plan is a permutation of the input', () => {
  it('holds over 200 random file sets, histories and diffs', () => {
    const rand = prng(460);
    for (let trial = 0; trial < 200; trial++) {
      const all = files(1 + Math.floor(rand() * 40));
      const pick = (): string[] => all.filter(() => rand() < 0.2);
      const runs = Array.from({ length: Math.floor(rand() * 12) }, (_, i) =>
        run(i, pick(), [...pick(), 'test/gone.test.ts']),
      );
      const plan = buildOrderPlan(
        input({ files: all, runs, changed: rand() < 0.5 ? pick() : null }),
      );
      expect([...order(plan)].sort()).toEqual([...all].sort());
      expect(() => assertPermutation(all, plan)).not.toThrow();
    }
  });

  it('a mutant plan that drops a file fails the check', () => {
    const all = files(6);
    const plan = buildOrderPlan(input({ files: all }));
    const mutant = { ...plan, entries: plan.entries.slice(1) };
    expect(() => assertPermutation(all, mutant)).toThrow(/missing/);
  });

  it('a mutant plan that duplicates a file fails the check', () => {
    const all = files(3);
    const plan = buildOrderPlan(input({ files: all }));
    const mutant = { ...plan, entries: [...plan.entries, plan.entries[0]!] };
    expect(() => assertPermutation(all, mutant)).toThrow(/duplicate/);
  });

  it('is deterministic for the same input', () => {
    const all = files(20);
    const runs = [run(0, [all[3]!], all), run(1, [all[7]!], all)];
    const a = buildOrderPlan(input({ files: all, runs, changed: [all[1]!] }));
    const b = buildOrderPlan(input({ files: all, runs, changed: [all[1]!] }));
    expect(order(a)).toEqual(order(b));
  });
});

describe('criterion 4: cold start', () => {
  it('empty store and no diff: declaration mode, input order', () => {
    const all = files(5);
    const plan = buildOrderPlan(input({ files: [...all].reverse() }));
    expect(plan.mode).toBe('declaration');
    expect(order(plan)).toEqual([...all].reverse());
    expect(plan.historyRuns).toBe(0);
  });

  it('1-4 runs with a diff: diff-only, and the reason names the run count', () => {
    const all = files(5);
    const runs = [run(0, [all[4]!], all), run(1, [all[4]!], all)];
    const plan = buildOrderPlan(
      input({ files: all, runs, changed: [all[2]!] }),
    );
    expect(plan.mode).toBe('diff-only');
    expect(plan.modeReason).toMatch(/2 of 5 runs/);
    expect(order(plan)[0]).toBe(all[2]);
  });

  it('counts only runs of the requested suite', () => {
    const all = files(3);
    const runs = Array.from({ length: 6 }, (_, i) => run(i, [], all, 'other'));
    const plan = buildOrderPlan(input({ files: all, runs, changed: [] }));
    expect(plan.historyRuns).toBe(0);
    expect(plan.mode).toBe('diff-only');
  });

  it('5 or more runs: history+diff', () => {
    const all = files(3);
    const runs = Array.from({ length: 5 }, (_, i) => run(i, [], all));
    expect(buildOrderPlan(input({ files: all, runs })).mode).toBe(
      'history+diff',
    );
  });
});

describe('criterion 5: planted failure', () => {
  const all = files(50);
  const flaky = all[37]!;
  const changed = all[12]!;
  const runs = Array.from({ length: 10 }, (_, i) =>
    run(i, [2, 5, 8].includes(i) ? [flaky] : [], all),
  );
  const plan = buildOrderPlan(input({ files: all, runs, changed: [changed] }));

  it('a file that failed 3 of the last 10 runs ranks in the top 5', () => {
    expect(order(plan).slice(0, 5)).toContain(flaky);
  });

  it('a changed file with no failures ranks above files with neither signal', () => {
    const at = order(plan).indexOf(changed);
    const quiet = all.filter((f) => f !== flaky && f !== changed);
    for (const f of quiet) expect(at).toBeLessThan(order(plan).indexOf(f));
  });
});

describe('criterion 6: explainability', () => {
  it('every ranked entry has a reason and every unranked entry has none', () => {
    const all = files(10);
    const runs = Array.from({ length: 6 }, (_, i) => run(i, [all[4]!], all));
    const imports = new Map([['src/util', [all[6]!]]]);
    const plan = buildOrderPlan(
      input({ files: all, runs, changed: ['src/util.ts', all[1]!], imports }),
    );
    const ranked = plan.entries.filter(
      (e) => !plan.unranked.includes(e.test_file),
    );
    expect(ranked.map((e) => e.test_file).sort()).toEqual(
      [all[1]!, all[4]!, all[6]!].sort(),
    );
    for (const e of ranked) expect(e.reasons.length).toBeGreaterThan(0);
    for (const e of plan.entries.filter((x) =>
      plan.unranked.includes(x.test_file),
    )) {
      expect(e.reasons).toEqual([]);
    }
    const reasons = plan.entries.flatMap((e) => e.reasons).join('\n');
    expect(reasons).toMatch(/failed 6 of last 6 runs/);
    expect(reasons).toMatch(/imports src\/util\.ts \(changed\)/);
    expect(reasons).toMatch(/changed in diff/);
  });

  it('unranked files keep declaration order after the ranked ones', () => {
    const all = files(6);
    const plan = buildOrderPlan(input({ files: all, changed: [all[4]!] }));
    expect(order(plan)).toEqual([
      all[4],
      all[0],
      all[1],
      all[2],
      all[3],
      all[5],
    ]);
    expect(plan.unranked).toEqual([all[0], all[1], all[2], all[3], all[5]]);
  });

  it('breaks equal scores by faster mean duration, then by path', () => {
    const all = ['b.test.ts', 'a.test.ts', 'c.test.ts'];
    const runs = Array.from({ length: 5 }, (_, i) => {
      const r = run(i, all, all);
      r.tests = r.tests!.map((t) => ({
        ...t,
        duration_ms: t.test_file === 'c.test.ts' ? 1 : 50,
      }));
      return r;
    });
    const plan = buildOrderPlan(input({ files: all, runs }));
    expect(order(plan)).toEqual(['c.test.ts', 'a.test.ts', 'b.test.ts']);
  });
});
