# Example: Luhn Card Validator

Tests an `is_valid_luhn` function that checks a card-number string against
the standard Luhn checksum.

This is a **Python unit** example, and — like `order-state-machine` — it
raises `ValueError` on invalid input rather than silently normalizing it.
The Luhn algorithm looks like a one-line reduce until the doubling step
overflows past a single digit: doubling a `5`-`9` digit produces a
two-digit result that has to be reduced by subtracting 9, not truncated or
modulo'd. Case 3 pins a minimal two-digit input that exercises exactly that
branch, and case 7 gives the function a real malformed-input surface —
non-digit characters are rejected, not stripped.

## Prompt

```text
Generate pytest unit tests for an is_valid_luhn function.

Signature:
    def is_valid_luhn(number: str) -> bool:

The function checks whether `number` passes the standard Luhn checksum used
by card numbers.

Rules:
  - `number` must be a non-empty, ASCII-digit-only string. Any non-digit
    character (dashes, spaces, letters, etc.) or an empty string raises a
    ValueError — malformed input is rejected, not stripped or coerced.
  - Starting from the rightmost digit and moving left, double every second
    digit.
  - If a doubled digit exceeds 9, reduce it by subtracting 9 (equivalent to
    summing its own two digits).
  - Sum all digits (doubled-and-reduced plus untouched). The number is
    valid (returns True) iff that sum is a multiple of 10.
  - The function is pure — it never mutates or normalizes its input.

Cover these cases (hand-verified against the algorithm):
  1. Canonical 16-digit test Visa number —
     is_valid_luhn("4111111111111111") -> True (digit-sum = 30, 30 % 10 == 0)
  2. Same number with the last digit changed (1 -> 2) —
     is_valid_luhn("4111111111111112") -> False (sum becomes 31)
  3. Minimal case exercising the >9 doubling-reduction —
     is_valid_luhn("91") -> True (9 doubled = 18, reduced = 9; sum = 1+9 = 10)
  4. Single digit, undoubled — is_valid_luhn("0") -> True (sum = 0)
  5. Single digit, undoubled, fails — is_valid_luhn("5") -> False (sum = 5)
  6. Empty string — is_valid_luhn("") -> raises ValueError
  7. Non-digit characters present —
     is_valid_luhn("4111-1111-1111-1111") -> raises ValueError
  8. All-zero 16-digit number —
     is_valid_luhn("0000000000000000") -> True
```

See [`prompt.txt`](prompt.txt) for a copy-pasteable version.

## Run it

```bash
cd examples/realworld-functions/luhn-card-validator
cat prompt.txt
```

Then, in Claude Code, generate the test:

```text
/canary-write-test  <paste the contents of prompt.txt>
```

Canary will:

1. Classify the request as `api` (pytest hint, pure checksum function)
2. Pick `pytest` from the framework registry
3. Write a `test_is_valid_luhn.py` file under `tests/generated/`
4. Print the file path + feedback hint

## What Canary should produce

Eight test functions. The doubling-reduction case is the one most
implementations get right by accident rather than by design:

```python
def test_minimal_doubling_reduction_case():
    # 9 doubled = 18, reduced by 9 = 9; digit-sum = 1 + 9 = 10
    assert is_valid_luhn("91") is True

def test_rejects_non_digit_characters():
    with pytest.raises(ValueError):
        is_valid_luhn("4111-1111-1111-1111")
```

## Running the generated test

```bash
pip install pytest
pytest tests/generated/test_is_valid_luhn.py -v
```

## Variations to try

- **Check-digit generator:** ask Canary for a companion
  `luhn_check_digit(partial: str) -> str` that computes the missing final
  digit, plus a test proving `is_valid_luhn(partial + check_digit)` always
  holds
- **Card-brand prefix table:** extend the function to also classify the
  brand (Visa/Mastercard/Amex) by IIN prefix alongside the checksum, and
  ask for a test distinguishing a valid-checksum-wrong-brand case
- **Property check:** ask for a Hypothesis case asserting that flipping any
  single digit of a valid number always makes `is_valid_luhn` return
  `False` — the checksum's single-error-detection property

## See also

- [Getting Started → generating tests](../../../docs/wiki/Getting-Started.md)
- [Writing Good Prompts](../../../docs/wiki/Writing-Good-Prompts.md)
- [Real-world functions overview](../README.md)
