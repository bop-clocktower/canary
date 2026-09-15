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
