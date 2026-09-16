/**
 * The OPTIONAL side inputs a charter reads from `.canary/` (#593).
 *
 * Both readers answer with `null` rather than an empty result when they cannot
 * speak: "the file said nothing imports this" and "there was no file" are
 * different claims, and collapsing them is how an absent measurement starts
 * reading as a clean one (ADR 0010). Kept separate from the facts assembly so
 * neither concern has to know how the other fails.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The inventory schema this reader understands; anything else is unavailable. */
const SUPPORTED_INVENTORY_SCHEMA = 1;

/** Inventory import targets, keyed by extension-stripped module path. */
type ImportIndex = Map<string, string[]>;

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  } catch {
    return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Index `.canary/test-inventory.json` targets by module path, or `null`.
 *
 * `null` for an absent, unreadable, malformed OR unknown-schema inventory —
 * criterion 4: a version this reader cannot parse is "unavailable", never an
 * empty read that would render as "none found".
 */
export function readInventoryIndex(root: string): ImportIndex | null {
  const data = readJson(join(root, '.canary', 'test-inventory.json'));
  if (!isRecord(data)) return null;
  if (data['schema_version'] !== SUPPORTED_INVENTORY_SCHEMA) return null;
  const files = data['files'];
  if (!Array.isArray(files)) return null;
  const index: ImportIndex = new Map();
  for (const file of files) indexInventoryFile(file, index);
  return index;
}

/** Add one inventory row's import targets to `index`; ignore a malformed row. */
function indexInventoryFile(file: unknown, index: ImportIndex): void {
  if (!isRecord(file)) return;
  const path = file['path'];
  const targets = file['targets'];
  if (typeof path !== 'string' || !Array.isArray(targets)) return;
  for (const target of targets) {
    if (typeof target !== 'string') continue;
    const existing = index.get(target);
    if (existing) existing.push(path);
    else index.set(target, [path]);
  }
}

/**
 * Read `rank_score` per path from `.canary/critical-areas.json`, or `null`.
 *
 * Tolerant of both shapes seen in the wild (a bare array, or an `areas` key)
 * because the file has no committed schema yet; an unreadable file is a stated
 * "risk ranking unavailable", never an inline ranking computed here (D6).
 */
export function readRankIndex(root: string): Map<string, number> | null {
  const data = readJson(join(root, '.canary', 'critical-areas.json'));
  const rows = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data['areas'])
      ? data['areas']
      : null;
  if (rows === null) return null;
  const index = new Map<string, number>();
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const path = row['path'];
    const score = row['rank_score'];
    if (typeof path === 'string' && typeof score === 'number') {
      index.set(path, score);
    }
  }
  return index;
}
