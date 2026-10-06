# Plan: canary QA site, phase 2 — producers

Issue: [#1151](https://github.com/bop-clocktower/canary/issues/1151) · Spec:
[proposal.md](../proposal.md) (Implementation Order item 2) · Date: 2026-10-06 ·
Base: `57f46c21` (`main`, phase 1 merged as #1153) · Branch:
`feat/1151-qa-site-producers` · Rigor: standard · **Tasks:** 20 · **Time:** ~85
min · **Integration Tier:** large (new skill, new public reporter options)

## Planning decisions (signed off 2026-10-06)

| #   | Decision                                                                                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | **A1.** Assessment values come from `canary ci-ready --json`. Each `CiCheck` gains `measure: {value, unit, denominator} \| null`; the JSON report gains `observed_at`. Starling owns no metric math for ci-ready metrics. A check whose `measure` is null (skipped, thin window, structural zero) becomes `not-assessed` with the check's own reason.         |
| P2  | **B1.** The reporter writes `canary.run/1` only when `runFile` / `CANARY_RUN_FILE` is set. A sharded run inserts `-s<i>of<n>` before the extension. The ingest payload is unchanged byte for byte.                                                                                                                                                            |
| P3  | **C.** A history row becomes a run record with `finished_at = timestamp` and `started_at = timestamp - duration_ms`. A row missing either, or carrying a per-test status outside passed/failed/flaky/skipped, is left out and counted in a stderr note — never given an invented value.                                                                       |
| P4  | **D.** Scope is never inferred (D2). Starling reads `scope` and optional `suites` from `canary-site.config.json` (`--config`, required). The reporter takes `scopeId`/`CANARY_SCOPE_ID` and `scopeEnv`/`CANARY_SCOPE_ENV` (falling back to an explicitly configured `environment`); with `runFile` set and scope incomplete it writes nothing and warns once. |
| P5  | NFR elicitation skipped on all four dimensions (offline JSON over a 30-runs-per-suite feed; existing perf/security/entropy gates stand).                                                                                                                                                                                                                      |
| P6  | One PR for the phase. Group 1 (engine) lands as its first commits so a perf-ratchet failure is visible before the skill work.                                                                                                                                                                                                                                 |

## Soundness-review amendments (2026-10-06) — these override the tasks below

`harness-soundness-review --mode plan` found 4 must-fix, 7 should-fix and 3
nits. The one-line fixes were made in place: no `build` subcommand, no
`@returns` JSDoc in `runs.mjs`, the `forbid` string, and the dependency edges.
Where a task below disagrees with this section, this section wins.

1. **Task 10 also adds the naming-registry row** (must-fix). No
   `canary-starling` row exists, and `ts/test/bop-name-registry.test.ts:210`
   reds as soon as the directory does. In Task 10, add `| \`canary-starling\` |
   shipped | 1151 | QA site feed composer (validated canary.site/1; absent
   inputs not-assessed) |`alphabetically to`docs/naming-registry.md`, and run
   that test. Task 19 drops its registry step.
2. **Task 17: `cli.mjs` is executable** (must-fix;
   `skill-cli-conformance.test.ts:101-102`). Run `chmod +x` on it and
   `git add --chmod=+x` it.
3. **Task 10: a test whose `test_file` is absolute or carries a drive letter
   leaves its row out** (P3). Vitest rows can hold absolute paths, and one such
   row would otherwise make the whole feed invalid. Extend the `bad` predicate
   with `/^(\/|[A-Za-z]:[\\/])/.test(t.test_file)`, and add an
   `'an absolute test path'` case to the `it.each` whose single test has
   `test_file: '/abs/a.ts'` (name `a`, status `passed`).
4. **Tasks 16/17: the CLI imports at most 5 local modules** (perf coupling;
   phase 1 saw the rule fire at 7). `readJson`, `readRecord` and `gather` move
   from `cli.mjs` into `feed.mjs`, and `feed.mjs` exports
   `gatherInputs(args, notes, now)`. `cli.mjs` then imports only `parse-args`,
   `is-main` and `feed.mjs`. Task 17 edits `feed.mjs` for this. The
   gate-conformance row moves from Task 17 to Task 18, keeping each task to 3
   files. Run `harness check-perf` in Tasks 8, 17 and 20.
5. **Task 8: `onEnd` stays flat** (complexity; `ingest.ts` is a perf entry
   point). `onEnd` keeps the guards (`!cfg`, nothing to do, `await preflight`
   when pushing, the nothing-ran return) and calls
   `private async deliver(result, pushing)`. `deliver` holds the
   `try { buildPayload; emitRunFile; if (!pushing) return; fit; push }` block,
   word for word from the task.
6. **Task 2: the flakiness denominator is the worst test's own** (should-fix).
   The rate divides by that test's `present` count, or its transitions for flips
   (`ts/src/core/flake-signals.ts:76-81`), not by `window.length`. Add
   `denominator: number` to `FlakeSignal` and set it where the rate is computed:
   `tally.present` for `retry-flake`, and the flip computation's own divisor for
   `cross-run flips` (read `isAlternating`'s input to confirm it). The measure
   uses `worst.denominator`. Add a test in which the flaky test is absent from 2
   of 6 runs: `denominator: 4`. A clean window's `denominator: window.length`
   stays.
7. **Task 20: arch allowance** (should-fix). The module-size total is ratcheted
   (`.harness/arch/baselines.json`), and Tasks 1–4 grow `ts/src/core`. Run
   `harness check-arch` against the merge base in a fresh worktree. If it grows,
   **[checkpoint:decision]**: either add
   `.harness/arch/allowances/feat-1151-qa-site-producers.json` (shaped like
   `fix-ingest-reporter-group-a.json` from a60d5b3e) with your sign-off, or pay
   it down. Never raise the baseline.
8. **Task 20: the spec's dogfood line** (proposal.md:262) says
   `canary-starling build`. Change it to the flag form, matching #4 of the
   in-place fixes.
9. **Nits:** `run-record.ts` and the npm tests use double quotes, as `npm/` does
   (Task 7's snippets already do; keep it that way). Exported-but-test-only
   constants (`RUNS_PER_SUITE`, `CI_READY_METRICS`, `RunRecordContext`) are kept
   and measured by entropy in Task 20. If entropy reds, un-export them and
   import the values in tests from the module that uses them. Run `npm ci` in
   `agents/skills` before Task 10.

## Goal

The Playwright reporter can write a valid `canary.run/1` file, and
`canary-starling` composes canary's run history, run files, the katana ledger
and a ci-ready report into a `canary.site/1` `site.json` that always passes
`validate.mjs`.

## Observable Truths (Acceptance Criteria)

1. When two shards of one workflow run finish with `runFile` set, the reporter
   writes two files whose `run.id` values differ (`42-1-s1of2`, `42-1-s2of2`).
   (Crit 5) → Tasks 7, 8
2. When a test ends `timedOut` or `interrupted`, its `canary.run/1` result
   status is `timed_out` or `interrupted` and `totals` counts it in that bucket.
   (Crit 6) → Task 7
3. When the reporter emits, `collected` is the full list; when the run is
   filtered or sharded it is `null`, never `[]`; an empty suite emits `[]`.
   (Crit 7) → Task 7
4. Every file the reporter writes passes
   `validateDocument(doc, {layer: 'run'})`. → Tasks 7, 8
5. If `runFile` is set but no scope is configured, then the reporter shall not
   write a file and shall log a warning naming `CANARY_SCOPE_ID`. → Tasks 6, 8
6. `canary ci-ready --json` checks each carry `measure`; skipped checks carry
   `measure: null`; the report carries an ISO `observed_at`. → Tasks 1–5
7. When `canary-starling` runs with no `--ci-ready`, or with a ci-ready report
   whose inventory checks skipped, each of the five ci-ready metrics is a
   `not-assessed` assessment whose `reason` names the missing input — never
   omitted, never `0`. (Crit 8, planted absence) → Tasks 14, 17
8. When two assessments share `scope.id + scope.env + source + metric`, only the
   one with the latest `observed_at` reaches `site.json`. (Crit 19) → Tasks 15,
   17
9. `site.json` keeps at most 30 runs per `(scope, suite)`, carries per-test
   `results` only on each suite's latest run, and `flaky[]` counts each test
   once with `flaky_runs` / `window_runs`. → Tasks 11, 12
10. `register[]` rows carry no `author`; ledger rows missing a date, commit or
    reason are left out and counted. → Task 13
11. If the composed feed fails validation, then starling shall not write `--out`
    and shall exit 1 printing each error. Under `--strict`, a feed with zero
    runs exits 3. → Tasks 16, 17
12. Four gates pass in `ts/`, `agents/skills/` and `npm/`; entropy, perf, arch
    ratchets pass without raising a baseline. (Crit 15) → every task, final
    check in Task 20

## Uncertainties

- [ASSUMPTION] `measurabilityOf(window) === 'yes'` is the only case in which a
  clean flakiness window is a measured 0. If wrong, Task 2's clean-window test
  changes, nothing else.
- [ASSUMPTION] The perf ratchet tolerates the new `measure` literals in
  `ts/src/core`; the flakiness logic goes in a helper so `scoreCleanWindow`'s
  branch count does not grow. If `check-perf` still reds, split Group 1 into its
  own PR (P6) and pay down before the skill PR.
- [ASSUMPTION] A test that never started (`duration_ms` absent in the ingest
  row) is `duration_ms: 0` in `canary.run/1` (the contract requires a count).
  Documented in the wiki in Task 9.
- [DEFERRABLE] `evidence.tier` is `null` for every ci-ready assessment in v1 —
  ci-ready does not state an evidence tier, and starling must not invent one.
- [DEFERRABLE] Exact stderr wording of starling's sample notes.

## File Map

```text
MODIFY ts/src/core/ci-ready.ts                    CheckMeasure type; flakiness + runtime measures
MODIFY ts/src/core/inventory-checks.ts            skip → null; three inventory measures
MODIFY ts/src/ci-ready-cli.ts                     observed_at on --json
MODIFY ts/test/ci-ready-cli.test.ts               measure + observed_at assertions
MODIFY CHANGELOG.md                               ci-ready JSON fields; reporter runFile
MODIFY npm/src/reporters/ingest/config.ts         runFile, scopeId, scopeEnv
CREATE npm/src/reporters/ingest/run-record.ts     toRunRecord, runFilePath, writeRunFile
MODIFY npm/src/reporters/ingest.ts                onEnd writes the run file
MODIFY npm/scripts/__tests__/ingest-config.test.js
CREATE npm/scripts/__tests__/ingest-run-record.test.js
MODIFY docs/wiki/Ingest-Reporter.md
CREATE agents/skills/claude-code/canary-starling/SKILL.md
CREATE agents/skills/claude-code/canary-starling/scripts/runs.mjs
CREATE agents/skills/claude-code/canary-starling/scripts/flaky.mjs
CREATE agents/skills/claude-code/canary-starling/scripts/register.mjs
CREATE agents/skills/claude-code/canary-starling/scripts/assess.mjs
CREATE agents/skills/claude-code/canary-starling/scripts/feed.mjs
CREATE agents/skills/claude-code/canary-starling/scripts/cli.mjs
CREATE agents/skills/test/canary-starling.test.ts
MODIFY agents/skills/test/gate-conformance.test.ts
MODIFY agents/skills/README.md
MODIFY agents/skills/package.json                 format:check glob
MODIFY agents/skills/vitest.config.ts             coverage include
MODIFY harness.config.json                        cli.mjs in both entryPoints arrays
MODIFY docs/naming-registry.md                    canary-starling → shipped
MODIFY AGENTS.md                                  skills section
MODIFY docs/roadmap.md                            #1151 row: phase 2 landed
```

## Skeleton (approved 2026-10-06)

1. ci-ready exposes its numbers — Tasks 1–5
2. Reporter emits `canary.run/1` — Tasks 6–9
3. Starling readers — Tasks 10–13
4. Starling assessments — Tasks 14–15
5. Starling feed and CLI — Tasks 16–17
6. Integration — Tasks 18–20

Parallel waves (file-overlap corrected by the soundness review): 1→2→3→4→5 (one
test file) and 6→7→8 run alongside 10→11→12→13 (one test file). 9 follows 5 and
8 (`CHANGELOG.md`). 14 follows 5 and 13; then 15→16→17→18→ 19→20.

## Tasks

### Task 1: `CheckMeasure` on every ci-ready check (null everywhere first)

**Depends on:** none | **Files:** `ts/src/core/ci-ready.ts`,
`ts/src/core/inventory-checks.ts`, `ts/test/ci-ready-cli.test.ts` | **Owns:**
`ts/src/core/ci-ready.ts`

1. In `ts/test/ci-ready-cli.test.ts`, extend the local types and the abstain
   test:

   ```ts
   interface Measure {
     value: number;
     unit: 'ratio' | 'count' | 'ms';
     denominator: number;
   }
   interface Check {
     name: string;
     verdict: 'pass' | 'warn' | 'fail' | 'skip';
     reason: string;
     measure: Measure | null;
   }
   ```

   and inside `it('abstains with exit 3 when no input exists…')` after the
   `every(skip)` assertion:

   ```ts
   // A skipped check measured nothing: null, never 0 (#1151 phase 2, P1).
   expect(report.checks.map((c) => c.measure)).toEqual([
     null,
     null,
     null,
     null,
     null,
   ]);
   ```

2. Run `cd ts && npx vitest run test/ci-ready-cli.test.ts` — observe the new
   assertion fail (`measure` is undefined).
3. In `ts/src/core/ci-ready.ts`, add above `CiCheck`:

   ```ts
   /**
    * The number a check scored, in a form a feed can carry without parsing the
    * prose `reason` (#1151 phase 2, P1). `null` when the check measured
    * nothing: a skip, a window too thin to judge, or a zero the reader could
    * not have observed. Null is never 0.
    */
   export interface CheckMeasure {
     value: number;
     unit: 'ratio' | 'count' | 'ms';
     denominator: number;
   }
   ```

   add `measure: CheckMeasure | null;` as the last field of `CiCheck`, and add
   `measure: null` to every object literal returning a `CiCheck` in
   `ci-ready.ts` (both returns of `scoreCleanWindow`, `unreadableSkip`, both
   returns of `scoreFlakiness`, both of `scoreRuntime`) and in
   `inventory-checks.ts` (`skip`, and the final return of `scoreCoverageDepth`,
   `scoreAssertionQuality`, `scoreCriticalPaths`). Tasks 2–4 replace the
   non-skip nulls.

4. Run
   `cd ts && npm run -s typecheck && npx vitest run test/ci-ready-cli.test.ts test/inventory-checks.test.ts`
   — observe pass.
5. Run: `harness validate`
6. Commit:
   `feat(ci-ready): carry a measure field on every check, null when unmeasured`

### Task 2: flakiness measure

**Depends on:** Task 1 | **Files:** `ts/src/core/ci-ready.ts`,
`ts/test/ci-ready-cli.test.ts`

1. In the test file, give `writeHistory` a fifth parameter `format?: string` and
   spread `...(format ? { reporter_format: format } : {})` into each record. Add
   tests:

   ```ts
   describe('flakiness measure (#1151 phase 2)', () => {
     it('measures the worst flake rate against the window', async () => {
       writeHistory(root, 5, [2]);
       const m = check((await runJson(root)).report, 'flakiness').measure;
       expect(m?.unit).toBe('ratio');
       expect(m?.value).toBeCloseTo(0.2);
       expect(m?.denominator).toBe(5);
     });

     it('carries a measured 0 only when retry flakes were observable', async () => {
       writeHistory(root, 10, [], [], 'playwright');
       expect(check((await runJson(root)).report, 'flakiness').measure).toEqual(
         { value: 0, unit: 'ratio', denominator: 10 },
       );
     });

     it('carries null for a structural or unknown zero, and for a thin window', async () => {
       writeHistory(root, 10, [], [], 'vitest');
       expect(
         check((await runJson(root)).report, 'flakiness').measure,
       ).toBeNull();
       writeHistory(root, 10); // unstamped: unknown
       expect(
         check((await runJson(root)).report, 'flakiness').measure,
       ).toBeNull();
       writeHistory(root, 5, [], [], 'playwright'); // thin
       expect(
         check((await runJson(root)).report, 'flakiness').measure,
       ).toBeNull();
     });
   });
   ```

2. Run `cd ts && npx vitest run test/ci-ready-cli.test.ts` — observe failures.
3. In `ci-ready.ts`, add after `measurabilitySuffix`:

   ```ts
   /** A clean window's 0 is a measurement only when a flake was observable. */
   function cleanMeasure(window: ScoredRun[]): CheckMeasure | null {
     if (measurabilityOf(window) !== 'yes') return null;
     return { value: 0, unit: 'ratio', denominator: window.length };
   }
   ```

   In `scoreCleanWindow`'s passing return set `measure: cleanMeasure(window)`
   (the thin-window return keeps `null`). In `scoreFlakiness`'s final return set
   `measure: { value: worst.rate, unit: 'ratio', denominator: window.length }`.

4. Run the test file — observe pass. Run `cd ts && npm run -s typecheck`.
5. Run: `harness validate`
6. Commit: `feat(ci-ready): measure flakiness as the worst rate over the window`

### Task 3: suite-runtime measure

**Depends on:** Task 2 | **Files:** `ts/src/core/ci-ready.ts`,
`ts/test/ci-ready-cli.test.ts`

1. Add inside `describe('suite runtime …')`:

   ```ts
   it('measures the p95 in ms against the runs that carry a duration', async () => {
     writeHistory(root, 3, [], [1000, 2000, 3000]);
     expect(
       check((await runJson(root)).report, 'suite-runtime').measure,
     ).toEqual({ value: 3000, unit: 'ms', denominator: 3 });
   });
   ```

2. Run the test file — observe failure.
3. In `scoreRuntime`'s final return set
   `measure: { value: p95, unit: 'ms', denominator: durations.length }`.
4. Run the test file — observe pass.
5. Run: `harness validate`
6. Commit: `feat(ci-ready): measure suite runtime as p95 ms`

### Task 4: inventory-check measures

**Depends on:** Task 3 | **Files:** `ts/src/core/inventory-checks.ts`,
`ts/test/ci-ready-cli.test.ts`

1. In `it('scores the three inventory checks once \`canary inventory\` has
   run')`, after the verdict loop add:

   ```ts
   for (const name of [
     'coverage-depth',
     'assertion-quality',
     'critical-paths',
   ]) {
     expect(check(report, name).measure).toEqual({
       value: 0,
       unit: 'count',
       denominator: 1,
     });
   }
   ```

2. Run the test file — observe failure.
3. In `inventory-checks.ts` set the final returns' measures:
   - `scoreCoverageDepth`:
     `measure: { value: at0, unit: 'count', denominator: paths.length }`
   - `scoreAssertionQuality`:
     `measure: { value: weak, unit: 'count', denominator: tests.length }`
   - `scoreCriticalPaths`: `measure` with `value: uncovered.length`,
     `unit: 'count'`, `denominator: top.length`

   Import `type CheckMeasure` is not needed (inferred from `CiCheck`).

4. Run
   `cd ts && npx vitest run test/ci-ready-cli.test.ts test/inventory-checks.test.ts`
   — observe pass.
5. Run: `harness validate`
6. Commit:
   `feat(ci-ready): measure the inventory checks as counts with denominators`

### Task 5: `observed_at` on `ci-ready --json`, and the changelog

**Depends on:** Tasks 3, 4 | **Files:** `ts/src/ci-ready-cli.ts`,
`ts/test/ci-ready-cli.test.ts`, `CHANGELOG.md`

1. Add `observed_at?: string` to the test's `Report` interface and a test:

   ```ts
   it('stamps --json with when the checks ran (#1151 phase 2)', async () => {
     const before = Date.now();
     const { report } = await runJson(root);
     const at = Date.parse(report.observed_at ?? '');
     expect(report.observed_at).toMatch(
       /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
     );
     expect(at).toBeGreaterThanOrEqual(before);
     expect(at).toBeLessThanOrEqual(Date.now());
   });
   ```

2. Run the test file — observe failure.
3. In `ci-ready-cli.ts` replace the JSON branch with:

   ```ts
   if (opts.json === true) {
     // When the checks ran, so a feed can order reports (#1151 phase 2).
     const stamped = { observed_at: new Date().toISOString(), ...report };
     deps.out(JSON.stringify(stamped, null, 2));
   } else {
   ```

4. Run the test file — observe pass. Run
   `cd ts && npm run -s build && npm run -s typecheck && npm run -s format:check`.
5. Under `## [Unreleased]` → `### Added` in `CHANGELOG.md` (create the
   subsection if absent):

   ```markdown
   - **`canary ci-ready --json` carries its numbers.** Each check gains
     `measure: {value, unit, denominator}` (`null` when the check measured
     nothing — a skip, a window under 10 runs, or a flake zero the reader could
     not observe) and the report gains `observed_at`. Text output is unchanged
     (#1151).
   ```

6. Run: `harness validate`; also `harness check-perf` and confirm no new
   violation versus `main` (if red, stop and apply P6).
7. Commit: `feat(ci-ready): stamp --json with observed_at`

### Task 6: reporter config — `runFile`, `scopeId`, `scopeEnv`

**Depends on:** none | **Files:** `npm/src/reporters/ingest/config.ts`,
`npm/scripts/__tests__/ingest-config.test.js` | **Owns:**
`npm/src/reporters/ingest/config.ts`

1. Append to `ingest-config.test.js`:

   ```js
   // --- #1151 phase 2: canary.run/1 file + explicit scope (P2, P4) -------------
   test('runFile and scope resolve from options', () => {
     const cfg = resolveConfig(
       {
         suite: 'web',
         runFile: 'out/run.json',
         scopeId: 'web-app',
         scopeEnv: 'staging',
       },
       {},
     );
     assert.equal(cfg.runFile, 'out/run.json');
     assert.deepEqual(cfg.scope, { id: 'web-app', env: 'staging' });
   });

   test('runFile and scope resolve from env, env falling back to an explicit environment', () => {
     const cfg = resolveConfig(
       { suite: 'web' },
       {
         CANARY_RUN_FILE: 'r.json',
         CANARY_SCOPE_ID: 'web-app',
         CANARY_INGEST_ENVIRONMENT: 'prod',
       },
     );
     assert.equal(cfg.runFile, 'r.json');
     assert.deepEqual(cfg.scope, { id: 'web-app', env: 'prod' });
   });

   test('an incomplete scope with runFile set is null and warns — scope is never inferred', () => {
     const cfg = resolveConfig(
       { suite: 'web', runFile: 'r.json', scopeId: 'web-app' },
       {},
     );
     assert.equal(cfg.scope, null);
     assert.match(
       cfg.configWarnings.join('\n'),
       /CANARY_SCOPE_ID.*CANARY_SCOPE_ENV/,
     );
   });

   test('no runFile: runFile null and no scope warning', () => {
     const cfg = resolveConfig({ suite: 'web' }, {});
     assert.equal(cfg.runFile, null);
     assert.equal(cfg.configWarnings.length, 0);
   });
   ```

2. Run
   `cd npm && npx tsc && node --test scripts/__tests__/ingest-config.test.js` —
   observe failures.
3. In `config.ts`:
   - `IngestReporterOptions` gains:

     ```ts
     /** Also write the run as a `canary.run/1` file here (#1151). Off by default. */
     runFile?: string;
     /** `canary.run/1` scope id. Required with `runFile`; never inferred (D2). */
     scopeId?: string;
     /** `canary.run/1` scope env. Falls back to an explicit `environment`. */
     scopeEnv?: string;
     ```

   - `ResolvedConfig` gains `runFile: string | null;` and
     `scope: { id: string; env: string } | null;`
   - `ENV_NAMES` gains `runFile: ["CANARY_RUN_FILE"]`,
     `scopeId: ["CANARY_SCOPE_ID"]`, `scopeEnv: ["CANARY_SCOPE_ENV"]`.
   - In `resolveConfig`, compute before the return:

     ```ts
     const environment = opts.environment ?? read('environment');
     const runFile = opts.runFile ?? read('runFile') ?? null;
     const scope = resolveScope(
       opts.scopeId ?? read('scopeId'),
       opts.scopeEnv ?? read('scopeEnv') ?? environment,
       runFile,
       configWarnings,
     );
     ```

     use `environment` in the returned object, and add `runFile, scope`.

   - Add below `resolveConfig`:

     ```ts
     /** Both halves or nothing: a guessed scope is how a run lands in the wrong place (D2). */
     function resolveScope(
       id: string | undefined,
       env: string | undefined,
       runFile: string | null,
       warnings: string[],
     ): { id: string; env: string } | null {
       if (id && env) return { id, env };
       if (runFile)
         warnings.push(
           'runFile is set but scope is incomplete; set scopeId/CANARY_SCOPE_ID and scopeEnv/CANARY_SCOPE_ENV. No canary.run/1 file will be written.',
         );
       return null;
     }
     ```

4. Run the test — observe pass. Run `cd npm && npm test` (all reporter tests
   still pass: the payload is unchanged).
5. Run: `harness validate`
6. Commit: `feat(reporter): runFile and explicit scope options for canary.run/1`

### Task 7: `toRunRecord` — the payload as `canary.run/1`

**Depends on:** none | **Files:** `npm/src/reporters/ingest/run-record.ts`,
`npm/scripts/__tests__/ingest-run-record.test.js` | **Owns:**
`npm/src/reporters/ingest/run-record.ts`

1. Create `npm/scripts/__tests__/ingest-run-record.test.js`:

   ```js
   const test = require('node:test');
   const assert = require('node:assert/strict');
   const path = require('node:path');
   const { pathToFileURL } = require('node:url');
   const { reporterModule, CI_ENV, T } = require('./ingest-harness.js');
   const {
     toRunRecord,
     runFilePath,
   } = require('../../dist/reporters/ingest/run-record.js');
   const { buildPayload, resolveConfig } = reporterModule;

   const VALIDATE = pathToFileURL(
     path.resolve(
       __dirname,
       '../../../agents/skills/lib/contracts/validate.mjs',
     ),
   ).href;
   const SCOPE = { id: 'web-app', env: 'staging' };
   const cfg = resolveConfig({ suite: 'web' }, {});
   const row = (title, status, extra = {}) => ({
     full_title: title,
     test_file: 'tests/a.spec.ts',
     status,
     retries: 0,
     tags: [],
     duration_ms: 5,
     ...extra,
   });
   const record = (
     results,
     { shard = null, collected, full = 'passed', env = CI_ENV } = {},
   ) =>
     toRunRecord(
       buildPayload(results, cfg, T, env, full, { shard, collected }),
       { scope: SCOPE, shard, fullResultStatus: full, env, version: '9.0.0' },
     );

   async function refusals(doc) {
     const { validateDocument } = await import(VALIDATE);
     return validateDocument(doc, { layer: 'run' }).errors;
   }

   test('crit 5: shards of one workflow run get distinct run ids', () => {
     const a = record([row('a', 'passed')], {
       shard: { current: 1, total: 2 },
     });
     const b = record([row('a', 'passed')], {
       shard: { current: 2, total: 2 },
     });
     assert.equal(a.run.id, '42-1-s1of2');
     assert.equal(b.run.id, '42-1-s2of2');
     assert.deepEqual(b.run.shard, { index: 2, total: 2 });
   });

   test('crit 6: timed_out and interrupted keep their own status and bucket', () => {
     const r = record([
       row('t', 'timed_out'),
       row('i', 'failed', { tags: ['interrupted'] }),
       row('f', 'failed'),
     ]);
     assert.deepEqual(
       r.results.map((x) => x.status),
       ['timed_out', 'interrupted', 'failed'],
     );
     assert.equal(r.totals.timed_out, 1);
     assert.equal(r.totals.interrupted, 1);
     assert.equal(r.totals.failed, 1);
   });

   test('crit 7: collected is the list, [] for an empty suite, null when not reported', () => {
     assert.deepEqual(
       record([row('a', 'passed')], {
         collected: [
           { full_title: 'a', test_file: 'tests/a.spec.ts', tags: [] },
         ],
       }).collected,
       [{ title: 'a', file: 'tests/a.spec.ts' }],
     );
     assert.deepEqual(record([], { collected: [] }).collected, []);
     assert.equal(
       record([row('a', 'passed')], { collected: null }).collected,
       null,
     );
   });

   test('run status: flaky is passed, interrupted and timedout runs are cancelled', () => {
     assert.equal(record([row('a', 'flaky')]).run.status, 'passed');
     assert.equal(
       record([row('a', 'passed')], { full: 'interrupted' }).run.status,
       'cancelled',
     );
     assert.equal(
       record([row('a', 'passed')], { full: 'timedout' }).run.status,
       'cancelled',
     );
     assert.equal(
       record([row('a', 'failed')], { full: 'failed' }).run.status,
       'failed',
     );
   });

   test('no invented values: unknown branch, sha and CI url are null; a never-started test is 0 ms', () => {
     const r = record([row('a', 'skipped', { duration_ms: undefined })], {
       env: {},
     });
     assert.equal(r.run.branch, null);
     assert.equal(r.run.commit_sha, null);
     assert.equal(r.run.ci_url, null);
     assert.equal(r.results[0].duration_ms, 0);
     assert.equal(r.producer.channel, 'local');
   });

   test('every emitted record passes the run contract', async () => {
     const env = {
       ...CI_ENV,
       CI: 'true',
       GITHUB_REF_NAME: 'main',
       GITHUB_SHA: 'abc1234def',
       GITHUB_SERVER_URL: 'https://github.com',
       GITHUB_REPOSITORY: 'o/r',
     };
     const r = record(
       [
         row('a', 'failed', { error_message: 'boom', area: 'cart' }),
         row('b', 'timed_out'),
       ],
       { shard: { current: 1, total: 2 }, env, full: 'failed' },
     );
     assert.deepEqual(await refusals(r), []);
     assert.equal(r.run.ci_url, 'https://github.com/o/r/actions/runs/42');
   });

   test('runFilePath suffixes a sharded run before the extension', () => {
     assert.equal(runFilePath('out/run.json', null), 'out/run.json');
     assert.equal(
       runFilePath('out/run.json', { current: 2, total: 4 }),
       'out/run-s2of4.json',
     );
     assert.equal(
       runFilePath('out/run', { current: 1, total: 2 }),
       'out/run-s1of2',
     );
   });
   ```

2. Run
   `cd npm && npx tsc; node --test scripts/__tests__/ingest-run-record.test.js`
   — observe failure (module missing).
3. Create `npm/src/reporters/ingest/run-record.ts`:

   ```ts
   // Ingest reporter: the run as a `canary.run/1` record (#1151 phase 2).
   //
   // Built FROM the ingest payload, so the shard-aware id (#1148), the deduped
   // rows and the run timing are the ones the dashboard receives. The payload
   // itself is unchanged; this is a second, contract-shaped view of it.
   import fs from 'node:fs';
   import path from 'node:path';
   import type { IngestPayload, ResultEntry, Shard } from './payload.js';

   export interface RunRecordContext {
     scope: { id: string; env: string };
     shard: Shard;
     /** Playwright's `FullResult.status`. */
     fullResultStatus?: string;
     env: NodeJS.ProcessEnv;
     version: string;
   }

   const SHA = /^[0-9a-f]{7,64}$/;

   export function toRunRecord(payload: IngestPayload, ctx: RunRecordContext) {
     const results = payload.results.map(toResult);
     const count = (s: string) => results.filter((r) => r.status === s).length;
     const shard =
       ctx.shard && ctx.shard.total > 1
         ? { index: ctx.shard.current, total: ctx.shard.total }
         : null;
     return {
       contract: 'canary.run/1',
       scope: ctx.scope,
       producer: {
         name: 'canary-test-cli/reporter',
         version: ctx.version,
         channel: isCI(ctx.env) ? 'ci' : 'local',
       },
       run: {
         id: payload.canary_run_id,
         suite: payload.suite,
         branch: ctx.env.GITHUB_REF_NAME || null,
         commit_sha:
           payload.commit_sha && SHA.test(payload.commit_sha)
             ? payload.commit_sha
             : null,
         started_at: payload.started_at,
         finished_at: payload.finished_at,
         ci_url: ciUrl(ctx.env),
         status: contractStatus(payload.status, ctx.fullResultStatus),
         shard,
       },
       totals: {
         passed: count('passed'),
         failed: count('failed'),
         flaky: count('flaky'),
         skipped: count('skipped'),
         timed_out: count('timed_out'),
         interrupted: count('interrupted'),
         total: results.length,
       },
       results,
       // Omitted from the payload = not reported = null; `[]` stays a measured zero.
       collected: payload.collected
         ? payload.collected.map((c) => ({
             title: c.full_title,
             file: c.test_file,
           }))
         : null,
     };
   }

   /** The contract has no run-level `flaky`, and a run that did not finish is `cancelled`. */
   function contractStatus(
     ingest: IngestPayload['status'],
     full?: string,
   ): 'passed' | 'failed' | 'cancelled' {
     if (ingest === 'cancelled' || full === 'timedout') return 'cancelled';
     return ingest === 'failed' ? 'failed' : 'passed';
   }

   /** Ingest sends an interrupted test as `failed` + an `interrupted` tag (#1149); the contract has its own status. */
   function toResult(r: ResultEntry) {
     const hasError =
       r.error_message !== undefined || r.error_stack !== undefined;
     return {
       title: r.full_title,
       file: r.test_file,
       status: r.tags.includes('interrupted') ? 'interrupted' : r.status,
       // Absent only for a test that never started (Playwright reports -1).
       duration_ms: r.duration_ms ?? 0,
       retries: r.retries,
       area: r.area ?? null,
       tags: r.tags,
       error: hasError
         ? { message: r.error_message ?? '', stack: r.error_stack ?? null }
         : null,
     };
   }

   function isCI(env: NodeJS.ProcessEnv): boolean {
     return env.CI === 'true' || env.GITHUB_ACTIONS === 'true';
   }

   function ciUrl(env: NodeJS.ProcessEnv): string | null {
     const {
       GITHUB_SERVER_URL: server,
       GITHUB_REPOSITORY: repo,
       GITHUB_RUN_ID: id,
     } = env;
     return server && repo && id
       ? `${server}/${repo}/actions/runs/${id}`
       : null;
   }

   /** One file per shard: `run.json` → `run-s2of4.json`, so shards never overwrite each other. */
   export function runFilePath(file: string, shard: Shard): string {
     if (!shard || shard.total <= 1) return file;
     const ext = path.extname(file);
     return `${file.slice(0, file.length - ext.length)}-s${shard.current}of${shard.total}${ext}`;
   }

   export function writeRunFile(
     file: string,
     record: ReturnType<typeof toRunRecord>,
   ): void {
     fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
     fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n', 'utf8');
   }

   /** This package's version, for `producer.version`. */
   export function packageVersion(): string {
     try {
       return (require('../../../package.json') as { version: string }).version;
     } catch {
       return 'unknown';
     }
   }
   ```

4. Run the test — observe pass. Run `cd npm && npm test`.
5. Run: `harness validate`
6. Commit: `feat(reporter): map the ingest payload to a canary.run/1 record`

### Task 8: write the run file from `onEnd`

**Depends on:** Tasks 6, 7 | **Files:** `npm/src/reporters/ingest.ts`,
`npm/scripts/__tests__/ingest-run-record.test.js`

1. Append to `ingest-run-record.test.js`:

   ```js
   const fs = require('node:fs');
   const os = require('node:os');
   const { fakeTest, fakeResult, runReporter } = require('./ingest-harness.js');

   function tmp() {
     return fs.mkdtempSync(path.join(os.tmpdir(), 'canary-run-'));
   }
   const scopeOpts = (dir) => ({
     runFile: path.join(dir, 'run.json'),
     scopeId: 'web-app',
     scopeEnv: 'staging',
   });

   test('onEnd writes a valid canary.run/1 file even when not pushing', async () => {
     const dir = tmp();
     const t = fakeTest({ title: 'a' });
     const { pushes } = await runReporter({
       options: { ...scopeOpts(dir), url: '' },
       tests: [[t, fakeResult('passed')]],
     });
     assert.equal(pushes.length, 0);
     const doc = JSON.parse(
       fs.readFileSync(path.join(dir, 'run.json'), 'utf8'),
     );
     assert.deepEqual(await refusals(doc), []);
     assert.equal(doc.results[0].status, 'passed');
   });

   test('crit 5 end to end: two shards write two files with distinct run ids', async () => {
     const dir = tmp();
     const t = fakeTest({ title: 'a' });
     for (const current of [1, 2]) {
       await runReporter({
         options: scopeOpts(dir),
         env: CI_ENV,
         config: { shard: { current, total: 2 }, projects: [] },
         tests: [[t, fakeResult('passed')]],
       });
     }
     const ids = ['run-s1of2.json', 'run-s2of2.json'].map(
       (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).run.id,
     );
     assert.deepEqual(ids, ['42-1-s1of2', '42-1-s2of2']);
   });

   test('runFile without a scope writes nothing and says why', async () => {
     const dir = tmp();
     const t = fakeTest({ title: 'a' });
     const { logs } = await runReporter({
       options: { runFile: path.join(dir, 'run.json') },
       tests: [[t, fakeResult('passed')]],
     });
     assert.equal(fs.existsSync(path.join(dir, 'run.json')), false);
     assert.match(logs.join('\n'), /CANARY_SCOPE_ID/);
   });

   test('the ingest payload is unchanged by runFile', async () => {
     const t = fakeTest({ title: 'a' });
     // CI_ENV pins canary_run_id; without GITHUB_RUN_ID it is a random UUID per run.
     const without = (
       await runReporter({ env: CI_ENV, tests: [[t, fakeResult('passed')]] })
     ).payload;
     const withFile = (
       await runReporter({
         env: CI_ENV,
         options: scopeOpts(tmp()),
         tests: [[t, fakeResult('passed')]],
       })
     ).payload;
     assert.deepEqual(withFile, without);
   });
   ```

2. Run
   `cd npm && npx tsc && node --test scripts/__tests__/ingest-run-record.test.js`
   — observe failures.
3. In `ingest.ts`, import
   `{ toRunRecord, runFilePath, writeRunFile, packageVersion } from "./ingest/run-record.js"`
   and replace `onEnd` with:

   ```ts
   async onEnd(result: FullResult) {
     if (!this.cfg) return;
     const pushing = shouldPush(this.cfg);
     if (!pushing && !this.cfg.runFile) return;
     if (pushing) await this.preflight;
     if (this.results.size === 0 && this.collectedCount > 0) {
       // `playwright test --list` and fully-filtered runs: a green run in which
       // nothing ran would read as real coverage.
       log("no test ran (list mode or everything filtered out); nothing pushed or written.");
       return;
     }
     try {
       const raw = buildPayload(
         [...this.results.values()],
         this.cfg,
         runTiming(result, this.startTime, Date.now()),
         process.env,
         result?.status,
         { shard: this.shard, collected: this.collected },
       );
       this.emitRunFile(raw, result?.status);
       if (!pushing) return;
       const { payload, warnings } = fitPayload(raw);
       for (const w of warnings) warn(w);
       await push(this.cfg, payload);
     } catch (err) {
       warn(`push error — ${errText(err)}; run not ingested.`);
     }
   }

   /** The `canary.run/1` file (#1151). Its failure never costs the push. */
   private emitRunFile(payload: IngestPayload, fullResultStatus: string | undefined): void {
     const { runFile, scope } = this.cfg ?? {};
     if (!runFile || !scope) return;
     try {
       const file = runFilePath(runFile, this.shard);
       const record = toRunRecord(payload, { scope, shard: this.shard, fullResultStatus, env: process.env, version: packageVersion() });
       writeRunFile(file, record);
       log(`wrote canary.run/1 to ${file}.`);
     } catch (err) {
       warn(`canary.run/1 not written — ${errText(err)}`);
     }
   }
   ```

   and add `IngestPayload` to the `import type … from "./ingest/payload.js"`
   line. The scope warning from Task 6 already reaches the log through
   `initConfig`'s `configWarnings` loop.

4. Run the test — observe pass. Run `cd npm && npm test`.
5. Run: `harness validate`
6. Commit: `feat(reporter): write canary.run/1 from onEnd when runFile is set`

### Task 9: document the run file

**Depends on:** Tasks 5, 8 | **Files:** `docs/wiki/Ingest-Reporter.md`,
`CHANGELOG.md` | **Category:** integration

1. In `docs/wiki/Ingest-Reporter.md` → `### Options` table add rows for
   `runFile` (`CANARY_RUN_FILE`), `scopeId` (`CANARY_SCOPE_ID`), `scopeEnv`
   (`CANARY_SCOPE_ENV`, falls back to `environment`), matching the table's
   columns (option | env | legacy env `—` | default `(unset)` | meaning).
2. Add a section before `## Source`:

   ```markdown
   ## The `canary.run/1` file

   With `runFile` set, the reporter also writes the run as a
   [`canary.run/1`](../specs/canary-run-contract.md) record — whether or not it
   pushes. A sharded run writes one file per shard (`run.json` →
   `run-s2of4.json`), with the same shard-aware `run.id` the ingest payload
   carries. `scopeId` and `scopeEnv` are required: scope is never inferred, so
   with either missing the reporter writes nothing and warns once. The ingest
   payload is unchanged.

   | Ingest row                           | `canary.run/1`                                  |
   | ------------------------------------ | ----------------------------------------------- |
   | `status: failed` + `interrupted` tag | `status: interrupted`                           |
   | `status: timed_out`                  | `status: timed_out`                             |
   | no `duration_ms` (never started)     | `duration_ms: 0`                                |
   | run `flaky`                          | run `passed`, `totals.flaky > 0`                |
   | run `timedout` / `interrupted`       | run `cancelled`                                 |
   | `collected` omitted / `[]` / list    | `collected: null` / `[]` / `{title, file}` list |

   Validate a file with
   `node agents/skills/lib/contracts/validate.mjs --layer run run.json`.
   ```

3. Under `## [Unreleased]` → `### Added` in `CHANGELOG.md`:

   ```markdown
   - **The ingest reporter can write a `canary.run/1` file.** Set `runFile`
     (`CANARY_RUN_FILE`) with `scopeId`/`scopeEnv`; sharded runs write one file
     per shard. Off by default; the ingest payload is unchanged (#1151).
   ```

4. Run
   `cd ts && npx prettier --write ../docs/wiki/Ingest-Reporter.md ../CHANGELOG.md`
   and `npx --yes markdownlint-cli2 docs/wiki/Ingest-Reporter.md CHANGELOG.md`
   from the root.
5. Run: `harness validate`
6. Commit: `docs(reporter): the canary.run/1 run file`

### Task 10: starling — one history row as `canary.run/1`

**Depends on:** none | **Files:**
`agents/skills/claude-code/canary-starling/scripts/runs.mjs`,
`agents/skills/test/canary-starling.test.ts` | **Owns:**
`agents/skills/claude-code/canary-starling/**`

1. Create `agents/skills/test/canary-starling.test.ts`:

   ```ts
   import { describe, expect, it } from 'vitest';
   import { historyToRun } from '../claude-code/canary-starling/scripts/runs.mjs';
   import { validateDocument } from '../lib/contracts/validate.mjs';

   const SCOPE = { id: 'canary', env: 'ci' };

   const historyRow = (over: Record<string, unknown> = {}) => ({
     run_id: 'r1',
     suite: 'ts-engine',
     branch: 'main',
     commit_sha: 'abc1234',
     timestamp: '2026-10-06T10:00:00Z',
     duration_ms: 60000,
     total: 2,
     passed: 1,
     failed: 1,
     flaky: 0,
     skipped: 0,
     schema_version: 3,
     tests: [
       { test_name: 'a', test_file: 'test/a.test.ts', status: 'passed' },
       {
         test_name: 'b',
         test_file: 'test/b.test.ts',
         status: 'failed',
         error_text: 'boom',
       },
     ],
     ...over,
   });

   describe('historyToRun (assumption C)', () => {
     it('derives started_at from timestamp minus duration and validates', () => {
       const { run } = historyToRun(historyRow(), SCOPE);
       expect(run.run.finished_at).toBe('2026-10-06T10:00:00Z');
       expect(run.run.started_at).toBe('2026-10-06T09:59:00.000Z');
       expect(run.run.status).toBe('failed');
       expect(run.results.map((r: { status: string }) => r.status)).toEqual([
         'passed',
         'failed',
       ]);
       expect(validateDocument(run, { layer: 'run' }).errors).toEqual([]);
     });

     it.each([
       ['no timestamp', { timestamp: undefined }],
       ['no duration', { duration_ms: null }],
       [
         'an unknown test status',
         { tests: [{ test_name: 'a', test_file: 'a.ts', status: 'todo' }] },
       ],
     ])('leaves out a row with %s, naming why', (_why, over) => {
       const out = historyToRun(historyRow(over), SCOPE);
       expect(out.run).toBeNull();
       expect(out.skipped).toMatch(/r1/);
     });

     it('carries results null, totals from the counts, for a count-only row', () => {
       const { run } = historyToRun(historyRow({ tests: undefined }), SCOPE);
       expect(run.results).toBeNull();
       expect(run.totals).toEqual({
         passed: 1,
         failed: 1,
         flaky: 0,
         skipped: 0,
         timed_out: 0,
         interrupted: 0,
         total: 2,
       });
       expect(validateDocument(run, { layer: 'run' }).errors).toEqual([]);
     });
   });
   ```

2. Run `cd agents/skills && npx vitest run test/canary-starling.test.ts` —
   observe failure.
3. Create `agents/skills/claude-code/canary-starling/scripts/runs.mjs`:

   ```js
   // runs -- run-history rows and canary.run/1 files as one list of run records.
   //
   // A history row has no start time, no scope and no producer. Scope comes
   // from the caller (D2: never inferred); started_at is timestamp minus
   // duration_ms, and a row without both is LEFT OUT and named -- an invented
   // time is a lie the contract cannot detect (#1151 phase 2, P3).

   const TIMESTAMP =
     /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
   const SHA = /^[0-9a-f]{7,64}$/;
   /** The only per-test statuses the history readers write. */
   const STATUSES = ['passed', 'failed', 'flaky', 'skipped'];

   const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);

   function toResult(t) {
     return {
       title: t.test_name,
       file: t.test_file,
       status: t.status,
       duration_ms: count(t.duration_ms),
       retries: count(t.retry_count),
       area: t.area ?? null,
       tags: [],
       error: t.error_text ? { message: t.error_text, stack: null } : null,
     };
   }

   function results(row) {
     if (!Array.isArray(row.tests)) return { list: null };
     const bad = row.tests.find(
       (t) => !STATUSES.includes(t.status) || !t.test_file || !t.test_name,
     );
     if (bad)
       return {
         error: `a test with status ${JSON.stringify(bad.status)} or no file/name`,
       };
     return { list: row.tests.map(toResult) };
   }

   function totals(row, list) {
     const n = (s) =>
       list ? list.filter((r) => r.status === s).length : count(row[s]);
     const t = {
       passed: n('passed'),
       failed: n('failed'),
       flaky: n('flaky'),
       skipped: n('skipped'),
       timed_out: 0,
       interrupted: 0,
     };
     return { ...t, total: t.passed + t.failed + t.flaky + t.skipped };
   }

   // {run, skipped: null} on success; {run: null, skipped: reason} when left out.
   // (No JSDoc @returns: allowJs would type `run` as object|null and break typecheck.)
   export function historyToRun(row, scope) {
     const why = (reason) => ({
       run: null,
       skipped: `history run ${row.run_id}: ${reason}`,
     });
     if (typeof row.timestamp !== 'string' || !TIMESTAMP.test(row.timestamp))
       return why('no ISO timestamp');
     if (!(typeof row.duration_ms === 'number' && row.duration_ms > 0))
       return why('no duration_ms, so no start time');
     const res = results(row);
     if (res.error) return why(res.error);
     const t = totals(row, res.list);
     return {
       skipped: null,
       run: {
         contract: 'canary.run/1',
         scope,
         producer: {
           name: 'canary-history',
           version: String(row.schema_version ?? 2),
           channel: 'history-store',
         },
         run: {
           id: row.run_id,
           suite: row.suite,
           branch: row.branch || null,
           commit_sha: SHA.test(row.commit_sha ?? '') ? row.commit_sha : null,
           started_at: new Date(
             Date.parse(row.timestamp) - row.duration_ms,
           ).toISOString(),
           finished_at: row.timestamp,
           ci_url: null,
           status: t.failed > 0 ? 'failed' : 'passed',
           shard: null,
         },
         totals: t,
         results: res.list,
         collected: null,
       },
     };
   }
   ```

4. Run the test — observe pass. Run
   `cd agents/skills && npx prettier --write claude-code/canary-starling test/canary-starling.test.ts`.
5. Run: `harness validate`
6. Commit: `feat(starling): convert a run-history row to canary.run/1`

### Task 11: starling — select runs (30 per suite, results on the latest only)

**Depends on:** Task 10 | **Files:** `…/canary-starling/scripts/runs.mjs`,
`agents/skills/test/canary-starling.test.ts`

1. Append a `describe('selectRuns', …)` block importing `selectRuns` and
   `RUNS_PER_SUITE`:

   ```ts
   describe('selectRuns (D15)', () => {
     const runAt = (i: number, suite = 'ts-engine') =>
       historyToRun(
         historyRow({
           run_id: `r${i}`,
           suite,
           timestamp: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
         }),
         SCOPE,
       ).run;

     it('keeps the newest 30 per suite, results only on the newest', () => {
       const all = [...Array(35).keys()]
         .map((i) => runAt(i))
         .concat(runAt(0, 'api'));
       const { feed, window } = selectRuns(all);
       const engine = feed.filter((r: any) => r.run.suite === 'ts-engine');
       expect(RUNS_PER_SUITE).toBe(30);
       expect(engine).toHaveLength(30);
       expect(engine[0].run.id).toBe('r34');
       expect(engine.filter((r: any) => r.results !== null)).toHaveLength(1);
       expect(
         feed.filter((r: any) => r.run.suite === 'api')[0].results,
       ).not.toBeNull();
       // The window keeps every kept run's results, for flaky[] (Task 12).
       expect(window.every((r: any) => r.results !== null)).toBe(true);
       for (const r of feed)
         expect(validateDocument(r, { layer: 'run' }).errors).toEqual([]);
     });
   });
   ```

2. Run the test — observe failure.
3. Append to `runs.mjs`:

   ```js
   /** D15: the last N runs per (scope, suite) keep the feed loadable in one fetch. */
   export const RUNS_PER_SUITE = 30;

   const suiteKey = (r) =>
     `${r.scope.id}\u0000${r.scope.env}\u0000${r.run.suite}`;

   /**
    * Newest first per suite. `window` keeps every kept run's results (flaky[]
    * needs them); `feed` drops results on all but each suite's newest run.
    * Dropped results become `results: null` and the run's totals stay, so the
    * run still validates ("not carried", never "zero tests").
    */
   export function selectRuns(runs) {
     const bySuite = new Map();
     for (const r of runs) {
       const k = suiteKey(r);
       bySuite.set(k, [...(bySuite.get(k) ?? []), r]);
     }
     const window = [];
     const feed = [];
     for (const group of bySuite.values()) {
       const kept = group
         .sort(
           (a, b) =>
             Date.parse(b.run.finished_at) - Date.parse(a.run.finished_at),
         )
         .slice(0, RUNS_PER_SUITE);
       window.push(...kept);
       feed.push(
         ...kept.map((r, i) => (i === 0 ? r : { ...r, results: null })),
       );
     }
     return { window, feed };
   }
   ```

4. Run the test — observe pass.
5. Run: `harness validate`
6. Commit:
   `feat(starling): keep 30 runs per suite, per-test results on the latest only`

### Task 12: starling — distinct flaky tests

**Depends on:** Task 11 | **Files:** `…/canary-starling/scripts/flaky.mjs`,
`agents/skills/test/canary-starling.test.ts`

1. Append:

   ```ts
   describe('flakyTests (D13)', () => {
     it('counts a test once, with flaky runs over runs that carry results', () => {
       const mk = (i: number, status: string) =>
         historyToRun(
           historyRow({
             run_id: `r${i}`,
             timestamp: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
             passed: status === 'passed' ? 1 : 0,
             flaky: status === 'flaky' ? 1 : 0,
             failed: 0,
             total: 1,
             tests: [{ test_name: 'a', test_file: 'test/a.test.ts', status }],
           }),
           SCOPE,
         ).run;
       const counted = historyToRun(
         historyRow({ run_id: 'c', tests: undefined }),
         SCOPE,
       ).run;
       const rows = flakyTests([
         mk(1, 'flaky'),
         mk(2, 'passed'),
         mk(3, 'flaky'),
         counted,
       ]);
       expect(rows).toEqual([
         {
           scope: SCOPE,
           suite: 'ts-engine',
           title: 'a',
           file: 'test/a.test.ts',
           flaky_runs: 2,
           window_runs: 3,
         },
       ]);
     });
   });
   ```

   (import `flakyTests` from
   `../claude-code/canary-starling/scripts/flaky.mjs`).

2. Run the test — observe failure.
3. Create `flaky.mjs`:

   ```js
   // flaky -- distinct flaky tests over each suite's window (D13).
   //
   // The feed keeps per-test results on one run per suite, so a page cannot
   // count distinct flakes; this does, over the selected window. A count-only
   // run (results null) is outside the denominator: it cannot say which test
   // flaked.

   const key = (...parts) => parts.join('\u0000');

   export function flakyTests(window) {
     const windowRuns = new Map();
     const hits = new Map();
     for (const r of window) {
       if (!Array.isArray(r.results)) continue;
       const suite = key(r.scope.id, r.scope.env, r.run.suite);
       windowRuns.set(suite, (windowRuns.get(suite) ?? 0) + 1);
       for (const t of r.results) {
         if (t.status !== 'flaky') continue;
         const k = key(suite, t.file, t.title);
         const prior = hits.get(k);
         hits.set(
           k,
           prior
             ? { ...prior, flaky_runs: prior.flaky_runs + 1 }
             : {
                 scope: r.scope,
                 suite: r.run.suite,
                 title: t.title,
                 file: t.file,
                 flaky_runs: 1,
                 suiteKey: suite,
               },
         );
       }
     }
     return [...hits.values()].map(({ suiteKey, ...row }) => ({
       ...row,
       window_runs: windowRuns.get(suiteKey),
     }));
   }
   ```

4. Run the test — observe pass.
5. Run: `harness validate`
6. Commit: `feat(starling): count distinct flaky tests over the window`

### Task 13: starling — the register from the katana ledger

**Depends on:** Task 12 | **Files:** `…/canary-starling/scripts/register.mjs`,
`agents/skills/test/canary-starling.test.ts`

1. Append:

   ```ts
   describe('registerRows (fork C)', () => {
     const ledgerRow = (over = {}) => ({
       test: 'adds',
       file: 'tests/cart.test.ts',
       kind: 'skipped',
       marker: 'it.skip',
       commit: 'abc1234',
       author: 'Someone',
       date: '2026-10-01T12:00:00+02:00',
       reason: 'chore: skip cart',
       cause: '',
       issue: '',
       expiry: '',
       ...over,
     });

     it('maps a ledger row, without author, empty cause/issue as null', () => {
       const { rows, skipped } = registerRows([ledgerRow()], SCOPE);
       expect(skipped).toEqual([]);
       expect(rows).toEqual([
         {
           scope: SCOPE,
           title: 'adds',
           file: 'tests/cart.test.ts',
           kind: 'skipped',
           reason: 'chore: skip cart',
           recorded_at: '2026-10-01T12:00:00+02:00',
           commit: 'abc1234',
           cause: null,
           issue: null,
         },
       ]);
     });

     it('leaves out a row with no date, commit or reason, and counts it', () => {
       const { rows, skipped } = registerRows(
         [ledgerRow({ date: '' }), ledgerRow({ commit: '' })],
         SCOPE,
       );
       expect(rows).toEqual([]);
       expect(skipped).toHaveLength(2);
     });
   });
   ```

2. Run the test — observe failure.
3. Create `register.mjs`:

   ```js
   // register -- the katana ledger as register[] rows (fork C).
   //
   // Author identity never reaches a public feed. A row with no provenance
   // (katana writes '' when git history was unavailable) cannot carry the
   // required recorded_at/commit/reason, so it is left out and counted rather
   // than given an invented date.

   const TIMESTAMP =
     /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
   const REQUIRED = ['test', 'file', 'kind', 'reason', 'commit'];

   export function registerRows(ledgerRows, scope) {
     const rows = [];
     const skipped = [];
     for (const r of ledgerRows) {
       const missing = REQUIRED.filter((f) => !r[f]);
       if (!TIMESTAMP.test(r.date ?? '')) missing.push('date');
       if (missing.length) {
         skipped.push(
           `ledger row ${r.file || '?'} :: ${r.test || '?'}: no ${missing.join(', ')}`,
         );
         continue;
       }
       rows.push({
         scope,
         title: r.test,
         file: r.file,
         kind: r.kind,
         reason: r.reason,
         recorded_at: r.date,
         commit: r.commit,
         cause: r.cause || null,
         issue: r.issue || null,
       });
     }
     return { rows, skipped };
   }
   ```

4. Run the test — observe pass.
5. Run: `harness validate`
6. Commit: `feat(starling): the katana ledger as register rows, no author`

### Task 14: starling — ci-ready checks as assessments (crit 8)

**Depends on:** Tasks 5, 13 | **Files:** `…/canary-starling/scripts/assess.mjs`,
`agents/skills/test/canary-starling.test.ts`

1. Append:

   ```ts
   describe('ciReadyAssessments (P1, crit 8)', () => {
     const NOW = '2026-10-06T12:00:00.000Z';
     const report = (checks: object[]) => ({
       observed_at: '2026-10-06T11:00:00.000Z',
       verdict: 'incomplete',
       checked: 1,
       checks,
     });

     it('is not-assessed for every metric when no report was supplied — planted absence', () => {
       const out = ciReadyAssessments(null, SCOPE, { now: NOW, source: null });
       expect(out.map((a: any) => a.metric)).toEqual(CI_READY_METRICS);
       for (const a of out) {
         expect(a.status).toBe('not-assessed');
         expect(a.value).toBeNull();
         expect(a.reason).toMatch(/no ci-ready report/);
         expect(validateDocument(a, { layer: 'assessment' }).errors).toEqual(
           [],
         );
       }
     });

     it('carries a skipped check as not-assessed with its own reason (no inventory)', () => {
       const skip = {
         name: 'coverage-depth',
         verdict: 'skip',
         reason:
           'no .canary/test-inventory.json: run `canary inventory` to produce it',
         measure: null,
       };
       const a = ciReadyAssessments(report([skip]), SCOPE, {
         now: NOW,
         source: 'ci-ready.json',
       })[0];
       expect(a).toMatchObject({
         status: 'not-assessed',
         value: null,
         reason: skip.reason,
         observed_at: '2026-10-06T11:00:00.000Z',
       });
     });

     it('maps pass/warn/fail with a measure to healthy/degraded/critical', () => {
       const m = { value: 0.2, unit: 'ratio', denominator: 5 };
       const out = ciReadyAssessments(
         report(
           ['pass', 'warn', 'fail'].map((verdict) => ({
             name: 'flakiness',
             verdict,
             reason: 'x',
             measure: m,
           })),
         ),
         SCOPE,
         { now: NOW, source: 'ci-ready.json' },
       );
       const flak = out.filter((a: any) => a.metric === 'flakiness');
       expect(flak.map((a: any) => a.status)).toEqual([
         'healthy',
         'degraded',
         'critical',
       ]);
       expect(flak[0]).toMatchObject({
         value: 0.2,
         unit: 'ratio',
         evidence: { tier: null, denominator: 5 },
         sources: ['ci-ready.json'],
       });
       for (const a of out)
         expect(validateDocument(a, { layer: 'assessment' }).errors).toEqual(
           [],
         );
     });

     it('a check with a verdict but no measure is not-assessed (thin window, structural zero)', () => {
       const out = ciReadyAssessments(
         report([
           {
             name: 'flakiness',
             verdict: 'pass',
             reason: 'structural zero',
             measure: null,
           },
         ]),
         SCOPE,
         { now: NOW, source: 'r.json' },
       );
       expect(out.find((a: any) => a.metric === 'flakiness')).toMatchObject({
         status: 'not-assessed',
         reason: 'structural zero',
       });
     });

     it('names a metric the report does not carry', () => {
       const out = ciReadyAssessments(report([]), SCOPE, {
         now: NOW,
         source: 'r.json',
       });
       expect(
         out.find((a: any) => a.metric === 'suite-runtime')?.reason,
       ).toMatch(/no suite-runtime check/);
     });
   });
   ```

   (import `ciReadyAssessments, CI_READY_METRICS` from `assess.mjs`). The third
   test's report carries three `flakiness` checks, so `out` holds those three
   plus one not-assessed row for each of the other four metrics; the `flak`
   filter and the validate-all loop are both written for that.

2. Run the test — observe failure.
3. Create `assess.mjs`:

   ```js
   // assess -- canary ci-ready checks as canary.assessment/1 records (P1).
   //
   // Starling owns no metric math: the number is the check's own `measure`.
   // A check without one measured nothing, so it is `not-assessed` with the
   // check's own reason -- whatever its verdict says (a thin window warns, a
   // structural zero passes; neither is a measurement). Every metric is
   // emitted, present or not: an absent input is never an omitted row (crit 8).

   export const CI_READY_METRICS = [
     'coverage-depth',
     'flakiness',
     'assertion-quality',
     'critical-paths',
     'suite-runtime',
   ];
   const SOURCE = 'canary.ci-ready';
   const STATUS = { pass: 'healthy', warn: 'degraded', fail: 'critical' };

   function base(scope, metric, observedAt, sources) {
     return {
       contract: 'canary.assessment/1',
       scope,
       source: SOURCE,
       metric,
       observed_at: observedAt,
       sources,
       verified_by: null,
       verified_at: null,
     };
   }

   function abstain(scope, metric, observedAt, sources, reason) {
     return {
       ...base(scope, metric, observedAt, sources),
       status: 'not-assessed',
       value: null,
       unit: null,
       reason,
       evidence: { tier: null, denominator: null },
     };
   }

   function fromCheck(c, scope, observedAt, sources) {
     if (!c.measure || !STATUS[c.verdict])
       return abstain(scope, c.name, observedAt, sources, c.reason);
     return {
       ...base(scope, c.name, observedAt, sources),
       status: STATUS[c.verdict],
       value: c.measure.value,
       unit: c.measure.unit,
       reason: null,
       evidence: { tier: null, denominator: c.measure.denominator },
     };
   }

   /**
    * @param report parsed `canary ci-ready --json`, or null when none was supplied
    * @param opts {now: ISO string, source: the report's path or null}
    */
   export function ciReadyAssessments(report, scope, { now, source }) {
     if (!report)
       return CI_READY_METRICS.map((m) =>
         abstain(
           scope,
           m,
           now,
           [],
           'no ci-ready report supplied (run `canary ci-ready --json`)',
         ),
       );
     const observedAt = report.observed_at ?? now;
     const sources = source ? [source] : [];
     const checks = Array.isArray(report.checks) ? report.checks : [];
     const out = checks
       .filter((c) => CI_READY_METRICS.includes(c.name))
       .map((c) => fromCheck(c, scope, observedAt, sources));
     for (const m of CI_READY_METRICS) {
       if (!checks.some((c) => c.name === m))
         out.push(
           abstain(
             scope,
             m,
             observedAt,
             sources,
             `the ci-ready report has no ${m} check`,
           ),
         );
     }
     return out;
   }
   ```

4. Run the test — observe pass.
5. Run: `harness validate`
6. Commit:
   `feat(starling): ci-ready checks as assessments, absent inputs not-assessed`

### Task 15: starling — latest per identity key (crit 19)

**Depends on:** Task 14 | **Files:** `…/canary-starling/scripts/assess.mjs`,
`agents/skills/test/canary-starling.test.ts`

1. Append:

   ```ts
   describe('latestPerKey (crit 19)', () => {
     const a = (observed_at: string, value: number, scope = SCOPE) => ({
       scope,
       source: 's',
       metric: 'm',
       observed_at,
       value,
     });
     it('keeps only the latest observed_at per scope.id + scope.env + source + metric', () => {
       const out = latestPerKey([
         a('2026-10-01T00:00:00Z', 1),
         a('2026-10-03T00:00:00Z', 3),
         a('2026-10-02T00:00:00Z', 2),
         a('2026-10-01T00:00:00Z', 9, { id: 'canary', env: 'prod' }),
       ]);
       expect(out.map((x: any) => x.value).sort()).toEqual([3, 9]);
     });
     it('compares instants, not strings, across offsets', () => {
       const out = latestPerKey([
         a('2026-10-01T10:00:00+02:00', 1),
         a('2026-10-01T09:00:00Z', 2),
       ]);
       expect(out.map((x: any) => x.value)).toEqual([2]);
     });
   });
   ```

2. Run the test — observe failure.
3. Append to `assess.mjs`:

   ```js
   /** Consumers read "latest per key" (spec, assessment layer); the feed ships only that. */
   export function latestPerKey(assessments) {
     const latest = new Map();
     for (const a of assessments) {
       const k = [a.scope.id, a.scope.env, a.source, a.metric].join('\u0000');
       const prior = latest.get(k);
       if (!prior || Date.parse(a.observed_at) >= Date.parse(prior.observed_at))
         latest.set(k, a);
     }
     return [...latest.values()];
   }
   ```

4. Run the test — observe pass.
5. Run: `harness validate`
6. Commit: `feat(starling): keep the latest assessment per identity key`

### Task 16: starling — config and feed composition

**Depends on:** Tasks 11–15 | **Files:** `…/canary-starling/scripts/feed.mjs`,
`agents/skills/test/canary-starling.test.ts`

1. Append:

   ```ts
   describe('loadConfig and composeFeed', () => {
     it('reads scope and declared suites; refuses a config without a full scope', () => {
       expect(parseConfig({ scope: SCOPE, suites: ['ts-engine'] })).toEqual({
         scope: SCOPE,
         suites: [{ scope: SCOPE, suite: 'ts-engine' }],
       });
       expect(parseConfig({ scope: SCOPE }).suites).toBeNull(); // D12: undeclared ≠ []
       expect(() => parseConfig({ scope: { id: 'canary' } })).toThrow(
         /scope\.env/,
       );
     });

     it('composes a valid feed whose scopes are every scope it carries', () => {
       const run = historyToRun(historyRow(), SCOPE).run;
       const other = { ...run, scope: { id: 'web', env: 'prod' } };
       const { doc, errors } = composeFeed({
         config: parseConfig({ scope: SCOPE, suites: ['ts-engine'] }),
         runs: [run, other],
         flaky: [],
         assessments: [],
         register: [],
         now: '2026-10-06T12:00:00.000Z',
       });
       expect(errors).toEqual([]);
       expect(doc.scopes).toEqual([SCOPE, { id: 'web', env: 'prod' }]);
     });

     it('returns the validator errors for an invalid feed', () => {
       const bad = {
         ...historyToRun(historyRow(), SCOPE).run,
         contract: 'canary.run/9',
       };
       const { errors } = composeFeed({
         config: parseConfig({ scope: SCOPE }),
         runs: [bad],
         flaky: [],
         assessments: [],
         register: [],
         now: '2026-10-06T12:00:00.000Z',
       });
       expect(errors.length).toBeGreaterThan(0);
     });
   });
   ```

2. Run the test — observe failure.
3. Create `feed.mjs`:

   ```js
   // feed -- canary-site.config.json and the composed canary.site/1 document.
   //
   // The feed is validated before anyone sees it: composeFeed returns the
   // validator's errors and the CLI refuses to write on any (#1151 phase 2).

   import { validateDocument } from '../../../lib/contracts/validate.mjs';

   const text = (v) => typeof v === 'string' && v.length > 0;

   /** @throws on a config without a full scope -- scope is never inferred (D2). */
   export function parseConfig(raw) {
     for (const f of ['id', 'env']) {
       if (!text(raw?.scope?.[f]))
         throw new Error(`canary-site.config.json: scope.${f} is required`);
     }
     const scope = { id: raw.scope.id, env: raw.scope.env };
     if (
       raw.suites !== undefined &&
       !(Array.isArray(raw.suites) && raw.suites.every(text))
     ) {
       throw new Error(
         'canary-site.config.json: suites must be a list of suite names',
       );
     }
     // D12: no declaration is null, which the panel reports as "none declared".
     const suites =
       raw.suites === undefined
         ? null
         : raw.suites.map((suite) => ({ scope, suite }));
     return { scope, suites };
   }

   function uniqueScopes(records) {
     const seen = new Map();
     for (const { scope } of records)
       seen.set(`${scope.id}\u0000${scope.env}`, {
         id: scope.id,
         env: scope.env,
       });
     return [...seen.values()];
   }

   export function composeFeed({
     config,
     runs,
     flaky,
     assessments,
     register,
     now,
   }) {
     const doc = {
       contract: 'canary.site/1',
       generated_at: now,
       scopes: uniqueScopes([{ scope: config.scope }, ...runs, ...assessments]),
       suites: config.suites,
       runs,
       flaky,
       assessments,
       register,
     };
     return { doc, errors: validateDocument(doc, { layer: 'site' }).errors };
   }
   ```

4. Run the test — observe pass.
5. Run: `harness validate`
6. Commit: `feat(starling): config parsing and a validated site feed`

### Task 17: starling — `cli.mjs`, end to end

**Depends on:** Task 16 | **Files:** `…/canary-starling/scripts/cli.mjs`,
`agents/skills/test/canary-starling.test.ts`,
`agents/skills/test/gate-conformance.test.ts`

1. Append an end-to-end block driving `main` in-process (as
   `canary-signal.test.ts` does). Add to the file's imports
   `mkdtempSync, writeFileSync, readFileSync, existsSync` from `node:fs`, `join`
   from `node:path`, `tmpdir` from `node:os`, `vi` from `vitest`, and
   `main as starlingMain` from `../claude-code/canary-starling/scripts/cli.mjs`.

   ```ts
   describe('canary-starling (end to end)', () => {
     const CI_AT = '2026-10-06T11:00:00.000Z';
     const runFile = {
       contract: 'canary.run/1',
       scope: { id: 'web', env: 'prod' },
       producer: {
         name: 'canary-test-cli/reporter',
         version: '9.0.0',
         channel: 'ci',
       },
       run: {
         id: '42-1',
         suite: 'e2e',
         branch: 'main',
         commit_sha: 'abc1234',
         started_at: '2026-10-06T09:00:00Z',
         finished_at: '2026-10-06T09:01:00Z',
         ci_url: null,
         status: 'passed',
         shard: null,
       },
       totals: {
         passed: 1,
         failed: 0,
         flaky: 0,
         skipped: 0,
         timed_out: 0,
         interrupted: 0,
         total: 1,
       },
       results: [
         {
           title: 'a',
           file: 'tests/a.spec.ts',
           status: 'passed',
           duration_ms: 5,
           retries: 0,
           area: null,
           tags: [],
           error: null,
         },
       ],
       collected: null,
     };
     const olderFlakiness = {
       contract: 'canary.assessment/1',
       scope: SCOPE,
       source: 'canary.ci-ready',
       metric: 'flakiness',
       status: 'healthy',
       value: 0,
       unit: 'ratio',
       reason: null,
       evidence: { tier: null, denominator: 10 },
       observed_at: '2026-10-01T00:00:00.000Z',
       sources: [],
       verified_by: null,
       verified_at: null,
     };
     const ciReady = {
       observed_at: CI_AT,
       verdict: 'incomplete',
       checked: 1,
       checks: [
         {
           name: 'coverage-depth',
           verdict: 'skip',
           reason:
             'no .canary/test-inventory.json: run `canary inventory` to produce it',
           measure: null,
         },
         {
           name: 'flakiness',
           verdict: 'warn',
           reason: '1 flaky',
           measure: { value: 0.05, unit: 'ratio', denominator: 20 },
         },
       ],
     };

     /** A tmp dir of inputs; `over` replaces a file's content, `null` omits it. */
     function fixture(over: Record<string, unknown> = {}) {
       const dir = mkdtempSync(join(tmpdir(), 'starling-'));
       const files: Record<string, unknown> = {
         'canary-site.config.json': { scope: SCOPE, suites: ['ts-engine'] },
         'history-v2.jsonl': [
           historyRow({ run_id: 'h1' }),
           historyRow({ run_id: 'h2', timestamp: '2026-10-06T10:30:00Z' }),
         ],
         'ci-ready.json': ciReady,
         'old-assessment.json': olderFlakiness,
         'run.json': runFile,
         ...over,
       };
       for (const [name, content] of Object.entries(files)) {
         if (content === null) continue;
         const text = name.endsWith('.jsonl')
           ? (content as object[]).map((r) => JSON.stringify(r)).join('\n') +
             '\n'
           : JSON.stringify(content);
         writeFileSync(join(dir, name), text, 'utf8');
       }
       return dir;
     }
     const argv = (dir: string, extra: string[] = []) => [
       '--config',
       join(dir, 'canary-site.config.json'),
       '--history',
       join(dir, 'history-v2.jsonl'),
       '--ledger',
       join(dir, 'ledger.json'),
       '--ci-ready',
       join(dir, 'ci-ready.json'),
       '--out',
       join(dir, 'site.json'),
       ...extra,
     ];
     function capture(fn: () => number) {
       const out: string[] = [];
       const err: string[] = [];
       const log = vi
         .spyOn(console, 'log')
         .mockImplementation((...a) => void out.push(a.join(' ')));
       const error = vi
         .spyOn(console, 'error')
         .mockImplementation((...a) => void err.push(a.join(' ')));
       try {
         return { code: fn(), stdout: out.join('\n'), stderr: err.join('\n') };
       } finally {
         log.mockRestore();
         error.mockRestore();
       }
     }

     it('writes a valid feed; crit 8 planted absence and crit 19 latest-per-key hold', () => {
       const dir = fixture({
         'ledger.json': { schema_version: 1, entries: [] },
       });
       const res = capture(() =>
         starlingMain(
           argv(dir, [join(dir, 'old-assessment.json'), join(dir, 'run.json')]),
         ),
       );
       expect(res.code).toBe(0);
       const site = JSON.parse(readFileSync(join(dir, 'site.json'), 'utf8'));
       expect(validateDocument(site, { layer: 'site' }).errors).toEqual([]);
       expect(
         site.assessments.find((a: any) => a.metric === 'coverage-depth'),
       ).toMatchObject({
         status: 'not-assessed',
         reason: expect.stringMatching(/test-inventory\.json/),
       });
       const flak = site.assessments.filter(
         (a: any) => a.metric === 'flakiness',
       );
       expect(flak).toHaveLength(1);
       expect(flak[0]).toMatchObject({
         observed_at: CI_AT,
         status: 'degraded',
       }); // the newer ci-ready one wins
       expect(site.runs).toHaveLength(3);
       expect(site.scopes).toEqual([SCOPE, { id: 'web', env: 'prod' }]);
       expect(site.suites).toEqual([{ scope: SCOPE, suite: 'ts-engine' }]);
     });

     // composeFeed's own refusal is unit-tested in Task 16; this is the CLI's
     // earlier gate on a RECORD file that is not a valid record.
     it('refuses an invalid record file, writes nothing and exits 1, naming the file', () => {
       const dir = fixture({
         'run.json': { ...runFile, contract: 'canary.run/9' },
       });
       const res = capture(() =>
         starlingMain(argv(dir, [join(dir, 'run.json')])),
       );
       expect(res.code).toBe(1);
       expect(existsSync(join(dir, 'site.json'))).toBe(false);
       expect(res.stderr).toContain('run.json');
     });

     it('exits 1 on a missing config — scope is never inferred', () => {
       const dir = fixture({ 'canary-site.config.json': null });
       const res = capture(() => starlingMain(argv(dir)));
       expect(res.code).toBe(1);
       expect(res.stderr).toMatch(/config/);
       expect(existsSync(join(dir, 'site.json'))).toBe(false);
     });

     it('names left-out history rows and a dark ledger on stderr', () => {
       const dir = fixture({
         'history-v2.jsonl': [
           historyRow({ run_id: 'r-nodur', duration_ms: null }),
         ],
       });
       // No --ledger: the DEFAULT path (.canary/quarantine.json, relative to the
       // cwd) is read, so run from the fixture dir, never the repo root.
       const noLedger = argv(dir).filter(
         (a, i, all) => a !== '--ledger' && all[i - 1] !== '--ledger',
       );
       const cwd = process.cwd();
       process.chdir(dir);
       try {
         const res = capture(() => starlingMain(noLedger));
         expect(res.code).toBe(0);
         expect(res.stderr).toMatch(/left out history run r-nodur/);
         expect(res.stderr).toMatch(/no quarantine ledger/);
       } finally {
         process.chdir(cwd);
       }
     });

     it('says abstained and, under --strict, exits 3 when the feed has zero runs', () => {
       const dir = fixture({
         'history-v2.jsonl': [],
         'ledger.json': { entries: [] },
       });
       const loose = capture(() => starlingMain(argv(dir)));
       expect(loose.code).toBe(0);
       expect(loose.stdout.toLowerCase()).toContain('abstained');
       expect(existsSync(join(dir, 'site.json'))).toBe(true);
       expect(capture(() => starlingMain(argv(dir, ['--strict']))).code).toBe(
         3,
       );
     });
   });
   ```

2. In `gate-conformance.test.ts` (rows need: `stdout` contains `abstained` on a
   zero denominator with exit 0; exit 3 under `--strict`), add the import
   `import { main as starlingMain } from '../claude-code/canary-starling/scripts/cli.mjs';`,
   a helper beside `emptyStore`:

   ```ts
   /** A minimal starling invocation over an empty store: zero runs in the feed. */
   function starlingArgs(base: string): string[] {
     const config = path.join(base, 'canary-site.config.json');
     fs.writeFileSync(
       config,
       JSON.stringify({ scope: { id: 'canary', env: 'ci' } }),
     );
     // emptyStore writes '' (line 174), which the ledger parser refuses; a
     // ledger with no entries is its own file.
     const ledger = path.join(base, 'quarantine.json');
     fs.writeFileSync(ledger, JSON.stringify({ entries: [] }));
     return [
       '--config',
       config,
       '--history',
       emptyStore(base),
       '--ledger',
       ledger,
       '--out',
       path.join(base, 'site.json'),
     ];
   }
   ```

   and the row:

   ```ts
   {
     // An empty history: a feed with zero runs. The tempting read is "all
     // suites quiet"; in fact nothing was measured (#1151, D14).
     command: 'canary-starling (zero runs in the feed)',
     forbid: [': 0 run(s)'],
     run: (base) => run(starlingMain, starlingArgs(base)),
     strict: (base) => run(starlingMain, [...starlingArgs(base), '--strict']),
   },
   ```

3. Run
   `cd agents/skills && npx vitest run test/canary-starling.test.ts test/gate-conformance.test.ts`
   — observe failures.
4. Create `cli.mjs`:

   ```js
   #!/usr/bin/env node
   // canary-starling -- compose a canary.site/1 feed (#1151 phase 2).
   //
   // Reads what canary already persists -- the run-history store, canary.run/1
   // files, the katana ledger, a `canary ci-ready --json` report, and any
   // canary.assessment/1 files -- and writes one site.json a page loads in one
   // fetch. The feed is validated before it is written; an invalid feed is
   // never written (exit 1). Every input it could not use is named on stderr.
   //
   // Exit: 0 written · 1 read error or invalid feed · 2 usage · 3 under
   // --strict when the feed carries zero runs (#508 D4).
   //
   // Invoked via `canary skills run canary-starling -- --config <file> --out <file> [...]`.

   import fs from 'node:fs';
   import path from 'node:path';

   import {
     createParser,
     formatUsageError,
     EXIT_USAGE,
   } from '../../../lib/parse-args.mjs';
   import { isMain } from '../../../lib/is-main.mjs';
   import { validateText } from '../../../lib/contracts/validate.mjs';
   import {
     loadLedger,
     loadRuns,
     DEFAULT_LEDGER,
   } from '../../canary-signal/scripts/sources.mjs';
   import { historyToRun, selectRuns } from './runs.mjs';
   import { flakyTests } from './flaky.mjs';
   import { registerRows } from './register.mjs';
   import { ciReadyAssessments, latestPerKey } from './assess.mjs';
   import { composeFeed, parseConfig } from './feed.mjs';

   const PREFIX = 'canary-starling:';
   const EXIT_ABSTAINED = 3;

   const USAGE =
     'usage: canary-starling [-h] --config PATH --out PATH [--history PATH]\n' +
     '                       [--ledger PATH] [--ci-ready PATH] [--strict]\n' +
     '                       [RECORD ...]\n' +
     '\n' +
     'Compose a validated canary.site/1 feed. RECORD: canary.run/1 or\n' +
     'canary.assessment/1 JSON files.';

   export const CLI_SPEC = {
     prog: 'canary-starling',
     booleans: { '--strict': 'strict' },
     values: {
       '--config': { key: 'config' },
       '--out': { key: 'out' },
       '--history': { key: 'history' },
       '--ledger': { key: 'ledger' },
       '--ci-ready': { key: 'ciReady' },
     },
     defaults: {},
     required: ['--config', '--out'],
     positionals: { key: 'records' },
   };

   const parseArgs = createParser(CLI_SPEC);

   function readJson(file, what) {
     try {
       return JSON.parse(fs.readFileSync(file, 'utf8'));
     } catch (exc) {
       throw new Error(`cannot read ${what} ${file}: ${exc.message}`);
     }
   }

   /** Each RECORD file must itself be a valid run or assessment record. */
   function readRecord(file) {
     const { valid, contract, errors } = validateText(
       fs.readFileSync(file, 'utf8'),
     );
     if (!valid)
       throw new Error(
         `${file}: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`,
       );
     if (contract !== 'canary.run/1' && contract !== 'canary.assessment/1')
       throw new Error(
         `${file}: expected a run or assessment record, got ${contract}`,
       );
     return JSON.parse(fs.readFileSync(file, 'utf8'));
   }

   function gather(args, notes, now) {
     const config = parseConfig(readJson(args.config, 'config'));
     const records = (args.records ?? []).map(readRecord);
     const runs = records.filter((r) => r.contract === 'canary.run/1');
     for (const row of args.history ? loadRuns(args.history) : []) {
       const out = historyToRun(row, config.scope);
       if (out.run) runs.push(out.run);
       else notes.push(`left out ${out.skipped}`);
     }
     // parse-args initialises an unset value flag to null: null = not named.
     const ledger = loadLedger(
       args.ledger ?? DEFAULT_LEDGER,
       args.ledger !== null,
     );
     if (ledger.state === 'dark') notes.push(ledger.reason);
     const register = registerRows(ledger.rows, config.scope);
     notes.push(...register.skipped.map((s) => `left out ${s}`));
     const report = args.ciReady
       ? readJson(args.ciReady, 'ci-ready report')
       : null;
     const assessments = latestPerKey([
       ...records.filter((r) => r.contract === 'canary.assessment/1'),
       ...ciReadyAssessments(report, config.scope, {
         now,
         source: args.ciReady ?? null,
       }),
     ]);
     const { window, feed } = selectRuns(runs);
     return {
       config,
       runs: feed,
       flaky: flakyTests(window),
       assessments,
       register: register.rows,
     };
   }

   function write(out, doc) {
     fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
     fs.writeFileSync(out, JSON.stringify(doc, null, 2) + '\n', 'utf8');
   }

   export function main(argv = []) {
     const { opts: args, positionals, help, error } = parseArgs(argv);
     if (help) {
       console.log(USAGE);
       return 0;
     }
     if (error) {
       console.error(formatUsageError(CLI_SPEC.prog, error));
       return EXIT_USAGE;
     }
     const now = new Date().toISOString();
     const notes = [];
     let parts;
     try {
       parts = gather({ ...args, records: positionals }, notes, now);
     } catch (exc) {
       console.error(`${PREFIX} ${exc.message}`);
       return 1;
     }
     for (const n of notes) console.error(`${PREFIX} ${n}`);
     const { doc, errors } = composeFeed({ ...parts, now });
     if (errors.length) {
       for (const e of errors)
         console.error(`${PREFIX} invalid feed: ${e.path}: ${e.message}`);
       console.error(`${PREFIX} ${args.out} not written`);
       return 1;
     }
     write(args.out, doc);
     if (doc.runs.length === 0) {
       // A feed of zero runs reads as "all quiet" on a page. It measured nothing.
       console.log(
         `${PREFIX} ABSTAINED: wrote ${args.out} with 0 runs; the feed measured nothing.`,
       );
       return args.strict ? EXIT_ABSTAINED : 0;
     }
     console.log(
       `${PREFIX} wrote ${args.out}: ${doc.runs.length} run(s), ${doc.assessments.length} assessment(s), ${doc.flaky.length} flaky, ${doc.register.length} register row(s)`,
     );
     return 0;
   }

   // `process.exitCode`, not `process.exit()` (#791).
   if (isMain(import.meta.url)) {
     process.exitCode = main(process.argv.slice(2));
   }
   ```

   Verified while planning: `createParser` returns
   `{opts, positionals, help, error}` with positionals as an array
   (`parse-args.mjs:215`), unset value flags initialise to `null` (`:76-84`),
   and `validateText` returns `{valid, contract, checked, errors}` with
   `contract` as the full string
   (`validateText('{"contract":"canary.run/1"}').contract === 'canary.run/1'`,
   run 2026-10-06), so the comparisons above are correct as written.

5. Run the tests — observe pass. Run
   `cd agents/skills && npm run -s typecheck && npx vitest run`.
6. Run: `harness validate` and `harness check-deps` (from the root; a skill →
   skill import of `canary-signal/scripts/sources.mjs` is inside the `skills`
   layer).
7. Commit: `feat(starling): build CLI composing a validated canary.site/1 feed`

### Task 18: `SKILL.md` and the skills README

**Depends on:** Task 17 | **Files:**
`agents/skills/claude-code/canary-starling/SKILL.md`, `agents/skills/README.md`
| **Category:** integration

1. Create `SKILL.md` with frontmatter (`name: canary-starling`, a `description`
   stating: composes a validated `canary.site/1` feed from run history, run
   files, the katana ledger and a ci-ready report; absent inputs become
   `not-assessed`, never omitted; writes only, never deploys — plus
   `cli: scripts/cli.mjs`, `requires: [node>=20]`), then sections matching
   `canary-signal/SKILL.md`: what it is not (no deploy, no network, no metric
   math — numbers come from ci-ready), the invocation below, a flag table, the
   `canary-site.config.json` shape (`{"scope": {"id", "env"}, "suites": [...]}`
   with "omit `suites` = none declared"), honest degradation (left-out rows,
   dark ledger, not-assessed metrics), and the exit-code table from the
   `cli.mjs` header. Invocation:

   ```bash
   canary skills run canary-starling -- \
     --config canary-site.config.json \
     --history test-results/reports/history-v2.jsonl \
     --ci-ready ci-ready.json --out site/site.json
   ```

2. Add `canary-starling` to `agents/skills/README.md`'s tree, its bullet list
   (one paragraph, same shape as `canary-signal`'s), and the "ship a Node entry"
   sentence.
3. Format and lint both files:

   ```bash
   cd ts && npx prettier --write \
     ../agents/skills/claude-code/canary-starling/SKILL.md \
     ../agents/skills/README.md
   cd .. && npx markdownlint-cli2 \
     agents/skills/claude-code/canary-starling/SKILL.md agents/skills/README.md
   ```

4. Run `cd agents/skills && npx vitest run test/skill-cli-conformance.test.ts`
   (discovers the new `cli:` and checks `CLI_SPEC`).
5. Run: `harness validate`
6. Commit: `docs(starling): SKILL.md and skills README entry`

### Task 19: registrations

**Depends on:** Task 18 | **Files:** `docs/naming-registry.md`,
`harness.config.json`, `agents/skills/package.json`,
`agents/skills/vitest.config.ts` | **Category:** integration

1. `docs/naming-registry.md`: the `canary-starling` row (reserved by #1152) →
   `shipped`, issue `1151`.
2. `harness.config.json`: add
   `"agents/skills/claude-code/canary-starling/scripts/cli.mjs"` beside the
   `canary-signal` line in **both** `entryPoints` arrays (entropy and
   performance).
3. `agents/skills/package.json` `format:check`: add
   `\"claude-code/canary-starling/scripts/*.mjs\"`.
4. `agents/skills/vitest.config.ts` coverage include: add
   `'claude-code/canary-starling/scripts/**/*.mjs',` beside canary-signal's.
5. Run `cd agents/skills && npm run -s format:check && npx vitest run`,
   `cd ts && npx vitest run test/bop-name-registry.test.ts test/harness-config-denominator.test.ts`,
   and from the root `harness check-deps`.
6. Run: `harness validate`
7. Commit:
   `chore(starling): register the skill in naming, entry points, format and coverage`

### Task 20: AGENTS.md, roadmap, final gates

**Depends on:** Task 19 | **Files:** `AGENTS.md`, `docs/roadmap.md` |
**Category:** integration

1. `AGENTS.md`: in the skills section add a `canary-starling` bullet (feed
   composer; reads history/run files/ledger/ci-ready; validated output); in the
   `QA data contract` bullet add that the reporter writes `canary.run/1` with
   `runFile` and `canary ci-ready --json` checks carry `measure`.
2. `docs/roadmap.md` #1151 row summary: phase 2 landed (reporter run file,
   `canary-starling`, ci-ready measures); remove "phase 2 absorbs reporter fixes
   #1148/#1149/#1150" (they landed in #1187). Do not change the row count.
3. Prettier + markdownlint both files.
4. Final gates on the latest tree, from a clean state:
   - `ts/`: `npm run -s build`, `typecheck`, `format:check`, then `npm test`
   - `agents/skills/`: `npm run -s typecheck`, `format:check`, then `npm test`
   - `npm/`: `npm test`
   - root: `harness check-deps`, `harness check-perf`, `harness validate`,
     entropy per `harness.config.json` — compare each count to `main` measured
     in a fresh worktree; none may rise.
   - Report each gate's denominator (tests run, modules checked); a zero is a
     failure, not a pass.
5. Commit: `docs(canary-qa-site): record phase 2 in AGENTS.md and the roadmap`
6. Push, open the PR with `Refs #1151` (never a closing keyword — the issue
   tracks five phases).

## Traceability

| Truth | Tasks          |
| ----- | -------------- |
| 1     | 7, 8           |
| 2     | 7              |
| 3     | 7              |
| 4     | 7, 8           |
| 5     | 6, 8           |
| 6     | 1–5            |
| 7     | 14, 17         |
| 8     | 15, 17         |
| 9     | 11, 12         |
| 10    | 13             |
| 11    | 16, 17         |
| 12    | every task; 20 |
