/**
 * Workspace ("monorepo") topology detection and per-package framework findings
 * (#504 part 1).
 *
 * Split from `migrator.ts` so detection can probe each declared package without
 * the migrator in the import path. The chain is strictly leafward:
 * `migrator -> workspace-detect -> framework-probes -> fs-glob`.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import {
  CONFIG_PROBES,
  inferPlaywrightTestType,
  probeFramework,
  ProbeResult,
} from './framework-probes.js';
import {
  comparePathParts,
  globDirs,
  isFile,
  parseJsonOrNull,
  readTextOrNull,
} from './fs-glob.js';

/** A framework detected in one workspace package. */
export interface WorkspaceFinding {
  /** Package directory, relative to the repo root, POSIX-separated. */
  dir: string;
  framework: string;
  shape: string;
  /** The evidence that identified it (e.g. `playwright.config.ts`). */
  source: string;
  confidence: string;
}

/** Declared workspace topology plus what probing each package found. */
export interface WorkspaceInfo {
  /** The workspace file's owner: `pnpm`, `npm`, or `yarn`. */
  manager: string;
  /** The declared package globs, deduplicated across every readable source. */
  globs: string[];
  /**
   * How many package directories the globs actually matched.
   *
   * The denominator. Without it, "no findings" is indistinguishable from "never
   * looked" -- a zero-denominator pass wearing the costume of a clean result.
   */
  scanned: number;
  findings: WorkspaceFinding[];
  /** Matched directories that could not be listed, relative and POSIX. */
  unreadable: string[];
}

/**
 * Workspace package globs declared at *root*, from pnpm-workspace.yaml or
 * package.json `workspaces` (array or `{packages: []}` form). Returns [] for a
 * single-package repo, which is what keeps non-monorepos on the old path.
 *
 * turbo.json is intentionally NOT read: Turborepo declares tasks, not package
 * locations -- it defers to the pnpm/npm workspace file we already read, so
 * parsing it would add a source of truth without adding any packages.
 */
export function workspaceGlobs(root: string): string[] {
  const yaml = readTextOrNull(join(root, 'pnpm-workspace.yaml'));
  return [
    ...new Set([
      ...(yaml === null ? [] : parsePnpmPackages(yaml)),
      ...packageJsonWorkspaceGlobs(root),
    ]),
  ];
}

/**
 * The `workspaces` globs in a package.json. Accepts both the array form
 * (`["apps/*"]`) and the object form (`{packages: ["apps/*"]}`) that yarn
 * writes; anything else yields [].
 */
function packageJsonWorkspaceGlobs(root: string): string[] {
  const list = packageJsonWorkspacesValue(root);
  if (!Array.isArray(list)) return [];
  return list.filter((e): e is string => typeof e === 'string' && e !== '');
}

/** The raw `workspaces` list from package.json, unfiltered, or undefined. */
function packageJsonWorkspacesValue(root: string): unknown {
  const pkg = parseJsonOrNull(
    readTextOrNull(join(root, 'package.json')),
  ) as Record<string, unknown> | null;
  if (
    pkg === null ||
    !Object.prototype.hasOwnProperty.call(pkg, 'workspaces')
  ) {
    return undefined;
  }
  const ws = pkg['workspaces'] as Record<string, unknown> | unknown[] | null;
  return Array.isArray(ws) ? ws : (ws?.['packages'] as unknown);
}

/**
 * Pull the `packages:` sequence out of a pnpm-workspace.yaml.
 *
 * A hand-rolled reader rather than a YAML dependency: the shape it must handle
 * is a single top-level key holding a flat list of quoted strings, and the
 * migrator has no other reason to take on a parser. A file it cannot read
 * yields [] -- the repo is then treated as single-package, which is the
 * pre-existing behavior, so a parse miss can never *invent* a suite.
 */
function parsePnpmPackages(yaml: string): string[] {
  const out: string[] = [];
  let inPackages = false;
  for (const rawLine of yaml.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '');
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const item = /^\s+-\s*(.+?)\s*$/.exec(line);
    if (item) {
      out.push(item[1]!.replace(/^["']|["']$/g, ''));
      continue;
    }
    // A non-indented, non-empty line ends the sequence.
    if (line.trim() !== '' && !/^\s/.test(line)) inPackages = false;
  }
  return out.filter((p) => p !== '');
}

/**
 * Warnings for workspace files that exist but yielded nothing.
 *
 * A non-empty pnpm-workspace.yaml that parses to zero packages is the
 * unparseable signal. It is reported rather than swallowed, and it never
 * discards globs from a second, readable source: `workspaceGlobs` unions every
 * source, so a broken yaml beside a valid package.json still yields that
 * package.json's globs (#504 part 1, criterion 5).
 */
function workspaceFileWarnings(root: string): string[] {
  const yaml = readTextOrNull(join(root, 'pnpm-workspace.yaml'));
  if (yaml === null || yaml.trim() === '') return [];
  if (parsePnpmPackages(yaml).length > 0) return [];
  return [
    'pnpm-workspace.yaml could not be parsed for a `packages:` list; ' +
      'workspace packages declared there were not scanned.',
  ];
}

/**
 * Whether *root* declares a workspace at all.
 *
 * Deliberately stricter than "package.json exists": nearly every JS repo has a
 * package.json, so keying off the file would route every single-package repo
 * down the workspace path and break the byte-identical guarantee. A workspace is
 * declared only by a pnpm-workspace.yaml or an explicit `workspaces` key.
 */
function workspaceDeclared(root: string): boolean {
  if (existsSync(join(root, 'pnpm-workspace.yaml'))) return true;
  return packageJsonWorkspacesValue(root) !== undefined;
}

/** Which tool owns the workspace declaration. */
function workspaceManager(root: string): string {
  if (existsSync(join(root, 'pnpm-workspace.yaml'))) return 'pnpm';
  // The object form (`{packages: [...]}`) is yarn's; the bare array is npm's.
  const pkg = parseJsonOrNull(
    readTextOrNull(join(root, 'package.json')),
  ) as Record<string, unknown> | null;
  const ws = pkg?.['workspaces'];
  return Array.isArray(ws) ? 'npm' : 'yarn';
}

/** Package directories matched by *globs*, deduplicated and path-sorted. */
function matchedPackageDirs(root: string, globs: string[]): string[] {
  const seen = new Set<string>();
  for (const glob of globs) {
    for (const dir of globDirs(root, glob)) seen.add(dir);
  }
  return [...seen].sort((a, b) =>
    comparePathParts(toPosixRel(root, a), toPosixRel(root, b)),
  );
}

function toPosixRel(root: string, dir: string): string {
  return relative(root, dir).split(sep).join('/');
}

/**
 * Every framework *dir* declares via a config file, as findings under *rel*.
 *
 * A package may carry both playwright.config.ts and vitest.config.ts. Since
 * `shapes` is a union that drives skill and workflow deployment,
 * first-match-wins would silently drop a shape whose skills should have
 * deployed -- so `dir` is NOT unique across findings, and findings.length may
 * exceed `scanned`.
 */
function configFindings(dir: string, rel: string): WorkspaceFinding[] {
  const out: WorkspaceFinding[] = [];
  const seen = new Set<string>();
  for (const [filename, framework, shape, confidence] of CONFIG_PROBES) {
    if (!isFile(join(dir, filename))) continue;
    // Mirrors the config tier's own refinement: a playwright config with no
    // UI-fixture spec is an API suite, and the shape decides which skills ship.
    const refined =
      framework === 'playwright' && shape === 'e2e_ui'
        ? inferPlaywrightTestType(dir)
        : shape;
    // NUL separates the parts because it cannot occur in a path, a framework
    // name, or a shape -- so `a\0b` can never collide with `a` + `\0b`. Written
    // as an escape, never as a literal byte: a raw NUL inside a file's first
    // 8 KB makes git classify it as binary, which is how this module first
    // landed with no reviewable diff at all.
    const key = `${rel}\0${framework}\0${refined}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      dir: rel,
      framework,
      shape: refined,
      source: filename,
      confidence: refined === shape ? confidence : 'content',
    });
  }
  return out;
}

/**
 * Findings for one package: every config-tier match, or -- only when the config
 * tier found nothing at all -- a single content-tier answer.
 *
 * The language tier is deliberately withheld; see `probeFramework` for why
 * inheriting a root `language:` per package would invent findings (#504 part 1,
 * spec test 8).
 */
function probePackage(
  dir: string,
  config: Record<string, unknown>,
  rel: string,
): WorkspaceFinding[] {
  const fromConfig = configFindings(dir, rel);
  if (fromConfig.length > 0) return fromConfig;
  const [framework, shape, source, confidence]: ProbeResult = probeFramework(
    dir,
    config,
    ['content'],
  );
  return framework === null
    ? []
    : [{ dir: rel, framework, shape, source, confidence }];
}

/**
 * Workspace topology and per-package findings, or `null` when no workspace
 * file is declared.
 *
 * That `null` is the back-compatibility guarantee: a single-package repo never
 * enters this path, so its report is byte-identical to the pre-change output
 * (#504 part 1, criterion 4).
 */
export function detectWorkspace(
  root: string,
  config: Record<string, unknown>,
  warnings?: string[],
): WorkspaceInfo | null {
  if (!workspaceDeclared(root)) return null;

  const globs = workspaceGlobs(root);
  if (warnings !== undefined) {
    for (const w of workspaceFileWarnings(root)) warnings.push(w);
  }
  const dirs = matchedPackageDirs(root, globs);
  const findings: WorkspaceFinding[] = [];
  const unreadable: string[] = [];

  for (const dir of dirs) {
    const rel = toPosixRel(root, dir);
    try {
      readdirSync(dir);
    } catch {
      unreadable.push(rel);
      continue;
    }
    for (const f of probePackage(dir, config, rel)) findings.push(f);
  }

  return {
    manager: workspaceManager(root),
    globs,
    scanned: dirs.length,
    findings,
    unreadable,
  };
}
