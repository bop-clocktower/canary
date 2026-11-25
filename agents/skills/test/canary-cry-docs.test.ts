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
import {
  CHECKPOINT_FORMAT,
  newCheckpoint,
  partialLine,
  recordResult,
} from '../claude-code/canary-cry/scripts/checkpoint.mjs';
import { PATTERNS } from '../claude-code/canary-cry/scripts/patterns.mjs';
import {
  runRounds,
  toResult,
} from '../claude-code/canary-cry/scripts/rounds.mjs';
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

const cells = (line: string | undefined) =>
  (line ?? '')
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim());
// The table row whose first cell is `first`, compared as a literal string: no
// regex is built from data, so a label never needs escaping.
const row = (first: string) =>
  SKILL_MD.split('\n').find(
    (l) => l.trimStart().startsWith('|') && cells(l)[0] === first,
  );

describe('canary-cry SKILL.md (P1-P4)', () => {
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
    'lists pattern %s with its catalog weight, core and mayRefuse flags',
    (id, p: any) => {
      const [, core, weight, , , mayRefuse] = cells(row(`\`${id}\``));
      expect(weight, id).toBe(String(p.weight));
      expect(core, id).toBe(p.core ? 'yes' : 'no');
      // One flag per intensity (#608 P4), written `i1 / i2 / i3`.
      const flags = p.mayRefuse.map((f: boolean) => (f ? 'yes' : 'no'));
      expect(mayRefuse, id).toBe(flags.join(' / '));
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
    expect(row(first), first).toBeDefined();
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

  it('no longer lists the token-expiry false positive as a known limit (#1720)', () => {
    expect(PROSE).not.toContain('correctly refuses the unauthenticated write');
    expect(PROSE).toContain('passes on a clean refusal');
  });

  it('shows the standalone replay command', () => {
    expect(SKILL_MD).toContain(
      'npx playwright test -c playwright.config.mjs specs/<scenario>.spec.mjs',
    );
  });
});

/** A scream of `rounds` rounds whose round-k scenario finds `found[k]`. */
async function screamLine(found: (string | null)[]) {
  const scenarios = found.map((_, i) => ({
    id: `f:multi-submit:i${i + 1}:sa`,
    flow: 'f',
    pattern: 'multi-submit',
    intensity: i + 1,
  }));
  const observation = (inv: string | null) => ({
    verdict: inv === null ? 'clean' : 'corrupted',
    reason: null,
    invariants: inv === null ? [] : [{ id: inv, breached: true }],
    signals: [],
  });
  const out = await runRounds({
    manifest: { amplitude: 'scream', scenarios },
    run: { id: RUN_ID, manifestSha: 'e'.repeat(64) },
    resumed: null,
    runOne: async (s: any) => ({
      result: toResult(s, observation(found[s.intensity - 1]!)),
    }),
    save: () => {},
    clock: () => 0,
    maxWall: null,
  });
  return out.line!;
}

const RUN_ID = '20261125T143333Z-0123abcd';

describe('canary-cry SKILL.md: rounds, checkpoints, --resume (P4)', () => {
  it('has a run usage line for --resume and documents --max-wall', () => {
    expect(SKILL_MD).toContain('canary-cry run --resume RUN_ID --confirm SHA');
    expect(SKILL_MD).toContain('[--max-wall D]');
  });

  it('documents the convergence line, worded as the code prints it', async () => {
    const line = await screamLine([null, null, null]);
    expect(line).toBe('converged after round 2');
    expect(SKILL_MD).toContain(line);
  });

  it('documents the ceiling line, worded as the code prints it', async () => {
    const line = await screamLine([null, 'one-order', null]);
    expect(PROSE).toContain(line);
  });

  it('documents the PARTIAL line, worded as the code prints it', () => {
    const cp = ['a', 'b'].reduce(
      (c, step) =>
        recordResult(c, {
          id: `f:multi-submit:i1:s${step}`,
          verdict: 'clean',
          fingerprints: [],
        }),
      newCheckpoint({ runId: RUN_ID, manifestSha: 'e'.repeat(64), total: 6 }),
    );
    expect(SKILL_MD).toContain(partialLine(cp));
  });

  it('names the checkpoint format the code writes', () => {
    expect(PROSE).toContain(`\`${CHECKPOINT_FORMAT}\``);
  });

  it('lists every stop reason findings.json can carry', () => {
    for (const reason of [
      'budget',
      'converged',
      'ceiling',
      'partial',
      'crashed',
    ]) {
      expect(PROSE, reason).toContain(`\`${reason}\``);
    }
  });
});
