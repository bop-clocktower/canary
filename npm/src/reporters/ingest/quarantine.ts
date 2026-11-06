// Ingest reporter: quarantine state from the canary-katana ledger (#1321).
//
// The ingest schema has no quarantine field, so the state rides on the tags
// both producers already send: `quarantined`, plus `quarantine:<issue>` when
// the row names one. Only a SKIPPED result the ledger backs is tagged; a skip
// with no row is an unexplained skip, not a quarantine the repo can stand
// behind. Nothing is stored, so release is implicit: drop the row and the
// next push sends no tag.
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { ResolvedConfig } from "./config.js";
import { dedupeByFullTitle } from "./payload.js";
import { errText, log, warn } from "./transport.js";
import type { ResultEntry } from "./types.js";

export const QUARANTINED_TAG = "quarantined";

/** The ledger fields this module reads; katana's `load()` fills every one. */
export interface LedgerRow {
  test: string;
  file: string;
  kind: string;
  issue: string;
}

export interface QuarantineReport {
  /** Skipped results that got the quarantine tags. */
  tagged: number;
  rows: number;
  /** `file › test` of each non-removed row no skipped result matched. */
  unmatched: string[];
  /** `removed` rows nothing matched: a deleted test never produces a result. */
  removed: number;
}

const KATANA_LEDGER = ["agents", "skills", "claude-code", "canary-katana", "scripts", "ledger.mjs"];

/**
 * katana's own reader, never a copy: `load()` is also where a v1 `ticket`
 * migrates onto `issue`, so a second parser would drift exactly there. It is
 * `<pkg>/agents/skills` in the published package (staged by build-engine,
 * #757) and `<repo>/agents/skills` in a checkout.
 */
function katanaLedgerModule(): string {
  for (const up of ["../../..", "../../../.."]) {
    const candidate = path.resolve(__dirname, up, ...KATANA_LEDGER);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("canary-katana's ledger reader (agents/skills/claude-code/canary-katana) is not installed.");
}

/**
 * The ledger's rows, or a throw. katana's `load()` reads a missing file as an
 * empty ledger, which here would turn a typo'd path into "nothing is
 * quarantined", so absence is checked first.
 */
export async function loadLedgerRows(file: string): Promise<LedgerRow[]> {
  if (!fs.existsSync(file)) throw new Error(`quarantine ledger ${file} not found.`);
  if (!fs.statSync(file).isFile()) throw new Error(`quarantine ledger ${file} is not a file.`);
  try {
    const katana = (await import(pathToFileURL(katanaLedgerModule()).href)) as {
      load(filePath: string): { entries: LedgerRow[] };
    };
    return katana.load(file).entries;
  } catch (err) {
    throw new Error(`cannot read the quarantine ledger: ${errText(err)}`);
  }
}

/** katana's `(file, test)` identity: `test` is the leaf title, `full_title` ends with it. */
function matches(result: ResultEntry, row: LedgerRow): boolean {
  if (!row.test || result.test_file !== row.file) return false;
  return result.full_title === row.test || result.full_title.endsWith(` > ${row.test}`);
}

export function applyQuarantine(
  results: ResultEntry[],
  rows: LedgerRow[],
): { results: ResultEntry[]; report: QuarantineReport } {
  const used = new Set<LedgerRow>();
  let tagged = 0;
  const out = results.map((r) => {
    if (r.status !== "skipped") return r;
    const hits = rows.filter((row) => matches(r, row));
    if (!hits.length) return r;
    for (const h of hits) used.add(h);
    tagged += 1;
    const tickets = hits.filter((h) => h.issue).map((h) => `quarantine:${h.issue}`);
    return { ...r, tags: [...new Set([...r.tags, QUARANTINED_TAG, ...tickets])] };
  });
  const left = rows.filter((row) => !used.has(row));
  return {
    results: out,
    report: {
      tagged,
      rows: rows.length,
      unmatched: left.filter((row) => row.kind !== "removed").map((row) => `${row.file} › ${row.test}`),
      removed: left.filter((row) => row.kind === "removed").length,
    },
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** One line: what was tagged, and every row that matched nothing, by name. */
export function quarantineSummary(report: QuarantineReport): string {
  const parts = [`quarantine: ${plural(report.tagged, "skipped result")} tagged from ${plural(report.rows, "ledger row")}`];
  if (report.unmatched.length) {
    parts.push(`${plural(report.unmatched.length, "ledger row")} matched no skipped result: ${report.unmatched.join(", ")}`);
  }
  if (report.removed) {
    parts.push(`${plural(report.removed, "removed row")} ${report.removed === 1 ? "has" : "have"} no test to match`);
  }
  return `${parts.join("; ")}.`;
}

/**
 * Load and apply; the results unchanged when no ledger is configured. Throws
 * on a bad ledger. Rows are merged by title FIRST, as buildPayload will: a
 * skip tagged before the merge would keep its tags on a row sent `passed`
 * (one project skipped it, another ran it), a quarantine claim the run
 * contradicts.
 */
export async function quarantineResults(
  cfg: ResolvedConfig,
  results: ResultEntry[],
): Promise<{ results: ResultEntry[]; summary?: string }> {
  if (!cfg.quarantineLedger) return { results };
  const applied = applyQuarantine(dedupeByFullTitle(results), await loadLedgerRows(cfg.quarantineLedger));
  return { results: applied.results, summary: quarantineSummary(applied.report) };
}

/**
 * The reporter's form: a bad ledger warns and the run is pushed untagged, like
 * every other reporter config error, because a reporter must never cost the
 * run its results.
 */
export async function reporterQuarantine(cfg: ResolvedConfig, results: ResultEntry[]): Promise<ResultEntry[]> {
  try {
    const q = await quarantineResults(cfg, results);
    if (q.summary) log(q.summary);
    return q.results;
  } catch (err) {
    warn(`${errText(err)} Pushing without quarantine tags.`);
    return results;
  }
}
