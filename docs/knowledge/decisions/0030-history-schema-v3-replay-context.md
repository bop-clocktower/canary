---
number: 0030
title: History schema v3 records replay context additively
date: 2026-09-16
status: accepted
tier: medium
source: docs/changes/461-canary-rewind/proposal.md
---

<!-- markdownlint-disable-file MD025 -->

# ADR 0030 — History schema v3 records replay context additively

**Status:** accepted **Date:** 2026-09-16 **Deciders:** Bri Stevenski
**Related:** docs/changes/461-canary-rewind/proposal.md (F1, F2, F3, success
criteria 1-3); docs/changes/461-canary-rewind/spike.md; ADR 0013 (async history
store); ADR 0029 (repo-relative `test_file`);
[`replay-context.ts`](../../../ts/src/history/keys/replay-context.ts),
[`replay-record.ts`](../../../ts/src/history/keys/replay-record.ts)

## Context

`canary rewind` (#461) reruns one failed test from a recorded run. The spike
found that a stored run carries a commit and test identity and nothing else a
replay needs: no seed, no execution order, no environment. The signed-off
proposal builds capture before replay (F1), stores the new facts on the existing
run record with a version bump rather than in a sidecar file (F2), and records a
seed only when it is known for certain (F3).

The reader's version guard (#701) refuses any `schema_version` it does not
understand, and its comments said the next bump "has to ship a migration".

## Decision

- `SCHEMA_VERSION` becomes **3**. v3 adds two optional fields and changes the
  meaning of none:
  - a run-level `replay` block: `seed`, `seed_source`, `runner {name, version}`,
    `node`, `os`, `arch`, `ci`, `commit_source`;
  - a per-test `start_index`: the rank of the test's file by start time.
- The reader accepts **v2 and v3** (`SUPPORTED_SCHEMA_VERSIONS`). No migration:
  an additive bump leaves every v2 row meaning what it meant, and an absent
  field reads as "not recorded". A future bump that changes an existing field's
  meaning still needs a migration. Versions above 3 are still refused.
- Unknown is `null` (or an absent `start_index`), never a default. `seed` is
  recorded only from `record --seed`; none of the supported report formats
  carries one, so `seed_source: 'report'` is reserved and unused.
- `commit_source` is `flag`, `GITHUB_SHA`, `HEAD` (the #1021 replacement of
  `local`), or `null` for a `local` commit, which marks the run non-replayable.
- Only the environment variable names `GITHUB_ACTIONS` and `CI` are read, and
  only to classify `ci`. No variable value is stored.
- `start_index` comes from per-file `startTime` (vitest) or the earliest attempt
  `startTime` per file (Playwright). JUnit gets none.
- The new fields are local-store only, like `reporter_format` (#604). The remote
  tables have no columns for them.

## Consequences

- Every run recorded from now on carries a non-null runner name, Node, OS and
  arch, so a replay can compare fingerprints (proposal criterion 6).
- An older canary build reading a store that holds v3 rows refuses it loudly.
  That is the guard doing its job; upgrading canary fixes it.
- Seed is `null` on most runs until a pipeline passes `--seed`, and a replay
  will say so rather than approximate.
- `runner.version` is `null` for vitest and JUnit, whose reports do not name it.
