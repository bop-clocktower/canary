---
name: canary-blackhawk
description:
  Temporal-dependency linter for test files — statically flags tests that lean
  on wall-clock time, a real delay, or the local timezone, the ones that pass
  all day and fail at midnight, across a DST boundary, or on Feb 29. Suppresses
  itself when the file already installs a frozen clock (fake timers, freezegun,
  time_machine, MockDate). Self-contained, deterministic, advisory by default.
cli: scripts/cli.mjs
requires: [node>=20]
---

# Canary Blackhawk

A test that reads the wall clock is a test with a scheduled outage. It passes
every run you watch, then fails at 23:59:59, on the Sunday the clocks move, or
on Feb 29. Blackhawk finds those lines before the calendar does.

Tier-0 deterministic analysis: no LLM, no network, no secrets, no dependency on
any other skill.

## Rules

| Rule | Severity | Fires on |
| --- | --- | --- |
| `BH001-wall-clock` | high | `Date.now()`, bare `new Date()`, `moment()`, `datetime.now()` / `.today()` / `.utcnow()`, `date.today()`, `time.time()`, `pd.Timestamp.now()` |
| `BH002-real-delay` | medium | `time.sleep(n)` and `setTimeout(fn, n)` with a literal `n > 0` |
| `BH003-local-timezone` | medium | `toLocaleString` / `toLocaleDateString` / `toLocaleTimeString`, `strftime('…%Z…')` or `%z` |
| `BH004-naive-datetime-compare` | low | a comparison against `datetime(2024, …)` or `strptime(…)` with no `tzinfo` / `timezone.utc` / `ZoneInfo` / `pytz` on the line |

A pinned constructor is never flagged: `new Date('2024-01-01T00:00:00Z')`,
`moment('2024-01-01')`, and `datetime(2024, 1, 1)` on its own are all fine.

## Framework-conditioned suppression (the important part)

The single biggest failure mode of a temporal linter is firing on tests that
**already handle time correctly**. So when a file installs a frozen clock,
every clock-dependent rule (`BH001`, `BH002`, `BH004`) goes quiet for that
file. Markers:

`vi.useFakeTimers` · `vi.setSystemTime` · `jest.useFakeTimers` ·
`jest.setSystemTime` · `sinon.useFakeTimers` · `MockDate` · `freeze_time` /
`freezegun` · `time_machine`

Two deliberate choices inside that:

- **Suppression is file-wide, not block-scoped.** `vi.useFakeTimers()` inside a
  `beforeEach` governs tests declared above it, and answering "is the clock
  frozen *here*" accurately needs a real parser. Blackhawk errs toward silence.
- **`BH003` is never suppressed.** Freezing the clock pins *when* a test runs,
  never *where*. A frozen clock does not stop `toLocaleString()` from returning
  a different string on a developer laptop than on a UTC runner.

## Fidelity limits (regex/AST-lite, on purpose)

Blackhawk is a line scanner with no TypeScript parser dependency, so it ships
anywhere `node` does. The cost, stated plainly:

- **Line-scoped.** A call split across lines (`setTimeout(\n  fn,\n  500\n)`)
  is missed, as is a `setTimeout` whose callback body contains a comma.
- **Comment-blind, one level deep.** Lines starting with `#`, `//`, `*`, `/*`,
  or a docstring quote are skipped; a multi-line block comment whose inner
  lines do not start with `*` is still scanned.
- **String-blind.** `Date.now()` inside a string literal or a fixture blob is
  flagged like real code.
- **No type awareness.** `.toLocaleString()` on a `Number` reads the same as on
  a `Date`.
- **Suppression is a substring match.** A mention of `freezegun` in a comment
  silences the file. That direction is intentional: a missed finding costs less
  than a false one.

## Which files get scanned

A directory walk only visits **test** files — `*.test.*`, `*.spec.*`,
`test_*.py`, `*_test.py`, or any supported source under `tests/`, `test/`,
`__tests__/`, `e2e/`, `spec/`. A file named explicitly on the command line is
always scanned, test-looking or not. Supported suffixes: `.py`, `.js`, `.jsx`,
`.ts`, `.tsx`, `.mjs`, `.cjs`.

## Invocation

```bash
# Scan the repo's test files (advisory — always exits 0):
canary skills run canary-blackhawk

# Scan a specific suite:
canary skills run canary-blackhawk -- tests/e2e

# Machine-readable findings:
canary skills run canary-blackhawk -- tests --json

# Fail the step on any finding:
canary skills run canary-blackhawk -- tests --strict
```

`--json` shape:

```json
{
  "schema_version": 1,
  "findings": [
    {
      "file": "tests/clock.spec.ts",
      "line": 12,
      "rule_id": "BH001-wall-clock",
      "severity": "high",
      "snippet": "const t = Date.now();",
      "why": "reads the wall clock, so the assertion depends on when the suite runs..."
    }
  ],
  "summary": { "files_scanned": 8, "findings": 1, "by_severity": { "high": 1 } }
}
```

## CI wiring (GitHub Actions)

Advisory first, then promote to blocking once the backlog is drained and the
signal is trusted — the same path every canary gate takes.

```yaml
- name: Temporal-dependency lint (advisory)
  run: canary skills run canary-blackhawk -- tests

# Once clean, add --strict to make new offenders fail the PR:
# run: canary skills run canary-blackhawk -- tests --strict
```

## Fixing what it finds

| Finding | Fix |
| --- | --- |
| `BH001` | Freeze the clock (`vi.useFakeTimers()` + `vi.setSystemTime(...)`, `@freeze_time("2024-01-01")`) or inject a clock the test controls. |
| `BH002` | Advance a fake timer (`vi.advanceTimersByTime(500)`) or await the real condition instead of a duration. |
| `BH003` | Assert on a UTC representation (`toISOString()`, `strftime('%Y-%m-%dT%H:%M:%SZ')` on a UTC datetime), or pin the locale and timezone explicitly. |
| `BH004` | Attach a timezone: `datetime(2024, 1, 1, tzinfo=timezone.utc)`. |
