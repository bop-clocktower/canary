# Example: Topological Task Order

Tests an `order` function that returns a dependency-respecting execution order
for a task graph.

This is a **Python unit** example, and — like `order-state-machine` — it raises
`ValueError` on invalid input rather than silently coercing it. Dependency
ordering looks like a solved textbook algorithm until you notice what
topological sort leaves undefined: a valid graph has _many_ valid orders, so an
untied contract cannot be asserted by equality at all. Pinning a tiebreak —
among all currently-eligible tasks, emit the lexicographically smallest —
collapses the output to exactly one list, the same move `dense-rank-leaderboard`
makes with tie schemes. Case 4 is then the one that catches a naive
implementation: `{"b": [], "a": ["b"]}` must yield `["b", "a"]`, because
dependency order beats alphabetical order. Case 5 catches the other half — two
independent chains must interleave by the tiebreak, not run one-after-the-other.

## Prompt

```text
Generate pytest unit tests for an order function.

Signature:
    def order(tasks: dict[str, list[str]]) -> list[str]:

The function returns a dependency-respecting execution order for a task
graph. Each key is a task name; its value is the list of task names that must
appear before it.

Rules:
  - A task may be emitted only once every one of its prerequisites has
    already been emitted.
  - Among all currently-eligible tasks, the lexicographically smallest name
    is emitted next. This tiebreak is not cosmetic: a valid dependency graph
    has many valid topological orders, and pinning the tiebreak is what makes
    the output a single assertable list rather than "any valid order".
  - A prerequisite naming a task that is not a key in `tasks` raises a
    ValueError — an unknown prerequisite is rejected, never silently skipped.
  - A cycle raises a ValueError. A task listing itself as its own
    prerequisite is a cycle.
  - An empty mapping returns an empty list.
  - The function is pure — it never mutates the input dict or its lists.
  - Invariant: every task appears exactly once in the result, and always
    after all of its prerequisites.

Cover these cases:
  1. Linear chain —
     order({"c": ["b"], "b": ["a"], "a": []}) -> ["a", "b", "c"]
  2. All tasks independent, emitted in lexicographic order —
     order({"b": [], "c": [], "a": []}) -> ["a", "b", "c"]
  3. Diamond — one root, two middles, one join —
     order({"d": ["b", "c"], "b": ["a"], "c": ["a"], "a": []}) ->
     ["a", "b", "c", "d"]
  4. Dependency order beats lexicographic order —
     order({"b": [], "a": ["b"]}) -> ["b", "a"]
  5. Two independent chains (a -> c and b -> d), interleaved by the
     tiebreak rather than run one-after-the-other —
     order({"a": [], "c": ["a"], "b": [], "d": ["b"]}) ->
     ["a", "b", "c", "d"]   (NOT ["a", "c", "b", "d"])
  6. Empty mapping — order({}) -> []
  7. Two-node cycle — order({"a": ["b"], "b": ["a"]}) -> raises ValueError
  8. Prerequisite naming an unknown task —
     order({"a": ["ghost"]}) -> raises ValueError
```

See [`prompt.txt`](prompt.txt) for a copy-pasteable version.

## Run it

```bash
cd examples/realworld-functions/topological-task-order
cat prompt.txt
```

Then, in Claude Code, generate the test:

```text
/canary-write-test  <paste the contents of prompt.txt>
```

Canary will:

1. Classify the request as `api` (pytest hint, structured dict input)
2. Pick `pytest` from the framework registry
3. Write a `test_order.py` file under `tests/generated/`
4. Print the file path + feedback hint

## What Canary should produce

Eight test functions covering ordering, the tiebreak, and both rejection paths.
The two most easily skipped are the tiebreak's precedence rule and the
unknown-prerequisite rejection:

```python
def test_dependency_order_beats_lexicographic_order():
    # "a" sorts first, but it depends on "b" — so "b" must be emitted first.
    assert order({"b": [], "a": ["b"]}) == ["b", "a"]

def test_unknown_prerequisite_is_rejected_not_skipped():
    with pytest.raises(ValueError):
        order({"a": ["ghost"]})
```

## Running the generated test

```bash
pip install pytest
pytest tests/generated/test_order.py -v
```

## Variations to try

- **Parallel wave scheduling:** ask for a variant returning `list[list[str]]` —
  each inner list a wave of tasks whose prerequisites are all satisfied,
  runnable concurrently — then contrast its wave count against the flat order's
  length
- **Cycle reporting:** extend the `ValueError` to name the tasks forming the
  cycle, and ask for a test asserting the reported cycle members rather than
  just the raise
- **Priority tiebreak:** replace the lexicographic tiebreak with an injected
  `priority: dict[str, int]` (highest priority first, name as the secondary
  tiebreak) and ask for a test proving the same graph produces a different —
  still valid — order

## See also

- [Getting Started → generating tests](../../../docs/wiki/Getting-Started.md)
- [Writing Good Prompts](../../../docs/wiki/Writing-Good-Prompts.md)
- [Real-world functions overview](../README.md)
