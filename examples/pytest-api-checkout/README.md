# Example: Pytest API — Checkout Endpoint

Generates an HTTP-level Pytest test against a checkout endpoint, covering
success, validation errors, and an auth failure.

## Prompt

```text
Generate a Pytest test file for POST https://api.example.com/v1/checkout.

The endpoint accepts:
  {"items": [{"sku": "string", "qty": int}], "currency": "USD"}

Cover three cases:

1. Success — valid bearer token, one item, qty=1 → expect 201 and
   response.json() to include an "order_id" string.

2. Validation error — empty items list → expect 400 and an error message
   mentioning "items".

3. Auth failure — missing Authorization header → expect 401.

Use the requests library. Read the bearer from an env var TEST_BEARER_TOKEN.
Group with pytest classes only if it improves readability. Add minimal
docstrings to each test.
```

See [`prompt.txt`](prompt.txt) for a copy-pasteable version.

## Run it

```bash
cd examples/pytest-api-checkout
cat prompt.txt        # the scenario
```

Then, in Claude Code, generate the test from the scenario:

```text
/canary-write-test  <paste the contents of prompt.txt>
```

Canary will classify as `api`, pick `pytest`, and write a `test_*.py` file.

## Running the generated test

```bash
pip install pytest requests
export TEST_BEARER_TOKEN=stub-for-now
canary run tests/generated/<filename>.py pytest
```

The test will fail against `api.example.com` (no real endpoint). Adapt by:

- Replacing the URL with your real API base
- Setting `TEST_BEARER_TOKEN` to a test-only token your environment accepts
- Adjusting the request payload to match your endpoint's actual schema

## What to expect

Canary generally produces something like:

```python
import os
import requests


BASE_URL = "https://api.example.com/v1/checkout"
TOKEN = os.environ.get("TEST_BEARER_TOKEN", "")


def _post(payload, headers=None):
    return requests.post(BASE_URL, json=payload, headers=headers or {})


def test_success_returns_order_id():
    """Valid checkout returns 201 and an order_id."""
    res = _post(
        {"items": [{"sku": "ABC-123", "qty": 1}], "currency": "USD"},
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    assert res.status_code == 201
    assert isinstance(res.json().get("order_id"), str)


def test_empty_items_returns_400():
    """Empty items list is rejected."""
    res = _post(
        {"items": [], "currency": "USD"},
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    assert res.status_code == 400
    assert "items" in res.text.lower()


def test_missing_auth_returns_401():
    """No Authorization header → 401."""
    res = _post({"items": [{"sku": "ABC-123", "qty": 1}], "currency": "USD"})
    assert res.status_code == 401
```

## Variations to try

- **Add more error cases:** rate-limit (429), invalid currency, malformed JSON
- **Use `httpx` instead of `requests`:** rephrase the prompt
- **Add parametrize:** ask Canary to use `@pytest.mark.parametrize` for the
  validation cases

## See also

- [Getting Started → generating tests](../../docs/wiki/Getting-Started.md)
- [Writing Good Prompts](../../docs/wiki/Writing-Good-Prompts.md)
