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
    keep: null,
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
