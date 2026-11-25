/**
 * Diff scope and the D7 mutant cap for the mutation run (#486 slice 2).
 *
 * The scope decides what a PR's mutation run can claim to have checked, so the
 * filters are tested on what they DROP as hard as on what they keep: a test
 * file or a declaration file that slipped into scope would spend the budget on
 * mutants no test could kill, and every one would read as a weak assertion.
 */
import { describe, expect, it } from 'vitest';

import {
  MUTANT_CAP,
  mutateEntries,
  mutationTargets,
  sampleLines,
} from '../src/guardian/mutation-scope.js';

describe('mutationTargets', () => {
  it('keeps added ranges under ts/src and makes the path ts-relative', () => {
    const targets = mutationTargets([
      { path: 'ts/src/a.ts', added_ranges: [[3, 5]] },
    ]);
    expect(targets).toEqual([{ path: 'src/a.ts', ranges: [[3, 5]] }]);
  });

  it('drops everything Stryker should not mutate', () => {
    const targets = mutationTargets([
      { path: 'docs/a.md', added_ranges: [[1, 1]] },
      { path: 'ts/test/a.test.ts', added_ranges: [[1, 1]] },
      { path: 'ts/src/a.test.ts', added_ranges: [[1, 1]] },
      { path: 'ts/src/types.d.ts', added_ranges: [[1, 1]] },
      { path: 'ts/src/data/registry.json', added_ranges: [[1, 1]] },
      { path: 'agents/skills/x/scripts/run.mjs', added_ranges: [[1, 1]] },
      { path: 'ts/srcfoo/a.ts', added_ranges: [[1, 1]] },
    ]);
    expect(targets).toEqual([]);
  });

  it('orders targets by path so the run is the same however the diff is ordered', () => {
    const targets = mutationTargets([
      { path: 'ts/src/z.ts', added_ranges: [[1, 1]] },
      { path: 'ts/src/a.ts', added_ranges: [[2, 2]] },
    ]);
    expect(targets.map((t) => t.path)).toEqual(['src/a.ts', 'src/z.ts']);
  });

  it('yields nothing for an empty diff', () => {
    expect(mutationTargets([])).toEqual([]);
  });
});

describe('mutateEntries', () => {
  it('emits one Stryker line-range entry per range', () => {
    expect(
      mutateEntries([
        {
          path: 'src/a.ts',
          ranges: [
            [3, 5],
            [9, 9],
          ],
        },
      ]),
    ).toEqual(['src/a.ts:3-5', 'src/a.ts:9-9']);
  });
});

describe('sampleLines (D7 cap)', () => {
  it('is the identity at or under the cap', () => {
    const sample = sampleLines(
      [
        { path: 'src/a.ts', line: 3, mutants: 2 },
        { path: 'src/a.ts', line: 4, mutants: 1 },
      ],
      3,
    );
    expect(sample).toEqual({
      generated: 3,
      planned: 3,
      capped: false,
      targets: [{ path: 'src/a.ts', ranges: [[3, 4]] }],
    });
  });

  it('keeps a deterministic (path, line) prefix over the cap and discloses the total', () => {
    const counts = [
      { path: 'src/b.ts', line: 1, mutants: 2 },
      { path: 'src/a.ts', line: 7, mutants: 2 },
      { path: 'src/a.ts', line: 2, mutants: 2 },
    ];
    const first = sampleLines(counts, 4);
    const second = sampleLines([...counts].reverse(), 4);
    expect(first).toEqual(second);
    expect(first).toEqual({
      generated: 6,
      planned: 4,
      capped: true,
      targets: [
        {
          path: 'src/a.ts',
          ranges: [
            [2, 2],
            [7, 7],
          ],
        },
      ],
    });
  });

  it('stops at the first line that does not fit rather than skipping ahead', () => {
    // Skipping ahead to a smaller later line would make the sample depend on
    // the mutant counts of lines after the cut, not just on position.
    const sample = sampleLines(
      [
        { path: 'src/a.ts', line: 1, mutants: 2 },
        { path: 'src/a.ts', line: 2, mutants: 5 },
        { path: 'src/a.ts', line: 3, mutants: 1 },
      ],
      4,
    );
    expect(sample.planned).toBe(2);
    expect(sample.targets).toEqual([{ path: 'src/a.ts', ranges: [[1, 1]] }]);
  });

  it('never samples zero lines when the first line alone is over the cap', () => {
    const sample = sampleLines([{ path: 'src/a.ts', line: 1, mutants: 9 }], 4);
    expect(sample.planned).toBe(9);
    expect(sample.targets).toEqual([{ path: 'src/a.ts', ranges: [[1, 1]] }]);
  });

  it('extends a kept line to the end of a multi-line mutant that starts on it', () => {
    // The first real run reported "sampled 5 of 8" with nothing capped: a
    // BlockStatement spanning 2289-2295 starts on a kept line but ends past
    // the line-only range, so Stryker never generated it.
    const sample = sampleLines(
      [
        { path: 'src/a.ts', line: 1, mutants: 1 },
        { path: 'src/a.ts', line: 2, endLine: 6, mutants: 2 },
        { path: 'src/a.ts', line: 9, mutants: 5 },
      ],
      3,
    );
    expect(sample.capped).toBe(true);
    expect(sample.targets).toEqual([{ path: 'src/a.ts', ranges: [[1, 6]] }]);
  });

  it('charges a kept line for every mutant its extended range pulls in', () => {
    // The dogfood run on this branch tested 177 mutants under a 150 cap: a
    // function's BlockStatement extended one kept line over the whole body,
    // and every mutant starting inside it ran uncounted.
    const counts = [
      { path: 'src/a.ts', line: 1, endLine: 10, mutants: 1 },
      { path: 'src/a.ts', line: 5, mutants: 4 },
      { path: 'src/a.ts', line: 20, mutants: 1 },
    ];
    expect(sampleLines(counts, 3)).toMatchObject({
      planned: 5,
      targets: [{ path: 'src/a.ts', ranges: [[1, 10]] }],
    });
    // A line already inside a kept range is not charged twice.
    expect(sampleLines(counts, 10)).toMatchObject({
      planned: 6,
      capped: false,
      targets: [
        {
          path: 'src/a.ts',
          ranges: [
            [1, 10],
            [20, 20],
          ],
        },
      ],
    });
  });

  it('counts ignored mutants in the total Stryker will report, never in the budget', () => {
    const sample = sampleLines(
      [{ path: 'src/a.ts', line: 1, mutants: 2, ignored: 3 }],
      2,
    );
    expect(sample).toMatchObject({ generated: 5, planned: 2, capped: false });
  });

  it('drops lines that produce no mutant', () => {
    const sample = sampleLines([{ path: 'src/a.ts', line: 1, mutants: 0 }]);
    expect(sample).toEqual({
      generated: 0,
      planned: 0,
      capped: false,
      targets: [],
    });
  });

  it('caps at 150 by default (spec D7)', () => {
    expect(MUTANT_CAP).toBe(150);
    const counts = Array.from({ length: 200 }, (_, i) => ({
      path: 'src/a.ts',
      line: i + 1,
      mutants: 1,
    }));
    expect(sampleLines(counts).planned).toBe(150);
  });
});
