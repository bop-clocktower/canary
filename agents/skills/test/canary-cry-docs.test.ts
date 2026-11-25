/**
 * canary-cry's SKILL.md says what the shipped code does (#608 P1, P2; the full
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
import { PATTERNS } from '../claude-code/canary-cry/scripts/patterns.mjs';

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

describe('canary-cry SKILL.md (P1, P2)', () => {
  it.each(['validate', 'matrix', 'run'])(
    'has a section for `%s`',
    (command) => {
      expect(SKILL_MD).toMatch(new RegExp(`^## \`${command}\``, 'm'));
    },
  );

  it.each(['0', '2', '3', '4'])('has an exit-code row for %s', (code) => {
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
