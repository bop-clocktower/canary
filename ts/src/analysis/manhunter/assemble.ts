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
 * It is a content fingerprint, not a signature: no key, no secret. It detects
 * an edit made without recomputing it; anyone can recompute it, so it is not
 * proof of who produced the dossier. Source paths are stored relative to the
 * root (see {@link relativizeSection}) so the same evidence gives the same
 * digest in any checkout.
 */

import { relative, sep } from 'node:path';

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

/**
 * Fed sections a caller tried to exclude. An exclusion declares a source OUT of
 * scope; applied to a source that was read, it would hide what that source
 * found. The CLI refuses these as a usage error.
 */
export function excludedButFed(
  sections: Section[],
  exclusions: Exclusions,
): SectionId[] {
  return sections
    .filter((s) => s.status === 'fed' && exclusions[s.id] !== undefined)
    .map((s) => s.id);
}

/** Only a dark section can be excluded; a fed one is never hidden. */
function applyExclusion(section: Section, exclusions: Exclusions): Section {
  const reason = exclusions[section.id];
  if (reason === undefined || section.status === 'fed') return section;
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

/**
 * Rewrite a section's paths relative to `root`, in its sources and in every
 * reason, fact and eye line, so the payload (and the digest) does not depend
 * on where the repository is checked out, and no home directory leaks into it.
 */
export function relativizeSection(section: Section, root: string): Section {
  const prefix = root.endsWith(sep) ? root : root + sep;
  const strip = (text: string) => text.split(prefix).join('');
  const toPosix = (p: string) => relative(root, p).split(sep).join('/');
  return {
    ...section,
    reason: section.reason === null ? null : strip(section.reason),
    sources: section.sources.map((ref) => ({
      ...ref,
      path: toPosix(ref.path),
    })),
    facts: section.facts.map(strip),
    eyes: section.eyes.map(strip),
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

/** Whether the stored counts and verdict follow from the stored sections. */
function selfConsistent(payload: Record<string, unknown>): boolean {
  if (!Array.isArray(payload.sections)) return false;
  const sections = payload.sections.filter(isRecord) as unknown as Section[];
  if (sections.length !== payload.sections.length) return false;
  const counts = countStatuses(sections);
  return (
    canonicalJson(counts) === canonicalJson(payload.counts) &&
    verdictOf(counts) === payload.verdict
  );
}

/**
 * Recompute a JSON dossier's digest from its own payload. A file that is not
 * a v1 dossier is `malformed`; one whose digest matches but whose verdict does
 * not follow from its sections is a `mismatch` -- recomputing the hash after
 * flipping the verdict is exactly the edit this must still catch.
 */
export function verifyDossier(text: string): VerifyResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'malformed';
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.digest !== 'string' ||
    parsed.schemaVersion !== DOSSIER_SCHEMA_VERSION
  ) {
    return 'malformed';
  }
  const { digest, generatedAt: _generatedAt, ...payload } = parsed;
  if (sha256Hex(canonicalJson(payload)) !== digest) return 'mismatch';
  return selfConsistent(payload) ? 'match' : 'mismatch';
}
