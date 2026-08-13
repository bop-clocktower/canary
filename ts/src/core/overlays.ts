/**
 * Resolve tracked overlays for `canary migrate --from`.
 *
 * Faithful TypeScript port of `agent/core/overlays.py`. Tracked overlays are git
 * clones under `~/.canary/overlays/<name>/` created by `canary overlay add`.
 * This module maps a `--from` value to a clone path.
 *
 * Cross-runtime contract (matches the Phase 1 skill loader): the clone
 * **directories** are the source of truth. `overlays.json` is written solely by
 * the TS side and is read here **only** to order overlay names when it parses —
 * its absence or corruption never blocks resolution (a directory scan is the
 * fallback).
 *
 * Disambiguation: a value containing a path separator (`./o`, `../o`, `/abs/o`)
 * is a **path**; a bare token (`example-org-example-overlay`) is an overlay
 * **name**. A bare token is never treated as a path, so a same-named directory
 * in the current working directory cannot shadow a tracked overlay, and a
 * mistyped name fails loudly instead of silently resolving to a stray path.
 *
 * Python→TS nuances:
 *   - `Path.resolve()` (absolute + symlink resolution + normalize) maps to
 *     `fs.realpathSync`, so a macOS `/var` → `/private/var` symlink resolves the
 *     same on both sides.
 *   - Python's `OverlayNotFound.name` attribute (the overlay name) is exposed as
 *     {@link OverlayNotFound.overlayName} — `Error.name` is reserved for the
 *     class name in JS.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';

/** A `--from` value did not resolve to an overlay (bad name or missing path). */
export class OverlayNotFound extends Error {
  overlayName: string;
  available: string[];

  constructor(name: string, available: string[]) {
    const hint = available.length
      ? 'tracked overlays: ' + available.join(', ')
      : 'no overlays are tracked — add one with `canary overlay add <source>`';
    super(`could not resolve overlay '${name}' (${hint})`);
    this.name = 'OverlayNotFound';
    this.overlayName = name;
    this.available = available;
  }
}

/**
 * Directory holding overlay clones: `<home>/.canary/overlays`.
 *
 * Exported so a sibling that reads per-overlay config files (see
 * `persona.ts`) locates them through this one definition rather than
 * re-deriving the path and drifting from it.
 */
export function overlaysRoot(home?: string): string {
  return join(home ?? homedir(), '.canary', 'overlays');
}

/** Overlay names in `overlays.json` order, or `[]` when it is unreadable. */
function registryOrder(home: string): string[] {
  const registry = join(home, '.canary', 'overlays.json');
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(registry, 'utf-8'));
  } catch {
    return [];
  }
  if (!isRecord(data)) return [];
  const overlays = data['overlays'];
  if (!Array.isArray(overlays)) return [];
  const names: string[] = [];
  for (const o of overlays) {
    if (isRecord(o) && typeof o['name'] === 'string') {
      names.push(o['name']);
    }
  }
  return names;
}

/**
 * Map overlay name -> declared precedence from `overlays.json` (#333).
 *
 * A null/absent/non-numeric precedence is 0. An unreadable or malformed registry
 * yields an empty map, so callers fall back to directory-name order. Higher
 * precedence wins a skill-name collision — the winner rule mirrors the TS side
 * (`npm/src/overlay-conflicts.ts`) so both runtimes agree.
 */
export function registryPrecedence(home?: string): Record<string, number> {
  const h = home ?? homedir();
  const registry = join(h, '.canary', 'overlays.json');
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(registry, 'utf-8'));
  } catch {
    return {};
  }
  if (!isRecord(data)) return {};
  const overlays = data['overlays'];
  if (!Array.isArray(overlays)) return {};
  const result: Record<string, number> = {};
  for (const o of overlays) {
    if (!isRecord(o) || typeof o['name'] !== 'string') continue;
    const p = o['precedence'];
    // typeof excludes booleans (JSON `true`), null, undefined, and strings —
    // the JS analog of Python's `isinstance(p, (int, float)) and not
    // isinstance(p, bool)`.
    result[o['name']] = typeof p === 'number' ? p : 0;
  }
  return result;
}

/**
 * Names of tracked overlays (clone dirs under `~/.canary/overlays/`).
 *
 * Ordered by `overlays.json` when it parses (on-disk overlays not listed there
 * are appended in sorted order); otherwise a plain sorted directory scan.
 * Returns `[]` when no overlays root exists.
 */
export function listOverlays(home?: string): string[] {
  const h = home ?? homedir();
  const root = overlaysRoot(h);
  if (!isDir(root)) return [];
  const onDisk = new Set(listDirs(root));
  const ordered = registryOrder(h).filter((name) => onDisk.has(name));
  const orderedSet = new Set(ordered);
  const extras = [...onDisk].filter((name) => !orderedSet.has(name)).sort();
  return [...ordered, ...extras];
}

/**
 * Resolve a `--from` value to an overlay clone path.
 *
 * A value with a path separator is resolved as a path (which must exist). A bare
 * token is looked up as a tracked-overlay name under `~/.canary/overlays/`.
 * Either miss throws {@link OverlayNotFound} carrying the available names.
 */
export function resolveOverlay(nameOrPath: string, home?: string): string {
  const h = home ?? homedir();
  if (looksLikePath(nameOrPath)) {
    if (existsSync(nameOrPath)) return realpathSync(nameOrPath);
    throw new OverlayNotFound(nameOrPath, listOverlays(h));
  }
  const candidate = join(overlaysRoot(h), nameOrPath);
  if (isDir(candidate)) return realpathSync(candidate);
  throw new OverlayNotFound(nameOrPath, listOverlays(h));
}

function looksLikePath(value: string): boolean {
  const separators = new Set<string>([sep]);
  // Python's `os.altsep` is "/" on Windows, unset on POSIX.
  if (process.platform === 'win32') separators.add('/');
  for (const s of separators) {
    if (value.includes(s)) return true;
  }
  return false;
}

// ── small helpers ─────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function listDirs(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}
