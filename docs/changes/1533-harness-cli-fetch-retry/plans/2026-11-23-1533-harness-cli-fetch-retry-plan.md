# Plan: retry the harness CLI fetch with a bounded backoff, never the checks

Issue: [#1533](https://github.com/bop-clocktower/canary/issues/1533) · Route:
cicd · Pipeline: `harness:workflow-audit` → TDD · Date: 2026-11-23 · Base:
`origin/main` @ `9c15de65` · Run: fleet-command fc1123, cicd-fleet lane

---

## 1. Recurrence (why this moved from "tracked" to "remediate")

PR #1649 at head `572e1f6cb993f6d84d3861371972c76723ad847d`, 2026-11-23 17:08Z:
four required checks failed on attempt 1, and all four passed on attempt 2 of
the same SHA. Attempt-1 logs were read with
`gh run view <id> --attempt 1 --log-failed`:

| Run         | Check (workflow)                           | Failed step                                      | Attempt-1 log                                                                                         |
| ----------- | ------------------------------------------ | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| 45224318526 | `deps-and-validate` (harness-architecture) | `npx --yes -p "$HARNESS_CLI" harness check-deps` | `npm error code E404` … `GET …/@typescript-eslint/visitor-keys/-/visitor-keys-8.74.0.tgz - Not found` |
| 45224318662 | `harness` (harness.yml)                    | `npm install -g "$HARNESS_CLI"`                  | same E404                                                                                             |
| 45224318784 | `validate` (harness-quality)               | `Resolve harness CLI version`                    | `Could not resolve a version from '@harness-engineering/cli@14' (got '')`                             |
| 45224319230 | `security` (harness-security)              | `Resolve harness CLI version`                    | same `got ''`; the cause was discarded by `2>/dev/null`                                               |

All four failed while fetching. None failed while checking. The most likely
cause is registry propagation lag on a just-published transitive tarball, pulled
in because `HARNESS_CLI` floats at `@14` on purpose.

## 2. Audit (`harness:workflow-audit`, scoped to the 5 CLI-fetching workflows)

INVENTORY: `harness.yml`, `harness-quality.yml`, `harness-security.yml`,
`harness-architecture.yml`, `refresh-arch-baseline.yml`. Fetch sites: 1 per
workflow. In `harness-architecture.yml` the fetch and the check were the same
`npx` call.

MECHANICAL:

- M1 path filters: none on any of the five. The four required producers are
  unconditional on `pull_request`, as ADR 0011 requires.
- M2 permissions: `harness-security.yml`, `harness-architecture.yml` and
  `refresh-arch-baseline.yml` declare top-level `permissions:`. **`harness.yml`
  and `harness-quality.yml` declare none** and inherit the repo default. That is
  outside this item's scope, so it is flagged and not fixed.
- M3 pinning: only first-party `actions/*@v7`. No third-party action.
- M4 push-back: `refresh-arch-baseline.yml` pushes. It is already split into
  `measure`/`push`/`consume-label` (#1463). Not touched here.
- M5/M6: no secret echo. Every referenced script exists, and the new
  `scripts/retry-fetch.mjs` is tracked and declared in both `entryPoints`.

JUDGMENT:

- J2, gate defeat by fetch (the finding this plan fixes). A transient registry
  error on the fetch reads as a red **check**. That breaks the signal in both
  directions. A real check-deps failure and a 404 look the same, and the only
  remedy is a blind rerun, which teaches reruns. **ERROR, `deps-and-validate`,
  `harness-architecture.yml:74`.** Patch: separate the fetch from the check
  (section 3).
- J2, silent cause. `2>/dev/null` in both resolve steps drops the only evidence
  of why the version was empty. **WARNING, `harness-quality.yml:70`,
  `harness-security.yml:51`.**
- J1 injection: no `${{ github.event.* }}` lands in the edited `run:` lines.

Summary: workflows audited: 5 · findings: 1 error, 2 warnings (the M2 gap above
is noted for follow-up, not counted as part of this item) · gates that never
fire: none · documented-but-unwired gates: none.

## 3. Decision (human, fork F1=A, not re-litigated)

Wrap **only** the fetch/resolve in a bounded retry. That means 3 attempts in
total, 10 s and then 30 s apart, with a `::warning::` that names each failed
attempt and its error. The step is still red after the last attempt. **Never
retry a step whose failure is a check or test result.** One shared helper, not
copy-pasted bash. `HARNESS_CLI` pins unchanged.

## 4. Tasks

1. **Test first** in `ts/test/harness-cli-fetch-retry.test.ts`:
   - Shape: every fetch in the five workflows goes through the helper, and the
     helper wraps nothing but a fetch. The test also checks the denominator per
     file (1/1/1/2/1). No line running `harness ci|check-*|validate|cleanup` is
     wrapped. Architecture check-deps and validate run on `$HARNESS_CLI_EXACT`
     after the resolve step. Three planted regressions are each caught.
   - Behaviour: the helper is driven with a fake command, never the network. It
     succeeds on attempt 2 with 1 warning, and stays red after 3 attempts with 3
     warnings and an `::error::`. Its warnings are one line each (`%0A`). With
     `--expect-semver` an exit-0 with no version is retried and ends red, which
     is the `got ''` case. A call with no `--` is a usage error.
   - Integration: the real architecture resolve step runs under bash with a stub
     `npx`. It rides out one E404 and exports the exact version. When the stub
     fails every time, the step goes red with the cause in every warning.
   - Seen red: 16 of 19 failing before any implementation.
2. **`scripts/retry-fetch.mjs`**: `MAX_ATTEMPTS = 3`,
   `BACKOFF_SECONDS = [10, 30]`. Annotations go to stderr, so `$(...)` capture
   of stdout stays exact. `RETRY_FETCH_BACKOFF_MS` shortens the sleep for tests
   and never changes the bound. Kept under the `check-perf` complexity threshold
   so the perf ratchet gains no new identity.
3. **Workflows** (minimal edits): `harness.yml` and `refresh-arch-baseline.yml`
   wrap `npm install -g`. The quality and security resolve steps run the probe
   through `--expect-semver`. `harness-architecture.yml` gains a
   `Resolve harness CLI version` step that resolves the float, warms the npx
   cache for the exact version (both retried), and exports `HARNESS_CLI_EXACT`.
   After it, `check-deps` and `validate` run once each on the exact version.
4. **Existing pins**: `ts/test/entropy-ratchet.test.ts` asserted the literal
   resolve line, so it was updated to the wrapped form. It still requires the
   floating pin to be what gets probed. `harness-cli-exact-pin.test.ts` passes
   unchanged.
5. **Docs**: an AGENTS.md "Harness dependency surface" paragraph (doc drift: the
   section describes the install and did not mention the retry).
6. **Gates**: run from `ts/` (build, typecheck, format:check, test), plus
   actionlint 1.7.12 with shellcheck, `harness check-perf` with
   `perf-ratchet.mjs`, `harness cleanup` with `entropy-ratchet.mjs`,
   `check-deps` and `validate`.

## 5. Out of scope, noted

- `arch-snapshot.yml` also fetches the CLI. It is scheduled and not required, so
  it is not wrapped here. It is a candidate if it ever flakes.
- The dogfood `Doctor (from a packed install)` ECONNRESET in the issue table is
  advisory, and it is a different fetch (a packed tarball).
- The quality and security scans re-fetch `$HARNESS_CLI_EXACT` through `npx`,
  mostly from the warm npm cache. They were not seen failing, so they are not
  wrapped.
- No top-level `permissions:` in `harness.yml` or `harness-quality.yml` (M2),
  already tracked by #1267.

## 6. Exit

Issue #1533 stays open (`Refs`, not a closing keyword). The human closes it
after watching a few weeks of runs. A retried pass shows up as a `::warning::`
annotation on the run, so the rate of retries stays measurable.

## 7. VERIFY must-fix (round 2)

`refresh-arch-baseline.yml` runs on `pull_request: [labeled]`, and its `measure`
job checks out `pull_request.head.sha`. That means the workflow file comes from
the merge ref but the working tree is the PR head. Once this merges, a PR whose
branch predates #1533 has no `scripts/retry-fetch.mjs` at its head. The step
would then fail with MODULE_NOT_FOUND on exactly the stale PRs the label exists
to fix. PR CI never runs the labelled path, so it could not catch this.

The fix is an inline bash loop in that one step (`id: install-harness-cli`),
with the helper's contract: 3 attempts, 10 s then 30 s apart, a `::warning::`
per failed attempt carrying the `%0A`-escaped tail of npm's output, and an
`::error::` plus exit 1 after the last. The test was written first and run red
(6 of 24 failing):

- the shape check flags any job that checks out `pull_request.head.*` and calls
  the helper, and it also flags the inline loop being removed;
- the step's real script runs under bash with `npm` and `sleep` stubbed, from a
  directory outside the repo, so the helper is not on hand.

The other four workflows check out the merge ref, so they keep the helper.
