---
number: 13
title: 'ADR 0013 — The history store presents one async contract'
date: 2026-08-13
status: accepted
source: adr
---

<!-- markdownlint-disable-file MD025 -->

# ADR 0013 — The history store presents one async contract

**Status:** accepted **Date:** 2026-08-13 **Accepted:** 2026-08-13 **Deciders:**
Bri Stevenski (maintainer) **Related:** #390 (this decision); #389 (the
`history/` port that surfaced it); #538 (`canary history record`, the first
writer built on the answer); #543 (the leaf-module split of the contract); #508
(no silent abstention — the `countRuns?()` optionality below); ADR 0009 (exit 3
= abstained); the five downstream consumers that inherit this shape — #460
(canary-shiva), #461 (canary-rewind), #604 (flakiness detector), #610
(canary-clocktower gap analysis), #491 (abandonment signals)

## Context

The Python reference's `HistoryStore` ABC was **synchronous**: `query_flaky`,
`push_run`, `query_timeline`, `query_summary` all returned values, because
`supabase-py`'s `.execute()` blocks. `@supabase/supabase-js` is Promise-based,
so the TS port could not mirror that shape for the remote backend and introduced
`AsyncHistoryStore` plus a `LocalAsyncAdapter` over the still-synchronous
`NdjsonHistoryStore` (see `ts/src/history/async-store.ts`, `store.ts`).

That left **two live contracts in one module**, and which one a caller gets
depends on which command it is:

| Caller                            | Store handle                            | Remote support          |
| --------------------------------- | --------------------------------------- | ----------------------- |
| `canary history` (`history/cli`)  | `AsyncHistoryStore` via `makeStore`     | yes (Supabase or local) |
| `canary analyze` (`analysis/cli`) | `NdjsonHistoryStore` **directly**, sync | no — local NDJSON only  |
| `AnalysisEngine` (`analysis/eng`) | the sync `HistoryStore` interface       | no                      |

This is not a hypothetical fork. It is already producing a user-visible
dishonesty: `analyze` accepts `--db-url` and `CANARY_HISTORY_DB_URL` for CLI
fidelity with the Python reference, then prints
`note: --db-url is ignored by analyze; it reads local NDJSON only.` and reads
somewhere else. The note is the right call given the shape — silently reading a
different data source would be far worse — but a flag that is accepted and
ignored is the product-lies class that #538 was filed about, one layer down.

The decision is forced now rather than later because #538 adds the **first
writer** to the local store, and five queued consumers (#460, #461, #604, #610
and #491) will all be readers built on whichever contract this ADR names.
Choosing after they exist means changing five call sites instead of one.

## Decision

**`AsyncHistoryStore` is the single history-store contract. Async propagates all
the way up; the synchronous `NdjsonHistoryStore` is demoted to an implementation
detail behind `LocalAsyncAdapter`.**

1. Every **new** consumer — reader or writer — takes `AsyncHistoryStore` and
   obtains it from `makeStore()`. `canary history record` (#538) is the first,
   which is why it writes local or remote by configuration rather than
   hardcoding a backend.
2. `NdjsonHistoryStore` stays exported (the adapter and the analysis engine need
   it) but is **not** the interface to program against. New code that imports it
   directly is a review finding.
3. `countRuns?()` stays **optional** on the contract. A backend that cannot
   report its denominator returns unknown and never abstains — unknown is not
   zero (#508). This is a property of the contract, not of the async choice, and
   it survives unchanged.
4. `AnalysisEngine` and `analysis/cli.ts` are the **one remaining sync
   consumer**. Converting them is follow-up work, not part of #538: the engine's
   five report paths and their byte-exact renderers are a separate blast radius,
   and the `--db-url` honesty note above is the correct interim behaviour until
   they move. Until then this ADR is the reason the note exists, rather than the
   note standing in for a decision nobody made.

### Why, against the three options in #390

**Option 2, a sync facade over the async store, was rejected as infeasible
rather than as a trade-off.** Node has no way to synchronously await a Promise.
Making the store's queries look synchronous requires either `Atomics.wait`
against a worker thread or a synchronous child process per query — both of which
forfeit streaming, mangle error fidelity across the boundary, and add a thread
or process hop to a call that is otherwise a `readFileSync`. "Simpler callers"
is not on offer; the cost is paid in the hardest-to-debug part of the stack.

**Option 3, split sync-local / async-remote behind a capability check, is the
status quo, and it has been measured.** The capability check in practice is
`analysis/cli.ts`'s `if (dbUrl) { warn }` — a check that always resolves to
"local" is not a capability check, it is a hardcode with an apology attached. It
also multiplies: each of the five downstream consumers would separately decide
whether it supports the remote backend, and the honest ones would each ship
their own version of that same note. Two contracts in one module is exactly what
made this an ADR rather than a local call.

**Option 1's stated cost — divergence from the Python call shape — is now
zero.** The Python engine was retired at v6.0.0; there is no second
implementation to stay congruent with. The sync shape was never a design goal,
it was `supabase-py`'s blocking `.execute()` showing through, and this repo's
own port notes say so.

**What Option 1 actually costs is bounded and one-directional.** Async only
propagates upward through call sites that are already async: commander action
handlers (the CLI is driven by `parseAsync`, and every `history` handler is
already `async`), and the MCP server's tool handlers. There is no synchronous
boundary above the store anywhere in the TS engine — no sync plugin API, no
`require`-time read. The propagation terminates at the process entry point,
which awaits already.

**And it is what the five consumers need.** #460 (predictive ordering from
per-test history), #461 (replay), #604 (flakiness over N runs), #610
(run-history gap analysis) and #491 (abandonment signals) are all readers
reached from a CLI subcommand or a skill process. Every one of them is
async-capable by construction, and every one of them will eventually want the
remote store — the shared fleet history is the whole point of #610. Handing them
a local-only sync handle would make "does this work against the team's store?" a
question answered five separate times.

## Consequences

- `canary history record` (#538) is implemented against `makeStore()` and the
  async contract, so it honours `--db-url` / `CANARY_HISTORY_DB_URL` instead of
  hardcoding the local file — and its duplicate-`run_id` detection degrades to
  "cannot verify" on a backend without `countRuns()`, rather than claiming a
  write it did not confirm.
- The next change to `analysis/` should convert `AnalysisEngine.run` and the
  five `analyze` report paths to async and delete the `--db-url` note. That is
  the last sync consumer; when it lands, `NdjsonHistoryStore` is reachable only
  through the adapter and the "do not program against it" rule in Decision 2
  becomes structural rather than a review convention. **Not filed as an issue by
  this change** — flagged to the maintainer with the ADR.

  > **Landed (#711).** Filed after all, and delivered: the engine and all five
  > report paths are async, `analyze` obtains its backend from `makeStore()`,
  > and the note is gone. Decision 4 is closed and Decision 2 is now structural.
  >
  > Doing it surfaced one thing this ADR did not anticipate. Three `analyze`
  > reports (spikes, common-failures, regression-candidates) are computed by
  > walking whole run records rather than through any of the four contract
  > methods, using a `readAll()` the engine duck-typed for and which only the
  > local backend has. Honouring `--db-url` therefore made those reports render
  > empty against a remote backend — trading a loud lie for a quiet one. The fix
  > follows Decision 3 rather than inventing a mechanism: `readAll?()` is an
  > explicit optional capability whose absence means UNKNOWN, and each report
  > names itself as unverifiable instead of reporting zero. A remote `readAll()`
  > (a real query plus a row-to-`RunRecord` mapping) remains unbuilt and is the
  > natural next change here.

- Reviewers get a one-line test for new history code: does it import
  `NdjsonHistoryStore`? If yes, it needs a reason in the diff.
- A future sync consumer (a hook, a synchronous reporter plugin) would have to
  re-open this ADR rather than quietly re-adding a second contract.

## Alternatives Considered

**Mirror the Python sync ABC and give the remote store a blocking shim.** See
Option 2 above: infeasible in Node without worker/subprocess blocking
primitives, and the cost lands on error handling and streaming rather than on
line count.

**Keep both contracts and document the split.** This is what the port notes
already do, and it is how `analyze --db-url` came to accept a flag it ignores.
Documentation of a fork is not a resolution of it; the fork is load-bearing the
moment a sixth consumer picks the wrong side.

**Defer until the `analyze` engine is ported to async, then decide.** Rejected
on ordering grounds — #538 ships a writer now, and #460/#461/#604/#610/#491 are
queued behind it. Deferring means the shape is decided by whichever of them
merges first, which is the definition of an architectural decision made by
accident.
