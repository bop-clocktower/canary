# Deploy Checklist: canary-test-ai-agent

**Date:** 2026-05-13 | **Deployer:** Bri | **Strategy:** Direct / all-at-once

---

## Pre-Deploy

### Code Quality (anti-regression gate)

- [ ] Every file you touched is in at least as good a shape as you
      found it — no shortcuts, no TODO bombs left behind
- [ ] Run the full test suite locally and confirm it's green
- [ ] Diff your changes: nothing unexpected crept in (e.g. debug
      prints, commented-out blocks, hardcoded values)
- [ ] If you refactored anything, verify behavior parity with a
      quick manual smoke test
- [ ] Check for any newly introduced imports or dependencies —
      are they intentional and pinned?

### Scaffolding Integrity

- [ ] New modules/files follow the established project structure
      and naming conventions
- [ ] Any config changes (env vars, settings files) are documented
      in a comment or the relevant README section
- [ ] The company-fork-compatible layer is not broken — verify that
      nothing in this change would require a non-trivial patch in
      the org fork
- [ ] Verify the separation of concerns between this repo and the
      company fork is still clean (no logic that belongs in the
      company-specific layer has leaked in here)

### Final Sanity Check

- [ ] `git diff main` looks exactly like what you intended to ship —
      no accidental file inclusions
- [ ] All new files are tracked (`git status` shows nothing
      unintentionally untracked)

---

## Deploy

- [ ] Push / merge to main (or deploy branch)
- [ ] Confirm the deploy completes without errors
- [ ] Run a quick end-to-end smoke test of the primary flow you
      changed
- [ ] Verify any new config/infra changes took effect as expected

---

## Post-Deploy

- [ ] Spend 5 minutes exercising the changed surfaces — does
      everything behave as expected?
- [ ] Check logs for any new warnings or errors that weren't there
      before
- [ ] If this scaffolding change affects the company fork, note what
      needs to be ported or adapted there
- [ ] Update any relevant internal notes / dev journal with what
      changed and why

---

## Rollback Triggers

Since this is a direct deploy with no feature flags,
rollback = `git revert` + redeploy.

Roll back immediately if:

- A previously working flow is broken
- An unintended behavior regression appears in any tested path
- New errors appear in logs that weren't present before the deploy

---

## Notes

> _"Always improve the code you touch, never slide back."_
>
> If you find yourself about to deploy something and you're not
> confident it's cleaner than what it replaced — stop, fix it,
> then ship.
