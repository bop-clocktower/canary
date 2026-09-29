/**
 * Record-time enrichment for `canary history record` (#1125).
 *
 * Fills the two fields the format readers cannot know. `area` comes from
 * `.canary/critical-areas.json` (see `area.ts`); `failure_category` comes from
 * the row's own error text (see `failure-category.ts`). It lives in `analysis`,
 * not `history`, and reaches the recorder through the optional
 * `HistoryDeps.enrichResults` seam, which the engine registry
 * (`commands/engine/cli.ts`) fills: `ts/src/history` has no arch headroom
 * (#1074), and `history` stays usable without it.
 *
 * An areas file that is absent or unusable is an abstention, reported as a
 * note, never a silent empty (#508). A row with no error text gets no
 * category: `other` with no evidence would turn a real gap into a false `fed`
 * in `history gaps`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  parseCriticalAreas,
  type CriticalArea,
} from '../../core/inventory-checks.js';
import type { TestResultInput } from '../../history/schema.js';
import { areaFor } from './area.js';
import { categorizeFailure } from './failure-category.js';

const CRITICAL_AREAS_FILE = '.canary/critical-areas.json';
const CATEGORISED = new Set(['failed', 'flaky']);

interface AreasLoad {
  areas: CriticalArea[];
  note?: string;
}

function unusable(reason: string): AreasLoad {
  return {
    areas: [],
    note:
      `area not recorded: ${reason}. \`history record\` maps each test ` +
      `file to an area listed in ${CRITICAL_AREAS_FILE}.`,
  };
}

/** The file's text, `null` when it does not exist, or the read error code. */
function readAreasText(
  cwd: string,
): { text: string | null } | { code: string } {
  try {
    return { text: readFileSync(join(cwd, CRITICAL_AREAS_FILE), 'utf-8') };
  } catch (err) {
    const code = String((err as NodeJS.ErrnoException).code);
    return code === 'ENOENT' ? { text: null } : { code };
  }
}

function loadAreas(cwd: string): AreasLoad {
  const read = readAreasText(cwd);
  if ('code' in read) {
    return unusable(`${CRITICAL_AREAS_FILE} could not be read (${read.code})`);
  }
  const parsed = parseCriticalAreas(read.text);
  if (!parsed.ok) return unusable(parsed.reason);
  if (parsed.areas.length === 0) {
    return unusable(`${CRITICAL_AREAS_FILE} lists no areas`);
  }
  return { areas: parsed.areas };
}

function enrichRow(
  row: TestResultInput,
  areas: readonly CriticalArea[],
): TestResultInput {
  const area = areaFor(row.test_file, areas);
  const category =
    CATEGORISED.has(row.status) && row.error_text
      ? categorizeFailure(row.error_text)
      : undefined;
  return {
    ...row,
    ...(area === undefined ? {} : { area }),
    ...(category === undefined ? {} : { failure_category: category }),
  };
}

/** Enrich recorded rows; `notes` holds one line per abstention. */
export function enrichRecordedResults(
  results: readonly TestResultInput[],
  cwd: string,
): { results: TestResultInput[]; notes: string[] } {
  const loaded = loadAreas(cwd);
  return {
    results: results.map((r) => enrichRow(r, loaded.areas)),
    notes: loaded.note === undefined ? [] : [loaded.note],
  };
}
