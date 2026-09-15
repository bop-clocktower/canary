/**
 * Guardian adjudication without reactions (ADR 0025, #938).
 *
 * The soft→hard promotion rests on `precision = TP / (TP + FP)`. Reaction
 * collection (#490) read an input nobody produces (0 reactions on 290 stickies),
 * so precision is now DERIVED on demand from signals the team already leaves:
 *
 * - **true positive**: a coverage-verified finding on the first sticky revision
 *   is gone from the last one while its file is still in the merged diff (a
 *   later commit covered it).
 * - **intentional**: the merged diff adds `canary:allow-untested <reason>`.
 * - **false positive**: the reason starts with `fp:`.
 * - **ambiguous**: it disappeared with no coverage evidence (heuristic/graph
 *   tier, or the file left the diff).
 * - **unresolved**: still active at merge. Not a false positive.
 *
 * Nothing is stored. Precision is `null` below {@link PRECISION_FLOOR}
 * adjudicated findings (TP + FP), and every excluded PR is counted in a
 * disclosed denominator rather than dropped (#508, ADR 0009).
 *
 * PURE: no network, no filesystem. GitHub access lives in
 * `adjudication-github.ts` behind an injected seam.
 */

import { STICKY_MARKER } from './pr-comment.js';
import { suppressionReason } from './pr-check.js';

/** Minimum TP + FP before precision is reported as a number. */
export const PRECISION_FLOOR = 30;

export type Verdict =
  | 'true-positive'
  | 'false-positive'
  | 'intentional'
  | 'ambiguous'
  | 'unresolved';

export type SuppressionKind = 'false-positive' | 'intentional';

/** One finding row as rendered in a sticky revision. */
export interface StickyFinding {
  path: string;
  fidelity: string;
}

/** A merged-PR file as REST `/pulls/{n}/files` returns it (`patch` may be absent). */
export interface PrFile {
  filename: string;
  patch?: string;
}

/**
 * One merged PR's evidence. `revisions` holds the sticky's bodies oldest to
 * newest, or `null` when its edit history could not be retrieved.
 */
export interface PrEvidence {
  number: number;
  revisions: string[] | null;
  files: PrFile[];
}

// A finding row: `| <sev> | [`path`](url) or `path` | what | fidelity |`. The
// header and separator never open their second cell with a backtick.
const FINDING_ROW_RE = /^\|[^|]*\|\s*\[?`([^`]+)`.*\|\s*([a-z-]+)\s*\|\s*$/;
const TABLE_HEADER = '| Sev | File |';
const HEADING = 'Canary PR Guardian';

/**
 * `fp:` (any case, optional space before the colon) marks a false positive;
 * any other reason is intentional. A bare `fp:` still counts: the prefix is
 * the reviewer's verdict, the text after it is only the explanation.
 */
export function suppressionKind(reason: string): SuppressionKind {
  return /^fp\s*:/i.test(reason.trim()) ? 'false-positive' : 'intentional';
}

/** Suppressions ADDED by the merged diff, per path (`fp:` wins on a tie). */
export function suppressionsByPath(
  files: PrFile[],
): Map<string, SuppressionKind> {
  const out = new Map<string, SuppressionKind>();
  for (const file of files) {
    for (const line of (file.patch ?? '').split('\n')) {
      if (!line.startsWith('+') || line.startsWith('+++')) continue;
      const reason = suppressionReason(line.slice(1));
      if (reason === null || out.get(file.filename) === 'false-positive')
        continue;
      out.set(file.filename, suppressionKind(reason));
    }
  }
  return out;
}

/**
 * Parse the finding rows of one sticky revision. Returns `null` for a body
 * that is not a guardian sticky, or whose findings table yields no row: an
 * unparseable body is unknown, never zero findings.
 */
export function parseStickyFindings(body: string): StickyFinding[] | null {
  const trimmed = body.trimStart();
  if (!trimmed.startsWith(STICKY_MARKER) || !body.includes(HEADING))
    return null;
  const rows: StickyFinding[] = [];
  for (const line of body.split(/\r\n|\r|\n/)) {
    const match = FINDING_ROW_RE.exec(line);
    if (match) rows.push({ path: match[1]!, fidelity: match[2]! });
  }
  if (rows.length === 0 && body.includes(TABLE_HEADER)) return null;
  return rows;
}

/** Classify one first-revision finding against the merge-time evidence. */
export function classifyFinding(
  finding: StickyFinding,
  ctx: {
    last: StickyFinding[];
    suppressions: Map<string, SuppressionKind>;
    mergedPaths: Set<string>;
  },
): Verdict {
  const suppression = ctx.suppressions.get(finding.path);
  if (suppression) return suppression;
  if (ctx.last.some((f) => f.path === finding.path)) return 'unresolved';
  const covered =
    finding.fidelity === 'coverage-verified' &&
    ctx.mergedPaths.has(finding.path);
  return covered ? 'true-positive' : 'ambiguous';
}

/** The derived precision report. `precision` is null below the floor. */
export interface AdjudicationReport {
  counts: Record<Verdict, number>;
  /** TP + FP: the only findings that count toward the floor. */
  adjudicated: number;
  precision: number | null;
  prs: {
    scanned: number;
    withSticky: number;
    noHistory: number;
    unparseable: number;
  };
}

function emptyCounts(): Record<Verdict, number> {
  return {
    'true-positive': 0,
    'false-positive': 0,
    intentional: 0,
    ambiguous: 0,
    unresolved: 0,
  };
}

/** Tally one PR into `report`, or count it as excluded. */
function tallyPr(pr: PrEvidence, report: AdjudicationReport): void {
  if (pr.revisions === null || pr.revisions.length === 0) {
    report.prs.noHistory += 1;
    return;
  }
  const first = parseStickyFindings(pr.revisions[0]!);
  const last = parseStickyFindings(pr.revisions.at(-1)!);
  if (first === null || last === null) {
    report.prs.unparseable += 1;
    return;
  }
  const ctx = {
    last,
    suppressions: suppressionsByPath(pr.files),
    mergedPaths: new Set(pr.files.map((f) => f.filename)),
  };
  for (const finding of first) report.counts[classifyFinding(finding, ctx)]++;
}

/** Derive the report over the PRs that carried a sticky (PURE). */
export function deriveReport(
  prs: PrEvidence[],
  scanned: number,
): AdjudicationReport {
  const report: AdjudicationReport = {
    counts: emptyCounts(),
    adjudicated: 0,
    precision: null,
    prs: { scanned, withSticky: prs.length, noHistory: 0, unparseable: 0 },
  };
  for (const pr of prs) tallyPr(pr, report);
  const { 'true-positive': tp, 'false-positive': fp } = report.counts;
  report.adjudicated = tp + fp;
  if (report.adjudicated >= PRECISION_FLOOR) report.precision = tp / (tp + fp);
  return report;
}

/** Render the report; the number never appears without its sample size. */
export function renderReport(report: AdjudicationReport): string {
  const c = report.counts;
  const sample = `n=${report.adjudicated}: ${c['true-positive']} TP / ${c['false-positive']} FP`;
  const value =
    report.precision === null
      ? `unknown (N < ${PRECISION_FLOOR}) (${sample})`
      : `${(report.precision * 100).toFixed(1).replace(/\.0$/, '')}% (${sample})`;
  const p = report.prs;
  return [
    `guardian precision: ${value}`,
    `excluded from precision: ${c.intentional} intentional, ${c.ambiguous} ambiguous, ${c.unresolved} unresolved at merge`,
    `merged PRs: ${p.scanned} scanned, ${p.withSticky} with a guardian sticky, ` +
      `${p.noHistory} excluded: no edit history, ${p.unparseable} excluded: unparseable sticky`,
    '`fp:` suppressions are a convention: under-use biases precision upward.',
  ].join('\n');
}
