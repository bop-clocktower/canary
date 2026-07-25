/**
 * Emit the machine-readable api-delta.json v1 artifact.
 *
 * Faithful TypeScript port of `agent/guardian/delta_emitter.py`. Serializes an
 * `ApiDiff` into the frozen contract (docs/specs/api-delta-contract.md) that
 * downstream tooling consumes to trigger library-stub regeneration. Generic and
 * company-neutral — the shape carries only HTTP method/path/change categories.
 *
 * The builder is pure (the caller supplies `generated`) so it stays testable.
 */

import { writeFileSync } from 'node:fs';

import { ApiDiff, classifyChanges } from './diff-extractor.js';

/** The api-delta.json v1 contract shape. */
export interface ApiDelta {
  schema_version: number;
  sut: { sha: string; suite: string };
  generated: string;
  summary: { added: number; removed: number; changed: number; total: number };
  endpoints: {
    added: Array<{ method: string; path: string }>;
    removed: Array<{ method: string; path: string }>;
    changed: Array<{ method: string; path: string; changes: string[] }>;
  };
}

/** Python: `build_api_delta`. Build the api-delta.json v1 object from a diff. */
export function buildApiDelta(
  diff: ApiDiff,
  sha: string,
  suite: string,
  generated: string,
): ApiDelta {
  return {
    schema_version: 1,
    sut: { sha, suite },
    generated,
    summary: {
      added: diff.added.length,
      removed: diff.removed.length,
      changed: diff.changed.length,
      total: diff.added.length + diff.removed.length + diff.changed.length,
    },
    endpoints: {
      added: diff.added.map((ec) => ({
        method: ec.method.toUpperCase(),
        path: ec.path,
      })),
      removed: diff.removed.map((ec) => ({
        method: ec.method.toUpperCase(),
        path: ec.path,
      })),
      changed: diff.changed.map((ec) => ({
        method: ec.method.toUpperCase(),
        path: ec.path,
        changes: classifyChanges(ec.before, ec.after),
      })),
    },
  };
}

/** Python: `write_api_delta`. Write the delta to `path` as indented JSON. */
export function writeApiDelta(delta: ApiDelta, path: string): void {
  writeFileSync(path, `${JSON.stringify(delta, null, 2)}\n`, 'utf-8');
}
