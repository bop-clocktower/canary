---
number: 11
title: 'ADR 0011 — Required status checks are declared in the repository'
date: 2026-08-06
status: accepted
source: adr
---

<!-- markdownlint-disable-file MD025 -->

# ADR 0011 — Required status checks are declared in the repository

**Status:** accepted **Date:** 2026-08-06 **Deciders:** Bri Stevenski
(maintainer) **Related:** #542; #540/#541 (the merge that exposed it); ADR 0010
(promote a check once its precision is known); #508 (no silent abstention)

## Context

`main`'s ruleset (16189198) contained no `required_status_checks` rule at all —
not a missing entry, the rule type was absent. Every check this repo runs was
advisory with respect to merging. The `pull_request` rule also carried
`required_approving_review_count: 0`, so the practical gate on `main` was "open
a PR, then merge it."

This surfaced on 2026-08-03: PR #540 was merged by auto-merge while its
`markdownlint` check was reporting `FAILURE`. Auto-merge fires once the
_required_ checks pass; with none required, it fires as soon as the PR exists.
`main` went red and stayed red until #541. `markdownlint` was not wrong — it
caught four real MD040/MD033 violations. It did its job and was overruled by
configuration.

The classic `branches/main/protection` endpoint returns
`404 Branch not protected`, because protection here is configured via a ruleset.
Anyone auditing through the old endpoint would conclude, wrongly, that nothing
is configured at all — which is how this survived as long as it did.

This is the shape #508 spent five waves eliminating from the CLI, one layer up.
There the question was _did the check examine anything_; here it is _can the
check stop anything_. A repository whose product thesis is that a green result
must be backed by a real denominator cannot have a merge gate that accepts any
result at all.

## Decision

**The required set is declared in `.github/required-checks.json`, and the GitHub
ruleset is a copy of it.**

Three parts:

1. **Required checks run unconditionally on `pull_request`.** A required check
   behind a `paths:` filter never reports on a PR outside those paths. GitHub
   shows it as "Expected — waiting for status" and the PR can never merge. So
   promoting a check and removing its path filter are one change, not two. Four
   workflows were unfiltered for this: `docs-lint`, `harness-architecture`,
   `harness-security`, `validate-plugin`.

   Note the trap in the obvious plan: #542's own proposal named `docs-lint`
   among the checks to promote, and `docs-lint` was path-filtered. Following it
   verbatim would have deadlocked every code-only PR — while fixing the gate.

2. **Every check-producing job is classified.** `required`, or `advisory` with a
   stated reason. `ts/test/workflow-false-green.test.ts` fails when a job is
   neither, so a new check cannot join the advisory pile by default. ADR 0010's
   rule holds: a check is promoted once its precision is known, and _that_ is a
   legitimate reason to stay advisory. "Nobody configured it" is not, and is
   what #542 was filed about.

3. **`required_approving_review_count` stays 0, as a decision.** This is a
   single-maintainer repo; raising it to 1 would mean self-approving every PR,
   which trains the exact reflex the gate exists to prevent. Recorded in the
   manifest so it stops reading as an unconfigured default. Revisit when a
   second maintainer joins.

### What stays advisory, and why

The five `dogfood.yml` jobs run canary against canary and report against a
409-finding baseline that #544 has not triaged. Promoting before the triage
would block every PR on findings nobody has confirmed are real — ADR 0010's case
for waiting, exactly. `Fleet health` has a second reason: it reports on
accumulated run history, so its verdict is not a function of the change under
review.

`refresh-arch-baseline.yml` is not a gate at all. It triggers on
`pull_request: types: [labeled]` — an on-demand action a maintainer invokes.
Requiring it would deadlock every PR that is never labeled.

## Consequences

- A red `markdownlint`, `enforce`, `security`, `validate`, `harness`,
  `guardian`, `TS engine (pilot)`, `npm package`, `Skills (JS)`, or
  plugin-schema check now blocks the merge button. The #540 merge is no longer
  possible.
- Doc-only PRs pay for `enforce` and `security` (~2 min) that they previously
  skipped. Accepted: a gate that runs sometimes is a gate that reports "no
  opinion" and looks identical to "pass".
- The unfiltering also retires the #549 self-listing workaround on those
  triggers — a workflow that always runs cannot fail to gate its own file. The
  #549 invariant remains live for the path-filtered triggers that are left
  (`wiki-sync.yml` on push).
- Changing the required set means editing the manifest, which the test suite
  checks against the workflows. Applying it to the ruleset is still a manual
  `gh api` call; the manifest is what makes the drift visible.

## Applying the manifest to the ruleset

```bash
gh api repos/bop-clocktower/canary/rulesets/16189198 > /tmp/ruleset.json
# add a required_status_checks rule whose contexts match required-checks.json
gh api -X PUT repos/bop-clocktower/canary/rulesets/16189198 --input /tmp/ruleset.json
gh api repos/bop-clocktower/canary/rulesets/16189198 --jq '.rules[].type'
```

The last line is the verification, not the optimism: confirm
`required_status_checks` is present before calling this done.
