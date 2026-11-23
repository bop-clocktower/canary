# Plan: build the refresh-baseline push-job git fixture once, copy it per test

Item: `bop-clocktower/canary#1645` (harness `cicd-fleet`, run fc1123, fork F2=A)
· Pipeline: `harness:debugging` (investigate → analyze → hypothesize → fix) ·
Date: 2026-11-23 · Base: `origin/main` @ `9c15de65` · Refs #1261, #1243

---

## 1. INVESTIGATE

| Question                    | Answer                                                                                                                                                                                                |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What failed                 | `Error: Hook timed out in 10000ms.` in `ts/test/refresh-baseline-push-job.test.ts`, seen once in a full local `npm test` (issue body).                                                                |
| Which hook                  | The file's single top-level `beforeEach` (base line 151).                                                                                                                                             |
| What it did                 | **8** synchronous `git` spawns per test: `init --bare`, `clone`, `checkout -b`, `add`, `commit`, `push`, `rev-parse`, `checkout --detach`. 51 tests, so 408 spawns per file run in hooks alone.       |
| Reproduces alone at 10 s?   | No: 51/51 passed 3 of 3 runs (10.9-11.3 s file duration).                                                                                                                                             |
| Deterministic stand-in      | Lowered hook budget. `--hookTimeout=100`: **51/51 fail** "Hook timed out in 100ms". `150`: 1 fails. `250`: 0 fail. So the hook costs ~100-150 ms idle; full-suite contention multiplies it past 10 s. |
| Recent changes              | None to the fixture since #1463/#1591. Load, not a regression.                                                                                                                                        |
| Entropy (`harness cleanup`) | 106 findings, equal to the merge base; none in or near this file.                                                                                                                                     |

## 2. ANALYZE

Working example: #1261 (`ts/test/git-fixture-testkit.ts`, used by
`branch-prune.test.ts`, `rewind-replay.test.ts`, `order-cli.test.ts`). It builds
a template in `beforeAll` (`buildGitTemplate`, 60 s
`GIT_TEMPLATE_BUILD_TIMEOUT_MS`) and gives each test a `cpSync` copy
(`copyGitTemplate`). The one difference to handle: a clone records its origin as
an absolute path, so a copy would still push to the template's origin.
branch-prune re-points it with one `git remote set-url` per test; the brief asks
for zero spawns in `beforeEach`.

## 3. HYPOTHESIZE

> The timeout is the per-test spawn cost of the fixture, not a defect in the
> workflow scripts. If so, a `beforeEach` that starts no process passes the
> lowered-budget reproduction 51/51 and the file gets measurably faster.

Tested one variable: fixture construction. Result: confirmed (section 5).

Relative-remote check (scratch, before writing the fix): a clone whose
`remote.origin.url` is `../origin.git`, copied with `cp -R`, pushes to its own
copied origin from the work tree root and from a subdirectory; the template's
origin is unchanged.

## 4. FIX

1. **Guard first (red).** Every process the file starts now goes through one
   local `spawn()` wrapper that counts. The top-level `beforeEach` records how
   many it started;
   `gives each test its fixture without starting a process (#1645)` asserts 0.
   On the unfixed fixture: `AssertionError: expected 8 to be +0`.
2. **Fix.** `beforeAll` builds the bare origin, the work clone (origin URL set
   once to `../origin.git`), the seed commit and the detached checkout, via
   `buildGitTemplate`. `beforeEach` copies it with `copyGitTemplate`, resets
   `headSha` to the template's seed SHA, and writes the two artifact files. No
   git. `afterEach`/`afterAll` use `removeGitFixture`.
3. **Isolation guard.** `pushes to the copy of origin, never to the template`
   runs the push job and asserts the template's branch tip is still the seed.
   Mutation check: deleting the `set-url` line turns it, and every push test,
   red.
4. No `hookTimeout`/`testTimeout` change, no skip, retry or quarantine, no
   assertion touched.

## 5. VERIFY

Counts and timings are in section 6.

| Gate (from `ts/`)                 | Result                          |
| --------------------------------- | ------------------------------- |
| `npm run build`                   | pass                            |
| `npm run typecheck`               | pass                            |
| `npm run format:check`            | pass                            |
| `npm test` x5 consecutive         | file passed 5/5 (see section 6) |
| perf ratchet (head vs base)       | 198 vs 198 (+0), ceiling 201    |
| entropy ratchet (head vs base)    | 106 vs 106 (+0), ceiling 116    |
| `harness check-deps` / `validate` | pass / pass                     |
| `--hookTimeout=100` on this file  | 53/53 pass (base: 51/51 fail)   |
| `--sequence.shuffle` on this file | 53/53 pass                      |

## 6. Proof counts and timings

All numbers are from this machine (10 cores, Node 22.23.2). Other fleet lanes
were running suites at the same time, so load averages are high and uneven,
which is the load the issue describes.

**5 consecutive full `npm test` runs from `ts/` (branch head):**

| Run | Exit | Wall | Load avg (1 min) | Result                                  | This file |
| --- | ---- | ---- | ---------------- | --------------------------------------- | --------- |
| 1   | 0    | 41 s | 12.75            | 7581 passed, 3 skipped                  | passed    |
| 2   | 0    | 42 s | 21.67            | 7581 passed, 3 skipped                  | passed    |
| 3   | 0    | 59 s | 27.39            | 7581 passed, 3 skipped                  | passed    |
| 4   | 1    | 74 s | 52.40            | 1 suite failed (unrelated), 7578 passed | passed    |
| 5   | 0    | 50 s | 59.28            | 7581 passed, 3 skipped                  | passed    |

Run 4's failure was not this file. It was
`ts/test/analysis-scope-rehearsal.test.ts:169`, a `beforeAll` that runs the
harness CLI twice and hit `Hook timed out in 10000ms` at load 52. It is filed as
issue #1651.

**20 stressed repeats of the file, before and after:** 5 rounds of 4 parallel
`npx vitest run test/refresh-baseline-push-job.test.ts --sequence.shuffle`
processes, with 8 `yes` CPU burners running throughout.

| Tree                      | Passed | Failed | File duration (vitest) |
| ------------------------- | ------ | ------ | ---------------------- |
| base `9c15de65` (unfixed) | 20     | 0      | 26.8-30.5 s            |
| this branch               | 20     | 0      | 9.7-10.6 s             |

**Idle timings, file alone:** base 10.9 / 11.2 / 11.3 s, branch 4.2 / 4.3 / 4.4
s.

**`--sequence.concurrent` is not a valid stress for this file:** 20 of 20 runs
fail on both the base (21 of 51 tests) and the branch (14 of 53). The tests
share module-level fixture state (`dir`, `work`, `headSha`), so tests that run
concurrently inside one worker overwrite each other's paths. That was true
before this change and is unchanged by it. The repo's vitest config never runs
tests concurrently inside a file, so this is a design property, not a failure
the suite can hit.

## 7. Out of scope (deferrable)

- `ts/test/critical-areas-consumers.test.ts` has a describe-level `beforeEach`
  with `git init` + a commit + a canary invocation per test. Same class, a few
  spawns, not observed failing.
