# Plan: leak gate on pull_request_target (#843)

Spec: `docs/changes/843-leak-gate-pull-request-target/proposal.md`

| #   | Task                                                                                                                                   | Files                                                              | Verify                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------- |
| 1   | Write the workflow structure test (trigger, permissions, no head checkout or install, no `${{ }}` in `run:`, job name in the manifest) | `ts/test/leak-gate-workflow.test.ts`                               | Fails red: `leak-gate.yml` does not exist |
| 2   | Write the scanner tree-mode tests (leak in the commit only, clean commit with a dirty tree, symlink skipped, PRT without a tree)       | `ts/test/leak-gate-tree-mode.test.ts`                              | Fails red                                 |
| 3   | Teach the false-green suite that `pull_request_target` is a PR trigger                                                                 | `ts/test/workflow-false-green.test.ts`                             | Stays green                               |
| 4   | Add the tree source to the scanner                                                                                                     | `scripts/check_removed_symbols.mjs`                                | Task 2 goes green                         |
| 5   | Add `leak-gate.yml`, remove the job from `docs-lint.yml`, update the manifest and `AGENTS.md`                                          | `.github/workflows/*`, `.github/required-checks.json`, `AGENTS.md` | Task 1 goes green                         |
| 6   | Run the gates from `ts/`: build, typecheck, format:check, test                                                                         | —                                                                  | All exit 0                                |
| 7   | Security review of the diff, then provenance, then the PR                                                                              | `docs/changes/843-leak-gate-pull-request-target/provenance.json`   | Reviewer passes                           |

Checkpoint: after task 5, re-read the workflow against ADR 0023 rules 1 to 5.

## Amendment: two-step migration (supersedes task 5's move)

Task 5 as first shipped on PR #948 moved the required context
`No removed-symbol or proprietary leaks` from `docs-lint.yml` to `leak-gate.yml`
in one PR. That PR could never merge. `pull_request_target` runs the workflow
**as it exists on the base branch**, and `leak-gate.yml` is not on `main` yet,
so the required context never reported on #948 (18 pass, 1 required missing).
Ruleset 16189198 has zero bypass actors, so `--admin` cannot get past it.

**Step 1 (PR #948):**

- `docs-lint.yml` keeps the `No removed-symbol or proprietary leaks` job on
  `pull_request`, byte-identical to `main`. It stays the required producer.
- `leak-gate.yml` is added with the ADR 0023 design under the distinct job name
  `Leak gate (pull_request_target, transitional)`. It is listed as advisory in
  `.github/required-checks.json`. The required list and the ruleset do not
  change.
- `ts/test/leak-gate-workflow.test.ts` asserts this state: both workflows exist,
  docs-lint.yml carries the required context, and leak-gate.yml's job name
  differs.

**Step 2 (follow-up PR, after #948 merges; not opened yet):**

1. Rename the `leak-gate.yml` job to `No removed-symbol or proprietary leaks`.
2. Delete the `removed-symbols` job from `docs-lint.yml`, so exactly one
   workflow produces the context.
3. Move the manifest entry's `workflow` to `leak-gate.yml`, drop the
   transitional advisory entry, and update `AGENTS.md` and the tests.
4. Confirm the context reports on that PR, and that a real fork PR gets a
   passing context, per ADR 0023.

Caution, the same base-branch trap applies to step 2 itself. On the step-2 PR,
`pull_request_target` still runs `main`'s `leak-gate.yml`, whose job carries the
transitional name. If that PR also deletes the `docs-lint.yml` job, nothing
reports the required context and the PR deadlocks exactly like #948 did. Split
it: **2a** renames the `leak-gate.yml` job only, and docs-lint.yml still reports
on that PR. **2b**, after 2a is on `main`, deletes the docs-lint.yml job and
moves the manifest entry. Between 2a and 2b both workflows report the context on
each PR. Keep that window short.
