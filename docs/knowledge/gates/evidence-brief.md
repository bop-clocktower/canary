---
type: business_rule
domain: gates
source: authored
related:
  - docs/knowledge/gates/denominator-carrying-metric.md
  - docs/changes/613-canary-question/proposal.md
---

# Evidence brief, not a classifier

Where a wrong answer is worse than no answer, canary prints an **evidence
brief** instead of a classification: named hypotheses in a fixed order, the
evidence for and against each, a derived fidelity label with its denominator,
what could not be read, and what observation would tell the hypotheses apart. It
never chooses.

## Why

"It's just a flaky test" stamped on a real product defect is how defects escape,
and it degrades the escaped-defect metric while appearing to help (#613). A
classifier's confident wrong answer is indistinguishable from its confident
right one. A brief's evidence can be checked.

## The rule

- The hypothesis order is fixed and never depends on the evidence. The layout
  itself must not read as a ranking.
- A signal that does not discriminate supports every hypothesis. It is never
  quietly assigned to one: nondeterminism is what a product race looks like too.
- Fidelity is derived from what was read (`abstained` / `thin` / `history` /
  `history+diff`), never asserted. Abstention prints no evidence at all.
- Unreadable optional evidence is listed as Not checked, with the reason.
- The absence of verdict language is a property of the output, so it is asserted
  on the output, over every fixture.

## Where it is implemented

- [`brief.mjs`](../../../agents/skills/claude-code/canary-question/scripts/brief.mjs)
  — assembly, fidelity, fixed order, renderers.
- [`signals.mjs`](../../../agents/skills/claude-code/canary-question/scripts/signals.mjs)
  — every signal and which hypotheses it bears on.
- [`canary-question.test.ts`](../../../agents/skills/test/canary-question.test.ts)
  — the no-verdict guard (SC9).
