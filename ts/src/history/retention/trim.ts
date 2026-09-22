/**
 * Retention for a local NDJSON history store (#1024).
 *
 * Deliberately NOT part of `pushRun`: the write contract stays append-only and
 * unbounded (proposal 460), so nothing a consumer records is dropped behind
 * their back. This is the separate operation a caller invokes when a bounded
 * store is what they want -- canary's own CI calls it between `history record`
 * and the Actions cache save, where an unbounded store means an unbounded,
 * immutable cache entry per run.
 *
 * Lives in its own module rather than on `NdjsonHistoryStore` so the store's
 * query surface stays a read surface, and so retention can grow (age-based
 * cutoffs, per-suite caps) without widening the store contract every consumer
 * implements.
 */

import { readFileSync, writeFileSync } from 'node:fs';

/** What a trim did, in denominators a caller can report honestly. */
export interface TrimResult {
  before: number;
  after: number;
  removed: number;
}

interface RawLine {
  raw: string;
  timestamp: string;
  index: number;
}

/**
 * Drop every run but the newest `keep`, by TIMESTAMP.
 *
 * Two properties this holds on purpose:
 *
 *   - "Newest" is TIME order, not append order, the same rule `queryFlaky` and
 *     `querySummary` apply (#604). A backfilled older run appended last must
 *     not survive while a genuinely newer run is dropped.
 *   - Surviving rows are written back as their ORIGINAL bytes, not
 *     re-serialized from a parsed record. Re-serializing would silently drop
 *     any field this version does not model, turning a retention operation
 *     into data loss on a store written by a newer canary.
 *
 * A store at or below `keep` is not rewritten at all, so the file is left
 * byte-identical and the no-op costs nothing. A missing file is zero runs,
 * which is within any keep count -- a no-op, not an error, because CI trims
 * unconditionally after recording.
 */
export function trimStoreToNewest(path: string, keep: number): TrimResult {
  const lines = readRawLines(path);
  if (lines.length <= keep) {
    return { before: lines.length, after: lines.length, removed: 0 };
  }

  const survivorIndexes = new Set(
    [...lines]
      .sort((a, b) => cmp(a.timestamp, b.timestamp))
      .slice(-keep)
      .map((l) => l.index),
  );
  // Restore the file's original order among the survivors: the store is an
  // append log, and readers that do not sort (e.g. `readAll`) should still see
  // it in the order it was written.
  const survivors = lines.filter((l) => survivorIndexes.has(l.index));
  writeFileSync(path, survivors.map((l) => l.raw).join('\n') + '\n', 'utf-8');

  return {
    before: lines.length,
    after: survivors.length,
    removed: lines.length - survivors.length,
  };
}

/** The raw NDJSON lines with just enough parsed out to order them. */
function readRawLines(path: string): RawLine[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const lines: RawLine[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const record = JSON.parse(line) as { timestamp?: string | null };
    lines.push({
      raw: line,
      timestamp: record.timestamp ?? '',
      index: lines.length,
    });
  }
  return lines;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
