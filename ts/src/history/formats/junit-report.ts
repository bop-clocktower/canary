/**
 * JUnit XML -> a v2 history run (#963).
 *
 * One reader for every runner that writes JUnit XML (pytest `--junitxml`,
 * jest-junit, Maven surefire, Gradle, ...). The input is the report's raw
 * text: the CLI has already checked it is well formed (`../../util/xml.ts`).
 * No third-party XML parser, the same call the Cobertura reader made.
 *
 * Mapping:
 *   - test name is `classname::name` (bare `name` when classname is absent);
 *     `file` becomes `test_file` when present.
 *   - `<failure>` / `<error>` -> failed; `<skipped>` -> skipped; else passed.
 *   - `time` is seconds (fractional, may be absent) -> `duration_ms`.
 *
 * Retry encodings recognized as `flaky` (a later attempt passed):
 *   1. surefire `<flakyFailure>` / `<flakyError>` on a case with no final
 *      `<failure>` / `<error>`;
 *   2. surefire `<rerunFailure>` / `<rerunError>` with no final failure (with
 *      one, every rerun failed and the case stays failed);
 *   3. the same `classname::name` repeated in one report (pytest-rerunfailures
 *      and similar): collapsed into one row whose status is the LAST attempt's,
 *      promoted to flaky when an earlier attempt failed; durations are summed.
 * Any other encoding (e.g. retries written to separate report files) is
 * recorded per attempt, as whatever each file says.
 */
import { makeRunId, type RunInput, type TestResultInput } from '../schema.js';

/** The run-level facts the report cannot carry (a subset of RecordContext). */
interface RunContext {
  suite: string;
  repo: string;
  branch: string;
  commitSha: string;
  runId?: string;
  nowMs: number;
}

/** One `<testcase>` as read: attributes plus which outcome children it had. */
interface JunitCase {
  attrs: Map<string, string>;
  children: Set<string>;
  errorText: string | undefined;
}

const ERROR_TEXT_LIMIT = 2000;
const OUTCOME_TAGS = new Set([
  'failure',
  'error',
  'skipped',
  'flakyFailure',
  'flakyError',
  'rerunFailure',
  'rerunError',
]);

// A tag, a CDATA section, or a comment. Quoted attribute values may hold `>`.
const TOKEN_RE =
  /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<(\/?)([A-Za-z_][\w.:-]*)((?:"[^"]*"|'[^']*'|[^'">])*?)(\/?)>/g;
const ATTR_RE = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const ROOT_RE =
  /^\s*(?:<\?[\s\S]*?\?>\s*|<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<(testsuites|testsuite)[\s/>]/;
const ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};

/** A string whose root element (past prolog and comments) is a JUnit suite. */
export function isJunitReport(parsed: unknown): boolean {
  return typeof parsed === 'string' && ROOT_RE.test(parsed);
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|[A-Za-z]+);/g, (m, ref) => {
    const r = String(ref);
    if (r.startsWith('#x'))
      return String.fromCodePoint(parseInt(r.slice(2), 16));
    if (r.startsWith('#'))
      return String.fromCodePoint(parseInt(r.slice(1), 10));
    return ENTITIES[r] ?? m;
  });
}

function parseAttrs(body: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const m of body.matchAll(ATTR_RE)) {
    attrs.set(m[1]!, decodeEntities(m[2] ?? m[3] ?? ''));
  }
  return attrs;
}

/** Mutable scan state: the open testcase and the open outcome child's text. */
interface ScanState {
  current: JunitCase | null;
  outcomeStart: number;
  cases: JunitCase[];
}

function openTag(
  state: ScanState,
  name: string,
  body: string,
  selfClosing: boolean,
  end: number,
): void {
  if (name === 'testcase') {
    const c: JunitCase = {
      attrs: parseAttrs(body),
      children: new Set(),
      errorText: undefined,
    };
    state.cases.push(c);
    state.current = selfClosing ? null : c;
    return;
  }
  if (state.current === null || !OUTCOME_TAGS.has(name)) return;
  state.current.children.add(name);
  captureMessage(state.current, name, parseAttrs(body).get('message'));
  state.outcomeStart = selfClosing ? -1 : end;
}

/** The first failure-ish message wins; skipped reasons are not errors. */
function captureMessage(
  c: JunitCase,
  name: string,
  message: string | undefined,
): void {
  if (name === 'skipped' || c.errorText !== undefined) return;
  if (message !== undefined) c.errorText = message;
}

function closeTag(state: ScanState, name: string, text: string): void {
  if (name === 'testcase') {
    state.current = null;
    return;
  }
  if (state.current === null || state.outcomeStart < 0) return;
  appendBody(state.current, name, text);
  state.outcomeStart = -1;
}

function appendBody(c: JunitCase, name: string, text: string): void {
  const body = text.trim();
  if (name === 'skipped' || body === '') return;
  c.errorText = c.errorText === undefined ? body : `${c.errorText}\n${body}`;
}

/** Inner text of an outcome element: entity-decoded, CDATA unwrapped. */
function innerText(xml: string, from: number, to: number): string {
  const slice = xml.slice(from, to);
  return slice
    .split(/(<!\[CDATA\[[\s\S]*?\]\]>)/)
    .map((part) =>
      part.startsWith('<![CDATA[')
        ? part.slice(9, -3)
        : decodeEntities(part.replace(/<[^>]*>/g, '')),
    )
    .join('');
}

function scanCases(xml: string): JunitCase[] {
  const state: ScanState = { current: null, outcomeStart: -1, cases: [] };
  for (const m of xml.matchAll(TOKEN_RE)) {
    if (m[1] !== undefined || m[3] === undefined) continue; // CDATA / comment
    const end = m.index + m[0].length;
    if (m[2] === '/') {
      const text =
        state.outcomeStart < 0
          ? ''
          : innerText(xml, state.outcomeStart, m.index);
      closeTag(state, m[3], text);
    } else {
      openTag(state, m[3], m[4] ?? '', m[5] === '/', end);
    }
  }
  return state.cases;
}

function caseStatus(children: Set<string>): string {
  if (children.has('failure') || children.has('error')) return 'failed';
  if (children.has('skipped')) return 'skipped';
  const retried = ['flakyFailure', 'flakyError', 'rerunFailure', 'rerunError'];
  return retried.some((t) => children.has(t)) ? 'flaky' : 'passed';
}

function caseName(attrs: Map<string, string>): string {
  const name = attrs.get('name') ?? '';
  const classname = attrs.get('classname');
  // No invented fallback for a nameless case: the name is the join key, and a
  // nameless row fails validation instead.
  return classname && name ? `${classname}::${name}` : name;
}

function toMs(time: string | undefined): number {
  const seconds = Number(time);
  return time !== undefined && Number.isFinite(seconds)
    ? Math.round(seconds * 1000)
    : 0;
}

function toRow(
  c: JunitCase,
  ids: { runId: string; suite: string; repo: string },
): TestResultInput {
  return {
    run_id: ids.runId,
    suite: ids.suite,
    repo: ids.repo,
    test_name: caseName(c.attrs),
    test_file: c.attrs.get('file') ?? '',
    status: caseStatus(c.children),
    duration_ms: toMs(c.attrs.get('time')),
    ...(c.errorText === undefined
      ? {}
      : { error_text: c.errorText.slice(0, ERROR_TEXT_LIMIT) }),
  };
}

/** Fold a repeated name into its earlier row (encoding 3 above). */
function mergeAttempt(prev: TestResultInput, next: TestResultInput): void {
  const earlierFailed = prev.status === 'failed' || prev.status === 'flaky';
  prev.duration_ms = (prev.duration_ms ?? 0) + (next.duration_ms ?? 0);
  prev.status =
    next.status === 'passed' && earlierFailed ? 'flaky' : next.status;
  if (next.error_text !== undefined) prev.error_text = next.error_text;
}

function collapseAttempts(rows: TestResultInput[]): TestResultInput[] {
  const byName = new Map<string, TestResultInput>();
  const out: TestResultInput[] = [];
  for (const row of rows) {
    const prev = row.test_name ? byName.get(row.test_name) : undefined;
    if (prev === undefined) {
      if (row.test_name) byName.set(row.test_name, row);
      out.push(row);
    } else {
      mergeAttempt(prev, row);
    }
  }
  return out;
}

function readRows(
  xml: string,
  ids: { runId: string; suite: string; repo: string },
): TestResultInput[] {
  return collapseAttempts(scanCases(xml).map((c) => toRow(c, ids)));
}

/** Per-test result count after collapsing repeated attempts. */
export function countJunitResults(parsed: unknown): number {
  return readRows(String(parsed), { runId: '', suite: '', repo: '' }).length;
}

/** The first suite `timestamp`, read as UTC when it carries no zone. */
function startedAt(xml: string, nowMs: number): number {
  const m = /<testsuites?\b[^>]*?\btimestamp\s*=\s*["']([^"']+)["']/.exec(xml);
  if (m === null) return nowMs;
  const raw = m[1]!;
  const zoned = /(?:Z|[+-]\d\d:?\d\d)$/.test(raw) ? raw : `${raw}Z`;
  const ms = Date.parse(zoned);
  return Number.isNaN(ms) ? nowMs : ms;
}

/** Convert a JUnit XML report's text into a run + its per-test rows. */
export function readJunitReport(
  parsed: unknown,
  ctx: RunContext,
): { run: RunInput; results: TestResultInput[] } {
  const xml = String(parsed);
  const startedMs = startedAt(xml, ctx.nowMs);
  const runId =
    ctx.runId ??
    makeRunId(ctx.suite, ctx.commitSha, Math.floor(startedMs / 1000));
  const results = readRows(xml, { runId, suite: ctx.suite, repo: ctx.repo });
  const count = (status: string): number =>
    results.filter((r) => r.status === status).length;

  const run: RunInput = {
    run_id: runId,
    suite: ctx.suite,
    repo: ctx.repo,
    branch: ctx.branch,
    commit_sha: ctx.commitSha,
    timestamp: new Date(startedMs).toISOString().replace('Z', '+00:00'),
    total: results.length,
    passed: count('passed'),
    failed: count('failed'),
    flaky: count('flaky'),
    skipped: count('skipped'),
    duration_ms: results.reduce((n, r) => n + (r.duration_ms ?? 0), 0),
  };
  return { run, results };
}
