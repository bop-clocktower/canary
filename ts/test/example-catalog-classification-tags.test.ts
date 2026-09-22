/**
 * Every classification tag quoted in the `examples/` catalog must be a value
 * `ts/src/core/classifier.ts` can actually emit.
 *
 * Issue #1049. The catalog READMEs tell a reader what Canary "will classify
 * this request as", and four shipped examples named `python_unit` /
 * `backend_unit` while a fifth named `unit` — three labels the classifier has
 * never produced. Nothing checked them, so they read as authoritative for as
 * long as they survived. Documentation that states a machine-checkable fact
 * and is never machine-checked drifts by default.
 *
 * The emittable set is DERIVED from the classifier source rather than
 * hard-coded here, so a tag added to the classifier is legal in the catalog
 * the moment it lands, and a tag removed from the classifier immediately
 * invalidates any README still quoting it. Hard-coding the list would turn
 * this test into a second thing to keep in sync — the exact failure it exists
 * to prevent.
 *
 * Deliberately NOT asserted: that classifying the example's own `prompt.txt`
 * returns the documented tag. That is a stronger claim about classifier
 * behaviour, and it currently fails for `vitest-unit-validation`, whose prompt
 * says "No snapshot testing" and trips the `visual` keyword rule on the
 * negated phrase. That is a classifier bug, tracked separately; widening this
 * test to cover it would conflate "the label is a real label" with "the label
 * is the right label".
 *
 * Offline: reads files only. Never executes, never reaches the network.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reportAbstention, reportVerified } from './abstention-testkit.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLASSIFIER = join(REPO_ROOT, 'ts', 'src', 'core', 'classifier.ts');
const EXAMPLES = join(REPO_ROOT, 'examples');

/** Source text between a `const <name>...= [` header and its closing `];`. */
function tableBody(source: string, name: string): string {
  const start = source.indexOf(`const ${name}`);
  if (start === -1) return '';
  const open = source.indexOf('= [', start);
  if (open === -1) return '';
  const close = source.indexOf('\n];', open);
  return close === -1 ? '' : source.slice(open, close);
}

function matchAll(body: string, re: RegExp): string[] {
  return [...body.matchAll(re)].map((m) => m[1]!);
}

/**
 * Every `test_type` the classifier can return, read out of its own tables:
 * framework hints (`['vitest', 'frontend_unit']`), category keywords
 * (`['accessibility', [...]]`), the trailing keyword rules, and the bare
 * `result('e2e_ui', …)` literals for the unconditional paths.
 */
function emittableTestTypes(): Set<string> {
  const source = readFileSync(CLASSIFIER, 'utf8');

  const hints = matchAll(
    tableBody(source, 'FRAMEWORK_HINTS'),
    /\[\s*'[^']+',\s*'([a-z0-9_]+)'\s*\]/g,
  );
  const categories = matchAll(
    tableBody(source, 'CATEGORY_KEYWORDS'),
    /\[\s*'([a-z0-9_]+)',\s*\[/g,
  );
  const trailing = matchAll(
    tableBody(source, 'TRAILING_RULES'),
    /\]\s*,\s*'([a-z0-9_]+)'\s*,\s*[\d.]+\s*\]/g,
  );
  const literals = matchAll(source, /\bresult\(\s*'([a-z0-9_]+)'/g);

  // Each table is asserted non-empty at its own site below; a silent parse
  // break must not quietly shrink the legal set.
  for (const [name, found] of [
    ['FRAMEWORK_HINTS', hints],
    ['CATEGORY_KEYWORDS', categories],
    ['TRAILING_RULES', trailing],
    ['result() literals', literals],
  ] as const) {
    expect(found.length, `no test_type parsed out of ${name}`).toBeGreaterThan(
      0,
    );
  }

  return new Set([...hints, ...categories, ...trailing, ...literals]);
}

/** "Classify the request as `api`", "Canary classifies as `performance`". */
const TAG_RE = /classif[a-z]*\b[^\n`]*?as `([a-z0-9_]+)`/gi;

interface CatalogTag {
  file: string;
  tag: string;
}

function readmesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...readmesUnder(full));
    else if (entry === 'README.md') out.push(full);
  }
  return out;
}

function catalogTags(): CatalogTag[] {
  const out: CatalogTag[] = [];
  for (const file of readmesUnder(EXAMPLES)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(TAG_RE)) {
      out.push({ file: relative(REPO_ROOT, file), tag: m[1]! });
    }
  }
  return out;
}

describe('examples/ classification tags', () => {
  it('quotes only test_types the classifier can emit', () => {
    const emittable = emittableTestTypes();
    const tags = catalogTags();

    if (tags.length === 0) {
      reportAbstention(
        'example-catalog-tags',
        'no classification tag found under examples/ — the catalog moved, ' +
          'was renamed, or the README phrasing changed; nothing was checked',
      );
      expect.fail(
        'zero catalog tags matched: a vacuous pass, not a clean catalog',
      );
    }

    const drifted = tags.filter((t) => !emittable.has(t.tag));
    expect(
      drifted.map((d) => `${d.file}: \`${d.tag}\``),
      `tags the classifier never emits (legal: ${[...emittable].sort().join(', ')})`,
    ).toEqual([]);

    reportVerified(
      'example-catalog-tags',
      `${tags.length} tag(s) across ${new Set(tags.map((t) => t.file)).size} ` +
        `README(s) checked against ${emittable.size} emittable test_type(s)`,
    );
  });
});
