// Baseline / ratchet mode shared by the skill scanners (#1322).
//
// An advisory scanner whose count nobody watches stops being read: in one
// consuming monorepo canary-savant and canary-blackhawk ran on every PR with
// 169 and 360 findings and nothing noticed them grow. A committed baseline
// turns the count into a ratchet -- a run fails only on a finding the baseline
// does not already hold, and a fixed finding is reported as shrinkage, never as
// a failure.
//
// ONE file format, ONE comparison and ONE exit-code contract, so a team can
// read any canary baseline the same way. The engine's `canary vacuity-check`
// cannot import this file (skills ship without the engine and the engine is
// compiled TypeScript), so ts/src/core/scan-baseline.ts is a port of it, and
// ts/test/scan-baseline-conformance.test.ts requires both to produce the same
// bytes and the same comparison for a shared corpus.
//
// ## Identity
//
// A finding is keyed on (file, rule, anchor), never on its line number: a
// baseline keyed on lines breaks the moment anyone adds an import above the
// finding. The anchor is the most stable thing the scanner knows about the
// finding -- the test name for vacuity-check, the offending source line for
// savant and blackhawk -- with whitespace runs collapsed so a re-indent is not
// a new finding. Identical identities form a MULTISET (the perf ratchet's
// rule, #853): a file that holds one baselined `new Date()` and gains a
// second has one new finding, and a set would swallow it.
//
// The run contract (flags, exit codes, reports) lives in scan-baseline-run.mjs.
//
// Standard library only, and every Node global is imported, because this
// directory is vendored verbatim into consumer repos (lib-portability.test.ts).

import path from 'node:path';
import process from 'node:process';

const BASELINE_SCHEMA_VERSION = 1;

/** Collapse whitespace runs so a re-indented line keeps its identity. */
function normalizeAnchor(anchor) {
  return String(anchor ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A path relative to `cwd`, with forward slashes on every platform. */
function normalizeFile(file, cwd) {
  const rel = path.relative(cwd, path.resolve(cwd, String(file)));
  return rel.split(path.sep).join('/');
}

/** The line-free identity of one finding. */
export function identityOf(finding, cwd = process.cwd()) {
  return {
    file: normalizeFile(finding.file, cwd),
    rule: String(finding.rule),
    anchor: normalizeAnchor(finding.anchor),
  };
}

const keyOf = (id) => `${id.file}\u0000${id.rule}\u0000${id.anchor}`;

const byIdentity = (a, b) =>
  cmp(a.file, b.file) || cmp(a.rule, b.rule) || cmp(a.anchor, b.anchor);

// Code-unit order, not localeCompare: the file must sort the same on every
// machine, whatever its locale, or two clean runs would disagree in a diff.
function cmp(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Fold identities into a Map of key -> {file, rule, anchor, count}. */
function tally(identities) {
  const counts = new Map();
  for (const id of identities) {
    const key = keyOf(id);
    const seen = counts.get(key);
    if (seen) seen.count += 1;
    else counts.set(key, { ...id, count: 1 });
  }
  return counts;
}

/** A baseline object for `tool` holding `identities`, entries sorted. */
export function buildBaseline(tool, identities) {
  const findings = [...tally(identities).values()].sort(byIdentity);
  return { schemaVersion: BASELINE_SCHEMA_VERSION, tool, findings };
}

export function serializeBaseline(baseline) {
  return JSON.stringify(baseline, null, 2) + '\n';
}

function entryProblem(e) {
  if (!e || typeof e !== 'object') return 'is not an object';
  for (const k of ['file', 'rule', 'anchor']) {
    if (typeof e[k] !== 'string') return `has no string '${k}'`;
  }
  if (!Number.isInteger(e.count) || e.count < 1) {
    return "has a 'count' that is not a positive integer";
  }
  return null;
}

function shapeProblem(data, tool) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return 'is not a JSON object';
  }
  if (data.schemaVersion !== BASELINE_SCHEMA_VERSION) {
    return `has schemaVersion ${JSON.stringify(data.schemaVersion)}, expected ${BASELINE_SCHEMA_VERSION}`;
  }
  if (data.tool !== tool) {
    return `was written by '${data.tool}', not '${tool}'`;
  }
  if (!Array.isArray(data.findings)) return "has no 'findings' array";
  return null;
}

function findingsProblem(findings) {
  const seen = new Set();
  for (const [i, e] of findings.entries()) {
    const bad = entryProblem(e);
    if (bad) return `entry ${i} ${bad}`;
    const key = keyOf(e);
    if (seen.has(key)) return `entry ${i} is a duplicate identity`;
    seen.add(key);
  }
  return null;
}

/**
 * Parse baseline text written for `tool`. Returns `{baseline}` or `{error}`;
 * a malformed file is an error, never an empty baseline, because an empty
 * baseline would turn every finding "new" -- or, read the other way round, a
 * crash-shaped file would be the quietest possible way to disable the gate.
 */
export function parseBaseline(text, tool) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { error: `is not valid JSON (${e.message})` };
  }
  const problem = shapeProblem(data, tool) ?? findingsProblem(data.findings);
  if (problem) return { error: problem };
  const findings = data.findings.map(({ file, rule, anchor, count }) => ({
    file,
    rule,
    anchor,
    count,
  }));
  return {
    baseline: { schemaVersion: data.schemaVersion, tool: data.tool, findings },
  };
}

/** Multiset difference between `baseline` and the current `identities`. */
export function compareBaseline(baseline, identities) {
  const base = new Map(baseline.findings.map((e) => [keyOf(e), e]));
  const head = tally(identities);
  const added = [];
  const fixed = [];
  let baselined = 0;
  for (const [key, e] of head) {
    const had = base.get(key)?.count ?? 0;
    baselined += Math.min(had, e.count);
    if (e.count > had) added.push({ ...e, count: e.count - had });
  }
  for (const [key, e] of base) {
    const has = head.get(key)?.count ?? 0;
    if (e.count > has) fixed.push({ ...e, count: e.count - has });
  }
  return {
    baselined,
    new: added.sort(byIdentity),
    fixed: fixed.sort(byIdentity),
    newCount: added.reduce((n, e) => n + e.count, 0),
    fixedCount: fixed.reduce((n, e) => n + e.count, 0),
  };
}
