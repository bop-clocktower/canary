# Type-label backfill for harness-managed issues (#880)

## Problem

Roadmap sync files issues with `harness-managed` and no type label. The first
routing step in roadmap-fleet reads a type label from metadata, so it can never
fire for these issues. Every one of them falls through to rubric inference,
which defaults to `feature`, so bugs get a design-first route when they need a
reproducing test.

The label is dropped when the issue is filed, and that code lives upstream. It
is tracked at Intense-Visions/harness-engineering#2146. This change covers the
backfill half only.

## Decision (F4)

- Upstream: cite harness-engineering#2146 and do not file a duplicate.
- In-repo: add a backfill script with tests.

## Design

- `scripts/lib/type-label-infer.mjs` holds pure logic:
  - `inferTypeLabel({title, body})` returns `{label, reason}`.
  - `planBackfill(issues)` returns `{examined, plan}`.
- `scripts/backfill-type-labels.mjs` is the CLI.
  - It reads open `harness-managed` issues through `gh issue list`, or from
    `--issues-json <file>` for tests and offline runs.
  - Dry run is the default. `--apply` runs `gh issue edit N --add-label L` once
    per planned issue.
  - It never removes a label.
  - `--json` prints machine-readable output.
- Type vocabulary is the existing set: `bug`, `enhancement`, `documentation`,
  `chore`, `question`, `spike` and `decision`. An issue that already has any of
  these labels is skipped.
- Inference only ever emits `bug`, `chore`, `documentation` or `enhancement`.
  Rules check the title first, then the body. When nothing matches, the label is
  `enhancement`, which matches roadmap-fleet's own safe default, and the reason
  says it was a default.
- Exit codes:
  - `0`: examined at least one issue
  - `2`: usage or `gh` error
  - `3`: zero denominator, meaning no harness-managed issue was examined

## Success criteria

1. A dry run reports every untyped harness-managed issue with its inferred label
   and reason, and makes no writes.
2. `--apply` adds exactly one label per planned issue and never removes one.
3. Issues that already have a type label are untouched.
4. A run that examines zero harness-managed issues exits 3.
5. The script and lib are declared in both `entropy.entryPoints` arrays.

## Non-goals

- Fixing the upstream emitter.
- Running `--apply` against the live tracker in this PR.
