/**
 * Context-aware environment & persona detection (issue #341).
 *
 * Faithful TypeScript port of `agent/core/environment_detect.py`.
 *
 * Canary tailors which skills load, which user pool it queries, and how it
 * phrases output based on *who* is driving and *what* they are testing. This
 * module gathers that context from cheap, local, deterministic signals so a
 * consumer (currently the MCP `analyze_file` path) can attach it to its
 * response without any network call or model round-trip.
 *
 * Three detection paths are implemented — the concrete, testable ones:
 *   1. **BASE_URL** — from `.env` (canonical `BASE_URL` plus common aliases),
 *      falling back to a literal `baseURL` in `playwright.config.*`.
 *   2. **Suite hints** — parse `playwright.config.*` for `testDir` / project
 *      names / `testMatch` to classify the suite as e2e / component / api.
 *   3. **User level (SDET vs manual)** — a transparent, documented heuristic
 *      over cwd and the caller-supplied list of open files.
 *
 * Python→TS nuances:
 *   - `os.environ` is not touched here; all inputs are paths.
 *   - `Path(p).resolve()` → `resolve(p)`; `Path.exists()` → `existsSync`;
 *     `read_text(encoding="utf-8", errors="ignore")` → `readFileSync(p,
 *     'utf-8')` (Node substitutes U+FFFD on bad bytes rather than dropping).
 *   - `re.search`/`re.findall` map to a single `.exec` / a global-regex loop.
 *   - `round(x, 3)` is Python round-half-to-even, reproduced by {@link round3}.
 *   - `Path(f).suffix` → `extname` (both yield "" for a dotfile like `.env`).
 */

import { existsSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

// Ordered by trust: the canonical name wins over framework-specific aliases.
const BASE_URL_KEYS = [
  'BASE_URL',
  'PLAYWRIGHT_BASE_URL',
  'E2E_BASE_URL',
  'APP_URL',
] as const;

const PLAYWRIGHT_CONFIGS = [
  'playwright.config.ts',
  'playwright.config.js',
  'playwright.config.mts',
  'playwright.config.mjs',
  'playwright.config.cts',
  'playwright.config.cjs',
] as const;

// Extensions that indicate someone is writing/reading code or automated tests.
const CODE_SUFFIXES = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.java',
  '.rb',
  '.go',
  '.cs',
]);
// Extensions that indicate manual test artefacts (plans, case sheets, notes).
const MANUAL_SUFFIXES = new Set([
  '.md',
  '.csv',
  '.xlsx',
  '.xls',
  '.docx',
  '.doc',
  '.pdf',
  '.txt',
]);

// Config filenames whose mere presence marks an automation-savvy project.
const TEST_CONFIG_FILES = [
  'playwright.config.ts',
  'playwright.config.js',
  'vitest.config.ts',
  'vitest.config.js',
  'pytest.ini',
  'jest.config.js',
  'jest.config.ts',
  'cypress.config.ts',
  'cypress.config.js',
] as const;
const PROJECT_MANIFESTS = [
  'package.json',
  'pyproject.toml',
  'requirements.txt',
] as const;

// cwd path fragments that lean manual.
const MANUAL_DIR_HINTS = [
  'manual',
  'test-case',
  'testcase',
  'test-plan',
  'testplan',
] as const;

/** Python-compatible `round(x, 3)` — round-half-to-even at 3 decimal places. */
function round3(x: number): number {
  const scaled = x * 1000;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  const eps = 1e-9;
  let rounded: number;
  if (Math.abs(diff - 0.5) < eps) {
    rounded = floor % 2 === 0 ? floor : floor + 1;
  } else {
    rounded = Math.round(scaled);
  }
  return rounded / 1000;
}

/** Split like Python's `str.splitlines()` for the common line endings. */
function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** Python `str.strip()` (no args) — trim ASCII whitespace both ends. */
function stripWs(s: string): string {
  return s.trim();
}

/** Python `str.strip(ch)` — remove all leading/trailing runs of `ch`. */
function stripChar(s: string, ch: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s[start] === ch) start++;
  while (end > start && s[end - 1] === ch) end--;
  return s.slice(start, end);
}

/** JSON-serialisable init for {@link EnvironmentContext}. */
export interface EnvironmentContextInit {
  base_url?: string | null;
  base_url_source?: string | null;
  suite_type?: string | null;
  suite_hints?: string[];
  user_level?: string;
  user_level_signals?: string[];
  user_level_confidence?: number;
}

/**
 * Detected environment/persona context for the current invocation.
 *
 * Python: `EnvironmentContext` (a dataclass). All fields are
 * optional/degradable: absent signals leave sensible `null` / `"unknown"`
 * defaults rather than raising.
 */
export class EnvironmentContext {
  base_url: string | null;
  base_url_source: string | null; // ".env" | "playwright.config" | null
  suite_type: string | null; // "e2e" | "component" | "api" | null
  suite_hints: string[];
  user_level: string; // "sdet" | "manual" | "unknown"
  user_level_signals: string[];
  user_level_confidence: number;

  constructor(init: EnvironmentContextInit = {}) {
    this.base_url = init.base_url ?? null;
    this.base_url_source = init.base_url_source ?? null;
    this.suite_type = init.suite_type ?? null;
    this.suite_hints = init.suite_hints ?? [];
    this.user_level = init.user_level ?? 'unknown';
    this.user_level_signals = init.user_level_signals ?? [];
    this.user_level_confidence = init.user_level_confidence ?? 0.0;
  }

  /**
   * Return a JSON-serialisable view for embedding in MCP responses.
   *
   * Python: `EnvironmentContext.to_dict`.
   */
  toDict(): Record<string, unknown> {
    return {
      base_url: this.base_url,
      base_url_source: this.base_url_source,
      suite_type: this.suite_type,
      suite_hints: [...this.suite_hints],
      user_level: this.user_level,
      user_level_signals: [...this.user_level_signals],
      user_level_confidence: round3(this.user_level_confidence),
    };
  }
}

// ---------------------------------------------------------------------------
// Path 2 (issue path b): BASE_URL from .env / playwright.config.*
// ---------------------------------------------------------------------------

/**
 * Return the first BASE_URL-family value from `.env`, or null.
 *
 * Python: `_parse_dotenv_base_url`.
 */
function parseDotenvBaseUrl(root: string): string | null {
  const path = join(root, '.env');
  if (!existsSync(path)) return null;
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    // Python catches OSError → None.
    return null;
  }

  const found: Record<string, string> = {};
  for (const raw of splitLines(text)) {
    let line = stripWs(raw);
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) {
      line = line.slice('export '.length).replace(/^\s+/, '');
    }
    if (!line.includes('=')) continue;
    const idx = line.indexOf('=');
    const key = stripWs(line.slice(0, idx));
    let value = stripWs(line.slice(idx + 1));
    value = stripChar(stripChar(value, '"'), "'");
    if (
      (BASE_URL_KEYS as readonly string[]).includes(key) &&
      value &&
      !Object.prototype.hasOwnProperty.call(found, key)
    ) {
      found[key] = value;
    }
  }

  // Honour trust order regardless of file order.
  for (const key of BASE_URL_KEYS) {
    if (Object.prototype.hasOwnProperty.call(found, key)) return found[key]!;
  }
  return null;
}

/**
 * Return a *literal* `baseURL` from playwright.config.*, or null.
 *
 * A `process.env.*` indirection is deliberately ignored — there is no literal
 * URL to report, and inventing one would be misleading.
 *
 * Python: `_parse_config_base_url`.
 */
function parseConfigBaseUrl(root: string): string | null {
  for (const name of PLAYWRIGHT_CONFIGS) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    let text: string;
    try {
      text = readFileSync(path, 'utf-8');
    } catch {
      // Python catches OSError → continue.
      continue;
    }
    const match = /baseURL\s*:\s*['"]([^'"]+)['"]/.exec(text);
    if (match) return match[1]!;
  }
  return null;
}

/**
 * Detect the target BASE_URL for the project.
 *
 * Precedence: an explicit `.env` value beats a literal in the Playwright
 * config. Returns `[url, source]` where source is `".env"`,
 * `"playwright.config"`, or `null` when nothing was found.
 *
 * Python: `detect_base_url`.
 */
export function detectBaseUrl(
  projectRoot = '.',
): [string | null, string | null] {
  const root = resolve(projectRoot);

  const envUrl = parseDotenvBaseUrl(root);
  if (envUrl) return [envUrl, '.env'];

  const cfgUrl = parseConfigBaseUrl(root);
  if (cfgUrl) return [cfgUrl, 'playwright.config'];

  return [null, null];
}

// ---------------------------------------------------------------------------
// Path 2 (issue path b): suite hints from playwright.config.*
// ---------------------------------------------------------------------------

/**
 * Infer suite type and collect free-form hints from a Playwright config.
 *
 * Reads `testDir`, `testMatch`, and `projects[].name` and classifies the suite
 * as `"component"`, `"api"`, or `"e2e"`. Playwright is end-to-end by default,
 * so a config present but giving no stronger signal is classified `"e2e"`.
 * Returns `[null, []]` when no Playwright config exists.
 *
 * Python: `parse_playwright_suite_hints`.
 */
export function parsePlaywrightSuiteHints(
  projectRoot = '.',
): [string | null, string[]] {
  const root = resolve(projectRoot);
  let configText: string | null = null;
  for (const name of PLAYWRIGHT_CONFIGS) {
    const path = join(root, name);
    if (existsSync(path)) {
      try {
        configText = readFileSync(path, 'utf-8');
      } catch {
        configText = '';
      }
      break;
    }
  }

  if (configText === null) return [null, []];

  const hints: string[] = [];

  const testDirMatch = /testDir\s*:\s*['"]([^'"]+)['"]/.exec(configText);
  if (testDirMatch) hints.push(testDirMatch[1]!);

  const testMatch = /testMatch\s*:\s*['"]([^'"]+)['"]/.exec(configText);
  if (testMatch) hints.push(testMatch[1]!);

  const nameRe = /name\s*:\s*['"]([^'"]+)['"]/g;
  for (
    let m = nameRe.exec(configText);
    m !== null;
    m = nameRe.exec(configText)
  ) {
    hints.push(m[1]!);
  }

  const blob = hints.join(' ').toLowerCase();
  let suiteType: string;
  if (
    blob.includes('component') ||
    blob.includes('.ct.') ||
    blob.includes('/ct')
  ) {
    suiteType = 'component';
  } else if (blob.includes('api')) {
    suiteType = 'api';
  } else {
    // Config present but no stronger cue: Playwright defaults to e2e.
    suiteType = 'e2e';
  }

  return [suiteType, hints];
}

// ---------------------------------------------------------------------------
// Path 3 (issue path c): SDET-vs-manual user-level heuristic
// ---------------------------------------------------------------------------

/**
 * Classify the driver as an SDET or a manual tester — transparently.
 *
 * An intentionally simple, auditable scoring heuristic: each fired signal adds
 * one point to the SDET or manual tally and is returned so a consumer can see
 * exactly why the verdict came out. Returns `[level, signals, confidence]`
 * where `level` is `"sdet"` / `"manual"` / `"unknown"` (a tie or no signal),
 * and `confidence` is `|sdet - manual| / (sdet + manual)` in `[0, 1]` (`0.0`
 * when no signal fired).
 *
 * Python: `detect_user_level`.
 */
export function detectUserLevel(
  cwd: string,
  openFiles: readonly string[] | null = null,
): [string, string[], number] {
  const signals: string[] = [];
  let sdet = 0;
  let manual = 0;

  const files = openFiles ?? [];
  for (const f of files) {
    const suffix = extname(f).toLowerCase();
    if (CODE_SUFFIXES.has(suffix)) {
      sdet += 1;
      signals.push(`code/test file open: ${f}`);
    } else if (MANUAL_SUFFIXES.has(suffix)) {
      manual += 1;
      signals.push(`manual artefact open: ${f}`);
    }
  }

  // Python: `cwd_path = Path(cwd)`. `Path("")` normalizes to `"."`, so an empty
  // cwd scans the current directory and its `str()` is `"."` — reproduce that
  // rather than treating `""` as a non-existent path.
  const cwdPath = cwd === '' ? '.' : cwd;

  const cwdLower = cwdPath.toLowerCase();
  if (MANUAL_DIR_HINTS.some((hint) => cwdLower.includes(hint))) {
    manual += 1;
    signals.push('cwd path suggests manual testing');
  }

  if (existsSync(cwdPath)) {
    for (const cfg of TEST_CONFIG_FILES) {
      if (existsSync(join(cwdPath, cfg))) {
        sdet += 1;
        signals.push(`test-framework config present: ${cfg}`);
        break;
      }
    }
    for (const manifest of PROJECT_MANIFESTS) {
      if (existsSync(join(cwdPath, manifest))) {
        sdet += 1;
        signals.push(`project manifest present: ${manifest}`);
        break;
      }
    }
  }

  const total = sdet + manual;
  if (total === 0) return ['unknown', [], 0.0];

  const confidence = Math.abs(sdet - manual) / total;
  if (sdet > manual) return ['sdet', signals, confidence];
  if (manual > sdet) return ['manual', signals, confidence];
  return ['unknown', signals, confidence];
}

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

/** Options for {@link detectEnvironment}. */
export interface DetectEnvironmentOptions {
  cwd?: string | null;
  openFiles?: readonly string[] | null;
}

/**
 * Run every implemented detection path and return the combined context.
 *
 * Python: `detect_environment`. `cwd` defaults to `project_root` when omitted;
 * `open_files` is the caller-supplied list of open/edited paths (this module
 * never guesses them).
 */
export function detectEnvironment(
  projectRoot = '.',
  options: DetectEnvironmentOptions = {},
): EnvironmentContext {
  const { cwd = null, openFiles = null } = options;

  const [baseUrl, baseUrlSource] = detectBaseUrl(projectRoot);
  const [suiteType, suiteHints] = parsePlaywrightSuiteHints(projectRoot);
  // Python: `cwd or project_root` — an empty-string cwd is falsy and collapses
  // to project_root. `??` would wrongly keep `""`, so use `||`.
  const [level, levelSignals, levelConf] = detectUserLevel(
    cwd || projectRoot,
    openFiles,
  );

  return new EnvironmentContext({
    base_url: baseUrl,
    base_url_source: baseUrlSource,
    suite_type: suiteType,
    suite_hints: suiteHints,
    user_level: level,
    user_level_signals: levelSignals,
    user_level_confidence: levelConf,
  });
}
