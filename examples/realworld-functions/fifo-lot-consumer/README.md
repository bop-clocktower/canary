# Example: FIFO Lot Consumer

Tests a `consume` function that depletes a list of inventory lots in
first-in-first-out order to satisfy a requested quantity.

This is a **Python unit** example, and — like `order-state-machine` — it
raises `ValueError` on invalid input rather than silently coercing it. FIFO
consumption looks like "subtract until zero" until a request spans multiple
lots: the function has to fully drain each lot in order before touching the
next one, leave partially-consumed lots at the front of `remaining` in
their original order, and prove conservation — nothing consumed or
remaining may ever exceed what the lots originally held. Case 5 is the one
that catches a shuffled or reordered `remaining` list.

## Prompt

```text
Generate pytest unit tests for a consume function.

Signature:
    def consume(lots: list[dict], qty: int) -> dict:

The function depletes `lots` (each `{"id": str, "qty": int}`) in FIFO order
to satisfy a requested `qty`, returning `{"consumed": [...], "remaining":
[...]}` — parallel lists of the same `{"id": str, "qty": int}` shape.

Rules:
  - `qty` must be a positive int. A non-int or non-positive value raises a
    ValueError.
  - Lots are consumed strictly in list order (FIFO) until `qty` is
    satisfied.
  - Each entry in `consumed` carries the source lot's `id`, with its own
    `qty` equal to the amount taken from that lot (never more than the lot
    held).
  - `remaining` preserves the original relative order of untouched or
    partially-consumed lots; a lot fully drained to zero is removed from
    `remaining` entirely.
  - If the total quantity across all lots is less than the requested `qty`,
    the function raises a ValueError — nothing is consumed on failure.
  - The function is pure — it never mutates the input `lots` list or its
    dict elements.
  - Invariant: sum(c["qty"] for c in consumed) == qty on success, and
    sum(l["qty"] for l in lots) == sum(consumed) + sum(remaining) always
    (conservation).

Cover these cases:
  1. Single lot, partial consumption —
     consume([{"id": "L1", "qty": 10}], 4) ->
     {"consumed": [{"id": "L1", "qty": 4}], "remaining": [{"id": "L1", "qty": 6}]}
  2. Single lot, exact consumption (fully drained, removed from remaining) —
     consume([{"id": "L1", "qty": 5}], 5) ->
     {"consumed": [{"id": "L1", "qty": 5}], "remaining": []}
  3. Spans two lots (first fully drained, second partial) —
     consume([{"id": "L1", "qty": 3}, {"id": "L2", "qty": 5}], 6) ->
     {"consumed": [{"id": "L1", "qty": 3}, {"id": "L2", "qty": 3}], "remaining": [{"id": "L2", "qty": 2}]}
  4. Spans three lots exactly, draining all (remaining=[]) —
     consume([{"id": "L1", "qty": 2}, {"id": "L2", "qty": 3}, {"id": "L3", "qty": 4}], 9) ->
     {"consumed": [{"id": "L1", "qty": 2}, {"id": "L2", "qty": 3}, {"id": "L3", "qty": 4}], "remaining": []}
  5. Partial consumption at the front only — untouched lots preserved in
     order in remaining —
     consume([{"id": "L1", "qty": 5}, {"id": "L2", "qty": 3}, {"id": "L3", "qty": 4}], 2) ->
     {"consumed": [{"id": "L1", "qty": 2}], "remaining": [{"id": "L1", "qty": 3}, {"id": "L2", "qty": 3}, {"id": "L3", "qty": 4}]}
  6. Insufficient total across populated lots —
     consume([{"id": "L1", "qty": 2}, {"id": "L2", "qty": 3}], 10) -> raises ValueError
  7. Empty lots list with qty>0 — consume([], 1) -> raises ValueError
  8. Non-positive qty (0) —
     consume([{"id": "L1", "qty": 5}], 0) -> raises ValueError
```

See [`prompt.txt`](prompt.txt) for a copy-pasteable version.

## Run it

```bash
cd examples/realworld-functions/fifo-lot-consumer
cat prompt.txt
```

Then, in Claude Code, generate the test:

```text
/canary-write-test  <paste the contents of prompt.txt>
```

Canary will:

1. Classify the request as `api` (pytest hint, structured dict I/O)
2. Pick `pytest` from the framework registry
3. Write a `test_consume.py` file under `tests/generated/`
4. Print the file path + feedback hint

## What Canary should produce

Eight test functions covering FIFO order and partial / exact / insufficient
consumption. The conservation invariant is the one most easily skipped:

```python
def test_conservation_holds_across_partial_consumption():
    lots = [
        {"id": "L1", "qty": 5},
        {"id": "L2", "qty": 3},
        {"id": "L3", "qty": 4},
    ]
    result = consume(lots, 2)
    total_out = sum(c["qty"] for c in result["consumed"]) + sum(
        r["qty"] for r in result["remaining"]
    )
    assert total_out == sum(l["qty"] for l in lots)

def test_insufficient_total_raises_without_partial_consumption():
    with pytest.raises(ValueError):
        consume([{"id": "L1", "qty": 2}, {"id": "L2", "qty": 3}], 10)
```

## Running the generated test

```bash
pip install pytest
pytest tests/generated/test_consume.py -v
```

## Variations to try

- **Multi-warehouse lots:** extend the lot shape to `{"id": str, "qty":
  int, "warehouse": str}` and ask Canary for tests that consume within a
  single warehouse only, leaving other warehouses' lots untouched
- **Expiry-aware FIFO:** add an `expires_at` field and ask for a variant
  that consumes the soonest-expiring lots first (FEFO) instead of list
  order, then contrast the two orderings on the same input
- **Reservation/rollback:** wrap `consume` in a two-phase `reserve` /
  `commit` pair and ask for a test proving a failed commit restores the
  original lots unchanged

## See also

- [Getting Started → generating tests](../../../docs/wiki/Getting-Started.md)
- [Writing Good Prompts](../../../docs/wiki/Writing-Good-Prompts.md)
- [Real-world functions overview](../README.md)
