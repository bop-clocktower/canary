# TS Migration Pilot — Decision Gate

**Date:** 2026-07-22 | **Pilot:** `agent/analysis/` → `ts/` | **Plan:**
[2026-07-22-ts-migration-pilot-analysis-plan.md](2026-07-22-ts-migration-pilot-analysis-plan.md)

This is the `[checkpoint:decision]` at the end of the pilot. It reports what was
proven and recommends whether to continue the strangler migration.

## Outcome: the pilot succeeded

All six acceptance truths from the plan hold:

| #   | Truth                                                     | Result                                       |
| --- | --------------------------------------------------------- | -------------------------------------------- |
| 1   | `tsc` strict compiles the module clean                    | ✅                                           |
| 2   | Vitest coverage gate enforced                             | ✅ 99.42% lines / 86.32% branch (gate 90/85) |
| 3   | TS reports match Python golden byte-for-byte              | ✅ all 6 reports                             |
| 4   | TS reads the Python-written `history-v2.jsonl`            | ✅ (the seam)                                |
| 5   | New CI job; Python `validate` + `fail_under=81` untouched | ✅ `ts-validate`, parallel                   |
| 6   | Python still builds/tests/ships unchanged                 | ✅ no Python source touched                  |

- **Tests:** 71 Vitest specs, exit 0. **Ported:** `reports.ts`, `engine.ts`, the
  history seam (`record.ts`, `ndjson-store.ts`, `detector.ts`), shared
  `round.ts`.
- **Seam:** file-based (NDJSON) — no FFI, no subprocess. The record format is
  the entire contract. This is the most important result: it means subsystems
  can move one at a time with the on-disk history as the boundary.

## What the pilot taught us (friction + surprises)

1. **Float rendering parity.** Python `str(10.0)` → `"10.0"`; JS `${10.0}` →
   `"10"`. Only the parity harness caught it (in the report _header_ threshold
   params, not the table values). Resolved with a `pyFloat()` helper.
   **Lesson:** every ported module needs a golden-parity test; type-checking and
   unit tests alone would have shipped a subtle formatting drift.
2. **Round-half-to-even.** Python's banker's rounding had to be reimplemented
   (`round1`) rather than `Math.round`. Cheap once known.
3. **Faithful-port discipline.** `engine.py` never populates `area_health` rows
   (always renders the empty message). The port preserves that bug rather than
   "fixing" it — a migration must be behaviour-preserving; fixes are a separate,
   reviewable change afterward.
4. **Toolchain guardrails.** ESLint was dropped: the repo uses none, and the
   `protect-config` hook (correctly) blocks AI-authored linter configs. `tsc`
   strict + Prettier is the gate. `esbuild`'s install script needs approval
   under the local script-guard (stock CI npm runs it normally).
5. **Schema versioning.** Real Python records carry no version field (v2 lives
   in the filename). The TS reader tolerates absence but fails loudly on an
   explicit unknown version — a forward-compat guard the Python side lacks.

## Effort signal (for extrapolation)

`agent/analysis/` is 609 LOC of Python. It ported cleanly but the _parity
scaffolding_ (golden capture, normalization, float-rendering fixes) was a real
fraction of the work and is now reusable. Extrapolating to the big subsystems —
`core/` (6.5k LOC) and `guardian/` (3.2k LOC, coupled to `core`, on the CI
critical path) — the raw porting scales with LOC, but their coupling and
side-effects (not pure `rows→string` functions) will cost more per line than
`analysis/` did.

## Recommendation

**Proceed — with `agent/history/` as the next subsystem.** Rationale:

- It is the analysis vertical's own dependency; porting it lets TS **own the
  write side** of the `history-v2.jsonl` seam, completing one clean end-to-end
  slice (write → read → report) entirely in TS while Python still ships.
- It is self-contained (no cross-subsystem imports). Its Supabase path is the
  one external-SDK risk to confront early, on a small surface, before it blocks
  a larger subsystem.
- Defer `core/` and `guardian/` until the write-side seam and the Supabase
  boundary are proven — they are the highest-coupling, highest-stakes modules.

**Do not** cut over the user-facing `canary analyze` CLI yet. Cutover is its own
decision once a full vertical (history + analysis) is green in TS.

### Decision needed

- **A — Proceed to `history/`** (recommended): plan + execute the next pilot.
- **B — Proceed, different subsystem:** name it.
- **C — Adjust toolchain first:** e.g. reconsider the coverage floor, add
  branch-coverage parity, or revisit the no-ESLint call.
- **D — Stop:** hold the migration; keep the `ts/` pilot as-is.
