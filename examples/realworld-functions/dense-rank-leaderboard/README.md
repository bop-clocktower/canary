# Example: Dense-Rank Leaderboard

Tests a `rank` function that assigns a **competition rank** to each score in a
leaderboard — the kind of ranking where tied players share a place and the next
player skips the gap.

This is a **Python unit** example — no HTTP, no DOM, no fixtures. Ranking looks
like "sort and number them 1, 2, 3" until two scores tie. Then the whole
difficulty appears: under standard competition ranking, `[100, 90, 90, 80]`
ranks as `[1, 2, 2, 4]` — there is **no rank 3**, because two players hold
second place and the next distinct score takes fourth. A robust suite has to
prove the implementation skips that gap rather than silently renumbering.

## Prompt

```text
Generate pytest unit tests for a rank function.

Signature:
    def rank(scores: list[int]) -> list[int]:

The function assigns a competition rank to each score and returns a list of
ranks parallel to the input: rank[i] is the rank of scores[i]. Higher scores
rank better — the highest score is rank 1.

Ranking rules (standard "competition" ranking):
  - A score's rank is 1 + the number of scores strictly greater than it.
  - Tied scores share the same rank, and the next distinct (lower) score skips
    the gap: [100, 90, 90, 80] -> [1, 2, 2, 4] — there is no rank 3.
  - Ranks follow the input order; the input list is never reordered.
  - The function is pure — it does not mutate `scores`.
  - An empty list returns an empty list.

Cover these cases:
  1. Strictly descending, no ties — rank([100, 90, 80]) -> [1, 2, 3]
  2. Tie shares a rank, next skips the gap — rank([100, 90, 90, 80]) -> [1, 2, 2, 4]
  3. Input order is preserved (unsorted input) — rank([90, 100, 80]) -> [2, 1, 3]
  4. All scores equal — rank([50, 50, 50]) -> [1, 1, 1]
  5. Three-way tie at the top — rank([100, 100, 100, 70]) -> [1, 1, 1, 4]
  6. Tie in the middle — rank([100, 80, 80, 80, 50]) -> [1, 2, 2, 2, 5]
  7. Single score — rank([42]) -> [1]
  8. Empty list — rank([]) -> []
```

See [`prompt.txt`](prompt.txt) for a copy-pasteable version.

## Run it

```bash
cd examples/realworld-functions/dense-rank-leaderboard
cat prompt.txt
```

Then, in Claude Code, generate the test:

```text
/canary-write-test  <paste the contents of prompt.txt>
```

Canary will:

1. Classify the request as `backend_unit` (pytest hint)
2. Pick `pytest` from the framework registry
3. Write a `test_rank.py` file under `tests/generated/`
4. Print the file path + feedback hint

## What Canary should produce

Eight test functions, likely grouped in a `class TestRank` or as module-level
`test_*` functions. The tie cases are where naïve "sort and enumerate"
implementations break:

```python
def test_tie_shares_rank_and_skips_the_gap():
    # two scores tie for 2nd, so the next score is 4th — there is no rank 3
    assert rank([100, 90, 90, 80]) == [1, 2, 2, 4]


def test_preserves_input_order():
    assert rank([90, 100, 80]) == [2, 1, 3]
```

## Running the generated test

```bash
pip install pytest
pytest tests/generated/test_rank.py
```

The tests import a `rank` stub — paste your real implementation or point the
import at your module before running.

## Variations to try

- **Dense vs standard contrast:** ask Canary to add a second function
  `dense_rank` where ties do *not* skip the gap (`[100, 90, 90, 80] ->
  [1, 2, 2, 3]`) and a test that contrasts the two — makes the "skipped gap"
  the explicit subject under test
- **Property check:** ask for a Hypothesis case asserting that for any list, the
  rank of the maximum is always `1` and the number of distinct ranks equals the
  number of distinct scores
- **Ascending option:** add a `descending: bool = True` parameter so the lowest
  score can rank 1 (golf scoring), and assert both directions
- **Stable tie payload:** change the input to `list[tuple[str, int]]` of
  `(player, score)` and return `list[tuple[str, int]]` of `(player, rank)` so the
  example reads like a real standings table

## See also

- [Getting Started → generating tests](../../../docs/wiki/Getting-Started.md)
- [Writing Good Prompts](../../../docs/wiki/Writing-Good-Prompts.md)
- [Real-world functions overview](../README.md)
