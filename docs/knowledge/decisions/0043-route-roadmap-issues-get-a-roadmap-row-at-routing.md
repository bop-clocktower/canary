---
number: 0043
title: route:roadmap issues get a roadmap row at routing time
date: 2026-10-21
status: accepted
tier: medium
source: https://github.com/bop-clocktower/canary/issues/1387
---

<!-- markdownlint-disable-file MD025 -->

# ADR 0043 — `route:roadmap` issues get a roadmap row at routing time

**Status:** accepted **Date:** 2026-10-21 **Deciders:** Bri Stevenski
(maintainer) **Related:**
[#1387](https://github.com/bop-clocktower/canary/issues/1387); ADR 0034
(`route:*` labels are canary's half of the issue-fleet contract); ADR 0009 (exit
3 reserved for "abstained")

## Context

`roadmap-fleet` ranks its SELECT batch with `roadmap-pilot`'s impact scorer
(`scoreRoadmapCandidatesForMode`, in the harness CLI bundle) over
`docs/roadmap.md`. The `roadmap-fleet` skill says "Do not rank ad-hoc. Reuse
`harness-roadmap-pilot`'s impact scoring" (SELECT step 3). The scorer can only
rank an issue that has a roadmap row. A row is tied to its issue by an
`External-ID:` line, for example:

```markdown
- **External-ID:** github:bop-clocktower/canary#602
```

On 2026-10-16 the fleet-command `roadmap-fleet` lane found 31 of the 43 open
`route:roadmap` issues had no row. The scorer abstained on them, so the lane
made up its own fallback tier (a false green on a required gate, then false
green or data loss elsewhere, then enhancement). The fallback was labelled at
the gate. Even so, most of the real queue was ranked by something other than the
scorer.

The gap is still there (counted 2026-10-21 against `origin/main` `4608f963`):

- **45** open issues carry `route:roadmap`. Two methods give the same set:
  `gh issue list --label route:roadmap --state open --limit 500`, and all 84
  open issues filtered on their own labels. The second method follows ADR 0034,
  which says the `--label` filter can under-report. `gh` returns 30 results
  unless `--limit` is raised, so a default call would also under-count.
- `docs/roadmap.md` holds **12** rows. Each row has one `External-ID:` line, and
  all 12 point at open `route:roadmap` issues (#486, #602, #603, #608, #614,
  #615, #616, #618, #619, #855, #858, #1151).
- **33 of 45** `route:roadmap` issues (73%) have no row. The scorer ranks only
  the other 12.

Who owns what:

- `issue-fleet` applies the `route:roadmap` label. `roadmap-fleet` consumes it.
  Both are **harness member skills**. They are vendored from the harness CLI and
  overwritten on every release (AGENTS.md, `route:*` entry). Canary cannot
  change their text locally.
- Canary owns the `route:*` vocabulary and its tooling
  (`scripts/lib/route-labels.mjs`, `scripts/route-queue.mjs`; ADR 0034). It also
  owns the fleet briefs and conventions it gives these members when it
  dispatches them.
- `harness roadmap sync --apply` cannot be used to fill the gap, because it
  duplicates shipped work.

## Decision

**When `issue-fleet` routes an issue to `route:roadmap`, it also gives that
issue a roadmap row in the same pass** (option (a), decided by the maintainer
2026-10-21).

1. **Write path.** The row is written with `manage_roadmap add` and linked by an
   `External-ID: github:bop-clocktower/canary#<N>` line. It is **never** written
   by `harness roadmap sync --apply`. Before adding, check the `External-ID:`
   lines already in `docs/roadmap.md` so an issue that already has a row is not
   given a second one.
2. **The scorer ranks the whole queue.** Once every `route:roadmap` issue has a
   row, `roadmap-fleet` SELECT ranks only with `roadmap-pilot`'s scorer. It does
   not build its own tier.
3. **A missing row is an abstention, not a ranking.** If a `route:roadmap` issue
   still has no row at SELECT (for example, it was labelled by hand), the lane
   reports it at the gate as unranked, with a count. It does not give it an
   improvised position in the batch. This follows ADR 0009: an abstention is
   reported as an abstention and is never turned into a result.
4. **Where it is enforced.** Canary puts this rule in the briefs and conventions
   it uses to dispatch `issue-fleet` and `roadmap-fleet`. Changing the vendored
   member skills is an upstream follow-up and is out of scope here (see
   Consequences).

This ADR records the decision only. It does not edit `docs/roadmap.md` and does
not backfill any rows.

## Consequences

- The scorer's denominator becomes the real queue. Today it ranks 12 of 45
  issues. Once routing writes rows and the backlog is backfilled, it ranks all
  of them.
- Routing does more work. Each `route:roadmap` decision also writes a row and
  needs a summary and priority. That adds roadmap churn to `issue-fleet` PRs,
  and `docs/roadmap.md` becomes a file that parallel lanes conflict on.
- If a row is linked wrong or written twice, it is a scoring bug that nobody
  sees. The `External-ID:` duplicate check in Decision step 1 is the guard.
- **Commitment: backfill the existing gap.** The 33 open `route:roadmap` issues
  with no row get rows in a later change, built by `roadmap-fleet` or
  `issue-fleet` with the same write path (`manage_roadmap add` plus
  `External-ID:`, never `sync --apply`). Not in this PR. Until the backfill
  lands, the abstention in Decision step 3 covers most of the queue, and the
  gate shows that count.
- **Finding: canary cannot enforce this in the member skills.** `issue-fleet`
  and `roadmap-fleet` are harness skills that are overwritten on every CLI
  release. A canary brief can tell a dispatched lane what to do, but an
  `issue-fleet` run started outside canary's briefs will still route without
  writing a row. The durable fix is upstream:
  - `issue-fleet` writes a roadmap row when it routes to `roadmap-fleet`.
  - `roadmap-fleet` SELECT reports row-less candidates as abstentions.

  Both are follow-ups, not part of this ADR.

- **Finding: nothing checks the invariant mechanically yet.**
  `scripts/route-queue.mjs report` counts routed, unroutable, untriaged and
  conflicted issues. It does not count `route:roadmap` issues that have no
  `External-ID:` row. That count would make the gap visible on every run.
  Follow-up.

### Assumptions made

- The decision is recorded as the maintainer answered it on 2026-10-21 (option
  (a), plus the backfill commitment). The architecture advisor's discovery and
  choice gates were settled by that answer, so the options were not weighed
  again.
- `tier: medium`. The decision changes how two fleets hand off to each other but
  changes no product code.
- `source` is the issue URL, because no proposal document exists for #1387.
- The counts are from 2026-10-21 and will drift. The 31/43 figure is from the
  2026-10-16 run and is quoted from #1387.
- "Same pass" means routing and row-writing happen in one `issue-fleet` run. It
  does not require one atomic commit.
- Follow-ups are listed here and not filed from this lane. The orchestrator
  files issues.

## Alternatives Considered

- **(b) An explicit, tested fallback tier owned by `roadmap-fleet`.** This turns
  today's improvised tier into a documented, tested ranking. Rejected: it is an
  upstream harness change, and it would make output that is not from the scorer
  look like a ranking. The real queue would stay ranked by a secondary rule
  while the reports look the same as scored output.
- **(c) Both (a) and (b).** Rejected for the same reason as (b). Under (a), a
  remaining fallback is only an abstention labelled at the gate (Decision step
  3). A second ranking would hide the gap that (a) is meant to close.
