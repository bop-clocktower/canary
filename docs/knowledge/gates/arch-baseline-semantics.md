---
type: business_rule
domain: gates
source: authored
related:
  - docs/knowledge/decisions/0012-entropy-ratchet.md
---

# Architecture baseline semantics

What the arch gate measures, and why its raw output reads as failure on a clean
tree. Every line here has cost someone an investigation.

## `complexity` counts violating symbols, not complexity

The arch `complexity` metric is a **count of symbols that violate the
threshold**, not a measurement of how complex the code is. So
`--update-baseline` does not record where the codebase stands — it raises a
permanent allowance for that many violations.

The consequence: a baseline refresh is a policy change, not a snapshot. It
should be reviewed as one. This is the same ratchet discipline
[ADR 0012](../decisions/0012-entropy-ratchet.md) applies to the entropy scan —
lower it when the count drops, never raise it to make CI pass.

## `harness check-arch` returns `passed: false` on a clean tree

Run alone, `check-arch` lists pre-existing `thresholdViolations` and therefore
reports `passed: false` even when the working tree introduces nothing new.
Reading that exit status as a regression signal produces a false alarm on every
run.

## The CI gate is `harness ci check`, which judges the delta

`harness ci check` is what actually gates: it compares against the baseline and
reports `newViolations` and `regressions`. Pre-existing violations are the
denominator, not the finding.

So: `check-arch` answers _what violates the thresholds today_; `ci check`
answers _did this change make it worse_. Confusing them is why a clean branch
can look red.

`ci check` gates only half of "worse", though. It fails on a metric
**regression**, but a **new threshold violation** comes out as a warning with
exit 0. PR #959 merged an over-threshold module on that green (#968). In
`harness.yml` the new violations are gated by
`scripts/harness-report-summary.mjs`, which exits 1 when the `check-arch --json`
detail lists any `newViolations`. Allowance-covered violations are already
filtered out of that list by the CLI.

## The `|| true` on the `check-arch` capture is not masking

`harness.yml` runs `harness check-arch --json > arch-report.json || true`, and
on main that command exits 1 on every run (#1208; 12 pre-existing violations, 0
new, on harness 12.10.1 and unchanged on 13.0.0). The swallow is deliberate: the
absolute exit is the verdict the summariser reinterprets. A later step in the
same job reads the file and fails the job itself, with exit 1 on any
`newViolations` and exit 3 when the report is missing, empty or has no
`newViolations` field.

That holds only while the pairing does. The summariser must stay in the same
job, be invoked in command position, and read the same file via `--arch`. It
must be able to fail: no `||` fallback, pipe, `set +e` or trailing `; true`, and
no `continue-on-error` at step or job level. Its condition must be exactly
`!cancelled()` or `always()`, so a failed earlier step cannot skip it. And
`harness ci check` must not `--skip arch`. Since #1369 the summariser abstains
(exit 3) when `--arch` is passed and the CI report has no `arch` entry. A new
violation in the detail report still exits 1. So a skip turns the job red rather
than green, and that red is noise, not a verdict.

`refresh-arch-baseline.yml` swallows the same capture, and its consumer,
`scripts/refresh-arch-baseline.mjs`, also exits 3 on a missing, empty or
field-less report. `ts/test/arch-capture-contract.test.ts` scans every workflow
and fails on any swallowed `check-arch` capture that lacks a declared
fail-closed consumer meeting these rules.

The red absolute exit itself is a stale baseline, not a defect: refreshing it is
the human, label-gated `refresh-arch-baseline.yml` step.

## Three metrics were 0 by construction until harness 13

Through harness 12.x, three of the seven arch metrics could not report anything,
whatever the code did (#1164, Intense-Visions/harness-engineering#2235):

- **`circular-deps`** built its graph with a stub parser whose `parseFile`
  always failed, so the graph had zero edges and no cycle could be found.
- **`layer-violations`** and **`forbidden-imports`** called
  `validateDependencies` with `layers: []`, so no file resolved to a layer.

The `0` recorded for each in `.harness/arch/baselines.json` and
`.harness/arch/timeline.json` before the `@13` pin is an abstention, not a
measurement.

harness 13.0.0 fixed all three. On the bump (2026-10-21) planted positives
proved each one live — a `ui -> core` import read `layer-violations: 1`, a
`util -> guardian` import added one to both `layer-violations` and
`forbidden-imports` — and `circular-deps` found two real cycles that had been
there all along, in `npm/src` (`doctor.ts` and its check producers;
`reporters/ingest/payload.ts` and `redact.ts`). Both closed through
`import type` edges and were broken by moving the shared types into leaf
modules. Neither was caught by `harness check-deps`, which analyzes 468 modules
against the 858 files the arch collector walks, nor by
`ts/test/import-graph-acyclic.test.ts`, which covers `ts/src` only.

So layer direction and cycles are now gated twice: by the arch ratchet, and by
`harness check-deps` in the `deps-and-validate` job (`harness-architecture.yml`)
and the `deps` step of `harness ci check` (`harness.yml`). The arch ratchet is
the wider of the two. `scripts/arch-verdict.mjs` no longer assumes the
abstention: it reads the `measurements` block harness 13 emits and prints a
`NOT MEASURED` line only for a dependency metric whose denominator is zero,
which reports `skipped`, or which is missing — and for all three when the report
has no `measurements` at all, as every 12.x report does.

## Optional markers in inline type literals cost branches

Each `?` optional marker in an **inline** type literal counts as a branch
against the complexity threshold. A function signature carrying a handful of
inline optional fields can breach the threshold without containing any
conditional logic at all.

The cheap fix is to hoist the shape to a named interface, which costs one
declaration and removes the branches from the count. Applied in #561 to
`ts/src/guardian/cli.ts`, and again in #669 to
`ts/test/precommit-abstention.test.ts`.

## Every `??` counts as two branches

The decision-point pattern is `/\?(?!=)/g` — it excludes `?=` and nothing else.
Its own inline comment in the harness source claims it skips `?.` and `??`, but
the regex never implemented that, so **each `??` scores two** and each `?.`
scores one. The comment describes an intention, not the behaviour.

This is usually the largest single contributor, and the least visible one.
`runHook` in `ts/test/precommit-abstention.test.ts` measured 12 against a warn
threshold of 10, of which exactly **2 were real control flow** (one ternary, one
`catch`); the other 10 were three `??` (6), two inline optional properties (2),
one optional parameter (1), and the ternary's own `?` (1).

The remedy is never to swap `??` for `||` — that changes behaviour on falsy
values to buy a number. Extract the expression into a named helper, which moves
the count somewhere it is affordable and usually names a real responsibility
while it is there.

## Reading a `check-arch` verdict through a pipe hides it

`harness check-arch | tail` reports `tail`'s exit status, not the gate's. The
same trap applies to any gate command whose verdict is an exit code. Redirect to
a file and check `$?` on the command itself — this is the shell-level instance
of the same false-green shape the rest of this page describes.
