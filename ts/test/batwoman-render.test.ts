/**
 * The renderer, register by register. Every test injects a persona registry;
 * none reads the shipped registry from disk.
 */
import { describe, expect, it } from 'vitest';

import { summaryLine, wrap } from '../src/analysis/batwoman/render.js';
import { MIXED, render, v } from './batwoman-testkit.js';

describe('summaryLine', () => {
  it('prints one column per status plus the changed-file total', () => {
    expect(summaryLine(MIXED)).toBe(
      '7 changed · 0 exercised · 2 not exercised · 0 abstained · ' +
        '3 no probe · 2 n/a',
    );
  });

  it('sums its columns to the changed-file total', () => {
    const numbers = [...summaryLine(MIXED).matchAll(/(\d+) /g)].map((m) =>
      Number(m[1]),
    );
    const [total, ...columns] = numbers;
    expect(columns.reduce((a, b) => a + b, 0)).toBe(total);
  });

  it('prints every column on an all-exercised run, with no all-clear', () => {
    expect(summaryLine([v('a.yml', 'exercised')])).toBe(
      '1 changed · 1 exercised · 0 not exercised · 0 abstained · ' +
        '0 no probe · 0 n/a',
    );
  });

  it('prints every column on an empty run', () => {
    expect(summaryLine([])).toContain('0 changed');
    expect(summaryLine([])).toContain('0 abstained');
  });
});

describe('wrap', () => {
  it('breaks on word boundaries under the width', () => {
    const lines = wrap('one two three four five', 9, '');
    expect(lines.every((line) => line.length <= 9)).toBe(true);
    expect(lines.join(' ')).toBe('one two three four five');
  });

  it('keeps a word longer than the width on its own line', () => {
    expect(wrap('supercalifragilistic ok', 5, '')).toEqual([
      'supercalifragilistic',
      'ok',
    ]);
  });

  it('applies the indent to every line', () => {
    const lines = wrap('one two', 6, '..');
    expect(lines.every((line) => line.startsWith('..'))).toBe(true);
  });
});

describe('the report header', () => {
  it('names the repo and issue, the closing sha and its subject', () => {
    const out = render('junior');
    expect(out).toContain('canary batwoman — canary#749');
    expect(out).toContain('1e0c05b');
    expect(out).toContain('make the refresh-baseline label refresh');
  });

  it('prints the merge timestamp', () => {
    expect(render('junior')).toContain('2026-08-22 17:34 UTC');
  });

  it('always ends with the summary line', () => {
    for (const id of ['sdet', 'junior', 'manual']) {
      expect(render(id).trimEnd().endsWith(summaryLine(MIXED))).toBe(true);
    }
  });
});

describe('persona provenance', () => {
  it('prints the register, its label and its source when chosen', () => {
    const out = render('sdet');
    expect(out).toContain('sdet');
    expect(out).toContain('explicit');
  });

  it('renders the registry fallback and says so when nothing is chosen', () => {
    const out = render(null);
    expect(out).toContain('junior');
    expect(out).toContain('fallback');
    expect(out).toContain("fell back to 'junior'");
  });

  it('reports an unknown register as the mistake it is, not as silence', () => {
    const out = render('architect');
    expect(out).toContain('junior');
    expect(out).toContain('architect');
  });
});
