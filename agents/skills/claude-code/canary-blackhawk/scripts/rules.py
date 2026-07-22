"""Temporal-dependency rule catalog (pure data + compiled patterns).

Each rule is a line-level pattern plus the reason it matters. The catalog is
deliberately small and language-agnostic: the same scan runs over Python and
JS/TS because the idioms do not collide (`new Date()` never appears in Python,
`time.time()` never in TypeScript).

Rules whose `clock_dependent` flag is set are suppressed when the file already
installs a frozen clock (see `scanner.frozen_clock_markers`). Timezone rules are
not, because freezing the clock pins *when* a test runs, never *where*.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

SEVERITIES = ("high", "medium", "low")

# Frozen-clock idioms. Their presence anywhere in a file suppresses every
# clock-dependent rule in that file -- the single most important behaviour in
# this skill, because a naive universal wall-clock rule false-positives on
# exactly the tests that already handle time correctly.
FROZEN_CLOCK_MARKERS = (
    "vi.useFakeTimers",
    "vi.setSystemTime",
    "jest.useFakeTimers",
    "jest.setSystemTime",
    "sinon.useFakeTimers",
    "MockDate",
    "freeze_time",
    "freezegun",
    "time_machine",
)

# Tokens that make a datetime expression explicitly timezone-aware.
_TZ_TOKENS = ("tzinfo", "timezone.utc", "pytz", "tz=", "ZoneInfo", "astimezone")


@dataclass(frozen=True)
class Rule:
    """One temporal-dependency check."""

    rule_id: str
    severity: str
    why: str
    pattern: re.Pattern
    clock_dependent: bool = True
    # Optional guard: given the source line, return True to keep the finding.
    keep: object = None


def _naive_datetime(match: re.Match) -> bool:
    """True when the compared datetime literal carries no timezone token."""
    line = match.string
    return not any(token in line for token in _TZ_TOKENS)


_WALL_CLOCK = re.compile(
    r"""(?x)
    \bDate\.now\s*\(                       # JS: Date.now()
  | \bnew\s+Date\s*\(\s*\)                 # JS: bare new Date()
  | \bmoment\s*\(\s*\)                     # JS: moment() with no argument
  | \bdatetime\.(?:now|today|utcnow)\s*\(  # PY: datetime.now/today/utcnow()
  | \bdate\.today\s*\(                     # PY: date.today()
  | \btime\.time\s*\(                      # PY: time.time()
  | \bTimestamp\.now\s*\(                  # PY: pd.Timestamp.now()
    """
)

_REAL_DELAY = re.compile(
    r"""(?x)
    \btime\.sleep\s*\(\s*(?P<delay>[0-9][0-9_]*(?:\.[0-9]+)?)\s*\)   # PY
  | \bsetTimeout\s*\([^,]*,\s*(?P<delay2>[0-9][0-9_]*(?:\.[0-9]+)?)\s*[,)]  # JS
    """
)

_LOCAL_TZ = re.compile(
    r"""(?x)
    \.toLocale(?:String|DateString|TimeString)\s*\(   # JS locale formatting
  | strftime\s*\(\s*[frbu]*['"][^'"]*%[zZ]            # PY %z / %Z formatting
    """
)

_NAIVE_COMPARE = re.compile(
    r"""(?x)
    (?:==|!=|<=|>=|<|>)\s*(?:\w+\.)*datetime\s*\(\s*\d{4}   # x == datetime(2024, ...)
  | (?:\w+\.)*datetime\s*\(\s*\d{4}[^)]*\)\s*(?:==|!=|<=|>=|<|>)
  | (?:==|!=|<=|>=|<|>)\s*(?:\w+\.)*strptime\s*\(
  | (?:\w+\.)*strptime\s*\([^)]*\)\s*(?:==|!=|<=|>=|<|>)
    """
)


def _delay_is_positive(match: re.Match) -> bool:
    raw = match.group("delay") or match.group("delay2")
    try:
        return float(raw.replace("_", "")) > 0
    except (TypeError, ValueError):
        return False


RULES = (
    Rule(
        rule_id="BH001-wall-clock",
        severity="high",
        why=(
            "reads the wall clock, so the assertion depends on when the suite "
            "runs (midnight, a DST shift, or Feb 29 changes the answer)"
        ),
        pattern=_WALL_CLOCK,
    ),
    Rule(
        rule_id="BH002-real-delay",
        severity="medium",
        why=(
            "burns a real delay, so the test is slow by construction and races "
            "the scheduler on a loaded CI runner"
        ),
        pattern=_REAL_DELAY,
        keep=_delay_is_positive,
    ),
    Rule(
        rule_id="BH003-local-timezone",
        severity="medium",
        why=(
            "formats against the machine's local timezone, so the expected "
            "string differs between a developer laptop and a UTC CI runner"
        ),
        pattern=_LOCAL_TZ,
        clock_dependent=False,
    ),
    Rule(
        rule_id="BH004-naive-datetime-compare",
        severity="low",
        why=(
            "compares a timezone-naive datetime, so the result shifts with the "
            "host offset and breaks across a DST boundary"
        ),
        pattern=_NAIVE_COMPARE,
        keep=_naive_datetime,
    ),
)
