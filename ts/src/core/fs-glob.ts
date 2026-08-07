/**
 * Filesystem and glob helpers shared by the migrator, the framework probes,
 * and workspace detection.
 *
 * A leaf module by design: it imports nothing from `core/`, which is what lets
 * `framework-probes` use `globFiles` without cycling back through `migrator`
 * (#504 part 1). The glob subset mirrors `Path.glob` -- `**` matches zero or
 * more directories, `*` matches within one segment.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Compile a single glob segment (with `*` -> `[^/]*`) to an anchored regex. */
export function segGlobRegex(seg: string): RegExp {
  const body = seg
    .replace(/[.+^${}()|[\]\\?]/g, '\\$&')
    .replace(/\*/g, '[^/]*');
  return new RegExp(`^${body}$`);
}

/**
 * Match files under *root* against a pathlib-style glob (`**` matches zero or
 * more directories; `*` matches within a single segment). Mirrors the subset of
 * `Path.glob` the migrator needs.
 */
export function globFiles(root: string, pattern: string): string[] {
  const segments = pattern.split('/');
  const out: string[] = [];
  const visit = (dir: string, si: number): void => {
    const seg = segments[si]!;
    const last = si === segments.length - 1;
    if (seg === '**') {
      // `**` consumes zero directories -> continue at the same dir.
      visit(dir, si + 1);
      // `**` consumes one-or-more -> descend into each subdir, staying on `**`.
      for (const d of subDirs(dir)) visit(d, si);
      return;
    }
    const re = segGlobRegex(seg);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!re.test(e.name)) continue;
      const full = join(dir, e.name);
      if (last) {
        if (e.isFile() || isFile(full)) out.push(full);
      } else if (e.isDirectory()) {
        visit(full, si + 1);
      }
    }
  };
  visit(root, 0);
  return out;
}

export function subDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

/**
 * Directories a workspace glob must never descend into or return.
 *
 * `node_modules` matters twice over: a dependency ships its own
 * `playwright.config.ts`, which would be mistaken for this repo's suite and
 * silently suppress a scaffold the user needs -- and a `**` glob over a real
 * monorepo would otherwise walk every installed package on disk.
 */
export const _WORKSPACE_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.venv',
  'venv',
  'dist',
  'build',
  '.next',
  '.turbo',
  'coverage',
  '__pycache__',
]);

/**
 * Match *directories* under *root* against a workspace glob (`apps/*`).
 *
 * Deliberately a separate walk from `globFiles` rather than a shared one
 * parameterised by file-vs-directory: folding the two together forced a `kind`
 * branch through every step and pushed both the walker and its filter to
 * cyclomatic complexity 14 (threshold 10) to save 7 lines. Two short, honest
 * walks beat one clever one.
 */
export function globDirs(root: string, pattern: string): string[] {
  const segments = pattern.split('/').filter((s) => s !== '');
  const out: string[] = [];
  const walkable = (dir: string): string[] =>
    subDirs(dir).filter((d) => !_WORKSPACE_SKIP_DIRS.has(basename(d)));
  const visit = (dir: string, si: number): void => {
    if (si === segments.length) {
      if (dir !== root) out.push(dir);
      return;
    }
    const seg = segments[si]!;
    if (seg === '**') {
      visit(dir, si + 1);
      for (const d of walkable(dir)) visit(d, si);
      return;
    }
    const re = segGlobRegex(seg);
    for (const d of walkable(dir)) {
      if (re.test(basename(d))) visit(d, si + 1);
    }
  };
  visit(root, 0);
  return out;
}

export function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

/** Parse *text* as JSON, or null if it is absent or malformed. */
export function parseJsonOrNull(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
