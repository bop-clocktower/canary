/**
 * The producer behind `.canary/test-inventory.json` (#957).
 *
 * `canary ci-ready` scores coverage depth, assertion quality and critical paths
 * from this file, and until #957 nothing wrote it. The walk and the per-test
 * boundaries are not new: files come from `collectTestFiles` (the denominator
 * `review-test` and `vacuity-check` share) and tests from `enumerateTests` over
 * string-blanked source. The weak-assertion vocabulary is the vacuity scanner's.
 * A second traversal would be a second answer to "how many tests are there".
 *
 * Depth is a STATIC tier, not runtime coverage, and the schema doc
 * (docs/guides/test-inventory.md) says so:
 *   0 -- no recognised assertion
 *   1 -- every assertion is an absence or a trivial presence
 *   2 -- at least one shaped assertion
 */
import { readFileSync } from 'node:fs';
import { posix, relative, sep } from 'node:path';

import { enumerateTests, frameworkForPath } from './static-linter.js';
import { blankStringContent } from './string-literals.js';
import {
  isAssertion,
  isPythonStdlibModule,
  isWeakAssertion,
} from './vacuity-scanner.js';

export const INVENTORY_SCHEMA_VERSION = 1;

export type AssertionDepth = 0 | 1 | 2;

export interface InventoryTest {
  name: string;
  line: number;
  depth: AssertionDepth;
}

export interface InventoryFile {
  /** POSIX path relative to the inventory root. */
  path: string;
  framework: string;
  /** Root-relative, extension-stripped paths the file imports first-party. */
  targets: string[];
  tests: InventoryTest[];
}

export interface TestInventory {
  schema_version: number;
  generated: string;
  files: InventoryFile[];
  /** Same shape as `SkipEntry` in gate-result.ts, kept local to hold fan-out down. */
  skipped: InventorySkip[];
}

interface InventorySkip {
  name: string;
  reason: string;
}

/** The static depth tier of one test body. */
export function assertionDepth(body: string, python: boolean): AssertionDepth {
  const asserts = body.split('\n').filter((l) => isAssertion(l, python));
  if (asserts.length === 0) return 0;
  return asserts.every((l) => isWeakAssertion(l, python)) ? 1 : 2;
}

const JS_SPECIFIER =
  /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)['"](\.[^'"]*)['"]/g;
const PY_FROM = /^[ \t]*from\s+([\w.]+)\s+import\b/gm;
const SOURCE_EXT = /\.(?:[mc]?[jt]sx?|py)$/;

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

function pyModulePath(mod: string, fileDir: string): string | null {
  const dots = /^\.*/.exec(mod)![0].length;
  const rest = mod.slice(dots).replace(/\./g, '/');
  if (dots === 0) {
    return isPythonStdlibModule(rest.split('/')[0]!) ? null : rest;
  }
  const up = '../'.repeat(dots - 1);
  return posix.normalize(posix.join(fileDir, up, rest));
}

/** First-party import targets, in source order, deduplicated. */
function importTargets(source: string, rel: string, python: boolean): string[] {
  const fileDir = posix.dirname(rel);
  const out = new Set<string>();
  if (python) {
    for (const m of source.matchAll(PY_FROM)) {
      const p = pyModulePath(m[1]!, fileDir);
      if (p) out.add(p);
    }
  } else {
    for (const m of source.matchAll(JS_SPECIFIER)) {
      const p = posix.normalize(posix.join(fileDir, m[1]!));
      out.add(p.replace(SOURCE_EXT, ''));
    }
  }
  return [...out];
}

function inventoryFile(
  path: string,
  root: string,
  skipped: InventorySkip[],
): InventoryFile | null {
  const rel = toPosix(relative(root, path));
  const framework = frameworkForPath(path);
  if (framework === null) return null;
  let source: string;
  try {
    source = readFileSync(path, 'utf-8');
  } catch (e) {
    skipped.push({ name: rel, reason: `unreadable: ${(e as Error).message}` });
    return null;
  }
  const python = framework === 'pytest';
  const code = blankStringContent(source, { python });
  const tests = enumerateTests(code, source, python).map((t) => ({
    name: t.name,
    line: t.line,
    depth: assertionDepth(t.body, python),
  }));
  const targets = importTargets(source, rel, python);
  return { path: rel, framework, targets, tests };
}

/**
 * Inventory `testFiles` (from `collectTestFiles`), with paths relative to
 * `root`. The caller walks the tree, which keeps this module's fan-out within
 * the perf coupling rule. `generated` is injected so the output is
 * deterministic under test.
 */
export function buildInventory(
  root: string,
  testFiles: string[],
  generated: string,
): TestInventory {
  const skipped: InventorySkip[] = [];
  const files: InventoryFile[] = [];
  for (const path of testFiles) {
    const f = inventoryFile(path, root, skipped);
    if (f) files.push(f);
  }
  return {
    schema_version: INVENTORY_SCHEMA_VERSION,
    generated,
    files,
    skipped,
  };
}

/** Total tests across the inventory -- the denominator every consumer needs. */
export function inventoryTestCount(inv: TestInventory): number {
  return inv.files.reduce((n, f) => n + f.tests.length, 0);
}
