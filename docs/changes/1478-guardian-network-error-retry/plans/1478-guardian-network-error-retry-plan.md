# Plan: guardian comment client survives network failures (#1478)

Follow-up to #1467 (PR #1470), which retried and degraded HTTP 5xx/429 and
rate-limited 403 responses but left network-level `fetch` failures out of scope.
Human decision: fork F2 = a.

## Root cause

Node's `fetch` (undici) does not return a `Response` for a network failure. It
rejects with `TypeError('fetch failed')`, and the reason is on `cause.code`
(`ECONNRESET`, `ENOTFOUND`, `EAI_AGAIN`, `UND_ERR_SOCKET`,
`UND_ERR_CONNECT_TIMEOUT`, ...). Three things lined up:

1. `fetchWithRetry` (`ts/src/guardian/github-http.ts`) only looped on a returned
   `Response`, so a rejection escaped on the first attempt, for GET, PATCH and
   POST alike.
2. Nothing typed the rejection, so it reached `upsertStickyComment` as a bare
   `TypeError`.
3. `upsertStickyComment` (`ts/src/guardian/pr-comment.ts`) degrades only
   `GitHubPermissionError`, `GitHubRateLimitError` and `GitHubServerError`, so
   it rethrew. `postStickyComment` (`ts/src/guardian/cli.ts`) runs before
   `prCheckCmd` throws `CliExitError(verdict)`, so the crash code replaced the
   computed verdict on the required `guardian` check.

Reproduction: `ts/test/guardian-network-error.test.ts` stubs `fetch` to reject
with a coded `TypeError`. Before the fix, 10 of 12 cases failed. The 2 that
passed are the guards that a non-network `TypeError` still throws.

## Fix

- `networkErrorCode(err)` classifies a rejection as a network error only when it
  is a `TypeError` whose `cause.code` (or an `AggregateError` cause's
  `errors[].code`) is in a fixed set of socket, DNS and timeout codes. Anything
  else returns `null` and is rethrown untouched, so a programming error stays
  loud.
- `fetchWithRetry` catches a network rejection. On GET and PATCH it waits the
  existing backoff (1s, then 2s) and tries again, up to `MAX_ATTEMPTS` (3). On a
  POST it never re-sends, because the request may already have landed and a
  second POST would stack a second sticky (SC-9). The final failure throws the
  new `GitHubNetworkError` (with `code`, and the original error as `cause`).
- `upsertStickyComment` degrades a `GitHubNetworkError` to a notice naming the
  code. The existing #1467 degrade path in `postStickyComment` then prints the
  `::warning::`, writes the verdict to the job log and the step summary, and
  `pr-check` exits with the computed verdict's code. No `cli.ts` change was
  needed.
- Docs: a paragraph in `docs/guides/pr-guardian.md`, plus a CHANGELOG
  `Unreleased / Fixed` entry.

## Tests (`ts/test/guardian-network-error.test.ts`, 13 cases)

- The paged GET retries an `ECONNRESET`, then succeeds after one 1s wait.
- The PATCH retries `ENOTFOUND`, `EAI_AGAIN`, `UND_ERR_SOCKET` and
  `UND_ERR_CONNECT_TIMEOUT`.
- The PATCH retries a code nested in an `AggregateError` cause (added in the
  verify retry, to cover the extracted `nestedErrors` helper).
- A PATCH that keeps resetting stops at 3 attempts with 1s and 2s waits.
- The comment POST is not re-sent after a network error (1 POST, no sleep).
- A non-network `TypeError` is not retried and throws as-is.
- `upsertStickyComment` degrades a POST `ECONNRESET` after exactly one POST, and
  degrades a GET that never connects.
- `upsertStickyComment` still throws a non-network `TypeError`.
- `pr-check --post-comment` with a POST `ECONNRESET` makes one POST, exits 3
  (the computed ABSTAINED verdict), prints `::warning::guardian: ...ECONNRESET`,
  and puts the verdict in the log and the step summary.

The existing #1467 suites (`guardian-transient-5xx`, `guardian-rate-limit-403`,
`briefing-comment`) still pass unchanged.

## Remediation actions / assumptions made

- **F2 = a (decided, human):** GET and PATCH retry a network error with the
  existing backoff. The comment-create POST is never re-sent after one. After
  retries the post degrades to the verdict exit code, a `::warning::`, and the
  verdict in the log and the step summary.
- Network-error code set (my choice, from undici and Node's `net`/`dns`):
  `ECONNRESET`, `ECONNREFUSED`, `ECONNABORTED`, `EPIPE`, `ETIMEDOUT`,
  `ENOTFOUND`, `EAI_AGAIN`, `ENETUNREACH`, `EHOSTUNREACH`, `UND_ERR_SOCKET`,
  `UND_ERR_CONNECT_TIMEOUT`, `UND_ERR_HEADERS_TIMEOUT`, `UND_ERR_BODY_TIMEOUT`.
  `ENOTFOUND` is usually persistent, but the brief names it, and three quick
  tries cost about 3s.
- A network retry uses the plain 1s/2s backoff. There are no headers, so there
  is no `retry-after` to honour.
- `AggregateError` causes (dual-stack connect failures) are checked through
  `errors[].code`.
- Out of scope, deferrable: a socket reset while reading the body of a 2xx
  (`resp.json()` rejecting after the headers arrived). The request already
  succeeded there, so it is not a retry case. It still throws, and it can be
  filed separately if it is ever seen in CI.
- `RestBranchProtectionClient` and the adjudication reactions client are
  unchanged, the same scope line #1470 drew.
- `github-http.ts` grew from 159 to 251 lines and `pr-comment.ts` from 282 to
  292 lines. Both are under the 300-line perf threshold. No new module, so
  `entropy.entryPoints` is unchanged.
- **Verify retry (orchestrator REJECT on `a2ad0b6d`).** The CI arch and perf
  ratchets flagged cyclomatic complexity 12 (threshold 10) in `networkErrorCode`
  and in the test's `stubFetch`. Locally the gates had not covered that: only CI
  runs these ratchets. I fixed the code rather than the baseline.
  `networkErrorCode` now delegates to `nestedErrors` (the AggregateError walk)
  and `knownNetworkCode` (the `Set` lookup). `stubFetch` delegates to
  `nextStep`, `play` and `replyBody`. Behaviour and assertions are unchanged,
  and one case was added for the nested-cause path. Local re-run: `check-arch`
  plus `arch-verdict.mjs` show 0 new violations (the 12 pre-existing ones are
  the same BASELINE TRIP as on main), and `perf-ratchet.mjs` against merge base
  `488d9371` shows 0 new findings.
