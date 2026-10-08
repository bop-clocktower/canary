# Plan: Nested test-config detection (#1212)

**Spec:** `docs/changes/1212-nested-config-detection/proposal.md`
**Phase:** 1 of 1 (complexity: low). Rigor: fast. The spec has a single
coherent phase, so the plan was approved automatically.

## Tasks

### Task 1: Extract `config-probes.ts` as a pure move

**Files:** `ts/src/core/config-probes.ts` (new),
`ts/src/core/framework-probes.ts`, `ts/src/core/workspace-detect.ts`

Move `CONFIG_PROBES`, `inferPlaywrightTestType`, `_PW_UI_FIXTURE_RE` and
`probeConfig` into the new module. `workspace-detect` imports
`CONFIG_PROBES` and `inferPlaywrightTestType` from it directly, with no
re-exports. Behavior does not change: run the existing test suite, which
must stay green.

### Task 2: Write failing tests for the walker

**Files:** `ts/test/nested-config-walk.test.ts` (new)

Cover these cases:

- A config at depth 3 is found, and a config at depth 4 is not.
- Every `NESTED_CONFIG_SKIP_DIRS` entry is skipped, including
  `node_modules`. A test pins the list itself.
- Results come back sorted and are independent of creation order.
- A config at depth 0 is not part of the walk.
- Agreeing configs produce a hit whose source names the first relative path
  and the count of the others.
- Disagreeing configs produce the mixed abstention, which names every config.
- A Playwright config is refined at its own directory.

### Task 3: Implement the walker

**Files:** `ts/src/core/config-probes.ts`

Add `NESTED_CONFIG_MAX_DEPTH`, `NESTED_CONFIG_SKIP_DIRS`,
`findNestedConfigs` and `probeNestedConfig`. Task 2's tests turn green.

### Task 4: Wire the `nested-config` tier into `probeFramework`

**Files:** `ts/src/core/framework-probes.ts`, `ts/test/framework-probes.test.ts`

Write these tests first:

- The tier list includes `nested-config` and the acceptance package (only
  nested `wdio.conf.ts`, no scripts, no deps) detects `wdio`/`mobile` with
  confidence `config`.
- Without the tier, the result is unchanged.
- A mixed abstention terminates the loop, even when `language` is
  configured.
- Root `scripts.test` outranks a nested config.

### Task 5: Migrator opt-in, reason text, and monorepo regression test

**Files:** `ts/src/core/migrator.ts`, `ts/test/migrator-monorepo-report.test.ts`

Make these changes:

- Add `nested-config` only when `ws === null`.
- `unresolvedFrameworkReason` states the depth it walked for a
  single-package repo, keeps "root-level" for a workspace, and has a
  dedicated reason for the mixed nested case.

Write these tests first:

- A workspace fixture with nested package configs still reports
  `workspace (…)`, never a nested root hit.
- A single-package repo reason names the bounded depth.
- A single-package repo with disagreeing nested configs gets the mixed
  reason.

### Task 6: Gates and ratchets

Run these from `ts/`: build, typecheck, format:check and test. Then check:

- Perf: every file is at most 300 LOC.
- Entropy: the new module is not an entry point.
- Arch: run check-deps from the repo root.
- Dead exports.

## Checkpoints

None needing a human. This is an autonomous fleet lane.
