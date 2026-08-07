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

import { probe, ProbeResult } from './framework-probes.js';
import {
  comparePathParts,
  globDirs,
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
export function parsePnpmPackages(yaml: string): string[] {
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
): WorkspaceInfo | null {
  if (!workspaceDeclared(root)) return null;

  const globs = workspaceGlobs(root);
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
    // The language tier is deliberately withheld -- see `probe`.
    const [framework, shape, source, confidence]: ProbeResult = probe(
      dir,
      config,
      ['config', 'content'],
    );
    if (framework !== null) {
      findings.push({ dir: rel, framework, shape, source, confidence });
    }
  }

  return {
    manager: workspaceManager(root),
    globs,
    scanned: dirs.length,
    findings,
    unreadable,
  };
}
