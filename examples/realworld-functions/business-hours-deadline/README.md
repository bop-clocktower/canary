# Example: Business Hours Deadline

Tests an `add_business_hours` function that adds a budget of business hours
to a start time, skipping nights, weekends, and holidays.

This is a **Python unit** example. Two edges trip up naive implementations:
a start time **outside** the business window must round up before any hours
are consumed, and `hours=0` must still perform that rounding — it isn't
simply a no-op (case 6 asserts both branches). Fixing the window to
09:00-17:00 UTC, Monday-Friday keeps the DST/timezone rabbit hole out of
scope entirely.

## Prompt

```text
Generate pytest unit tests for an add_business_hours function.

Signature:
    from datetime import date, datetime

    def add_business_hours(
        start: datetime,
        hours: int,
        holidays: set[date],
    ) -> datetime:

The function adds a budget of business hours to `start` and returns the
resulting datetime (UTC). The business window is fixed: 09:00-17:00 UTC,
Monday-Friday, minus any date present in `holidays`.

Rules:
  - `hours` must be a non-negative int. A float or negative value raises a
    ValueError.
  - If `start` falls outside the business window (before 09:00, after 17:00,
    on a weekend, or on a holiday), it first rounds up to the next valid
    window-start (09:00 on the next business day) before consuming any of the
    `hours` budget.
  - Hours are consumed by walking forward through business windows in order,
    skipping weekends and holidays entirely — each business day contributes
    exactly 8 business-hours.

Cover these cases (all datetimes are UTC; 2024-01-01 is a Monday):
  1. Same-day addition, no skip — add_business_hours(datetime(2024, 1, 1, 10, 0), 3, set()) → datetime(2024, 1, 1, 13, 0)
  2. Crosses end-of-day, rolls to next business day — add_business_hours(datetime(2024, 1, 1, 15, 0), 4, set()) → datetime(2024, 1, 2, 11, 0)
  3. Crosses a weekend — add_business_hours(datetime(2024, 1, 5, 15, 0), 4, set()) → datetime(2024, 1, 8, 11, 0)
  4. Crosses an explicit holiday — add_business_hours(datetime(2024, 1, 1, 15, 0), 4, {date(2024, 1, 2)}) → datetime(2024, 1, 3, 11, 0)
  5. start outside business hours rounds up first — add_business_hours(datetime(2024, 1, 1, 20, 0), 1, set()) → datetime(2024, 1, 2, 10, 0)
  6. hours=0 — add_business_hours(datetime(2024, 1, 1, 10, 0), 0, set()) → datetime(2024, 1, 1, 10, 0) (already in-window, unchanged); add_business_hours(datetime(2024, 1, 1, 20, 0), 0, set()) → datetime(2024, 1, 2, 9, 0) (outside window, rounds up only)
  7. Multi-day span, full 8-hour days — add_business_hours(datetime(2024, 1, 1, 9, 0), 20, set()) → datetime(2024, 1, 3, 13, 0)
  8. Negative hours — add_business_hours(datetime(2024, 1, 1, 10, 0), -1, set()) → raises ValueError
```

See [`prompt.txt`](prompt.txt) for a copy-pasteable version.

## Run it

```bash
cd examples/realworld-functions/business-hours-deadline
cat prompt.txt
```

Then, in Claude Code, generate the test:

```text
/canary-write-test  <paste the contents of prompt.txt>
```

Canary will:

1. Classify the request as `python_unit` (pytest hint, pure datetime function)
2. Pick `pytest` from the framework registry
3. Write a `test_add_business_hours.py` file under `tests/generated/`
4. Print the file path + feedback hint

## What Canary should produce

Eight test functions covering the window-crossing and rounding rules. The
zero-hours case is the one most likely to be under-tested — it still has to
prove the rounding-up branch, not just the identity branch:

```python
def test_zero_hours_outside_window_rounds_up_only():
    result = add_business_hours(datetime(2024, 1, 1, 20, 0), 0, set())
    assert result == datetime(2024, 1, 2, 9, 0)

def test_crosses_explicit_holiday():
    result = add_business_hours(
        datetime(2024, 1, 1, 15, 0), 4, {date(2024, 1, 2)}
    )
    assert result == datetime(2024, 1, 3, 11, 0)
```

## Running the generated test

```bash
pip install pytest
pytest tests/generated/test_add_business_hours.py -v
```

## Variations to try

- **Half-day holidays:** extend `holidays` to a dict of partial closures
  (e.g., 09:00-13:00 only) and ask Canary for tests that consume a reduced
  daily budget
- **Timezone-aware input:** accept a timezone-aware `start`, convert to UTC
  before applying the window, and ask for a test asserting a non-UTC input
  still lands on the right UTC hour
- **Business-days-only variant:** ask for a sibling `add_business_days` that
  skips the hour math entirely and just counts whole days

## See also

- [Getting Started → generating tests](../../../docs/wiki/Getting-Started.md)
- [Writing Good Prompts](../../../docs/wiki/Writing-Good-Prompts.md)
- [Real-world functions overview](../README.md)
