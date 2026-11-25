---
name: canary-cry
description:
  Pre-launch "try to break it" sweep of ordinary user flows, run ahead of a
  launch, a client onboarding or a demo so a sales demo never has to explain
  away a bug. It abuses flows the way real people do (an impatient double-submit
  on a slow network, abandoning a multi-form flow after it wrote partial rows, a
  second user on a shared machine, a duplicated tab, a token that expires
  mid-flow) and judges by state corruption, not by rendering. This release ships
  the deterministic half. `validate` checks the declared .canary/cry/flows.json
  and targets.json and names the JSON path of every error; `matrix` emits the
  ranked scenario matrix (flows x abuse patterns, cut to a whisper, shout or
  scream budget) with no network and no agent. Live runs against an allowlisted
  non-prod target arrive in later phases. NOT input fuzzing and NOT targeted bug
  pursuit (that is canary-huntress).
cli: scripts/cli.mjs
requires: [node>=20]
---

# Canary Cry

## Quick start

```bash
canary skills run canary-cry -- --help
```

Pre-launch "try to break it" sweep of ordinary user flows (#608). Phase 1 is in
progress; see the
[canary-cry spec](../../../../docs/changes/canary-cry/proposal.md).
