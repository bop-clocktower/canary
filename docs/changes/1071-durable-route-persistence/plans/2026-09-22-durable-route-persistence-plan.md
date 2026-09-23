# Plan — Durable route persistence for `issue-fleet` (#1071)

**Spec:** `docs/changes/1071-durable-route-persistence/proposal.md` **Branch:**
`feat/1071-durable-route-persistence` **Base:** `origin/main` @ `7995370b`

Every task is test-first. A task is not done until its test failed for the right
reason before the implementation existed.

## Phase 1 — Vocabulary and partition logic

### T1.1 — Test: the vocabulary is exactly the roster-derived 13

Assert `ROUTE_LABELS` has 13 members, all prefixed `route:`, that the 12
destinations match D3's list exactly, and that `route:unroutable` is present and
is not a destination. Also assert the six from the vendored enum
(`adr|roadmap|pr|cicd|test|cleanup`) and the four #886 named
(`docs|security|perf|craft`) are all covered — the acceptance floor, asserted
rather than assumed.

### T1.2 — Test: `partitionByRoute` counts a denominator it did not filter

`examined` equals the input length. Four disjoint populations — `routed`,
`unroutable`, `untriaged`, `conflicted` — and their sizes sum to `examined`.
This sum is the invariant that makes a silent drop impossible: an issue that
vanished from every bucket breaks it.

### T1.3 — Test: an unroutable issue is its own population

An issue carrying `route:unroutable` lands in `unroutable`, never in
`untriaged`, and is named in the output.

### T1.4 — Test: two route labels is `conflicted`, not a pick

An issue carrying `route:test` and `route:cleanup` lands in `conflicted` with
both labels recorded. Nothing in the module resolves it.

### T1.5 — Implement `scripts/lib/route-labels.mjs`

Pure; no `gh`, no `fs`, no network. Takes already-fetched issue objects.

## Phase 2 — The CLI

### T2.1 — Test: `report` exits 3 on zero open issues

The abstention case. Stub returns `[]`; assert exit code **3** and that stdout
never contains a green-looking "0 routed" pass.

### T2.2 — Test: the denominator is not built on the label filter

**The load-bearing test.** The stub is programmed so that an
`issue list --label …` invocation returns _fewer_ issues than the unfiltered
invocation. Assert the reported denominator equals the **unfiltered** count, and
separately assert from the stub's recorded argv that no `--label` flag was ever
passed on the reporting path. A test that only checked the number could pass by
coincidence; recording the argv proves the mechanism.

### T2.3 — Test: `report --json` names every issue in every population

Not just counts — "and here is which" is an acceptance bullet, so the per-issue
numbers must be present for `routed`, `unroutable`, `untriaged`, `conflicted`.

### T2.4 — Test: `ensure-labels` is dry-run by default and only ever creates

Default invocation creates nothing (assert no `label create` in the recorded
argv). With `--apply`, only labels genuinely missing from the stubbed
`label list` are created — and no `label delete` or `label edit` is ever issued.

### T2.5 — Test: a `gh` failure exits 2, not 0

A stub that exits non-zero must not be read as an empty tracker. This is the
difference between "nothing to route" and "could not look".

### T2.6 — Implement `scripts/route-queue.mjs`

Mirrors `scripts/backfill-type-labels.mjs`: `ROUTE_QUEUE_GH_STUB` for offline
tests, the `0/2/3` exit convention, `--json` for machine consumption.

## Phase 3 — Ratchets and registration

### T3.1 — Declare both new `.mjs` files in `harness.config.json`

In **both** `entropy.entryPoints` and `performance.entryPoints`. The analyzer
cannot follow `./x.js` imports, so an undeclared `scripts/lib/*.mjs` module
reads as dead code and trips the entropy ratchet. `maxFindings` is not raised.
`ts/test/entropy-entrypoints.test.ts` already asserts both arrays stay in sync
and that every declared path is git-tracked — it will catch a half-declaration.

### T3.2 — Run the four gates from `ts/`

`build`, `typecheck`, `format:check`, `test`. Then `check-deps` from the repo
root. Silence means it did not run.

## Phase 4 — Documentation

### T4.1 — ADR for D1/D3/D4/D5

The cross-repo contract rationale — that canary's label vocabulary is the write
end for a vendored, release-overwritten skill — must outlive this session, or
the next harness release regenerates the confusion.

### T4.2 — `AGENTS.md` label-vocabulary section

So the next agent finds the vocabulary without reading this plan.

## Phase 5 — Remote mutation

### T5.1 — Create the 13 labels via `ensure-labels --apply`

A real remote mutation. Every label created is listed in the handoff record so
it is auditable.

### T5.2 — Re-run `report` against the live tracker

Confirm a non-zero denominator. Under this feature's own rules, an unverified
green is not a pass.

## Risks

| Risk                                                                 | Mitigation                                                                  |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Entropy ratchet trips on the two new `.mjs` files                    | T3.1 declares both, in both arrays; the existing entrypoints test guards it |
| The roster changes and the enum silently goes stale                  | T1.1 pins the list; a roster change fails a test rather than drifting       |
| `gh` label lag makes a post-apply verification look empty            | T2.2's discipline applies to verification too — read labels off issues      |
| Worktree is under `.claude/`, so pre-push `check-docs` self-excludes | Push via the GitHub API or a non-`.claude` worktree; never `--no-verify`    |
