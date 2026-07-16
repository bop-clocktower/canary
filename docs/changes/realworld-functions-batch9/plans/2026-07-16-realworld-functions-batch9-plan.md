# Plan: Real-World Function Examples — Batch 9

<!-- markdownlint-disable-file MD013 MD032 -->
<!-- Generated implementation plan: task steps mix long prose/command lines
     with label-then-list blocks (**Files:** followed by a list), matching the
     canary-fail-fast plan's MD013/MD032 relaxation for working docs. The
     example files this plan produces (prompt.txt, README.md) are NOT exempt
     — they must pass markdownlint/MD013 (80 cols) on their own, per Task 4. -->

**Date:** 2026-07-16 | **Spec:** `docs/changes/realworld-functions-batch9/proposal.md` | **Tasks:** 5 | **Time:** ~28 min | **Integration Tier:** small

## Goal

Add two new prompt-only example directories (`fifo-lot-consumer`,
`luhn-card-validator`) to `examples/realworld-functions/`, each with a
template-faithful `prompt.txt` + `README.md`, cataloged in both README
tables, verified green by the existing structural test and markdownlint.

This is **not** a TDD code-writing task. There is no application code to
implement or unit-test — the deliverable is prompt/doc content, and the only
"tests" involved are the repo's own structural guard
(`tests/unit/test_examples_catalog.py`) and markdownlint, both of which
already exist and are run unmodified in Task 4.

## Observable Truths (Acceptance Criteria)

1. `examples/realworld-functions/fifo-lot-consumer/prompt.txt` and
   `README.md` exist; the prompt has exactly 8 numbered cases matching the
   spec's Technical Design section.
2. `examples/realworld-functions/luhn-card-validator/prompt.txt` and
   `README.md` exist; the prompt has exactly 8 numbered cases matching the
   spec's Technical Design section.
3. Both `examples/realworld-functions/README.md` and `examples/README.md`
   list both new examples in their catalog tables.
4. `uv run pytest tests/unit/test_examples_catalog.py -v` passes (all
   subtests green, including the two new example dirs).
5. `npx --no markdownlint-cli` passes on all 4 new/changed `.md` files.
6. The catalog's framework mix after this batch is 9 pytest / 10 vitest (19
   total) — matching the spec's stated success criterion.

## Uncertainties

- [ASSUMPTION] The spec's Technical Design section describes
  `fifo-lot-consumer`'s 8 cases in prose ("single lot, partial consumption",
  "spans two lots (first fully drained, second partial)", etc.) without
  literal lot/qty numbers — unlike `luhn-card-validator`, whose 8 cases are
  already fully concrete strings in the spec. This plan pins concrete
  `lots`/`qty` values for each `fifo-lot-consumer` case (Task 1) that (a)
  satisfy the case's prose description exactly and (b) satisfy the spec's
  stated conservation invariant (`sum(lots) == sum(consumed) +
  sum(remaining)`, verified by hand for every case below). This is
  formatting the spec's cases into concrete test data, not inventing new
  cases. If wrong, only Task 1's `prompt.txt`/`README.md` content changes.
- [ASSUMPTION] Canary's request-classification tag (the "Classify the
  request as `X`" line in each README's "What Canary should produce"
  section) is illustrative, not verified by any test. This plan uses `api`
  (structured dict I/O) for `fifo-lot-consumer` — matching the
  `lego-tracker-reconcile-collection` / `access-policy-evaluator` precedent
  for `list[dict]`/`dict`-shaped functions — and `python_unit` (pure
  checksum function) for `luhn-card-validator` — matching the
  `tax-bracket-calculator` / `order-state-machine` precedent for pure
  scalar-input functions. Cosmetic if off.
- [DEFERRABLE] Exact generated test file names Canary would pick
  (`test_consume.py`, `test_is_valid_luhn.py`) in each README's "What
  Canary should produce" section are illustrative only — not verified by
  any test, cosmetic if off.

## File Map

- CREATE `examples/realworld-functions/fifo-lot-consumer/prompt.txt`
- CREATE `examples/realworld-functions/fifo-lot-consumer/README.md`
- CREATE `examples/realworld-functions/luhn-card-validator/prompt.txt`
- CREATE `examples/realworld-functions/luhn-card-validator/README.md`
- MODIFY `examples/realworld-functions/README.md` (2 catalog rows)
- MODIFY `examples/README.md` (2 catalog rows)

## Skeleton

_Not produced — task count (5) is below the standard-rigor threshold (8)._

## Tasks

### Task 1: Create `fifo-lot-consumer/` (prompt.txt + README.md)

**Depends on:** none | **Files:** `examples/realworld-functions/fifo-lot-consumer/prompt.txt`, `examples/realworld-functions/fifo-lot-consumer/README.md`

- [ ] **Step 1:** Create `examples/realworld-functions/fifo-lot-consumer/prompt.txt`:

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

- [ ] **Step 2:** Create `examples/realworld-functions/fifo-lot-consumer/README.md`.
   NOTE: this block uses a 4-backtick outer fence (` ```` `) because the
   README content itself contains nested triple-backtick fences (the
   `text`/`bash`/`python` blocks below) — do not write the 4-backtick
   markers into the actual file, they exist only to delimit this plan step.

````markdown
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
````

- [ ] **Step 3:** Run: `harness validate`
- [ ] **Step 4:** Commit: `feat(examples): add fifo-lot-consumer realworld example`

### Task 2: Create `luhn-card-validator/` (prompt.txt + README.md)

**Depends on:** none | **Files:** `examples/realworld-functions/luhn-card-validator/prompt.txt`, `examples/realworld-functions/luhn-card-validator/README.md`

- [ ] **Step 1:** Create `examples/realworld-functions/luhn-card-validator/prompt.txt`:

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

- [ ] **Step 2:** Create `examples/realworld-functions/luhn-card-validator/README.md`.
   NOTE: 4-backtick outer fence for the same nesting reason as Task 1.

````markdown
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

1. Classify the request as `python_unit` (pytest hint, pure checksum
   function)
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
````

- [ ] **Step 3:** Run: `harness validate`
- [ ] **Step 4:** Commit: `feat(examples): add luhn-card-validator realworld example`

### Task 3: Add catalog rows to both README.md files

**Depends on:** Task 1, Task 2 | **Files:** `examples/realworld-functions/README.md`, `examples/README.md` | **Category:** integration

- [ ] **Step 1:** In `examples/realworld-functions/README.md`, append two rows to the
   `## Catalog` table (after the `token-bucket-rate-limiter` row, before the
   `## How these differ from the top-level examples` heading):

```markdown
| [fifo-lot-consumer](fifo-lot-consumer/) | Unit | Pytest | FIFO inventory consumption — partial/exact draining, order-preserving remainder, conservation invariant |
| [luhn-card-validator](luhn-card-validator/) | Unit | Pytest | Luhn checksum validation — doubling-reduction, malformed-input reject, minimal 2-digit edge case |
```

- [ ] **Step 2:** In `examples/README.md`, append the same two rows (with the
   `realworld-functions/` path prefix) to the `## Real-world function
   examples` table (after the `token-bucket-rate-limiter` row, before the
   "See [realworld-functions/README.md]..." line):

```markdown
| [fifo-lot-consumer](realworld-functions/fifo-lot-consumer/) | Unit | Pytest | FIFO inventory consumption — partial/exact draining, order-preserving remainder, conservation invariant |
| [luhn-card-validator](realworld-functions/luhn-card-validator/) | Unit | Pytest | Luhn checksum validation — doubling-reduction, malformed-input reject, minimal 2-digit edge case |
```

- [ ] **Step 3:** Run: `harness validate`
- [ ] **Step 4:** Commit: `docs(examples): catalog realworld-functions batch 9`

### Task 4: Verify — structural test + markdownlint

**Depends on:** Task 3 | **Files:** none (verification only)

- [ ] **Step 1:** Run the structural catalog test:

```bash
uv run pytest tests/unit/test_examples_catalog.py -v
```

   Expect: all subtests pass, including `test_each_example_has_prompt_txt`,
   `test_each_example_has_readme`, and `test_each_example_linked_in_catalog`
   for both new directories.

- [ ] **Step 2:** Run markdownlint on the 4 new/changed markdown files:

```bash
npx --no markdownlint-cli \
  examples/realworld-functions/fifo-lot-consumer/README.md \
  examples/realworld-functions/luhn-card-validator/README.md \
  examples/realworld-functions/README.md \
  examples/README.md
```

   Expect: no output, exit code 0. If MD013 (line length) fires on any
   prose line, rewrap that line in the offending file only — table rows and
   fenced code blocks are exempt per `.markdownlint.json`.

- [ ] **Step 3:** Manually confirm the framework mix: count `Vitest` vs `Pytest` rows in
   `examples/realworld-functions/README.md` — expect 10 vitest / 9 pytest
   (19 total), matching the spec's stated success criterion.

- [ ] **Step 4:** If either check fails, fix the specific file and re-run both commands —
   do not proceed to Task 5 until both are green.

### Task 5: Commit remaining changes and open PR

**Depends on:** Task 4 | **Files:** none (git operations only)

- [ ] **Step 1:** Confirm branch: `git branch --show-current` → `feat/realworld-functions-batch9`
   (already checked out; no new branch needed).
- [ ] **Step 2:** Confirm all changes from Tasks 1-3 are committed:

```bash
git status
git log --oneline -5
```

- [ ] **Step 3:** Push the branch and open the PR:

```bash
git push -u origin feat/realworld-functions-batch9
gh pr create --title "feat(examples): add realworld-functions batch 9" --body "$(cat <<'EOF'
## Summary
- Adds two prompt-only examples to examples/realworld-functions/:
  fifo-lot-consumer (pytest), luhn-card-validator (pytest)
- Catalogs both in examples/realworld-functions/README.md and
  examples/README.md
- Selected from the leftover ranked pool in
  docs/ideation/realworld-function-batch6-2026-06-27.md; spec at
  docs/changes/realworld-functions-batch9/proposal.md

## Test plan
- [x] uv run pytest tests/unit/test_examples_catalog.py -v
- [x] npx --no markdownlint-cli on the 4 new/changed README/prompt files
- [x] harness validate
EOF
)"
```

- [ ] **Step 4:** Run: `harness validate`

## Success Criteria

- All 5 tasks complete; `harness validate` passes after each.
- `uv run pytest tests/unit/test_examples_catalog.py -v` green.
- `npx --no markdownlint-cli` green on all 4 new/changed `.md` files.
- Both catalog READMEs list both new examples.
- Catalog framework mix is 9 pytest / 10 vitest (19 total).
- PR opened against `main` from `feat/realworld-functions-batch9`.
