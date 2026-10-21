# Plan: security check — pinned Node, one CLI, a validate that explains itself

Item: issue #1401 (harness `cicd-fleet`, cause bucket flake / infra-config) ·
Pipeline: `harness:cicd-fleet` → `harness:workflow-audit` (+ `harness:debugging`
for diagnosis) → TDD · Date: 2026-10-21 · Base: `origin/main` @ `4608f963`

---

## 1. Diagnosis — what is known

| Fact                                                         | Evidence                                                                                                                                                   |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Validate architecture` failed with exit 1 and no CLI output | Run 39298544259 attempt 1, 2026-10-19T18:01. The step log holds only npm `EBADENGINE` and deprecation warnings, then `Process completed with exit code 1`. |
| Same SHA was green on rerun                                  | Attempt 2 of run 39298544259 (SHA f6af5d94). Four other PRs passed the same workflow in the same minute.                                                   |
| The job ran an unsupported Node                              | `EBADENGINE`: `@earendil-works/pi-coding-agent@0.79.10` requires `node >=22.19.0`, but the job had `v20.20.2`. `.nvmrc` pins `22.23.2`.                    |
| Each step re-resolved the floating CLI                       | `npx --yes -p "$HARNESS_CLI"` in all three harness steps. The log never named the resolved version.                                                        |
| Local validate is clean                                      | `@harness-engineering/cli@13.0.0 harness validate --json` on Node 22.23.2 in a fresh worktree: `"valid": true`, exit 0.                                    |

**Root cause: not proven.** The failure could not be reproduced locally, and the
CI log has nothing that tells a validation finding apart from a CLI crash or
install failure. This change does not claim a cause. It removes the two
nondeterministic inputs (an unsupported Node, and re-resolving the CLI on every
`npx` call). It also adds diagnostics, so the next failure can be triaged from
the log.

## 2. Workflow audit (`harness:workflow-audit`, scoped to `harness-security.yml`)

```text
WORKFLOW AUDIT: bop-clocktower/canary (harness-security.yml)
Workflows audited: 1   Findings: 1 error, 2 warning, 3 info
Gates that never fire: none (no path filters; removed on purpose in #542)
Documented-but-unwired gates: none (AGENTS.md table: validate, check-deps, check-security all wired)
```

| Sev     | Check             | Where                     | Finding                                                                                         | Disposition                                                                                                                                                                                           |
| ------- | ----------------- | ------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ERROR   | runtime-mismatch  | `harness-security.yml:31` | `node-version: '20'` is below a CLI dependency's engine floor and differs from `.nvmrc`         | **Fixed**: `node-version-file: .nvmrc`                                                                                                                                                                |
| WARNING | pin-floats-in-run | `:34,37,41`               | Every step re-resolves `@13`, and the log never names the version                               | **Fixed**: resolve once and export `HARNESS_CLI_EXACT` (copied from #1248)                                                                                                                            |
| WARNING | silent-red-gate   | `:34`                     | A red validate leaves no diagnostic                                                             | **Fixed**: `--json` goes to a file. On failure the log gets the exit code, the CLI and Node versions, and the result (or a line saying it was empty). The file is uploaded with `!cancelled()` (#588) |
| INFO    | permissions-broad | `:16`                     | `contents: write` is set for the whole workflow, but only the push-to-main ledger step needs it | Out of scope. Flagged in the report, not fixed                                                                                                                                                        |
| INFO    | concurrency       | whole file                | No `concurrency:` group, and the ledger step force-pushes `chore/security-ledger`               | Out of scope. Flagged                                                                                                                                                                                 |
| INFO    | pinning           | `:27,30`                  | First-party actions are pinned to major tags (`@v7`). This matches repo convention              | No change                                                                                                                                                                                             |

M1 (path filters): none. M5 (secrets): none. M6: `scripts/security_ledger.mjs`
exists. J1 (injection): no `${{ }}` interpolation in any `run:` block.

## 3. Fix

1. `actions/setup-node` reads `node-version-file: .nvmrc`.
2. A new `Resolve harness CLI version` step (`id: harness-cli`) copies the
   resolve step in `harness-quality.yml` and exports
   `HARNESS_CLI_EXACT=<pkg>@<resolved>`. `validate`, `check-deps` and
   `check-security` all run `"$HARNESS_CLI_EXACT"`.
3. `Validate architecture` runs
   `harness validate --json > harness-validate.json` and keeps the exit code. On
   a non-zero code it prints a `::error` annotation with the exit code, the CLI
   version and the Node version. It then prints the result, or says the CLI
   wrote no result and was not reporting a validation finding. It exits with the
   **original** code, so the gate stays red and a crash is not reported as
   exit 1.
4. `Upload harness validate result` (`if: !cancelled()`), required by the #588
   invariant in `workflow-false-green.test.ts`.

## 4. Tests (written first, watched fail: 8 red before the workflow change)

- `ts/test/harness-cli-exact-pin.test.ts`: new describe for
  `harness-security.yml`. It checks the scan denominator (`check-deps`,
  `check-security`, `validate`), that no scan uses the floating pin or runs
  before the resolve step, the export line, and a planted floating `check-deps`
  to prove the checker catches one.
- `ts/test/harness-security-workflow.test.ts` (new):
  - setup-node uses `node-version-file: .nvmrc`, with exactly one setup step
  - runs the validate step's actual `run:` script under `bash -e` with a stub
    `npx`, and asserts:
    - the arguments are `-p <exact> harness validate --json`
    - a failure prints the exit code and the JSON result, and stays red
    - an empty-output failure prints "no JSON result"
    - a 134 exit code is passed through unchanged

## 5. Assumptions / defaults taken

- **Human-answered fork (a), binding**: `.nvmrc` Node, the #1248 exact pin, and
  `--json` with print-on-failure.
- The result file goes in the workspace (`harness-validate.json`), not
  `$RUNNER_TEMP`, so the #588 upload invariant can match it the same way it
  matches `harness.yml`. The ledger step stages only named files, so the
  untracked file is never committed.
- On failure the full JSON is printed even though #588 discourages dumping
  `--json` to the log. The validate result is about 1 KB, far below the 60 KB
  log cut, and the issue asks for it to be readable inline. The artifact is the
  durable copy.
- The workflow-level `HARNESS_CLI` stays a floating major (CI tracks upstream).
- `actionlint` is not installed locally. The CI `Workflow lint` job is the check
  for this.

## 6. Verification plan

- Local gates from `ts/`: build, typecheck, format:check and test, all green.
- After PR CI is green, rerun the Security Reviewer run on the PR head at least
  twice more. The item is done only if every attempt is green.
