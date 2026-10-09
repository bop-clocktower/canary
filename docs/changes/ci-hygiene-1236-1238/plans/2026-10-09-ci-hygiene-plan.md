# Plan: CI workflow hygiene (#1236, #1237, #1238)

**Spec:** `docs/changes/ci-hygiene-1236-1238/proposal.md`. **Rigor:** fast. The
spec has one phase, and it was approved by the lane brief. **Integration tier:**
small.

## Tasks

### Task 1: Write the red tests

`ts/test/workflow-hygiene.test.ts` asserts three things:

- `harness-architecture.yml` declares top-level `permissions` with exactly
  `contents: read`, and no job widens it.
- The `ts` `format:check` script covers `../.github/workflows/*.yml`.
- `workflow-lint.yml` has an `actionlint` job that pins an exact actionlint
  version. That job is declared advisory in `.github/required-checks.json`.

Run it, and expect 3 failures.

### Task 2: Add the permissions block (#1236)

Add top-level `permissions: contents: read` to `harness-architecture.yml`.
Expect the first test to turn green.

### Task 3: Gate workflow formatting (#1237)

1. Run `prettier --write` on `.github/workflows/batwoman.yml`.
2. Confirm that the js-yaml parse is identical before and after.
3. Extend `format:check` in `ts/package.json`.
4. Run `npm run format:check` and expect a pass. A planted mis-format must make
   it fail.

Expect the second test to turn green.

### Task 4: Fix the shellcheck findings (#1238)

1. Add scoped `SC2016` disables in `dogfood.yml` (x2) and `release.yml`.
2. Add scoped `SC2086` disables with a reason in `harness-quality.yml` (x3).
   Keep that file's diff to these directives only, because lane #1248 edits the
   same file.
3. Add the `workflow-lint.yml` `actionlint` job pinned to 1.7.12.
4. Add the advisory entry to `required-checks.json`.
5. Run actionlint 1.7.12 locally and expect 0 findings.

Expect the third test to turn green.

### Task 5: Run the gates and ship

1. Run the four gates from `ts/`.
2. Run the `docs-ratchet`, `entropy-ratchet` and `perf-ratchet` tests, which
   read the edited `run:` blocks.
3. Run `workflow-false-green.test.ts`.
4. Add the CHANGELOG entry, the provenance file and the PR.

## Checkpoints

None. Every task is mechanical, and the lane brief settled every fork.
