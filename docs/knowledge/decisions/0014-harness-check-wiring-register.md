---
number: 14
title: 'ADR 0014 — Every harness check is wired or its decline is recorded'
date: 2026-08-13
status: accepted
source: adr
---

<!-- markdownlint-disable-file MD025 -->

# ADR 0014 — Every harness check is wired or its decline is recorded

**Status:** accepted **Date:** 2026-08-13 **Deciders:** Bri Stevenski
(maintainer) **Related:** #717 (seven unwired checks); #718 (three checks that
report but cannot fail); ADR 0009 (exit 3 = abstained); ADR 0011 (required
checks); ADR 0012 (the entropy ratchet this copies, and the
`performance.entryPoints` model `check-perf` depends on); #508 (no silent
abstention); #638 (check-perf abstaining on unresolved entry points);
harness-engineering #1012 / #1013 (the strength score's denominator)

## Context

The cross-lens self-audit at `422316b` found seven harness subcommands that were
available, functional, and referenced by **no workflow in
`.github/workflows/`**. A check that runs nowhere protects nothing, and its
passing output is not evidence of anything. Three more checks ran but could not
change any outcome.

The failure mode is not that any one of them is broken. It is that all seven
were silently unavailable as a safety net whenever someone assumed "harness
covers that" — and nothing in the repo recorded which ones were deliberate. The
next audit would have re-derived the same list from scratch, which is what this
ADR exists to stop.

### What made the audit itself hazardous

Two of the seven cannot be evaluated by reading their exit codes, and both
near-misses are worth recording because each one is a trap the _obvious_ next
step walks into.

**`check-perf`'s narrowing flags silence it into a pass.** Measured on the same
tree in the same minute at `8c865b5`, CLI 11.1.1:

| Invocation                        | Result                             |
| --------------------------------- | ---------------------------------- |
| `harness check-perf`              | `x Validation failed (237 issues)` |
| `harness check-perf --structural` | `x Validation failed (209 issues)` |
| `harness check-perf --coupling`   | `v validation passed` — exit 0     |
| `harness check-perf --size`       | `v validation passed` — exit 0     |

The 237 is 87 cyclomatic-complexity + 58 function-length + 42 file-length + 26
coupling-ratio + 22 nesting-depth + 2 import-count. `--structural` correctly
reports its 209. **`--coupling` reports a pass over the 28 findings that are its
own subject.** The flags do not narrow the check, they silence it — into a green
tick, which is the shape ADR 0009 outlaws for canary's own CLI.

This matters concretely rather than as trivia: scoping the gate to `--coupling`
is the obvious way to make `check-perf` blockable on day one, because 28
findings is a tractable backlog and 237 is not. That gate would have been green
forever, over nothing.

**`list-capabilities` audits the wrong MCP server and looks like it doesn't.**
It reports 105 capabilities, four of them named `canary_probe`,
`canary_run_history`, `canary_discover_test_command`,
`canary_recommend_framework`. Those are _harness's_ canary-integration tools.
Canary's own six MCP tools — `canary__analyze_file`, `canary__write_test_file`,
`canary__run_tests`, `canary__init_suite`, `canary__list_frameworks`,
`canary__migrate`, all declared in `ts/src/mcp-server.ts` — appear **zero**
times. The command audits whichever MCP server is running, which under CI is
harness's own. A wired `list-capabilities` would emit a confident 105-tool green
that says nothing whatsoever about the surface this repo ships.

## Decision

**Every harness subcommand is either wired to a workflow, or its decline is
recorded here with the reason.** Silence is not a third option: an unwired check
with no entry in this table is a finding, not a default.

### Wired

| Command                                                             | Where                 | How it blocks                                                                                                                                                                                                           |
| ------------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check-perf`                                                        | `harness-quality.yml` | Ratcheted against `.harness/perf-baseline.json` (`maxViolations` 233 against a measured 225, CLI 11.3.0) via `scripts/perf-ratchet.mjs`, which abstains when the running CLI is not the one that set the ceiling (#744) |
| `check-docs`                                                        | `harness-quality.yml` | Blocking at `--min-coverage 3`, a floor at today's measurement                                                                                                                                                          |
| `check-deps`, `check-security`, `check-arch`, `cleanup`, `validate` | pre-existing          | See ADR 0011 / ADR 0012                                                                                                                                                                                                 |

`check-perf` is ratcheted rather than strict for the reason ADR 0012 gives: 237
violations is a real backlog, and a gate that blocks every PR on day one gets
demoted to advisory within a week. It exits 1 whenever it has violations, which
is always, so its own exit code cannot be the gate — the step swallows it with
`|| true` and hands the captured report to the ratchet. That swallow is only
safe because the ratchet **abstains** rather than passing when the report is
unparseable; without the ratchet line, `|| true` is simply a silenced check.

`check-docs` was `continue-on-error: true` carrying the comment "allow warnings
for now as we transition". The transition had no end condition, no target, and
no owner, and the measurement is **3.0%** — 5 of 166 source files. At 3% that is
the steady state, not a transition. `--min-coverage 3` pins it as a floor: the
check blocks, so it cannot be ignored, but it blocks on _regression_ rather than
on an 80% aspiration this repo has never met and has scheduled no campaign to
meet. Coverage rises opportunistically and can never fall back. Raise the floor
when the number goes up; never lower it to make CI pass.

### Declined

| Command                   | Why it stays unwired                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Revisit when                                                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `check-operational-drift` | Reports "No operational-policy surfaces changed" and exits 0 even when policy surfaces demonstrably changed — see the probe below. Its clean is a zero denominator, not a pass, so wiring it blocking would add a new instance of the very category this ADR removes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | It can be shown to fire on a real policy change                                                                            |
| `check-vocabulary`        | Zero rules authored, so it reports `v Semantic vocabulary: no rules — skipped` — a pass marker over an empty denominator. Wiring it would add a green tick that measures nothing, which is worse than not running it, because the tick is what stops someone noticing. This repo has no semantic-vocabulary policy to encode and inventing one to justify a gate is backwards.                                                                                                                                                                                                                                                                                                                                                                                                                        | A vocabulary policy exists and has rules                                                                                   |
| `check-harness-strength`  | Reports `score: 100` on `rulesRun: 4` of `rulesApplicable: 7` (STRENGTH-002 regression-baseline, -003 skip-discipline, -007 snapshot-honesty never evaluated). `tier: "incomplete"` is the honest field and does its job, but `score` is the number a human or a badge reads. **Never consume `score` without asserting `rulesRun == rulesApplicable`.** Tracked upstream as harness-engineering #1012 / #1013.                                                                                                                                                                                                                                                                                                                                                                                       | The three missing inputs exist, or upstream fixes the scoring                                                              |
| `list-capabilities`       | Audits the running MCP server, which under CI is harness's own — zero of canary's six tools appear in its 105 (see Context). A wired run would report a confident green about a surface this repo does not ship.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | It can be pointed at `ts/src/mcp-server.ts`                                                                                |
| `review-ci`               | Overlaps the guardian gate (`guardian.yml`), which is canary-owned (ADR 0008), already tuned for precision (#413, #527), and already posts a sticky verdict. Running both means two review comments disagreeing on the same diff, and the one with no owner wins arguments by default.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | The guardian gate is retired or narrowed                                                                                   |
| `scan-config`             | Exits 2 with **816** findings, re-measured on CLI 11.1.1 at `46e452e` — not the 26 this row first recorded, and not one rule: `SEC-AGT-007` (392) and `SEC-MCP-002` (391) are both path-scoped rules matching Markdown inline code as if it were a hook command string. Root cause is upstream and now **fixed**: the command called `SecurityScanner.scanContent`, which evaluates every rule regardless of `filePath`, rather than `scanFileContent`, which applies the rule's `fileGlob`. Filed as Intense-Visions/harness-engineering#1343, fixed by harness-engineering#1344 (merged 2026-08-13). Not yet reachable — the newest published release is 11.1.1 (2026-08-09), which predates the merge, so the `@harness-engineering/cli@11` pin still floats to the broken build. Tracked in #719. | The `fileGlob` fix reaches a **published** 11.x the pin resolves to, and the residual ~29 `INJ-SUS-*` findings are triaged |

#### The `check-operational-drift` probe, and why it changed the answer

Issue #717 proposed wiring this one **blocking from the start**, and the
reasoning was good: it was clean, so there was no backlog to grandfather and no
PR it would block on arrival — the cheapest possible moment to give it teeth.
The first time it had something to say would be the first time a policy surface
actually moved, which is exactly when someone should be made to look.

That reasoning inverts once you ask _why_ it is clean. Probed at `533cfd7`
against a 9-file, 1014-insertion diff that changed **both** surfaces its own
`--help` names:

- a hook — `.harness/hooks/quality-warner.js`
- a threshold — `performance.thresholds.maxComplexity`

In `--strict` mode ("treat a missing ADR as blocking, overriding config"),
against an explicit `--base` of the merge-base, it reported
`✓ No operational-policy surfaces changed` and exited 0. `harness.config.json`
has no `operationalDrift` key for it to read.

So the check does not currently distinguish a repo that changed no policy from a
repo it cannot measure, and on this repo it is the latter. **Making it blocking
would have added a new check that reports but cannot fail — the exact #718
category this ADR exists to remove — and it would have looked like a win**,
because a green tick from a newly-wired gate is indistinguishable from a green
tick from a working one. The audit's own "it is clean today" was the tell, and
the same tell #718 flags in `check-vocabulary`: a pass with no denominator
behind it. It stays declined until it can be shown to fire.

`mcp-guard` was declined by the audit and is **re-evaluated as worth wiring**,
but not in this change — it needs its own decision about coverage honesty.
`harness mcp-guard check` inspects `.mcp.json`, which declares three servers
(`canary-mcp`, `harness`, `playwright`), and reports on **one**: only
`playwright` resolves to an npx package OSV can be asked about, and the other
two are local commands with nothing to look up. Exiting 0 having covered 1 of 3
without saying so is a partial denominator reported as a full pass. The one it
does cover is `npx @playwright/mcp@latest` — a floating tag, which is the actual
supply-chain vector — so the check earns its place; it just needs the 1-of-3 to
be stated at the point of use rather than discovered later.

## Consequences

- `harness-quality.yml` has **zero** `continue-on-error: true` steps. That is
  now an invariant rather than a coincidence:
  `ts/test/workflow-false-green.test.ts` fails on any soft step that lacks an
  annotating sibling.
- Two independent guards keep `check-perf` honest, and **neither is sufficient
  alone**. `perf-ratchet.mjs` abstains on an implausible collapse, which catches
  `--coupling` and `--size` (both report zero); it cannot catch `--structural`,
  whose 209 against a 245 baseline is an ordinary-looking pass. The workflow
  test asserts the invocation carries no narrowing flag, which covers
  `--structural`; it cannot see an upstream change to what a bare `check-perf`
  measures. Together they cover both. Removing either reopens a real hole, so
  neither is redundant belt-and-braces.
- The perf baseline is an **absolute** total, so concurrent branches consume a
  shared non-renewable budget none of them can see (#700, #703). It carries 8
  violations of headroom for the same reason `.harness/entropy-baseline.json`
  carries 10. Measure it in a fresh `git worktree` — the shared working
  directory reads high, and a mid-conflict tree returns confident garbage.
- Declining a check is now a recorded decision with a revisit condition. An
  unwired check that appears in neither table above is a finding.
- **A check is not wired until it has been seen to fire.** This ADR shipped one
  fewer gate than #717 asked for because the probe above was run, and probing is
  now the price of admission: a green result from a gate nobody has watched fail
  is indistinguishable from a green result from a gate that cannot fail.
  `check-perf` and `check-docs` were both watched failing (`check-perf` on a
  lowered baseline, `check-docs` at the default `--min-coverage 80`) before
  being wired.

## Alternatives Considered

**Wire `check-perf` strict at zero.** Rejected. 237 violations across
complexity, nesting, length and coupling is weeks of refactoring, and the gate
would be turned off long before it was satisfied.

**Wire `check-perf` scoped to `--coupling` so the backlog is tractable.**
Rejected, and this is the alternative that matters: it does not work. The flag
reports a pass over its own 28 findings, so the gate would be permanently green
over nothing. It is documented at length above precisely because it is the
attractive wrong answer.

**Leave `check-docs` advisory with a dated target.** Rejected. It is the same
open-ended shape #718 filed, with a date attached — and a date nobody owns
expires into the same wallpaper. A floor blocks today, on the property that
actually matters (no regression), without requiring a campaign to be scheduled.

**Accept 3% documentation coverage and write it off entirely.** Rejected as
strictly worse than the floor: an accepted-and-ignored number cannot detect the
regression from 3% to 1%, and the floor costs nothing extra to enforce.

**Author placeholder vocabulary rules so `check-vocabulary` has a denominator.**
Rejected. Rules invented to make a gate non-vacuous encode no real policy, and
the resulting green is exactly as uninformative as the skip it replaced — with
the added cost that it now looks like a considered decision.
