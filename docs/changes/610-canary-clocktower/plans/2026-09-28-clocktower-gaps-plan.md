# Plan: canary-clocktower — `canary history gaps`

**Date:** 2026-09-28 | **Spec:** [proposal.md](../proposal.md) | **Tasks:** 10 |
**Time:** ~40 min | **Integration Tier:** medium | **Rigor:** standard |
**Session:** `changes--610-canary-clocktower--proposal`

## Goal

`canary history gaps` reads the local NDJSON run-history store and reports, per
consumer and with denominators, which history consumers are fed, partial, dark
or unmeasured. It exits 0 when everything is fed, 1 on gaps, and 3 when it
abstains. It ships as the thin `/canary-clocktower` skill, with zero lines
changed under `ts/src/history/**`.

## Observable Truths (Acceptance Criteria)

1. When `--path` names a file that does not exist, `canary history gaps` shall
   exit 3 and print `store not found: <path>` plus the `Abstained` summary line.
   It shall never print `passed` (SC1).
2. When the store exists with zero runs (empty or blank-line-only file), the
   command shall exit 3 and print `store is empty: <path> (0 runs)` (SC2).
3. When every applicable row carries a consumer's required field, that consumer
   shall be `fed`. When no row carries it, the consumer shall be `dark`. When
   some rows carry it, the consumer shall be `partial`, rendered as
   `carried/applicable` (SC3).
4. If the store has no failed or flaky tests, then `failure-categories` shall be
   `unmeasured` and listed in the summary line's skipped set. It shall never be
   `fed` (SC4).
5. When the store was written by `canary history record` from a Playwright
   report, the command shall report `area-health` and `failure-categories` as
   `dark` and exit 1 (SC5, which reproduces G1/G2 end to end).
6. When `CANARY_HISTORY_DB_URL` is set, the summary line shall name
   `remote store [local NDJSON only]` as skipped (SC6).
7. `git diff --stat <merge-base> -- ts/src/history` prints nothing (SC7).
8. The four gates (run from `ts/`) are green, `agents/skills` tests are green,
   and the entropy, perf, arch and docs ratchets are equal to or better than the
   merge base `47745970` (SC8).
9. `ts/test/gate-conformance.test.ts` carries engine rows for `history gaps`,
   and they pass.
10. `docs/naming-registry.md` lists `canary-clocktower` as `shipped`, and
    `ts/test/bop-name-registry.test.ts` passes.

## Uncertainties

- [ASSUMPTION, needs sign-off] **Flag name is `--path <store>`, not the spec's
  `--history <path>`.** Every engine sibling that reads or writes the store uses
  `--path <store>`: `history trim` (`ts/src/history/retention/cli.ts:108`),
  `history record` (`ts/src/history/record/cli.ts:244`), `order`
  (`ts/src/order/order-cli.ts:194`) and `rewind`
  (`ts/src/rewind/rewind-cli.ts:268`). Only the canary-screech skill script uses
  `--history`. If you want the spec's name instead, change it in one place (Task
  4, plus the doc and skill examples). This is the only deliberate divergence
  from the spec.
- [ASSUMPTION] **Meaning of "carried":**
  - Strings (`branch`, `commit_sha`, `timestamp`, `area`, `failure_category`,
    `test_file`) count as carried when they are non-empty strings. `null`, `''`
    and an absent key are all not carried.
  - Numbers (`duration_ms`, `start_index`) count when they are finite numbers.
  - Objects (`replay`, `order`) count when they are non-null objects.
- [ASSUMPTION] **The `failed-test` scope covers `status ∈ {failed, flaky}`.**
  This mirrors `isFailureWithError` (`ts/src/analysis/engine.ts:49`) and
  `FAILING` (`ts/src/analysis/order/rank.ts:59`).
- [ASSUMPTION] **A malformed or unsupported-version store is caught in
  `cli.ts`.** The command prints `Cannot read <path>: <message>` to stderr and
  exits 1. It is loud, and it is not an abstention (spec CLI step 5).
- [ASSUMPTION] **The doc path is `docs/history-gaps.md`, as specified.** Guide
  precedent is `docs/guides/*.md` (`rewind.md`, `order.md`). Moving it there is
  a one-line change if you prefer.
- [ASSUMPTION] **`cli.ts` is NOT added to `entropy`/`performance.entryPoints`.**
  It is reachable from `ts/src/commands/engine/cli.ts`, which is already an
  entry point, and `ts/src/history/retention/cli.ts` is likewise not listed.
  Task 6 verifies this with `harness cleanup` rather than assuming it.
- [ASSUMPTION] **No persona YAML is needed.** Only `canary-batwoman` has one
  (`agents/personas/canary-batwoman.yaml`), and no test enumerates personas per
  skill (`ts/test/persona.test.ts`).
- [ASSUMPTION] **No `AGENTS.md` change.** No test enforces a skill count there.
  The `(27)` in `agents/skills/README.md:16` is prose, and it gets bumped to 28.
- [DEFERRABLE] **The arch `module-size` metric will grow** (~400 new LOC in
  `ts/src/analysis`). If `harness check-arch` reports a module-size regression,
  it is resolved at ship time with the `refresh-baseline` PR label (AGENTS.md
  #749 flow), not in a task.
- [DEFERRABLE] **Roadmap row status** (`docs/roadmap.md:79`, `planned`) moves in
  the ship flow. Never use `harness roadmap sync --apply`.
- [BLOCKING-FOR-EXECUTION, not for planning] **The disk is nearly full.** While
  planning, `/` had about 205 MiB free, and one Bash call failed with `ENOSPC`.
  Task 10 builds the engine and creates a detached merge-base worktree, which
  needs its own `node_modules`. Free space before executing.

## File Map

- CREATE `ts/src/analysis/clocktower/consumers.ts`
- CREATE `ts/src/analysis/clocktower/gaps.ts`
- CREATE `ts/src/analysis/clocktower/render.ts`
- CREATE `ts/src/analysis/clocktower/cli.ts`
- MODIFY `ts/src/commands/engine/cli.ts` (mount `registerGapsCommand` beside
  `registerTrimCommand`)
- CREATE `ts/test/clocktower-consumers.test.ts`
- CREATE `ts/test/clocktower-gaps.test.ts`
- CREATE `ts/test/clocktower-render.test.ts`
- CREATE `ts/test/clocktower-cli.test.ts`
- CREATE `ts/test/clocktower-e2e.test.ts`
- MODIFY `ts/test/gate-conformance.test.ts` (two engine rows)
- MODIFY `harness.config.json` (three paths in each of `entropy.entryPoints` and
  `performance.entryPoints`)
- CREATE `docs/history-gaps.md`
- CREATE `agents/skills/claude-code/canary-clocktower/SKILL.md`
- MODIFY `agents/skills/README.md` (tree plus a skill-list section)
- MODIFY `docs/naming-registry.md` (`canary-clocktower` reserved → shipped)
- MODIFY `agents/skills/claude-code/canary-test-reporter/SKILL.md` ("Persisting
  runs", G4)
- CREATE `docs/knowledge/gates/consumer-field-coverage.md` (Knowledge Impact)

**Zero files under `ts/src/history/**`.**

## Skeleton

1. Pure core, TDD: consumers and gaps (~2 tasks, ~10 min)
2. Render, TDD (~1 task, ~4 min)
3. CLI, mount, end-to-end and conformance (~2 tasks, ~10 min)
4. Registrations, docs and skill (~3 tasks, ~10 min)
5. Follow-up issue, gates and ratchets (~2 tasks, ~8 min)

_Skeleton approved: self-approved (autonomous roadmap-fleet lane, standard
rigor). The caller pre-fixed the module layout and task budget._

## Constraints applied to every code task

- Perf: cyclomatic complexity ≤ 10, nesting ≤ 4, functions ≤ 50 lines.
- Export only what another module or a test imports. Entropy counts a dead
  export as a finding.
- Source stays ASCII. Glyphs are written as `\u{...}` escapes, as in
  `ts/src/core/gate-result.ts`.
- `analysis`-layer files (`consumers.ts`, `gaps.ts`, `render.ts`) import only
  from `history`, `core` and `util`. `cli.ts` binds to the `cli` layer because
  the filename matches `ts/src/**/*cli*.ts` first.
- Every test run is
  `cd /Users/bs/Github/canary-fleet-610-clocktower/ts && npx vitest run <file>`.
  Check the exit code, and never pipe the result before checking it.
- **Plant a positive** means: mutate the implementation as stated, confirm the
  named test FAILS, then revert. Record the failing test name in the commit
  body.

## Tasks

### Task 1: Consumer table (`consumers.ts`)

**Depends on:** none | **Files:** `ts/src/analysis/clocktower/consumers.ts`,
`ts/test/clocktower-consumers.test.ts`

1. Create `ts/test/clocktower-consumers.test.ts` with these tests (vitest,
   importing `CONSUMERS` from `../src/analysis/clocktower/consumers.js`):
   - `declares the eight initial consumers with unique ids`: the ids equal

     ```text
     ['screech','ci-ready-runtime','flaky-retry','area-health','failure-categories','order','rewind','order-ttff']
     ```

   - `gives every consumer at least one requirement`
   - `it.each` over mirror rows `[id, field, scope, source]`, named
     `'%s reads %s at %s scope (%s)'`:
     - `screech/branch/run/agents/skills/claude-code/canary-screech/scripts/history.mjs:68`
     - `screech/timestamp/run/…history.mjs:71`
     - `ci-ready-runtime/duration_ms/run/ts/src/core/ci-ready.ts:179`
     - `flaky-retry/reporter_format/run/ts/src/util/flake-window.ts:141`
     - `area-health/area/test/ts/src/analysis/reports.ts:121`
     - `failure-categories/failure_category/failed-test/ts/src/analysis/engine.ts:57`
     - `order/test_file/test/ts/src/analysis/order/rank.ts:166`
     - `order/duration_ms/test/ts/src/analysis/order/rank.ts:166`
     - `rewind/replay/run/ts/src/analysis/rewind/plan.ts:125`
     - `rewind/start_index/test/ts/src/analysis/rewind/plan.ts:170`
     - `order-ttff/order/run/ts/src/analysis/order/ttff-report.ts:36`

     Each row asserts that the consumer has a requirement with that `field` and
     `scope`.

   - `treats a null, empty or absent area as not carried`: the `area` predicate
     returns false for `{area:null}`, `{area:''}` and `{}`, and true for
     `{area:'checkout'}`.
   - `counts reporter_format only for playwright or junit (#604)`: true for
     `playwright` and `junit`; false for `vitest`, `null` and absent.
   - `counts duration_ms only when it is a finite number`: false for `null` and
     `NaN`, true for `0`.
   - `marks only order-ttff as opt-in via --order-plan`
2. Run `npx vitest run test/clocktower-consumers.test.ts`. It fails because the
   module does not exist.
3. Create `ts/src/analysis/clocktower/consumers.ts`:

   ```ts
   /**
    * The consumer table for `canary history gaps` (#610): which history
    * consumers read which fields, and over which denominator. The ONE place to
    * update when a consumer or writer changes; each row's source line is pinned
    * in ts/test/clocktower-consumers.test.ts.
    */
   import type { RunRecord, TestResultRecord } from '../../history/record.js';

   export type Scope = 'run' | 'test' | 'failed-test';

   export interface Requirement {
     field: string;
     scope: Scope;
     carried(run: RunRecord, test?: TestResultRecord): boolean;
   }

   export interface Consumer {
     id: string;
     surface: string;
     requirements: Requirement[];
     /** The writer flag that feeds an opt-in consumer. */
     optIn?: string;
   }

   // Only these readers can emit the `flaky` status (#604); a Vitest-only
   // store is structurally dark for retry flakes (G6).
   const RETRY_CAPABLE = new Set(['playwright', 'junit']);

   const text = (v: unknown): boolean => typeof v === 'string' && v.length > 0;
   const num = (v: unknown): boolean =>
     typeof v === 'number' && Number.isFinite(v);
   const obj = (v: unknown): boolean => typeof v === 'object' && v !== null;
   const retry = (v: unknown): boolean =>
     typeof v === 'string' && RETRY_CAPABLE.has(v);

   function onRun(
     field: keyof RunRecord,
     ok: (v: unknown) => boolean,
   ): Requirement {
     return { field, scope: 'run', carried: (run) => ok(run[field]) };
   }

   function onTest(
     field: keyof TestResultRecord,
     ok: (v: unknown) => boolean,
     scope: 'test' | 'failed-test' = 'test',
   ): Requirement {
     return {
       field,
       scope,
       carried: (_run, test) => test !== undefined && ok(test[field]),
     };
   }

   export const CONSUMERS: readonly Consumer[] = [
     {
       id: 'screech',
       surface: 'canary-screech, history timeline',
       requirements: [
         onRun('branch', text),
         onRun('commit_sha', text),
         onRun('timestamp', text),
       ],
     },
     {
       id: 'ci-ready-runtime',
       surface: 'canary ci-ready suite runtime',
       requirements: [onRun('duration_ms', num)],
     },
     {
       id: 'flaky-retry',
       surface: 'history flaky, analyze flaky',
       requirements: [onRun('reporter_format', retry)],
     },
     {
       id: 'area-health',
       surface: 'analyze area-health, flaky area column',
       requirements: [onTest('area', text)],
     },
     {
       id: 'failure-categories',
       surface: 'analyze spikes / common-failures',
       requirements: [onTest('failure_category', text, 'failed-test')],
     },
     {
       id: 'order',
       surface: 'canary order',
       requirements: [onTest('test_file', text), onTest('duration_ms', num)],
     },
     {
       id: 'rewind',
       surface: 'canary rewind',
       requirements: [onRun('replay', obj), onTest('start_index', num)],
     },
     {
       id: 'order-ttff',
       surface: 'canary order --report (TTFF)',
       requirements: [onRun('order', obj)],
       optIn: '--order-plan',
     },
   ];
   ```

4. Run the test again. It passes.
5. Plant a positive: add `'vitest'` to `RETRY_CAPABLE`. Confirm
   `counts reporter_format only for playwright or junit (#604)` fails, then
   revert.
6. Run `harness validate`.
7. Commit: `feat(clocktower): declare the history consumer field table (#610)`

### Task 2: Gap analyser (`gaps.ts`)

**Depends on:** Task 1 | **Files:** `ts/src/analysis/clocktower/gaps.ts`,
`ts/test/clocktower-gaps.test.ts`

1. Create `ts/test/clocktower-gaps.test.ts`. Import `analyzeGaps` from
   `../src/analysis/clocktower/gaps.js`, pass synthetic consumer tables as the
   second argument, and pass `RunRecord` literals (`run_id`, `suite`, `tests`).
   Tests:
   - `reports fed when every run carries every required field`
   - `reports dark when no run carries a required field`
   - `reports partial with carried/applicable when some runs carry it`: 2 runs,
     1 with `branch`, gives `{carried:1, applicable:2}` and `partial`.
   - `counts test-scope requirements over every test in every run`
   - `counts failed-test requirements only over failed and flaky tests`: tests
     with statuses `passed`, `failed`, `flaky` and `skipped` give
     `applicable: 2`.
   - `reports unmeasured, never fed, when the store has no failed tests` (SC4):
     uses the real `CONSUMERS`, all tests `passed`, and `failure-categories` has
     status `unmeasured`.
   - `lets unmeasured outrank dark when one requirement has no denominator`
   - `treats a run without a tests array as zero tests`
   - `totals runs and tests across the store`
   - `carries optIn through to the gap`
2. Run `npx vitest run test/clocktower-gaps.test.ts`. It fails.
3. Create `ts/src/analysis/clocktower/gaps.ts`:

   ```ts
   /** Per-consumer field coverage over a history store (#610). Pure. */
   import type { RunRecord, TestResultRecord } from '../../history/record.js';
   import { CONSUMERS } from './consumers.js';
   import type { Consumer, Requirement, Scope } from './consumers.js';

   export interface RequirementCoverage {
     field: string;
     scope: Scope;
     carried: number;
     applicable: number;
   }
   export type ConsumerStatus = 'fed' | 'partial' | 'dark' | 'unmeasured';
   export interface ConsumerGap {
     id: string;
     surface: string;
     status: ConsumerStatus;
     optIn?: string;
     coverage: RequirementCoverage[];
   }
   export interface GapReport {
     runs: number;
     tests: number;
     consumers: ConsumerGap[];
   }

   // Mirrors isFailureWithError (analysis/engine.ts:49): the rows a
   // failure_category means anything on.
   const FAILED = new Set(['failed', 'flaky']);

   function applies(scope: Scope, test: TestResultRecord): boolean {
     return scope === 'test' || FAILED.has(test.status);
   }

   function measure(
     req: Requirement,
     records: readonly RunRecord[],
   ): RequirementCoverage {
     let carried = 0;
     let applicable = 0;
     for (const run of records) {
       if (req.scope === 'run') {
         applicable += 1;
         if (req.carried(run)) carried += 1;
         continue;
       }
       for (const test of run.tests ?? []) {
         if (!applies(req.scope, test)) continue;
         applicable += 1;
         if (req.carried(run, test)) carried += 1;
       }
     }
     return { field: req.field, scope: req.scope, carried, applicable };
   }

   /** D6: no denominator is unmeasured, never fed. */
   function statusOf(cov: readonly RequirementCoverage[]): ConsumerStatus {
     if (cov.some((c) => c.applicable === 0)) return 'unmeasured';
     if (cov.every((c) => c.carried === c.applicable)) return 'fed';
     if (cov.some((c) => c.carried === 0)) return 'dark';
     return 'partial';
   }

   function gapFor(c: Consumer, records: readonly RunRecord[]): ConsumerGap {
     const coverage = c.requirements.map((r) => measure(r, records));
     const gap: ConsumerGap = {
       id: c.id,
       surface: c.surface,
       status: statusOf(coverage),
       coverage,
     };
     if (c.optIn !== undefined) gap.optIn = c.optIn;
     return gap;
   }

   export function analyzeGaps(
     records: readonly RunRecord[],
     consumers: readonly Consumer[] = CONSUMERS,
   ): GapReport {
     const tests = records.reduce((n, r) => n + (r.tests?.length ?? 0), 0);
     return {
       runs: records.length,
       tests,
       consumers: consumers.map((c) => gapFor(c, records)),
     };
   }
   ```

4. Run the test. It passes.
5. Plant a positive: move the `unmeasured` line below the `fed` line in
   `statusOf`. Confirm `lets unmeasured outrank dark …` fails. Then change
   `FAILED` to `new Set(['failed'])` and confirm
   `counts failed-test requirements only over failed and flaky tests` fails.
   Revert both.
6. Run `harness validate` and `harness check-deps` from the repo root.
7. Commit: `feat(clocktower): compute per-consumer field coverage (#610)`

### Task 3: Renderer (`render.ts`)

**Depends on:** Task 2 | **Files:** `ts/src/analysis/clocktower/render.ts`,
`ts/test/clocktower-render.test.ts`

1. Create `ts/test/clocktower-render.test.ts`. It builds `GapReport` literals
   and imports `renderGapReport` and `renderAbstention` from
   `../src/analysis/clocktower/render.js`. Tests:
   - `renders the path, run count and test count in the header`
   - `renders each requirement as carried/applicable with its scope unit`:
     `area: 0/12 tests`, `failure_category: 3/4 failed tests` and
     `branch: 2/2 runs`.
   - `renders each consumer with its status and surface`
   - `labels a dark opt-in consumer with the flag that feeds it`: the output
     contains ``dark (fed only by `history record --order-plan`)``.
   - `labels an unmeasured consumer as having no applicable rows`
   - `renders an abstention naming the reason and every consumer dark by abstention`
2. Run `npx vitest run test/clocktower-render.test.ts`. It fails.
3. Create `ts/src/analysis/clocktower/render.ts`:

   ```ts
   /** Text rendering for `canary history gaps` (#610). Pure. */
   import type { Scope } from './consumers.js';
   import type { ConsumerGap, GapReport, RequirementCoverage } from './gaps.js';

   const EM_DASH = '\u{2014}';
   const UNIT: Record<Scope, string> = {
     run: 'runs',
     test: 'tests',
     'failed-test': 'failed tests',
   };

   function statusLabel(gap: ConsumerGap): string {
     if (gap.status === 'unmeasured') return 'unmeasured (no applicable rows)';
     if (gap.status === 'dark' && gap.optIn !== undefined) {
       return `dark (fed only by \`history record ${gap.optIn}\`)`;
     }
     return gap.status;
   }

   function coverageLine(c: RequirementCoverage): string {
     return `      ${c.field}: ${c.carried}/${c.applicable} ${UNIT[c.scope]}`;
   }

   export function renderGapReport(
     report: GapReport,
     meta: { path: string },
   ): string {
     const lines = [
       `canary history gaps ${EM_DASH} ${meta.path}: ` +
         `${report.runs} run(s), ${report.tests} test(s)`,
       '',
     ];
     for (const gap of report.consumers) {
       lines.push(`  ${gap.id}: ${statusLabel(gap)} ${EM_DASH} ${gap.surface}`);
       for (const c of gap.coverage) lines.push(coverageLine(c));
     }
     return lines.join('\n');
   }

   export function renderAbstention(
     reason: string,
     consumerIds: readonly string[],
   ): string {
     return (
       `canary history gaps ${EM_DASH} ${reason}\n` +
       `  dark by abstention: ${consumerIds.join(', ')}`
     );
   }
   ```

4. Run the test. It passes.
5. Plant a positive: drop the `gap.optIn !== undefined` branch. Confirm
   `labels a dark opt-in consumer …` fails, then revert.
6. Run `harness validate`.
7. Commit: `feat(clocktower): render the gap report and abstentions (#610)`

### Task 4: `history gaps` CLI and engine mount

**Depends on:** Task 3 | **Files:** `ts/src/analysis/clocktower/cli.ts`,
`ts/src/commands/engine/cli.ts`, `ts/test/clocktower-cli.test.ts`

1. Create `ts/test/clocktower-cli.test.ts`. Use `invokeCanary`, `mkTmp` and
   `rmTmp` from `./canary-cli-testkit.js`, and seed NDJSON like
   `ts/test/history-cli-trim.test.ts:14`. Add a `fedRun(i)` helper that sets
   every consumer field:
   - `branch`, `commit_sha`, `timestamp`, `duration_ms`,
     `reporter_format:'playwright'`, `replay:{}`, `order:{}`;
   - one `failed` test with `area`, `failure_category`, `test_file`,
     `duration_ms` and `start_index`.

   Tests:
   - `exits 3 and says not found when the store path does not exist` (SC1):
     `code===3`, stdout contains `store not found:` and the path, and contains
     `Abstained`. stdout does not contain `passed`.
   - `exits 3 and says the store is empty for a zero-run store` (SC2): the file
     is `'\n'`.
   - `exits 0 when every measured consumer is fed`: 2 `fedRun`s, and stdout
     contains `All 8`.
   - `exits 1 when any consumer is dark or partial`: `fedRun` with `area`
     deleted, and stdout contains `area-health: dark`.
   - `names unmeasured consumers as skipped in the summary line` (SC4): all
     tests `passed`, and stdout contains
     `failure-categories [no applicable rows]`.
   - `names the remote store as skipped when CANARY_HISTORY_DB_URL is set`
     (SC6): `env:{CANARY_HISTORY_DB_URL:'postgres://x'}`, and stdout contains
     `remote store [local NDJSON only]`.
   - `--json emits path, abstained, runs, tests, consumers and exitCode`
   - `--json abstention carries the reason and exitCode 3`
   - `exits 1 with the reader error on a malformed store`: the file is
     `'{not json\n'`, `code===1`, and stderr contains `Cannot read`.
   - `rejects an unknown flag with usage exit 2`: `['history','gaps','--nope']`.
   - `is listed in canary history --help`

2. Run `npx vitest run test/clocktower-cli.test.ts`. It fails with an unknown
   command.
3. Create `ts/src/analysis/clocktower/cli.ts`:

   ```ts
   /**
    * `canary history gaps` (#610): which history consumers the store on disk
    * actually feeds. Mounted from ../../commands/engine/cli.ts (the #988
    * registry, `trim` precedent) so history/cli.ts -- at its arch and import
    * ceilings (#1074) -- does not grow. Named cli.ts so it binds to the `cli`
    * layer (first match on ts/src/**\/*cli*.ts) and may import cli-common.
    */
   import { existsSync } from 'node:fs';

   import type { Command } from 'commander';

   import {
     CliExitError,
     jsonIndent2,
     normalizeUsageExit,
   } from '../../cli-common.js';
   import { gateOutcome } from '../../core/gate-result.js';
   import type { SkipEntry } from '../../core/gate-result.js';
   import { NdjsonHistoryStore } from '../../history/ndjson-store.js';
   import type { RunRecord } from '../../history/record.js';
   import { CONSUMERS } from './consumers.js';
   import { analyzeGaps } from './gaps.js';
   import { renderAbstention, renderGapReport } from './render.js';

   const DEFAULT_HISTORY_FILE = 'test-results/reports/history-v2.jsonl';
   const NOUN = { noun: 'consumer check(s)' };

   interface GapsOptions {
     path?: string;
     json?: boolean;
   }
   interface GapsDeps {
     out(s: string): void;
     err(s: string): void;
     env: NodeJS.ProcessEnv;
   }

   function remoteSkip(env: NodeJS.ProcessEnv): SkipEntry[] {
     return env['CANARY_HISTORY_DB_URL']
       ? [{ name: 'remote store', reason: 'local NDJSON only' }]
       : [];
   }

   /** D7: readAll() returns [] on ENOENT, so existence is checked first. */
   function loadRecords(path: string, deps: GapsDeps): RunRecord[] | null {
     if (!existsSync(path)) return null;
     try {
       return new NdjsonHistoryStore(path).readAll();
     } catch (e) {
       deps.err(`Cannot read ${path}: ${(e as Error).message}`);
       throw new CliExitError(1);
     }
   }

   function abstain(
     path: string,
     reason: string,
     opts: GapsOptions,
     deps: GapsDeps,
   ): never {
     const ids = CONSUMERS.map((c) => c.id);
     const skipped = [
       ...ids.map((name) => ({ name, reason: 'dark by abstention' })),
       ...remoteSkip(deps.env),
     ];
     const outcome = gateOutcome({ checked: 0, findings: [], skipped }, 'gate');
     if (opts.json) {
       deps.out(
         jsonIndent2({
           path,
           abstained: true,
           reason,
           runs: 0,
           tests: 0,
           consumers: [],
           exitCode: outcome.exitCode,
         }),
       );
     } else {
       deps.out(`${renderAbstention(reason, ids)}\n${outcome.summaryLine}`);
     }
     throw new CliExitError(outcome.exitCode);
   }

   function gapsCmd(opts: GapsOptions, deps: GapsDeps): void {
     const path = opts.path ?? DEFAULT_HISTORY_FILE;
     const records = loadRecords(path, deps);
     if (records === null)
       abstain(path, `store not found: ${path}`, opts, deps);
     if (records.length === 0) {
       abstain(path, `store is empty: ${path} (0 runs)`, opts, deps);
     }
     const report = analyzeGaps(records);
     const measured = report.consumers.filter((c) => c.status !== 'unmeasured');
     const skipped = [
       ...report.consumers
         .filter((c) => c.status === 'unmeasured')
         .map((c) => ({ name: c.id, reason: 'no applicable rows' })),
       ...remoteSkip(deps.env),
     ];
     const findings = measured.filter((c) => c.status !== 'fed');
     const outcome = gateOutcome(
       { checked: measured.length, findings, skipped },
       'gate',
       NOUN,
     );
     deps.out(
       opts.json
         ? jsonIndent2({
             path,
             abstained: outcome.abstained,
             ...report,
             exitCode: outcome.exitCode,
           })
         : `${renderGapReport(report, { path })}\n\n${outcome.summaryLine}`,
     );
     if (outcome.exitCode !== 0) throw new CliExitError(outcome.exitCode);
   }

   /** Attach `gaps` to the `history` command. */
   export function registerGapsCommand(program: Command, deps: GapsDeps): void {
     const gaps = program
       .command('gaps')
       .description(
         'Report which history consumers the local store feeds, per field (#610).',
       )
       .option(
         '--path <store>',
         `Local NDJSON store to read (default: ${DEFAULT_HISTORY_FILE}).`,
       )
       .option('--json')
       .action((opts: GapsOptions) => {
         gapsCmd(opts, deps);
       });
     // Registered from outside createHistoryCommand, so it must opt in to the
     // usage-exit normalisation (2, not 1) -- see history/retention/cli.ts.
     gaps.exitOverride(normalizeUsageExit);
   }
   ```

   If `harness check-perf` flags `gapsCmd` later (Task 10), extract
   `buildResult(report, env)` returning `{checked, findings, skipped}`. Keep it
   unexported.

4. Modify `ts/src/commands/engine/cli.ts`. Add
   `import { registerGapsCommand } from '../../analysis/clocktower/cli.js';`
   after the `registerTrimCommand` import. Inside the history factory, directly
   after the `registerTrimCommand(...)` call, add:

   ```ts
   // `history gaps` (#610): same seam, same reason as `trim` above.
   registerGapsCommand(history, {
     out: deps.out,
     err: deps.err,
     env: process.env,
   });
   ```

5. Run

   ```text
   npx vitest run test/clocktower-cli.test.ts test/cli-command-registry.test.ts test/history-cli-trim.test.ts
   ```

   All pass. The registry cap is 12 imports, and this brings the file to 6.

6. Plant a positive: replace the `existsSync` guard with
   `return new NdjsonHistoryStore(path).readAll();`. Confirm
   `exits 3 and says not found …` fails, because stdout now says
   `store is empty`. Revert.
7. Run `harness validate` and `harness check-deps` from the repo root.
8. Commit:

   ```text
   feat(clocktower): add canary history gaps with the gate exit contract (#610)
   ```

### Task 5: End-to-end G1/G2 reproduction and gate-conformance rows

**Depends on:** Task 4 | **Files:** `ts/test/clocktower-e2e.test.ts`,
`ts/test/gate-conformance.test.ts`

These are test-only changes over code that already exists. The expected result
is green on the first run, so the plant-a-positive step is what proves the tests
are not vacuous.

1. Create `ts/test/clocktower-e2e.test.ts`. It copies the `playwrightReport()`
   fixture from `ts/test/history-record.test.ts:144` verbatim, and uses

   ```text
   env: { GITHUB_REPOSITORY:'acme/widgets', GITHUB_REF_NAME:'main', GITHUB_SHA:'a'.repeat(40) }
   ```

   - the test named "reproduces G1 and G2 on a store written by history record
     from a Playwright report" (SC5):
     1. `invokeCanary(['history','record',src,'--suite','web'],{cwd,env})`
        returns code 0.
     2. `invokeCanary(['history','gaps','--json'],{cwd,env})` returns code 1.
     3. The parsed consumers have `area-health` with `status:'dark'` and
        coverage `{carried:0, applicable:3}`, and `failure-categories` with
        `status:'dark'` and `applicable:2` (one failed plus one flaky).
   - `reports flaky-retry fed for a Playwright-recorded store`, which checks the
     positive direction (`reporter_format` is written).

2. In `ts/test/gate-conformance.test.ts`, append two rows to `ROWS` after the
   `history timeline (zero runs recorded)` row:

   ```ts
   {
     command: 'history gaps (store path does not exist)',
     layer: 'engine',
     kind: 'gate',
     expect: 'exit3',
     forbid: ['passed'],
     run: (base) =>
       invokeCanary(['history', 'gaps', '--path', join(base, 'missing.jsonl')]),
   },
   // #610: a DIFFERENT zero -- readAll() returns [] for both, so only the
   // existsSync check keeps "not found" from reading as "empty".
   {
     command: 'history gaps (store exists with zero runs)',
     layer: 'engine',
     kind: 'gate',
     expect: 'exit3',
     forbid: ['passed'],
     run: (base) => {
       const path = join(base, 'empty.jsonl');
       writeFileSync(path, '', 'utf-8');
       return invokeCanary(['history', 'gaps', '--path', path]);
     },
   },
   ```

3. Run
   `npx vitest run test/clocktower-e2e.test.ts test/gate-conformance.test.ts`.
   All pass.
4. Plant a positive: in `consumers.ts`, change the `failure-categories`
   predicate to `onTest('failure_category', () => true, 'failed-test')`. Confirm
   `reproduces G1 and G2 …` fails. Revert.
5. Run `git diff --stat 47745970 -- ts/src/history`. It prints nothing (SC7).
6. Run `harness validate`.
7. Commit:
   `test(clocktower): reproduce G1/G2 end to end and register gate rows (#610)`

### Task 6: Ratchet registrations and `docs/history-gaps.md`

**Depends on:** Task 4 | **Files:** `harness.config.json`,
`docs/history-gaps.md` | **Category:** integration

1. In `harness.config.json`, insert these three lines directly after
   `"ts/src/analysis/batwoman/verdict.ts",` in BOTH `entropy.entryPoints` (near
   line 175) and `performance.entryPoints` (near line 310):

   ```json
   "ts/src/analysis/clocktower/consumers.ts",
   "ts/src/analysis/clocktower/gaps.ts",
   "ts/src/analysis/clocktower/render.ts",
   ```

2. Create `docs/history-gaps.md` with these sections:
   - H1 `# canary history gaps — run-history field coverage (#610)`.
   - Usage fences:
     - `canary history gaps --help`
     - `<!-- canary:illustrative -->` above
       `canary history gaps --path test-results/reports/history-v2.jsonl --json`
   - The exit-code table: 0 all measured consumers fed; 1 any dark or partial,
     or an unreadable store; 2 usage; 3 abstained (missing or empty store).
   - The status rule, D6 on unmeasured, and D8 on the remote store.
   - The consumer table from the spec.
   - The gap list G1–G6 from the spec.
   - A "Source" list of markdown LINKS. Backtick paths do not count for the docs
     ratchet:
     - `[consumers.ts](../ts/src/analysis/clocktower/consumers.ts)`
     - `[gaps.ts](../ts/src/analysis/clocktower/gaps.ts)`
     - `[render.ts](../ts/src/analysis/clocktower/render.ts)`
     - `[cli.ts](../ts/src/analysis/clocktower/cli.ts)`
     - the spec `[proposal](changes/610-canary-clocktower/proposal.md)`
3. Run `npx prettier --write docs/history-gaps.md harness.config.json`. Run it
   only on these files, never on a glob.
4. Run `node scripts/check_doc_links.mjs` from the repo root. It exits 0.
5. Run

   ```text
   npx --yes -p @harness-engineering/cli harness cleanup --findings-json > /private/tmp/claude-501/entropy-head.txt || true
   ```

   then `grep -c clocktower` on that file. The count is 0. If `cli.ts` shows a
   dead-export finding, add it to both arrays too and note that in the commit
   body.

6. Run `harness validate`.
7. Commit:
   `chore(clocktower): register entry points and document history gaps (#610)`

### Task 7: The `/canary-clocktower` skill and registries

**Depends on:** Task 6 | **Files:**
`agents/skills/claude-code/canary-clocktower/SKILL.md`,
`agents/skills/README.md`, `docs/naming-registry.md` | **Category:** integration

1. Create `agents/skills/claude-code/canary-clocktower/SKILL.md`, a thin skill
   over the CLI (shape of `canary-batwoman/SKILL.md`):

   ```markdown
   ---
   name: canary-clocktower
   description:
     Run-history gap analysis — reports, for the history store on disk, which
     consumers (analyze area-health, spikes, ci-ready runtime, flaky retry,
     order, rewind, screech) are fed, partial, dark or unmeasured, per required
     field with denominators. Use when a history-backed report looks thin or
     one-bucket, after wiring `canary history record`, or when asking "what does
     our run history not carry". Read-only; exits 0 fed, 1 gaps, 3 abstained.
     NOT a writer (it fills no field), NOT a remote-store analyser (local NDJSON
     only), NOT a flake detector.
   cli: canary history gaps
   requires: [node>=20]
   ---
   ```

   The body has these sections:
   - **Why:** three fields declared, read, and written by no writer.
   - **Usage:** a `bash` fence containing `canary history gaps --help`. This is
     the executable example `ts/src/core/skill-examples.ts` requires of a `cli:`
     skill. Add a `<!-- canary:illustrative -->` fence containing
     `canary history gaps --path test-results/reports/history-v2.jsonl --json`.
   - **Exit codes** table.
   - **Reading the output:** fed, partial, dark and unmeasured, and an opt-in
     consumer.
   - A link to `[docs/history-gaps.md](../../../../docs/history-gaps.md)`.

2. In `agents/skills/README.md`:
   - Add `│   ├── canary-clocktower/` to the tree, alphabetically after
     `canary-ci-ready/`, and change `# Claude Code skills (27)` to `(28)`.
   - Add a section after `### Closure auditing`:

     ```markdown
     ### Run-history gap analysis

     - [`canary-clocktower`](./claude-code/canary-clocktower/SKILL.md) — Reports
       which run-history consumers the store on disk actually feeds, per
       required field with denominators, and abstains loudly on a missing or
       empty store. Deterministic, no network, no agent.
     ```

3. In `docs/naming-registry.md`, change the row `| \`canary-clocktower\` |
   reserved | 610 | Run-history gap analysis |`to`shipped`.
4. Run

   ```text
   npx prettier --write agents/skills/claude-code/canary-clocktower/SKILL.md agents/skills/README.md docs/naming-registry.md
   ```

5. From `ts/`, run `npm run build`. The skill-examples check execs the built
   CLI. Then run

   ```text
   npx vitest run test/bop-name-registry.test.ts test/skill-examples.test.ts test/skill-surfaces.test.ts test/skill-registry.test.ts test/skill-packaging.test.ts test/skill-cli-executable.test.ts test/doc-links.test.ts
   ```

   All pass.

6. From `agents/skills/`, run

   ```text
   npx vitest run test/skill-cli-conformance.test.ts test/gate-conformance.test.ts
   ```

   All pass. `cli: canary history gaps` has spaces, so the `^cli:\s*(\S+)\s*$`
   discovery regex skips it, exactly as it skips `cli: canary batwoman`.

7. Run `node ts/bin/canary.js skills list | grep canary-clocktower`. It prints
   one line.
8. Run `harness validate`.
9. Commit:

   ```text
   feat(clocktower): ship the canary-clocktower skill and mark the name shipped (#610)
   ```

### Task 8: Reporter wiring (G4) and knowledge entry

**Depends on:** Task 6 | **Files:**
`agents/skills/claude-code/canary-test-reporter/SKILL.md`,
`docs/knowledge/gates/consumer-field-coverage.md` | **Category:** integration

1. In `canary-test-reporter/SKILL.md`, append a `## Persisting runs` section:

   ````markdown
   ## Persisting runs

   This skill renders a report; it writes nothing to run history. The same
   Playwright JSON is persisted by `canary history record`, which appends one
   run to `test-results/reports/history-v2.jsonl` for the cross-run consumers
   (`history flaky`, `analyze`, `ci-ready`, `order`, `rewind`, canary-screech):

   <!-- canary:illustrative -->

   ```bash
   canary history record test-results/results.json --suite e2e
   ```

   Run `canary history gaps` afterwards to see which of those consumers the
   recorded fields actually feed (see
   [canary-clocktower](../canary-clocktower/SKILL.md)).
   ````

2. Create `docs/knowledge/gates/consumer-field-coverage.md`, in the frontmatter
   shape of `docs/knowledge/gates/false-green-detection.md`:
   - `type: business_rule`, `domain: gates`, `source: authored`, and `related:`
     `docs/knowledge/gates/false-green-detection.md` and `docs/history-gaps.md`.
   - Body rule: "A history consumer is only as live as the least-populated field
     it reads. A field with no applicable rows is unmeasured, never fed (#610
     D6, the #508 denominator doctrine)."
   - A link to `[gaps.ts](../../../ts/src/analysis/clocktower/gaps.ts)`.
3. Run prettier on both files, then run `node scripts/check_doc_links.mjs`. It
   exits 0.
4. From `ts/`, run `npx vitest run test/skill-examples.test.ts`. It passes, and
   the new fence is classified illustrative, not unverifiable.
5. Run `harness validate`.
6. Commit:

   ```text
   docs(clocktower): point test-reporter at history record and record the coverage rule (#610)
   ```

### Task 9: File the G1–G3 writer follow-up

**Depends on:** Task 5 | **Files:** none (tracker) | **Category:** integration |
`[checkpoint:human-action]` only if `gh` auth fails

1. Run

   ```text
   gh issue create --repo bop-clocktower/canary --title "history writers never fill area, failure_category, tags (G1-G3 from #610)" --body-file <scratch>
   ```

   The body contains:
   - G1–G3 rows from `docs/history-gaps.md`;
   - the readers they need to change (`ts/src/history/formats/*`);
   - that `ts/src/history` has zero arch headroom (#1074), so a paydown must
     come first;
   - the acceptance: `canary history gaps` reports `area-health` and
     `failure-categories` as `fed` on a Playwright-recorded store.

   Write it WITHOUT any closing keyword next to an issue number.

2. Add the new issue number to the G1–G3 "Disposition" cells in
   `docs/history-gaps.md` as a link. Run prettier.
3. Commit: `docs(clocktower): link the G1-G3 writer follow-up issue (#610)`

### Task 10: Gates and ratchets against the merge base

**Depends on:** Tasks 1–9 | **Files:** none (verification) |
`[checkpoint:human-verify]` if any ratchet is red

1. Free disk space first (see Uncertainties). Then, from
   `/Users/bs/Github/canary-fleet-610-clocktower/ts`, run:
   `npm run build && npm run typecheck && npm run format:check && npm test`. All
   four must pass. Read the vitest totals: a zero-test count is an abstention.
2. From `/Users/bs/Github/canary-fleet-610-clocktower/agents/skills`, run
   `npm test && npm run typecheck && npm run format:check`.
3. Create the base worktree:

   ```text
   git -C /Users/bs/Github/canary-fleet-610-clocktower worktree add --detach /Users/bs/Github/canary-610-base 47745970
   ```

   Verify that this equals `git merge-base HEAD origin/main` after `git fetch`.
   If main moved, use the new merge base.

4. In each tree (head and base), from the ROOT, run the four ratchets:

   ```sh
   harness cleanup --findings-json > /private/tmp/claude-501/entropy-<side>.txt || true
   harness check-perf > /private/tmp/claude-501/perf-<side>.txt 2>&1 || true
   harness check-arch --json > /private/tmp/claude-501/arch-<side>.json || true
   harness check-docs --json --min-coverage 0 > /private/tmp/claude-501/docs-<side>.json || true
   ```

   Then compare from the head root:

   ```sh
   node scripts/entropy-ratchet.mjs --report /private/tmp/claude-501/entropy-head.txt --base-report /private/tmp/claude-501/entropy-base.txt
   node scripts/perf-ratchet.mjs --report /private/tmp/claude-501/perf-head.txt --base-report /private/tmp/claude-501/perf-base.txt
   node scripts/docs-ratchet.mjs --report /private/tmp/claude-501/docs-head.json --base-report /private/tmp/claude-501/docs-base.json
   harness check-docs --min-coverage 3
   ```

   Each must exit 0. For arch, diff the `module-size`, `complexity` and
   `layer-violations` values:
   - any NEW `cyclomaticComplexity` on a clocktower function means fix the code;
   - `module-size` growth only means the PR gets the `refresh-baseline` label at
     ship time.

5. Confirm SC7 again: `git diff --stat 47745970 -- ts/src/history` is empty.
6. Remove the base worktree:

   ```text
   git -C /Users/bs/Github/canary-fleet-610-clocktower worktree remove /Users/bs/Github/canary-610-base
   ```

7. No commit, unless a ratchet forced a fix. A fix commit is
   `fix(clocktower): <what> to hold the <ratchet> ratchet (#610)`.

## Traceability

| Truth | Task(s)                   |
| ----- | ------------------------- |
| 1     | 4 (unit), 5 (conformance) |
| 2     | 4, 5                      |
| 3     | 2, 3, 4                   |
| 4     | 2, 4                      |
| 5     | 5                         |
| 6     | 4                         |
| 7     | 5, 10                     |
| 8     | 10                        |
| 9     | 5                         |
| 10    | 7                         |

Spec integration points: entry points (Tasks 4 and 7), registrations (Tasks 5, 6
and 7), docs (Tasks 6 and 8), knowledge impact (Task 8), ADR none (spec). The
follow-up is Task 9.

## Parallelism

- Tasks 1 → 2 → 3 → 4 → 5 are sequential.
- Tasks 6, 8 and 9 are independent of each other once their dependencies land.
- Task 7 needs Task 6's doc to link to.
- Task 10 is last.
