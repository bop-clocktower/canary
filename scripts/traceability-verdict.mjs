#!/usr/bin/env node
// Supplies the denominator the `traceability` check in `harness ci check` has
// never had in CI.
//
// `runTraceabilityCheck` is a pure function of `.harness/graph/graph.json`.
// That path is gitignored, untracked, and until this script's companion change
// no workflow built it — the only `harness graph` invocation in the repo was
// commented out in `guardian.yml`. Upstream returns an EMPTY issue list when
// the graph fails to load, and the reporter renders empty as `pass`. So every
// `actions/checkout` printed:
//
//   {"name":"traceability","status":"pass","issues":[]}
//
// having read zero requirements. Reproduced on one commit with one pinned CLI:
// a worktree with a graph present reports `warn traceability 1`; a fresh
// `git clone` reports `pass traceability 0`.
//
// The CI report cannot tell those apart — a clean read and an absent one are
// byte-identical there, exactly as the `arch` entry cannot distinguish a new
// violation from a ratchet trip (#626). The distinguishing data exists in
// `harness traceability --json`, which lists every spec and every requirement
// with the code and test files traced to it. This module is the single place
// that reads it, shared by the CI summariser
// (`harness-report-summary.mjs --traceability`) and by a local run, so the two
// paths cannot drift into different verdicts on the same report.
//
// It reports the coverage numbers; it does NOT gate on them. Test-edge
// coverage on this repo is ~2%, and raising `minCoverage` is a separate,
// deliberate decision. A number nobody can see is the problem being fixed here;
// a number that fails the build the day it becomes visible is a different one.
//
// Exit codes follow the repo's gate convention (#508):
//   0 = measured — the requirement count is non-zero and is printed
//   2 = usage error
//   3 = ABSTENTION — the report is missing, truncated, has an unreadable
//       shape, or contains ZERO requirements. Zero verified items is not a
//       pass; that is the whole defect this script exists to make impossible.
//
//   node scripts/traceability-verdict.mjs [traceability-report.json]
//
// Produce the input with:
//   harness graph scan
//   harness traceability --json > traceability-report.json
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Untraced requirements listed before the remainder is summarised. */
const UNTRACED_DETAIL_CAP = 10;

const GRAPH_PATH = '.harness/graph/graph.json';

/** The command that builds the graph every traceability read depends on. */
const BUILD_COMMAND = 'harness graph scan';

/**
 * The sentence every abstention ends with. The new-gate checklist requires an
 * abstention to name why the denominator collapsed AND the first fix step — a
 * bare "abstained" is half a bug report, and this particular one is reached by
 * people who have no reason to know a knowledge graph is involved at all.
 */
const FIX_STEP =
  `Run \`${BUILD_COMMAND}\` before \`harness ci check\`: the traceability check is a pure function of ` +
  `${GRAPH_PATH}, which is gitignored and untracked, so on a bare checkout it reads nothing and reports \`pass\`.`;

/**
 * Reads and parses a `harness traceability --json` report.
 *
 * @returns {{ok: true, report: unknown} | {ok: false, reason: string}}
 */
export function loadTraceabilityReport(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (error) {
    return { ok: false, reason: `cannot read ${path}: ${error.message}` };
  }
  try {
    return { ok: true, report: JSON.parse(raw) };
  } catch (error) {
    return {
      ok: false,
      reason: `${path} is not parseable JSON (${raw.length} bytes) — likely truncated: ${error.message}`,
    };
  }
}

function traced(files) {
  return Array.isArray(files) && files.length > 0;
}

function percent(part, whole) {
  return whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10;
}

/** A tally that has counted nothing yet. Fresh `untraced` array per call. */
function emptyTally() {
  return {
    specs: 0,
    requirements: 0,
    codeTraced: 0,
    testTraced: 0,
    untraced: [],
  };
}

/**
 * The verdict for a report that is not the array of specs, or `null` when the
 * report is readable and the caller should go on to count it.
 *
 * Two unreadable shapes, deliberately given different verdicts. The `error`
 * object is the one a bare checkout actually produces — verified against CLI
 * 11 in a fresh `git clone` of this repo: `harness traceability --json` exits
 * 2 and prints {"error":"No knowledge graph found. Run `harness graph scan`
 * first."}. That is a known cause with a known fix, so it abstains and passes
 * upstream's own sentence through; paraphrasing it into "shape I cannot read"
 * is technically true and useless. Anything else non-array is `unknown` — an
 * upstream rename must surface as "I cannot read this", never as a clean bill
 * of health derived from a field that stopped existing.
 */
function unreadableShapeVerdict(report) {
  if (Array.isArray(report)) return null;
  if (typeof report?.error === 'string') {
    return {
      ...emptyTally(),
      verdict: 'abstain',
      reason: `the traceability report carries no specs, only an error: ${report.error}`,
    };
  }
  return {
    ...emptyTally(),
    verdict: 'unknown',
    reason:
      'the report is not an array of specs — `harness traceability --json` did not produce a shape this can read',
  };
}

/**
 * A spec's requirements, tolerating a spec that carries none.
 *
 * A missing or non-array `requirements` key contributes zero to the
 * denominator rather than throwing: one malformed spec must shrink the
 * measurement honestly, not take the whole gate down.
 */
function requirementsOf(spec) {
  return Array.isArray(spec?.requirements) ? spec.requirements : [];
}

/**
 * How an untraced requirement is named in the report.
 *
 * Every field is optional upstream, so the fallback chain runs all the way to
 * a placeholder — an unnamed row still has to appear in the list, because
 * dropping it would quietly shrink the count of things nothing traces.
 */
function untracedEntry(spec, req) {
  return {
    spec: String(spec?.specPath ?? '(unknown spec)'),
    name: String(req?.requirementName ?? req?.requirementId ?? '(unnamed)'),
  };
}

/** Walks every requirement in every spec, accumulating the coverage counts. */
function tallyRequirements(report) {
  const tally = { ...emptyTally(), specs: report.length };
  for (const spec of report) {
    for (const req of requirementsOf(spec)) {
      tally.requirements += 1;
      const hasCode = traced(req?.codeFiles);
      const hasTest = traced(req?.testFiles);
      if (hasCode) tally.codeTraced += 1;
      if (hasTest) tally.testTraced += 1;
      if (!hasCode && !hasTest) tally.untraced.push(untracedEntry(spec, req));
    }
  }
  return tally;
}

/**
 * Classifies a parsed report into the counts a reader needs.
 *
 * Three outcomes, and the two failing ones are NOT interchangeable. An
 * unreadable shape is `unknown`; zero requirements read from a perfectly
 * readable report is `abstain`, a different finding with a different fix —
 * the graph is missing — and saying which one happened is the point.
 *
 * @returns {{verdict: 'measured'|'abstain'|'unknown', reason?: string,
 *   specs: number, requirements: number, codeTraced: number,
 *   testTraced: number, untraced: {spec: string, name: string}[]}}
 */
export function classifyTraceabilityReport(report) {
  const unreadable = unreadableShapeVerdict(report);
  if (unreadable) return unreadable;

  const tally = tallyRequirements(report);
  if (tally.requirements === 0) {
    return {
      ...tally,
      verdict: 'abstain',
      reason: `zero requirements were read across ${tally.specs} spec(s), so the traceability check verified nothing`,
    };
  }
  return { ...tally, verdict: 'measured' };
}

/**
 * Human-readable lines for a verdict.
 *
 * The counts are rendered as `n/total` rather than a bare percentage on
 * purpose: a percentage is exactly the form in which a zero denominator hides,
 * and the whole point of this surface is that the denominator is visible.
 */
export function traceabilityVerdictLines(v) {
  if (v.verdict !== 'measured') {
    return [`traceability — ABSTAINED: ${v.reason}`, `  ${FIX_STEP}`];
  }
  const lines = [
    `traceability — measured against a real graph: ${v.requirements} requirement(s) across ${v.specs} spec(s).`,
    `  code edges: ${v.codeTraced}/${v.requirements} (${percent(v.codeTraced, v.requirements)}%)`,
    `  test edges: ${v.testTraced}/${v.requirements} (${percent(v.testTraced, v.requirements)}%)`,
  ];
  if (v.untraced.length > 0) {
    lines.push(
      `  ${v.untraced.length} requirement(s) with neither code nor test traced:`,
    );
    for (const item of v.untraced.slice(0, UNTRACED_DETAIL_CAP)) {
      lines.push(`    ${item.spec} — ${item.name}`);
    }
    const hidden = v.untraced.length - UNTRACED_DETAIL_CAP;
    if (hidden > 0) lines.push(`    … +${hidden} more`);
  }
  return lines;
}

/**
 * GitHub annotations. The abstention is an `::error` because it is the false
 * green returning; a thin-but-real coverage number gets none, because it is a
 * measurement rather than a defect and annotating it every run is how a real
 * signal becomes wallpaper.
 */
export function traceabilityAnnotations(v) {
  if (v.verdict === 'measured') return [];
  // Upstream's own error sentence already ends in a full stop, so the joining
  // one is dropped rather than printed as `first.. Run`.
  const reason = String(v.reason ?? '').replace(/\.\s*$/, '');
  return [`::error title=harness traceability::${reason}. ${FIX_STEP}`];
}

function main() {
  const path = process.argv[2] ?? 'traceability-report.json';
  if (path.startsWith('-')) {
    console.error('usage: traceability-verdict.mjs [traceability-report.json]');
    process.exit(2);
  }
  const loaded = loadTraceabilityReport(path);
  const verdict = loaded.ok
    ? classifyTraceabilityReport(loaded.report)
    : { ...emptyTally(), verdict: 'unknown', reason: loaded.reason };
  for (const line of traceabilityVerdictLines(verdict)) console.log(line);
  for (const line of traceabilityAnnotations(verdict)) console.log(line);
  if (verdict.verdict !== 'measured') {
    console.error(`ABSTAINED: ${verdict.reason}`);
    process.exit(3);
  }
  process.exit(0);
}

// Importable as a module (the CI summariser shares the classifier) and
// executable as a CLI. `process.argv[1]` is this file only in the latter case.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
