# Plan: canary-setup-harness six-workflow baseline (#1143)

Spec: `docs/changes/1143-setup-harness-baseline/proposal.md`

## Tasks

1. **Test first.** Extend `ts/test/required-workflows-docs.test.ts` with a
   `#1143` block that parses the skill's Phase 3 step 2 baseline list and
   conditional add-on list, and asserts: baseline non-empty and subset of
   `requiredWorkflows()`; conditional entries required, disjoint from the
   baseline, each with a condition; baseline ∪ conditional = required; every
   spelled-out workflow count equals the baseline length. Include planted
   positives so the parsers are not vacuous. Run it: expect red on the current
   skill (no conditional list; union is 5 not 8).
2. **Skill update.** Rewrite step 2 (six baseline, two conditional with
   conditions, one canary-requires-eight sentence), add a guardian wiring step
   pointing at `.github/workflows/guardian.yml` and
   `docs/guides/pr-guardian.md#pr-check`, update the frontmatter description,
   Phase 5 checks, Success Criteria and the fresh-fork example. Expect green.
3. **Gates.** From `ts/`: build, typecheck, format:check, test; skill tests
   under `agents/skills/`; prettier on touched md/ts.
4. **Provenance, commit, PR** with `Closes #1143`.

## Checkpoints

- After task 1: the new test is red for the stated reason (not a parse error).
- After task 2: the full `required-workflows-docs` suite is green.
