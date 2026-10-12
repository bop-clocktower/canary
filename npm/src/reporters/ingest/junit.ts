// Ingest reporter: JUnit XML -> result rows, for `canary testtracker push` (#1320).
//
// One reader for the four runners consumers asked for — vitest
// `--reporter=junit`, `node --test --test-reporter=junit`, `newman -r junit`
// and `maestro test --format junit` — and any other runner writing the common
// shape. It reads more than `ts/src/history/formats/junit-report.ts` does (the
// enclosing `<testsuite>` path, skip reasons, retry counts) and lives on this
// side of the CommonJS/ESM boundary, which a module with imports cannot cross
// (see scripts/sync-gate-result.mjs).
import { errorField, MAX_ERROR_MESSAGE, MAX_ERROR_STACK } from './payload.js';
import { skipTags } from './describe.js';

/** One `<testcase>` as read, before it becomes a row. */
interface JunitCase {
  /** `full_title` parts: file, suite path, classname, name (empties dropped). */
  title: string;
  /** The test's file as the report names it, or undefined when it names none. */
  file: string | undefined;
  status: 'passed' | 'failed' | 'flaky' | 'skipped';
  duration_ms?: number;
  error_message?: string;
  error_stack?: string;
  retries: number;
  tags: string[];
}

interface OpenCase {
  attrs: Map<string, string>;
  suites: string[];
  outcomes: Map<string, { message?: string; type?: string; body: string }[]>;
}

/** Surefire's retry encodings; none of the four target runners writes them. */
const RETRY_TAGS = ['flakyFailure', 'flakyError', 'rerunFailure', 'rerunError'];
const OUTCOME_TAGS = new Set(['failure', 'error', 'skipped', ...RETRY_TAGS]);
const TOKEN_RE =
  /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w.:-]*)((?:"[^"]*"|'[^']*'|[^'">])*?)(\/?)>|([^<]+)/g;
const ATTR_RE = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const ROOT_RE =
  /^﻿?\s*(?:<\?[\s\S]*?\?>\s*|<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<(testsuites|testsuite)[\s/>]/;
const ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};

/** True when the text's root element is a JUnit `<testsuites>` / `<testsuite>`. */
export function isJunitXml(text: string): boolean {
  return ROOT_RE.test(text);
}

function decode(text: string): string {
  return text.replace(
    /&(#x[0-9A-Fa-f]+|#[0-9]+|[A-Za-z]+);/g,
    (m, ref: string) => {
      const cp = ref.startsWith('#x')
        ? parseInt(ref.slice(2), 16)
        : ref.startsWith('#')
          ? parseInt(ref.slice(1), 10)
          : NaN;
      if (!Number.isNaN(cp))
        return cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
      return ENTITIES[ref] ?? m;
    },
  );
}

function attrsOf(body: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const m of body.matchAll(ATTR_RE))
    attrs.set(m[1], decode(m[2] ?? m[3] ?? ''));
  return attrs;
}

/** Scan state: the open `<testsuite>` names, the open case and its open outcome. */
interface Scan {
  suites: string[];
  current: OpenCase | null;
  outcome: { body: string } | null;
  cases: OpenCase[];
}

function open(
  scan: Scan,
  name: string,
  attrs: Map<string, string>,
  selfClosing: boolean,
): void {
  if (name === 'testsuite') {
    if (!selfClosing) scan.suites.push(attrs.get('name') ?? '');
  } else if (name === 'testcase') {
    const c: OpenCase = {
      attrs,
      suites: scan.suites.filter(Boolean),
      outcomes: new Map(),
    };
    scan.cases.push(c);
    scan.current = selfClosing ? null : c;
  } else if (scan.current && OUTCOME_TAGS.has(name)) {
    const entry = {
      message: attrs.get('message'),
      type: attrs.get('type'),
      body: '',
    };
    scan.current.outcomes.set(name, [
      ...(scan.current.outcomes.get(name) ?? []),
      entry,
    ]);
    scan.outcome = selfClosing ? null : entry;
  }
}

function close(scan: Scan, name: string): void {
  if (name === 'testsuite') scan.suites.pop();
  else if (name === 'testcase') scan.current = null;
  else if (OUTCOME_TAGS.has(name)) scan.outcome = null;
}

/** One token: CDATA or text feeds the open outcome's body; tags open or close. */
function step(s: Scan, m: RegExpMatchArray): void {
  const text = m[1] ?? (m[6] === undefined ? undefined : decode(m[6]));
  if (text !== undefined) {
    if (s.outcome) s.outcome.body += text;
    return;
  }
  if (m[3] === undefined) return; // a comment or processing instruction
  if (m[2] === '/') close(s, m[3]);
  else open(s, m[3], attrsOf(m[4] ?? ''), m[5] === '/');
}

function scan(xml: string): OpenCase[] {
  const s: Scan = { suites: [], current: null, outcome: null, cases: [] };
  for (const m of xml.matchAll(TOKEN_RE)) step(s, m);
  return s.cases;
}

const PATH_LIKE = /[\\/]|\.(?:[cm]?[jt]sx?|ya?ml|json|feature)$/;
const alnum = (s: string) => s.replace(/[^A-Za-z0-9]/g, '').toLowerCase();

/**
 * The classname, when it says something the title does not already: not
 * node's constant `test`, not the file (vitest), not the name (Maestro), and
 * not the innermost suite re-cased (Newman's UpperCamel request name).
 */
function usefulClassname(
  cls: string | undefined,
  c: OpenCase,
  file: string | undefined,
  name: string,
): string | undefined {
  if (
    !cls ||
    cls === 'test' ||
    cls === file ||
    cls === name ||
    c.suites.includes(cls)
  )
    return undefined;
  if (alnum(cls) === alnum(c.suites.at(-1) ?? '')) return undefined;
  return cls;
}

function statusOf(
  outcomes: OpenCase['outcomes'],
  retries: number,
): JunitCase['status'] {
  if (outcomes.has('failure') || outcomes.has('error')) return 'failed';
  if (outcomes.has('skipped')) return 'skipped';
  return retries > 0 ? 'flaky' : 'passed';
}

/** The final failure explains a failed case; the first retry explains a flaky one. */
function errorOf(outcomes: OpenCase['outcomes']): {
  error_message?: string;
  error_stack?: string;
} {
  const first =
    [...(outcomes.get('failure') ?? []), ...(outcomes.get('error') ?? [])][0] ??
    RETRY_TAGS.flatMap((t) => outcomes.get(t) ?? [])[0];
  if (!first) return {};
  const body = first.body.trim();
  const message = first.message ?? (body || undefined);
  return {
    error_message: errorField(message, MAX_ERROR_MESSAGE),
    ...(body && body !== message
      ? { error_stack: errorField(body, MAX_ERROR_STACK) }
      : {}),
  };
}

/**
 * `todo` (node --test) rides as a tag like Playwright's `fixme`; a skip's
 * message becomes `reason:<text>` (#1183). Node writes `message="true"` for a
 * bare skip, which is not a reason.
 */
function skipTagsOf(outcomes: OpenCase['outcomes']): string[] {
  const tags: string[] = [];
  for (const s of outcomes.get('skipped') ?? []) {
    if (s.type === 'todo') tags.push('todo');
    if (s.message && s.message !== 'true')
      tags.push(...skipTags([{ type: 'skip', description: s.message }]));
  }
  return tags;
}

/** The `file` attribute, else a classname that is a path (vitest). */
function fileOf(attrs: Map<string, string>): string | undefined {
  const cls = attrs.get('classname');
  return attrs.get('file') ?? (cls && PATH_LIKE.test(cls) ? cls : undefined);
}

/** JUnit `time` is fractional seconds and may be absent. */
function durationOf(time: string | undefined): { duration_ms?: number } {
  const seconds = Number(time);
  return time !== undefined && Number.isFinite(seconds) && seconds >= 0
    ? { duration_ms: Math.round(seconds * 1000) }
    : {};
}

function toCase(c: OpenCase): JunitCase {
  const name = c.attrs.get('name') ?? '';
  const file = fileOf(c.attrs);
  const cls = usefulClassname(c.attrs.get('classname'), c, file, name);
  const retries = RETRY_TAGS.reduce(
    (n, t) => n + (c.outcomes.get(t)?.length ?? 0),
    0,
  );
  const inlineTags = [...name.matchAll(/(?:^|\s)@([\w:-]+)/g)].map((m) => m[1]);
  return {
    title: [file, ...c.suites.filter((s) => s !== file), cls, name]
      .filter(Boolean)
      .join(' > '),
    file,
    status: statusOf(c.outcomes, retries),
    ...durationOf(c.attrs.get('time')),
    ...errorOf(c.outcomes),
    retries,
    tags: [...new Set([...inlineTags, ...skipTagsOf(c.outcomes)])],
  };
}

/**
 * Every `<testcase>` in a JUnit report, titled `file > suite… > classname >
 * name` from whichever of those the dialect writes. Titles still shared inside
 * one report (node --test names no file, so two files' `shared name` tests
 * are identical) get ` [2]`, ` [3]` in report order, and `numbered` counts
 * them: both tests stay in the denominator rather than collapsing into one.
 */
export function readJunitCases(xml: string): {
  cases: JunitCase[];
  numbered: number;
} {
  const cases = scan(xml).map(toCase);
  const seen = new Map<string, number>();
  let numbered = 0;
  for (const c of cases) {
    const n = (seen.get(c.title) ?? 0) + 1;
    seen.set(c.title, n);
    if (n > 1) {
      c.title = `${c.title} [${n}]`;
      numbered += 1;
    }
  }
  return { cases, numbered };
}
