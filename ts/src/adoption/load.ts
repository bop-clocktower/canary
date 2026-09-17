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
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
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

/** Load every `*.json` in `dir`; a missing directory is zero records. */
export function loadRecords(dir: string): LoadedRecords {
  const records: GuardianRecord[] = [];
  const skipped: SkippedFile[] = [];
  for (const file of listDir(dir).filter((f) => f.endsWith('.json'))) {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as Record<
        string,
        unknown
      >;
    } catch {
      skipped.push({ file, reason: 'unparseable JSON' });
      continue;
    }
    if (raw['source'] !== 'canary-pr-guardian') {
      skipped.push({ file, reason: 'not a canary-pr-guardian record' });
    } else if (!isRecord(raw)) {
      skipped.push({ file, reason: 'malformed record' });
    } else {
      records.push({
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
      });
    }
  }
  return { records, skipped };
}

export interface WorkflowPresence {
  present: boolean;
  files: string[];
}

/**
 * Which `.github/workflows/*.y{a,}ml` files under `root` run `guardian pr-check`.
 * Presence only: whether a present workflow is DISABLED lives in the Actions
 * API, which this report never calls.
 */
export function scanWorkflows(root: string): WorkflowPresence {
  const dir = join(root, '.github', 'workflows');
  const files = listDir(dir).filter((f) => {
    if (!/\.ya?ml$/.test(f)) return false;
    try {
      return /guardian\s+pr-check/.test(readFileSync(join(dir, f), 'utf-8'));
    } catch {
      return false;
    }
  });
  return { present: files.length > 0, files };
}
