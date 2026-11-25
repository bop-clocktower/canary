/**
 * canary-cry's SKILL.md says what the shipped code does (#608 P1-P3; the full
 * SC20 check lands with `report` in P5).
 *
 * The pattern table and the budget table are copies of data the code owns
 * (patterns.mjs, matrix.mjs AMPLITUDES), so they are read back against it: a
 * re-weighted pattern or a re-sized budget fails here, not in a reader's head.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ALLOWED_ENVIRONMENTS } from '../claude-code/canary-cry/scripts/gate.mjs';
import { AMPLITUDES } from '../claude-code/canary-cry/scripts/matrix.mjs';
import { buildFindings } from '../claude-code/canary-cry/scripts/findings.mjs';
import { PATTERNS } from '../claude-code/canary-cry/scripts/patterns.mjs';
import {
  scenarioVerdict,
  summarize,
} from '../claude-code/canary-cry/scripts/verdict.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_MD = fs.readFileSync(
  path.join(HERE, '..', 'claude-code', 'canary-cry', 'SKILL.md'),
  'utf8',
);

// Prose is re-wrapped by prettier (proseWrap: always), so a literal sentence is
// matched with its whitespace collapsed.
const PROSE = SKILL_MD.replace(/\s+/g, ' ');

const row = (first: string) =>
  SKILL_MD.split('\n').find((l) =>
    new RegExp(`^\\|\\s*${first}\\s*\\|`).test(l),
  );
const cells = (line: string | undefined) =>
  (line ?? '')
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim());

describe('canary-cry SKILL.md (P1, P2, P3)', () => {
  it.each(['validate', 'matrix', 'run'])(
    'has a section for `%s`',
    (command) => {
      expect(SKILL_MD).toMatch(new RegExp(`^## \`${command}\``, 'm'));
    },
  );

  it.each(['0', '1', '2', '3', '4'])('has an exit-code row for %s', (code) => {
    expect(row(`\`${code}\``), `exit ${code}`).toBeDefined();
  });

  it('documents the abstention line verbatim', () => {
    expect(PROSE).toContain('ABSTAINED: zero scenarios');
  });

  it('lists the allowed environments the gate enforces, exactly', () => {
    expect(PROSE).toContain(
      `${ALLOWED_ENVIRONMENTS.slice(0, -1)
        .map((e) => `\`${e}\``)
        .join(', ')} or \`${ALLOWED_ENVIRONMENTS.at(-1)}\``,
    );
  });

  it('states the server-side limit line verbatim', () => {
    expect(PROSE).toContain(
      'server-side side effects (email, webhooks, payments) are NOT intercepted by canary-cry.',
    );
  });

  it.each(PATTERNS.map((p) => [p.id, p]))(
    'lists pattern %s with its catalog weight and core flag',
    (id, p: any) => {
      const [, core, weight] = cells(row(`\`${id}\``));
      expect(weight, id).toBe(String(p.weight));
      expect(core, id).toBe(p.core ? 'yes' : 'no');
    },
  );

  it.each(Object.entries(AMPLITUDES))(
    'states the %s radius the matrix uses',
    (name, budget: any) => {
      const [, radius] = cells(row(`\`${name}\``));
      const expected =
        budget.radius === Infinity ? 'all flows' : `top ${budget.radius} flows`;
      expect(radius, name).toBe(expected);
    },
  );
});

/** The verdict label verdict.mjs gives one scenario, as SKILL.md writes it. */
function label(over: Record<string, unknown>): string {
  const v = scenarioVerdict({
    flow: 'f',
    pattern: 'multi-submit',
    brokenAt: null,
    invariants: [],
    signals: [],
    ...over,
  });
  const name =
    v.reason === null ? `\`${v.verdict}\`` : `\`abstain: ${v.reason}\``;
  return v.fidelity === null || v.verdict === 'abstain'
    ? name
    : `${name} (${v.fidelity})`;
}

describe('canary-cry SKILL.md: a confirmed run (P3)', () => {
  it.each<[string, Record<string, unknown>]>([
    ['corrupted', { invariants: [{ id: 'i', breached: true }] }],
    ['symptom', { signals: [{ kind: 'pageerror' }] }],
    ['clean', { invariants: [{ id: 'i', breached: false }] }],
    ['no-probes', {}],
    ['flow-broken', { brokenAt: '<step>' }],
    ['probe-failed', { invariants: [{ id: '<invariant>', error: 'x' }] }],
  ])('has a verdict row for %s, worded as the code reports it', (_, over) => {
    const first = label(over);
    expect(row(first.replace(/[()]/g, '\\$&')), first).toBeDefined();
  });

  it.each(['no-observation', 'runtime-error'])(
    'has a verdict row for abstain: %s',
    (reason) => {
      expect(row(`\`abstain: ${reason}\``)).toBeDefined();
    },
  );

  it.each([
    'ABSTAINED: no @playwright/test in target',
    'ABSTAINED: target unreachable',
    'ABSTAINED: playwright crashed',
  ])('documents the run-level abstention %s', (line) => {
    expect(PROSE).toContain(line);
  });

  it('documents the every-scenario-abstained line the summary prints', () => {
    const { reason } = summarize([{ verdict: 'abstain', reason: 'no-probes' }]);
    expect(reason).toMatch(/^every scenario abstained \(/);
    expect(PROSE).toContain('ABSTAINED: every scenario abstained (');
  });

  it('names the findings.json format the code writes', () => {
    const doc = buildFindings({
      run: {},
      manifest: { scenarios: [] },
      observations: new Map(),
    });
    expect(PROSE).toContain(`"format": "${doc.format}"`);
  });

  it('shows the standalone replay command', () => {
    expect(SKILL_MD).toContain(
      'npx playwright test -c playwright.config.mjs specs/<scenario>.spec.mjs',
    );
  });
});
