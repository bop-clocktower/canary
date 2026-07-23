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

/** BH002 guard: keep only when the literal delay is > 0. */
function delayIsPositive(match) {
  const raw = match.groups?.delay ?? match.groups?.delay2;
  const n = Number.parseFloat(String(raw).replace(/_/g, ''));
  return Number.isFinite(n) && n > 0;
}

/** BH004 guard: keep only when the compared datetime carries no timezone token. */
function naiveDatetime(match) {
  const line = match.input ?? '';
  return !TZ_TOKENS.some((token) => line.includes(token));
}

/**
 * @typedef {{ruleId: string, severity: string, why: string, pattern: RegExp,
 *            clockDependent: boolean, keep: ((m: RegExpExecArray) => boolean)|null}} Rule
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
  },
];
