/**
 * Read-only inputs for the adoption report (#491): guardian analysis records on
 * disk, and whether any local workflow still runs the guardian.
 *
 * Harness keeps its own records in the same `.harness/analyses/` directory, so
 * a file that is not a canary guardian record is skipped by NAME with a reason.
 * Silently ignoring it would make a mis-pointed `--dir` look like an empty one.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { GuardianRecord } from './signals.js';

interface SkippedFile {
  file: string;
  reason: string;
}

interface LoadedRecords {
  records: GuardianRecord[];
  skipped: SkippedFile[];
  /**
   * Why the directory yielded nothing, when that was not "it was empty".
   * A directory that could not be read is a FINDING, not a zero: the report
   * must be able to say "I could not look" rather than "I looked and found
   * nothing".
   */
  dirProblem: string | null;
}

/** `missing` is ENOENT; `unreadable` is anything else (permissions, a file). */
type DirRead =
  | { kind: 'read'; files: string[] }
  | { kind: 'missing' }
  | { kind: 'unreadable'; error: string };

function listDir(dir: string): DirRead {
  try {
    return { kind: 'read', files: readdirSync(dir).sort() };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'unreadable', error: code ?? String(err) };
  }
}

function isRecord(raw: Record<string, unknown>): boolean {
  const s = raw['summary'] as Record<string, unknown> | undefined;
  return (
    typeof raw['ref'] === 'string' &&
    typeof raw['gate'] === 'string' &&
    typeof raw['tier'] === 'number' &&
    typeof raw['analyzedAt'] === 'string' &&
    typeof s === 'object' &&
    s !== null &&
    typeof s['total'] === 'number' &&
    typeof s['unaddressed'] === 'number' &&
    typeof s['suppressed'] === 'number'
  );
}

/** One file's outcome: a record, or a named skip. */
type FileOutcome =
  { kind: 'record'; record: GuardianRecord } | { kind: 'skip'; reason: string };

function readOne(dir: string, file: string): FileOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
  } catch {
    return { kind: 'skip', reason: 'unparseable JSON' };
  }
  // `JSON.parse('null')` and `JSON.parse('[]')` both parse fine and are not
  // records: a truncated file from an interrupted job must be SKIPPED, never a
  // crash — the command's contract is that it always exits 0.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'skip', reason: 'not a JSON object' };
  }
  const raw = parsed as Record<string, unknown>;
  if (raw['source'] !== 'canary-pr-guardian') {
    return { kind: 'skip', reason: 'not a canary-pr-guardian record' };
  }
  if (!isRecord(raw)) return { kind: 'skip', reason: 'malformed record' };
  return {
    kind: 'record',
    record: {
      ref: raw['ref'] as string,
      gate: raw['gate'] as string,
      tier: raw['tier'] as number,
      abstained: raw['abstained'] === true,
      degradedNotice:
        typeof raw['degradedNotice'] === 'string'
          ? raw['degradedNotice']
          : null,
      analyzedAt: raw['analyzedAt'] as string,
      summary: raw['summary'] as GuardianRecord['summary'],
    },
  };
}

/** Load every `*.json` in `dir`, naming what it could not read. */
export function loadRecords(dir: string): LoadedRecords {
  const records: GuardianRecord[] = [];
  const skipped: SkippedFile[] = [];
  const listing = listDir(dir);
  if (listing.kind !== 'read') {
    return {
      records,
      skipped,
      dirProblem:
        listing.kind === 'missing'
          ? 'the records directory does not exist'
          : `the records directory could not be read (${listing.error})`,
    };
  }
  for (const file of listing.files.filter((f) => f.endsWith('.json'))) {
    const outcome = readOne(dir, file);
    if (outcome.kind === 'record') records.push(outcome.record);
    else skipped.push({ file, reason: outcome.reason });
  }
  return { records, skipped, dirProblem: null };
}

export interface WorkflowPresence {
  present: boolean;
  files: string[];
}

export type WorkflowScan =
  | { kind: 'scanned'; value: WorkflowPresence }
  | { kind: 'unknown'; reason: string };

/**
 * Which `.github/workflows/*.y{a,}ml` files under `root` run `guardian pr-check`.
 * Presence only: whether a present workflow is DISABLED lives in the Actions
 * API, which this report never calls.
 */
export function scanWorkflows(root: string): WorkflowScan {
  const dir = join(root, '.github', 'workflows');
  const listing = listDir(dir);
  if (listing.kind !== 'read') {
    // Claiming "absent from .github/workflows" about a directory that does not
    // exist would be a positive claim from a failed look.
    return {
      kind: 'unknown',
      reason:
        listing.kind === 'missing'
          ? 'no .github/workflows directory here'
          : `.github/workflows could not be read (${listing.error})`,
    };
  }
  const files = listing.files.filter((f) => {
    if (!/\.ya?ml$/.test(f)) return false;
    try {
      return /guardian\s+pr-check/.test(readFileSync(join(dir, f), 'utf-8'));
    } catch {
      return false;
    }
  });
  return { kind: 'scanned', value: { present: files.length > 0, files } };
}
