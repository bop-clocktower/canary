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

## The same missing graph, but rendered as `pass` instead of a grade

The entry above is the advisory half. The gating half ran for as long and said
less: the `traceability` check inside `harness ci check` is a pure function of
the same gitignored `.harness/graph/graph.json`, and **no workflow built it** —
the only `harness graph` invocation in the repo was a commented-out line in
`guardian.yml` that predated the current CLI major. Upstream returns an empty
issue list when the graph fails to load, and the reporter renders empty as
`pass`. So on every `actions/checkout` the report carried:

```json
{ "name": "traceability", "status": "pass", "issues": [], "durationMs": 4 }
```

having read zero requirements, on every run the check ever made.

Reproduced on one commit with one pinned CLI: a worktree with a graph present
reports `warn traceability 1` in 988 ms; a fresh `git clone` — what CI does —
reports `pass traceability 0` in 4 ms. The duration is the only tell in the
report itself, and nobody reads a duration.

Note which way this one fails. The #563 shape at least produced a bad-looking
grade; this produced the best-looking status a check has. **A denominator of
zero is most dangerous on the checks that pass**, because nothing invites a
second look.

Fixed by building the graph in `harness.yml` before the check runs, and by
`scripts/traceability-verdict.mjs`, which reads the denominator out of
`harness traceability --json` and makes the summariser exit 3 rather than
reprint `pass` over a count it cannot see. Guarded by
`ts/test/traceability-abstention.test.ts`.

## A gate script living where nothing reviews it

The repo root has no tracked `package.json` — `/package.json` and
`/package-lock.json` are gitignored (#244) because CI runs
`npx --yes markdownlint-cli` and never installs a root node project. A local
root manifest still accumulated a `lint` script, and it ran
`ruff check agent tests` months after `agent/` was deleted in the v6.0.0
cutover: a Python linter pointed at a tree that no longer exists, in a file no
review, CI job, or ratchet had ever read. `npm run lint` at the root therefore
reported on nothing while looking like the third of four gates. Issue #672
records it, and `ts/test/root-manifest-not-a-gate.test.ts` guards it.

Two shapes stack here. The gate named a scope that had been deleted out from
under it — the same defect as the layer rule above, but reached by deletion
rather than by a loose glob. And it lived on an **unreviewed surface**, which is
why it survived: every mechanism this repo has for catching stale references
(`check_removed_symbols.mjs`, the ratchets, review itself) reads tracked files
only. An ignored file cannot drift loudly.

## Why these are worth writing down

Each was diagnosed once, at cost, and each looked like an isolated bug. They are
one defect class, and naming the class is what makes the next instance
recognizable before it burns a week.
