// Ingest reporter: JUnit report files -> one run's rows, timing, catalog and
// the denominator line, for `canary testtracker push` (#1320).
import * as fs from 'node:fs';
import * as path from 'node:path';

import { resolveArea } from './config.js';
import type { ResolvedConfig } from './config.js';
import { relativeFile } from './describe.js';
import { isJunitXml, readJunitCases } from './junit.js';
import { runTiming } from './payload.js';
import type { CollectedEntry, ResultEntry } from './payload.js';

/** One report file, read. */
export interface JunitReport {
  file: string;
  rows: ResultEntry[];
  /** Testcases numbered ` [2]`… because their title repeated in this report. */
  numbered: number;
  started?: number;
  seconds?: number;
}

/**
 * Reads one report, or throws naming the file when it is missing, unreadable
 * or not JUnit. A report that names no test file (node, Newman, Maestro)
 * gives its own path as `test_file`, so a row still says where it came from.
 */
export function readJunitReport(
  file: string,
  cfg: Pick<ResolvedConfig, 'testFilePrefix' | 'areaMap'>,
): JunitReport {
  let xml: string;
  try {
    xml = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${file} (${(err as Error).message}).`);
  }
  if (!isJunitXml(xml)) throw new Error(`${file} is not a JUnit XML report.`);
  const { cases, numbered } = readJunitCases(xml);
  const reportPath = path.relative(process.cwd(), path.resolve(file)) || file;
  const rows = cases.map(({ title, file: testFile, ...rest }): ResultEntry => {
    const test_file = testFile
      ? relativeFile(testFile, cfg.testFilePrefix)
      : reportPath;
    const area = resolveArea([], test_file, cfg.areaMap);
    return { full_title: title, test_file, ...rest, ...(area ? { area } : {}) };
  });
  return { file, rows, numbered, ...timingOf(xml) };
}

/** The first suite timestamp (UTC when zoneless) and the root's `time`. */
function timingOf(xml: string): { started?: number; seconds?: number } {
  const attr = (name: string) =>
    new RegExp(`<testsuites?\\b[^>]*?\\b${name}\\s*=\\s*["']([^"']+)["']`).exec(
      xml,
    )?.[1];
  const stamp = attr('timestamp');
  const zoned =
    stamp && (/(?:Z|[+-]\d\d:?\d\d)$/.test(stamp) ? stamp : `${stamp}Z`);
  const started = zoned ? Date.parse(zoned) : NaN;
  const seconds = Number(attr('time'));
  return {
    ...(Number.isFinite(started) ? { started } : {}),
    ...(Number.isFinite(seconds) ? { seconds } : {}),
  };
}

/** Earliest start across reports; the longest report decides the end. */
export function junitRunTiming(reports: JunitReport[], now: number) {
  const starts = reports
    .map((r) => r.started)
    .filter((n): n is number => n !== undefined);
  if (!starts.length) return runTiming(undefined, now, now);
  const seconds = Math.max(0, ...reports.map((r) => r.seconds ?? 0));
  return runTiming(
    { startTime: new Date(Math.min(...starts)), duration: seconds * 1000 },
    now,
    now,
  );
}

/** Every testcase, one entry per title (as the results are deduped), tags merged. */
export function junitCatalog(rows: ResultEntry[]): CollectedEntry[] {
  const byTitle = new Map<string, CollectedEntry>();
  for (const { full_title, test_file, tags, area } of rows) {
    const prior = byTitle.get(full_title);
    byTitle.set(full_title, {
      full_title,
      test_file,
      tags: [...new Set([...(prior?.tags ?? []), ...tags])],
      ...(area ? { area } : {}),
    });
  }
  return [...byTitle.values()];
}

/** What was read and what is sent, by status: the run's stated denominator. */
export function junitDenominator(
  reports: JunitReport[],
  results: ResultEntry[],
): string {
  const read = reports.reduce((n, r) => n + r.rows.length, 0);
  const count = (s: string) => results.filter((r) => r.status === s).length;
  const plural = reports.length === 1 ? '' : 's';
  const lines = [
    `canary testtracker: read ${read} testcases from ${reports.length} JUnit report${plural}; ` +
      `${results.length} results: ${count('passed')} passed, ${count('failed') + count('timed_out')} failed, ` +
      `${count('flaky')} flaky, ${count('skipped')} skipped.`,
  ];
  if (read !== results.length) {
    lines.push(
      `  ${read - results.length} testcase(s) shared a title across reports and were merged (worst status wins).`,
    );
  }
  for (const r of reports.filter((x) => x.numbered)) {
    lines.push(
      `  ${r.numbered} testcase(s) in ${r.file} share a title and name no file; numbered " [2]", " [3]" in report order, so their identity follows that order.`,
    );
  }
  return `${lines.join('\n')}\n`;
}
