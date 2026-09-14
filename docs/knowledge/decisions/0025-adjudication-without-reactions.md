---
number: 0025
title: Guardian adjudication without reactions
date: 2026-09-14
status: proposed
tier: medium
source: 'adr'
---

<!-- markdownlint-disable-file MD025 -->

# ADR 0025 — Guardian adjudication without reactions

**Status:** proposed **Date:** 2026-09-14 **Deciders:** Bri Stevenski
(maintainer) **Related:** #932 (source issue); #490 (reaction-based collection);
issue #508 (no silent abstention); #553; #312; ADR 0009
(`precision: number | null`); ADR 0011 (promote a check once its precision is
known)

## Context

The guardian's soft-to-hard gate promotion (the contract documented in
`ts/src/guardian/pr-check.ts`, and the rule in ADR 0011) depends on
`precision = TP / (TP + FP)`. Under #490 that number is fed by
`ts/src/guardian/adjudication.ts`, which reads thumbs-up and thumbs-down
reactions off the guardian's sticky comment, and by the `collect-adjudications`
and `precision` commands in `ts/src/guardian/cli.ts`. `pr-check` also runs the
same collection inline (`collectAdjudicationsBestEffort`) on its posting and
emitting surfaces.

A 2026-09-14 audit found that pipeline broken at every stage:

1. **Input is empty.** There are 0 reactions on all 290 guardian sticky comments
   in this repo. The team does not react to GitHub comments at all, so a
   reaction signal is structurally empty. Asking for reactions will not change
   that.
2. **Nothing runs collection.** No workflow invokes `collect-adjudications` or
   `precision`.
3. **Nothing persists.** `--emit-analysis` writes records to
   `.harness/analyses/`, which is gitignored and never uploaded by
   `guardian.yml`, so every record vanishes with the runner.

The promotion is therefore unreachable, and per ADR 0009 the honest value today
is unknown (`null`), not a pass.

### Feasibility check: sticky-comment edit history

Deriving first-versus-last verdicts without a store needs the sticky comment's
earlier bodies. The guardian upserts one comment by marker, so each run is an
edit. This was verified against the live repo on 2026-09-14:

```bash
gh api graphql -f query='{ repository(owner: "bop-clocktower", name: "canary") {
  pullRequest(number: 920) { comments(first: 50) { nodes { id author { login }
  lastEditedAt userContentEdits(first: 50) { totalCount nodes { editedAt diff } }
  } } } } }'
```

Result: **edit history is retrievable.**

- PR #920: the sticky `IC_kwDOSZA6rs8AAAABUfjdwA` (author `github-actions`) has
  `userContentEdits.totalCount = 5`. The oldest node's `diff` holds the full
  earlier body ("Canary PR Guardian — 1 file needs test coverage", with the
  finding table). The newest holds "no test-coverage gaps" at
  `origin/main...e456e0dc44`.
- PR #917: the sticky `IC_kwDOSZA6rs8AAAABUfErIw` has `totalCount = 3`, with the
  same first "1 file needs test coverage" and last "no test-coverage gaps"
  shape.

Despite its name, the `diff` field returns the whole body as it stood at that
revision, so each run's finding table can be parsed from it. The CI-artifact
fallback is not needed.

## Decision

Derive adjudication from actions people already take, rebuild it on demand from
GitHub, and remove reaction-based collection.

1. **Signals.** Per guardian finding on a merged PR:
   - **True positive:** a later commit on the same PR raises coverage on the
     flagged lines. The finding disappears on a re-run AND those lines become
     covered.
   - **Intentional:** the flagged line gains
     `// canary:allow-untested <reason>`. Counted separately and excluded from
     precision.
   - **False positive:** a suppression whose reason starts with `fp:`, for
     example `// canary:allow-untested fp: type-only barrel`.
   - **Ambiguous, excluded:** the finding disappears with no coverage change
     (the code was reshaped or deleted).
   - **Unresolved at merge:** not a false positive, and excluded from precision.
2. **Storage: derive on demand, store nothing.** A report command rebuilds
   adjudications from GitHub each time: the merged PRs, each sticky comment's
   edit history (GraphQL `userContentEdits` on the IssueComment, for the first
   and last verdict), the later commits, and the `fp:` suppressions in the
   merged diff. There is no new store, no committed ledger and no bot push to
   `main`.
3. **Trigger and floor.** A weekly scheduled workflow computes precision over
   merged PRs and writes it to the step summary. It is advisory and never a
   required check. It reports **unknown** until at least **30 adjudicated
   findings** (TP + FP) exist, so a small sample never reads as 100% (#508, ADR
   0009).
4. **Remove reaction-based collection.** Delete the reaction reading in
   `adjudication.ts`, the `collect-adjudications` command, and the inline
   best-effort collection in `pr-check`. They imply a signal that will never
   exist here, and removing them pays down `ts/src` module size.

This ADR records the decision only. The build is follow-up work.

## Consequences

### Positive

- Precision becomes computable from signals the team already produces (commits
  and suppression comments), with no new behavior asked of reviewers.
- No persistence problem to solve: nothing is stored, so nothing can be lost to
  an ephemeral runner or a gitignored directory.
- A false positive is recorded where the reasoning already lives (the
  suppression comment), and it stays reviewable in the diff.
- The gate cannot be promoted on a tiny sample. Below 30 it says unknown.

### Negative / costs

- **API cost and rate limits.** Each weekly run re-walks every merged PR in the
  window through GraphQL and REST. The report must page and bound its window.
- **Coupling to the sticky format.** Verdicts are parsed from rendered comment
  bodies. A change to the comment layout can break old parses, so the parser
  needs fixtures across layout revisions, and an unparseable body must count as
  unknown, not as zero findings.
- **Edit history is GitHub-owned.** If GitHub truncates or drops
  `userContentEdits`, the derivation degrades. The report must say how many PRs
  had no retrievable history rather than silently shrinking the denominator.
- **`fp:` is a convention.** It only works if people use it. Under-use biases
  precision upward, and the report can only disclose the counts, not correct
  them.
- **Removal is breaking** for anyone scripting `guardian collect-adjudications`.
  It needs a CHANGELOG entry.

### Follow-up build work

- [ ] Weekly scheduled workflow that runs the report and writes precision to the
      step summary, advisory, never in `.github/required-checks.json`.
- [ ] Derive-on-demand report command: merged PRs, sticky `userContentEdits`
      first/last verdict, later-commit coverage comparison, output
      `precision: number | null` with sample counts and the 30-finding floor.
- [ ] `fp:` suppression parsing in `// canary:allow-untested` reasons
      (intentional versus false positive).
- [ ] Remove reaction-based collection: the reaction reading in
      `adjudication.ts`, `collect-adjudications`, and
      `collectAdjudicationsBestEffort` in `pr-check`.
- [ ] Tests: signal classification per case, the below-floor unknown, missing
      edit history, an unparseable sticky body, and `fp:` parsing.

### Assumptions made

- The weekly window and pagination bounds are implementation details, as long as
  the report states its denominator.
- Coverage for "lines become covered" comes from the coverage-verified tier that
  the later run's sticky already reports. A finding judged only at the heuristic
  or graph tier that disappears counts as ambiguous unless coverage evidence
  exists.
- The `precision` command may survive, re-pointed at the derived report; only
  reaction collection is removed.
- The 30-finding floor counts TP + FP only. Intentional, ambiguous and
  unresolved findings are reported but do not count toward it.

## Alternatives considered

- **Signals: a PR label `guardian:false-positive`.** Rejected. It marks a whole
  PR, not a finding, and the team does not use labels for this.
- **Signals: derived-only with no FP signal.** Rejected. Precision with no way
  to record an FP is structurally 100%, which is the dishonesty #508 forbids.
- **Storage: the run-history store.** Rejected. It adds a write path and a
  backend dependency for data GitHub already holds.
- **Storage: a CI artifact with retention.** Rejected. Retention expiry loses
  history, and aggregation across artifacts is its own pipeline. It remains the
  fallback if edit history ever becomes unretrievable.
- **Trigger: a per-PR step.** Rejected. Adjudication is only final at merge, and
  per-PR runs add cost to every PR.
- **Trigger: on demand only.** Rejected. Nobody runs it, which is how #490's
  commands ended up never running.
- **Keep reaction collection as a secondary signal.** Rejected. It implies a
  signal that will never exist here, and it keeps dead weight in `ts/src`.
