/**
 * One reader for the `required` set in `.github/required-checks.json` (#1122,
 * #1123).
 *
 * The manifest is PRIMARY for the required set (ADR 0011), and prose that
 * restates it — a guide listing what blocks a merge, a skill telling a fork how
 * to configure those workflows — is a copy that drifts silently unless a test
 * reads both. This kit is what such a test reads the manifest through, so the
 * doc tests and the manifest can never disagree about what "required" means.
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

/** The manifest's `required` entries, exactly as declared. */
export function requiredEntries(): RequiredEntry[] {
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, '.github', 'required-checks.json'), 'utf-8'),
  ) as { required?: RequiredEntry[] };
  return manifest.required ?? [];
}

/** Workflow files (e.g. `docs-lint.yml`) producing at least one required check. */
export function requiredWorkflows(): Set<string> {
  return new Set(requiredEntries().map((e) => e.workflow));
}
