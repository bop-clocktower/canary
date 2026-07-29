---
status: plan
date: 2026-07-29
keywords:
  - autopilot
  - backlog
  - sequencing
  - decision-points
  - readiness
---

# Autopilot queue — remaining open issues (post-v6.2.0)

## Purpose

`harness:autopilot` chains planning → execution → verification → review and
**pauses only at human decision points**. So an issue is autopilot-ready exactly
when it contains no unresolved decision — otherwise the loop stalls mid-flight,
at the most expensive possible moment.

This document sorts every open issue by that test, names the specific decision
blocking each one that is not ready, and gives an execution order that respects
the dependencies between them.

**Readiness is not the same as size.** #462 is large but decision-blocked; #472
is tiny and fully ready. Autopilot cares only about the second property.

## Tier 1 — ready to autopilot now

No unresolved decisions. Scope, acceptance, and approach are all settled.

| Issue    | Work                                    | Why it is ready                                                                                                                                                                             |
| -------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **#472** | `canary-blackhawk` CLI ignores `--help` | Fully specified with a repro, expected output, and a named root cause (flag parsing lost in the Python→JS port, where `argparse` had handled it for free). Single file, no design latitude. |
| **#385** | Ratchet engine coverage floor 81 → 90   | Mechanical _if_ the floor is already met — see the pre-check below.                                                                                                                         |

### #472 — suggested shape

One phase. Add flag parsing to
`agents/skills/claude-code/canary-blackhawk/scripts/cli.mjs` before the
positional loop; `--help`/`-h` print usage and exit 0. Acceptance: `--help`
prints the positional `<path...>`, `--strict`, and the three rule codes
(`BH001-wall-clock`, `BH002-real-delay`, `BH003-local-timezone`); an unknown
`--flag` errors as a flag rather than as a missing path; scanning behaviour is
unchanged.

**Worth generalising:** every skill ported Python→JS lost `argparse`'s free
`--help`. Autopilot should check the other ported CLIs (`canary-savant`,
`canary-katana`, `canary-instrument`, `canary-fail-fast`,
`canary-test-reporter`) in the same pass rather than waiting for four more
issues like this one.

### #385 — pre-check before executing

The issue predates the v6 cutover. **Autopilot must first measure the current
coverage** (`npm test` in `ts/` prints the v8 summary) and branch:

- already ≥ 90 → the change is a one-line threshold bump, ship it
- below 90 → **stop and report the gap.** Writing tests to hit a coverage number
  is how low-value assertion-free tests get created, which is precisely what
  `canary-ci-ready` and the guardian's `weak-test` finding exist to catch. Do
  not let a coverage target manufacture the tests it measures.

## Tier 2 — one decision away

Each needs a single answer, then becomes Tier 1. These are the highest-leverage
things to resolve, because the unblocking cost is one sentence each.

| Issue    | The decision                                  | Recommendation                                                                                                                                                                                                                                                            |
| -------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **#456** | How is the authored-sentinel cleared?         | **HEAD-stamped sentinel** — record `HEAD` when writing; the loop guard fires only while `HEAD` is unchanged. Restores the deleted hook's "clears on the next commit" semantics with no hook, needs no cooperation from the skill, and makes the guard's own message true. |
| **#459** | What owns `.github/workflows/` on install?    | **Write only when absent; on version mismatch report, never overwrite; `--force` for the deliberate case.** `migrate`'s one-way "overlay owns deployed files" rule (#334) must NOT extend to a consumer's CI.                                                             |
| **#342** | Carve out the opt-in `--reasoning` flag?      | **Yes.** It needs no skill-level signal, no persistence, and no privacy surface — most of the value, none of the blocked design. Leave `auto` mode waiting on #341.                                                                                                       |
| **#452** | When N surfaces disagree, which is divergent? | **Report the disagreement set without electing a winner**; let fixture-intent be the only thing that can name a culprit. Majority-wins is wrong at N=2 and wrong whenever one surface is the write path.                                                                  |

### #456 also carries a rider

Whatever mechanism wins, the acceptance criteria must include: **a stale or
malformed sentinel fails OPEN** (authoring allowed). The current failure is
fail-closed-forever, and a fix that preserves that shape is not a fix.

## Tier 3 — needs a spike before any plan is meaningful

Autopilot would produce a confident plan against unknown data and stall on
contact. The spike **is** the first deliverable.

| Issue                                     | The unknown                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **#460** `canary-cassandra`               | Does run-history carry per-test pass/fail keyed to a commit, with enough retention to be predictive? And can the supported runners even _accept_ a test order?                                                                                                                                                                                  |
| **#461** `canary-rewind`                  | Is the **seed** captured? Without it there is no replay. Also test order, env depth, and whether an unreachable commit can be refused cleanly.                                                                                                                                                                                                  |
| **#390** ADR: sync vs async history store | This one is a _decision document_ — the deliverable is the ADR, not code. **New evidence:** the reachability sweep (#469) shipped both a sync core and an async driver over one shared `planSweep`/`resolveOutcome`, with a test asserting they agree. That is a working precedent the ADR should evaluate rather than reason about abstractly. |

For #460 and #461 the honest likely outcome is that the spike's output is a
**history-store change**, not a skill. Autopilot should be instructed to report
that finding rather than build around a gap.

## Tier 4 — needs decomposition first

Too large for one autopilot run. Each needs splitting into phases with its own
proposal under `docs/changes/<slug>/`, following the `canary-pr-guardian`
pattern (proposal + numbered phase plans).

- **#339** — four wave skills (`screech`, `misfit`, `mission-briefing`,
  `sweep`). Each is independently autopilot-able once specced. **Sequence
  `sweep` last or first deliberately**: it crawls every route, as does #452's
  reachability sweep, and they must share one crawl primitive. Whichever runs
  first extracts it — retrofitting a shared crawler afterwards is far more
  expensive.
- **#340** — voice pack. The assets largely exist; the remaining work is
  _wiring_ them into session responses, reporter lines, doc epigraphs, and
  doctor moments. Split per surface; each surface is a small autopilot run.
- **#341 + #462** — **plan these together.** #341's remaining scope (consume the
  detected context) is the first concrete consumer of #462's persona
  abstraction. Built separately, #341's wiring gets built twice.
- **#338** — one bullet left (`promote-test` gating on structured test-craft
  verdicts), blocked upstream. **Recommend closing #338 and re-filing that
  bullet standalone** so the board stops holding a permanently-blocked epic.

## Recommended order

1. **#472** — smallest, fully ready, and the `--help` sweep across the other
   ported CLIs pays for itself immediately.
2. **#456** — a live bug with a recommended fix; one decision away, and it
   silently disables a shipped feature today.
3. **#385** — measure first, then either a one-line bump or a reported gap.
4. **#342 carve-out** — small, shippable, independent of the blocked half.
5. **#459** — sequenced in its own triage: `canary_shape` in `_KNOWN_KEYS`
   (**done**, #467) → add `coverage_report_path` / `sut_controllers_path` to the
   config contract → fix the templates → install phase → doctor report.
6. **#390 ADR** — cheap, unblocks TS design questions, and now has a concrete
   precedent to reason from.
7. **Spikes for #460 / #461.**
8. **Decomposition for #339, #340, #341+#462.**

## Standing instructions for any autopilot run in this repo

Learned from the v6.2.0 cycle; these are the traps that actually cost time here.

- **The arch ratchet will fail your first CI run.** Any net line growth trips
  it. Separate a genuine `NEW: cyclomaticComplexity` violation (fix it in code)
  from plain module-size growth (legitimate). For the latter, apply the
  `refresh-baseline` label — and note the bot's push **cannot re-trigger CI**,
  so close/reopen the PR afterwards. If the label is already applied, remove and
  re-add it; the workflow fires on `labeled` only.
- **Verify before believing a doc.** Three issues this cycle described an
  architecture that had not existed for four majors. Check behaviour against the
  code, not just paths — path-correct and behaviour-wrong reads as current.
- **Check whether the issue is already fixed.** #379 and #403 were both resolved
  by the v6 cutover and needed closing, not building. #341's detection half was
  already shipped and tested while its issue said otherwise.
- **Never let prettier's stderr go to `/dev/null`,** and beware
  repo-root-relative paths when the shell cwd may be `ts/`. A silently no-op'd
  format command cost a red CI run.
- **Guards match identifiers, not prose.** `check_removed_symbols.mjs` cannot
  see "the orchestrator calls the LLM client". Narrative drift needs human eyes.
