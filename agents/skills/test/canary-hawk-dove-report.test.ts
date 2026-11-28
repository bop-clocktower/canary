// canary-hawk-dove report (#618): per-gate outcome counts, the ADR 0025 floor
// of 30 adjudicated labels, an abstention that names how many more each gate
// needs, and never a threshold.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  ABSTAINED_LINE,
  CAVEAT,
  MAX_ROWS,
  PRECISION_FLOOR,
  buildReport,
  renderMarkdown,
} from '../claude-code/canary-hawk-dove/scripts/report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function finding(id: string, gate = 'guardian') {
  return {
    v: 1,
    kind: 'finding',
    id,
    gate,
    file: `${id}.ts`,
    rule: 'r',
    anchor: '',
  };
}

function lbl(
  id: string | null,
  outcome: string,
  gate = 'guardian',
  rule = 'explicit',
) {
  return {
    v: 1,
    kind: 'label',
    finding: id,
    gate,
    outcome,
    rule,
    by: 'synthetic-labeller',
    at: '2026-01-01T00:00:00.000Z',
    evidence: 'synthetic',
    note: null,
  };
}

function stateWith(real: number, noise: number, gate = 'guardian') {
  const findings = new Map();
  const labels = [];
  for (let i = 0; i < real + noise; i += 1) {
    const id = `${gate}-${i}`;
    findings.set(id, finding(id, gate));
    labels.push(lbl(id, i < real ? 'real' : 'noise', gate));
  }
  return { findings, runs: [], labels };
}

describe('the floor', () => {
  it('mirrors PRECISION_FLOOR in ts/src/guardian/adjudication.ts', () => {
    const src = fs.readFileSync(
      path.join(HERE, '../../../ts/src/guardian/adjudication.ts'),
      'utf8',
    );
    const m = /export const PRECISION_FLOOR = (\d+);/.exec(src);
    expect(m, 'PRECISION_FLOOR not found in adjudication.ts').not.toBeNull();
    expect(PRECISION_FLOOR).toBe(Number(m![1]));
    expect(PRECISION_FLOOR).toBe(30);
  });
});

describe('buildReport', () => {
  it('abstains below the floor and says how many more labels are needed', () => {
    const report = buildReport(stateWith(20, 9), { malformed: 0 });
    expect(report.abstained).toBe(true);
    expect(report.gates[0]).toMatchObject({
      gate: 'guardian',
      real: 20,
      noise: 9,
      adjudicated: 29,
      meetsFloor: false,
      needs: 1,
    });
    const text = renderMarkdown(report);
    expect(text).toContain(ABSTAINED_LINE);
    expect(text).toContain('needs 1 more');
  });

  it('reports counts and the caveat at the floor, without abstaining', () => {
    const report = buildReport(stateWith(25, 5), { malformed: 0 });
    expect(report.abstained).toBe(false);
    expect(report.gates[0]).toMatchObject({
      adjudicated: 30,
      meetsFloor: true,
      needs: 0,
    });
    const text = renderMarkdown(report);
    expect(text).not.toContain(ABSTAINED_LINE);
    expect(text).toContain(CAVEAT);
    expect(text).toMatch(/\| guardian \| 25 \| 5 \|/);
  });

  it('never prints a threshold or a recommendation, at any count', () => {
    for (const [r, n] of [
      [0, 0],
      [3, 2],
      [200, 40],
    ]) {
      const report = buildReport(stateWith(r, n), { malformed: 0 });
      const out = `${renderMarkdown(report)}\n${JSON.stringify(report)}`;
      expect(out).not.toMatch(
        /threshold\s*[:=]|recommend(ed|ation)\b|suggested|precision/i,
      );
      expect(out).not.toMatch(/%/);
    }
  });

  it('the latest label for a finding wins (a human overrides a derived one)', () => {
    const s = stateWith(0, 0);
    s.findings.set('a', finding('a'));
    s.labels.push(lbl('a', 'noise', 'guardian', 'guardian-fp-suppression'));
    s.labels.push(lbl('a', 'real'));
    const g = buildReport(s, { malformed: 0 }).gates[0];
    expect(g).toMatchObject({ real: 1, noise: 0, overridden: 1 });
  });

  it('counts escapes and intentional labels but not toward the floor', () => {
    const s = stateWith(29, 0);
    s.labels.push(lbl(null, 'escape'));
    s.labels.push(lbl(null, 'escape'));
    s.findings.set('i', finding('i'));
    s.labels.push(lbl('i', 'intentional'));
    const g = buildReport(s, { malformed: 0 }).gates[0];
    expect(g).toMatchObject({
      escape: 2,
      intentional: 1,
      adjudicated: 29,
      needs: 1,
    });
  });

  it('counts findings nobody labelled', () => {
    const s = stateWith(1, 0);
    s.findings.set('u', finding('u'));
    expect(buildReport(s, { malformed: 0 }).gates[0].unlabelled).toBe(1);
  });

  it('an empty ledger abstains with a first fix step', () => {
    const report = buildReport(
      { findings: new Map(), runs: [], labels: [] },
      { malformed: 0 },
    );
    expect(report.abstained).toBe(true);
    expect(report.checked).toBe(0);
    expect(renderMarkdown(report)).toContain('no labels in the ledger');
  });

  it('caps Markdown rows at a realistic upper bound and says how many are hidden', () => {
    const s = stateWith(0, 0);
    for (let i = 0; i < MAX_ROWS + 10; i += 1) {
      s.labels.push(lbl(null, 'escape', `gate-${String(i).padStart(3, '0')}`));
    }
    const report = buildReport(s, { malformed: 0 });
    expect(report.gates).toHaveLength(MAX_ROWS + 10);
    const text = renderMarkdown(report);
    expect(text.match(/^\| gate-/gm)).toHaveLength(MAX_ROWS);
    expect(text).toContain('and 10 more gate(s); see --json.');
  });

  it('escapes a hostile gate name and discloses malformed lines', () => {
    const s = stateWith(0, 0, 'x');
    s.labels.push(lbl(null, 'escape', '| [x](https://evil.example) |\n# h'));
    const text = renderMarkdown(buildReport(s, { malformed: 2 }));
    expect(text).not.toContain('](https://');
    expect(text).not.toContain('https://evil');
    expect(text).not.toMatch(/\n# h/);
    expect(text).toContain('2 malformed ledger line(s) not read');
  });
});
