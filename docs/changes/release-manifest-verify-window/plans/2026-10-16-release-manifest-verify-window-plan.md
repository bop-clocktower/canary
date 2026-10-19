# Plan: widen the release manifest-verify poll so a slow npm doesn't strand a release

Item: #1331 (harness `cicd-fleet`, cause `infra-config`) · Pipeline:
`harness:cicd-fleet` → `harness-workflow-audit` → TDD · Date: 2026-10-16 · Base:
`origin/main` @ `ab9abf39`

Human answers from CONFIRM: **2A** (20 probes, 30 s apart, still exit 3 at the
end), **3A** (no job split; the split from #1332 goes to a follow-up issue),
**5A** (test-level verification plus CI; the live path is unproven until the
next `v*` tag).

## 1. INVENTORY

| Claim from the issue                                  | Verdict | Evidence                                                                                                                                            |
| ----------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| The v9.3.0 release run abstained after a good publish | Correct | Run 38312805585: `Publish npm package` green, `Verify the published manifest ships every bin` exit 3, so the release and latest steps were skipped. |
| The window is 6 × 10 s                                | Correct | `release.yml` at `ab9abf39`, `for attempt in 1 2 3 4 5 6` / `sleep 10`.                                                                             |
| `release-workflow.test.ts` pins the loop shape        | Partly  | It pins only `exit 3` and `::error::`, not the attempt count or the sleep. Nothing stopped the window from shrinking either.                        |
| The job timeout would kill a longer window            | No      | `publish` sets no `timeout-minutes` (the default is 360).                                                                                           |

## 2. AUDIT (harness-workflow-audit, scoped to the step)

- The step runs under GitHub's default `bash -eo pipefail`. Both `[ … ] && …`
  lines in the loop sit inside `&&` lists, so errexit never fires on them.
  Checked by hand, and the tests now run the real step body with the same flags.
- No `${{ }}` interpolation inside the script, so no injection surface.
- The old loop slept after the final failed probe too: 10 s spent for nothing
  before it abstained.
- `shellcheck -s bash` on the extracted step body is clean. `actionlint` runs in
  `workflow-lint.yml`.

## 3. TASKS

1. Write failing tests in `ts/test/release-workflow.test.ts` that execute the
   real step body against a fake `npm` and `sleep`: version visible on probe 8
   (old window: exit 3) → verified; never visible → exactly 20 probes with 19 ×
   30 s between them, then exit 3 with `::error::`; visible on probe 1 → no
   sleep. **RED confirmed:** 2 failures on `ab9abf39`.
2. Change the loop to `ATTEMPTS=20`, `seq 1 "$ATTEMPTS"`, and `sleep 30` only
   while attempts remain. Keep the exit-3 abstention as it is. **GREEN.**
3. Run the gates from `ts/`: build, typecheck, format:check, test.
4. File the #1332 job-split idea as its own follow-up issue (answer 3A).

## 4. ASSUMPTIONS / DEFAULTS TAKEN

- No sleep after the last probe. The window runs about 9.5 min from the first
  probe to the last, plus each `npm view`'s own latency. That is close enough to
  the "20 × 30 s (10 min)" in the issue, and it doesn't waste 30 s before the
  abstention.
- No backoff (that was option 2B, not chosen). A fixed interval keeps the shape
  easy to pin.

## 5. NOT VERIFIED

`release.yml` only runs on a `v*` tag push, so CI on this PR proves the step
body under test, not a live registry. The next release is the first real
exercise of the wider window.
