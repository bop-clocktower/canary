# Durable route persistence for `issue-fleet` (#1071)

## Overview

`issue-fleet` computes a route for every triaged issue — the downstream fleet
that should own it — and then discards it. The routed queue is `issue-fleet`'s
terminal artifact and the contract every downstream fleet consumes, yet it
survives only as session transcript. Nobody can reconstruct afterwards which
issues were routed, where, or which ones had no legal destination.

This is the **canary-owned half** of #886. The upstream PR
(`Intense-Visions/harness-engineering#2183`) widens the route _enum_; it does
not touch the write end, because the write end is _this repository's label
vocabulary_. When #886 closes on that adoption, this gap would close with it,
unfixed. A route that is computed and then discarded is precisely the "silent
omission" #886's own acceptance bullet forbids — one stage later in the
pipeline.

### Goals

- A computed route outlives the session, recorded on the issue itself.
- The routed queue is reportable with an honest denominator: _N routed, M
  unroutable, K untriaged — and here is which_.
- An unroutable issue is reported as unroutable, never silently dropped. A zero
  denominator is an abstention, not a pass.

### Non-goals

- Patching the vendored `issue-fleet` skill. It lives under
  `~/.claude/plugins/marketplaces/harness/agents/skills/claude-code/issue-fleet/`
  and is overwritten by every harness CLI release. Canary owns the _contract_,
  not the producer.
- Widening the upstream route enum. That is #886 / upstream #2183.
- Automatically applying routes. This change makes a route _recordable and
  reportable_; deciding a route stays `issue-fleet`'s job, under its own human
  CONFIRM gate.

## Evidence

Re-measured on this branch against `origin/main` at `7995370b`, because this
repo's issue bodies have historically been wrong at a high rate:

- `gh label list` returns **30 labels**, of which **0** match `^route:`. The
  only fleet-namespaced label is `fleet:claimed`. _(Issue body: confirmed.)_
- `grep -rln "issue-fleet"` across the repo returns exactly **one** match,
  `docs/changes/879-groom-flag-closed-issue-rows/provenance.json` — a provenance
  record, not an implementation. _(Issue body: confirmed.)_ Canary genuinely
  owns no `issue-fleet` code.
- The vendored skill's route comment reads
  `route, // downstream fleet: adr | roadmap | pr | cicd | test | cleanup`
  (`issue-fleet/SKILL.md:78`) — six destinations.
- The **installed fleet roster** is 14 skills: `adr`, `bug`, `cicd`, `cleanup`,
  `craft`, `docs`, `fleet-command`, `ideate`, `issue`, `perf`, `pr`, `roadmap`,
  `security`, `test`. So the enum is short by more than the four #886 named.

### Prior art in this repo

`scripts/backfill-type-labels.mjs` + `scripts/lib/type-label-infer.mjs` is a
near-exact precedent: pure logic in a `scripts/lib/*.mjs` module, a thin CLI
over it, the repo's `0 / 2 / 3` gate exit-code convention (#508), and a
`*_GH_STUB` env var so contract tests drive `gh` offline.
`scripts/roadmap-denominator-check.mjs` is the precedent for the denominator
discipline and for exit 3 as an abstention.

## Decisions made

### D1 — Mechanism: a `route:*` label family

**Settled by the human at CONFIRM; recorded here, not re-litigated.** One label
per destination fleet, mirroring the existing `fleet:claimed` pattern.

Explicitly rejected: a structured comment block (survives vocabulary churn and
carries a timestamp, but is not queryable); and shipping _both_ mechanisms (two
write paths that can disagree is a new false-green surface, which is the exact
failure class this issue exists to close).

### D2 — A lib module + CLI script, not a new `canary` subcommand

Three shapes were weighed:

|            | A) `scripts/lib` + `scripts/*.mjs`              | B) `ts/src` module + `canary` subcommand         | C) Docs/ADR only                   |
| ---------- | ----------------------------------------------- | ------------------------------------------------ | ---------------------------------- |
| **Pros**   | Exact precedent (#880); no CLI-surface ratchets | First-class, discoverable, typed                 | Zero build cost                    |
| **Cons**   | Not surfaced in `canary --help`                 | Trips 3 CI ratchets; `ts/src/history` at ceiling | No tooling — acceptance 2 unmet    |
| **Risk**   | Low                                             | Medium-high                                      | High (ships a promise, not a gate) |
| **Effort** | Low                                             | High                                             | Trivial                            |

**Chosen: A.** This is repo-governance tooling in the same family as
`roadmap-denominator-check` and `backfill-type-labels`, both of which live in
`scripts/`. B would additionally require a dead-exports pass, a perf-complexity
delta, and an arch allowance plus floor bump for a capability with no runtime
consumer in the product CLI. C fails the second acceptance bullet outright.

### D3 — The enum is the installed fleet roster, minus two

Destinations are the 14 installed `*-fleet` skills minus `fleet-command` (a
conductor over fleets, never a destination for an issue) and `issue-fleet`
itself (the _producer_ of the route — routing an issue to the router is a
cycle). That leaves **12**: `adr`, `bug`, `cicd`, `cleanup`, `craft`, `docs`,
`ideate`, `perf`, `pr`, `roadmap`, `security`, `test`.

This is a superset of the six in the vendored enum and covers all four #886
identified as having no legal destination (`docs`, `security`, `perf`, `craft`),
plus `bug` and `ideate`, which the roster has and the enum never did.

### D4 — `route:unroutable` is an explicit label, not an absence

Absence of a route label is ambiguous: it could mean _not yet triaged_ or
_triaged and found to have no legal destination_. Collapsing those two is
exactly the silent drop the issue forbids. So the vocabulary carries a
thirteenth label, `route:unroutable`, and the report distinguishes three
populations: **routed**, **unroutable** (a recorded decision), and **untriaged**
(never examined).

### D5 — The report reads labels off issues, never through the label filter

`gh issue list --label` lags writes and under-reports — observed twice during
the run that filed #1071, where a freshly-applied `fleet:claimed` was missing
from a list query but present on a direct `gh issue view`. A denominator built
on that filter silently under-reports, which is the same false-green shape the
feature exists to prevent.

So the reporter enumerates open issues with **no `--label` filter** and
partitions them by reading each issue's own `labels` array. The filter is never
used as the denominator. This is asserted by a test, not just documented.

### D6 — A multi-route issue is a finding, not a pick

Two route labels on one issue means two triage passes disagreed about who owns
it. Silently picking one corrupts the downstream queue. The reporter classifies
it as `conflicted` and names it; it never resolves the conflict itself.

## Technical design

### Files

| Path                                 | Role                                                       |
| ------------------------------------ | ---------------------------------------------------------- |
| `scripts/lib/route-labels.mjs`       | Pure logic: the vocabulary, and `partitionByRoute(issues)` |
| `scripts/route-queue.mjs`            | CLI: `ensure-labels` and `report` over the live tracker    |
| `ts/test/route-labels.test.ts`       | Contract tests for both, `gh` driven by a stub             |
| `docs/knowledge/decisions/00NN-*.md` | ADR recording D1/D3/D4/D5                                  |

### `scripts/lib/route-labels.mjs`

```js
export const ROUTE_PREFIX = 'route:';
export const DESTINATIONS = [ /* the 12 of D3, sorted */ ];
export const UNROUTABLE = 'route:unroutable';
export const ROUTE_LABELS = [...DESTINATIONS.map(d => ROUTE_PREFIX + d), UNROUTABLE];

/** Partition open issues by the route labels carried ON THE ISSUE (D5). */
export function partitionByRoute(issues) // -> { examined, routed, unroutable, untriaged, conflicted }
```

`partitionByRoute` takes already-fetched issue objects, so it is pure and the
tests never touch the network. `examined` is the denominator and is the length
of the input, not of any filtered subset.

### `scripts/route-queue.mjs`

```bash
node scripts/route-queue.mjs ensure-labels [--apply]   # dry run by default
node scripts/route-queue.mjs report [--json]
```

- `ensure-labels` reconciles the 13 labels against `gh label list`. It only ever
  **creates**; nothing here deletes or renames a label.
- `report` prints `N routed, M unroutable, K untriaged, C conflicted` out of
  `examined`, followed by the per-issue breakdown — the "and here is which".

Exit codes follow the repo gate convention (#508):

| Code | Meaning                                                                   |
| ---- | ------------------------------------------------------------------------- |
| 0    | verified — examined ≥ 1 open issue and reported honestly                  |
| 2    | usage or `gh` error                                                       |
| 3    | **ABSTENTION** — zero open issues examined, or the tracker was unreadable |

`ROUTE_QUEUE_GH_STUB` overrides the `gh` executable, mirroring
`BACKFILL_GH_STUB` in `scripts/backfill-type-labels.mjs`, so contract tests run
offline and deterministically.

## Integration points

- **Entry Points** — two new `scripts/lib/*.mjs` / `scripts/*.mjs` files. No new
  `canary` CLI surface, no new `ts/src` module (D2), so the dead-exports,
  perf-complexity, and arch-allowance ratchets are not engaged.
- **Registrations Required** — both new `.mjs` files must be declared in
  `harness.config.json`, in **both** `entropy.entryPoints` and
  `performance.entryPoints`; the analyzer cannot follow `./x.js` imports, and
  the two arrays are read by different callers. `maxFindings` is not raised.
- **Documentation Updates** — `AGENTS.md` gains the `route:*` vocabulary
  alongside the existing label conventions.
- **Architectural Decisions** — D1/D3/D4/D5 together warrant one ADR: they
  define a cross-repo contract (canary's label vocabulary is what a vendored,
  release-overwritten skill writes into) whose rationale must survive the
  session that chose it.
- **Knowledge Impact** — the route vocabulary, the producer/consumer split
  between the vendored skill and this repo, and the label-filter lag hazard.

## Success criteria

1. `route:*` exists as a 13-member label vocabulary on the canary tracker, and
   `ensure-labels` reports it as complete.
2. `report` prints a denominator over open issues and names every issue in each
   population.
3. Given zero open issues, `report` exits **3** and says ABSTENTION — it never
   prints "0 routed ✓".
4. A route recorded as a label is readable in a later session with no access to
   the session that wrote it.
5. An issue with `route:unroutable` is counted and named as unroutable, not
   folded into untriaged and not dropped.
6. An issue carrying two route labels is reported as `conflicted`; the tool does
   not pick one.
7. The denominator is provably not built on `gh issue list --label`: a test
   drives a stub whose `--label` path returns fewer issues than its unfiltered
   path, and the reported denominator matches the **unfiltered** count.

## Implementation order

1. Vocabulary and partition logic in `scripts/lib/route-labels.mjs`, test-first.
2. The `route-queue.mjs` CLI over it, test-first, including the abstention and
   label-lag cases.
3. `harness.config.json` entry-point declarations (both arrays).
4. ADR + `AGENTS.md`.
5. Create the 13 labels on the tracker via `ensure-labels --apply`.
