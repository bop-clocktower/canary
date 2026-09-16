import { describe, expect, it } from 'vitest';
import {
  droppedLines,
  judgmentLines,
} from '../src/briefing/judgment-sections.js';
import { renderCharter } from '../src/briefing/charter.js';
import type { BriefingFacts } from '../src/briefing/facts.js';

const result = {
  mission: 'Explore the discount.',
  verify: [{ text: 'Apply 10%', cite: 'src/a.ts:2' }],
  edge_cases: [
    { category: 'Boundary values' as const, text: '100%', cite: 'src/a.ts:2' },
  ],
  dropped: [
    {
      section: 'verify' as const,
      text: 'Vague',
      cite: null,
      reason: 'no citation',
    },
  ],
};

describe('judgment sections', () => {
  it('renders mission, a verify checklist and grouped edge cases in order', () => {
    const md = judgmentLines(result).join('\n');
    expect(md).toContain('**Mission:** Explore the discount.');
    expect(md).toContain('- [ ] Apply 10% (`src/a.ts:2`)');
    expect(md).toContain('#### Boundary values');
    expect(md).not.toContain('#### Race conditions');
    expect(md.indexOf('### Verify by hand')).toBeLessThan(
      md.indexOf('### Edge cases this diff invites'),
    );
  });
  it('states an empty section instead of printing a bare heading', () => {
    const md = judgmentLines({ ...result, verify: [], edge_cases: [] }).join(
      '\n',
    );
    expect(md).toContain('No verify item cited a changed line.');
    expect(md).toContain('No edge case cited a changed line.');
  });
  it('lists dropped items with their reason', () => {
    expect(droppedLines(result.dropped)).toContain(
      '- Dropped verify item "Vague" \u{2014} no citation',
    );
  });
  it('uses no status emoji and no pass/fail words (criterion 7)', () => {
    const md = judgmentLines(result).join('\n');
    expect(md).not.toMatch(/\bpass(ed)?\b|\bfail(ed)?\b|[\u{2705}\u{274C}]/iu);
  });
});

describe('renderCharter with judgment', () => {
  const facts: BriefingFacts = {
    schema_version: 1,
    provenance: 'Diff: x',
    coverage: { status: 'unavailable' },
    risk_ranking: 'unavailable',
    inventory: 'unavailable',
    units: [
      {
        path: 'src/a.ts',
        added_ranges: [[1, 3]],
        coverage: 'unknown',
        execution_evidence: null,
        imported_by: null,
        uncovered_lines: [],
      },
    ],
    skipped: [],
  };
  const skillPointer = 'come from the `canary-mission-briefing` skill';

  it('is unchanged without judgment', () => {
    const md = renderCharter(facts);
    expect(md).toContain(skillPointer);
    expect(md).not.toContain('### Verify by hand');
  });

  it('places judgment before existing tests and lists dropped items', () => {
    const md = renderCharter(facts, result);
    const order = [
      '**Mission:**',
      '### Verify by hand',
      '### Edge cases this diff invites',
      '### Existing tests',
      '### Out of this charter',
      'Dropped verify item "Vague"',
    ].map((s) => md.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(md).not.toContain(skillPointer);
  });
});
