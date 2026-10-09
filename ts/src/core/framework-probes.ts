/**
 * Test-framework detection probes, tiered by the kind of evidence they read.
 *
 * Split out of `migrator.ts` (#504 part 1) so workspace detection can probe an
 * individual package without importing the migrator -- see `fs-glob.ts` for why
 * the direction has to stay leafward.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  inferPlaywrightTestType,
  probeConfig,
  probeNestedConfig,
  type ProbeResult,
} from './config-probes.js';
import { readTextOrNull } from './fs-glob.js';
import type { TestShape } from './test-shapes.js';

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

export type ProbeTier =
  | 'config'
  | 'content'
  | 'nested-config'
  | 'scripts'
  | 'dependency'
  | 'language';

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
 *
 * `nested-config` (#1212) walks below *dir*, so only a root that declares no
 * workspace passes it -- at a workspace root it would report a package's own
 * config as a root hit. It ranks below the root's own evidence and above the
 * weaker tiers, and its mixed result (framework null, a `nested configs
 * (mixed: ...)` source) ends the probe like any hit: an inherited language
 * guess must not paper over configs that disagree.
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
    ['nested-config', () => probeNestedConfig(dir)],
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
