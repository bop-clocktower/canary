# Plan: bind the check-arch capture's `|| true` to the summariser that gates it

Issue: [#1208](https://github.com/bop-clocktower/canary/issues/1208) · Route:
cicd · Pipeline: `harness:cicd-fleet` → `harness:workflow-audit` · Option: F2-A
(human-decided) · Date: 2026-10-13 · Base: `origin/main` @ `d4b5681f`

---

## 1. EXPLORE — what is actually true

| Claim in #1208                          | Verdict         | Evidence (re-measured 2026-10-13, harness 12.10.1)                                                                                                                                         |
| --------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `harness check-arch` exits 1 on main    | Correct         | `harness check-arch --json` exit 1; `mode: baseline`, `passed: false`, `totalViolations: 12` (all complexity `thresholdViolations`), `newViolations: 0`, `regressions: 0`, `resolved: 45`. |
| The capture step's `\|\| true` hides it | Partly obsolete | The `Summarise harness checks` step (#968) reads `arch-report.json` and fails the job: exit 1 on `newViolations`, exit 3 on a missing/empty/field-less report.                             |
| A new violation would land silently     | False (today)   | Probe of `scripts/harness-report-summary.mjs` with the measured report: as-is → 0; one planted `newViolations` entry → 1; empty file → 3; missing file → 3.                                |
| The baseline is stale                   | Correct         | 45 `resolvedViolations` still recorded. Refresh is the human, label-gated `refresh-arch-baseline.yml`; out of scope here.                                                                  |

Latent gap found while probing: the summariser consults the arch detail only
when the CI report has an `arch` entry. With a CI report lacking it, a planted
new violation exits **0**. The real workflow does not `--skip arch`, so this is
not live — but nothing bound it either.

## 2. EVALUATE — the fork

Settled by the human at CONFIRM (F2 = a): document why the `|| true` is not
masking, and add a guard test that fails if the contract breaks. Do not refresh
the baseline, do not touch `.harness/arch`, do not apply `refresh-baseline`.

Existing coverage, so nothing is duplicated:

- Summariser exit rows (new → 1, empty/unreadable → 3, missing CI report → 3):
  `ts/test/arch-verdict.test.ts`.
- Summariser step not soft and passes `--arch`:
  `ts/test/workflow-false-green.test.ts` (#968 case).

Missing: the **pairing** — same job, same file, after the capture, runs under
`!cancelled()`, and `ci check` keeps `arch`.

## 3. TASKS

1. Run `harness:workflow-audit` over `harness.yml`; re-measure check-arch. ✔
2. Write `ts/test/arch-capture-contract.test.ts`: a predicate plus eight planted
   mutations of the real `harness.yml`, plus a non-zero-denominator assertion on
   the real file. Show red against a stubbed predicate (10 failures) and against
   an on-disk mutation (`continue-on-error: true` on the summariser). ✔
3. Make it pass on the real file (no workflow behavior change needed). ✔
4. Document: the `harness.yml` capture-step comment, a section in
   `docs/knowledge/gates/arch-baseline-semantics.md`, one pointer in AGENTS.md.
   ✔
5. Gates from `ts/`: build, typecheck, format:check, test. Push, PR with
   `Refs #1208`, watch CI.

## 4. OUT OF SCOPE (flagged)

- `harness.yml` has no top-level `permissions:` block (workflow-audit M2
  warning; it only reads, so `contents: read` would suffice).
- The stale arch baseline and the permanently red absolute exit — human,
  label-gated refresh.
