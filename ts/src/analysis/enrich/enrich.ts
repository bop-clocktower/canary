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
 * Generic over the row shape, so this module does not import the history
 * schema: any row with these fields enriches, and extra fields pass through.
 *
 * A row with no error text gets no category: `other` with no evidence would
 * turn a real gap into a false `fed` in `history gaps`.
 */
import { areaFor, loadAreas } from './area.js';
import { categorizeFailure } from './failure-category.js';

/** The fields enrichment reads and writes on a recorded test row. */
interface RecordedRow {
  test_file: string;
  status: string;
  error_text?: string | null;
  area?: string | null;
  failure_category?: string | null;
}

const CATEGORISED = new Set(['failed', 'flaky']);

function enrichRow<T extends RecordedRow>(
  row: T,
  areas: Parameters<typeof areaFor>[1],
): T {
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
export function enrichRecordedResults<T extends RecordedRow>(
  results: readonly T[],
  cwd: string,
): { results: T[]; notes: string[] } {
  const loaded = loadAreas(cwd);
  return {
    results: results.map((r) => enrichRow(r, loaded.areas)),
    notes: loaded.note === undefined ? [] : [loaded.note],
  };
}
