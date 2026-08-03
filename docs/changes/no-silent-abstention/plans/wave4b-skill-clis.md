# Plan: No Silent Abstention — Wave 4b (skill CLIs)

**Date:** 2026-08-03 | **Spec:** `docs/changes/no-silent-abstention/proposal.md`
(Implementation Order item 4, skill-CLI half) | **Issue:** #508 | **Tasks:** 5

**Branch:** `feat/abstention-wave4b-skills`, based on `origin/main` at
`bf961577`. Wave 4a (engine long tail) ships in parallel as PR #530; the two
touch disjoint trees, so neither blocks the other.

## Goal

The three standalone skill CLIs — `canary-blackhawk`, `canary-savant`,
`canary-katana` — abstain loudly when their denominator collapses, and a
skill-layer conformance registry enforces the convention that keeps them honest.

## Why this is the "convention half" of D2

D2 splits the doctrine's mechanics in two: engine commands and npm scripts
consume the shared helper, while **self-contained skill CLIs get convention plus
a table-driven conformance suite**. These three are `.mjs` entry points that
import no engine code on purpose (Tier-0: no LLM, no network, no cross-skill
dependency), so they cannot call `gateOutcome`. Each declares a local
`ABSTAINED_LINE` matching the helper's exact wording.

Convention without enforcement is just a comment, so the load-bearing artifact
here is `agents/skills/test/gate-conformance.test.ts` — the third registry,
alongside the engine one (`ts/test/`) and the npm one
(`npm/scripts/__tests__/`).

## Observable Truths (Acceptance Criteria)

1. **[Event-driven]** When `canary-blackhawk` or `canary-savant` scans zero
   files, the system shall print the abstention line + remediation instead of
   `No temporal-dependency findings (0 files scanned)` /
   `No order-dependence suspects (0 files scanned)`.
2. **[Event-driven]** When `canary-katana` reads an EMPTY diff, the system shall
   abstain rather than print `0 deletion(s) captured` — which reads identically
   whether the diff was empty or simply had no deletions.
3. **[Ubiquitous]** All three stay ADVISORY by default (exit 0, D3). Under
   `--strict` they carry an exit-code contract, so a collapsed denominator
   inherits **exit 3** — distinct from 1, which means "found something real".
4. **[Ubiquitous]** Findings outrank abstention: the abstention branch is only
   reachable on the no-findings path, so a real finding is never masked.
5. **[Ubiquitous]** `canary-katana --json` gains `checked` / `abstained`
   additively, so a consumer can tell "no deletions" from "nothing examined"
   without parsing prose.
6. **[Unwanted]** If the denominator is non-zero, then no existing output byte
   or exit code shall change.
7. **[Ubiquitous]** The skill-layer conformance registry holds one row per CLI,
   each asserting both the advisory and the `--strict` outcome.

## Uncertainties

- **[DECISION] Katana's denominator is the DIFF, not the deletion count.** Zero
  deletions in a 500-line diff is a real result; zero deletions in an empty diff
  means nothing was examined. `0 deletion(s) captured` cannot tell them apart,
  which is exactly the banned shape. The probe is `diff.trim().length > 0`.
- **[DECISION] `--strict` inherits exit 3 rather than 1.** The spec's audit
  table says skill CLIs "gate only via `--strict`, which inherits exit 3 when
  strict + zero-denominator". Collapsing it to 1 would make CI unable to
  distinguish a real finding from an empty scan — the distinction D4 exists to
  preserve.
- **[DECISION] Four pre-existing pins were rewritten, not deleted.** The
  blackhawk and savant suites asserted their clean-run copy while pointing at an
  EMPTY temp directory — a green all-clear over zero scanned files, i.e. the
  silent-abstention shape restated as a test. Each now writes one unremarkable
  test file so the clean path is genuinely exercised, and a sibling test covers
  the zero-file abstention.

## Tasks

| #   | Task                                                                   | Verify          |
| --- | ---------------------------------------------------------------------- | --------------- |
| 1   | `ABSTAINED_LINE` convention + zero-file abstention in blackhawk        | blackhawk suite |
| 2   | Same for savant                                                        | savant suites   |
| 3   | Katana empty-diff abstention + `checked`/`abstained` in `--json`       | katana suite    |
| 4   | Rewrite the 4 pins that asserted a green over an empty temp dir        | suites green    |
| 5   | Skill-layer conformance registry (3 CLIs x advisory + strict = 6 rows) | registry green  |

## Rollback

Purely additive branches in three `renderText` functions plus one `--strict`
guard each. Reverting restores the previous copy byte-for-byte; no persisted
format changes, and `--json` gains fields only on katana.
