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

## Three metrics are 0 by construction: no layer or cycle evidence

In harness 12.10.1, three of the seven arch metrics cannot report anything,
whatever the code does (#1164, Intense-Visions/harness-engineering#2235):

- **`circular-deps`** builds its graph with a stub parser whose `parseFile`
  always fails, so the graph has zero edges and no cycle can be found in any
  file.
- **`layer-violations`** and **`forbidden-imports`** call `validateDependencies`
  with `layers: []`, so no file resolves to a layer and every edge is skipped.

The `0` recorded for each in `.harness/arch/baselines.json` and
`.harness/arch/timeline.json` is an abstention, not a measurement. A planted
cycle and a planted wrong-layer import both left `check-arch` reporting
`newViolations: []`. A green arch verdict therefore covers `complexity`,
`coupling`, `module-size` and `dependency-depth` only.

Layer direction, forbidden imports and cycles are gated by `harness check-deps`,
which reads the configured `layers`. It runs in two required checks: the
`deps-and-validate` job (`harness-architecture.yml`) and the `deps` step inside
`harness ci check` (`harness.yml`). `ts/test/import-graph-acyclic.test.ts`
repeats the `ts/src` cycle check at desk speed. `scripts/arch-verdict.mjs`
prints a `NOT MEASURED` line naming the three metrics under every verdict; the
list is the `UNMEASURED_ARCH_METRICS` constant, to be revisited when canary
picks up the harness release that fixes #2235.

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
