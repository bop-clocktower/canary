# Plan: report-summary `--arch` abstains on a missing `arch` entry

Issue: [#1369](https://github.com/bop-clocktower/canary/issues/1369) · Route:
cicd · Pipeline: `harness:cicd-fleet` → `harness:workflow-audit` + `harness:tdd`
(with `harness:debugging` discipline) · Cause bucket: infra-config (fail-open) ·
Date: 2026-10-21 · Base: `origin/main` @ `4608f963`

---

## 1. Root cause (confirmed before the fix)

`scripts/harness-report-summary.mjs`, `archSection`, on `4608f963`:

```js
const check = report.checks.find((c) => c.name === 'arch');
if (!check) return { lines: [], annotations: [], exitCode: 0 };
```

The early return runs before `archPath` is consulted. So when `--arch` IS passed
and the CI report has no `arch` entry (for example
`harness ci check --skip arch`, or an upstream change that drops the check), the
arch section renders nothing and contributes exit 0. A requested arch verdict
that does not exist reads as green. The supplied detail report is never read
either, so a planted `newViolations` entry also exits 0. The #1208 plan recorded
this as a latent gap.

Reproduced on main with the new tests (3 red, 1 green):

| Case                                                     | main | expected |
| -------------------------------------------------------- | ---- | -------- |
| `--arch` + no `arch` entry + clean detail report         | 0    | 3        |
| `--arch` + no `arch` entry + detail with a new violation | 0    | 1        |
| `--arch` + no `arch` entry + unreadable detail report    | 0    | 3        |
| no `--arch` + no `arch` entry                            | 0    | 0        |

Not live today: `harness.yml` never skips arch, and
`ts/test/arch-capture-contract.test.ts` (#1359) fails on any `--skip arch`. Both
protections are indirect. The summariser itself failed open.

## 2. Workflow audit (`harness:workflow-audit`, scoped to `harness.yml`)

- M1 path filters: none (0 globs), so nothing to resolve.
- M2 permissions: no top-level `permissions:` block. Warning, pre-existing, out
  of scope. Flagged in the PR, not fixed.
- M3 pinning: only first-party `actions/*@v7`. No third-party actions.
- M4 self-trigger: no push-back steps.
- J1 injection: no attacker-controlled `${{ }}` in any `run:`.
- J2 gate completeness: the `Summarise harness checks` step gates arch, and it
  failed open on a missing entry. That is this issue.

## 3. Fix

New `missingArchSection(report, archPath)`, called when the entry is absent:

- No `--arch`: `{ exitCode: 0 }`, silent. This is unchanged behaviour.
- `--arch` given: emit `arch — RESULT MISSING: …` plus a matching
  `::error title=harness arch::` annotation. Then read the detail report:
  - unreadable or unclassifiable: exit 3
  - classifiable with `newCount > 0`: exit 1, plus the usual verdict lines and
    annotations
  - otherwise: exit 3

`exitCodeFor` is unchanged. It already ranks arch exit 1 above any 3. The header
comment's exit-3 entry and the `exitCodeFor` doc now name the new abstention.

## 4. Tests (written first, watched fail on main)

`ts/test/harness-report-summary.test.ts`, describe
`#1369 — a requested arch result that is missing abstains`:

1. `--arch` with no entry: exits 3, with a
   `::error title=harness arch::…missing` annotation, and the summary still
   renders.
2. `--arch` with no entry and a detail report with a new violation: exits 1 (the
   precedence row).
3. `--arch` with no entry and an unreadable detail report: exits 3.
4. No `--arch` and no entry: exits 0 with no arch annotation (regression pin).

Re-ran `arch-verdict`, `arch-capture-contract` (#1359),
`traceability-abstention` and `workflow-false-green`: all green.

## 5. Assumptions and defaults taken

- **The detail report is still read when the entry is missing.** The issue asks
  only for exit 3. The brief's precedence rule (a new violation, exit 1,
  outranks exit 3) is applied to this case too, so the #1208 latent gap closes
  fully. Without it, a known regression would show up only as "abstained".
- **No workflow change.** The `harness.yml` comment saying the `|| true` is safe
  only while `ci check` does not `--skip arch` is still true. The summariser now
  enforces that condition on its own as well.
- The human fork was answered at the fleet level: take over the expired
  issue-fleet claim and apply the fix the issue specifies, without a fork.
