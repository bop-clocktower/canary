# Plan: No Silent Abstention — Wave 4a (engine long tail)

**Date:** 2026-08-03 | **Spec:** `docs/changes/no-silent-abstention/proposal.md`
(Implementation Order item 4) | **Issue:** #508 | **Tasks:** 9 | **Integration
Tier:** medium

**Branch:** `feat/abstention-wave4-longtail`, based on `origin/main` at
`bf961577` (Wave 3 merged). Baselines: **1727** ts tests, **224** npm tests.

**Wave 4 is split into two PRs.** This one takes the **engine** long tail
(`review-test`, `flake-check`, `heal-test`, `analyze` ×6, `history` ×3,
`skills run`). The standalone skill CLIs (blackhawk / savant / katana, which
import no engine code and need the convention half of D2) ship as **Wave 4b**.
Splitting keeps each diff reviewable; both leave `main` shippable (D6).

## Goal

Every remaining engine surface reports its denominator. The file-scanning gates
exit 3 when they matched zero files; the history-backed advisory commands warn
unmissably when their window contains zero runs instead of rendering a green
all-clear (or, worse, a fabricated `0.0%` average) over an empty sample.

## Observable Truths (Acceptance Criteria)

1. **[Event-driven]** When `review-test <dir>` collects zero test files, the
   system shall print the abstention line + remediation and exit 3 — never
   `✓ No issues found.` Same for `flake-check`
   (`✓ No flakiness patterns detected.`). Both are gates: a directory that
   matched nothing is the #503 shape.
2. **[Ubiquitous]** When either gate collects ≥1 file, the clean line shall
   state its denominator, and a run with findings shall be byte-identical to
   today.
3. **[Event-driven]** When an `analyze` subcommand's store holds zero runs, the
   system shall print an abstention notice **on stderr** and, on the human path,
   replace the all-clear with the abstention line. `--json` stdout stays exactly
   as parseable as before (the row array is unchanged) — the notice never
   contaminates it. Exit stays 0 (advisory, D3).
4. **[Event-driven]** When `history flaky` / `history summary` run over zero
   runs, the system shall abstain rather than print `No tests above N%` or a
   fabricated `avg pass rate: 0.0%` over an empty sample. `history migrate` with
   zero migrated runs shall likewise abstain rather than print
   `Migrated 0 runs`.
5. **[Ubiquitous]** `NdjsonHistoryStore` shall expose `countRuns()` and
   `AsyncHistoryStore` an optional `countRuns?()` denominator probe. A backend
   without the probe (the remote Supabase store) keeps benefit-of-the-doubt and
   never abstains — an unknown denominator is not a zero one.
6. **[Ubiquitous]** `heal-test` and `skills run` shall be **audited and
   pinned**, not changed — see Uncertainties. Their registry rows record the
   classification so a future reader does not re-litigate it.
7. **[Unwanted]** If a denominator is non-zero, then no existing output byte or
   exit code shall change (spec SC5).
8. **[Ubiquitous]** Conformance registry gains rows for every surface swept
   here; full ts + npm suites green at the wave boundary (D6).

## Uncertainties

- **[DECISION] `skills run` keeps its exit ladder unchanged.** It already uses
  exit 3 — for "refusing to invoke an executable skill non-interactively" —
  which collides with D4's CLI-wide reservation. The collision resolves in the
  doctrine's favor: a refusal to invoke IS an abstention (zero skills executed,
  explicit printed reason), so the existing code is already correct and gains a
  registry row rather than a change. `skill === null` → exit 1 stays too: "no
  skill named X" is a bad argument, not a collapsed denominator.
- **[DECISION] `heal-test` has no zero-denominator path.** It errors when the
  path is not a file, so its denominator is always exactly 1.
  `No auto-fixable patterns found` over a genuinely-examined file is a real
  result, not an abstention. Skipped patterns already render (D7). Audited,
  pinned, unchanged.
- **[DECISION] The `analyze`/`history` denominator is RUNS, not ROWS.** Zero
  flaky rows across 500 runs is a genuine clean result; zero rows across zero
  runs is an abstention. Probing `countRuns()` is what separates them — using
  `rows.length` as the denominator would abstain on every healthy fleet.
- **[DECISION] `--json` stdout is never touched on the analyze path.** The
  payload is a bare array, so `abstained` has nowhere to live without breaking
  the contract; the notice goes to stderr (the #515 precedent, and the same
  split `analyze` already uses for its `--db-url` note).
  `history summary --json` returns an object and does gain the field additively.
- **[DECISION] The remote Supabase store never abstains.** `countRuns` is
  optional on `AsyncHistoryStore`; a store that cannot report its denominator is
  _unknown_, and treating unknown as zero would invent an abstention. This
  mirrors `precision: null` in #527 — absent measurement is not a value.

## Tasks

| #   | Task                                                                                | Verify                               |
| --- | ----------------------------------------------------------------------------------- | ------------------------------------ |
| 1   | RED→GREEN: `review-test` + `flake-check` zero-file abstention (gate, exit 3)        | new cli-commands tests               |
| 2   | `countRuns()` on `NdjsonHistoryStore`; optional on `AsyncHistoryStore`              | store unit tests                     |
| 3   | RED→GREEN: `analyze flaky/spikes/area-health/common-failures/regression-candidates` | analyze cli tests (human + `--json`) |
| 4   | RED→GREEN: `analyze digest` (composed report)                                       | analyze cli tests                    |
| 5   | RED→GREEN: `history flaky` + `history summary` (the fabricated `0.0%`)              | history cli tests                    |
| 6   | RED→GREEN: `history migrate` zero-migrated abstention                               | history cli tests                    |
| 7   | Pin `heal-test` + `skills run` classifications with negative tests                  | 3 pinning tests                      |
| 8   | Conformance registry rows for every surface swept here                              | registry green                       |
| 9   | Full gate: ts + npm suites, tsc, prettier, arch baseline                            | 1727+ ts, 224 npm                    |

## Rollback

Additive except the summary lines in `cli-commands.ts`, `analysis/cli.ts`, and
`history/cli.ts`. No persisted format changes; `--json` stdout is unchanged
everywhere except `history summary`, where the new fields are additive.
