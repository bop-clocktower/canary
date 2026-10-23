# Plan: guardian retries transient GitHub errors (#1467)

Route: cicd (fleet-command run fc1023). Stages: harness-debugging, then
harness-tdd. Base: `origin/main` @ `7f1c2364`.

## Root cause

PR Guardian run 39985841183 @ a0d18c34 (PR #1466), attempt 1, computed its
verdict and then failed with `Error: GitHub API 500`. Attempt 2 on the same SHA
passed. The call chain was:

`prCheckCmd` → `postStickyComment` (`ts/src/guardian/cli.ts`) →
`upsertStickyComment` → `RestGitHubClient.createComment` → `request()`
(`ts/src/guardian/pr-comment.ts`)

Three defects combined:

1. **No retry.** `request()` and `restPageReader` each called `fetch` once. A
   single transient 5xx was final.
2. **No classification.** `toGitHubError` typed only 403s
   (`GitHubPermissionError` or `GitHubRateLimitError`). A 5xx and a 429 both
   became a plain `Error`.
3. **No degrade branch.** `upsertStickyComment` caught only the two 403 types
   and rethrew everything else. `prCheckCmd` throws `CliExitError(exitCode)`
   only after the post, so the rethrown error replaced the computed verdict's
   exit code with the generic crash exit 1. `guardian` is a required check, so
   the PR went red for reasons unrelated to the diff.

The working model is the existing 403 path: a typed error becomes a `degraded`
result, then a `::warning::` plus the step summary, and the verdict exit is
preserved. The 5xx/429 classes had none of this.

## Fix

- `pr-comment.ts`
  - `fetchWithRetry(url, init, sleep)` makes up to 3 attempts on a retryable
    status: `>= 500`, `429`, or a rate-limited `403` (`isRateLimited`). Each
    retry waits `retry-after` seconds when present (capped at 60s), otherwise 1s
    and then 2s. Before sleeping, it cancels the discarded response body. Every
    other status returns right away.
  - `toGitHubError`: a 5xx becomes the new `GitHubServerError(status)`. A 429
    becomes `GitHubRateLimitError(status 429)`. The rate-limit error now carries
    its status, so the notice no longer hard-codes 403. Other 4xx keep the plain
    `Error` and stay loud.
  - `upsertStickyComment` degrades `GitHubServerError` to a notice that names
    the status and the attempt count.
  - `RestGitHubClient` takes an optional fifth constructor argument, `sleep`
    (default: real `setTimeout`). Both `request()` and the paged reader use
    `fetchWithRetry`, so reads and writes retry alike (F1).
- `github-paging.ts`: `restPageReader` accepts an optional `send` function
  (default: plain `fetch`). The adjudication reactions client is unchanged.
- `cli.ts` `postStickyComment`: on any degraded post, it prints the rendered
  verdict body to the job log and appends it to `$GITHUB_STEP_SUMMARY`
  (`appendStepSummaryBlock`), along with the existing `::warning::` and summary
  notice (F2).
- `briefing/comment.ts`: a degraded upsert now reports `FORBIDDEN_NOTICE` only
  for a real permission 403. Otherwise it keeps the upsert's reason. Without
  this change, the new 5xx degrade would have shown up in the briefing as "token
  lacks write permission", which is a regression this fix would have introduced.

## Tests (written first, watched fail)

`ts/test/guardian-transient-5xx.test.ts` stubs global `fetch` and injects a
recording `sleep`, so the tests never touch the network or wait in real time.

| Case                                                                                                      | Before fix                                          |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 500 then 201 on POST → succeeds, sleeps `[1000]`                                                          | threw `GitHub API 500`                              |
| 500 ×3 → 3 POSTs, sleeps `[1000, 2000]`, then throws                                                      | 1 POST, no sleeps                                   |
| 429 `retry-after: 5` then 201 → sleeps `[5000]`                                                           | threw `GitHub API 429`                              |
| rate-limited 403 then 201 → 2 POSTs                                                                       | threw `GitHubRateLimitError`                        |
| 404 → 1 POST, no sleep, throws                                                                            | passed (characterizes no-retry)                     |
| plain 403 → 1 POST                                                                                        | passed (characterizes no-retry)                     |
| paged read 502 then 200 → 2 GETs                                                                          | rejected with `GitHub API 502`                      |
| upsert, 500 ×3 → `degraded`, notice names HTTP 500                                                        | threw                                               |
| upsert, 429 forever → rate-limit notice                                                                   | threw                                               |
| upsert, 404 → still throws                                                                                | passed (characterizes loud 4xx)                     |
| `pr-check --post-comment`, every POST 500 → exit 3 (computed verdict) + `::warning::guardian: … HTTP 500` | **threw `Error: GitHub API 500` (the #1467 repro)** |
| same, verdict body in job log and step summary                                                            | threw                                               |

Also changed:

- `ts/test/briefing-comment.test.ts`: a 503 degrades with a
  `canary briefing: … HTTP 503` notice, not the permission notice. Watched it
  fail first.
- `ts/test/guardian-rate-limit-403.test.ts`: injects a no-op `sleep`, because a
  rate-limited 403 is now retried. Without it, the `retry-after: 60` case would
  wait in real time.

## Assumptions / remediation actions

- **F1 (DECIDED, human):** the retry lives in `RestGitHubClient`'s request path
  and covers reads and writes.
- **F2 (DECIDED, human):** a post that still fails exits with the computed
  verdict's code. The verdict goes to the job log and step summary, and the
  failure surfaces as a `::warning::` (same degrade shape as the 403 path).
- **F3 (DECIDED, human):** 3 attempts total, 1s then 2s backoff, and
  `retry-after` honoured. 429 and rate-limited 403 retry. Other 4xx are loud and
  not retried. The sleep is injectable.
- **Default (mine):** an honoured `retry-after` is capped at 60s, so a secondary
  rate limit cannot stall a required check for minutes. The post degrades to a
  warning anyway.
- **Default (mine):** a non-numeric `retry-after` (HTTP-date form) falls back to
  the exponential backoff. GitHub sends seconds.
- **Default (mine):** printing the verdict body to the log and summary applies
  to every degraded post, including the existing 403 and rate-limit paths. This
  keeps one degrade shape.
- **Default (mine):** a network-level `fetch` rejection (DNS, ECONNRESET) is not
  retried and is not degraded. It is outside F1–F3's status-code scope and still
  fails loudly. Possible follow-up.
- **Default (mine):** the other guardian GitHub clients
  (`RestBranchProtectionClient`, the adjudication reactions client) are not
  changed. They are not on the sticky-comment path.
- **Default (mine):** the issue says `pr-check --comment`. The actual flag is
  `--post-comment`.
