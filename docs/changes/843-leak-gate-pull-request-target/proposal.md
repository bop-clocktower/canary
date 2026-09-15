# Leak gate on `pull_request_target` (#843)

**Keywords:** leak-gate, pull_request_target, fork-PR, required-checks,
denylist, pwn-request, git-blobs

## Overview

`No removed-symbol or proprietary leaks` is a required check. Fork PRs can never
pass it, because GitHub does not pass `secrets.CANARY_PROPRIETARY_DENYLIST` to
fork-triggered `pull_request` runs. ADR 0023
(`docs/knowledge/decisions/0023-leak-gate-pull-request-target.md`) moves the job
to `pull_request_target`, under one rule: **with base-repo secrets available,
head code is never checked out, installed, built or run.** This change carries
out that decision.

**Out of scope:** removing the `CONTRIBUTING.md` fork section and
`ts/test/contributing-fork-note.test.ts`, and retiring the Dependabot copy of
the secret. ADR 0023 puts both after a real fork PR has confirmed the change.

## Decisions made

All settled by ADR 0023. Brainstorming ran without a human in the loop (fleet
lane), so the defaults below are recorded as assumptions in `provenance.json`.

| Decision                     | Choice                                                                                                                      | Why                                                                                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trigger                      | `pull_request_target` + `push: main`                                                                                        | ADR 0023 rejects `workflow_run`. `push: main` keeps post-merge detection (`required-checks.json#mergePolicy.postMergeDetection`)                     |
| Where the job lives          | New `.github/workflows/leak-gate.yml`                                                                                       | Triggers are per file. ADR 0023 keeps the other `docs-lint.yml` jobs on `pull_request`                                                               |
| How head content is scanned  | **A (chosen):** the scanner reads git blobs of the head commit (`CANARY_LEAK_SCAN_TREE`)                                    | Head files are never written to disk, so there is no working tree, no symlink following and nothing to execute. This is ADR 0023 rule 3, as written. |
|                              | B (rejected): `git archive` the head into a temp dir and point `CANARY_LEAK_SCAN_ROOT` at it                                | Writes head files to disk, follows symlinks, and reuses a seam that loudly declares "this run does not gate the repository"                          |
| How head commits are reached | `git fetch origin <head sha>` into the object store                                                                         | Pins the exact event SHA with no ref race, and never touches the working tree                                                                        |
| Missing tree under the event | Scanner exits 1 when `GITHUB_EVENT_NAME=pull_request_target` and `CANARY_LEAK_SCAN_TREE` is unset, malformed, or unreadable | Otherwise it would scan the base checkout and report a green about the wrong tree                                                                    |

## Technical design

- `scripts/check_removed_symbols.mjs` gets a second file source. It keeps the
  working-tree source (default, and on `push`). The new tree source uses
  `git ls-tree -r -z <sha>` and `git cat-file --batch`. It keeps only regular
  blobs (`100644`/`100755`) and skips symlinks (`120000`) and gitlinks. Both
  halves (removed symbols and proprietary) read through the source. Tree mode
  prints its denominator (`scanned commit <sha>: N files`), and a tree with zero
  scannable files abstains (exit 1).
- `.github/workflows/leak-gate.yml`: top-level
  `permissions: {contents: read, pull-requests: read}`. The checkout is the base
  default with `persist-credentials: false` and `fetch-depth: 0`. `setup-node`
  runs with no cache. On the PR event only, one step fetches the head SHA as
  data. The scan step runs base's `scripts/check_removed_symbols.mjs` with the
  secret. Every event value reaches `run:` only through `env:`, never as
  `${{ }}` inside a script.
- `docs-lint.yml` loses the `removed-symbols` job.
  `.github/required-checks.json` points the check at `leak-gate.yml`, and the
  context string is unchanged.
- `ts/test/workflow-false-green.test.ts` treats `pull_request_target` as a PR
  trigger.

## Integration Points

### Entry Points

New workflow `.github/workflows/leak-gate.yml`. New environment input
`CANARY_LEAK_SCAN_TREE` on the existing scanner. No new module or script file.

### Registrations Required

`.github/required-checks.json` workflow field for the check. Ruleset 16189198 is
keyed on the context string, which does not change, so it needs no edit.

### Documentation Updates

The `AGENTS.md` leak-gate line (it names `docs-lint`), and the comments in the
workflow and the manifest.

### Architectural Decisions

None new. ADR 0023 covers this.

### Knowledge Impact

The pattern "base-context workflows read head as blobs, never as a checkout" is
written down in the workflow comment and enforced by the structure test.

## Success Criteria

1. When a PR event runs the leak workflow, the trigger is `pull_request_target`
   and no step checks out, switches to, archives or installs head code (asserted
   by `ts/test/leak-gate-workflow.test.ts`).
2. The workflow's `permissions` are exactly
   `contents: read, pull-requests: read`, and no `run:` block interpolates
   `${{ }}`.
3. The job name equals the `required-checks.json` entry, and that entry names
   `leak-gate.yml`.
4. When `CANARY_LEAK_SCAN_TREE` names a commit with a denylisted term, the
   scanner fails even if the working tree is clean. When the commit is clean, it
   passes even if the working tree has the term.
5. If the event is `pull_request_target` and no valid tree is given, the scanner
   exits 1.
6. The four local gates pass.
7. (After merge, human) A real fork PR shows a non-abstaining green with a
   non-zero commit count, and a planted term fails it (ADR 0023 Verification).

## Implementation Order

1. Tests first: workflow structure test, scanner tree-mode test, and the
   false-green trigger update.
2. Scanner tree source.
3. New workflow, `docs-lint.yml` removal, manifest, and `AGENTS.md`.
4. Gates, security review, then the PR.
