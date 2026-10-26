// Ingest reporter: redact credentials out of free text before it leaves the run (#1354).
//
// Live-environment suites sign in as real test members, and their failures
// echo what a step typed or saw: emails, passwords, bearer tokens. TestTracker
// is a management dashboard, so none of that may reach it. Redaction is ON by
// default; `CANARY_INGEST_REDACT=0` (or `false`) turns it off.
import type { CollectedEntry, ResultEntry } from './types.js';

/**
 * A maximal run of dot-separated token segments. `.` is not a segment
 * character, so the pattern has one way to match and stays linear.
 */
const DOTTED_RUN = /[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*/g;
/** A JWT may start a segment or follow a `-` in it (the old `\b`), never a word char. */
const JWT_START = /(?:^|-)(eyJ[A-Za-z0-9_-])/;

/**
 * `eyJ…` header, payload, signature: a JWT. Checked before the bare rule.
 *
 * Same matches as `/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g`,
 * which was quadratic (#1400, CWE-1333): it retried from every `eyJ` in a run
 * and rescanned the run each time. Every start in one segment shares the same
 * tail, so only the leftmost start per segment is tried, once per dotted run.
 */
function redactJwts(text: string): string {
  return text.replace(DOTTED_RUN, (run) => {
    const segs = run.split('.');
    const out: string[] = [];
    let i = 0;
    while (i < segs.length) {
      const start = i + 2 < segs.length ? JWT_START.exec(segs[i]) : null;
      if (!start) {
        out.push(segs[i++]);
        continue;
      }
      const at = start.index + start[0].length - start[1].length;
      out.push(`${segs[i].slice(0, at)}<token>`);
      i += 3;
    }
    return out.join('.');
  });
}
// The lookbehind starts a match only at the beginning of a run, which keeps a
// long run with no `@` linear instead of quadratic (8 KB stacks go through it).
const EMAIL =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
/**
 * A run of 32+ token characters. `/` and `.` are deliberately not token
 * characters, so a stack frame's file path is never swallowed whole.
 */
const BARE =
  /(?<![A-Za-z0-9_+=-]|<secret:)[A-Za-z0-9_+=-]{32,}(?![A-Za-z0-9_+=-])/g;
const HAS_DIGIT = /[0-9]/;
const HAS_LETTER = /[A-Za-z]/;

/**
 * Named values shorter than this are skipped: replacing every `a1` or `true`
 * in a failure would shred the text, and a value that short is not a secret
 * the dashboard can be protected from by substring matching anyway.
 */
const MIN_NAMED_SECRET_LENGTH = 6;

function enabled(env: NodeJS.ProcessEnv): boolean {
  const flag = env.CANARY_INGEST_REDACT?.trim().toLowerCase();
  return flag !== '0' && flag !== 'false';
}

/** `CANARY_INGEST_REDACT_ENV=A,B`: the literal values of those env vars, longest first. */
function namedSecrets(
  env: NodeJS.ProcessEnv,
): Array<[name: string, value: string]> {
  const names = (env.CANARY_INGEST_REDACT_ENV ?? '')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
  return names
    .map((name): [string, string] => [name, env[name] ?? ''])
    .filter(([, value]) => value.length >= MIN_NAMED_SECRET_LENGTH)
    .sort((a, b) => b[1].length - a[1].length);
}

type Span = { start: number; end: number; name: string };

/** Every occurrence of `needle` in `text`, overlapping ones included, by start. */
function spansOf(text: string, needle: string, name: string): Span[] {
  const spans: Span[] = [];
  for (
    let at = text.indexOf(needle);
    at !== -1;
    at = text.indexOf(needle, at + 1)
  )
    spans.push({ start: at, end: at + needle.length, name });
  return spans;
}

/** How many of `spans` (sorted by start) start before `at`. */
function countBefore(spans: Span[], at: number): number {
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid].start < at) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** reach[i]: the furthest end among spans[0..i]. */
const reachOf = (spans: Span[]) => {
  let far = -1;
  return spans.map((s) => (far = Math.max(far, s.end)));
};

/**
 * One pass over the text, not one per name (#1400). buildPayload redacts every
 * field twice, so a value that is a substring of a placeholder this pass
 * writes (`TOK='secret'`, or one name's value being another's name) must not
 * be replaced again inside it: a configured placeholder is kept when every
 * value occurrence touching it lies wholly inside it. A value always beats a
 * placeholder it overlaps (#1400 F1(a)): an occurrence that starts inside a
 * placeholder and runs past its end, or starts before it, is redacted even
 * though that breaks the placeholder, because keeping the placeholder would
 * leave the rest of the value in the text. Only the configured names'
 * placeholders are kept: a looser `<secret:…>` shape would let failure text
 * hide a value from redaction. Overlapping value occurrences merge into one
 * redacted span named by the leftmost (then longest) value. Sorted spans and
 * prefix reaches keep it O(n log n): failure text can repeat a placeholder
 * thousands of times.
 */
function replaceNamed(text: string, env: NodeJS.ProcessEnv): string {
  const byValue = namesByValue(env);
  const values = valueSpans(text, byValue);
  if (values.length === 0) return text;
  const kept = keptPlaceholders(text, byValue, values);
  const keptReach = reachOf(kept);
  return renderSpans(
    text,
    values.filter((v) => furthestEnd(kept, keptReach, v.start + 1) < v.end),
  );
}

/** Two names with one value: the first listed (longest first) names it. */
function namesByValue(env: NodeJS.ProcessEnv): Map<string, string> {
  const byValue = new Map<string, string>();
  for (const [name, value] of namedSecrets(env))
    if (!byValue.has(value)) byValue.set(value, name);
  return byValue;
}

const byStart = (a: Span, b: Span) => a.start - b.start || b.end - a.end;

/** Every occurrence of every configured value, sorted by start. */
function valueSpans(text: string, byValue: Map<string, string>): Span[] {
  return [...byValue]
    .flatMap(([value, name]) => spansOf(text, value, name))
    .sort(byStart);
}

/** The furthest end among `spans` that start before `at`, or -1 if none. */
function furthestEnd(spans: Span[], reach: number[], at: number): number {
  const n = countBefore(spans, at);
  return n === 0 ? -1 : reach[n - 1];
}

/**
 * The configured placeholders no value overlaps from outside, sorted by
 * start. A value starting before p must end by p.start; one starting inside
 * p must end by p.end. The reach of everything starting before p.end checks
 * both.
 */
function keptPlaceholders(
  text: string,
  byValue: Map<string, string>,
  values: Span[],
): Span[] {
  const reach = reachOf(values);
  return [...new Set(byValue.values())]
    .flatMap((name) => spansOf(text, `<secret:${name}>`, name))
    .filter(
      (p) =>
        furthestEnd(values, reach, p.start) <= p.start &&
        furthestEnd(values, reach, p.end) <= p.end,
    )
    .sort(byStart);
}

/** Replaces each run of overlapping spans with its first span's placeholder. */
function renderSpans(text: string, hits: Span[]): string {
  let out = '';
  let pos = 0;
  for (let i = 0; i < hits.length;) {
    const { start, name } = hits[i];
    let end = hits[i].end;
    for (i++; i < hits.length && hits[i].start < end; i++)
      end = Math.max(end, hits[i].end);
    out += `${text.slice(pos, start)}<secret:${name}>`;
    pos = end;
  }
  return out + text.slice(pos);
}

/** The rules a test title gets: named secrets, JWTs and emails. Never the bare rule. */
function titleRules(text: string, env: NodeJS.ProcessEnv): string {
  return redactJwts(replaceNamed(text, env)).replace(EMAIL, '<email>');
}

/**
 * Redacts a failure message, stack or skip reason. Adds the bare-credential
 * rule: 32+ token characters containing BOTH a digit and a letter, so a long
 * CamelCase identifier or a long number survives. A 40-hex git SHA does not
 * survive; that trade was accepted at the #1354 security-fleet CONFIRM, since
 * many API keys are hex.
 */
export function redactText(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!enabled(env)) return text;
  return titleRules(text, env).replace(BARE, (run) =>
    HAS_DIGIT.test(run) && HAS_LETTER.test(run) ? '<token>' : run,
  );
}

/**
 * Redacts a test title. Titles are the row identity (`full_title`), so they
 * get only the rules that cannot match an ordinary identifier.
 */
export function redactTitle(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return enabled(env) ? titleRules(text, env) : text;
}

/** A `reason:<text>` tag carries a skip message, so it gets the full text rules. */
function redactTag(tag: string, env: NodeJS.ProcessEnv = process.env): string {
  return tag.startsWith('reason:')
    ? `reason:${redactText(tag.slice('reason:'.length), env)}`
    : tag;
}

/**
 * The pass every pushed row goes through in buildPayload, whichever path built
 * it. `errorField` already redacted message and stack before truncating, with
 * `process.env`; this pass applies the caller's env, which
 * `canary testtracker push` resolves on its own. Idempotent.
 */
export function redactEntry(
  r: ResultEntry,
  env: NodeJS.ProcessEnv = process.env,
): ResultEntry {
  return {
    ...r,
    full_title: redactTitle(r.full_title, env),
    tags: r.tags.map((t) => redactTag(t, env)),
    ...(r.error_message !== undefined
      ? { error_message: redactText(r.error_message, env) }
      : {}),
    ...(r.error_stack !== undefined
      ? { error_stack: redactText(r.error_stack, env) }
      : {}),
  };
}

/**
 * Redacts the catalog and collapses titles that now read the same into one
 * entry (tags merged): the dashboard keys the catalog by title too.
 */
export function redactCatalog(
  entries: CollectedEntry[],
  env: NodeJS.ProcessEnv = process.env,
): CollectedEntry[] {
  const byTitle = new Map<string, CollectedEntry>();
  for (const c of entries) {
    const full_title = redactTitle(c.full_title, env);
    const tags = c.tags.map((t) => redactTag(t, env));
    const prior = byTitle.get(full_title);
    byTitle.set(
      full_title,
      prior
        ? { ...prior, tags: [...new Set([...prior.tags, ...tags])] }
        : { ...c, full_title, tags },
    );
  }
  return [...byTitle.values()];
}
