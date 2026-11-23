// Ingest reporter: a test's `features` — where they come from (a `feature`
// annotation, else the first `featureMap` glob) and how two copies of one test
// merge. One module, so the results, the JUnit catalog, catalog redaction and
// the Playwright catalog all apply the same rule (three of them used to keep
// the first copy while results took the union, so a run could say one thing in
// `results` and another in `collected`). Imports only leaf modules.
import { globToRegExp } from './globs.js';
import type { CollectedEntry } from './types.js';

/**
 * The features of a test seen twice (two reports, two projects, or two titles
 * that redact alike): the union of what either copy said. Absent on both stays
 * absent — "the suite said nothing" — and `[]` on either side survives as an
 * answer, so the distinction the dashboard relies on is never lost in a merge.
 */
export function mergedFeatures(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): { features?: string[] } {
  if (a === undefined && b === undefined) return {};
  return { features: [...new Set([...(a ?? []), ...(b ?? [])])] };
}

/** Two catalog entries for one title: tags and features both unioned. */
export function mergeCatalogEntry(
  prior: CollectedEntry,
  next: CollectedEntry,
): CollectedEntry {
  return {
    ...prior,
    tags: [...new Set([...prior.tags, ...next.tags])],
    ...mergedFeatures(prior.features, next.features),
  };
}

/**
 * A feature map as JSON: glob → slug or slugs. A bare string is one slug.
 * Anything else falls back to no map with a warning, never a thrown error, so
 * a typo cannot turn pushing off (the same stance as `parseAreaMap`).
 */
export function parseFeatureMap(
  raw: string | undefined,
  warnings: string[],
): Record<string, string[]> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const map: Record<string, string[]> = {};
      for (const [glob, v] of Object.entries(parsed)) {
        if (typeof v === 'string') map[glob] = [v];
        else if (Array.isArray(v) && v.every((x) => typeof x === 'string'))
          map[glob] = v;
        else throw new Error('bad value');
      }
      return map;
    }
  } catch {
    /* fall through to the warning below */
  }
  warnings.push(
    'the feature map must be a JSON object of glob → slug or [slugs], e.g. {"src/billing/**":["billing"]}; sending no features.',
  );
  return {};
}

/**
 * A test's feature slugs: its `feature` annotations, else the first
 * `featureMap` glob matching its repo-relative file, else `undefined` (send no
 * key). Unlike `resolveArea` a glob may map to `[]`, which is sent: "covers no
 * feature" is an answer, where an absent key is none.
 */
export function resolveFeatures(
  annotations: ReadonlyArray<{ type: string; description?: string }>,
  testFile: string,
  featureMap: Record<string, string[]>,
): string[] | undefined {
  const annotated = annotations
    .filter((a) => a.type === 'feature' && a.description)
    .map((a) => a.description as string);
  if (annotated.length) return [...new Set(annotated)];
  for (const [glob, features] of Object.entries(featureMap)) {
    if (globToRegExp(glob).test(testFile)) return [...new Set(features)];
  }
  return undefined;
}
