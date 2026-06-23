# Real-World Function Examples — Batch 4

**Status:** approved (design sign-off 2026-06-22)
**Type:** docs/examples (prompt-only) — small change, no production code
**Keywords:** realworld-functions, examples, prompt-only, vitest, pytest,
largest-remainder, state-machine, full-jitter, dependency-injection, catalog

## Overview and goals

Add three pure-function examples to `examples/realworld-functions/`, continuing
the prompt-only catalog (`prompt.txt` + `README.md`, no committed tests). Selected
and objection-tested in `docs/ideation/realworld-function-batch4-2026-06-22.md`.
Goal: each example is a crisp contract with a counterintuitive invariant that
teaches a testing skill the existing seven do not. After this batch the catalog
is **5 pytest / 5 vitest** (parity).

Out of scope: implementing the functions (examples are prompt-only), changing the
example template, adding frameworks, property-test libraries (not in the registry).

## Decisions made

| Decision | Choice | Rationale |
| --- | --- | --- |
| Batch size | Top 3 (money-allocator, order-state-machine, retry-backoff-schedule) | Matches batch-3 cadence; lands catalog at 5/5 parity |
| Cases-design approach | Template-faithful (8 enumerated cases each) | Catalog uniformity; no non-registry deps; technique surfaced in "Variations to try" |
| money-allocator remainder rule | Largest-remainder, ties→lowest index | Deterministic; preserves `sum===total` invariant |
| order-state-machine fail-mode | Raise `ValueError` on illegal/unknown transition | Pythonic; makes terminal-rejection a crisp `pytest.raises` assertion |
| retry-backoff jitter | Full jitter `rng() * min(cap, base·2^i)` | AWS-canonical; injected `rng` → deterministic bound/exact assertions |

## Technical design

Each example is a directory under `examples/realworld-functions/` containing
`prompt.txt` (signature + rules + 8 numbered cases) and `README.md` (locked
structure: summary → "X unit example" → Prompt → Run it → What Canary should
produce → Running the generated test → Variations to try → See also).

### money-allocator (vitest)

`allocate(totalCents: number, ratios: number[]): number[]` — largest-remainder
split, integer parts summing exactly to total. Empty/all-zero ratios → `RangeError`.
Cases: even split; equal-remainder tie→lowest; distinct remainders (2 leftover →
two largest); clean weighted; single ratio; zero ratio→0; zero total; empty/all-zero
→ throws. Headline invariant: `sum(allocate(t,r)) === t`.

### order-state-machine (pytest)

`apply(state, event, machine) -> str` — pure lookup over a sparse transition map;
`ValueError` on absent state or undefined event; terminal states (empty map) reject
all events; explicit self-loops legal. Cases: valid; branch; legal self-loop;
multi-step; unknown event→raise; terminal→raise; unknown state→raise;
empty-string event→raise.

### retry-backoff-schedule (vitest)

`backoffDelays(attempts, baseMs, capMs, rng): number[]` — full jitter with injected
`rng`. Cases: `attempts=0`→`[]`; floor (rng=0); half (rng=0.5); cap clamps;
scripted rng exact sequence; `base=0`→zeros; `attempts=1`; negative→`RangeError`.
Teaches dependency-injection of nondeterminism (cases 2/3/5).

## Integration Points

- **Entry Points:** three new example directories under
  `examples/realworld-functions/` (`money-allocator/`, `order-state-machine/`,
  `retry-backoff-schedule/`), each with `prompt.txt` + `README.md`.
- **Registrations Required:** add one catalog row per example to BOTH
  `examples/realworld-functions/README.md` and `examples/README.md` (the structural
  test `tests/unit/test_examples_catalog.py` enforces the link).
- **Documentation Updates:** the two catalog READMEs above. No AGENTS.md change.
- **Architectural Decisions:** None (no ADR — small docs change).
- **Knowledge Impact:** None.

## Success criteria

- Three new directories exist, each with `prompt.txt` + `README.md` matching the
  locked template shape (8 numbered cases in the prompt).
- Both catalog READMEs list all three; `tests/unit/test_examples_catalog.py` passes.
- markdownlint passes on the new READMEs.
- Catalog framework mix is 5 pytest / 5 vitest.

## Implementation order

1. Create the three directories with `prompt.txt` + `README.md` (template-faithful).
2. Add catalog rows to both READMEs.
3. Run `test_examples_catalog.py` + markdownlint; verify green.
4. Commit on a feature branch; open PR.
