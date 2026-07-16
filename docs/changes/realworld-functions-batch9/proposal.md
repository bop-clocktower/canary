# Real-World Function Examples — Batch 9

**Status:** approved (design sign-off pending)
**Type:** docs/examples (prompt-only) — small change, no production code
**Keywords:** realworld-functions, examples, prompt-only, pytest, fifo,
inventory, luhn, checksum, catalog

## Overview and goals

Add two pure-function examples to `examples/realworld-functions/`,
continuing the prompt-only catalog (`prompt.txt` + `README.md`, no committed
tests). Selected from the leftover ranked pool in
`docs/ideation/realworld-function-batch6-2026-06-27.md` ("Below the cut"
section) — the two least-weak of the four remaining candidates. Goal: each
example teaches a testing skill the existing seventeen do not, despite both
being lower-scored than prior batches' picks.

Out of scope: implementing the functions (examples are prompt-only),
changing the example template, adding frameworks or property-test libraries
(not in the registry), the two remaining ideation candidates
(`truncate-grapheme` — flagged as awkward to mirror across pytest/vitest,
breaking framework parity; `cron-next-fire` — the doc's own weakest-scored
candidate, explicit "parsing surface balloons" scope-creep risk). Both left
for a future batch or fresh ideation.

## Decisions made

| Decision | Choice | Rationale |
| --- | --- | --- |
| Batch size | 2 (fifo-lot-consumer, luhn-card-validator) | Smaller than batch 8's 3, reflecting weaker/thinner source material in the remaining pool; both selected are pytest |
| fifo-lot-consumer: lot shape | `{"id": str, "qty": int}` | Minimal structured record — avoids the ideation doc's flagged risk ("structured return inflates effort relative to payoff") by keeping the record as thin as possible while still being real |
| fifo-lot-consumer: numeric contract | `qty` (requested amount) must be a positive `int`; lot `qty` values assumed well-formed positive ints, not separately validated | Pins the soundness-required numeric contract on the one parameter the doc's error mode ("insufficient → error") actually concerns, without adding lot-shape validation scope beyond the doc's stated scope |
| luhn-card-validator: input contract | ASCII-digit-only string; non-digit chars (dashes, spaces, letters) rejected, not stripped | Directly addresses the doc's flagged risk ("doesn't showcase edge-case design") by giving the function a real malformed-input surface, matching this catalog's established pattern (`pagination-cursor-codec`'s malformed-input handling) |
| luhn-card-validator: case design | Includes a minimal 2-digit case (`"91"`) that explicitly exercises the `>9` doubling-reduction step | The single-code-path risk is specifically about the doubling-overflow branch being incidental rather than deliberately tested; a minimal case makes it deliberate |

## Technical design

Each example is a directory under `examples/realworld-functions/` containing
`prompt.txt` (signature + rules + 8 numbered cases) and `README.md` (locked
structure: summary → "X unit example" → Prompt → Run it → What Canary should
produce → Running the generated test → Variations to try → See also).

### fifo-lot-consumer (pytest)

`consume(lots: list[dict], qty: int) -> dict` — depletes `lots` (each
`{"id": str, "qty": int}`) in FIFO order to satisfy `qty`, returning
`{"consumed": [...], "remaining": [...]}`. `qty` must be a positive `int`
(non-integer or `<=0` → `ValueError`). Insufficient total quantity across
all lots → `ValueError`.

Cases: (1) single lot, partial consumption; (2) single lot, exact
consumption (fully drained, removed from `remaining`); (3) spans two lots
(first fully drained, second partial); (4) spans three lots exactly,
draining all (`remaining=[]`); (5) partial consumption at the front only —
untouched lots preserved in order in `remaining`; (6) insufficient total
across populated lots → `ValueError`; (7) empty `lots` list with `qty>0` →
`ValueError`; (8) non-positive `qty` (`0`) → `ValueError`.

Headline invariant: `sum(consumed) == qty` on success, and
`sum(lots) == sum(consumed) + sum(remaining)` always (conservation) — plus
FIFO order preserved in `remaining`.

### luhn-card-validator (pytest)

`is_valid_luhn(number: str) -> bool` — standard Luhn checksum: from the
rightmost digit, double every second digit moving left, reduce any result
`>9` by subtracting 9, sum all digits, valid iff `sum % 10 == 0`. Input must
be an ASCII-digit-only string — empty or non-digit input raises `ValueError`.

Cases (hand-verified against the algorithm): (1) `"4111111111111111"`
(canonical 16-digit test Visa number) → `True` (digit-sum = 30,
`30 % 10 == 0`); (2) same number, last digit `1→2` → `False` (sum becomes
31); (3) `"91"` → `True` — minimal case exercising the `>9`
doubling-reduction (`9`→doubled`18`→reduced`9`; sum=`1+9=10`); (4) `"0"` →
`True` (single digit, undoubled, sum=0); (5) `"5"` → `False` (sum=5);
(6) `""` → `ValueError`; (7) `"4111-1111-1111-1111"` (contains non-digit
chars) → `ValueError`; (8) `"0000000000000000"` → `True`.

Headline invariant: the algorithm correctly reduces any single-digit
doubling overflow (`5`–`9` doubled) via digit-sum, not naive truncation.

## Integration Points

- **Entry Points:** two new example directories under
  `examples/realworld-functions/` (`fifo-lot-consumer/`,
  `luhn-card-validator/`), each with `prompt.txt` + `README.md`.
- **Registrations Required:** add one catalog row per example to BOTH
  `examples/realworld-functions/README.md` and `examples/README.md` (the
  structural test `tests/unit/test_examples_catalog.py` enforces the
  realworld-functions-level link).
- **Documentation Updates:** the two catalog READMEs above. No AGENTS.md
  change.
- **Architectural Decisions:** None (no ADR — small docs change).
- **Knowledge Impact:** None.

## Success criteria

- Two new directories exist, each with `prompt.txt` + `README.md` matching
  the locked template shape (8 numbered cases in the prompt).
- Both catalog READMEs list both; `tests/unit/test_examples_catalog.py`
  passes.
- markdownlint passes on the new READMEs.
- Catalog framework mix after this batch: 9 pytest / 10 vitest (19 total).

## Implementation order

1. Create the two directories with `prompt.txt` + `README.md`
   (template-faithful).
2. Add catalog rows to both READMEs.
3. Run `test_examples_catalog.py` + markdownlint; verify green.
4. Commit on a feature branch; open PR.
