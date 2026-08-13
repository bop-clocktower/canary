/**
 * Personas as a first-class engine concept (issue #462), and the consumer
 * wiring the detected user level never had (issue #341).
 *
 * The invariants here are deliberately opinionated, because each one pins a
 * design decision that would otherwise be re-litigated:
 *
 *   - the fallback persona is *explanatory*, never terse (the repo owner's
 *     stated default on #341 and #342: over-explaining is a mild annoyance,
 *     under-explaining silently fails a manual tester);
 *   - a persona carries no `voice` field, because voice is already its own
 *     axis with its own config surface (`voice/discovery.md`);
 *   - every value `detectUserLevel` can return is mapped, so the two
 *     vocabularies cannot drift apart again.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { detectUserLevel } from '../src/core/environment-detect.js';
import {
  DEPTHS,
  defaultPersonaRegistryPath,
  findPersona,
  loadPersonaRegistry,
  mergePersonaRegistries,
  personaIds,
  personaToDict,
  readOverlayPersonaLayers,
  resolvePersona,
  type OverlayPersonaLayer,
  type PersonaRegistry,
} from '../src/core/persona.js';

const SHIPPED = loadPersonaRegistry();

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

function registry(over: Partial<PersonaRegistry> = {}): PersonaRegistry {
  return {
    version: 1,
    fallback: 'b',
    minDetectionConfidence: 0.5,
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
  it('resolves to a real file under ts/src/data', () => {
    expect(defaultPersonaRegistryPath()).toMatch(
      /data[/\\]personas[/\\]registry\.json$/,
    );
  });

  it('defines a non-zero number of personas', () => {
    // Denominator rule: a registry that defines nothing has abstained, and
    // every resolution below it would silently return the same fallback.
    expect(SHIPPED.personas.length).toBeGreaterThan(0);
  });

  it('keeps the vocabulary the edge-case skill already published', () => {
    // agents/skills/.../canary-edge-case-discovery/SKILL.md documents
    // `--level sdet|junior|manual`. Changing those ids would be a breaking
    // change to a published skill surface, so the registry adopts them.
    expect(personaIds(SHIPPED)).toEqual(['sdet', 'junior', 'manual']);
  });

  it('names a fallback that exists', () => {
    expect(findPersona(SHIPPED, SHIPPED.fallback)).not.toBeNull();
  });

  it('falls back to an explanatory persona, never a terse one', () => {
    const fallback = findPersona(SHIPPED, SHIPPED.fallback);
    expect(fallback?.depth).not.toBe('terse');
    expect(fallback?.reasoning).toBe(true);
  });

  it('gives every persona a distinct id and a known depth', () => {
    const ids = SHIPPED.personas.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of SHIPPED.personas) {
      expect(DEPTHS).toContain(p.depth);
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.audience.length).toBeGreaterThan(0);
      expect(p.formats.length).toBeGreaterThan(0);
    }
  });

  it('carries no voice field — voice is a separate axis', () => {
    // `voice/discovery.md` already resolves a named voice profile from its own
    // project config. Collapsing the two axes would make "terse Huntress" and
    // "explanatory Huntress" inexpressible, which is the exact objection
    // raised on #462.
    for (const p of SHIPPED.personas) {
      expect(p).not.toHaveProperty('voice');
    }
  });

  it('maps every user level detectUserLevel can return', () => {
    // The two vocabularies drifted once already: prose said
    // sdet|junior|manual, code said sdet|manual|unknown. Pin the union.
    const levels = ['sdet', 'manual', 'unknown'];
    for (const level of levels) {
      const target = SHIPPED.detectionMap[level] ?? SHIPPED.fallback;
      expect(findPersona(SHIPPED, target)).not.toBeNull();
    }
  });

  it('maps an unknown level to the fallback rather than a persona', () => {
    // `unknown` is a real detector outcome, not a persona. It must not be
    // mapped to an audience, or a no-signal run would assert one.
    expect(SHIPPED.detectionMap['unknown']).toBeUndefined();
  });

  it('agrees with the live detector on a code-shaped project', () => {
    // Contract test across the #341 seam: the detector's own output must be a
    // resolvable input, not merely a string that happens to look like one.
    const [level] = detectUserLevel(process.cwd(), ['src/thing.ts']);
    const resolved = resolvePersona({
      detected: { level, confidence: 1, signals: [] },
      registry: SHIPPED,
    });
    expect(resolved.source).toBe('detected');
    expect(resolved.persona.id).toBe('sdet');
  });
});

// ---------------------------------------------------------------------------
// Registry loading
// ---------------------------------------------------------------------------

describe('loadPersonaRegistry', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'canary-persona-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws a message naming the file when it is unreadable', () => {
    const missing = join(dir, 'nope.json');
    expect(() => loadPersonaRegistry(missing)).toThrow(/nope\.json/);
  });

  it('throws when the payload is not a persona registry', () => {
    const path = join(dir, 'bad.json');
    writeFileSync(path, '[]');
    expect(() => loadPersonaRegistry(path)).toThrow(/persona registry/i);
  });

  it('throws naming the file when the JSON is malformed', () => {
    const path = join(dir, 'truncated.json');
    writeFileSync(path, '{ "personas": [');
    expect(() => loadPersonaRegistry(path)).toThrow(/is not JSON/);
  });

  it('treats an absent fallback as no opinion, not an empty id', () => {
    const path = join(dir, 'no-fallback.json');
    writeFileSync(path, JSON.stringify({ personas: [persona('only')] }));
    const loaded = loadPersonaRegistry(path);
    expect(loaded.fallback).toBe('');
    // With no named fallback the first persona applies, rather than throwing
    // on a registry that is otherwise perfectly usable.
    expect(resolvePersona({ registry: loaded }).persona.id).toBe('only');
  });

  it('drops malformed persona entries rather than trusting them', () => {
    const path = join(dir, 'partial.json');
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        fallback: 'ok',
        personas: [
          persona('ok'),
          { id: 'no-label' },
          persona('bad-depth', { depth: 'shouty' }),
          'not-an-object',
        ],
      }),
    );
    expect(personaIds(loadPersonaRegistry(path))).toEqual(['ok']);
  });

  it('defaults the confidence floor and detection map when absent', () => {
    const path = join(dir, 'minimal.json');
    writeFileSync(
      path,
      JSON.stringify({ fallback: 'ok', personas: [persona('ok')] }),
    );
    const loaded = loadPersonaRegistry(path);
    expect(loaded.minDetectionConfidence).toBeGreaterThan(0);
    expect(loaded.detectionMap).toEqual({});
    expect(loaded.version).toBe(1);
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
      detected: { level: 'sdet', confidence: 0.25, signals: ['s1'] },
      registry: registry(),
    });
    expect(resolved.persona.id).toBe('b');
    expect(resolved.source).toBe('fallback');
    // The floor must be named, or a surprised user has nothing to tune.
    expect(resolved.reason).toMatch(/0\.5/);
    // Signals survive: the fallback still owes the user its evidence.
    expect(resolved.signals).toEqual(['s1']);
  });

  it('treats the floor as inclusive', () => {
    const resolved = resolvePersona({
      detected: { level: 'sdet', confidence: 0.5, signals: [] },
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

  it('falls back with no input at all', () => {
    const resolved = resolvePersona({ registry: registry() });
    expect(resolved.persona.id).toBe('b');
    expect(resolved.source).toBe('fallback');
    expect(resolved.signals).toEqual([]);
  });

  it('defaults to the shipped registry', () => {
    expect(resolvePersona().persona.id).toBe(SHIPPED.fallback);
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
      detected: { level: 'sdet', confidence: 1, signals: [] },
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
// The JSON view consumers actually read
// ---------------------------------------------------------------------------

describe('personaToDict', () => {
  it('emits the resolution provenance beside the definition', () => {
    const dict = personaToDict(
      resolvePersona({
        detected: { level: 'manual', confidence: 0.9, signals: ['s'] },
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
      signals: ['s'],
    });
  });

  it('copies its arrays so a consumer cannot mutate the registry', () => {
    const reg = registry();
    const dict = personaToDict(
      resolvePersona({ explicit: 'a', registry: reg }),
    );
    (dict['formats'] as string[]).push('mutated');
    expect(findPersona(reg, 'a')?.formats).toEqual(['bullets']);
  });
});

// ---------------------------------------------------------------------------
// Overlay extension, via the precedence contract that already exists (#333)
// ---------------------------------------------------------------------------

describe('mergePersonaRegistries', () => {
  const layer = (
    overlay: string,
    precedence: number,
    over: Partial<OverlayPersonaLayer> = {},
  ): OverlayPersonaLayer => ({
    overlay,
    precedence,
    personas: [],
    fallback: null,
    ...over,
  });

  it('returns the base unchanged when no overlay contributes', () => {
    expect(mergePersonaRegistries(registry(), [])).toEqual(registry());
  });

  it('adds a persona an overlay defines', () => {
    const merged = mergePersonaRegistries(registry(), [
      layer('acme', 0, {
        personas: [persona('pm')] as PersonaRegistry['personas'],
      }),
    ]);
    expect(personaIds(merged)).toEqual(['a', 'b', 'pm']);
  });

  it('lets a higher precedence overlay override a base persona', () => {
    const merged = mergePersonaRegistries(registry(), [
      layer('low', 1, {
        personas: [
          persona('a', { label: 'Low' }),
        ] as PersonaRegistry['personas'],
      }),
      layer('high', 9, {
        personas: [
          persona('a', { label: 'High' }),
        ] as PersonaRegistry['personas'],
      }),
    ]);
    expect(findPersona(merged, 'a')?.label).toBe('High');
    // Overriding must not reorder the base vocabulary.
    expect(personaIds(merged)).toEqual(['a', 'b']);
  });

  it('breaks a precedence tie by overlay name, lowest first', () => {
    const merged = mergePersonaRegistries(registry(), [
      layer('zeta', 0, {
        personas: [
          persona('a', { label: 'Zeta' }),
        ] as PersonaRegistry['personas'],
      }),
      layer('alpha', 0, {
        personas: [
          persona('a', { label: 'Alpha' }),
        ] as PersonaRegistry['personas'],
      }),
    ]);
    // Ascending (precedence, name) with last-writer-wins mirrors
    // skill-registry.ts, so both surfaces agree on the winner.
    expect(findPersona(merged, 'a')?.label).toBe('Zeta');
  });

  it('lets the highest precedence overlay move the fallback', () => {
    const merged = mergePersonaRegistries(registry(), [
      layer('acme', 3, { fallback: 'a' }),
      layer('other', 1, { fallback: 'b' }),
    ]);
    expect(merged.fallback).toBe('a');
  });

  it('ignores an overlay fallback naming no known persona', () => {
    const merged = mergePersonaRegistries(registry(), [
      layer('acme', 3, { fallback: 'ghost' }),
    ]);
    expect(merged.fallback).toBe('b');
  });
});

describe('readOverlayPersonaLayers', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'canary-persona-home-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function writeOverlay(name: string, body: string): void {
    const dir = join(home, '.canary', 'overlays', name, '.canary');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'personas.json'), body);
  }

  it('returns nothing when no overlays are installed', () => {
    expect(readOverlayPersonaLayers(home)).toEqual([]);
  });

  it('reads a personas.json and its declared precedence', () => {
    mkdirSync(join(home, '.canary'), { recursive: true });
    writeFileSync(
      join(home, '.canary', 'overlays.json'),
      JSON.stringify({ overlays: [{ name: 'acme', precedence: 7 }] }),
    );
    writeOverlay('acme', JSON.stringify({ personas: [persona('pm')] }));
    expect(readOverlayPersonaLayers(home)).toEqual([
      {
        overlay: 'acme',
        precedence: 7,
        personas: [persona('pm')],
        fallback: null,
      },
    ]);
  });

  it('treats an undeclared precedence as zero', () => {
    writeOverlay('acme', JSON.stringify({ personas: [persona('pm')] }));
    expect(readOverlayPersonaLayers(home)[0]?.precedence).toBe(0);
  });

  it('skips an overlay with no personas.json', () => {
    mkdirSync(join(home, '.canary', 'overlays', 'bare'), { recursive: true });
    expect(readOverlayPersonaLayers(home)).toEqual([]);
  });

  it('skips a malformed personas.json rather than throwing', () => {
    writeOverlay('broken', '{ not json');
    writeOverlay('ok', JSON.stringify({ personas: [persona('pm')] }));
    expect(readOverlayPersonaLayers(home).map((l) => l.overlay)).toEqual([
      'ok',
    ]);
  });

  it('carries an overlay fallback through', () => {
    writeOverlay(
      'acme',
      JSON.stringify({ fallback: 'pm', personas: [persona('pm')] }),
    );
    expect(readOverlayPersonaLayers(home)[0]?.fallback).toBe('pm');
  });
});
