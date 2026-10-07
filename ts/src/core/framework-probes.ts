/**
 * Test-framework detection probes, tiered by the kind of evidence they read.
 *
 * Split out of `migrator.ts` (#504 part 1) so workspace detection can probe an
 * individual package without importing the migrator -- see `fs-glob.ts` for why
 * the direction has to stay leafward.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { globFiles, readTextOrNull } from './fs-glob.js';
import type { TestShape } from './test-shapes.js';

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

// pyproject.toml section markers
const _PYPROJECT_MARKERS: Array<[string, string, TestShape]> = [
  ['[tool.pytest.ini_options]', 'pytest', 'api'],
  ['[tool.coverage', 'pytest', 'api'],
];

// package.json test script -> (framework, shape)
const _PACKAGE_SCRIPT_PATTERNS: Array<[RegExp, string, TestShape]> = [
  [/\bplaywright\b/, 'playwright', 'e2e_ui'],
  [/\bcypress\b/, 'playwright', 'e2e_ui'],
  [/\bvitest\b/, 'vitest', 'frontend_unit'],
  [/\bjest\b/, 'vitest', 'frontend_unit'],
  [/\bk6\b/, 'k6', 'performance'],
  [/\blocust\b/, 'locust', 'load'],
  [/\bstryker\b/, 'stryker', 'mutation'],
  [/\bwdio\b/, 'wdio', 'mobile'],
];

// package.json dependency -> (framework, shape) (#1205): exact names, registry
// frameworks only, same vocabulary as the tables above. `@playwright/test` is
// refined by `inferPlaywrightTestType`, as the config tier does.
const _JS_DEP_PACKAGES: Array<[string, string, TestShape]> = [
  ['@playwright/test', 'playwright', 'e2e_ui'],
  ['vitest', 'vitest', 'frontend_unit'],
  ['k6', 'k6', 'performance'],
  ['@wdio/cli', 'wdio', 'mobile'],
  ['webdriverio', 'wdio', 'mobile'],
];

const _JS_DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies'];

// Python dependency -> (framework, shape). MULTILINE `^` anchored on `\n` only.
const _PYTHON_DEP_PATTERNS: Array<[RegExp, string, TestShape]> = [
  [/(?:^|(?<=\n))pytest\b/i, 'pytest', 'api'],
  [/(?:^|(?<=\n))locust\b/i, 'locust', 'load'],
  [/(?:^|(?<=\n))pact\b/i, 'pact', 'contract'],
  [/(?:^|(?<=\n))sdv\b/i, 'sdv', 'synthetic_data'],
  [/(?:^|(?<=\n))faker\b/i, 'faker', 'synthetic_data'],
  [/(?:^|(?<=\n))testcontainers\b/i, 'testcontainers', 'integration'],
];

// Language -> (framework, shape) fallbacks from harness.config.json
const _LANGUAGE_FALLBACKS: Record<string, [string, TestShape]> = {
  python: ['pytest', 'api'],
  typescript: ['playwright', 'e2e_ui'],
  javascript: ['playwright', 'e2e_ui'],
};

// Detects playwright UI fixture params. MULTILINE is a no-op (no `^`/`$`).
const _PW_UI_FIXTURE_RE = /async\s*\(\s*\{[^}]*\b(?:page|browser)\b/;

export type ProbeTier =
  'config' | 'content' | 'scripts' | 'dependency' | 'language';

export type ProbeResult = [
  framework: string | null,
  shape: string,
  source: string,
  confidence: string,
];

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

/** Tier 1 -- a dedicated config file (highest confidence). */
function probeConfig(root: string): ProbeResult | null {
  for (const [filename, framework, shape, confidence] of CONFIG_PROBES) {
    if (existsSync(join(root, filename))) {
      // For playwright config files, distinguish API vs UI suites.
      if (framework === 'playwright' && shape === 'e2e_ui') {
        const inferred = inferPlaywrightTestType(root);
        if (inferred !== shape)
          return [framework, inferred, filename, 'content'];
      }
      return [framework, shape, filename, confidence];
    }
  }
  return null;
}

/** Tier 2a -- pyproject.toml section markers, then its dependency scan. */
function probePyproject(root: string): ProbeResult | null {
  const pyproject = join(root, 'pyproject.toml');
  if (!existsSync(pyproject)) return null;
  const content = readTextOrNull(pyproject);
  if (content === null) return null;
  for (const [marker, framework, shape] of _PYPROJECT_MARKERS) {
    if (content.includes(marker)) {
      return [framework, shape, 'pyproject.toml', 'content'];
    }
  }
  for (const [pattern, framework, shape] of _PYTHON_DEP_PATTERNS) {
    if (pattern.test(content)) {
      return [framework, shape, 'pyproject.toml (dependencies)', 'content'];
    }
  }
  return null;
}

/** Tier 2b -- requirements*.txt dependency scan. */
function probeRequirements(root: string): ProbeResult | null {
  for (const reqFile of [
    'requirements.txt',
    'requirements-test.txt',
    'requirements-dev.txt',
  ]) {
    const reqPath = join(root, reqFile);
    if (!existsSync(reqPath)) continue;
    const content = readTextOrNull(reqPath);
    if (content === null) continue;
    for (const [pattern, framework, shape] of _PYTHON_DEP_PATTERNS) {
      if (pattern.test(content)) return [framework, shape, reqFile, 'content'];
    }
  }
  return null;
}

/** package.json as an object, or null when absent, unreadable, or not JSON. */
function readPackageJson(root: string): Record<string, unknown> | null {
  const text = readTextOrNull(join(root, 'package.json'));
  try {
    const pkg: unknown = JSON.parse(text ?? ''); // missing file -> throws -> null
    return isRecord(pkg) ? pkg : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// npm lifecycle hooks install/publish a package: never test evidence (#1205).
const _LIFECYCLE_RE =
  /^(?:(?:pre|post)?(?:install|publish|pack|version)|prepare|prepublishOnly)$/;

/**
 * Tier 2d filter -- any other script except lifecycle hooks and the pre/post
 * hook of a declared script; multi-target suites often have only `test:<x>`
 * (#1205). Its own tier so a workspace root can withhold it.
 */
function isOtherScript(key: string, scripts: object): boolean {
  const hooked = /^(?:pre|post)(.+)$/.exec(key)?.[1] ?? '';
  const hook = _LIFECYCLE_RE.test(key) || Object.hasOwn(scripts, hooked);
  return key !== 'test' && !hook;
}

/** Tiers 2c/2d -- the first script *keep* admits that a runner matches. */
function probeScripts(
  root: string,
  keep: (key: string, scripts: object) => boolean,
): ProbeResult | null {
  const pkg = readPackageJson(root);
  const scripts = isRecord(pkg?.['scripts']) ? pkg['scripts'] : {};
  for (const [key, command] of Object.entries(scripts)) {
    if (typeof command !== 'string' || !keep(key, scripts)) continue;
    const m = _PACKAGE_SCRIPT_PATTERNS.find(([re]) => re.test(command));
    if (m) return [m[1], m[2], `package.json (scripts.${key})`, 'content'];
  }
  return null;
}

/**
 * Tier 2e -- package.json dependency scan (#1205). Below scripts: a script says
 * how the suite runs, a dependency only that the tool is installed. Above the
 * language fallback: a dependency is observed here, a language is inherited.
 */
function probePackageDeps(root: string): ProbeResult | null {
  const pkg = readPackageJson(root);
  if (pkg === null) return null;
  for (const [dep, framework, shape] of _JS_DEP_PACKAGES) {
    const field = _JS_DEP_FIELDS.find(
      (f) => isRecord(pkg[f]) && Object.hasOwn(pkg[f] as object, dep),
    );
    if (field === undefined) continue;
    const refined =
      framework === 'playwright' ? inferPlaywrightTestType(root) : shape;
    return [framework, refined, `package.json (${field}: ${dep})`, 'content'];
  }
  return null;
}

/** Tier 3 -- language fallback from harness config. */
function probeLanguage(config: Record<string, unknown>): ProbeResult | null {
  const language = String(config['language'] ?? '').toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(_LANGUAGE_FALLBACKS, language)) {
    return null;
  }
  const [fw, shape] = _LANGUAGE_FALLBACKS[language]!;
  return [fw, shape, `harness.config.json (language: ${language})`, 'language'];
}

/**
 * Detect a test framework under *dir*, running only the requested *tiers*.
 *
 * The tier list is the whole point of this function. A workspace root whose
 * packages carry findings withholds `scripts` and `dependency` (#1205). No
 * package probe passes `language`: it maps `language: typescript` to
 * playwright/e2e_ui, so every package in a TypeScript monorepo would "detect"
 * playwright by inheritance -- findings never observed (#504 part 1, test #8).
 *
 * Note the tier list and the returned `confidence` are not the same axis: the
 * config tier returns confidence `content` when `inferPlaywrightTestType`
 * refines e2e_ui to api, because the refinement read file contents to decide.
 */
export function probeFramework(
  dir: string,
  config: Record<string, unknown>,
  tiers: ProbeTier[],
): ProbeResult {
  const steps: Array<[ProbeTier, () => ProbeResult | null]> = [
    ['config', () => probeConfig(dir)],
    [
      'content',
      () =>
        probePyproject(dir) ??
        probeRequirements(dir) ??
        probeScripts(dir, (key) => key === 'test'),
    ],
    ['scripts', () => probeScripts(dir, isOtherScript)],
    ['dependency', () => probePackageDeps(dir)],
    ['language', () => probeLanguage(config)],
  ];
  for (const [tier, probe] of steps) {
    const hit = tiers.includes(tier) ? probe() : null;
    if (hit !== null) return hit;
  }
  return [null, 'unknown', 'none', 'none'];
}
