'use strict';

/**
 * Built-in `canary doctor` engine checks (Phase 2, tier 1). Each returns a
 * {@link CheckResult}; none throws. Network is injectable and offline-tolerant.
 */

import * as fs from 'node:fs';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CheckResult } from './doctor.js';
import {
  freshness,
  workingTreeStatus,
  type GitRunner,
  type GitResult,
} from './overlay-commands.js';
import * as registry from './overlays-registry.js';
import { detectSkillConflicts } from './overlay-conflicts.js';
import {
  parseRequiresField,
  parseRequirement,
  checkRequirement,
  type CommandProbe,
} from './skill-requirements.js';

/** The published npm package name (mirrors the install remedy in the shim). */
const PKG = 'canary-test-cli';
const DEFAULT_TIMEOUT_MS = 5000;

export interface EngineCheckDeps {
  git?: GitRunner;
  homeDir?: string;
  /** Project directory scanned for `.canary/` config and `.mcp.json`. */
  cwd?: string;
  /** Current CLI version; defaults to reading the package's own package.json. */
  currentVersion?: string;
  /** Latest published version, or null when unknown/offline. Injectable. */
  getLatestVersion?: () => Promise<string | null>;
  timeoutMs?: number;
  /** Probe a command's presence + version (#336). Injectable for tests. */
  skillProbe?: CommandProbe;
}

const realGit: GitRunner = (args, opts = {}) => {
  const { spawnSync } =
    require('node:child_process') as typeof import('node:child_process');
  const r = spawnSync('git', args, { cwd: opts.cwd, encoding: 'utf8' });
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    return {
      status: code === 'ENOENT' ? 127 : 1,
      stdout: '',
      stderr: String(r.error.message),
    };
  }
  return {
    status: r.status ?? 1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  } as GitResult;
};

/** Read this package's own version from its package.json (best effort). */
function ownVersion(): string | null {
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    return (
      (JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string })
        .version ?? null
    );
  } catch {
    return null;
  }
}

/** String `version` from a registry body; null on parse error or non-string shape (SEC-DES-001: registry JSON is untrusted). */
export function parseRegistryVersion(rawBody: string): string | null {
  try {
    const v = (JSON.parse(rawBody) as { version?: unknown } | null)?.version;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

/** GET the latest published version from the npm registry. null on any error. */
function fetchLatestVersion(timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const req = https.get(`https://registry.npmjs.org/${PKG}/latest`, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(parseRegistryVersion(body)));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => req.destroy());
  });
}

/** True when semver `a` is strictly older than `b` (numeric compare, no prerelease). */
export function isOlder(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10));
  const pb = b.split('.').map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) {
      return x < y;
    }
  }
  return false;
}

/** CLI version vs latest release. Offline degrades to info, never a failure. */
export async function checkVersion(
  deps: EngineCheckDeps = {},
): Promise<CheckResult> {
  const current = deps.currentVersion ?? ownVersion();
  if (!current) {
    return {
      id: 'engine:version',
      status: 'info',
      label: 'CLI version: unknown',
    };
  }
  const getLatest =
    deps.getLatestVersion ??
    (() => fetchLatestVersion(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const latest = await getLatest();
  if (!latest) {
    return {
      id: 'engine:version',
      status: 'info',
      label: `CLI ${current} (could not check latest — offline?)`,
    };
  }
  if (isOlder(current, latest)) {
    return {
      id: 'engine:version',
      status: 'fail',
      label: `CLI ${current} is behind latest ${latest}`,
      remedy: `Upgrade: npm install -g ${PKG}@latest`,
    };
  }
  return {
    id: 'engine:version',
    status: 'pass',
    label: `CLI ${current} (latest)`,
  };
}

/** git present on PATH. */
export function checkGit(deps: EngineCheckDeps = {}): CheckResult {
  const git = deps.git ?? realGit;
  const res = git(['--version']);
  if (res.status === 0) {
    return {
      id: 'engine:git',
      status: 'pass',
      label: `git present (${res.stdout.trim() || 'ok'})`,
    };
  }
  return {
    id: 'engine:git',
    status: 'fail',
    label: 'git not found on PATH',
    remedy:
      'Install git and ensure it is on your PATH — overlay add/update need it.',
  };
}

/** Registered overlays present, fresh, and free of local modifications. */
export function checkOverlays(deps: EngineCheckDeps = {}): CheckResult[] {
  const git = deps.git ?? realGit;
  const homeDir = deps.homeDir ?? os.homedir();
  let reg;
  try {
    reg = registry.read(homeDir);
  } catch (e) {
    return [
      {
        id: 'engine:overlays',
        status: 'fail',
        label: 'overlays registry unreadable',
        remedy: (e as Error).message,
      },
    ];
  }
  if (reg.overlays.length === 0) {
    return [
      {
        id: 'engine:overlays',
        status: 'info',
        label: 'no overlays registered',
      },
    ];
  }
  const results: CheckResult[] = [];
  for (const o of reg.overlays) {
    const fresh = freshness(o.path, o, git);
    if (fresh.startsWith('missing')) {
      results.push({
        id: `overlay:${o.name}:present`,
        status: 'fail',
        label: `overlay "${o.name}": clone missing`,
        remedy: `Re-add it: canary overlay remove ${o.name} (if needed) then canary overlay add ${o.source}`,
      });
      continue;
    }
    if (fresh.includes('behind')) {
      results.push({
        id: `overlay:${o.name}:fresh`,
        status: 'fail',
        label: `overlay "${o.name}": ${fresh}`,
        remedy: `Update it: canary overlay update ${o.name}`,
      });
    } else {
      results.push({
        id: `overlay:${o.name}:fresh`,
        status: 'pass',
        label: `overlay "${o.name}": ${fresh}`,
      });
    }
    const clean = workingTreeStatus(o.path, git);
    if (clean === 'clean') {
      results.push({
        id: `overlay:${o.name}:clean`,
        status: 'pass',
        label: `overlay "${o.name}": no local changes`,
      });
    } else {
      results.push({
        id: `overlay:${o.name}:clean`,
        status: 'fail',
        label: `overlay "${o.name}": ${clean === 'dirty' ? 'local modifications' : 'git status unreadable'}`,
        remedy: `Commit/stash changes in ${o.path}, or canary overlay remove ${o.name} and re-add.`,
      });
    }
  }
  return results;
}

/** Parse a JSON file; returns an error message or null when it parses (or is absent). */
function parseErrorOrNull(file: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT'
      ? null
      : (e as Error).message;
  }
  try {
    JSON.parse(raw);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** Project `.canary/` config files parse as JSON. */
export function checkProjectConfig(deps: EngineCheckDeps = {}): CheckResult {
  const cwd = deps.cwd ?? process.cwd();
  const dir = path.join(cwd, '.canary');
  let names: string[];
  try {
    names = fs
      .readdirSync(dir)
      .filter((n) => /^company(\.[\w-]+)?\.json$/.test(n));
  } catch {
    return {
      id: 'engine:project-config',
      status: 'skip',
      label: 'no project .canary/ config',
    };
  }
  if (names.length === 0) {
    return {
      id: 'engine:project-config',
      status: 'skip',
      label: 'no project .canary/ config',
    };
  }
  for (const name of names) {
    const err = parseErrorOrNull(path.join(dir, name));
    if (err) {
      return {
        id: 'engine:project-config',
        status: 'fail',
        label: `project .canary/${name} does not parse`,
        remedy: `Fix the JSON in .canary/${name}: ${err}`,
      };
    }
  }
  return {
    id: 'engine:project-config',
    status: 'pass',
    label: `project .canary/ config parses (${names.length} file(s))`,
  };
}

/** Assert a single `.mcp.json` parses and each server entry is well-formed. */
function inspectMcpFile(file: string): { present: boolean; error?: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { present: false };
    }
    return { present: true, error: (e as Error).message };
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return { present: true, error: `does not parse: ${(e as Error).message}` };
  }
  const servers = (data as { mcpServers?: Record<string, unknown> }).mcpServers;
  if (servers === undefined) {
    return { present: true };
  }
  if (typeof servers !== 'object' || servers === null) {
    return { present: true, error: 'mcpServers is not an object' };
  }
  for (const [key, entry] of Object.entries(servers)) {
    const e = entry as { command?: unknown; url?: unknown };
    if (typeof e.command !== 'string' && typeof e.url !== 'string') {
      return {
        present: true,
        error: `server "${key}" has neither a command nor a url`,
      };
    }
  }
  return { present: true };
}

/** MCP config references resolvable — read project and home `.mcp.json` directly. */
export function checkMcpConfig(deps: EngineCheckDeps = {}): CheckResult {
  const cwd = deps.cwd ?? process.cwd();
  const homeDir = deps.homeDir ?? os.homedir();
  const files = [path.join(cwd, '.mcp.json'), path.join(homeDir, '.mcp.json')];
  let anyPresent = false;
  for (const file of files) {
    const r = inspectMcpFile(file);
    anyPresent = anyPresent || r.present;
    if (r.error) {
      return {
        id: 'engine:mcp',
        status: 'fail',
        label: `MCP config ${file} is invalid`,
        remedy: `Fix ${file}: ${r.error}`,
      };
    }
  }
  if (!anyPresent) {
    return { id: 'engine:mcp', status: 'skip', label: 'no .mcp.json found' };
  }
  return { id: 'engine:mcp', status: 'pass', label: 'MCP config resolves' };
}

/**
 * Skill-name collisions across registered overlays are resolved by a declared
 * precedence (#333). A collision with no precedence winner is a `fail` — which
 * definition wins is otherwise accidental (directory-name order). No overlays
 * or no collisions → an informational/passing line, never a false alarm.
 */
export function checkOverlayConflicts(deps: EngineCheckDeps = {}): CheckResult {
  const homeDir = deps.homeDir ?? os.homedir();
  let reg;
  try {
    reg = registry.read(homeDir);
  } catch {
    // The dedicated engine:overlays check already reports an unreadable
    // registry; don't double-fail here.
    return {
      id: 'engine:overlay-conflicts',
      status: 'skip',
      label: 'overlay skill conflicts: registry unreadable',
    };
  }
  const conflicts = detectSkillConflicts(reg);
  const unresolved = conflicts.filter((c) => !c.resolved);
  if (unresolved.length > 0) {
    const names = unresolved.map((c) => c.skill).join(', ');
    return {
      id: 'engine:overlay-conflicts',
      status: 'fail',
      label: `overlay skill conflicts unresolved: ${names}`,
      remedy:
        'Two overlays ship these skill name(s) with equal precedence — the ' +
        'winner is accidental. Set a higher `precedence` on the overlay you ' +
        'want to win in ~/.canary/overlays.json, or run ' +
        '`canary overlay list --conflicts` for details.',
    };
  }
  if (conflicts.length > 0) {
    return {
      id: 'engine:overlay-conflicts',
      status: 'pass',
      label: `overlay skill conflicts: ${conflicts.length} resolved by precedence`,
    };
  }
  return {
    id: 'engine:overlay-conflicts',
    status: 'pass',
    label: 'no overlay skill conflicts',
  };
}

/** Real command probe (#336): `<cmd> --version`, extract the first x.y[.z]. */
const realProbe: CommandProbe = (command) => {
  const { spawnSync } =
    require('node:child_process') as typeof import('node:child_process');
  const r = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    timeout: DEFAULT_TIMEOUT_MS,
  });
  // ENOENT (not on PATH) sets r.error; a non-zero exit does not — the command
  // exists, it just may not print a parseable version.
  if (r.error) return { present: false, version: null };
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const m = out.match(/(\d+\.\d+(?:\.\d+)?)/);
  return { present: true, version: m ? m[1] : null };
};

/** One installed skill that declares runtime requirements. */
interface SkillRequires {
  name: string;
  /** Where it came from, for the failure line: `overlay:<n>`, `global`, `local`. */
  source: string;
  requires: string[];
}

/** SKILL.md paths + source labels for skills installed in a consuming repo. */
function skillMdRoots(homeDir: string, cwd: string): Array<[string, string]> {
  const roots: Array<[string, string]> = [];
  const overlays = path.join(homeDir, '.canary', 'overlays');
  for (const ov of safeDirs(overlays)) {
    roots.push([path.join(overlays, ov, '.canary', 'skills'), `overlay:${ov}`]);
  }
  roots.push([path.join(homeDir, '.canary', 'skills'), 'global']);
  roots.push([path.join(cwd, '.canary', 'skills'), 'local']);
  return roots;
}

/** Directory entries (names) under `dir`, or [] when it is absent/unreadable. */
function safeDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/** Collect `requires` declarations from every skill installed in this repo. */
function scanSkillRequirements(homeDir: string, cwd: string): SkillRequires[] {
  const found: SkillRequires[] = [];
  for (const [skillsDir, source] of skillMdRoots(homeDir, cwd)) {
    for (const name of safeDirs(skillsDir)) {
      const md = path.join(skillsDir, name, 'SKILL.md');
      let text: string;
      try {
        text = fs.readFileSync(md, 'utf8');
      } catch {
        continue;
      }
      const requires = parseRequiresField(text);
      if (requires.length > 0) found.push({ name, source, requires });
    }
  }
  return found;
}

/**
 * Verify the runtime requirements declared by installed skills (#336). Reads
 * `requires:` from each overlay/global/local skill's SKILL.md and checks every
 * declared command (and optional version) against the environment. A missing
 * or too-old requirement is a `fail` naming the skill and command; a bare
 * presence check that passes, or a token whose version cannot be read, never
 * fails. No declarations at all → an informational line (not a false "all
 * good"). Bundled skills ship inside the engine and are out of scope here.
 */
export function checkSkillRequirements(
  deps: EngineCheckDeps = {},
): CheckResult {
  const homeDir = deps.homeDir ?? os.homedir();
  const cwd = deps.cwd ?? process.cwd();
  const probe = deps.skillProbe ?? realProbe;

  const skills = scanSkillRequirements(homeDir, cwd);
  if (skills.length === 0) {
    return {
      id: 'engine:skill-requirements',
      status: 'info',
      label: 'no installed skill declares runtime requirements',
    };
  }

  const failures: string[] = [];
  let checked = 0;
  for (const skill of skills) {
    for (const token of skill.requires) {
      checked += 1;
      const r = checkRequirement(parseRequirement(token), probe);
      if (r.status === 'missing' || r.status === 'too-old') {
        failures.push(
          `${skill.source}/${skill.name} needs ${token}: ${r.detail}`,
        );
      }
    }
  }

  if (failures.length > 0) {
    return {
      id: 'engine:skill-requirements',
      status: 'fail',
      label: `skill runtime requirements unmet: ${failures.length} of ${checked}`,
      remedy: `Install/upgrade the missing tools — ${failures.join('; ')}`,
    };
  }
  return {
    id: 'engine:skill-requirements',
    status: 'pass',
    label: `skill runtime requirements: ${checked} satisfied across ${skills.length} skill(s)`,
  };
}

/** Run every engine check, in display order. */
export async function runEngineChecks(
  deps: EngineCheckDeps = {},
): Promise<CheckResult[]> {
  return [
    await checkVersion(deps),
    checkGit(deps),
    ...checkOverlays(deps),
    checkOverlayConflicts(deps),
    checkSkillRequirements(deps),
    checkProjectConfig(deps),
    checkMcpConfig(deps),
  ];
}
