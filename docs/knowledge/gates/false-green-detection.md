---
type: business_rule
domain: gates
source: authored
related:
  - docs/knowledge/decisions/0009-exit-3-reserved-for-abstained.md
---

# False-green detection shapes

The rule — a zero denominator is an abstention, not a pass — is stated in
AGENTS.md and given its exit-code vocabulary by
[ADR 0009](../decisions/0009-exit-3-reserved-for-abstained.md). This entry is
the shapes that rule has actually taken here, each with the change that found
it. They are recorded because every one of them read as green at the time.

## An existence check is not a coverage check

A layer rule pointed at `tests/**`, which matched a directory holding 280
untracked `.pyc` files. The glob matched, so the rule reported satisfied; no
test file was involved. Fixed in #555.

The general shape: a check that asks _does anything match this pattern_ answers
a different question from _is the thing this pattern was written to find
present_.

## `|| echo` converts a hard rejection into a green job

A workflow step ran `git push || echo`, so a GH013 push rejection — the remote
refusing the write outright — produced a zero exit status and a green job. The
work silently did not land. Fixed in #551; guarded by
`ts/test/workflow-false-green.test.ts`.

Same family: `continue-on-error` placed over a step that crashes at _startup_
rather than at its assertion. The entropy scan carried one and had never once
run. Fixed in #545.

## An advisory claim that nothing verifies

`engines.node` declared a floor that no check enforced, so an unsupported
runtime installed cleanly and failed later, somewhere else. Fixed in #560 — the
floor is now enforced by a dogfood job in `.github/workflows/dogfood.yml`.

## A zero denominator in a fresh worktree

`.harness/graph/` is gitignored (`.harness/.gitignore`), so a freshly created
worktree has no graph. The knowledge pipeline then reports `0/0 code linked`,
which renders as a plausible D grade rather than as an error. The grade is
indistinguishable from a real measurement of a badly documented repo. Recorded
in #563.

This is why the seeding of this directory is verified by inspecting graph nodes
rather than by counting files: the file can be perfect and the node absent, with
no error either way.

## Why these are worth writing down

Each was diagnosed once, at cost, and each looked like an isolated bug. They are
one defect class, and naming the class is what makes the next instance
recognizable before it burns a week.
