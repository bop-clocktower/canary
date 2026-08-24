/**
 * The renderer, register by register. Every test injects a persona registry;
 * none reads the shipped registry from disk.
 */
import { describe, expect, it } from 'vitest';

import { resolvePersona } from '../src/core/persona.js';
import { explain } from '../src/analysis/batwoman/verdict.js';
import {
  renderReport,
  summaryLine,
  wrap,
} from '../src/analysis/batwoman/render.js';
import {
  FIXTURE_REGISTRY,
  HEADER,
  MIXED,
  render,
  v,
} from './batwoman-testkit.js';

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

describe('the junior register (brief, the declared fallback)', () => {
  it('groups rows under a heading naming the status and its count', () => {
    const out = render('junior');
    expect(out).toContain('NOT EXERCISED — 2 of 7 changed files');
    expect(out).toContain('NO PROBE — 3 files');
    expect(out).toContain('NOT APPLICABLE — 2 files');
  });

  it('omits a section with no rows rather than printing an empty one', () => {
    const out = render('junior');
    expect(out).not.toContain('ABSTAINED');
    expect(out).not.toContain('EXERCISED — 0');
  });

  it('carries each not-exercised row with its full sentence', () => {
    const out = render('junior');
    expect(out).toContain('.github/workflows/refresh-arch-baseline.yml');
    expect(out).toContain('twelve days before this fix merged');
    expect(out).toContain('`refresh-baseline` label');
  });

  it('names the artifact type on every no-probe row', () => {
    expect(render('junior')).toContain('test file');
  });

  it('adds the evidence clause, because the register wants reasoning', () => {
    const out = render('junior', [
      {
        file: 'ci.yml',
        status: 'abstain',
        explanation: explain(
          'The workflow probe could not decide, because gh failed.',
        ),
        evidence: 'gh run list --limit 100',
      },
    ]);
    expect(out).toContain('Read: gh run list --limit 100');
  });

  it('wraps prose rather than emitting one very long line', () => {
    const longest = Math.max(
      ...render('junior')
        .split('\n')
        .map((line) => line.length),
    );
    expect(longest).toBeLessThanOrEqual(78);
  });
});

describe('the header holds the 78-column limit', () => {
  /**
   * Both header values are free text of unbounded length: a commit subject is
   * whatever the author typed, and `ResolvedPersona.reason` is a sentence the
   * resolver composes. The short fixtures elsewhere in this suite kept both
   * lines under the limit by luck, which is what hid the second instance of
   * this defect behind the first. This case supplies a realistically long
   * value for each at once, so the limit is asserted against the header rather
   * than against the fixtures that happen to fit.
   */
  const LONG_SUBJECT =
    'fix(ci): make the refresh-baseline label actually refresh the ' +
    'architecture baseline instead of silently skipping the job';

  /** An unknown register: the resolver's longest real reason. */
  const LONG_REASON = resolvePersona({
    explicit: 'architect',
    registry: FIXTURE_REGISTRY,
  });

  it('gives the resolver a reason long enough to break an unwrapped line', () => {
    // Guard the guard: if the reason were short, the assertion below would
    // pass without exercising the wrap, which is the abstention shape.
    expect(LONG_REASON.reason.length).toBeGreaterThan(33);
  });

  it('wraps a long merge subject and a long persona reason together', () => {
    const out = renderReport({
      header: { ...HEADER, mergeSubject: LONG_SUBJECT },
      repo: 'canary',
      verdicts: MIXED,
      persona: LONG_REASON,
    });
    const longest = Math.max(...out.split('\n').map((line) => line.length));
    expect(longest).toBeLessThanOrEqual(78);
  });

  it('keeps the wrapped subject and reason readable, not truncated', () => {
    const out = renderReport({
      header: { ...HEADER, mergeSubject: LONG_SUBJECT },
      repo: 'canary',
      verdicts: MIXED,
      persona: LONG_REASON,
    });
    // Wrapping must not drop words: every word of both values survives.
    const flattened = out.replace(/\s+/g, ' ');
    for (const word of LONG_SUBJECT.split(' ')) {
      expect(flattened).toContain(word);
    }
    expect(flattened).toContain('architect');
  });
});

describe('the sdet register (terse)', () => {
  it('is shorter than the junior register over the same verdicts', () => {
    expect(render('sdet').split('\n').length).toBeLessThan(
      render('junior').split('\n').length,
    );
  });

  it('renders findings as one bullet per row', () => {
    expect(render('sdet')).toContain(
      '  - .github/workflows/refresh-arch-baseline.yml  not-exercised',
    );
  });

  it('keeps the observation-and-cause sentence on every finding row', () => {
    // Terse drops the reasoning extras, never the sentence: a row without one
    // is a status code, which spec D4 rejects.
    expect(render('sdet')).toContain('twelve days before this fix merged');
  });

  it('drops the evidence clause, because it wants no reasoning', () => {
    const out = render('sdet', [
      {
        file: 'ci.yml',
        status: 'abstain',
        explanation: explain(
          'The workflow probe could not decide, because gh failed.',
        ),
        evidence: 'gh run list --limit 100',
      },
    ]);
    expect(out).not.toContain('Read:');
  });

  it('still prints the whole summary line', () => {
    expect(render('sdet')).toContain(
      '7 changed · 0 exercised · 2 not exercised',
    );
  });
});

describe('the manual register (guided)', () => {
  it('numbers the rows within each section', () => {
    const out = render('manual');
    expect(out).toContain('    1. .github/workflows/refresh-arch-baseline.yml');
    expect(out).toContain('    2. scripts/refresh-arch-baseline.mjs');
  });

  it('gives every not-exercised row an actionable next step', () => {
    const out = render('manual');
    expect(out).toContain('Next:');
    expect(out).toMatch(/Next: [A-Z][^\n]*/);
  });

  it('gives an abstain row a different next step from a no-probe row', () => {
    const stepOf = (out: string) =>
      out.split('Next: ')[1]?.split('\n')[0] ?? '';
    const abstained = stepOf(render('manual', [v('ci.yml', 'abstain')]));
    const unprobed = stepOf(render('manual', [v('x.ts', 'no-probe')]));
    expect(abstained).not.toBe('');
    expect(abstained).not.toBe(unprobed);
  });

  it('gives an exercised row no next step, having nothing to ask for', () => {
    expect(render('manual', [v('a.yml', 'exercised')])).not.toContain('Next:');
  });

  it('keeps the evidence clause, because the register wants reasoning', () => {
    const out = render('manual', [
      {
        file: 'ci.yml',
        status: 'abstain',
        explanation: explain(
          'The workflow probe could not decide, because gh failed.',
        ),
        evidence: 'gh run list --limit 100',
      },
    ]);
    expect(out).toContain('Read: gh run list --limit 100');
  });
});
