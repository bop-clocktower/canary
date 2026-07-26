/**
 * Discovers Canary skills: bundled defaults and local project overlays.
 *
 * Faithful TypeScript port of `agent/core/skill_registry.py`. Implements the
 * discovery convention defined in docs/specs/skill-discovery.md.
 *
 * Skills are SKILL.md files with YAML-style frontmatter. The optional `cli:` and
 * `entry:` frontmatter fields let a skill ship executable code alongside its
 * prose:
 *   - `cli:`   filesystem path (relative to the skill directory) of an
 *     executable to invoke as a subprocess.
 *   - `entry:` a `module:callable` string to call in-process (reserved).
 * These fields are mutually exclusive; specifying both is rejected at discovery.
 *
 * Python->TS nuances:
 *   - Python patches `Path.home()` in its tests to isolate the home-dir tiers.
 *     There is no global monkeypatch in JS, so the home directory is an
 *     injectable constructor argument (defaults to `os.homedir()`), mirroring the
 *     `home?` seam the overlays.ts port added. The bundled-skill directory is
 *     resolved from `import.meta.url` exactly as Python resolves it from
 *     `__file__` (three levels up to the repo root, then agents/skills).
 *   - `Path.read_text` / `OSError` -> `readFileSync` in a try/catch returning
 *     `null`. `Path.resolve()` (absolute + symlink resolution) -> `realpathSync`,
 *     except a *non-existent* candidate is normalized without throwing (Python's
 *     non-strict `resolve()` does not raise), so {@link resolveCliPath} only
 *     realpaths a path that exists.
 *   - Python truthiness (`""`/`None` falsy) via {@link pyTruthy}.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';

import { registryPrecedence } from './overlays.js';

// ---------------------------------------------------------------------------
// Python-compatibility helper (copied locally per-module, matching reporter.ts)
// ---------------------------------------------------------------------------

/**
 * Python-truthiness for the values used here: `null`/`undefined`/`""` and an
 * empty array are falsy (mirrors `if x:`).
 */
function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (value === 0 || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

/**
 * Order two strings by Unicode code point, matching Python `sorted()`. JS's
 * default string comparison is by UTF-16 code unit, which mis-orders names
 * containing astral characters (a lead surrogate 0xD800-0xDBFF sorts before
 * BMP chars like U+E000, where Python orders by the true code point). Skill
 * names are realistically ASCII, but this keeps discovery order oracle-faithful.
 */
function codePointCompare(a: string, b: string): number {
  const ca = [...a];
  const cb = [...b];
  const n = Math.min(ca.length, cb.length);
  for (let i = 0; i < n; i++) {
    const d = ca[i]!.codePointAt(0)! - cb[i]!.codePointAt(0)!;
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return ca.length - cb.length;
}

/** Bundled skills live at `<repo>/agents/skills`. Python: `_AGENTS_SKILLS_DIR`. */
function defaultAgentsSkillsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // here = ts/src/core -> repo root is three levels up (Python: parents[2]).
  return resolve(here, '..', '..', '..', 'agents', 'skills');
}

/** A parsed frontmatter block: scalar strings or flow-list values. */
type Frontmatter = Record<string, string | string[]>;

/**
 * A discovered skill (Python: `SkillInfo` dataclass).
 *
 * `cli`/`entry` are populated only when the SKILL.md frontmatter declares them;
 * markdown-only skills leave both `null`.
 */
export class SkillInfo {
  name: string;
  path: string; // the SKILL.md file
  source: string; // "bundled" | "overlay" | "global" | "local"
  description: string;
  cli: string | null;
  entry: string | null;
  // Shapes this skill should be deployed to during `canary migrate`. Empty
  // means the skill is not auto-deployed; ["all"] deploys regardless of shape.
  deploy_to: string[];
  // Runtime tools the skill needs (#336), e.g. ["python3>=3.10", "node>=20"].
  requires: string[];
  // Validation error captured at discovery time; when set the skill is still
  // listed but `canary skills run` refuses to invoke it.
  error: string | null;

  constructor(init: {
    name: string;
    path: string;
    source: string;
    description?: string;
    cli?: string | null;
    entry?: string | null;
    deploy_to?: string[];
    requires?: string[];
    error?: string | null;
  }) {
    this.name = init.name;
    this.path = init.path;
    this.source = init.source;
    this.description = init.description ?? '';
    this.cli = init.cli ?? null;
    this.entry = init.entry ?? null;
    this.deploy_to = init.deploy_to ?? [];
    this.requires = init.requires ?? [];
    this.error = init.error ?? null;
  }

  /** Directory containing SKILL.md - base for relative cli paths (Python: `dir`). */
  get dir(): string {
    return dirname(this.path);
  }

  /** Python: `is_executable`. */
  get isExecutable(): boolean {
    return (this.cli !== null || this.entry !== null) && this.error === null;
  }
}

/**
 * Discover skills from bundled defaults, global home-dir, and local overlays.
 *
 * Precedence (lowest -> highest): bundled, overlay, global, local. See the
 * Python module docstring for the full source-tier description.
 */
export class SkillRegistry {
  private readonly home: string;
  private readonly agentsSkillsDir: string;

  constructor(home?: string, agentsSkillsDir?: string) {
    this.home = home ?? homedir();
    this.agentsSkillsDir = agentsSkillsDir ?? defaultAgentsSkillsDir();
  }

  discover(root?: string): SkillInfo[] {
    const skills = new Map<string, SkillInfo>();

    for (const info of this.bundledSlashSkills()) {
      skills.set(info.name, info);
    }

    for (const info of this.bundledHarnessSkills()) {
      if (!skills.has(info.name)) skills.set(info.name, info); // setdefault
    }

    for (const info of this.overlaySkills()) {
      skills.set(info.name, info); // overlay wins over bundled
    }

    for (const info of this.globalSkills()) {
      skills.set(info.name, info); // global wins over overlay
    }

    const searchRoot = resolve(root ?? process.cwd());
    for (const candidate of SkillRegistry.ancestorsToGitRoot(searchRoot)) {
      for (const info of this.localOverlaySkills(candidate)) {
        skills.set(info.name, info); // local wins over global
      }
    }

    return [...skills.values()].sort((a, b) =>
      codePointCompare(a.name, b.name),
    );
  }

  /** Return the SkillInfo for `name` honoring precedence, or null. */
  find(name: string, root?: string): SkillInfo | null {
    for (const skill of this.discover(root)) {
      if (skill.name === name) return skill;
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Bundled skill sources
  // ------------------------------------------------------------------

  /** Flat `*.md` files in `agents/skills/` - Claude Code slash commands. */
  private bundledSlashSkills(): SkillInfo[] {
    const results: SkillInfo[] = [];
    if (!existsSync(this.agentsSkillsDir)) return results;
    const names = SkillRegistry.listEntries(this.agentsSkillsDir)
      .filter((n) => n.endsWith('.md'))
      .sort();
    for (const name of names) {
      if (name === 'README.md') continue;
      const path = join(this.agentsSkillsDir, name);
      if (!SkillRegistry.isFile(path)) continue;
      const info = this.parseFlat(path, 'bundled');
      if (info) results.push(info);
    }
    return results;
  }

  /** Nested `claude-code/<name>/SKILL.md` - prescriptive harness skills. */
  private bundledHarnessSkills(): SkillInfo[] {
    const results: SkillInfo[] = [];
    const harnessDir = join(this.agentsSkillsDir, 'claude-code');
    if (!existsSync(harnessDir)) return results;
    for (const dirName of SkillRegistry.listEntries(harnessDir).sort()) {
      const path = join(harnessDir, dirName, 'SKILL.md');
      if (existsSync(path)) {
        const info = this.parseNested(path, dirName, 'bundled');
        if (info) results.push(info);
      }
    }
    return results;
  }

  // ------------------------------------------------------------------
  // Global home-dir skills
  // ------------------------------------------------------------------

  /** Skills in `~/.canary/skills/<name>/SKILL.md`. */
  private globalSkills(): SkillInfo[] {
    const results: SkillInfo[] = [];
    const globalDir = join(this.home, '.canary', 'skills');
    if (!SkillRegistry.isDir(globalDir)) return results;
    for (const dirName of SkillRegistry.listDirs(globalDir).sort()) {
      const path = join(globalDir, dirName, 'SKILL.md');
      if (existsSync(path)) {
        const info = this.parseNested(path, dirName, 'global');
        if (info) results.push(info);
      }
    }
    return results;
  }

  // ------------------------------------------------------------------
  // Tracked-overlay skills
  // ------------------------------------------------------------------

  /**
   * Skills from tracked overlays under `~/.canary/overlays/`.
   *
   * Overlays are visited in ascending `(precedence, dir-name)` order and
   * `discover()` lets the last writer win, so the highest-precedence overlay
   * wins a skill-name collision (ties broken by dir-name). `overlays.json` is
   * read read-only for precedence; an absent/malformed registry means every
   * precedence is 0 and the old pure dir-name order applies (#333).
   */
  private overlaySkills(): SkillInfo[] {
    const results: SkillInfo[] = [];
    const overlaysRoot = join(this.home, '.canary', 'overlays');
    if (!SkillRegistry.isDir(overlaysRoot)) return results;
    const precedence = registryPrecedence(this.home);
    const overlayDirs = SkillRegistry.listDirs(overlaysRoot);
    overlayDirs.sort((a, b) => {
      const pa = precedence[a] ?? 0;
      const pb = precedence[b] ?? 0;
      if (pa !== pb) return pa - pb;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    for (const overlayName of overlayDirs) {
      const skillsDir = join(overlaysRoot, overlayName, '.canary', 'skills');
      if (!SkillRegistry.isDir(skillsDir)) continue;
      for (const dirName of SkillRegistry.listDirs(skillsDir).sort()) {
        const path = join(skillsDir, dirName, 'SKILL.md');
        if (existsSync(path)) {
          const info = this.parseNested(path, dirName, 'overlay');
          if (info) results.push(info);
        }
      }
    }
    return results;
  }

  // ------------------------------------------------------------------
  // Local overlay skills
  // ------------------------------------------------------------------

  /** Skills in `<candidate>/.canary/skills/<name>/SKILL.md`. */
  private localOverlaySkills(candidate: string): SkillInfo[] {
    const results: SkillInfo[] = [];
    const overlayDir = join(candidate, '.canary', 'skills');
    if (!existsSync(overlayDir)) return results;
    for (const dirName of SkillRegistry.listDirs(overlayDir).sort()) {
      const path = join(overlayDir, dirName, 'SKILL.md');
      if (existsSync(path)) {
        const info = this.parseNested(path, dirName, 'local');
        if (info) results.push(info);
      }
    }
    return results;
  }

  // ------------------------------------------------------------------
  // Filesystem helpers
  // ------------------------------------------------------------------

  /** Directories from start up to (and including) the git root. */
  private static ancestorsToGitRoot(start: string): string[] {
    const candidates: string[] = [];
    let current = start;
    for (;;) {
      candidates.push(current);
      if (existsSync(join(current, '.git'))) break;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return candidates;
  }

  private static listEntries(path: string): string[] {
    try {
      return readdirSync(path);
    } catch {
      return [];
    }
  }

  private static listDirs(path: string): string[] {
    try {
      return readdirSync(path, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return [];
    }
  }

  private static isDir(path: string): boolean {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  }

  private static isFile(path: string): boolean {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------------
  // Parsers
  // ------------------------------------------------------------------

  private parseFlat(path: string, source: string): SkillInfo | null {
    let text: string;
    try {
      text = readFileSync(path, 'utf-8');
    } catch {
      return null;
    }
    const fm = SkillRegistry.parseFrontmatter(text);
    const stem = basename(path, extname(path));
    const name = pyTruthy(fm['name']) ? (fm['name'] as string) : stem;
    return new SkillInfo({
      name,
      path,
      source,
      description: (SkillRegistry.get(fm, 'description', '') as string) ?? '',
      cli: SkillRegistry.scalar(fm['cli']),
      entry: SkillRegistry.scalar(fm['entry']),
      deploy_to: SkillRegistry.parseDeployTo(fm),
      requires: SkillRegistry.parseStrList(fm, 'requires'),
      error: SkillRegistry.validateExecutableFields(fm),
    });
  }

  private parseNested(
    path: string,
    dirName: string,
    source: string,
  ): SkillInfo | null {
    let text: string;
    try {
      text = readFileSync(path, 'utf-8');
    } catch {
      return null;
    }
    const fm = SkillRegistry.parseFrontmatter(text);
    const name = pyTruthy(fm['name']) ? (fm['name'] as string) : dirName;
    // Python: `fm.get("description") or self._blockquote_tagline(text)`.
    const description = pyTruthy(fm['description'])
      ? (fm['description'] as string)
      : SkillRegistry.blockquoteTagline(text);
    return new SkillInfo({
      name,
      path,
      source,
      description,
      cli: SkillRegistry.scalar(fm['cli']),
      entry: SkillRegistry.scalar(fm['entry']),
      deploy_to: SkillRegistry.parseDeployTo(fm),
      requires: SkillRegistry.parseStrList(fm, 'requires'),
      error: SkillRegistry.validateExecutableFields(fm),
    });
  }

  /** Python `dict.get(key, default)`: default only on a missing key. */
  private static get(
    fm: Frontmatter,
    key: string,
    fallback: string | string[],
  ): string | string[] {
    return Object.prototype.hasOwnProperty.call(fm, key) ? fm[key]! : fallback;
  }

  /** A scalar frontmatter value as `string | null` (Python: `fm.get(key)`). */
  private static scalar(value: string | string[] | undefined): string | null {
    return typeof value === 'string' ? value : null;
  }

  static parseDeployTo(fm: Frontmatter): string[] {
    return SkillRegistry.parseStrList(fm, 'deploy_to');
  }

  /**
   * Normalize a frontmatter field to `string[]`, accepting either a flow list
   * (`[a, b]`) or a bare scalar (`a`). Python: `_parse_str_list`.
   */
  static parseStrList(fm: Frontmatter, key: string): string[] {
    const raw = Object.prototype.hasOwnProperty.call(fm, key) ? fm[key] : [];
    if (Array.isArray(raw)) {
      return raw.map((v) => String(v).trim()).filter((v) => v);
    }
    if (typeof raw === 'string' && raw) return [raw.trim()];
    return [];
  }

  /**
   * Tiny YAML-subset parser: top-level scalar and flow-list fields between `---`
   * delimiters. No nesting, no block sequences, no quoting. Python:
   * `_parse_frontmatter`.
   */
  static parseFrontmatter(text: string): Frontmatter {
    const result: Frontmatter = {};
    if (!text.startsWith('---')) return result;
    const lines = text.split('\n');
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim() === '---') break;
      if (!line || line.replace(/^\s+/, '').startsWith('#')) continue;
      if (!line.includes(':')) continue;
      const idx = line.indexOf(':'); // Python str.partition -> first colon.
      const key = line.slice(0, idx);
      const value = line.slice(idx + 1);
      const v = value.trim();
      if (v.startsWith('[') && v.endsWith(']')) {
        const inner = v.slice(1, -1);
        result[key.trim()] = inner
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item);
      } else {
        result[key.trim()] = v;
      }
    }
    return result;
  }

  /** Return an error string if the cli/entry combination is invalid. */
  static validateExecutableFields(fm: Frontmatter): string | null {
    const cli = fm['cli'];
    const entry = fm['entry'];
    // INTENTIONAL DIVERGENCE from the oracle: Python stores a list-valued
    // `cli:`/`entry:` as-is (marking the skill executable), then crashes with a
    // TypeError in resolve_cli_path (`skill_dir / [...]`). Reject the malformed
    // shape loudly here instead — a non-executable skill with a clear diagnostic
    // beats both a runtime crash and the silent markdown-only downgrade the
    // scalar() coercion would otherwise produce. Pinned by a regression test.
    if (Array.isArray(cli) || Array.isArray(entry)) {
      return 'cli:/entry: must be a scalar path, not a list';
    }
    if (pyTruthy(cli) && pyTruthy(entry)) {
      return 'skill declares both cli: and entry: \u{2014} they are mutually exclusive';
    }
    return null;
  }

  /** Extract the first blockquote block as a one-line description. */
  static blockquoteTagline(text: string): string {
    const quoteLines: string[] = [];
    for (const line of text.split('\n')) {
      const stripped = line.replace(/^\s+/, '');
      if (stripped.startsWith('> ')) {
        quoteLines.push(stripped.slice(2).trim());
      } else if (quoteLines.length) {
        break;
      }
    }
    return quoteLines.join(' ');
  }
}

/**
 * Resolve `skill.cli` to an absolute path inside the skill directory.
 *
 * Throws (Python `ValueError`) if the skill has no `cli:` field, the path
 * escapes the skill dir after symlink resolution, or the target doesn't exist.
 */
export function resolveCliPath(skill: SkillInfo): string {
  if (!pyTruthy(skill.cli)) {
    throw new Error(`skill '${skill.name}' has no cli: field`);
  }
  const skillDir = realpathSync(skill.dir);
  const joined = resolve(skillDir, skill.cli as string);
  // Python's non-strict `resolve()` never raises on a missing path; realpathSync
  // does, so only resolve symlinks when the candidate exists (which is what
  // catches a symlink that escapes the skill dir).
  const candidate = existsSync(joined) ? realpathSync(joined) : joined;
  const rel = relative(skillDir, candidate);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      `skill '${skill.name}' cli path escapes the skill directory: ` +
        `'${skill.cli}'`,
    );
  }
  if (!existsSync(candidate)) {
    throw new Error(
      `skill '${skill.name}' cli target does not exist: '${skill.cli}'`,
    );
  }
  return candidate;
}

/**
 * Whether to honor cli:/entry: invocation in the current context.
 *
 * In non-interactive contexts (no TTY, or `CI=true`) executable skills require
 * an explicit opt-in via `allowFlag` to prevent a freshly cloned malicious
 * overlay from silently executing code on the next CI run. Interactive contexts
 * allow execution by default. Python: `is_executable_skill_allowed`.
 */
export function isExecutableSkillAllowed(allowFlag: boolean): boolean {
  if (allowFlag) return true;
  const ci = (process.env.CI ?? '').toLowerCase();
  if (['1', 'true', 'yes'].includes(ci)) return false;
  if (!process.stdin.isTTY) return false;
  return true;
}
