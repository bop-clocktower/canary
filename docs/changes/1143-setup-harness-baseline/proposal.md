# canary-setup-harness: a six-workflow baseline, with the other two conditional

**Keywords:** canary-setup-harness, required-checks, baseline workflows,
guardian, leak-gate, validate-plugin, doc drift

## Overview

`canary-setup-harness` tells a new project it needs **five** required CI
workflows. Canary's own `.github/required-checks.json` requires **eight**. The
skill never said whether the gap was on purpose (#1143), so a reader could not
tell a deliberate baseline from a stale copy.

Goal: the skill states one baseline, says why it differs from canary's own
required set, and a test holds the two together so the count cannot drift again.

Out of scope: changing which checks canary itself requires, and building a new
guardian workflow template.

## Decisions made

| #   | Decision                                                                                                                                                                                                                      | Rationale                                                                                                                                                                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Baseline = six workflows**: the five harness workflows plus `guardian.yml` (issue option 2; human-approved 2026-10-05).                                                                                                     | `guardian.yml` is canary's own product and the most canary-specific check. A canary setup without it ships the guardrails but not the guardian.                                                                         |
| D2  | `leak-gate.yml` and `validate-plugin.yml` are **conditional add-ons**, each with its condition stated: leak-gate for a public repo with an identifier denylist (#843); validate-plugin for a repo that ships a Claude plugin. | Neither applies to every adopting project. Requiring them would make a private repo or a non-plugin repo carry a gate with nothing to check.                                                                            |
| D3  | One sentence says canary's own repo requires all eight, and why two are conditional.                                                                                                                                          | Makes the gap visibly deliberate rather than looking stale.                                                                                                                                                             |
| D4  | Option 3 (derive the list from `required-checks.json`) is rejected.                                                                                                                                                           | Forks and new projects do not share canary's repo-specific gates (issue #1143, option 3).                                                                                                                               |
| D5  | `guardian.yml` wiring instructions point at canary's stock workflow and the PR-check section of `docs/guides/pr-guardian.md`; no new template is built.                                                                       | The stock workflow already exists at `.github/workflows/guardian.yml`, and `docs/guides/pr-guardian.md#pr-check` documents enabling it. The other five are likewise "copied from an upstream Canary reference install". |

Approaches considered: the three options listed in #1143. Option 1 (keep five,
explain) leaves canary's flagship check out of the default; option 3 is wrong
for forks. Option 2 was chosen.

## Technical design

`agents/skills/claude-code/canary-setup-harness/SKILL.md`:

- Frontmatter description: "five required CI workflows" becomes "six baseline CI
  workflows".
- Phase 3 step 2 becomes "Baseline workflows", lists six, then a "Conditional
  add-ons" list naming `leak-gate.yml` and `validate-plugin.yml` with their
  conditions, then the one canary-requires-eight sentence.
- A new step says how to wire `guardian.yml` (copy the stock workflow, set
  `canary.guardian.pr.enabled`, link the guide; note it is PR-only).
- Phase 5 check list adds the guardian; Success Criteria and the fresh-fork
  example say six.

Test, extending `ts/test/required-workflows-docs.test.ts` through
`ts/test/required-checks-testkit.ts` (no testkit change):

- The baseline list parsed from step 2 is non-empty and a subset of the
  manifest's required workflows.
- Each conditional add-on is a required workflow, carries a stated condition,
  and is not in the baseline.
- baseline ∪ conditional = the manifest's required workflows, so a new required
  workflow must be classified.
- Every spelled-out count ("five", "six", ...) next to "workflow"/"gate" in the
  skill equals the baseline length.

## Integration points

- **Entry points:** none new; one existing skill's content.
- **Registrations required:** none. The skill has no generated mirror (no
  `skill.yaml`, no slash-command copy); `README.md` and
  `docs/guides/harness-canary-integration.md` describe it without a count.
- **Documentation updates:** the skill itself.
- **Architectural decisions:** none (small change).
- **Knowledge impact:** none.

## Success criteria

1. When the skill is read, every count of its baseline workflows says six and
   the baseline list has six entries.
2. When a workflow is added to the manifest's `required` set, the docs test
   fails until the skill classifies it as baseline or conditional.
3. If a baseline workflow is not required by the manifest, the docs test fails.
4. The skill names a condition for each conditional add-on and explains why
   canary requires eight.

## Implementation order

1. Write the failing test (red against the five-workflow skill).
2. Update the skill to the six-workflow baseline (green).
3. Gates, PR.
