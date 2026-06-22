# Example: LEGO Tracker — Reconcile Collection

Tests a pure `reconcile_collection` function that diffs a locally-tracked
set of LEGO IDs against an API response from Rebrickable, returning three
buckets: matched, local-only, and API-only.

This is a **unit** example — no HTTP, no database, no fixtures needed.
The entire test surface is a dict-in / dict-out pure function.

## Prompt

```text
Generate pytest unit tests for a reconcile_collection function.

Signature:
    def reconcile_collection(
        local_ids: list[str],
        api_sets: list[dict],
    ) -> dict:

The function compares locally-tracked LEGO set IDs against a list of sets
returned by the Rebrickable API. It returns a dict with three keys:
  - "matched":    dicts from api_sets whose set_num appears in local_ids
  - "local_only": set IDs in local_ids that have no matching entry in api_sets
  - "api_only":   dicts from api_sets whose set_num does NOT appear in local_ids

Each item in api_sets is a dict with keys: set_num (str), name (str), num_parts (int).

Cover these cases:
  1. Happy path — some sets in both, one local-only, one api-only
  2. Perfect match — every local ID has an api_sets entry, nothing left over
  3. Empty local list — everything falls into api_only
  4. Empty api_sets — everything falls into local_only
  5. Both empty — all three result keys are empty lists
```

See [`prompt.txt`](prompt.txt) for a copy-pasteable version.

## Run it

```bash
cd examples/realworld-functions/lego-tracker-reconcile-collection
cat prompt.txt
```

Then, in Claude Code, generate the test:

```text
/canary-write-test  <paste the contents of prompt.txt>
```

Canary will:

1. Classify the request as `api` (pure function with dict I/O, no framework hint)
2. Pick `pytest` from the framework registry
3. Write a `test_reconcile_collection.py` file under `tests/generated/`
4. Print the file path + feedback hint

## What Canary should produce

Expect five test methods (or parametrized cases), each asserting the three
returned keys. Rough shape:

```python
def test_happy_path():
    local_ids = ["42115", "75192"]
    api_sets = [
        {"set_num": "42115", "name": "Lamborghini Sián FKP 37", "num_parts": 3696},
        {"set_num": "75192", "name": "Millennium Falcon", "num_parts": 7541},
        {"set_num": "10281", "name": "Bonsai Tree", "num_parts": 878},
    ]
    result = reconcile_collection(["42115", "75192", "60197"], api_sets)
    assert len(result["matched"]) == 2
    assert result["local_only"] == ["60197"]
    assert result["api_only"] == [{"set_num": "10281", ...}]
```

The exact structure (class vs. functions, fixture use, assertion style) varies
by run — the important thing is five distinct scenarios covered.

## Running the generated test

```bash
pip install pytest
pytest tests/generated/test_reconcile_collection.py -v
```

The generated tests assert against a function stub — paste your real
`reconcile_collection` implementation first, or point the import at your
module path.

## Variations to try

- **Stricter:** ask Canary to also assert that `matched` preserves the
  original API dict order
- **Error path:** extend the prompt with a case where `local_ids` contains
  duplicates — what should the function do?
- **Broader:** swap to a music-library reconcile or book inventory reconcile;
  the prompt shape stays identical

## See also

- [Getting Started → generating tests](../../../docs/wiki/Getting-Started.md)
- [Writing Good Prompts](../../../docs/wiki/Writing-Good-Prompts.md)
- [Real-world functions overview](../README.md)
