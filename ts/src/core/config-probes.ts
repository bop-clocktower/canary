/**
 * The config-file tiers of framework detection: a dedicated test config at the
 * probed root, and -- for a repo that declares no workspace -- the same config
 * names up to NESTED_CONFIG_MAX_DEPTH directories below it (#1212).
 *
 * Split from `framework-probes.ts` so the walk has a home without pushing that
 * module past the perf LOC ceiling. Leafward: `framework-probes -> config-probes
 * -> fs-glob`; nothing here imports back.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { globFiles, WORKSPACE_SKIP_DIRS } from './fs-glob.js';
import type { TestShape } from './test-shapes.js';

/** [framework, shape, source, confidence] -- framework null on a miss. */
export type ProbeResult = [
  framework: string | null,
  shape: string,
  source: string,
  confidence: string,
];

// (config_file, framework, shape, confidence)
export const CONFIG_PROBES: Array<[string, string, TestShape, string]> = [
  ['playwright.config.ts', 'playwright', 'e2e_ui', 'config'],
  ['playwright.config.js', 'playwright', 'e2e_ui', 'config'],
  ['cypress.config.ts', 'playwright', 'e2e_ui', 'config'],
  ['cypress.config.js', 'playwright', 'e2e_ui', 'config'],
  ['vitest.config.ts', 'vitest', 'frontend_unit', 'config'],
  ['vitest.config.js', 'vitest', 'frontend_unit', 'config'],
  ['vitest.config.mts', 'vitest', 'frontend_unit', 'config'],
  ['jest.config.ts', 'vitest', 'frontend_unit', 'config'],
  ['jest.config.js', 'vitest', 'frontend_unit', 'config'],
  ['jest.config.mjs', 'vitest', 'frontend_unit', 'config'],
  ['k6.config.js', 'k6', 'performance', 'config'],
  ['pytest.ini', 'pytest', 'api', 'config'],
  ['setup.cfg', 'pytest', 'api', 'config'],
  ['axe.config.js', 'axe-core', 'accessibility', 'config'],
  ['backstop.json', 'backstopjs', 'visual', 'config'],
  ['pact.json', 'pact', 'contract', 'config'],
  ['.pact', 'pact', 'contract', 'config'],
  ['stryker.config.js', 'stryker', 'mutation', 'config'],
  ['stryker.config.mjs', 'stryker', 'mutation', 'config'],
  ['locust.conf', 'locust', 'load', 'config'],
  ['locustfile.py', 'locust', 'load', 'config'],
  ['wdio.conf.ts', 'wdio', 'mobile', 'config'],
  ['wdio.conf.js', 'wdio', 'mobile', 'config'],
  ['wdio.conf.mjs', 'wdio', 'mobile', 'config'],
];

// Detects playwright UI fixture params. MULTILINE is a no-op (no `^`/`$`).
const _PW_UI_FIXTURE_RE = /async\s*\(\s*\{[^}]*\b(?:page|browser)\b/;

/**
 * Return 'api' when no playwright spec file uses page/browser fixtures, else
 * 'e2e_ui' (the default when any UI signal is found or no spec files exist).
 */
export function inferPlaywrightTestType(root: string): TestShape {
  const specGlobs = [
    'tests/**/*.spec.ts',
    'tests/**/*.spec.js',
    'test/**/*.spec.ts',
    'test/**/*.spec.js',
  ];
  let total = 0;
  for (const glob of specGlobs) {
    for (const path of globFiles(root, glob)) {
      // Python read_text(errors="ignore"); readFileSync substitutes U+FFFD for
      // invalid bytes -- immaterial for the ASCII fixture pattern below.
      let content: string;
      try {
        content = readFileSync(path, 'utf-8');
      } catch {
        continue;
      }
      total += 1;
      if (_PW_UI_FIXTURE_RE.test(content)) return 'e2e_ui';
    }
  }

  return total > 0 ? 'api' : 'e2e_ui';
}

/**
 * The (framework, shape, confidence) a config file at *dir* declares. A
 * playwright config is refined against the specs beside it; the refinement
 * read file contents, so a changed shape reports confidence `content`.
 */
function classifyConfig(
  dir: string,
  framework: string,
  shape: TestShape,
  confidence: string,
): [string, string, string] {
  if (framework === 'playwright' && shape === 'e2e_ui') {
    const inferred = inferPlaywrightTestType(dir);
    if (inferred !== shape) return [framework, inferred, 'content'];
  }
  return [framework, shape, confidence];
}

/** Tier 1 -- a dedicated config file at the root (highest confidence). */
export function probeConfig(root: string): ProbeResult | null {
  for (const [filename, framework, shape, confidence] of CONFIG_PROBES) {
    if (existsSync(join(root, filename))) {
      const [fw, sh, conf] = classifyConfig(root, framework, shape, confidence);
      return [fw, sh, filename, conf];
    }
  }
  return null;
}

/** How many directory levels below the root the nested walk reaches. */
export const NESTED_CONFIG_MAX_DEPTH = 3;

/**
 * Directories the nested walk never enters: installed dependencies, VCS
 * metadata, and build / tool output, none of which is the repo's own suite.
 * A superset of the workspace walk's list so the two cannot drift apart.
 */
export const NESTED_CONFIG_SKIP_DIRS: ReadonlySet<string> = new Set([
  ...WORKSPACE_SKIP_DIRS,
  'out',
  '.nuxt',
  '.cache',
  'target',
]);

const _CONFIG_NAMES = new Set(CONFIG_PROBES.map(([name]) => name));

/** Code-point order, independent of locale and of creation order. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Relative POSIX paths of every config file 1..NESTED_CONFIG_MAX_DEPTH levels
 * below *root*, sorted. The root itself belongs to `probeConfig`. Symlinked
 * directories are not followed (no cycles); an unreadable directory is skipped.
 */
export function findNestedConfigs(root: string): string[] {
  const found: string[] = [];
  const visit = (rel: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (depth > 0 && _CONFIG_NAMES.has(entry.name)) found.push(path);
      if (
        entry.isDirectory() &&
        depth < NESTED_CONFIG_MAX_DEPTH &&
        !NESTED_CONFIG_SKIP_DIRS.has(entry.name)
      ) {
        visit(path, depth + 1);
      }
    }
  };
  visit('', 0);
  return found.sort(byCodePoint);
}

/**
 * Nested config tier (#1212). Agreement is on the (framework, shape) PAIR, as
 * for workspace findings: one pair is a hit naming the first config's relative
 * path; several pairs are an explicit abstention naming every config, so the
 * answer never depends on walk order. Null when nothing nested matched.
 */
export function probeNestedConfig(root: string): ProbeResult | null {
  const hits = findNestedConfigs(root).map((rel) => {
    const name = rel.slice(rel.lastIndexOf('/') + 1);
    const [, framework, shape, confidence] = CONFIG_PROBES.find(
      ([n]) => n === name,
    )!;
    const dir = join(root, rel, '..');
    return [rel, ...classifyConfig(dir, framework, shape, confidence)];
  });
  if (hits.length === 0) return null;
  const pairs = new Set(hits.map(([, fw, sh]) => `${fw}/${sh}`));
  if (pairs.size > 1) {
    const named = hits.map(([rel, fw, sh]) => `${rel} (${fw}/${sh})`);
    return [
      null,
      'unknown',
      `nested configs (mixed: ${named.join(', ')})`,
      'none',
    ];
  }
  const [rel, framework, shape, confidence] = hits[0]!;
  const more = hits.length > 1 ? ` (+${hits.length - 1} more)` : '';
  const label = hits.length > 1 ? 'nested configs' : 'nested config';
  return [framework!, shape!, `${label} ${rel}${more}`, confidence!];
}
