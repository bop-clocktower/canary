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
answers _did this change make it worse_. Only the second one is a gate, and
confusing them is why a clean branch can look red.

## Optional markers in inline type literals cost branches

Each `?` optional marker in an **inline** type literal counts as a branch
against the complexity threshold. A function signature carrying a handful of
inline optional fields can breach the threshold without containing any
conditional logic at all.

The cheap fix is to hoist the shape to a named interface, which costs one
declaration and removes the branches from the count. Applied in #561 to
`ts/src/guardian/cli.ts`, and again to
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
