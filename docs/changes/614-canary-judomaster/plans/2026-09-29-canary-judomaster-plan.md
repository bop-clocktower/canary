# Plan: canary-judomaster (stack trace to a watched-failing regression test)

**Date:** 2026-09-29 | **Spec:** docs/changes/614-canary-judomaster/proposal.md
| **Tasks:** 12 | **Time:** ~50 min | **Integration Tier:** medium

## Goal

`canary judomaster brief` turns a pasted V8/CPython trace into a regression
brief, and `canary judomaster verify` grades a generated test by a real run,
never reporting a pass as success.

## Observable Truths (Acceptance Criteria)

1. When a V8 or CPython trace (with `>` quotes, fences, ANSI) is given to
   `brief`, the system shall emit a brief whose `suspect` is the innermost
   in-repo frame, even for `/app/src/...` paths (SC1). Tasks 1-3, 8.
2. If no frames parse or none resolve under the root, then `brief` shall exit 3
   naming the reason, never 0 (SC2). Tasks 3, 8.
3. When the test fails and output contains the signature, `verify` shall print
   `reproduced` and exit 0 (SC3). Tasks 4, 9.
4. When the test passes, `verify` shall print `not-reproduced` plus a vacuity
   red flag and exit 1 (SC4). Tasks 4, 9.
5. When it fails without the signature, `verify` shall print
   `failed-other-reason`, labelled unverified, exit 1 (SC5). Tasks 4, 9.
6. When collection fails, times out (124), cannot spawn, or the framework is
   unknown, `verify` shall print `unverified — could not reproduce` and exit 3
   (SC6). Tasks 4, 9.
7. If the test realpath is outside `<root>/tests/generated/`, `verify` shall
   exit 2 and the fake executor records zero calls (SC7). Tasks 5, 9.
8. `npm run build && npm run typecheck && npm run format:check && npm test`
   (from `ts/`) pass; check-arch/entropy/perf ratchets green with no
   `maxFindings` change (SC8). Task 12.

## Uncertainties

- [ASSUMPTION] A spawn failure reaches `classifyRun` as `[1, '', <err>]` with
  `ENOENT|EACCES|spawn` in stderr (`ts/src/core/executor.ts:185`), or as exit
  127; both classify `unverified`. An unknown/command-less framework makes
  `execute` throw (`executor.ts:140-150`); the CLI catches it and classifies
  `unverified`.
- [ASSUMPTION] Dead-export detection ignores test-only imports, so engine
  modules export only what the CLI imports; helpers (`normalizeTrace`) are
  tested through `parseTrace`.
- [ASSUMPTION] stdin is read with `readFileSync(0, 'utf-8')` (precedent
  `ts/src/briefing/briefing-cli.ts:76`); its test uses `vi.mock('node:fs')` in
  its own file so the mock cannot leak.
- [DEFERRABLE] Exact requirement-string wording and markdown layout.
- [DEFERRABLE] Size of the module-size growth; measured in Task 12, not guessed.

## File Map

- CREATE ts/src/analysis/judomaster/{types,parse,resolve,brief,verify,render}.ts
- CREATE ts/src/judomaster/judomaster-cli.ts
- MODIFY ts/src/commands/readiness/cli.ts (append to READINESS_COMMANDS, after
  manhunter, line 30)
- MODIFY ts/test/cli-command-registry.test.ts (append `'judomaster'` to
  EXPECTED_COMMANDS)
- CREATE
  ts/test/judomaster-{parse,resolve,brief,verify,render,cli,cli-stdin}.test.ts
- CREATE agents/skills/claude-code/canary-judomaster/{SKILL.md,skill.yaml}
- MODIFY agents/skills/README.md, docs/naming-registry.md (line 94)
- CREATE docs/guides/incident-to-regression-test.md; MODIFY
  docs/guides/index.md, CHANGELOG.md, docs/roadmap.md (line 107 row)
- CREATE .harness/arch/allowances/feat-614-canary-judomaster.json; MODIFY
  .harness/arch/baselines.json (via script)

## Skeleton

1. Engine: parse, resolve, brief, verify, containment, render (6 tasks, ~25 min)
2. CLI: mount, brief, verify (3 tasks, ~15 min)
3. Docs + ratchets (3 tasks, ~12 min) _Skeleton approval: pending caller
   sign-off (12 tasks >= 8)._

## Tasks

Every task: write the test, run `cd ts && npx vitest run test/<file>` and see it
fail, implement, see it pass, run `harness validate`, commit. Keep every
function at cyclomatic <= 10 and export only what another `src` module imports.
Engine files import only `node:*`, `../../core/*`, `../../util/*`.

### Task 1: Types and trace parser

**Depends on:** none | **Files:** ts/src/analysis/judomaster/types.ts,
ts/src/analysis/judomaster/parse.ts, ts/test/judomaster-parse.test.ts

1. Test cases for `parseTrace(text): ParsedTrace | null`: V8
   `TypeError: Cannot read properties of undefined (reading 'qty')` + an
   indented `at cartTotal (/app/src/cart/total.ts:12:7)` gives format `v8`,
   errorType `TypeError`, and a first frame with file `/app/src/cart/total.ts`,
   line 12, column 7, fn `cartTotal`; `at /x/y.js:3:1` (no fn);
   `file:///home/ci/work/repo/src/a.ts:4:2` strips `file://`; the same trace
   wrapped in `>` quotes, a code fence and `\x1b[31m` ANSI parses identically;
   CPython `Traceback (most recent call last):` / an indented
   `File "/srv/app/cart/total.py", line 8, in total` / `ValueError: bad qty`
   gives frames reversed so innermost is first; prose-only input and a Java
   `at com.x.Y(Y.java:3)` trace give `null`.
2. `types.ts`: the spec's type block verbatim (Technical design), all
   `export`ed.
3. `parse.ts`: private `normalizeTrace` (strip `/\x1b\[[0-9;]*m/g`, leading
   `>\s?`, fence lines);
   `V8_FRAME = /^\s*at (?:(.+?) \()?(?:file:\/\/)?(.+?):(\d+):(\d+)\)?$/`;
   `PY_FRAME = /^\s*File "(.+)", line (\d+)(?:, in (.+))?$/`; error line = first
   `^(\w[\w.]*(?:Error|Exception)\w*):\s?(.*)$` (V8) or last such line (Python).
   Separate `parseV8`/`parsePython`; `export function parseTrace`.
4. Commit: `feat(judomaster): parse V8 and CPython stack traces (#614)`

### Task 2: Frame resolver

**Depends on:** Task 1 | **Files:** ts/src/analysis/judomaster/resolve.ts,
ts/test/judomaster-resolve.test.ts

1. Test with a `mkdtempSync` root holding a synthetic `src/cart/total.ts` (20
   lines): `/app/src/cart/total.ts:12` resolves by longest existing suffix to
   `path:'src/cart/total.ts'`, `status:'resolved'`, `excerpt` = lines 10-14; a
   root-relative `src/cart/total.ts:12` resolves as given; line 99 gives
   `stale`; `node_modules/x/i.js`, `site-packages/y.py`, `node:internal/...`,
   `<anonymous>` give `external`; `/app/src/gone.ts` gives `missing`; a suffix
   that escapes root via `..` never resolves.
2. `export function resolveFrames(frames: RawFrame[], root: string): ResolvedFrame[]`
   with helpers `isExternal`, `findInRoot` (try as-given if inside root, then
   suffixes longest-first, each checked with `realpathSync` containment under
   `realpathSync(root)`), `excerpt(lines, line)` (±2).
3. Commit: `feat(judomaster): resolve trace frames to repository files (#614)`

### Task 3: Regression brief

**Depends on:** Task 2 | **Files:** ts/src/analysis/judomaster/brief.ts,
ts/test/judomaster-brief.test.ts

1. Test `buildBrief(trace, frames)`: `schema:'canary-judomaster-brief/1'`;
   `suspect` = first frame with status `resolved|stale` (skipping an external
   innermost frame); `signature` `{text: message first line, kind:'message'}`,
   or `{text: errorType, kind:'type-only'}` when the message is empty; v8 gives
   `framework:'vitest'`,
   `outputPath:'tests/generated/regression/total-typeerror.test.ts'`; python
   gives `pytest`, `tests/generated/regression/test_total_valueerror.py`;
   `requirement` contains the path:line, fn, signature text and "must fail
   against the current code"; no suspect gives `suspect:null` (CLI turns that
   into exit 3).
2. Implement with helpers `pickSuspect`, `signatureOf`, `outputPathFor`,
   `requirementFor`; `export function buildBrief`.
3. Commit: `feat(judomaster): build the regression brief (#614)`

### Task 4: Run classifier and framework inference

**Depends on:** Task 1 | **Files:** ts/src/analysis/judomaster/verify.ts,
ts/test/judomaster-verify.test.ts

1. Table test `classifyRun([exit, stdout, stderr], signature | null)` returning
   `{verdict, label, vacuity, reason}`: `[0,'1 passed','']` gives
   `not-reproduced`, `vacuity:true`;
   `[1,'...Cannot read properties of undefined (reading \'qty\')...','']` with a
   message signature gives `reproduced` (match after ANSI strip, across
   stdout+stderr); `[1,'AssertionError','']` gives `failed-other-reason`, label
   `unverified`; signature `null` + exit 1 gives `failed-other-reason` with
   reason "no signature to confirm against"; `[1,'No test files found','']`,
   `[5,'','']` with `pytest`, `[1,'No tests found','']`, `[124,...]`,
   `[127,...]`, `[1,'','spawnSync npx ENOENT']` all give `unverified` and label
   `unverified — could not reproduce`. Also `inferFramework`: `a.py` gives
   pytest, `a.spec.ts`/`a.e2e.js` gives playwright, `a.test.mts` gives vitest,
   `a.rb` gives null.
2. Implement: `couldNotRun(exec, framework)` checked first, then exit 0, then
   signature match. Export `classifyRun`, `inferFramework`, `VerifyResult` type.
3. Commit: `feat(judomaster): classify a regression run by signature (#614)`

### Task 5: tests/generated containment

**Depends on:** Task 4 | **Files:** ts/src/analysis/judomaster/verify.ts,
ts/test/judomaster-verify.test.ts

1. Test `containedInGenerated(root, testPath): string | null` (realpath or
   null): a file under `<root>/tests/generated/regression/` passes;
   `<root>/src/x.test.ts`, `../outside.test.ts`, a missing file, and a symlink
   inside `tests/generated/` pointing to `<root>/src/evil.test.ts` return null.
2. Implement with `realpathSync` on both sides and a `startsWith(base + sep)`
   check (same argument as `ts/src/mcp-server.ts:611`, not imported: entry
   layer).
3. Commit: `feat(judomaster): confine verify to tests/generated (#614)`

### Task 6: Markdown renderers

**Depends on:** Tasks 3, 5 | **Files:** ts/src/analysis/judomaster/render.ts,
ts/test/judomaster-render.test.ts

1. Test `renderBrief(brief)` shows suspect `path:line`, signature and its kind,
   stale/external/missing frames named, the requirement, `outputPath`;
   `renderVerify(result)` puts the verdict first, shows
   `VACUITY RED FLAG: the test passed against the code it was written to catch`
   when `vacuity`, and "unverified" wording verbatim.
2. Implement; export both. Commit:
   `feat(judomaster): render brief and verify reports (#614)`

### Task 7: Mount `canary judomaster`

**Depends on:** none | **Files:** ts/test/cli-command-registry.test.ts,
ts/src/judomaster/judomaster-cli.ts, ts/src/commands/readiness/cli.ts

1. Append `'judomaster'` as the last entry of EXPECTED_COMMANDS; run
   `npx vitest run test/cli-command-registry.test.ts` and see it fail.
2. Create `judomaster-cli.ts` (manhunter header style, citing D8) exporting
   `buildJudomasterCommand(deps: MainDeps): Command`, a
   `new Command('judomaster')` whose description says it turns a stack trace
   into a regression brief, then grades the generated test by running it. Append
   `(deps) => buildJudomasterCommand(deps),` after the manhunter entry; if a
   concurrent lane appended first, keep both (append-only).
3. Commit: `feat(judomaster): mount canary judomaster (#614)`

### Task 8: `brief` subcommand

**Depends on:** Tasks 6, 7 | **Files:** ts/src/judomaster/judomaster-cli.ts,
ts/test/judomaster-cli.test.ts, ts/test/judomaster-cli-stdin.test.ts

1. `judomaster-cli.test.ts` via `invokeCanary`/`mkTmp`
   (`ts/test/canary-cli-testkit.ts`): seeded root + trace file gives exit 0 and
   markdown naming `src/cart/total.ts:12`; `--json` prints a parseable brief;
   `--json-out f` writes it; prose-only gives exit 3 + "no V8 or CPython
   frames"; frames all outside root give exit 3 + "no frame resolves inside";
   missing trace file gives exit 2. `judomaster-cli-stdin.test.ts`:
   `vi.mock('node:fs', ...)` makes `readFileSync(0, ...)` return a quoted/ANSI
   trace; `brief` and `brief -` both exit 0.
2. Implement `buildBriefCommand`: `.argument('[trace]')`, `--root`, `--json`,
   `--json-out`; `readTrace` (file, or fd 0 for undefined/`-`), `parseTrace`,
   `resolveFrames`, `buildBrief`, abstain with `CliExitError(EXIT_ABSTAINED)`;
   usage errors `CliExitError(2)`; `.exitOverride(normalizeUsageExit)`.
3. Commit: `feat(judomaster): canary judomaster brief (#614)`

### Task 9: `verify` subcommand

**Depends on:** Task 8 | **Files:** ts/src/judomaster/judomaster-cli.ts,
ts/test/judomaster-cli.test.ts

1. Tests inject `deps: { makeExecutor: () => ({ execute: spy }) as never }`
   (pattern: `ts/test/canary-cli.test.ts:47`): with a brief JSON + test under
   `tests/generated/regression/`: signature in output gives exit 0 `reproduced`;
   `[0,...]` gives exit 1 + VACUITY; wrong failure gives exit 1
   `failed-other-reason`; `[5,'','']` pytest gives exit 3; `execute` throwing
   gives exit 3; `--expect <text>` works without a brief; neither flag + exit 1
   gives `failed-other-reason` + "no signature"; `src/x.test.ts` gives exit 2
   with `spy` never called; `--brief` with a non-brief JSON gives exit 2;
   `--framework pytest` and `--timeout 5` reach
   `execute(realpath, 'pytest', 5)`; `--json` prints
   `{schema:'canary-judomaster-verify/1', verdict, ...}`.
2. Implement `buildVerifyCommand` with `--brief`, `--expect`, `--framework`,
   `--timeout` (default 60), `--root`, `--json`; `runVerify` split into
   `loadSignature`, `pickFramework`, `execSafely`, `exitFor` (reproduced 0,
   unverified 3, else 1).
3. Run `harness check-deps`. Commit:
   `feat(judomaster): canary judomaster verify (#614)`

### Task 10: Skill, skills README, naming registry

**Depends on:** Task 9 | **Files:**
agents/skills/claude-code/canary-judomaster/SKILL.md,
agents/skills/claude-code/canary-judomaster/skill.yaml, agents/skills/README.md,
docs/naming-registry.md | **Category:** integration

1. Flip the `canary-judomaster` row at `docs/naming-registry.md:94` to
   `shipped`; run `npx vitest run test/bop-name-registry.test.ts` and see it
   fail (shipped row needs a skill dir).
2. Create `skill.yaml` mirroring `canary-manhunter/skill.yaml`
   (`name: canary-judomaster`, `tier: 2`,
   `depends_on: [canary-generate-test, canary-promote-test]`) and `SKILL.md`
   frontmatter `cli: canary judomaster`, `requires: [node>=20]`, phases INTAKE,
   AUTHOR (`/canary-write-test` with `requirement` + `outputPath`), VERIFY
   (`verify --brief`), REPORT (relay the verdict verbatim; promote only after
   `reproduced`). README: tree entry after `canary-manhunter/`, bump `(29)` to
   30, description bullet near line 128.
3. Re-run the test (pass), then `npx vitest run test/doc-links.test.ts`. Commit:
   `docs(judomaster): add canary-judomaster skill (#614)`

### Task 11: Guide, changelog, roadmap

**Depends on:** Task 10 | **Files:** docs/guides/incident-to-regression-test.md,
docs/guides/index.md, CHANGELOG.md, docs/roadmap.md | **Category:** integration

1. Guide: paste, brief, author, verify, verdict table (4 verdicts with exit
   codes), the vacuity rule, non-goals (other languages abstain). Index entry
   `### [Incident to Regression Test Guide](./incident-to-regression-test.md)`
   after the Release Dossier entry. CHANGELOG `### Added` bullet under
   Unreleased (`Refs #614`). Roadmap row: keep `Status: planned` (the PR is
   `Refs #614`), set `Plan:` to this file.
2. Run `npx prettier --write` on the four files, then
   `npx vitest run test/doc-links.test.ts`. Commit:
   `docs(judomaster): guide, changelog and roadmap (#614)`

### Task 12: Ratchets and four gates

**Depends on:** Task 11 | **Files:**
.harness/arch/allowances/feat-614-canary-judomaster.json,
.harness/arch/baselines.json | **Category:** integration

1. From `ts/`: `npm run build`, `npm run typecheck`, `npm run format:check`,
   `npm test`; each must report a non-zero test count.
2. `harness check-arch --json > $TMP/branch.json` here and in a detached
   worktree of `git merge-base HEAD origin/main`. Write the allowance in the
   `feat-611-canary-manhunter.json` shape: `reason` (measured delta, base SHA,
   CLI version, no ts/src/history growth),
   `categories: {"module-size": <measured branch value>}`, `violationIds: []`,
   `createdFrom: <base>`. Then
   `node scripts/refresh-arch-baseline.mjs $TMP/branch.json`;
   `npx vitest run test/arch-baseline-freshness.test.ts`.
3. `harness cleanup --findings-json` (the CI entropy scan,
   `.github/workflows/harness-quality.yml:153`; exits 1 whenever findings exist,
   so compare counts against the merge base): count must not rise; unexport any
   dead export it names; never touch `maxFindings`; add `entryPoints` only if a
   file is named. `harness check-perf`: fix any function over complexity 10 in
   code, not by allowance.
4. `harness validate`. Commit:
   `chore(judomaster): arch allowance and baseline floor (#614)`

## Traceability

| Truth | Tasks      |
| ----- | ---------- |
| 1, 2  | 1, 2, 3, 8 |
| 3-6   | 4, 9       |
| 7     | 5, 9       |
| 8     | 12         |
