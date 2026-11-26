/**
 * Redacts failure text before run history stores or pushes it (#1566).
 *
 * The credential rules are a port of the TestTracker reporter's
 * `npm/src/reporters/ingest/redact.ts` (#1354, #1400): emails, JWTs, the
 * values of env vars named in `CANARY_INGEST_REDACT_ENV`, and bare 32+
 * token-character runs holding a digit and a letter. `test/redact-parity.test.ts`
 * runs both on the same inputs, so a rule changed on one side alone fails.
 * History adds two rules the dashboard path does not need: raw ANSI is
 * stripped, and an absolute path outside the repo becomes `<path>/<basename>`
 * (one inside it becomes repo-relative), because a checkout or home
 * directory names the machine's user (CWE-359).
 *
 * The same `CANARY_INGEST_REDACT=0` opt-out applies, so one switch governs
 * every place canary sends failure text. Pure apart from the `process.env` /
 * `process.cwd()` defaults.
 */

/** A maximal run of dot-separated token segments; one way to match, linear. */
const DOTTED_RUN = /[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*/g;
/** A JWT may start a segment or follow a `-` in it, never a word char. */
const JWT_START = /(?:^|-)(eyJ[A-Za-z0-9_-])/;

/** `eyJ…` header, payload, signature. Leftmost start per segment, once (#1400). */
function redactJwts(text: string): string {
  return text.replace(DOTTED_RUN, (run) => {
    const segs = run.split('.');
    const out: string[] = [];
    let i = 0;
    while (i < segs.length) {
      const seg = segs[i]!;
      const start = i + 2 < segs.length ? JWT_START.exec(seg) : null;
      if (!start) {
        out.push(seg);
        i++;
        continue;
      }
      const at = start.index + start[0].length - start[1]!.length;
      out.push(`${seg.slice(0, at)}<token>`);
      i += 3;
    }
    return out.join('.');
  });
}

// The lookbehind starts a match only at the beginning of a run (linear).
const EMAIL =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
/** `/` and `.` are not token characters, so a file path is never swallowed. */
const BARE =
  /(?<![A-Za-z0-9_+=-]|<secret:)[A-Za-z0-9_+=-]{32,}(?![A-Za-z0-9_+=-])/g;
const HAS_DIGIT = /[0-9]/;
const HAS_LETTER = /[A-Za-z]/;
/** Shorter named values would shred the text, and are not protectable anyway. */
const MIN_NAMED_SECRET_LENGTH = 6;

type Env = Readonly<Record<string, string | undefined>>;

function enabled(env: Env): boolean {
  const flag = env['CANARY_INGEST_REDACT']?.trim().toLowerCase();
  return flag !== '0' && flag !== 'false';
}

/** Configured value -> the first (longest-first) name that carries it. */
function namesByValue(env: Env): Map<string, string> {
  const pairs = (env['CANARY_INGEST_REDACT_ENV'] ?? '')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean)
    .map((name): [string, string] => [name, env[name] ?? ''])
    .filter(([, value]) => value.length >= MIN_NAMED_SECRET_LENGTH)
    .sort((a, b) => b[1].length - a[1].length);
  const byValue = new Map<string, string>();
  for (const [name, value] of pairs)
    if (!byValue.has(value)) byValue.set(value, name);
  return byValue;
}

interface Span {
  start: number;
  end: number;
  name: string;
}

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

const byStart = (a: Span, b: Span) => a.start - b.start || b.end - a.end;

/** reach[i]: the furthest end among spans[0..i]. */
function reachOf(spans: Span[]): number[] {
  let far = -1;
  return spans.map((s) => (far = Math.max(far, s.end)));
}

/** The furthest end among sorted `spans` that start before `at`, or -1. */
function furthestEnd(spans: Span[], reach: number[], at: number): number {
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid]!.start < at) lo = mid + 1;
    else hi = mid;
  }
  return lo === 0 ? -1 : reach[lo - 1]!;
}

/**
 * Named values in one pass (#1400). A configured placeholder no value
 * overlaps from outside is kept, so a second pass never re-redacts inside it;
 * a value that runs past a placeholder still wins. Overlapping occurrences
 * merge into one span named by the leftmost (then longest) value.
 */
function replaceNamed(text: string, env: Env): string {
  const byValue = namesByValue(env);
  const values = [...byValue]
    .flatMap(([value, name]) => spansOf(text, value, name))
    .sort(byStart);
  if (values.length === 0) return text;
  const valueReach = reachOf(values);
  const kept = [...new Set(byValue.values())]
    .flatMap((name) => spansOf(text, `<secret:${name}>`, name))
    .filter(
      (p) =>
        furthestEnd(values, valueReach, p.start) <= p.start &&
        furthestEnd(values, valueReach, p.end) <= p.end,
    )
    .sort(byStart);
  const keptReach = reachOf(kept);
  const hits = values.filter(
    (v) => furthestEnd(kept, keptReach, v.start + 1) < v.end,
  );
  let out = '';
  let pos = 0;
  for (let i = 0; i < hits.length;) {
    const { start, name } = hits[i]!;
    let end = hits[i]!.end;
    for (i++; i < hits.length && hits[i]!.start < end; i++)
      end = Math.max(end, hits[i]!.end);
    out += `${text.slice(pos, start)}<secret:${name}>`;
    pos = end;
  }
  return out + text.slice(pos);
}

/**
 * The #1354 failure-text rules, byte-for-byte with the npm reporter's
 * `redactText`. Idempotent. Exported for the parity test.
 */
export function redactCredentials(
  text: string,
  env: Env = process.env,
): string {
  if (!enabled(env)) return text;
  return redactJwts(replaceNamed(text, env))
    .replace(EMAIL, '<email>')
    .replace(BARE, (run) =>
      HAS_DIGIT.test(run) && HAS_LETTER.test(run) ? '<token>' : run,
    );
}

// CSI (`ESC [ … final`) and OSC (`ESC ] … BEL|ST`) sequences, then any lone ESC.
const ANSI =
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b/g;

/**
 * An absolute path of two or more segments, optionally as a `file://` URL:
 * POSIX `/a/b` or Windows `C:\a\b`. It must start the text or follow a
 * space, bracket, quote, `=` or `,`, so a URL's `/path` after its host is
 * left alone. Segments stop at `:`, keeping a frame's `:line:col` outside.
 */
const ABS_PATH =
  /(?<=^|[\s([{<'"`=,])(?:file:\/\/\/(?=[A-Za-z]:)|file:\/\/)?(?:\/|[A-Za-z]:[\\/])[^\s\\/:'"`()<>[\]{},;]+(?:[\\/][^\s\\/:'"`()<>[\]{},;]+)+/g;

function rewritePaths(text: string, root: string): string {
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '');
  return text.replace(ABS_PATH, (raw) => {
    const p = raw
      .replace(/^file:\/\/(?:\/(?=[A-Za-z]:))?/, '')
      .replace(/\\/g, '/');
    if (base.length > 0 && p.startsWith(`${base}/`))
      return p.slice(base.length + 1);
    return `<path>/${p.slice(p.lastIndexOf('/') + 1)}`;
  });
}

/**
 * Everything run history stores for failure text: ANSI stripped, the #1354
 * credential rules, then absolute paths rewritten against `root`. Must run
 * before any truncation, so a cut never leaves a fragment of a value.
 * Idempotent; the opt-out disables all of it, as it does on the npm path.
 */
export function redactFailureText(
  text: string,
  env: Env = process.env,
  root: string = process.cwd(),
): string {
  if (!enabled(env)) return text;
  return rewritePaths(redactCredentials(text.replace(ANSI, ''), env), root);
}

/** Redact, then cut to `limit`: the order every history reader needs. */
export function clipFailureText(text: string, limit: number): string {
  return redactFailureText(text).slice(0, limit);
}
