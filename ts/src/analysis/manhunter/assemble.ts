/**
 * Dossier assembly (#611): verdict, declared exclusions, Worth your eyes, and
 * the content digest.
 *
 * The verdict grades the EVIDENCE, never the product:
 *   - `abstained`  nothing was fed (excluded-only included: nothing was read);
 *   - `incomplete` at least one section is dark and was not declared out;
 *   - `complete`   every section is fed or excluded with a reason.
 * Worth-your-eyes items never move it. They are the answer to "what should I
 * look at", and a dossier that failed on them would be judging the release.
 *
 * The digest is sha256 over the canonical JSON of the payload -- every field
 * except `generatedAt` and the digest itself. Same evidence, same digest, so
 * anyone can re-run and compare; any edit to what the dossier says changes it.
 * It is a content fingerprint, not a signature: no key, no secret.
 */

import { sha256Hex } from './sources.js';
import {
  isRecord,
  type Section,
  type SectionId,
  type SectionStatus,
} from './types.js';

const DOSSIER_SCHEMA_VERSION = 1;

export type DossierVerdict = 'complete' | 'incomplete' | 'abstained';

export interface EyeItem {
  section: SectionId;
  text: string;
}

export interface DossierPayload {
  schemaVersion: number;
  release: string;
  verdict: DossierVerdict;
  counts: Record<SectionStatus, number>;
  sections: Section[];
  worthYourEyes: EyeItem[];
}

export interface Dossier extends DossierPayload {
  generatedAt: string;
  digest: string;
}

/** Reasons keyed by section id, as declared with `--exclude id=reason`. */
export type Exclusions = Readonly<Partial<Record<SectionId, string>>>;

export interface AssembleInput {
  release: string;
  sections: Section[];
  exclusions: Exclusions;
}

function applyExclusion(section: Section, exclusions: Exclusions): Section {
  const reason = exclusions[section.id];
  if (reason === undefined) return section;
  return { ...section, status: 'excluded', reason, facts: [], eyes: [] };
}

function countStatuses(sections: Section[]): Record<SectionStatus, number> {
  const counts: Record<SectionStatus, number> = {
    fed: 0,
    dark: 0,
    excluded: 0,
  };
  for (const s of sections) counts[s.status] += 1;
  return counts;
}

function verdictOf(counts: Record<SectionStatus, number>): DossierVerdict {
  if (counts.fed === 0) return 'abstained';
  return counts.dark > 0 ? 'incomplete' : 'complete';
}

/** Dark sections first -- an unread source outranks anything a read one says. */
function worthYourEyes(sections: Section[]): EyeItem[] {
  const dark = sections
    .filter((s) => s.status === 'dark')
    .map((s) => ({ section: s.id, text: `DARK: ${s.reason ?? ''}` }));
  const raised = sections.flatMap((s) =>
    s.eyes.map((text) => ({ section: s.id, text })),
  );
  return [...dark, ...raised];
}

export function assembleDossier(input: AssembleInput): DossierPayload {
  const sections = input.sections.map((s) =>
    applyExclusion(s, input.exclusions),
  );
  const counts = countStatuses(sections);
  return {
    schemaVersion: DOSSIER_SCHEMA_VERSION,
    release: input.release,
    verdict: verdictOf(counts),
    counts,
    sections,
    worthYourEyes: worthYourEyes(sections),
  };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
  return out;
}

/** JSON with object keys sorted at every depth, so key order cannot move a hash. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function finalizeDossier(
  payload: DossierPayload,
  generatedAt: string,
): Dossier {
  return { ...payload, generatedAt, digest: sha256Hex(canonicalJson(payload)) };
}

export type VerifyResult = 'match' | 'mismatch' | 'malformed';

/** Recompute a JSON dossier's digest from its own payload. */
export function verifyDossier(text: string): VerifyResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'malformed';
  }
  if (!isRecord(parsed) || typeof parsed.digest !== 'string') {
    return 'malformed';
  }
  const { digest, generatedAt: _generatedAt, ...payload } = parsed;
  return sha256Hex(canonicalJson(payload)) === digest ? 'match' : 'mismatch';
}
