/**
 * Markdown report builders for cross-suite analysis.
 *
 * Faithful TypeScript port of `agent/analysis/reports.py`. Pure functions: each
 * builder takes pre-fetched query rows and returns Markdown. No I/O.
 *
 * Parity notes:
 * - `round1` reproduces Python's round-half-to-even so `round(x, 1)` matches.
 * - Rounded values are rendered with `num1` (one decimal, trailing zero kept),
 *   matching `str(float)` for any 1-decimal-rounded float ("50.0", "33.3").
 */

import type {
  AreaHealthRow,
  CommonFailureRow,
  FlakyRow,
  RegressionRow,
  SpikeRow,
} from './rows.js';
import { num1, pyFloat, round1 } from '../util/round.js';
import { def } from '../util/coalesce.js';

// Re-exported so existing callers/tests importing round1 from here still work.
export { round1 };

// ---------------------------------------------------------------------------
// Flaky report
// ---------------------------------------------------------------------------

export function buildFlakyReport(
  rows: FlakyRow[],
  windowRuns: number,
  minRatePct: number,
  limit = 20,
): string {
  if (rows.length === 0) {
    return `No tests above ${pyFloat(minRatePct)}% flake rate in the last ${windowRuns} runs.\n`;
  }

  const sorted = [...rows]
    .sort((a, b) => b.flake_rate_pct - a.flake_rate_pct)
    .slice(0, limit);
  const lines = [
    `## Fleet-wide Flaky Tests (top ${limit}, window: ${windowRuns} runs, threshold: ≥ ${pyFloat(minRatePct)}%)\n`,
    '| Test | Suite | Area | Flake % | Flake/Total |',
    '|------|-------|------|---------|-------------|',
  ];
  for (const r of sorted) {
    lines.push(
      `| ${r.test_name} | ${r.suite ?? ''} | ${r.area || '—'} ` +
        `| ${num1(r.flake_rate_pct)}% | ${r.flake_count}/${r.total_runs} |`,
    );
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Spikes report
// ---------------------------------------------------------------------------

interface Spike {
  suite: string;
  earlyFailRate: number;
  recentFailRate: number;
  increasePct: number;
  since: string;
}

function groupBySuite(rows: SpikeRow[]): Map<string, SpikeRow[]> {
  const bySuite = new Map<string, SpikeRow[]>();
  for (const r of rows) {
    const bucket = bySuite.get(r.suite);
    if (bucket) bucket.push(r);
    else bySuite.set(r.suite, [r]);
  }
  return bySuite;
}

function suiteFailRate(rr: SpikeRow[]): number {
  // Matches Python: `total` sums only rows with total > 0, but `failed` sums
  // every row (including total === 0 rows).
  const total = rr.reduce((acc, r) => acc + (r.total > 0 ? r.total : 0), 0);
  const failed = rr.reduce((acc, r) => acc + r.failed + def(r.flaky, 0), 0);
  return total > 0 ? (failed / total) * 100 : 0.0;
}

function detectSpikes(rows: SpikeRow[], deltaPp: number): Spike[] {
  const spikes: Spike[] = [];
  for (const [suite, suiteRows] of groupBySuite(rows)) {
    const s = [...suiteRows].sort((a, b) => cmp(a.timestamp, b.timestamp));
    if (s.length < 4) continue;
    const mid = Math.floor(s.length / 2);
    const early = suiteFailRate(s.slice(0, mid));
    const recent = s.slice(mid);
    const recentRate = suiteFailRate(recent);
    const increase = recentRate - early;
    if (increase < deltaPp) continue;
    spikes.push({
      suite,
      earlyFailRate: round1(early),
      recentFailRate: round1(recentRate),
      increasePct: round1(increase),
      since: recent[0]!.timestamp.slice(0, 10),
    });
  }
  return spikes;
}

export function buildSpikesReport(rows: SpikeRow[], deltaPp: number): string {
  if (rows.length === 0) {
    return 'No run data available for spike detection.\n';
  }
  const spikes = detectSpikes(rows, deltaPp);
  if (spikes.length === 0) {
    return `No spikes detected (threshold: ${pyFloat(deltaPp)}pp increase in failure rate).\n`;
  }

  const lines = [
    `## Failure Spikes (threshold: ≥ ${pyFloat(deltaPp)}pp increase)\n`,
    '| Suite | Early Fail % | Recent Fail % | Increase | Since |',
    '|-------|-------------|--------------|----------|-------|',
  ];
  for (const s of spikes.sort((a, b) => b.increasePct - a.increasePct)) {
    lines.push(
      `| ${s.suite} | ${num1(s.earlyFailRate)}% | ${num1(s.recentFailRate)}% ` +
        `| +${num1(s.increasePct)}pp | ${s.since} |`,
    );
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Area health report
// ---------------------------------------------------------------------------

export function buildAreaHealthReport(
  rows: AreaHealthRow[],
  weeks: number,
): string {
  if (rows.length === 0) return 'No area health data available.\n';

  const byArea = new Map<string, AreaHealthRow[]>();
  for (const r of rows) {
    const key = `${r.area}\0${r.suite ?? ''}`;
    const bucket = byArea.get(key);
    if (bucket) bucket.push(r);
    else byArea.set(key, [r]);
  }

  const sortKey = (r: AreaHealthRow): string => r.week ?? r.timestamp ?? '';

  interface AreaEntry {
    area: string;
    suite: string;
    startRate: number;
    endRate: number;
    dropPp: number;
    degrading: boolean;
  }
  const allAreas: AreaEntry[] = [];
  for (const [key, areaRows] of byArea) {
    const [area, suite] = key.split('\0') as [string, string];
    const sorted = [...areaRows].sort((a, b) => cmp(sortKey(a), sortKey(b)));
    const rates = sorted
      .map((r) => r.pass_rate)
      .filter((v): v is number => v !== null && v !== undefined);
    if (rates.length === 0) continue;
    const drop = (rates[0]! - rates[rates.length - 1]!) * 100;
    allAreas.push({
      area,
      suite,
      startRate: round1(rates[0]! * 100),
      endRate: round1(rates[rates.length - 1]! * 100),
      dropPp: round1(drop),
      degrading: drop >= 5,
    });
  }

  if (allAreas.length === 0) return 'No area health data available.\n';

  const lines = [
    `## Area Health (last ${weeks} weeks)\n`,
    '| Area | Suite | Start % | Now % | Trend |',
    '|------|-------|---------|-------|-------|',
  ];
  for (const d of allAreas.sort((a, b) => b.dropPp - a.dropPp)) {
    const trend = d.degrading ? `↓ ${num1(d.dropPp)}pp` : '→ stable';
    lines.push(
      `| ${d.area} | ${d.suite} | ${num1(d.startRate)}% | ${num1(d.endRate)}% | ${trend} |`,
    );
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Common failures report
// ---------------------------------------------------------------------------

interface FailureEntry {
  errorPrefix: string;
  suites: Set<string>;
  tests: string[];
  category: string;
}

function groupFailuresByPrefix(
  rows: CommonFailureRow[],
): Map<string, FailureEntry> {
  const byPrefix = new Map<string, FailureEntry>();
  for (const r of rows) {
    const err = (r.error_text || '').slice(0, 200);
    if (!err) continue;
    let entry = byPrefix.get(err);
    if (!entry) {
      entry = {
        errorPrefix: err,
        suites: new Set(),
        tests: [],
        category: def(r.failure_category, 'other'),
      };
      byPrefix.set(err, entry);
    }
    entry.suites.add(r.suite);
    entry.tests.push(r.test_name);
  }
  return byPrefix;
}

export function buildCommonFailuresReport(
  rows: CommonFailureRow[],
  minSuites: number,
): string {
  if (rows.length === 0) return 'No failure data available.\n';

  const crossSuite = [...groupFailuresByPrefix(rows).values()].filter(
    (v) => v.suites.size >= minSuites,
  );
  if (crossSuite.length === 0) {
    return `No common failures appearing in ≥ ${minSuites} suites.\n`;
  }

  const lines = [`## Common Failures (appearing in ≥ ${minSuites} suites)\n`];
  for (const entry of crossSuite.sort(
    (a, b) => b.suites.size - a.suites.size,
  )) {
    const suitesStr = [...entry.suites].sort(cmp).join(', ');
    const testCount = new Set(entry.tests).size;
    lines.push(`### \`${entry.errorPrefix.slice(0, 80)}…\`\n`);
    lines.push(`- **Suites:** ${suitesStr}`);
    lines.push(`- **Category:** ${entry.category}`);
    lines.push(`- **Affected tests:** ${testCount}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Regression candidates report
// ---------------------------------------------------------------------------

export function buildRegressionCandidatesReport(rows: RegressionRow[]): string {
  if (rows.length === 0) return 'No regression candidates detected.\n';

  const lines = [
    '## Regression Candidates\n',
    '| Test | Suite | Area | Green Streak | First Failure |',
    '|------|-------|------|-------------|---------------|',
  ];
  for (const r of rows) lines.push(regressionRow(r));
  return lines.join('\n') + '\n';
}

function regressionRow(r: RegressionRow): string {
  const streak = def(r.green_streak, '?');
  const commit = String(def(r.first_failure_commit, '?')).slice(0, 8);
  // `|| '—'` (not def) mirrors Python `r.get('area') or '—'`: empty string → —.
  return (
    `| ${r.test_name} | ${def(r.suite, '')} | ${r.area || '—'} ` +
    `| ${streak} runs | ${commit} |`
  );
}

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

export function buildDigest(args: {
  flaky: FlakyRow[];
  spikes: SpikeRow[];
  areaHealth: AreaHealthRow[];
  commonFailures: CommonFailureRow[];
  regressionCandidates: RegressionRow[];
  windowRuns: number;
  deltaPp: number;
  weeks: number;
  minSuites: number;
}): string {
  const sections = [
    '# Fleet Health Digest\n',
    '## Flaky Tests\n\n' + buildFlakyReport(args.flaky, args.windowRuns, 10.0),
    '## Spikes\n\n' + buildSpikesReport(args.spikes, args.deltaPp),
    '## Area Health\n\n' + buildAreaHealthReport(args.areaHealth, args.weeks),
    '## Common Failures\n\n' +
      buildCommonFailuresReport(args.commonFailures, args.minSuites),
    '## Regression Candidates\n\n' +
      buildRegressionCandidatesReport(args.regressionCandidates),
  ];
  return sections.join('\n---\n');
}

/** Python-style string comparison (code-point order, stable). */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
