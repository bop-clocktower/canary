# Example: Tax Bracket Calculator

Tests a `compute_tax` function that applies a progressive (marginal) tax
schedule — each slice of income is taxed at its own band's rate, not the whole
amount at the top rate.

This is a **Python unit** example. Marginal tax is the textbook case where the
*boundaries* are the whole point: income sitting exactly on a bracket edge, the
first band, the open-ended top band, and rejection of nonsense inputs. The
prompt fixes a concrete schedule so the eight cases assert real arithmetic
rather than hand-waving at "it adds up the brackets."

## Prompt

```text
Generate pytest unit tests for a compute_tax function.

Signature:
    def compute_tax(
        income: float,
        brackets: list[tuple[float, float]],
    ) -> float:

The function computes progressive (marginal) income tax. `brackets` is a list
of (upper_bound, rate) tuples sorted ascending by upper_bound, where the final
tuple's upper_bound is float("inf"). Income is taxed marginally: the slice of
income that falls within each band (previous_bound, upper_bound] is taxed at
that band's rate. The result is rounded to 2 decimal places.

Use this schedule in the tests:
    brackets = [(10_000, 0.10), (40_000, 0.20), (float("inf"), 0.30)]

Rules:
  - Each band taxes only the portion of income that falls inside it.
  - Income exactly on a boundary fully fills that band and contributes 0 to
    the next.
  - The final band (upper_bound = inf) catches all remaining income.
  - The result is rounded to 2 decimal places.
  - Negative income raises a ValueError.
  - An empty brackets list raises a ValueError (no schedule to apply).

Cover these cases:
  1. Zero income — compute_tax(0, brackets) → 0.0
  2. Income within the first band — compute_tax(5_000, brackets) → 500.0
  3. Income exactly on the first boundary — compute_tax(10_000, brackets) → 1000.0
  4. Income spanning two bands — compute_tax(20_000, brackets) → 3000.0
  5. Income exactly on the second boundary — compute_tax(40_000, brackets) → 7000.0
  6. Income into the top (infinite) band — compute_tax(50_000, brackets) → 10000.0
  7. Negative income — compute_tax(-1, brackets) → raises ValueError
  8. Empty brackets — compute_tax(5_000, []) → raises ValueError
```

See [`prompt.txt`](prompt.txt) for a copy-pasteable version.

## Run it

```bash
cd examples/realworld-functions/tax-bracket-calculator
cat prompt.txt
```

Then, in Claude Code, generate the test:

```text
/canary-write-test  <paste the contents of prompt.txt>
```

Canary will:

1. Classify the request as `python_unit` (pytest hint, pure numeric function)
2. Pick `pytest` from the framework registry
3. Write a `test_compute_tax.py` file under `tests/generated/`
4. Print the file path + feedback hint

## What Canary should produce

Eight test functions over the fixed schedule. The boundary and
spanning-two-bands cases are where off-by-one marginal logic surfaces:

```python
import pytest

BRACKETS = [(10_000, 0.10), (40_000, 0.20), (float("inf"), 0.30)]

def test_income_spanning_two_bands():
    # 10_000 @ 10% + 10_000 @ 20% = 1000 + 2000
    assert compute_tax(20_000, BRACKETS) == 3000.0

def test_negative_income_raises():
    with pytest.raises(ValueError):
        compute_tax(-1, BRACKETS)
```

## Running the generated test

```bash
pip install pytest
pytest tests/generated/test_compute_tax.py -v
```

## Variations to try

- **Rounding edge:** swap in a rate like `0.0825` and an income such as
  `12_345` to force a genuine two-decimal rounding assertion
- **Effective rate:** change the return to `{ "tax": float, "effective_rate":
  float }` and assert the blended rate alongside the dollar figure
- **Parametrized:** ask for a `@pytest.mark.parametrize` table driven by the
  six numeric rows above instead of separate functions

## See also

- [Getting Started → generating tests](../../../docs/wiki/Getting-Started.md)
- [Writing Good Prompts](../../../docs/wiki/Writing-Good-Prompts.md)
- [Real-world functions overview](../README.md)
