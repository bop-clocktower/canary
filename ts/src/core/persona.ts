/**
 * Personas as a first-class engine concept (issue #462).
 *
 * Audience adaptation used to be hand-rolled per skill: each one restated some
 * variant of "if tester, use simpler words" in its own prose, with its own
 * vocabulary and its own inference rules. Nothing shared a definition, so tone
 * drifted between skills and an overlay had nothing to override. The drift was
 * measurable — `canary-edge-case-discovery` documented
 * `--level sdet|junior|manual` while {@link
 * import('./environment-detect.js').detectUserLevel} returned
 * `sdet|manual|unknown`, and no code read either.
 *
 * This module replaces that with one definition skills **consult**:
 *
 *   - a **registry** (`ts/src/data/personas/registry.json`) naming each
 *     audience, how much explanation it wants, which output formats suit it,
 *     and whether choices should be annotated with their reasoning;
 *   - a pure **resolver** that picks one from an explicit choice, a detected
 *     signal, or a fallback, and reports **which** and **why**;
 *   - **overlay extension** through the same `precedence` arbitration the
 *     overlay contract already defines for skill-name collisions (#333).
 *
 * Three deliberate boundaries, each of which was a decision rather than an
 * omission:
 *
 * **Voice is not a persona field.** `voice/discovery.md` already resolves a
 * named voice profile from its own project config, scoped by its own globs.
 * Audience depth and character voice are orthogonal axes — a senior SDET may
 * want a voiced-but-terse report while a manual tester wants the same voice
 * with more explanation — so collapsing them into one field would make half
 * the combinations inexpressible.
 *
 * **The fallback is explanatory, not degraded.** Most users will never
 * configure this, so the no-signal answer has to be a good answer. Erring
 * explanatory is the repo owner's stated default on #341 and #342: over-
 * explaining is a mild annoyance, under-explaining silently fails a manual
 * tester. It is *not* the maximum-explanation persona either, which would
 * assert an audience nobody claimed.
 *
 * **Nothing here reads the environment.** Like `environment-detect.ts`, every
 * input arrives as an argument, so the resolver is deterministic and the
 * decision of where a signal comes from stays with the caller.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { uncertainDetectionMessage } from './detection.js';
import { listOverlays, registryPrecedence, overlaysRoot } from './overlays.js';

/** How much explanation a persona wants around the same finding. */
export const DEPTHS = ['terse', 'brief', 'guided'] as const;

export type ExplanationDepth = (typeof DEPTHS)[number];

/**
 * Confidence floor applied when a registry declares none.
 *
 * Note what the detector's confidence actually is: `|sdet - manual| / total`,
 * a *margin* between two tallies, not a probability. One open `.ts` file with
 * no opposing signal scores 1.0. So this floor screens out genuine ties and
 * near-ties; it is not a calibrated certainty threshold.
 */
export const DEFAULT_MIN_DETECTION_CONFIDENCE = 0.5;

/** One audience, and what consulting it should change about the output. */
export interface PersonaDefinition {
  /** Stable id used by config, flags, and `detectionMap` targets. */
  id: string;
  /** Short human name, for surfacing which persona was applied. */
  label: string;
  /** Who this is, in one sentence — the thing a skill is adapting to. */
  audience: string;
  /** How much explanation to carry around each finding. */
  depth: ExplanationDepth;
  /** Output shapes that suit this audience, most preferred first. */
  formats: string[];
  /** Whether to annotate choices with why they were made (issue #342). */
  reasoning: boolean;
}

/** The full set of personas plus the policy for choosing between them. */
export interface PersonaRegistry {
  version: number;
  /** Id used when nothing explicit or detected applies. */
  fallback: string;
  /** Minimum detector confidence before a detected level is honored. */
  minDetectionConfidence: number;
  /** Detected user level -> persona id. Unmapped levels use the fallback. */
  detectionMap: Record<string, string>;
  personas: PersonaDefinition[];
}

/** Where a resolved persona came from — always reported, never inferred. */
export type PersonaSource = 'explicit' | 'detected' | 'fallback';

/** A user-level reading from `detectUserLevel`, as the resolver wants it. */
export interface DetectedUserLevel {
  /** `"sdet"` / `"manual"` / `"unknown"`, or an overlay-defined level. */
  level: string;
  /** The detector's margin metric in `[0, 1]`. */
  confidence: number;
  /** The detector's own reasons, carried through for auditability. */
  signals?: readonly string[];
}

/** Inputs to {@link resolvePersona}; every one is optional. */
export interface ResolvePersonaInput {
  /** An id the user chose outright — config, flag, or overlay setting. */
  explicit?: string | null;
  detected?: DetectedUserLevel | null;
  registry?: PersonaRegistry;
}

/** A persona plus the provenance that makes the choice auditable. */
export interface ResolvedPersona {
  persona: PersonaDefinition;
  source: PersonaSource;
  /** Why this persona, in one line a user can act on. */
  reason: string;
  /** The detector signals behind the choice, if any. */
  signals: string[];
}

/** One overlay's contribution to the registry, with its arbitration weight. */
export interface OverlayPersonaLayer {
  overlay: string;
  /** Declared `precedence` from `overlays.json`; undeclared is 0 (#333). */
  precedence: number;
  personas: PersonaDefinition[];
  /** A fallback this overlay would rather use, or null to inherit. */
  fallback: string | null;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isDepth(v: unknown): v is ExplanationDepth {
  return DEPTHS.includes(v as ExplanationDepth);
}

function stringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v.every((x) => typeof x === 'string') ? [...(v as string[])] : null;
}

/**
 * Validate one raw persona entry, or return null.
 *
 * Dropping a malformed entry rather than throwing is deliberate for the
 * *overlay* path: one bad downstream file must not take the engine's own
 * personas down with it. The count is observable through {@link personaIds},
 * so a dropped entry shows up as a missing id rather than as silence.
 */
function parsePersona(raw: unknown): PersonaDefinition | null {
  if (!isRecord(raw)) return null;
  const { id, label, audience, depth, reasoning } = raw;
  const formats = stringArray(raw['formats']);
  if (typeof id !== 'string' || id.trim() === '') return null;
  if (typeof label !== 'string' || typeof audience !== 'string') return null;
  if (!isDepth(depth) || formats === null) return null;
  if (typeof reasoning !== 'boolean') return null;
  return { id: id.trim(), label, audience, depth, formats, reasoning };
}

function parsePersonas(raw: unknown): PersonaDefinition[] {
  if (!Array.isArray(raw)) return [];
  const out: PersonaDefinition[] = [];
  for (const entry of raw) {
    const parsed = parsePersona(entry);
    if (parsed) out.push(parsed);
  }
  return out;
}

function parseDetectionMap(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) return {};
  const out: Record<string, string> = {};
  for (const [level, target] of Object.entries(raw)) {
    if (typeof target === 'string') out[level] = target;
  }
  return out;
}

/** Default registry path: `<module dir>/../data/personas/registry.json`. */
export function defaultPersonaRegistryPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // here = <core> -> sibling data/ dir (src/data under vitest, dist/data once
  // built and copied by ts/scripts/copy-data.mjs).
  return resolve(here, '..', 'data', 'personas', 'registry.json');
}

/**
 * Read and validate a persona registry.
 *
 * Throws — rather than degrading to an empty registry — because the engine's
 * own registry going missing is a build/packaging fault, and a silently empty
 * one would make every resolution return the same fallback while reporting
 * nothing. Overlay registries take the forgiving path instead; see
 * {@link readOverlayPersonaLayers}.
 */
export function loadPersonaRegistry(
  registryPath: string = defaultPersonaRegistryPath(),
): PersonaRegistry {
  let text: string;
  try {
    text = readFileSync(registryPath, 'utf-8');
  } catch (err) {
    // `String(err)` rather than `err.message`: both throwers here raise real
    // Errors, so an `instanceof` guard would only add an unreachable branch.
    throw new Error(
      `could not read persona registry ${registryPath}: ${String(err)}`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `persona registry ${registryPath} is not JSON: ${String(err)}`,
    );
  }
  if (!isRecord(raw)) {
    throw new Error(
      `persona registry ${registryPath} must be a JSON object, not an array` +
        ' or scalar',
    );
  }
  const version = typeof raw['version'] === 'number' ? raw['version'] : 1;
  const fallback = typeof raw['fallback'] === 'string' ? raw['fallback'] : '';
  const floor = raw['minDetectionConfidence'];
  return {
    version,
    fallback,
    minDetectionConfidence:
      typeof floor === 'number' ? floor : DEFAULT_MIN_DETECTION_CONFIDENCE,
    detectionMap: parseDetectionMap(raw['detectionMap']),
    personas: parsePersonas(raw['personas']),
  };
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/** Ids in registry order — the discoverable persona vocabulary. */
export function personaIds(registry: PersonaRegistry): string[] {
  return registry.personas.map((p) => p.id);
}

/** The persona with this id (case-insensitive), or null. */
export function findPersona(
  registry: PersonaRegistry,
  id: string | null | undefined,
): PersonaDefinition | null {
  if (typeof id !== 'string') return null;
  const want = id.trim().toLowerCase();
  if (want === '') return null;
  return registry.personas.find((p) => p.id.toLowerCase() === want) ?? null;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function fallbackPersona(registry: PersonaRegistry): PersonaDefinition {
  const named = findPersona(registry, registry.fallback);
  if (named) return named;
  const first = registry.personas[0];
  if (first) return first;
  // Never invent one. An empty registry is the denominator-zero case: the
  // caller asked for an audience and there is no vocabulary to answer from.
  throw new Error(
    'persona registry defines no personas, so no persona can be resolved',
  );
}

/**
 * Choose a persona and say where the choice came from.
 *
 * Precedence, highest first: an explicit id, then a detected level whose
 * confidence clears the registry floor, then the fallback. An explicit id that
 * names nothing does **not** suppress the rest of the cascade — a typo is a
 * mistake, not an instruction to ignore the signal — but it is always named in
 * the reason, so the mistake surfaces instead of being swallowed.
 */
export function resolvePersona(
  input: ResolvePersonaInput = {},
): ResolvedPersona {
  const registry = input.registry ?? loadPersonaRegistry();
  const signals = [...(input.detected?.signals ?? [])];
  const notes: string[] = [];

  const explicit = input.explicit;
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    const chosen = findPersona(registry, explicit);
    if (chosen) {
      return {
        persona: chosen,
        source: 'explicit',
        reason: `explicit persona '${chosen.id}'`,
        signals,
      };
    }
    notes.push(
      uncertainDetectionMessage('persona', {
        reason: `'${explicit.trim()}' is not a known persona`,
        candidates: personaIds(registry),
      }),
    );
  }

  const detected = input.detected;
  if (detected) {
    const floor = registry.minDetectionConfidence;
    const target = registry.detectionMap[detected.level];
    const mapped = findPersona(registry, target);
    if (!mapped) {
      notes.push(
        `detected user level '${detected.level}' maps to no persona, so the` +
          ' fallback applies',
      );
    } else if (detected.confidence < floor) {
      notes.push(
        `detected '${detected.level}' at confidence ` +
          `${detected.confidence} is below the ${floor} floor, so the` +
          ' fallback applies',
      );
    } else {
      notes.push(
        `detected user level '${detected.level}' at confidence ` +
          `${detected.confidence}`,
      );
      return {
        persona: mapped,
        source: 'detected',
        reason: notes.join('; '),
        signals,
      };
    }
  }

  const persona = fallbackPersona(registry);
  notes.push(`fell back to '${persona.id}'`);
  return { persona, source: 'fallback', reason: notes.join('; '), signals };
}

/**
 * A JSON-serialisable view for embedding in an MCP response.
 *
 * Flat rather than nested, and it carries `source`, `reason`, and `signals`
 * beside the definition: a consumer that adapts its output owes the user an
 * answer to "why did you decide I was that?".
 */
export function personaToDict(
  resolved: ResolvedPersona,
): Record<string, unknown> {
  const { persona, source, reason, signals } = resolved;
  return {
    id: persona.id,
    label: persona.label,
    audience: persona.audience,
    depth: persona.depth,
    formats: [...persona.formats],
    reasoning: persona.reasoning,
    source,
    reason,
    signals: [...signals],
  };
}

// ---------------------------------------------------------------------------
// Overlay extension (#333 precedence)
// ---------------------------------------------------------------------------

/**
 * Read each installed overlay's `.canary/personas.json`.
 *
 * Forgiving by design: a missing file means the overlay simply has no opinion,
 * and an unreadable or malformed one is skipped rather than fatal, because a
 * downstream overlay must not be able to break the engine's own vocabulary.
 */
export function readOverlayPersonaLayers(home?: string): OverlayPersonaLayer[] {
  const root = overlaysRoot(home);
  const precedence = registryPrecedence(home);
  const layers: OverlayPersonaLayer[] = [];
  for (const overlay of listOverlays(home)) {
    const path = join(root, overlay, '.canary', 'personas.json');
    if (!existsSync(path)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      continue;
    }
    if (!isRecord(raw)) continue;
    const fallback = raw['fallback'];
    layers.push({
      overlay,
      precedence: precedence[overlay] ?? 0,
      personas: parsePersonas(raw['personas']),
      fallback: typeof fallback === 'string' ? fallback : null,
    });
  }
  return layers;
}

/**
 * Fold overlay layers onto the base registry.
 *
 * Layers are applied in ascending `(precedence, overlay-name)` order and the
 * last writer wins — byte-for-byte the rule `skill-registry.ts` uses for
 * skill-name collisions, so a downstream operator who has already reasoned
 * about which overlay wins a skill does not have to learn a second model for
 * personas. An id already in the base is replaced **in place**, so extending
 * the vocabulary never reorders it.
 */
export function mergePersonaRegistries(
  base: PersonaRegistry,
  layers: readonly OverlayPersonaLayer[],
): PersonaRegistry {
  const ordered = [...layers].sort(
    (a, b) => a.precedence - b.precedence || a.overlay.localeCompare(b.overlay),
  );
  const personas = [...base.personas];
  let fallback = base.fallback;
  for (const layer of ordered) {
    for (const persona of layer.personas) {
      const at = personas.findIndex(
        (p) => p.id.toLowerCase() === persona.id.toLowerCase(),
      );
      if (at >= 0) personas[at] = persona;
      else personas.push(persona);
    }
    if (layer.fallback !== null) fallback = layer.fallback;
  }
  const merged: PersonaRegistry = { ...base, personas, fallback };
  // A fallback naming nothing is worse than no opinion: it would silently
  // demote resolution to "first persona in the list".
  if (!findPersona(merged, merged.fallback)) merged.fallback = base.fallback;
  return merged;
}
