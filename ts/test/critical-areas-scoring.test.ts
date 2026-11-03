/**
 * The pure document builder behind `canary critical-areas` (#1529). The numbers
 * here are the spec's D3/D4/D5/D9/D13/D14 rules, so a change to the formula has
 * to change a test.
 */
import { describe, expect, it } from 'vitest';

import {
  buildDocument,
  MAX_AREAS,
  type FileSignals,
} from '../src/critical-areas/scoring.js';

const ABSENT = { status: 'absent', reason: 'test' } as const;

function doc(
  files: FileSignals[],
  symbols: ReadonlyMap<string, string[]> = new Map(),
  extras: FileSignals[] = [],
) {
  return buildDocument({
    generated: '2026-01-01T00:00:00.000Z',
    base: 'a'.repeat(40),
    files,
    extras,
    symbols,
    sources: { churn: ABSENT, importers: ABSENT, coverage: ABSENT },
  });
}

const file = (
  path: string,
  churn: number | null,
  importers: number,
  coveragePct: number | null = null,
): FileSignals => ({ path, churn, importers, coveragePct });

const area = (d: ReturnType<typeof doc>, path: string) => {
  const found = d.areas.find((a) => a.path === path);
  if (found === undefined) throw new Error(`${path} is not listed`);
  return found;
};

describe('buildDocument scoring', () => {
  it('weighs churn and importers equally against the maxima in scope (D3)', () => {
    const d = doc([file('full.ts', 10, 10), file('half.ts', 5, 0)]);
    expect(area(d, 'full.ts').risk_score).toBe(1);
    expect(area(d, 'half.ts').risk_score).toBe(0.25);
  });

  it('falls back to importers alone when churn is unmeasured (D9)', () => {
    const d = doc([file('a.ts', null, 4)]);
    const a = area(d, 'a.ts');
    expect(a.risk_score).toBe(1);
    expect(a.churn_commits).toBeNull();
    expect(a.signals).not.toContain('high_churn');
    expect(a.summary).toContain('churn not measured');
  });

  it('adds a proportional coverage boost to a file with another signal (D4)', () => {
    // Base 0.5 comes from the full-importers half alone.
    const d = doc([
      file('peer.ts', 10, 0),
      file('low.ts', 0, 10, 40),
      file('at50.ts', 0, 10, 50),
    ]);
    const low = area(d, 'low.ts');
    expect(low.risk_score).toBe(0.59);
    expect(low.signals).toContain('low_coverage');
    expect(area(d, 'at50.ts').signals).not.toContain('low_coverage');
  });

  it('does not make a file critical for being untested alone (D4)', () => {
    const d = doc([file('busy.ts', 10, 10), file('untested.ts', 0, 0, 0)]);
    expect(d.areas.map((a) => a.path)).toEqual(['busy.ts']);
  });

  it('writes null coverage with no boost and says so', () => {
    const d = doc([file('peer.ts', 10, 0), file('a.ts', 0, 10)]);
    const a = area(d, 'a.ts');
    expect(a.coverage_pct).toBeNull();
    expect(a.risk_score).toBe(0.5);
    expect(a.signals).not.toContain('low_coverage');
    expect(a.summary).toContain('coverage not measured');
  });

  it('caps a score at exactly 1', () => {
    expect(area(doc([file('a.ts', 10, 10, 0)]), 'a.ts').risk_score).toBe(1);
  });

  it('fires high_churn at exactly half the maximum and not just below', () => {
    const d = doc([
      file('max.ts', 10, 0),
      file('half.ts', 5, 0),
      file('below.ts', 4, 0),
    ]);
    expect(area(d, 'half.ts').signals).toContain('high_churn');
    expect(area(d, 'below.ts').signals).not.toContain('high_churn');
  });

  it('fires many_dependents at half, and only then recommends integration', () => {
    const d = doc([
      file('max.ts', 0, 10),
      file('half.ts', 0, 5),
      file('below.ts', 0, 4),
    ]);
    expect(area(d, 'half.ts').signals).toContain('many_dependents');
    expect(area(d, 'half.ts').recommended_test_types).toEqual([
      'unit',
      'integration',
    ]);
    expect(area(d, 'below.ts').signals).not.toContain('many_dependents');
    expect(area(d, 'below.ts').recommended_test_types).toEqual(['unit']);
  });

  it('writes rank_score equal to risk_score on every area (D14)', () => {
    const d = doc([file('a.ts', 3, 1), file('b.ts', 1, 3), file('c.ts', 2, 2)]);
    expect(d.areas.length).toBe(3);
    for (const a of d.areas) expect(a.rank_score).toBe(a.risk_score);
  });
});

describe('buildDocument area selection', () => {
  const thirty = Array.from({ length: 30 }, (_, i) =>
    file(`f${String(i).padStart(2, '0')}.ts`, 30 - i, 0),
  );

  it('lists at most MAX_AREAS, highest score first', () => {
    const d = doc(thirty);
    expect(MAX_AREAS).toBe(25);
    expect(d.areas.length).toBe(25);
    expect(d.areas[0]!.path).toBe('f00.ts');
    expect(d.areas[24]!.path).toBe('f24.ts');
    expect(d.files_analyzed).toBe(30);
  });

  it('breaks a tie by path ascending', () => {
    const d = doc([file('b.ts', 1, 1), file('c.ts', 1, 1), file('a.ts', 1, 1)]);
    expect(d.areas.map((a) => a.path)).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('keeps a declared path ranked below the top 25 (D5, D13)', () => {
    const d = doc(thirty, new Map([['f26.ts', ['charge']]]));
    expect(d.areas.length).toBe(26);
    expect(area(d, 'f26.ts').symbols).toEqual(['charge']);
  });

  it('keeps a declared path with a zero score (D13)', () => {
    const d = doc(
      [file('a.ts', 1, 1), file('quiet.ts', 0, 0)],
      new Map([['quiet.ts', ['s']]]),
    );
    const quiet = area(d, 'quiet.ts');
    expect(quiet.risk_score).toBe(0);
    expect(quiet.symbols).toEqual(['s']);
  });

  it('omits the symbols key from an area without any', () => {
    const d = doc([file('a.ts', 1, 1)]);
    expect('symbols' in area(d, 'a.ts')).toBe(false);
  });

  it('returns no areas when nothing scores, even with declared symbols', () => {
    const quiet = [file('a.ts', 0, 0), file('b.ts', 0, 0)];
    expect(doc(quiet).areas).toEqual([]);
    expect(doc(quiet, new Map([['a.ts', ['s']]])).areas).toEqual([]);
  });

  it('lists a declared extra without moving another file`s score', () => {
    const files = [file('a.ts', 2, 0), file('b.ts', 1, 0)];
    const extra = file('tests/x.test.ts', 100, 0);
    const d = doc(files, new Map([['tests/x.test.ts', ['s']]]), [extra]);
    expect(area(d, 'a.ts').risk_score).toBe(0.5);
    expect(area(d, 'tests/x.test.ts').symbols).toEqual(['s']);
    expect(d.files_analyzed).toBe(2);
  });
});
