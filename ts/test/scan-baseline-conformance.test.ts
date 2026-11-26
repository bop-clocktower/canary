/**
 * Drift guard: the engine's scanner baseline must read and write exactly as
 * the skills' does (#1322).
 *
 * `src/core/scan-baseline.ts` is a port of `agents/skills/lib/scan-baseline.mjs`
 * -- the skills ship without the engine, and the engine is compiled
 * TypeScript, so neither can import the other. The point of the feature is ONE
 * file format and ONE comparison across `vacuity-check`, canary-savant and
 * canary-blackhawk; two copies that drifted would make that a claim rather
 * than a property. So a shared corpus runs through both and must produce the
 * same bytes, the same comparison and the same verdict on every malformed file.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as engine from '../src/core/scan-baseline.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

type Id = { file: string; rule: string; anchor: string };
type Port = Pick<
  typeof engine,
  | 'identityOf'
  | 'buildBaseline'
  | 'serializeBaseline'
  | 'parseBaseline'
  | 'compareBaseline'
>;

const skill = (await import(
  pathToFileURL(join(REPO_ROOT, 'agents/skills/lib/scan-baseline.mjs')).href
)) as Port;

const RAW: Id[] = [
  { file: 'tests/b.test.ts', rule: 'VAC-001', anchor: 'proves  nothing' },
  { file: './tests/a.test.ts', rule: 'VAC-002', anchor: '\tsaves\n it ' },
  { file: 'tests/a.test.ts', rule: 'VAC-002', anchor: 'saves it' },
  { file: 'tests/a.test.ts', rule: 'VAC-001', anchor: 'Zeta' },
  { file: 'tests/a.test.ts', rule: 'VAC-001', anchor: 'alpha' },
  { file: 'tests/ü.test.ts', rule: 'VAC-005', anchor: 'é' },
];
const ids = (port: Port) => RAW.map((f) => port.identityOf(f, '/repo'));

const MALFORMED = [
  '',
  '{',
  '[]',
  'null',
  JSON.stringify({ schemaVersion: 2, tool: 't', findings: [] }),
  JSON.stringify({ schemaVersion: 1, tool: 'other', findings: [] }),
  JSON.stringify({ schemaVersion: 1, tool: 't', findings: {} }),
  JSON.stringify({ schemaVersion: 1, tool: 't', findings: [null] }),
  JSON.stringify({
    schemaVersion: 1,
    tool: 't',
    findings: [{ file: 'f', rule: 'R', anchor: 'x', count: 1.5 }],
  }),
  JSON.stringify({
    schemaVersion: 1,
    tool: 't',
    findings: [
      { file: 'f', rule: 'R', anchor: 'x', count: 1 },
      { file: 'f', rule: 'R', anchor: 'x', count: 2 },
    ],
  }),
];

describe('scan-baseline: engine port vs skills lib', () => {
  it('derives the same identities', () => {
    expect(ids(engine)).toEqual(ids(skill));
  });

  it('serializes the same bytes', () => {
    const e = engine.serializeBaseline(engine.buildBaseline('t', ids(engine)));
    const s = skill.serializeBaseline(skill.buildBaseline('t', ids(skill)));
    expect(e).toBe(s);
    // Planted positive: the corpus really collapses a duplicate into count 2.
    expect(e).toContain('"count": 2');
  });

  it('compares the same way, multiset included', () => {
    const base = engine.buildBaseline('t', ids(engine).slice(0, 4));
    const head = [...ids(engine).slice(2), ids(engine)[2]!];
    const e = engine.compareBaseline(base, head);
    expect(skill.compareBaseline(base, head)).toEqual(e);
    expect(e.newCount).toBeGreaterThan(0);
    expect(e.fixedCount).toBeGreaterThan(0);
  });

  it.each(MALFORMED)('rejects the same malformed file: %s', (text) => {
    const e = engine.parseBaseline(text, 't');
    const s = skill.parseBaseline(text, 't');
    expect(e.error).toBeTruthy();
    expect(Boolean(s.error)).toBe(true);
    expect(e.baseline).toBeUndefined();
    expect(s.baseline).toBeUndefined();
  });

  it('parses a round-tripped file to the same baseline', () => {
    const text = engine.serializeBaseline(
      engine.buildBaseline('t', ids(engine)),
    );
    expect(engine.parseBaseline(text, 't')).toEqual(
      skill.parseBaseline(text, 't'),
    );
  });
});
