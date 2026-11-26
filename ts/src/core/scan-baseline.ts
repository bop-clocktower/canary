/**
 * The scanner baseline's file format, identity and comparison (#1322).
 *
 * A port of `agents/skills/lib/scan-baseline.mjs`, which canary-savant and
 * canary-blackhawk use: skills ship without the engine and the engine is
 * compiled TypeScript, so neither can import the other. The feature's point is
 * ONE format and ONE comparison across `canary vacuity-check` and both skills,
 * so `test/scan-baseline-conformance.test.ts` runs a shared corpus through both
 * copies and requires the same bytes. Change one, change both.
 *
 * A finding is keyed on (file, rule, anchor), never its line: the anchor is the
 * most stable thing a scanner knows -- for vacuity-check the test name -- with
 * whitespace runs collapsed. Identical identities form a MULTISET (the perf
 * ratchet's rule, #853), so a second copy of a baselined finding is new.
 *
 * The run contract (flags, exit codes, reports) is `scan-baseline-run.ts`.
 */

import { relative, resolve, sep } from 'node:path';

const BASELINE_SCHEMA_VERSION = 1;

export interface FindingIdentity {
  file: string;
  rule: string;
  anchor: string;
}

export interface BaselineEntry extends FindingIdentity {
  count: number;
}

export interface Baseline {
  schemaVersion: number;
  tool: string;
  findings: BaselineEntry[];
}

export interface BaselineComparison {
  baselined: number;
  new: BaselineEntry[];
  fixed: BaselineEntry[];
  newCount: number;
  fixedCount: number;
}

/** Collapse whitespace runs so a re-indented line keeps its identity. */
function normalizeAnchor(anchor: unknown): string {
  return String(anchor ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A path relative to `cwd`, with forward slashes on every platform. */
function normalizeFile(file: string, cwd: string): string {
  return relative(cwd, resolve(cwd, file)).split(sep).join('/');
}

/** The line-free identity of one finding. */
export function identityOf(
  finding: FindingIdentity,
  cwd: string = process.cwd(),
): FindingIdentity {
  return {
    file: normalizeFile(String(finding.file), cwd),
    rule: String(finding.rule),
    anchor: normalizeAnchor(finding.anchor),
  };
}

const keyOf = (id: FindingIdentity): string =>
  `${id.file}\u0000${id.rule}\u0000${id.anchor}`;

// Code-unit order, not localeCompare: the file must sort the same on every
// machine, whatever its locale, or two clean runs would disagree in a diff.
function cmp(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

const byIdentity = (a: FindingIdentity, b: FindingIdentity): number =>
  cmp(a.file, b.file) || cmp(a.rule, b.rule) || cmp(a.anchor, b.anchor);

function tally(identities: FindingIdentity[]): Map<string, BaselineEntry> {
  const counts = new Map<string, BaselineEntry>();
  for (const id of identities) {
    const key = keyOf(id);
    const seen = counts.get(key);
    if (seen) seen.count += 1;
    else counts.set(key, { ...id, count: 1 });
  }
  return counts;
}

/** A baseline object for `tool` holding `identities`, entries sorted. */
export function buildBaseline(
  tool: string,
  identities: FindingIdentity[],
): Baseline {
  const findings = [...tally(identities).values()].sort(byIdentity);
  return { schemaVersion: BASELINE_SCHEMA_VERSION, tool, findings };
}

export function serializeBaseline(baseline: Baseline): string {
  return JSON.stringify(baseline, null, 2) + '\n';
}

type Loose = Record<string, unknown>;

function entryProblem(e: unknown): string | null {
  if (!e || typeof e !== 'object') return 'is not an object';
  const o = e as Loose;
  for (const k of ['file', 'rule', 'anchor']) {
    if (typeof o[k] !== 'string') return `has no string '${k}'`;
  }
  if (!Number.isInteger(o.count) || (o.count as number) < 1) {
    return "has a 'count' that is not a positive integer";
  }
  return null;
}

function shapeProblem(data: unknown, tool: string): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return 'is not a JSON object';
  }
  const o = data as Loose;
  if (o.schemaVersion !== BASELINE_SCHEMA_VERSION) {
    return `has schemaVersion ${JSON.stringify(o.schemaVersion)}, expected ${BASELINE_SCHEMA_VERSION}`;
  }
  if (o.tool !== tool) {
    return `was written by '${String(o.tool)}', not '${tool}'`;
  }
  if (!Array.isArray(o.findings)) return "has no 'findings' array";
  return null;
}

function findingsProblem(findings: unknown[]): string | null {
  const seen = new Set<string>();
  for (const [i, e] of findings.entries()) {
    const bad = entryProblem(e);
    if (bad) return `entry ${i} ${bad}`;
    const key = keyOf(e as FindingIdentity);
    if (seen.has(key)) return `entry ${i} is a duplicate identity`;
    seen.add(key);
  }
  return null;
}

/**
 * Parse baseline text written for `tool`: `{baseline}` or `{error}`. A
 * malformed file is an error, never an empty baseline -- a crash-shaped file
 * must not be the quietest possible way to disable the gate.
 */
export function parseBaseline(
  text: string,
  tool: string,
): { baseline?: Baseline; error?: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { error: `is not valid JSON (${(e as Error).message})` };
  }
  const problem =
    shapeProblem(data, tool) ?? findingsProblem((data as Loose).findings as []);
  if (problem) return { error: problem };
  const o = data as Baseline;
  const findings = o.findings.map(({ file, rule, anchor, count }) => ({
    file,
    rule,
    anchor,
    count,
  }));
  return {
    baseline: { schemaVersion: o.schemaVersion, tool: o.tool, findings },
  };
}

const total = (entries: BaselineEntry[]): number =>
  entries.reduce((n, e) => n + e.count, 0);

/** Multiset difference between `baseline` and the current `identities`. */
export function compareBaseline(
  baseline: Baseline,
  identities: FindingIdentity[],
): BaselineComparison {
  const base = new Map(baseline.findings.map((e) => [keyOf(e), e]));
  const head = tally(identities);
  const added: BaselineEntry[] = [];
  const fixed: BaselineEntry[] = [];
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
    newCount: total(added),
    fixedCount: total(fixed),
  };
}
