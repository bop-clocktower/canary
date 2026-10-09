# CI workflow hygiene: permissions, prettier, actionlint (#1236, #1237, #1238)

**Keywords:** github-actions, least-privilege, permissions, prettier,
actionlint, shellcheck, workflow-lint

## Overview

Three pre-existing workflow-file defects surfaced by the cicd-fleet lane of the
run for #1235, bundled because they share one surface (`.github/workflows/`) and
one fix shape: make the defect impossible to reintroduce silently.

- **#1236:** `harness-architecture.yml` has no `permissions:` block, so its
  token gets the repository default scope.
- **#1237:** `batwoman.yml` fails `prettier --check`, and nothing gates workflow
  YAML formatting.
- **#1238:** actionlint 1.7.12 reports shellcheck findings in workflow `run:`
  scripts. There were 5 at `ccf6af0`. There are 6 at `0b89ca09`, because
  `release.yml` gained one since the issue was filed.

Out of scope: the other workflows that also lack a top-level `permissions:`
block. They are flagged in the PR as a follow-up, not silently fixed.

## Decisions made

| #   | Decision                                                                                                                                                | Rationale                                                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | `harness-architecture.yml` gets top-level `permissions: contents: read`, with no per-job writes.                                                        | Its only steps are `actions/checkout`, `setup-node`, `harness check-deps` and `harness validate`. None of them writes to the repo, the PR or the checks API (`harness-architecture.yml` steps).                                                                                                                                   |
| D2  | The workflow-format gate is the existing `ts` `format:check` script, extended with `../.github/workflows/*.yml`.                                        | It already runs in the required `TS engine (pilot)` check and in the local four gates, so the new coverage adds no job and no check context. Prettier resolves `.prettierrc` per file, so the repo-root config applies. Only `batwoman.yml` failed the check across all 16 workflows, so the gate starts green.                   |
| D3  | SC2086: the three `$*_BASE_FLAG` expansions in `harness-quality.yml` get a scoped `# shellcheck disable=SC2086` with a reason. They are **not** quoted. | Each variable holds zero or four arguments (`--base-report X --base-baseline Y` on PRs, empty on push). Quoting it would pass one fused argument on PRs, or an empty `""` argument on push, and break all three ratchets. The issue's "quote the expansion" fix is correct for the bug class but wrong for these three instances. |
| D4  | SC2016: scoped `# shellcheck disable=SC2016` in `dogfood.yml` (x2) and `release.yml` (x1).                                                              | The single quotes are intentional. Each one wraps a `node -e` program whose `${...}` are JS template literals, and the shell must not expand them.                                                                                                                                                                                |
| D5  | actionlint runs in CI as a new **advisory** `actionlint` job in a new `workflow-lint.yml`, pinned to 1.7.12.                                            | It is cheap (one pinned binary, about 10 s). Advisory follows ADR 0010: its precision on this repo is one clean run old. `required-checks.json` declares it with a reason, which `workflow-false-green.test.ts` enforces.                                                                                                         |

## Approaches considered

1. **Recommended: extend the existing gates and add one advisory job.** This
   adds no new required context. The format gate rides on an existing required
   check (D2), and actionlint is advisory (D5).
2. **A dedicated required `workflow-lint` job running both prettier and
   actionlint.** This needs a ruleset edit (a manual `gh api` step, ADR 0011)
   and promotes a check that has no precision record. Rejected.
3. **Fix the files and wire nothing.** This is the cheapest option, but #1237
   exists because nothing gated the format. Rejected for the format check.
   Approach 1 already keeps actionlint cheap.

## Technical design

- `.github/workflows/harness-architecture.yml`: add the top-level `permissions:`
  block.
- `.github/workflows/batwoman.yml`: `prettier --write`. The js-yaml parse of the
  file is identical before and after: four plain scalars are re-folded and two
  strings are re-quoted.
- `ts/package.json` `format:check`: add `"../.github/workflows/*.yml"`.
- `.github/workflows/{dogfood,harness-quality,release}.yml`: add scoped
  shellcheck directives. Each `harness-quality.yml` `run:` changes from a folded
  plain scalar to a `|` literal block, because a directive needs a comment line.
  The command and its arguments are unchanged.
- `.github/workflows/workflow-lint.yml`: a new workflow. It runs on
  `pull_request` and `push` to `main` with no path filter, sets
  `permissions: contents: read`, downloads actionlint 1.7.12 with the upstream
  script pinned to the tag, and runs it over every workflow.
- `.github/required-checks.json`: add an `advisory` entry for `actionlint`.
- `ts/test/workflow-hygiene.test.ts`: new regression tests for D1, D2 and D5.

## Integration points

- **Entry points:** one new workflow (`workflow-lint.yml`, check context
  `actionlint`).
- **Registrations required:** an `advisory` entry in
  `.github/required-checks.json`.
- **Documentation updates:** a CHANGELOG `[Unreleased]` entry. Contributors are
  told that `format:check` now covers workflow YAML.
- **Architectural decisions:** None. This is a small change.
- **Knowledge impact:** None.

## Success criteria

- When the `harness-architecture.yml` workflow runs, its token shall carry only
  `contents: read`.
- `npm run format:check` (from `ts/`) shall fail when any
  `.github/workflows/*.yml` is not prettier-clean, and shall pass on this tree.
- `actionlint` 1.7.12 shall report zero findings on this tree.
- The `actionlint` job shall be declared advisory in `required-checks.json`, and
  `workflow-false-green.test.ts` shall pass.
- If a `$*_BASE_FLAG` value is non-empty, then the ratchet shall still receive
  it as separate arguments. It shall never receive one fused argument.

## Implementation order

1. Write the tests first (red): the permissions block, the format-check
   coverage, and the actionlint job pin and advisory declaration.
2. Add the permissions block (#1236).
3. Run prettier on `batwoman.yml` and extend `format:check` (#1237).
4. Add the shellcheck directives, then the `workflow-lint.yml` job and the
   advisory entry (#1238).
5. Run the four gates and actionlint, then the CHANGELOG, provenance and PR.
