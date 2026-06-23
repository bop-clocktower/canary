# Example: Order State Machine

Tests an `apply` function that advances a finite state machine over a sparse
transition map — returning the next state, or raising on an illegal transition.

This is a **Python unit** example. State machines are deceptively simple to
implement and easy to get wrong at the edges that matter most: a **terminal
state must reject every event** (a delivered order can't be cancelled), an
**unknown event must be rejected rather than silently ignored**, and a
**self-loop is only legal when the map explicitly allows it**. The prompt encodes
those edges so the generated suite exercises the contract, not just the happy
path down the lifecycle.

## Prompt

```text
Generate pytest unit tests for an apply function.

Signature:
    def apply(
        state: str,
        event: str,
        machine: dict[str, dict[str, str]],
    ) -> str:

The function advances a finite state machine. `machine` maps each state to a
dict of {event: next_state}. The function looks up the transition for the given
(state, event) and returns the next state.

Transition rules:
  - If machine[state][event] is defined, return that next state.
  - If the state is not present in machine, or the event is not defined for that
    state, raise a ValueError — illegal and unknown transitions are rejected, not
    silently ignored.
  - A terminal state has an empty transition dict, so every event raises.
  - A self-loop is legal only when explicitly present (e.g. machine maps
    state "pending" event "edit" back to "pending").
  - The function is a pure lookup — it never mutates `machine`.

Use this order-lifecycle machine in the tests:
    ORDER = {
        "cart":      {"checkout": "pending"},
        "pending":   {"pay": "paid", "cancel": "cancelled", "edit": "pending"},
        "paid":      {"ship": "shipped", "refund": "refunded"},
        "shipped":   {"deliver": "delivered"},
        "delivered": {},   # terminal
        "cancelled": {},   # terminal
        "refunded":  {},   # terminal
    }

Cover these cases:
  1. Valid transition — apply("cart", "checkout", ORDER) → "pending"
  2. Branch transition — apply("pending", "cancel", ORDER) → "cancelled"
  3. Legal self-loop — apply("pending", "edit", ORDER) → "pending"
  4. Multi-step transition — apply("paid", "ship", ORDER) → "shipped"
  5. Unknown event for a valid state — apply("pending", "ship", ORDER) → raises ValueError
  6. Any event on a terminal state — apply("delivered", "refund", ORDER) → raises ValueError
  7. Unknown state — apply("archived", "checkout", ORDER) → raises ValueError
  8. Empty-string event — apply("pending", "", ORDER) → raises ValueError
```

See [`prompt.txt`](prompt.txt) for a copy-pasteable version.

## Run it

```bash
cd examples/realworld-functions/order-state-machine
cat prompt.txt
```

Then, in Claude Code, generate the test:

```text
/canary-write-test  <paste the contents of prompt.txt>
```

Canary will:

1. Classify the request as `python_unit` (pytest hint, pure lookup function)
2. Pick `pytest` from the framework registry
3. Write a `test_apply.py` file under `tests/generated/`
4. Print the file path + feedback hint

## What Canary should produce

Eight test functions over the fixed `ORDER` machine. The terminal-state and
self-loop cases are where most state-machine implementations slip — either
swallowing illegal events or treating an unknown event as a no-op:

```python
import pytest

def test_terminal_state_rejects_every_event():
    with pytest.raises(ValueError):
        apply("delivered", "refund", ORDER)

def test_explicit_self_loop_is_legal():
    assert apply("pending", "edit", ORDER) == "pending"
```

## Running the generated test

```bash
pip install pytest
pytest tests/generated/test_apply.py -v
```

## Variations to try

- **Parametrized matrix:** ask Canary for a `@pytest.mark.parametrize` table of
  (state, event, expected) plus a second table of (state, event) pairs that must
  raise — the transition table is exactly the shape parametrization fits
- **Guarded transitions:** extend the map value to `{event: {"to": str, "guard":
  str}}` and ask for tests where a guard blocks an otherwise-legal transition
- **Transition trace:** change the return to the full path
  `apply_sequence(state, events) -> list[str]` and assert the visited states

## See also

- [Getting Started → generating tests](../../../docs/wiki/Getting-Started.md)
- [Writing Good Prompts](../../../docs/wiki/Writing-Good-Prompts.md)
- [Real-world functions overview](../README.md)
