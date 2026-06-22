# Example: Subscription Expiry Checker

Tests a `check_subscriptions` function that buckets subscription records into
`expired / expiring_soon / active` relative to a caller-supplied reference
date, with a configurable warning window.

This is a **Python unit** example. The interesting surface is the boundary
conditions: a subscription expiring exactly *on* the reference date is expired
(not expiring soon), and the warning window is inclusive at both ends.
Passing `reference_date` explicitly — rather than calling `date.today()` inside
the function — makes every case trivially deterministic.

## Prompt

```text
Generate pytest unit tests for a check_subscriptions function.

Signature:
    from datetime import date

    def check_subscriptions(
        subscriptions: list[dict],
        reference_date: date,
        warning_days: int = 30,
    ) -> dict:

The function buckets subscription records by how they stand relative to
`reference_date`. It returns a dict with three keys:
  - "expired":        subscriptions whose `expires_on` is before reference_date
  - "expiring_soon":  subscriptions whose `expires_on` is within warning_days
                      from reference_date (inclusive of reference_date itself)
  - "active":         all remaining subscriptions

Each subscription is a dict with at least: id (str), expires_on (date).
A subscription appears in exactly one bucket — expired takes precedence over
expiring_soon (a past-due sub is expired, not expiring soon).

Cover these cases:
  1. Mixed bag — one expired, one expiring in 15 days, one active (90 days out)
  2. All expired — every sub lands in "expired", others are empty lists
  3. All active — every sub is well beyond the warning window
  4. Boundary: expires exactly on reference_date → "expired"
  5. Boundary: expires exactly warning_days from reference_date → "expiring_soon"
  6. Empty list — all three buckets return empty lists
  7. Custom warning_days=0 — only reference_date itself counts as expiring_soon
```

See [`prompt.txt`](prompt.txt) for a copy-pasteable version.

## Run it

```bash
cd examples/realworld-functions/subscription-expiry-checker
cat prompt.txt
```

Then, in Claude Code, generate the test:

```text
/canary-write-test  <paste the contents of prompt.txt>
```

Canary will:

1. Classify the request as `api` (pytest hint, structured dict I/O)
2. Pick `pytest` from the framework registry
3. Write a `test_check_subscriptions.py` file under `tests/generated/`
4. Print the file path + feedback hint

## What Canary should produce

Seven test functions (or `@pytest.mark.parametrize` cases). The boundary
tests are where the design intent becomes explicit:

```python
def test_expires_on_reference_date_is_expired():
    ref = date(2026, 6, 1)
    result = check_subscriptions(
        [{"id": "s1", "expires_on": ref}], reference_date=ref
    )
    assert result["expired"] == [{"id": "s1", "expires_on": ref}]
    assert result["expiring_soon"] == []
```

## Running the generated test

```bash
pip install pytest
pytest tests/generated/test_check_subscriptions.py -v
```

The tests call `check_subscriptions` — paste your implementation before
running, or point the import at your module.

## Variations to try

- **Timezone-aware:** change `expires_on` from `date` to `datetime` with
  timezone info; ask Canary to cover a case where UTC midnight differs from
  local midnight
- **Grace period:** add a `grace_days` param — expired subs within the grace
  period get a fourth bucket `"grace"`
- **Sorting:** ask Canary to assert that each bucket is sorted by
  `expires_on` ascending

## See also

- [Getting Started → generating tests](../../../docs/wiki/Getting-Started.md)
- [Writing Good Prompts](../../../docs/wiki/Writing-Good-Prompts.md)
- [Real-world functions overview](../README.md)
