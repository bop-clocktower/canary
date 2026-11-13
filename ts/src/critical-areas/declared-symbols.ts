/** The `symbols` a person declared in an existing map, kept through a rewrite. */
import { readRegularFile } from './regular-file.js';

/**
 * Katana's contract rejects these, and the engine cannot import a skill, so
 * this mirrors normSymbol and MIN_DECLARED_SYMBOL = 3 in
 * agents/skills/lib/contracts/critical-areas.mjs. Keep the two in step.
 */
const MIN_SYMBOL_CHARS = 3;

/**
 * The existing file's rows, or none when it is absent or malformed (D17), or
 * not a regular file: a tracked link to `/dev/zero` hung the scan (#1575).
 */
function existingRows(out: string): { path?: unknown; symbols?: unknown }[] {
  try {
    const text = readRegularFile(out);
    if (text === null) return [];
    const data = JSON.parse(text) as { areas?: unknown };
    return Array.isArray(data?.areas) ? data.areas : [];
  } catch {
    return [];
  }
}

const isSymbol = (s: unknown): boolean =>
  typeof s === 'string' &&
  s.toLowerCase().replace(/[^a-z0-9]/g, '').length >= MIN_SYMBOL_CHARS;

const isSymbolList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.every(isSymbol);

function readDeclaredSymbols(out: string) {
  const declared = new Map<string, string[]>();
  const rejected: string[] = [];
  for (const row of existingRows(out)) {
    if (typeof row?.path !== 'string' || row.symbols === undefined) continue;
    if (isSymbolList(row.symbols)) declared.set(row.path, row.symbols);
    else rejected.push(row.path);
  }
  return { declared, rejected };
}

/** A person chose these (D13); only a path not tracked in HEAD loses them. */
export function keepSymbols(out: string, trackedPaths: string[]) {
  const tracked = new Set(trackedPaths);
  const { declared, rejected } = readDeclaredSymbols(out);
  const rows = [...declared];
  return {
    kept: new Map(rows.filter(([path]) => tracked.has(path))),
    dropped: rows.map(([path]) => path).filter((p) => !tracked.has(p)),
    rejected,
  };
}
