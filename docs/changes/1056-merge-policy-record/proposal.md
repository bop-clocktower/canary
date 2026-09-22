# Merge-policy record accounts for every live ruleset rule

## Overview

`.github/required-checks.json` opens by declaring itself "the source of truth a
human can read" (#542). It is not — it accounts for 2 of the 6 rules that
ruleset 16189198 actually carries, and one of the four unrecorded facts changes
the effective review requirement for the class of change this repo produces
most.

Verified live, not inferred
(`gh api repos/bop-clocktower/canary/rulesets/16189198 --jq '.rules[].type'`):

```text
deletion, non_fast_forward, pull_request,
code_quality, copilot_code_review, required_status_checks
```

The manifest documents `required_status_checks` (the `required`/`advisory`
lists) and the `strict` flag inside it (the `mergePolicy` section). Everything
else is unwritten.

### Goals

1. Record every rule type the ruleset carries, each with a blocking verdict and
   a stated reason.
2. Correct the stated-vs-effective review requirement.
3. Record the access posture that makes the review requirement meaningful.
4. Make the record falsifiable offline, so a gutted section fails a test rather
   than reading as complete.
5. Fix the stale check-context comment in `guardian.yml`.

### Out of scope

- Changing the ruleset itself. This change records; it does not enforce.
- A live-API drift check in CI. The offline suite deliberately makes no network
  calls (`ts/test/workflow-false-green.test.ts:427-432` states the reasoning for
  `strict`); the same reasoning applies here, so the reconciliation stays a
  documented `gh api` one-liner in the manifest header.
- Creating `SECURITY.md`. See Decision 3.

## Decisions made

### 1. A new top-level `rulesetRules` section, not prose in `$comment`

The manifest already proves that a fact buried in a `$comment` goes stale
silently — `strict` was recorded as `false` for three weeks
(`.github/required-checks.json` `mergePolicy.$comment`). A structured section
with one entry per rule type is the shape a test can enumerate, which is what
makes the rest of this change falsifiable.

Each entry carries: `rule` (the API `type`), `blocking` (boolean), `parameters`
(the live values that matter), and `reason` (prose).

### 2. Rewrite the `reviews` rationale; do not drop the flag

Live, verified:

```json
"require_extra_approval_for_unattributed_changes": true,
"required_approving_review_count": 0
```

The manifest's stated reason for `0` is sound in itself — a single-maintainer
repo that requires 1 approval trains self-approval, which is the reflex the gate
exists to prevent. But the flag raises the requirement to 1 for unattributed
(agent- or bot-authored) commits, which is a large share of what lands here.
Dropping the flag would remove a protection to make a sentence true. Rewriting
the sentence to describe the effective policy is the correct direction: the
record was wrong, not the ruleset.

### 3. Record the access posture in the manifest, not in a new `SECURITY.md`

The issue names `SECURITY.md` as the conventional home. This repo has none, and
adding one creates a public-facing vulnerability-reporting contract that is a
scope decision of its own, not a byproduct of a documentation fix. The posture
belongs next to the review count it qualifies — a reader who finds
`required_approving_review_count: 0` needs the collaborator shape in the same
breath, not one file away. Recorded as aggregate role counts only; accounts are
never enumerated.

### 4. Falsifiable offline, not live

`ts/test/workflow-false-green.test.ts` parses workflow YAML, so a ruleset rule
that is not a status context is structurally invisible to it — the same blind
spot #769 documented for app-produced statuses, and the reason this gap could
not have been caught by the existing suite. The new tests mirror the
`externalStatuses` pattern at `ts/test/workflow-false-green.test.ts:354-409`:
assert a non-zero denominator, assert every entry is complete, and pin the
observed rule-type set so that recording a new rule without a verdict, or
deleting a recorded one, fails loudly. What no offline test can do is discover a
rule nobody wrote down; the `gh api` line in the section header is that step,
exactly as it is for `strict`.

### 5. `guardian.yml` comment: correct it in place

`.github/workflows/guardian.yml:151-157` instructs a maintainer to register the
context `"PR Guardian / guardian"` alongside `enforce`. Neither string is live:
the contexts are the bare `guardian` and `deps-and-validate`, and `enforce` was
retired by #698. Registering what the comment says would block every PR
indefinitely. One-line correction, no behavior change.

## Technical design

| File                                   | Change                                                                |
| -------------------------------------- | --------------------------------------------------------------------- |
| `.github/required-checks.json`         | Add `rulesetRules`; rewrite `reviews` with effective policy + posture |
| `ts/test/workflow-false-green.test.ts` | Add a `#1056` describe block enumerating `rulesetRules`               |
| `.github/workflows/guardian.yml`       | Correct the stale check-context comment                               |

`rulesetRules` shape:

```json
{
  "rulesetRules": {
    "$comment": ["... how to re-read this live ..."],
    "rules": [
      {
        "rule": "code_quality",
        "blocking": true,
        "parameters": { "severity": "errors" },
        "reason": ["..."]
      }
    ]
  }
}
```

## Integration points

- **Entry points:** None. No new CLI surface, module, or script — so none of the
  three CI ratchets on a new module (dead exports, perf complexity, arch
  allowance) apply.
- **Registrations required:** None.
- **Documentation updates:** `.github/required-checks.json` is itself the doc.
- **Architectural decisions:** None rise to an ADR. ADR 0011 already governs the
  manifest; this extends its record rather than changing its authority model.
- **Knowledge impact:** The direction-of-authority distinction the manifest
  already draws for `strict` (manifest primary for the required set, ruleset
  primary for observed fields) now extends to `rulesetRules` — every entry is an
  OBSERVATION, so on a disagreement the ruleset wins.

## Success criteria

1. `rulesetRules` records all six live rule types, each with a boolean
   `blocking` and a non-empty `reason`.
   `grep -c "code_quality\|copilot_code_review\|unattributed" .github/required-checks.json`
   returns non-zero (it returns 0 today).
2. The `reviews` section states the effective requirement: 1 approval for
   unattributed changes, 0 otherwise.
3. The `reviews` section records the collaborator shape as aggregate counts,
   with no account enumerated.
4. Deleting a `rulesetRules` entry, or adding one without a verdict or reason,
   fails `ts/test/workflow-false-green.test.ts`.
5. `.github/workflows/guardian.yml` names no string that is not a live check
   context.
6. Four gates green from `ts/`: build, typecheck, format:check, test.

## Implementation order

1. Write the failing tests (`#1056` describe block) against the absent section.
2. Add `rulesetRules`; rewrite `reviews`.
3. Correct the `guardian.yml` comment.
4. Prettier, then the four gates.
