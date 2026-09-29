/**
 * The release dossier's section model (#611, canary-manhunter).
 *
 * A section is one evidence source. It has exactly three states, and the
 * difference between two of them is the reason this module exists:
 *
 *   - `fed`      the source was read AND had a non-zero denominator;
 *   - `dark`     it was missing, unreadable, malformed, self-abstained, or
 *                measured nothing -- the section says which, never reads clean;
 *   - `excluded` a person declared it out of scope, with a reason.
 *
 * A dark section and a clean one must never render alike: "no findings from a
 * source that was never read" is the false green a release dossier exists to
 * prevent.
 */

/** Section ids, in the order the dossier renders them. */
export const SECTION_IDS = [
  'run-history',
  'coverage-tiers',
  'guardian-findings',
  'ci-readiness',
  'quarantine',
  'sweep',
  'escapes',
] as const;

export type SectionId = (typeof SECTION_IDS)[number];

export const SECTION_TITLES: Record<SectionId, string> = {
  'run-history': 'Run history',
  'coverage-tiers': 'Coverage tiers',
  'guardian-findings': 'Guardian findings',
  'ci-readiness': 'CI readiness',
  quarantine: 'Quarantined and deleted tests',
  sweep: 'Accessibility sweep',
  escapes: 'Escape history',
};

export type SectionStatus = 'fed' | 'dark' | 'excluded';

/** A file the section read (or tried to): `sha256` is null when not read. */
export interface SourceRef {
  path: string;
  sha256: string | null;
}

export interface Section {
  id: SectionId;
  title: string;
  status: SectionStatus;
  /** Why the section is dark or excluded; null when fed. */
  reason: string | null;
  sources: SourceRef[];
  /** What the section measured over, e.g. "42 runs across 3 suites". */
  denominator: string | null;
  facts: string[];
  /** Items a human should look at; capped, see {@link EYES_CAP}. */
  eyes: string[];
}

/** Per-section cap on Worth-your-eyes items, so the short list stays short. */
const EYES_CAP = 10;

function capEyes(eyes: string[]): string[] {
  if (eyes.length <= EYES_CAP) return eyes;
  return [...eyes.slice(0, EYES_CAP), `and ${eyes.length - EYES_CAP} more`];
}

/** A section that could not be fed, and why. */
export function darkSection(
  id: SectionId,
  sources: SourceRef[],
  reason: string,
): Section {
  return {
    id,
    title: SECTION_TITLES[id],
    status: 'dark',
    reason,
    sources,
    denominator: null,
    facts: [],
    eyes: [],
  };
}

export interface FedBody {
  sources: SourceRef[];
  denominator: string;
  facts: string[];
  eyes: string[];
}

/** A section whose source was read and measured something. */
export function fedSection(id: SectionId, body: FedBody): Section {
  return {
    id,
    title: SECTION_TITLES[id],
    status: 'fed',
    reason: null,
    sources: body.sources,
    denominator: body.denominator,
    facts: body.facts,
    eyes: capEyes(body.eyes),
  };
}

/** True for a plain JSON object (not null, not an array). */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
