import { describe, expect, it } from 'vitest';
import type { BriefingUnit } from '../src/briefing/facts.js';
import {
  type RawItem,
  applyJudgment,
  parseJudgment,
} from '../src/briefing/judgment.js';

describe('parseJudgment', () => {
  it('accepts the skill contract shape', () => {
    const j = parseJudgment(
      JSON.stringify({
        mission: 'Explore the discount.',
        verify: [{ text: 'Apply 10%', cite: 'src/discount.ts:2' }],
        edge_cases: [
          {
            category: 'Boundary values',
            text: '0% and 100%',
            cite: 'src/discount.ts:2',
          },
        ],
      }),
    );
    expect(typeof j).toBe('object');
  });
  it('returns a reason string for non-JSON', () => {
    expect(parseJudgment('{nope')).toMatch(/not valid JSON/);
  });
  it('returns a reason string when mission is missing or not a string', () => {
    expect(parseJudgment('{"verify":[],"edge_cases":[]}')).toMatch(/mission/);
  });
  it('returns a reason string when verify or edge_cases is not an array', () => {
    expect(
      parseJudgment('{"mission":"m","verify":{},"edge_cases":[]}'),
    ).toMatch(/verify/);
  });
  it('defaults absent arrays to empty', () => {
    const j = parseJudgment('{"mission":"m"}');
    expect(j).toEqual({ mission: 'm', verify: [], edge_cases: [] });
  });
});

const units: BriefingUnit[] = [
  {
    path: 'src/b.ts',
    added_ranges: [[10, 12]],
    coverage: 'unknown',
    execution_evidence: null,
    imported_by: null,
    uncovered_lines: [],
  },
  {
    path: 'src/a.ts',
    added_ranges: [[1, 3]],
    coverage: 'unknown',
    execution_evidence: null,
    imported_by: null,
    uncovered_lines: [],
  },
];
const judge = (verify: RawItem[], edge_cases: RawItem[] = []) =>
  applyJudgment({ mission: 'm', verify, edge_cases }, units);

describe('applyJudgment (criterion 9)', () => {
  it('keeps an item citing a line inside an added range', () => {
    expect(judge([{ text: 't', cite: 'src/a.ts:3' }]).verify).toEqual([
      { text: 't', cite: 'src/a.ts:3' },
    ]);
  });
  it.each([
    [{ text: 't' }, 'no citation'],
    [{ text: 't', cite: 'src/a.ts' }, 'citation is not path:line'],
    [{ text: 't', cite: 'src/a.ts:0' }, 'citation is not path:line'],
    [{ text: 't', cite: 'src/zzz.ts:1' }, 'cites a file outside this charter'],
    [
      { text: 't', cite: 'src/a.ts:4' },
      'cites a line outside the added ranges',
    ],
    [{ cite: 'src/a.ts:1' }, 'no text'],
  ])('drops %j with reason %s', (item, reason) => {
    const r = judge([item]);
    expect(r.verify).toEqual([]);
    expect(r.dropped[0]).toMatchObject({ section: 'verify', reason });
  });
  it('drops an edge case with an unknown category', () => {
    const r = judge([], [{ category: 'Vibes', text: 't', cite: 'src/a.ts:1' }]);
    expect(r.edge_cases).toEqual([]);
    expect(r.dropped[0]!.reason).toBe('unknown edge-case category');
  });
  it('keeps a cited edge case in a known category', () => {
    const r = judge(
      [],
      [{ category: 'Boundary values', text: 't', cite: ' src/b.ts:11 ' }],
    );
    expect(r.edge_cases).toEqual([
      { category: 'Boundary values', text: 't', cite: 'src/b.ts:11' },
    ]);
  });
  it('orders verify items by the unit order in facts (risk order), stably', () => {
    const r = judge([
      { text: 'a1', cite: 'src/a.ts:1' },
      { text: 'b1', cite: 'src/b.ts:10' },
      { text: 'a2', cite: 'src/a.ts:2' },
    ]);
    expect(r.verify.map((v) => v.text)).toEqual(['b1', 'a1', 'a2']);
  });
});
