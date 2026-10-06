/**
 * The one reader for `.github/required-checks.json` (#1122, #1123, #1144).
 *
 * The manifest is PRIMARY for the required set (ADR 0011), and prose that
 * restates it — a guide listing what blocks a merge, a skill telling a fork how
 * to configure those workflows — is a copy that drifts silently unless a test
 * reads both. This kit is what such a test reads the manifest through, so the
 * doc tests and the manifest can never disagree about what "required" means.
 *
 * Two rules, both from #1144:
 *
 * - `required` and `advisory` are read by NAME, never by flattening every
 *   top-level array. A flatten-everything reader once counted the 9 advisory
 *   rows as required.
 * - A missing, non-array, or empty `required` section THROWS. Returning `[]`
 *   would let every caller compare its doc against an empty set and pass — a
 *   zero denominator that reads as green. It fails here, once, for everyone.
 *
 * `required-checks-testkit.test.ts` enforces that no other test opens the file.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

type RequiredEntry = { check: string; workflow: string };
type AdvisoryEntry = RequiredEntry & { reason: string };

/**
 * The parsed manifest. Callers that need a section other than `required` or
 * `advisory` (externalStatuses, rulesetRules, reviews, mergePolicy) name its
 * shape as `T`; the file is still read in exactly one place.
 */
export function readRequiredChecksManifest<
  T extends object = Record<string, unknown>,
>(): T {
  return JSON.parse(
    readFileSync(join(REPO_ROOT, '.github', 'required-checks.json'), 'utf-8'),
  ) as T;
}

/** The rows of one named section, each carrying a non-empty `check`. */
function section(manifest: unknown, key: string): Record<string, unknown>[] {
  const rows = (manifest as Record<string, unknown> | null)?.[key];
  if (!Array.isArray(rows)) {
    throw new Error(
      `.github/required-checks.json: the \`${key}\` section is missing or not an array`,
    );
  }
  for (const row of rows as Record<string, unknown>[]) {
    if (typeof row?.check !== 'string' || row.check.length === 0) {
      throw new Error(
        `.github/required-checks.json: a \`${key}\` section row has no check name`,
      );
    }
  }
  return rows as Record<string, unknown>[];
}

/** The manifest's `required` entries, exactly as declared. Never empty. */
export function requiredEntries(
  manifest: unknown = readRequiredChecksManifest(),
): RequiredEntry[] {
  const rows = section(manifest, 'required');
  if (rows.length === 0) {
    throw new Error(
      '.github/required-checks.json: the `required` section is empty — a zero denominator is an abstention, not a pass',
    );
  }
  return rows as RequiredEntry[];
}

/**
 * The manifest's `advisory` entries. May be empty — every check promoted is a
 * legitimate state — but the section itself must exist.
 */
export function advisoryEntries(
  manifest: unknown = readRequiredChecksManifest(),
): AdvisoryEntry[] {
  return section(manifest, 'advisory') as AdvisoryEntry[];
}

/** The check names the manifest marks as required — never advisory ones. */
export function requiredCheckNames(
  manifest: unknown = readRequiredChecksManifest(),
): Set<string> {
  return new Set(requiredEntries(manifest).map((e) => e.check));
}

/** Workflow files (e.g. `docs-lint.yml`) producing at least one required check. */
export function requiredWorkflows(): Set<string> {
  return new Set(requiredEntries().map((e) => e.workflow));
}
