// Temporal-dependency rule catalog (pure data + compiled patterns).
//
// Each rule is a line-level pattern plus the reason it matters. The catalog is
// deliberately small and language-agnostic: the same scan runs over Python and
// JS/TS because the idioms do not collide (`new Date()` never appears in Python,
// `time.time()` never in TypeScript).
//
// Rules whose `clockDependent` flag is set are suppressed when the file already
// installs a frozen clock (see scanner.frozenClockMarkers). Timezone rules are
// not, because freezing the clock pins *when* a test runs, never *where*.
//
// PHP (#1107) is the exception: its idioms DO collide (`date(2024, 1, 1)` is a
// Python constructor, `sleep(1)` a plausible JS helper), so each rule carries a
// separate `php` variant and the scanner matches a `.php` file against those
// variants only, and every other file against the base patterns only.
//
// JS has no verbose-regex flag, so patterns are compact literals documented by
// the comment above them.

import { commentEnd, literalEnd } from '../../../lib/js-literals.mjs';

export const SEVERITIES = ['high', 'medium', 'low'];

// Frozen-clock idioms. Their presence anywhere in a file suppresses every
// clock-dependent rule in that file -- the single most important behaviour in
// this skill, because a naive universal wall-clock rule false-positives on
// exactly the tests that already handle time correctly.
export const FROZEN_CLOCK_MARKERS = [
  'vi.useFakeTimers',
  'vi.setSystemTime',
  'jest.useFakeTimers',
  'jest.setSystemTime',
  'sinon.useFakeTimers',
  'MockDate',
  'freeze_time',
  'freezegun',
  'time_machine',
  // PHP (#1107): Symfony's ClockMock (activated by `@group time-sensitive`),
  // php-mock's function mocks, Carbon's test clock, and the WordPress
  // `pre_option_*` filters the issue groups with them.
  'ClockMock',
  '@group time-sensitive',
  'PHPMock',
  'getFunctionMock',
  'php-mock',
  'setTestNow',
  'pre_option_gmt_offset',
  'pre_option_timezone_string',
];

// Tokens that make a datetime expression explicitly timezone-aware.
const TZ_TOKENS = [
  'tzinfo',
  'timezone.utc',
  'pytz',
  'tz=',
  'ZoneInfo',
  'astimezone',
];

// JS Date.now() | bare new Date() | moment() | PY datetime.now/today/utcnow() |
// date.today() | time.time() | pd.Timestamp.now()
const WALL_CLOCK =
  /\bDate\.now\s*\(|\bnew\s+Date\s*\(\s*\)|\bmoment\s*\(\s*\)|\bdatetime\.(?:now|today|utcnow)\s*\(|\bdate\.today\s*\(|\btime\.time\s*\(|\bTimestamp\.now\s*\(/;

// PY time.sleep(n) | JS setTimeout(fn, n) with a literal numeric delay.
const REAL_DELAY =
  /\btime\.sleep\s*\(\s*(?<delay>[0-9][0-9_]*(?:\.[0-9]+)?)\s*\)|\bsetTimeout\s*\([^,]*,\s*(?<delay2>[0-9][0-9_]*(?:\.[0-9]+)?)\s*[,)]/;

// JS locale formatting | PY strftime with %z / %Z.
const LOCAL_TZ =
  /\.toLocale(?:String|DateString|TimeString)\s*\(|strftime\s*\(\s*[frbu]*['"][^'"]*%[zZ]/;

// A comparison against datetime(YYYY, ...) or strptime(...) on either side.
const NAIVE_COMPARE =
  /(?:==|!=|<=|>=|<|>)\s*(?:\w+\.)*datetime\s*\(\s*\d{4}|(?:\w+\.)*datetime\s*\(\s*\d{4}[^)]*\)\s*(?:==|!=|<=|>=|<|>)|(?:==|!=|<=|>=|<|>)\s*(?:\w+\.)*strptime\s*\(|(?:\w+\.)*strptime\s*\([^)]*\)\s*(?:==|!=|<=|>=|<|>)/;

// --- PHP variants (#1107) -----------------------------------------------------
//
// Case-insensitive, because PHP function and class names are. Every call token
// sits behind PHP_CALL so a method, static or variable call (`$clock->time()`,
// `$c?->time()`, `Clock::date()`, `$date(`) or a declaration (`function
// time()`) never reads as the builtin; a leading `\` (a fully-qualified
// `\time()`) is still the builtin, and so is one after an unspaced operator
// (`'k'=>time()`, `$b ?:time()`).
const PHP_CALL = String.raw`(?<![\w$]|->|::)(?<!\bfunction\s+&?)`;
// One argument only (a format string, which may itself contain a comma).
const ONE_ARG = String.raw`\s*\(\s*(?:'[^']*'|"[^"]*"|[^,()'"])*\)`;
const php = (...alternatives) => new RegExp(alternatives.join('|'), 'i');

// time() | date/gmdate(fmt) | mktime() | strtotime('now'|'+1 day'|...) |
// microtime( | hrtime( | new DateTime[Immutable] with no arg or 'now' |
// date_create() | Carbon::now()/today() | WP current_time( | current_datetime( |
// wp_date(fmt) | date_i18n(fmt)
const PHP_WALL_CLOCK = php(
  String.raw`${PHP_CALL}time\s*\(\s*\)`,
  String.raw`${PHP_CALL}(?:gm)?date${ONE_ARG}`,
  String.raw`${PHP_CALL}mktime\s*\(\s*\)`,
  // Relative to now only without a base timestamp (`strtotime('+1 day', $ts)`
  // is pinned).
  String.raw`${PHP_CALL}strtotime\s*\(\s*(?<rq>['"])\s*(?:now|today|tomorrow|yesterday|midnight|noon|next\b|last\b|this\b|[+-])[^'"]*\k<rq>\s*\)`,
  String.raw`${PHP_CALL}(?:microtime|hrtime)\s*\(`,
  String.raw`\bnew\s+\\?DateTime(?:Immutable)?\b\s*(?:\(\s*(?:(?<q>['"])now\k<q>\s*)?[,)]|[;)])`,
  String.raw`${PHP_CALL}date_create(?:_immutable)?\s*\(\s*\)`,
  String.raw`\bCarbon(?:Immutable)?::(?:now|today)\s*\(`,
  String.raw`${PHP_CALL}current_(?:time|datetime)\s*\(`,
  String.raw`${PHP_CALL}(?:wp_date|date_i18n)${ONE_ARG}`,
);

// sleep(n) | usleep(n) | time_nanosleep(s, ns) with literal arguments.
const PHP_REAL_DELAY = php(
  String.raw`${PHP_CALL}u?sleep\s*\(\s*(?<delay>[0-9][0-9_]*(?:\.[0-9]+)?)\s*\)`,
  String.raw`${PHP_CALL}time_nanosleep\s*\(\s*(?<delay2>[0-9][0-9_]*)\s*,\s*(?<delay3>[0-9][0-9_]*)\s*\)`,
);

// date( (any arity: gmdate is the UTC twin) | mktime( with arguments |
// strftime( | new IntlDateFormatter / ::create( | setlocale( to anything but
// 'C'/'POSIX' | date_default_timezone_set( to anything but a UTC literal |
// date_default_timezone_get( | new DateTimeZone( with anything but a UTC
// literal. Pinning to UTC / the C locale is the fix, so it never fires.
const UTC_LITERAL = String.raw`(?!\s*['"](?:UTC|GMT|Etc/UTC|Z|\+00:?00)['"])`;
const PHP_LOCAL_TZ = php(
  String.raw`${PHP_CALL}date\s*\(`,
  String.raw`${PHP_CALL}mktime\s*\(\s*[^)\s]`,
  String.raw`${PHP_CALL}strftime\s*\(`,
  String.raw`${PHP_CALL}setlocale\s*\([^,)]*,(?!\s*['"](?:C|POSIX)['"])`,
  String.raw`\bnew\s+\\?IntlDateFormatter\b|\bIntlDateFormatter::create\s*\(`,
  String.raw`${PHP_CALL}date_default_timezone_set\s*\(${UTC_LITERAL}`,
  String.raw`${PHP_CALL}date_default_timezone_get\s*\(`,
  String.raw`\bnew\s+\\?DateTimeZone\s*\(${UTC_LITERAL}`,
);

// A comparison against new DateTime('YYYY..') or strtotime(..) on either side
// (`->` and `=>` are not comparisons), or a fixed-length DAY/WEEK/MONTH/YEAR
// _IN_SECONDS constant (a WordPress core idiom) in +/- timestamp arithmetic.
const PHP_OP = String.raw`(?:===|!==|==|!=|<=>|<=|>=|(?<![-=])>|<)`;
const PHP_DATE_START = String.raw`(?:new\s+\\?DateTime(?:Immutable)?\s*\(\s*['"]\d{4}|${PHP_CALL}strtotime\s*\()`;
const PHP_DATE_FULL = String.raw`(?:new\s+\\?DateTime(?:Immutable)?\s*\(\s*['"]\d{4}[^)]*\)|${PHP_CALL}strtotime\s*\([^)]*\))`;
const PHP_FIXED_UNIT = String.raw`(?:DAY|WEEK|MONTH|YEAR)_IN_SECONDS\b`;
const PHP_NAIVE_COMPARE = php(
  String.raw`${PHP_OP}\s*${PHP_DATE_START}`,
  String.raw`${PHP_DATE_FULL}\s*${PHP_OP}`,
  String.raw`(?<fixed>[+-]\s*(?:\w+\s*\*\s*)?\b${PHP_FIXED_UNIT}|\b${PHP_FIXED_UNIT}\s*(?:\*\s*\w+\s*)?[+-])`,
);

// Tokens that pin a PHP date expression to an explicit zone.
const PHP_TZ_TOKENS = ['DateTimeZone', 'UTC', 'GMT', '+00:00', "Z'", 'Z"'];

/** BH002 guard: keep only when a literal delay is > 0. */
function delayIsPositive(match) {
  const groups = match.groups ?? {};
  return Object.entries(groups).some(([name, raw]) => {
    if (!name.startsWith('delay') || raw === undefined) return false;
    const n = Number.parseFloat(String(raw).replace(/_/g, ''));
    return Number.isFinite(n) && n > 0;
  });
}

// #1636: a JS numeric literal (decimal, fraction, exponent, hex/binary/octal,
// `_` separators, BigInt `n`), as the receiver of `.toLocaleString(`: bare
// (`1e3.`, `5000..` -- the first dot is the literal's own), or parenthesised
// with an optional sign (`(5000)`, `(-5n)`), where the `(` is a grouping paren
// rather than a call (`foo(1)`, `foo?.(1)`, `make<Date>(0)`, `fn!(0)` and
// `new Date (0)` all return anything, #1659).
const NUMBER = String.raw`(?:0[xXbBoO][\da-fA-F_]+|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?|\.\d[\d_]*(?:[eE][+-]?\d+)?)n?`;
const BARE_NUMBER = new RegExp(String.raw`(?<![\w$.])${NUMBER}$`);
const GROUPED_NUMBER = new RegExp(String.raw`\(\s*[-+]?\s*${NUMBER}\s*\)$`);
// A word after which `(` opens an expression rather than a call.
const KEYWORD_BEFORE_PAREN =
  /(?:^|[^\w$])(?:return|yield|await|typeof|void|delete|case|throw|in|of|else|do)$/;

/** Whether `prefix` (the text before `.toLocaleString`) ends in a number. */
function numericReceiver(prefix) {
  if (BARE_NUMBER.test(prefix)) return true;
  const grouped = GROUPED_NUMBER.exec(prefix);
  if (grouped === null) return false;
  const before = prefix.slice(0, grouped.index).trimEnd();
  if (/[\w$]$/.test(before)) return KEYWORD_BEFORE_PAREN.test(before);
  if (/[)\].!]$/.test(before)) return false; // a call, `?.(`, or `fn!(`
  if (before.endsWith('>')) return before.endsWith('=>'); // `<T>(` vs arrow
  return true;
}

// #1659: a `timeZone` property whose value is a string literal. It is tested
// on blanked text (see blankedCallArgs), so a literal's content is spaces and
// only a quoted `'timeZone'` key keeps its text. Anything else -- `undefined`,
// `process.env.TZ`, `resolvedOptions().timeZone`, a variable, the `{ timeZone
// }` shorthand, an expression -- is, or may be, the host zone.
const ZONE_LITERAL_PROP = /^\s*(['"]?)timeZone\1\s*:\s*(['"`])\s*\2\s*$/;

/** Same-length stand-in for a comment or literal token (#1659). */
function blankToken(token, isComment) {
  const q = token[0];
  const closed = token.length > 1 && token.endsWith(q);
  const plain = q === '`' ? !token.includes('${') : q === "'" || q === '"';
  if (isComment || !plain || !closed) return ' '.repeat(token.length);
  const body = token.slice(1, -1);
  return q + (body === 'timeZone' ? body : ' '.repeat(body.length)) + q;
}

/**
 * The argument text of the call whose `(` ends just before `start`, with
 * comments and regex literals blanked and string contents blanked (quotes
 * kept), or null when the call does not close on this line (the scanner is
 * line-based). Lexed with the shared JS lexer, so a quote inside a comment
 * or a regex cannot unbalance the scan (#1659).
 */
function blankedCallArgs(line, start) {
  const rest = line.slice(start);
  let out = '';
  let depth = 1;
  let last = -1; // the last significant character, for regex-vs-division
  for (let i = 0; i < rest.length;) {
    const comment = commentEnd(rest, i);
    const end = comment ?? literalEnd(rest, i, last);
    if (end !== null) {
      out += blankToken(rest.slice(i, end), comment !== null);
      if (comment === null) last = end - 1;
      i = end;
      continue;
    }
    const ch = rest[i];
    if (ch === '(') depth += 1;
    else if (ch === ')' && (depth -= 1) === 0) return out;
    if (!/\s/.test(ch)) last = i;
    out += ch;
    i += 1;
  }
  return null;
}

/** Split `text` on top-level commas (strings are already blanked). */
function topLevelParts(text) {
  const parts = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) depth -= 1;
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(text.slice(from));
  return parts;
}

/**
 * True when one of the call's own arguments is an object literal with a
 * top-level `timeZone: '<literal>'` property. A pin nested in another call,
 * a ternary branch or an inner object does not count.
 */
function pinsLiteralZone(args) {
  return topLevelParts(args).some((arg) => {
    const object = arg.trim();
    if (!object.startsWith('{') || !object.endsWith('}')) return false;
    const body = object.slice(1, -1);
    // `{ a } || { b }` starts and ends with braces but is not one object.
    if (closesUnopened(body)) return false;
    return topLevelParts(body).some((p) => ZONE_LITERAL_PROP.test(p));
  });
}

/** Whether `text` closes a bracket it never opened. */
function closesUnopened(text) {
  let depth = 0;
  for (const ch of text) {
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch) && (depth -= 1) < 0) return true;
  }
  return false;
}

/**
 * A `.toLocale*(` call that cannot read the host zone: Number/BigInt
 * `toLocaleString` on a numeric literal, or any of the three with a
 * string-literal `timeZone` option in its own arguments. A pinned locale
 * alone is not enough.
 */
function localeCallIsPinned(line, m) {
  if (!m[0].startsWith('.toLocale')) return false; // strftime('%Z')
  const numeric =
    m[0].startsWith('.toLocaleString') &&
    numericReceiver(line.slice(0, m.index));
  if (numeric) return true;
  const args = blankedCallArgs(line, m.index + m[0].length);
  return args !== null && pinsLiteralZone(args);
}

/**
 * BH003 guard (#1636): keep unless every BH003 match from the first one on is
 * pinned. The scanner hands over only the first match on a line, so a later
 * unpinned call (`(5).toLocaleString() + d.toLocaleString()`) must still keep.
 */
function localTzUnpinned(match) {
  const line = match.input ?? '';
  const re = new RegExp(LOCAL_TZ.source, 'g');
  re.lastIndex = match.index;
  for (let m = re.exec(line); m !== null; m = re.exec(line)) {
    if (!localeCallIsPinned(line, m)) return true;
  }
  return false;
}

/** BH004 guard: keep only when the compared datetime carries no timezone token. */
function naiveDatetime(match) {
  const line = match.input ?? '';
  return !TZ_TOKENS.some((token) => line.includes(token));
}

/** PHP BH004 guard: fixed-unit arithmetic always; a comparison when naive. */
function phpNaiveDatetime(match) {
  if (match.groups?.fixed) return true;
  const line = match.input ?? '';
  return !PHP_TZ_TOKENS.some((token) => line.includes(token));
}

/**
 * @typedef {{pattern: RegExp, keep: ((m: RegExpExecArray) => boolean)|null}} Variant
 * @typedef {{ruleId: string, severity: string, why: string, pattern: RegExp,
 *            clockDependent: boolean, keep: ((m: RegExpExecArray) => boolean)|null,
 *            php: Variant}} Rule
 */

/** @type {Rule[]} */
export const RULES = [
  {
    ruleId: 'BH001-wall-clock',
    severity: 'high',
    why:
      'reads the wall clock, so the assertion depends on when the suite runs ' +
      '(midnight, a DST shift, or Feb 29 changes the answer)',
    pattern: WALL_CLOCK,
    clockDependent: true,
    keep: null,
    php: { pattern: PHP_WALL_CLOCK, keep: null },
  },
  {
    ruleId: 'BH002-real-delay',
    severity: 'medium',
    why:
      'burns a real delay, so the test is slow by construction and races the ' +
      'scheduler on a loaded CI runner',
    pattern: REAL_DELAY,
    clockDependent: true,
    keep: delayIsPositive,
    php: { pattern: PHP_REAL_DELAY, keep: delayIsPositive },
  },
  {
    ruleId: 'BH003-local-timezone',
    severity: 'medium',
    why:
      "formats against the machine's local timezone, so the expected string " +
      'differs between a developer laptop and a UTC CI runner',
    pattern: LOCAL_TZ,
    clockDependent: false,
    keep: localTzUnpinned,
    php: { pattern: PHP_LOCAL_TZ, keep: null },
  },
  {
    ruleId: 'BH004-naive-datetime-compare',
    severity: 'low',
    why:
      'compares a timezone-naive datetime, so the result shifts with the host ' +
      'offset and breaks across a DST boundary',
    pattern: NAIVE_COMPARE,
    clockDependent: true,
    keep: naiveDatetime,
    php: { pattern: PHP_NAIVE_COMPARE, keep: phpNaiveDatetime },
  },
];
