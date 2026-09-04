/**
 * Personas as a first-class engine concept (issue #462), and the consumer
 * wiring the detected user level never had (issue #341).
 *
 * These tests drive the module through its three public functions only —
 * `effectivePersonaRegistry`, `resolvePersona`, `personaToDict`. The parsing,
 * merging and overlay-reading helpers are module-private on purpose, so the
 * overlay cases here write real `.canary/personas.json` files to a temp home
 * rather than hand-building layer objects. That costs a few lines of setup and
 * buys a test of the contract that actually ships.
 *
 * Several invariants are deliberately opinionated, because each pins a design
 * decision that would otherwise be re-litigated:
 *
 *   - the fallback persona is *explanatory*, never terse (the repo owner's
 *     stated default on #341 and #342: over-explaining is a mild annoyance,
 *     under-explaining silently fails a manual tester);
 *   - a persona carries no `voice` field, because voice is already its own
 *     axis with its own config surface (`voice/discovery.md`);
 *   - every value `detectUserLevel` can return resolves to something, so the
 *     two vocabularies cannot drift apart again.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { detectUserLevel } from '../src/core/environment-detect.js';
import {
  effectivePersonaRegistry,
  personaToDict,
  resolvePersona,
  type PersonaRegistry,
} from '../src/core/persona.js';

/** An empty home, so the shipped registry is what resolution sees. */
const BARE = mkdtempSync(join(tmpdir(), 'canary-persona-bare-'));
const SHIPPED = effectivePersonaRegistry({ home: BARE });

const ids = (r: PersonaRegistry): string[] => r.personas.map((p) => p.id);
const byId = (r: PersonaRegistry, id: string) =>
  r.personas.find((p) => p.id === id) ?? null;

function persona(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    label: `Label ${id}`,
    audience: `Audience ${id}`,
    depth: 'brief',
    formats: ['bullets'],
    reasoning: true,
    ...over,
  };
}

/**
 * Two signals of genuinely different kinds — enough to clear the floor.
 *
 * Shaped like the detector's real output, because the independence rule reads
 * the signal's kind (the text before the first `": "`) rather than counting
 * strings.
 */
const TWO_KINDS = [
  'project manifest present: package.json',
  'test-framework config present: vitest.config.ts',
];

/** A small hand-built registry, for the precedence cases. */
function registry(over: Partial<PersonaRegistry> = {}): PersonaRegistry {
  return {
    version: 1,
    fallback: 'b',
    minDetectionConfidence: 0.5,
    minDetectionSignals: 2,
    detectionMap: { sdet: 'a', manual: 'b' },
    personas: [
      persona('a', { depth: 'terse', reasoning: false }),
      persona('b'),
    ] as PersonaRegistry['personas'],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The shipped registry
// ---------------------------------------------------------------------------

describe('shipped persona registry', () => {
  it('defines a non-zero number of personas', () => {
    // Denominator rule: a registry that defines nothing has abstained, and
    // every resolution below it would silently return the same fallback.
    expect(SHIPPED.personas.length).toBeGreaterThan(0);
  });

  it('keeps the vocabulary the edge-case skill already published', () => {
    // agents/skills/.../canary-edge-case-discovery/SKILL.md documents
    // `--level sdet|junior|manual`. Changing those ids would be a breaking
    // change to a published skill surface, so the registry adopts them.
    expect(ids(SHIPPED)).toEqual(['sdet', 'junior', 'manual']);
  });

  it('names a fallback that exists', () => {
    expect(byId(SHIPPED, SHIPPED.fallback)).not.toBeNull();
  });

  it('falls back to an explanatory persona, never a terse one', () => {
    const fallback = byId(SHIPPED, SHIPPED.fallback);
    expect(fallback?.depth).not.toBe('terse');
    expect(fallback?.reasoning).toBe(true);
  });

  it('gives every persona a distinct id and a known depth', () => {
    expect(new Set(ids(SHIPPED)).size).toBe(ids(SHIPPED).length);
    for (const p of SHIPPED.personas) {
      expect(['terse', 'brief', 'guided']).toContain(p.depth);
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.audience.length).toBeGreaterThan(0);
      expect(p.formats.length).toBeGreaterThan(0);
    }
  });

  it('carries no voice field — voice is a separate axis', () => {
    // `voice/discovery.md` already resolves a named voice profile from its own
    // project config. Collapsing the two axes would make "terse, in a given
    // voice" inexpressible, which is the exact objection raised on #462.
    // VAC-003 (#706): a loop of absence assertions is satisfied by an EMPTY
    // list, so the denominator has to be asserted or the test proves nothing.
    expect(SHIPPED.personas.length).toBeGreaterThan(0);
    for (const p of SHIPPED.personas) {
      expect(p).not.toHaveProperty('voice');
    }
  });

  it('resolves every user level detectUserLevel can return', () => {
    // The two vocabularies drifted once already: prose said
    // sdet|junior|manual, code said sdet|manual|unknown. Pin the union.
    for (const level of ['sdet', 'manual', 'unknown']) {
      const resolved = resolvePersona({
        detected: { level, confidence: 1, signals: TWO_KINDS },
        home: BARE,
      });
      expect(byId(SHIPPED, resolved.persona.id)).not.toBeNull();
    }
  });

  it('maps an unknown level to the fallback rather than a persona', () => {
    // `unknown` is a real detector outcome, not an audience. A run that fired
    // no signal must not assert one.
    const resolved = resolvePersona({
      detected: { level: 'unknown', confidence: 1, signals: TWO_KINDS },
      home: BARE,
    });
    expect(resolved.source).toBe('fallback');
    expect(resolved.persona.id).toBe(SHIPPED.fallback);
  });

  it('agrees with the live detector on a code-shaped project', () => {
    // Contract test across the #341 seam: the detector's own output must be a
    // resolvable input, not merely a string that happens to look like one.
    const [level, signals] = detectUserLevel(process.cwd(), ['src/thing.ts']);
    const resolved = resolvePersona({
      detected: { level, confidence: 1, signals },
      home: BARE,
    });
    expect(resolved.source).toBe('detected');
    expect(resolved.persona.id).toBe('sdet');
  });
});

// ---------------------------------------------------------------------------
// Reading the base registry off disk
// ---------------------------------------------------------------------------

describe('effectivePersonaRegistry base registry', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'canary-persona-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function load(name: string, body: string): PersonaRegistry {
    const path = join(dir, name);
    writeFileSync(path, body);
    return effectivePersonaRegistry({ home: BARE, registryPath: path });
  }

  it('throws a message naming the file when it is unreadable', () => {
    // The engine's own registry going missing is a packaging fault. Degrading
    // to an empty registry would make every resolution return the same
    // fallback while reporting nothing.
    const missing = join(dir, 'nope.json');
    expect(() =>
      effectivePersonaRegistry({ home: BARE, registryPath: missing }),
    ).toThrow(/nope\.json/);
  });

  it('throws naming the file when the JSON is malformed', () => {
    expect(() => load('truncated.json', '{ "personas": [')).toThrow(
      /is not JSON/,
    );
  });

  it('throws when the payload is not a persona registry', () => {
    expect(() => load('bad.json', '[]')).toThrow(/persona registry/i);
  });

  it('drops malformed persona entries rather than trusting them', () => {
    const loaded = load(
      'partial.json',
      JSON.stringify({
        version: 1,
        fallback: 'ok',
        personas: [
          persona('ok'),
          { id: 'no-label' },
          persona('bad-depth', { depth: 'shouty' }),
          persona('bad-formats', { formats: [1, 2] }),
          persona('bad-reasoning', { reasoning: 'yes' }),
          persona('  '),
          'not-an-object',
        ],
      }),
    );
    expect(ids(loaded)).toEqual(['ok']);
  });

  it('defaults both floors and the detection map when absent', () => {
    const loaded = load(
      'minimal.json',
      JSON.stringify({ fallback: 'ok', personas: [persona('ok')] }),
    );
    expect(loaded.minDetectionConfidence).toBeGreaterThan(0);
    // A registry that forgets the signal floor must not get a floor of zero —
    // that would restore exactly the single-signal trust this removes.
    expect(loaded.minDetectionSignals).toBe(2);
    expect(loaded.detectionMap).toEqual({});
    expect(loaded.version).toBe(1);
  });

  it('lets a registry declare a non-default signal floor', () => {
    const loaded = load(
      'strict.json',
      JSON.stringify({
        fallback: 'ok',
        personas: [persona('ok')],
        minDetectionSignals: 3,
      }),
    );
    expect(loaded.minDetectionSignals).toBe(3);
  });

  it('ignores a non-object detectionMap and non-string targets', () => {
    const loaded = load(
      'odd-map.json',
      JSON.stringify({
        fallback: 'ok',
        personas: [persona('ok')],
        detectionMap: { sdet: 7, manual: 'ok' },
      }),
    );
    expect(loaded.detectionMap).toEqual({ manual: 'ok' });
  });

  it('ignores a non-array personas field', () => {
    expect(() =>
      load('scalar.json', JSON.stringify({ fallback: 'x', personas: 3 })),
    ).not.toThrow();
  });

  it('treats an absent fallback as no opinion, not an empty id', () => {
    const loaded = load(
      'no-fallback.json',
      JSON.stringify({ personas: [persona('only')] }),
    );
    expect(loaded.fallback).toBe('');
    // With no named fallback the first persona applies, rather than throwing
    // on a registry that is otherwise perfectly usable.
    expect(resolvePersona({ registry: loaded }).persona.id).toBe('only');
  });
});

// ---------------------------------------------------------------------------
// Resolution precedence
// ---------------------------------------------------------------------------

describe('resolvePersona', () => {
  it('lets an explicit choice win over a confident detection', () => {
    const resolved = resolvePersona({
      explicit: 'a',
      detected: { level: 'manual', confidence: 1, signals: ['x'] },
      registry: registry(),
    });
    expect(resolved.persona.id).toBe('a');
    expect(resolved.source).toBe('explicit');
    expect(resolved.reason).toMatch(/explicit/i);
  });

  it('accepts an explicit choice case-insensitively', () => {
    const resolved = resolvePersona({ explicit: ' A ', registry: registry() });
    expect(resolved.persona.id).toBe('a');
  });

  it('uses a confident detection when nothing is explicit', () => {
    const resolved = resolvePersona({
      detected: { level: 'sdet', confidence: 0.8, signals: ['s1', 's2'] },
      registry: registry(),
    });
    expect(resolved.persona.id).toBe('a');
    expect(resolved.source).toBe('detected');
    expect(resolved.signals).toEqual(['s1', 's2']);
    expect(resolved.reason).toMatch(/0\.8/);
  });

  it('falls back when the detection is below the confidence floor', () => {
    const resolved = resolvePersona({
      detected: { level: 'sdet', confidence: 0.25, signals: TWO_KINDS },
      registry: registry(),
    });
    expect(resolved.persona.id).toBe('b');
    expect(resolved.source).toBe('fallback');
    // The floor must be named, or a surprised user has nothing to tune.
    expect(resolved.reason).toMatch(/0\.5/);
    // Signals survive: the fallback still owes the user its evidence.
    expect(resolved.signals).toEqual(TWO_KINDS);
  });

  it('treats the floor as inclusive', () => {
    const resolved = resolvePersona({
      detected: { level: 'sdet', confidence: 0.5, signals: TWO_KINDS },
      registry: registry(),
    });
    expect(resolved.source).toBe('detected');
  });

  it('falls back on an unmapped user level', () => {
    const resolved = resolvePersona({
      detected: { level: 'unknown', confidence: 1, signals: [] },
      registry: registry(),
    });
    expect(resolved.persona.id).toBe('b');
    expect(resolved.source).toBe('fallback');
    expect(resolved.reason).toMatch(/unknown/);
  });

  it('falls back when a mapping points at a persona that is gone', () => {
    const resolved = resolvePersona({
      registry: registry({ detectionMap: { sdet: 'deleted' } }),
      detected: { level: 'sdet', confidence: 1, signals: [] },
    });
    expect(resolved.source).toBe('fallback');
    expect(resolved.reason).toMatch(/maps to no persona/);
  });

  it('falls back with no input at all', () => {
    const resolved = resolvePersona({ registry: registry() });
    expect(resolved.persona.id).toBe('b');
    expect(resolved.source).toBe('fallback');
    expect(resolved.signals).toEqual([]);
  });

  it('reads the shipped registry when given no registry', () => {
    expect(resolvePersona().persona.id).toBe(SHIPPED.fallback);
  });

  it('ignores a blank explicit choice', () => {
    const resolved = resolvePersona({ explicit: '   ', registry: registry() });
    expect(resolved.source).toBe('fallback');
    expect(resolved.reason).not.toMatch(/not a known persona/);
  });

  it('names the valid ids when an explicit choice is unknown', () => {
    const resolved = resolvePersona({
      explicit: 'architect',
      registry: registry(),
    });
    expect(resolved.source).toBe('fallback');
    // Fail loud, in the repo's existing uncertain-detection wording.
    expect(resolved.reason).toContain('architect');
    expect(resolved.reason).toContain('a, b');
  });

  it('prefers a valid detection over an unknown explicit choice', () => {
    // An unknown explicit value is a mistake, not an instruction to ignore
    // everything else — but it must still be reported.
    const resolved = resolvePersona({
      explicit: 'architect',
      detected: { level: 'sdet', confidence: 1, signals: TWO_KINDS },
      registry: registry(),
    });
    expect(resolved.persona.id).toBe('a');
    expect(resolved.source).toBe('detected');
    expect(resolved.reason).toContain('architect');
  });

  it('falls back to the first persona when the fallback id is broken', () => {
    const resolved = resolvePersona({
      registry: registry({ fallback: 'gone' }),
    });
    expect(resolved.persona.id).toBe('a');
    expect(resolved.source).toBe('fallback');
  });

  it('throws rather than inventing a persona for an empty registry', () => {
    expect(() =>
      resolvePersona({ registry: registry({ personas: [] }) }),
    ).toThrow(/no personas/i);
  });
});

// ---------------------------------------------------------------------------
// The independent-signal floor
// ---------------------------------------------------------------------------

/**
 * Confidence alone cannot carry this decision, and these tests are why.
 *
 * `detectUserLevel` returns `|sdet - manual| / total` — a *margin* between two
 * tallies, not a probability. One unopposed signal scores a perfect 1.0, so a
 * confidence floor screens ties and nothing else: it will wave through a single
 * observation with total certainty attached. Requiring two signals of genuinely
 * different kinds is the screen that actually discriminates, and "confident and
 * wrong" is the failure this repo keeps rooting out.
 */
describe('resolvePersona independent-signal floor', () => {
  it('refuses a single signal even at full confidence', () => {
    // The whole point. One observation is not evidence about a person.
    const resolved = resolvePersona({
      detected: {
        level: 'sdet',
        confidence: 1,
        signals: ['project manifest present: package.json'],
      },
      registry: registry(),
    });
    expect(resolved.source).toBe('fallback');
    expect(resolved.persona.id).toBe('b');
  });

  it('counts repeated evidence of one kind as one signal', () => {
    // Ten open TypeScript files are one observation restated, not ten
    // independent ones — and the raw count would have said ten.
    const resolved = resolvePersona({
      detected: {
        level: 'sdet',
        confidence: 1,
        signals: [
          'code/test file open: a.ts',
          'code/test file open: b.ts',
          'code/test file open: c.ts',
        ],
      },
      registry: registry(),
    });
    expect(resolved.source).toBe('fallback');
  });

  it('accepts two signals of different kinds', () => {
    const resolved = resolvePersona({
      detected: { level: 'sdet', confidence: 1, signals: TWO_KINDS },
      registry: registry(),
    });
    expect(resolved.source).toBe('detected');
    expect(resolved.persona.id).toBe('a');
  });

  it('accepts two kinds spread across more than two signals', () => {
    const resolved = resolvePersona({
      detected: {
        level: 'sdet',
        confidence: 1,
        signals: [
          'code/test file open: a.ts',
          'code/test file open: b.ts',
          'project manifest present: package.json',
        ],
      },
      registry: registry(),
    });
    expect(resolved.source).toBe('detected');
  });

  it('treats a kindless signal as its own kind', () => {
    // `cwd path suggests manual testing` carries no `": "` separator, so the
    // whole string is the kind. It must still count as one.
    const resolved = resolvePersona({
      detected: {
        level: 'manual',
        confidence: 1,
        signals: [
          'cwd path suggests manual testing',
          'manual artefact open: plan.md',
        ],
      },
      registry: registry(),
    });
    expect(resolved.source).toBe('detected');
    expect(resolved.persona.id).toBe('b');
  });

  it('says insufficient signals, not absent ones', () => {
    // Abstention-vs-absence, the same discipline as the rest of the repo: a
    // reader has to be able to tell "I looked and found too little" from "I
    // found nothing", because only one of them is fixed by opening more files.
    const one = resolvePersona({
      detected: { level: 'sdet', confidence: 1, signals: ['only: one'] },
      registry: registry(),
    });
    expect(one.reason).toMatch(/1 independent signal/);
    expect(one.reason).toMatch(/2 required/);
    expect(one.reason).not.toMatch(/no signal/);

    const none = resolvePersona({
      detected: { level: 'sdet', confidence: 1, signals: [] },
      registry: registry(),
    });
    expect(none.reason).toMatch(/0 independent signal/);
  });

  it('keeps the evidence it rejected, so the user can see it', () => {
    const resolved = resolvePersona({
      detected: { level: 'sdet', confidence: 1, signals: ['only: one'] },
      registry: registry(),
    });
    expect(resolved.signals).toEqual(['only: one']);
  });

  it('reports a missing mapping ahead of the signal count', () => {
    // An unmapped level is a vocabulary problem, not an evidence problem, and
    // telling the user to open more files would be the wrong next step.
    const resolved = resolvePersona({
      detected: { level: 'unknown', confidence: 1, signals: ['only: one'] },
      registry: registry(),
    });
    expect(resolved.reason).toMatch(/maps to no persona/);
    expect(resolved.reason).not.toMatch(/independent signal/);
  });

  it('lets an explicit choice through with no signals at all', () => {
    // The floor governs inference. It must never gate a stated preference.
    const resolved = resolvePersona({
      explicit: 'a',
      detected: { level: 'manual', confidence: 1, signals: [] },
      registry: registry(),
    });
    expect(resolved.source).toBe('explicit');
    expect(resolved.persona.id).toBe('a');
  });

  it('honours a registry that lowers the floor', () => {
    const resolved = resolvePersona({
      detected: { level: 'sdet', confidence: 1, signals: ['only: one'] },
      registry: registry({ minDetectionSignals: 1 }),
    });
    expect(resolved.source).toBe('detected');
  });

  it('is two in the shipped registry, stated rather than defaulted', () => {
    // Declared in registry.json even though the code default matches it, so an
    // overlay author reading the data file can see the policy and retune it.
    expect(SHIPPED.minDetectionSignals).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// The JSON view consumers actually read
// ---------------------------------------------------------------------------

describe('personaToDict', () => {
  it('emits the resolution provenance beside the definition', () => {
    const dict = personaToDict(
      resolvePersona({
        detected: { level: 'manual', confidence: 0.9, signals: TWO_KINDS },
        registry: registry(),
      }),
    );
    expect(dict).toEqual({
      id: 'b',
      label: 'Label b',
      audience: 'Audience b',
      depth: 'brief',
      formats: ['bullets'],
      reasoning: true,
      source: 'detected',
      reason: expect.any(String),
      signals: TWO_KINDS,
    });
  });

  it('copies its arrays so a consumer cannot mutate the registry', () => {
    const reg = registry();
    const dict = personaToDict(
      resolvePersona({ explicit: 'a', registry: reg }),
    );
    (dict['formats'] as string[]).push('mutated');
    (dict['signals'] as string[]).push('mutated');
    expect(byId(reg, 'a')?.formats).toEqual(['bullets']);
  });
});

// ---------------------------------------------------------------------------
// Overlay extension, via the precedence contract that already exists (#333)
// ---------------------------------------------------------------------------

describe('overlay persona extension', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'canary-persona-home-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  /** Write `<home>/.canary/overlays/<name>/.canary/personas.json`. */
  function writeOverlay(name: string, body: string): void {
    const dir = join(home, '.canary', 'overlays', name, '.canary');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'personas.json'), body);
  }

  function declarePrecedence(entries: Record<string, number | null>): void {
    mkdirSync(join(home, '.canary'), { recursive: true });
    writeFileSync(
      join(home, '.canary', 'overlays.json'),
      JSON.stringify({
        overlays: Object.entries(entries).map(([name, precedence]) => ({
          name,
          precedence,
        })),
      }),
    );
  }

  function merged(): PersonaRegistry {
    return effectivePersonaRegistry({ home });
  }

  it('is the shipped registry when no overlay is installed', () => {
    expect(ids(merged())).toEqual(ids(SHIPPED));
  });

  it('adds a persona an overlay defines', () => {
    writeOverlay('acme', JSON.stringify({ personas: [persona('pm')] }));
    expect(ids(merged())).toEqual([...ids(SHIPPED), 'pm']);
  });

  it('lets an overlay redefine a shipped persona in place', () => {
    writeOverlay(
      'acme',
      JSON.stringify({ personas: [persona('sdet', { label: 'Staff SDET' })] }),
    );
    expect(byId(merged(), 'sdet')?.label).toBe('Staff SDET');
    // Overriding must not reorder the base vocabulary.
    expect(ids(merged())).toEqual(ids(SHIPPED));
  });

  it('lets the higher precedence overlay win a collision', () => {
    declarePrecedence({ low: 1, high: 9 });
    writeOverlay(
      'low',
      JSON.stringify({ personas: [persona('sdet', { label: 'Low' })] }),
    );
    writeOverlay(
      'high',
      JSON.stringify({ personas: [persona('sdet', { label: 'High' })] }),
    );
    expect(byId(merged(), 'sdet')?.label).toBe('High');
  });

  it('breaks a precedence tie by overlay name, lowest applied first', () => {
    // Ascending (precedence, name) with last-writer-wins mirrors
    // skill-registry.ts, so both surfaces agree on the winner.
    declarePrecedence({ alpha: 0, zeta: 0 });
    writeOverlay(
      'alpha',
      JSON.stringify({ personas: [persona('sdet', { label: 'Alpha' })] }),
    );
    writeOverlay(
      'zeta',
      JSON.stringify({ personas: [persona('sdet', { label: 'Zeta' })] }),
    );
    expect(byId(merged(), 'sdet')?.label).toBe('Zeta');
  });

  it('treats an undeclared precedence as zero', () => {
    declarePrecedence({ declared: 5, undeclared: null });
    writeOverlay(
      'declared',
      JSON.stringify({ personas: [persona('sdet', { label: 'Declared' })] }),
    );
    writeOverlay(
      'undeclared',
      JSON.stringify({ personas: [persona('sdet', { label: 'Undeclared' })] }),
    );
    expect(byId(merged(), 'sdet')?.label).toBe('Declared');
  });

  it('lets the highest precedence overlay move the fallback', () => {
    declarePrecedence({ acme: 3, other: 1 });
    writeOverlay('acme', JSON.stringify({ fallback: 'sdet' }));
    writeOverlay('other', JSON.stringify({ fallback: 'manual' }));
    expect(merged().fallback).toBe('sdet');
  });

  it('ignores an overlay fallback naming no known persona', () => {
    // A fallback naming nothing is worse than no opinion: it would silently
    // demote resolution to "first persona in the list".
    writeOverlay('acme', JSON.stringify({ fallback: 'ghost' }));
    expect(merged().fallback).toBe(SHIPPED.fallback);
  });

  it('skips an overlay with no personas.json', () => {
    mkdirSync(join(home, '.canary', 'overlays', 'bare'), { recursive: true });
    expect(ids(merged())).toEqual(ids(SHIPPED));
  });

  it('skips a malformed personas.json rather than throwing', () => {
    writeOverlay('broken', '{ not json');
    writeOverlay('scalar', '"just a string"');
    writeOverlay('ok', JSON.stringify({ personas: [persona('pm')] }));
    expect(ids(merged())).toEqual([...ids(SHIPPED), 'pm']);
  });

  it('reaches resolvePersona, so an overlay can retune the default', () => {
    // The whole point of #462: an overlay overrides the audience definition
    // the same way it ships a skill. If this does not hold, the extension
    // point is decoration.
    writeOverlay(
      'acme',
      JSON.stringify({
        fallback: 'field',
        personas: [persona('field', { depth: 'guided', label: 'Field' })],
      }),
    );
    const resolved = resolvePersona({ home });
    expect(resolved.source).toBe('fallback');
    expect(resolved.persona.label).toBe('Field');
  });

  it('resolves an overlay-only persona from an explicit id', () => {
    writeOverlay(
      'acme',
      JSON.stringify({ personas: [persona('pm', { depth: 'guided' })] }),
    );
    const resolved = resolvePersona({ explicit: 'pm', home });
    expect(resolved.source).toBe('explicit');
    expect(resolved.persona.depth).toBe('guided');
  });

  it('prefers an explicit registry over anything on disk', () => {
    writeOverlay('acme', JSON.stringify({ personas: [persona('pm')] }));
    const resolved = resolvePersona({ registry: registry(), home });
    expect(resolved.persona.id).toBe('b');
  });
});
