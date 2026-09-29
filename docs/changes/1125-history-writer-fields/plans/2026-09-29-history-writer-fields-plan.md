# Plan: History writers fill `area` and `failure_category` (#1125)

**Date:** 2026-09-29 | **Spec:** [proposal.md](../proposal.md) | **Tasks:** 9 |
**Time:** ~40 min | **Integration Tier:** medium | **Rigor:** standard

## Goal

`canary history record` stores `area` (from `.canary/critical-areas.json`) and
`failure_category` (the canary-fail-fast vocabulary) on each test at record
time, through an enricher in `ts/src/analysis/enrich/` that is injected into the
recorder. Without an areas file it abstains out loud on stderr.

## Observable Truths (Acceptance Criteria)

1. When `history record` runs in a directory whose `.canary/critical-areas.json`
   has an area with the same file stem as a test file, the system shall store
   that area's `path` as the test's `area`. (Tasks 2, 3, 6)
2. If `.canary/critical-areas.json` is absent, unreadable, malformed or lists no
   areas, then the system shall not write `area`, and `record` shall print one
   `note: area not recorded: …` line naming the file on stderr. The exit code
   does not change. (Tasks 3, 5, 6)
3. When a failed or flaky row carries `error_text`, the system shall store
   `categorizeFailure(error_text)` as `failure_category`. If a row has no
   `error_text`, then the system shall not write `failure_category`. (Task 3)
4. `categorizeFailure` and `FAILURE_CATEGORIES` in the engine agree with
   `agents/skills/claude-code/canary-fail-fast/scripts/failures.mjs` on a shared
   sample set that produces all seven categories. (Task 1)
5. When a Playwright test is flaky, the system shall store the error message of
   its last failing attempt as `error_text`. (Task 4)
6. On a store recorded from the e2e Playwright fixture with a matching areas
   file, `canary history gaps --json` reports `flaky-area`, `screech-cluster`
   and `failure-categories` as `fed` and exits 0. Without the file, `flaky-area`
   and `screech-cluster` are `dark`, `failure-categories` stays `fed`, and the
   `record` stderr carries the note. (Task 6)
7. `createHistoryCommand` without `enrichResults` records rows unchanged: the
   `history` module works without `analysis`. (Task 5)
8. `harness check-arch` shows no new violation, and the entropy, perf and docs
   ratchets pass against the merge base. The four gates pass from `ts/`
   (`npm run build`, `npm run typecheck`, `npm run format:check`, `npm test`).
   (Tasks 8, 9)
9. `docs/guides/history-gaps.md` records G1, G2 and G8 as fixed in #1125 and G3
   as an opt-in field with no automatic writer. The `history record` row of
   `README.md` names the areas input and the note. (Task 7)

## Evidence (verified before planning)

- Recorder flow: `ts/src/history/record/cli.ts` `recordCmd` → `buildOrRefuse` →
  `prepareRecordedRun` (keys `test_file` repo-relative) →
  `store.pushRun(built.run, built.results)`. `prepareRecordedRun` returns
  `KeyedRun` (`ts/src/history/keys/test-file-key.ts:118`,
  `extends BuiltRun { unjoinable }`).
- `HistoryDeps` is at `ts/src/history/cli-deps.ts:21-29` and already has
  `cwd()`. `createHistoryCommand(depsInit: Partial<HistoryDeps>)` merges it over
  defaults (`ts/src/history/cli.ts:41-44`).
- Production wiring: `ts/src/commands/engine/cli.ts:25`,
  `createHistoryCommand({ out: deps.out, err: deps.err })`. The registry has 6
  imports against a cap of 12 (`ts/test/cli-command-registry.test.ts`).
- Layers: `history` may import only `core`/`util`. `analysis` may import
  `history`/`core`/`util`. Any `ts/src/**/*cli*.ts` file is in the `cli` layer.
- `parseCriticalAreas(text | null)` is at `ts/src/core/inventory-checks.ts:97`.
  It returns `{ ok: true, areas: CriticalArea[] } | { ok: false, reason }`, and
  its reasons already name `.canary/critical-areas.json`.
- The categoriser to port is
  `agents/skills/claude-code/canary-fail-fast/scripts/failures.mjs`
  (`FAILURE_CATEGORIES`, `RULES`, `categorizeFailure`). The precedent for a
  `ts/test` file that dynamically imports a repo `.mjs` is
  `ts/test/test-duration-ratchet.test.ts:69-86`.
- G8: in `ts/src/history/formats/playwright-report.ts:150-156`, `errorText()`
  reads the last attempt only. Line 172 keeps it only for `status === 'failed'`.
  `ts/test/history-record-playwright.test.ts` ("keeps the failure message only
  for a failed test") pins the current behaviour and gets inverted.
- Gaps status rule (`ts/src/analysis/clocktower/gaps.ts:70-72`): `fed` when
  every requirement has `carried === applicable`. An opt-in dark consumer is
  skipped, not counted (`clocktower/cli.ts:108-112`). With areas, `order-ttff`
  is the only non-fed consumer and it is opt-in, so `gaps` exits 0
  (`core/gate-result.ts:139-160`).
- No existing `history record` test asserts empty stderr (checked with grep over
  `ts/test/history-record*.test.ts`, `history-replay-capture.test.ts` and
  `gate-conformance.test.ts`). The new `note:` line on every production `record`
  run without an areas file breaks none of them.
- Baseline on this branch (b6a94865): `harness validate` passes,
  `harness check-deps` passes (229 modules, 11 layers), and
  `harness check-arch --json` has `regressions: []` and `newViolations: []`. The
  12 threshold violations are pre-existing complexity findings. Module-size
  thresholds are `maxLoc 1800`, `maxFiles 12`, and module-size is a repo-wide
  aggregate (baseline value 48452).

## Uncertainties

- [ASSUMPTION] A critical-areas file that parses but lists **zero** areas is
  treated as unusable. It gets a note like an absent file, because it can map
  nothing and staying silent would be a silent empty (spec Goal 3 in spirit). If
  the maintainer disagrees, drop the `areas.length === 0` branch in Task 3.
- [ASSUMPTION] A read error other than ENOENT (EISDIR, EACCES) becomes a note,
  not a crash. `record` must never fail over an optional input (the same rule as
  `--order-plan`, `replay-context.ts:208`).
- [ASSUMPTION] The G8 change selects "the last attempt that carries an error".
  For a `failed` test whose final attempt has no error object but an earlier one
  does, this now stores the earlier message where it used to store nothing. That
  is strictly more evidence and no test pins the old behaviour.
- [ASSUMPTION] The enricher overwrites nothing that matters: no reader sets
  `area` or `failure_category` today (verified in `formats/`), so no "keep the
  existing value" guard is needed (YAGNI).
- [DEFERRABLE] `flaky-area` and `screech-cluster` are not opt-in consumers. A
  store recorded without an areas file still counts them as findings (`gaps`
  exits 1). Spec criterion 6 requires exactly that (the no-file case is `dark`).
  Marking them `optIn: '.canary/critical-areas.json'` would be a spec change, so
  it is out of scope. Noted for the maintainer.
- [DEFERRABLE] The exact arch module-size allowance value and whether entropy
  flags any new export. Both are measured in Task 8, not predicted.
- [DEFERRABLE] Knowledge pipeline (`--fix`): not run during planning. This lane
  forbids commits, and the spec's Knowledge Impact is carried by the Task 7
  docs. Run it at execution if the lane allows.

## File Map

- CREATE `ts/src/analysis/enrich/failure-category.ts`
- CREATE `ts/src/analysis/enrich/area.ts`
- CREATE `ts/src/analysis/enrich/enrich.ts`
- CREATE `ts/test/enrich-failure-category.test.ts`
- CREATE `ts/test/enrich-area.test.ts`
- CREATE `ts/test/enrich-recorded-results.test.ts`
- CREATE `ts/test/history-record-enrich.test.ts`
- MODIFY `ts/src/history/formats/playwright-report.ts` (G8)
- MODIFY `ts/test/history-record-playwright.test.ts` (invert the G8 pin)
- MODIFY `ts/src/history/cli-deps.ts` (optional `enrichResults`)
- MODIFY `ts/src/history/record/cli.ts` (apply it, print notes)
- MODIFY `ts/src/commands/engine/cli.ts` (production wiring)
- MODIFY `ts/test/clocktower-e2e.test.ts` (G1/G2 repro → positive plus no-file
  case)
- MODIFY `docs/guides/history-gaps.md` (Known gaps and Source links)
- MODIFY `README.md` (`history record` row)
- CONDITIONAL `.harness/arch/allowances/feat-1125-history-writer-fields.json`
  plus `.harness/arch/baselines.json` (only if check-arch regresses)
- CONDITIONAL `harness.config.json` (both `entryPoints` arrays, only if entropy
  flags a new file)

## Skeleton

1. Enrich module, TDD (~3 tasks, ~14 min): categoriser port plus parity, area
   matcher, enricher.
2. History seam (~2 tasks, ~8 min): G8 reader fix, `HistoryDeps.enrichResults`
   plus the record call.
3. Wiring and e2e (~1 task, ~5 min): engine registry, and the inverted
   clocktower e2e.
4. Integration (~3 tasks, ~13 min): docs, ratchets, final gates.

**Estimated total:** 9 tasks, ~40 min. _Skeleton status: this lane is autonomous
and the spec's Implementation order already fixes this direction. Presented to
the caller with the plan; not separately approved._

Parallel waves: **A** = Tasks 1, 2, 4, 5 (disjoint files). **B** = Task 3. **C**
= Task 6. Then 7 → 8 → 9 in sequence.

## Tasks

All commands run from `ts/` unless the step says repo root.

### Task 1: Port the failure categoriser with a parity test

**Depends on:** none | **Files:** `ts/src/analysis/enrich/failure-category.ts`,
`ts/test/enrich-failure-category.test.ts`

1. Create `ts/test/enrich-failure-category.test.ts`:

   ```ts
   /**
    * The engine's failure categoriser (#1125) is a rule-for-rule port of
    * canary-fail-fast's `failures.mjs`. This pins the two together: one
    * vocabulary engine-wide, never two drifting copies.
    */
   import { dirname, join } from 'node:path';
   import { fileURLToPath, pathToFileURL } from 'node:url';

   import { describe, expect, it } from 'vitest';

   import {
     FAILURE_CATEGORIES,
     categorizeFailure,
   } from '../src/analysis/enrich/failure-category.js';

   interface SkillFailures {
     FAILURE_CATEGORIES: string[];
     categorizeFailure(error: string | null | undefined): string;
   }

   const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
   const SCRIPT = join(
     REPO_ROOT,
     'agents/skills/claude-code/canary-fail-fast/scripts/failures.mjs',
   );
   const skill = (await import(pathToFileURL(SCRIPT).href)) as SkillFailures;

   // Chosen so every category is produced, and so the precedence rules are
   // exercised: schema outranks server, auth outranks timeout.
   const SAMPLES = [
     'ZodError: invalid_type at path "user.id"',
     'expected string, received number',
     'schema check failed with 500 and ZodError',
     'Request failed with status 401',
     '403 Forbidden',
     'token expired',
     'timed out waiting for 401',
     'Timeout 30000ms exceeded',
     'connect ECONNREFUSED 127.0.0.1:5432',
     'getaddrinfo ENOTFOUND api.example',
     '500 Internal Server Error',
     '502 Bad Gateway',
     '404 Not Found',
     '422 Unprocessable Entity',
     'response 409 conflict',
     'expected 3, got 4',
     '',
   ];

   describe('categorizeFailure (engine port of canary-fail-fast)', () => {
     it('declares the same vocabulary as the skill script', () => {
       expect([...FAILURE_CATEGORIES]).toEqual(skill.FAILURE_CATEGORIES);
     });

     it('agrees with the skill script on every sample', () => {
       for (const s of SAMPLES) {
         expect([s, categorizeFailure(s)]).toEqual([
           s,
           skill.categorizeFailure(s),
         ]);
       }
     });

     it('produces all seven categories over the samples (parity is not vacuous)', () => {
       const seen = new Set(SAMPLES.map((s) => categorizeFailure(s)));
       expect([...seen].sort()).toEqual([...FAILURE_CATEGORIES].sort());
     });

     it('falls back to other for missing text', () => {
       expect(categorizeFailure(undefined)).toBe('other');
       expect(categorizeFailure(null)).toBe('other');
     });
   });
   ```

2. Run `npx vitest run test/enrich-failure-category.test.ts`. It should fail
   because the module does not exist.
3. Create `ts/src/analysis/enrich/failure-category.ts`:

   ```ts
   /**
    * Heuristic failure categorisation for run-history rows (#1125).
    *
    * A rule-for-rule port of canary-fail-fast's `scripts/failures.mjs`, the one
    * categoriser canary ships, so `failure_category` means the same thing in
    * the store as in the fail-fast digest. `ts/test/enrich-failure-category.test.ts`
    * pins the two together. Change both, or neither.
    *
    * Order matters: the most distinctive signals are checked first, so a
    * status code quoted inside a schema error does not read as `server`.
    */

   export const FAILURE_CATEGORIES = [
     'schema',
     'auth',
     'server',
     'client',
     'timeout',
     'network',
     'other',
   ] as const;

   export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

   // [category, pattern] in match-priority order (not display order).
   // Case-insensitive, no `g` flag, so `test` is stateless.
   const RULES: ReadonlyArray<readonly [FailureCategory, RegExp]> = [
     [
       'schema',
       /ZodError|invalid[_ ]type|unrecognized key|expected .+ received|at path "|\bzod\b/i,
     ],
     [
       'auth',
       /\b401\b|unauthorized|\b403\b|forbidden|invalid(?: auth)? token|token expired/i,
     ],
     ['timeout', /timeout|timed out|etimedout|deadline exceeded/i],
     [
       'network',
       /econnrefused|enotfound|econnreset|socket hang up|getaddrinfo|network request failed/i,
     ],
     [
       'server',
       /\b5\d{2}\b|internal server error|bad gateway|service unavailable|gateway timeout/i,
     ],
     [
       'client',
       /\b4(?:0[045-9]|1\d|2\d)\b|bad request|not found|unprocessable|conflict/i,
     ],
   ];

   /** The category of a failure message; `other` when nothing matches. */
   export function categorizeFailure(
     error: string | null | undefined,
   ): FailureCategory {
     if (!error) return 'other';
     for (const [category, pattern] of RULES) {
       if (pattern.test(error)) return category;
     }
     return 'other';
   }
   ```

4. Run `npx vitest run test/enrich-failure-category.test.ts`. Expect 4 passing
   tests. If "all seven categories" fails, fix the SAMPLES. Never weaken the
   assertion.
5. Run `harness validate` from the repo root.
6. Commit:

   ```text
   feat(analysis): port the canary-fail-fast failure categoriser to the engine (#1125)
   ```

### Task 2: Area matcher

**Depends on:** none | **Files:** `ts/src/analysis/enrich/area.ts`,
`ts/test/enrich-area.test.ts`

1. Create `ts/test/enrich-area.test.ts`:

   ```ts
   /** D8 of #1125: test file -> critical-area path by file stem. */
   import { describe, expect, it } from 'vitest';

   import { areaFor } from '../src/analysis/enrich/area.js';

   const area = (path: string, risk_score = 1) => ({ path, risk_score });

   describe('areaFor', () => {
     it('maps a .spec file to the area with the same stem', () => {
       expect(areaFor('checkout.spec.ts', [area('src/checkout.ts')])).toBe(
         'src/checkout.ts',
       );
     });

     it('strips a .test marker as well as the extension', () => {
       expect(areaFor('test/cart.test.ts', [area('src/cart.tsx')])).toBe(
         'src/cart.tsx',
       );
     });

     it('returns undefined when no area shares the stem', () => {
       expect(areaFor('checkout-flow.spec.ts', [area('src/checkout.ts')])).toBe(
         undefined,
       );
       expect(areaFor('checkout.spec.ts', [])).toBe(undefined);
     });

     it('prefers the candidate sharing more trailing directory segments', () => {
       const areas = [
         area('src/cart/checkout.ts', 9),
         area('src/billing/checkout.ts', 1),
       ];
       expect(areaFor('e2e/billing/checkout.spec.ts', areas)).toBe(
         'src/billing/checkout.ts',
       );
     });

     it('breaks a directory tie by risk_score, then by path', () => {
       expect(
         areaFor('checkout.spec.ts', [
           area('a/checkout.ts', 1),
           area('b/checkout.ts', 5),
         ]),
       ).toBe('b/checkout.ts');
       expect(
         areaFor('checkout.spec.ts', [
           area('b/checkout.ts', 2),
           area('a/checkout.ts', 2),
         ]),
       ).toBe('a/checkout.ts');
     });
   });
   ```

2. Run `npx vitest run test/enrich-area.test.ts`. It should fail because the
   module does not exist.
3. Create `ts/src/analysis/enrich/area.ts`:

   ```ts
   /**
    * Map a recorded test file to a critical area (#1125, decision D8).
    *
    * `area` in the history store means "the critical area this test file maps
    * to" in `.canary/critical-areas.json`. Candidates share the test's file
    * stem (extension and a `.test`/`.spec` marker stripped). Among them, the
    * area sharing the most trailing directory segments wins, then the higher
    * `risk_score`, then the lexically smaller path, so the choice is
    * deterministic.
    */
   import type { CriticalArea } from '../../core/inventory-checks.js';

   function fileStem(path: string): string {
     const base = path.split('/').pop() ?? path;
     return base.replace(/\.[^.]+$/, '').replace(/\.(test|spec)$/, '');
   }

   /** How many trailing directory segments two paths have in common. */
   function sharedTrailingDirs(a: string, b: string): number {
     const x = a.split('/').slice(0, -1).reverse();
     const y = b.split('/').slice(0, -1).reverse();
     let n = 0;
     while (n < x.length && n < y.length && x[n] === y[n]) n++;
     return n;
   }

   interface Candidate {
     area: CriticalArea;
     shared: number;
   }

   function byRank(p: Candidate, q: Candidate): number {
     if (p.shared !== q.shared) return q.shared - p.shared;
     if (p.area.risk_score !== q.area.risk_score) {
       return q.area.risk_score - p.area.risk_score;
     }
     return p.area.path < q.area.path ? -1 : 1;
   }

   /** The matched area's `path`, or undefined when no area shares the stem. */
   export function areaFor(
     testFile: string,
     areas: readonly CriticalArea[],
   ): string | undefined {
     const stem = fileStem(testFile);
     const ranked = areas
       .filter((a) => fileStem(a.path) === stem)
       .map((a) => ({ area: a, shared: sharedTrailingDirs(testFile, a.path) }))
       .sort(byRank);
     return ranked[0]?.area.path;
   }
   ```

4. Run `npx vitest run test/enrich-area.test.ts`. Expect 5 passing tests.
5. Run `harness validate` from the repo root.
6. Commit:
   `feat(analysis): map test files to critical areas by file stem (#1125)`

### Task 3: Record-time enricher

**Depends on:** Task 1, Task 2 | **Files:** `ts/src/analysis/enrich/enrich.ts`,
`ts/test/enrich-recorded-results.test.ts`

1. Create `ts/test/enrich-recorded-results.test.ts`:

   ```ts
   /** The #1125 enricher: area from critical-areas.json, category from error text. */
   import { mkdirSync, writeFileSync } from 'node:fs';
   import { join } from 'node:path';

   import { afterEach, beforeEach, describe, expect, it } from 'vitest';

   import { enrichRecordedResults } from '../src/analysis/enrich/enrich.js';
   import type { TestResultInput } from '../src/history/schema.js';
   import { mkTmp, rmTmp } from './canary-cli-testkit.js';

   const row = (
     test_name: string,
     status: string,
     error_text?: string,
   ): TestResultInput => ({
     run_id: 'r1',
     suite: 'web',
     repo: 'acme/widgets',
     test_name,
     test_file: 'e2e/checkout.spec.ts',
     status,
     ...(error_text === undefined ? {} : { error_text }),
   });

   const ROWS = [
     row('passes', 'passed'),
     row('fails', 'failed', 'Request failed with status 401'),
     row('flakes', 'flaky', 'Timeout 5000ms exceeded'),
     row('fails silently', 'failed'),
   ];

   let tmp: string;
   beforeEach(() => {
     tmp = mkTmp();
   });
   afterEach(() => {
     rmTmp(tmp);
   });

   function writeAreas(text: string): void {
     mkdirSync(join(tmp, '.canary'), { recursive: true });
     writeFileSync(join(tmp, '.canary', 'critical-areas.json'), text, 'utf-8');
   }

   describe('enrichRecordedResults', () => {
     it('sets area on every mapped test and no note', () => {
       writeAreas(
         JSON.stringify({
           areas: [{ path: 'src/checkout.ts', risk_score: 3 }],
         }),
       );
       const { results, notes } = enrichRecordedResults(ROWS, tmp);
       expect(results.map((r) => r.area)).toEqual(
         Array(4).fill('src/checkout.ts'),
       );
       expect(notes).toEqual([]);
     });

     it('categorises failed and flaky rows that carry error text, and only those', () => {
       const { results } = enrichRecordedResults(ROWS, tmp);
       expect(results.map((r) => r.failure_category)).toEqual([
         undefined,
         'auth',
         'timeout',
         undefined,
       ]);
       // D6: no evidence, no key -- `other` here would be a false `fed`.
       expect('failure_category' in results[3]!).toBe(false);
     });

     it('abstains with a note naming the file when it is absent', () => {
       const { results, notes } = enrichRecordedResults(ROWS, tmp);
       expect(results.some((r) => 'area' in r)).toBe(false);
       expect(notes).toHaveLength(1);
       expect(notes[0]).toContain('area not recorded');
       expect(notes[0]).toContain('.canary/critical-areas.json');
     });

     it('abstains when the file is malformed, empty of areas, or unreadable', () => {
       writeAreas('{}');
       expect(enrichRecordedResults(ROWS, tmp).notes[0]).toContain(
         'has no areas list',
       );
       writeAreas('{"areas":[]}');
       expect(enrichRecordedResults(ROWS, tmp).notes[0]).toContain(
         'lists no areas',
       );
       rmTmp(join(tmp, '.canary'));
       mkdirSync(join(tmp, '.canary', 'critical-areas.json'), {
         recursive: true,
       });
       expect(enrichRecordedResults(ROWS, tmp).notes[0]).toContain(
         'could not be read',
       );
     });

     it('does not mutate the rows it was given', () => {
       const before = JSON.stringify(ROWS);
       enrichRecordedResults(ROWS, tmp);
       expect(JSON.stringify(ROWS)).toBe(before);
     });
   });
   ```

2. Run `npx vitest run test/enrich-recorded-results.test.ts`. It should fail
   because the module does not exist.
3. Create `ts/src/analysis/enrich/enrich.ts`:

   ```ts
   /**
    * Record-time enrichment for `canary history record` (#1125).
    *
    * Fills the two fields the format readers cannot know. `area` comes from
    * `.canary/critical-areas.json` (see `area.ts`). `failure_category` comes
    * from the row's own error text (see `failure-category.ts`). It lives in
    * `analysis`, not `history`, and reaches the recorder through the optional
    * `HistoryDeps.enrichResults` seam, which the engine registry
    * (`commands/engine/cli.ts`) fills. `history` stays usable without it.
    *
    * An areas file that is absent or unusable is an abstention, reported as a
    * note, never a silent empty (#508). A row with no error text gets no
    * category: `other` with no evidence would turn a real gap into a false
    * `fed` in `history gaps`.
    */
   import { readFileSync } from 'node:fs';
   import { join } from 'node:path';

   import {
     parseCriticalAreas,
     type CriticalArea,
   } from '../../core/inventory-checks.js';
   import type { TestResultInput } from '../../history/schema.js';
   import { areaFor } from './area.js';
   import { categorizeFailure } from './failure-category.js';

   const CRITICAL_AREAS_FILE = '.canary/critical-areas.json';
   const CATEGORISED = new Set(['failed', 'flaky']);

   interface AreasLoad {
     areas: CriticalArea[];
     note?: string;
   }

   function unusable(reason: string): AreasLoad {
     return {
       areas: [],
       note:
         `area not recorded: ${reason}. \`history record\` maps each test ` +
         `file to an area listed in ${CRITICAL_AREAS_FILE}.`,
     };
   }

   function loadAreas(cwd: string): AreasLoad {
     let text: string | null = null;
     try {
       text = readFileSync(join(cwd, CRITICAL_AREAS_FILE), 'utf-8');
     } catch (err) {
       const code = (err as NodeJS.ErrnoException).code;
       if (code !== 'ENOENT') {
         return unusable(
           `${CRITICAL_AREAS_FILE} could not be read (${String(code)})`,
         );
       }
     }
     const parsed = parseCriticalAreas(text);
     if (!parsed.ok) return unusable(parsed.reason);
     if (parsed.areas.length === 0) {
       return unusable(`${CRITICAL_AREAS_FILE} lists no areas`);
     }
     return { areas: parsed.areas };
   }

   function enrichRow(
     row: TestResultInput,
     areas: readonly CriticalArea[],
   ): TestResultInput {
     const area = areaFor(row.test_file, areas);
     const category =
       CATEGORISED.has(row.status) && row.error_text
         ? categorizeFailure(row.error_text)
         : undefined;
     return {
       ...row,
       ...(area === undefined ? {} : { area }),
       ...(category === undefined ? {} : { failure_category: category }),
     };
   }

   /** Enrich recorded rows; `notes` holds one line per abstention. */
   export function enrichRecordedResults(
     results: readonly TestResultInput[],
     cwd: string,
   ): { results: TestResultInput[]; notes: string[] } {
     const loaded = loadAreas(cwd);
     return {
       results: results.map((r) => enrichRow(r, loaded.areas)),
       notes: loaded.note === undefined ? [] : [loaded.note],
     };
   }
   ```

4. Run `npx vitest run test/enrich-recorded-results.test.ts`. Expect 5 passing
   tests.
5. From the repo root, run `harness validate` and `harness check-deps` (analysis
   → core and history imports must be allowed).
6. Commit:
   `feat(analysis): record-time enricher for area and failure_category (#1125)`

### Task 4: Playwright flakes keep their last failing error (G8)

**Depends on:** none | **Files:** `ts/src/history/formats/playwright-report.ts`,
`ts/test/history-record-playwright.test.ts`

1. In `ts/test/history-record-playwright.test.ts`, replace the test
   `'keeps the failure message only for a failed test'` with:

   ```ts
   it('keeps the last failing message for failed and flaky tests (G8, #1125)', () => {
     const r = report([
       spec('fails', [pwTest('unexpected', [FAIL(5, 'x'.repeat(3000))])]),
       spec('flakes', [
         pwTest('flaky', [FAIL(5, 'first'), FAIL(5, 'second'), PASS()]),
       ]),
       spec('passes', [pwTest('expected', [PASS()])]),
     ]);
     const built = buildRunFromReport('playwright', r, CTX);
     expect(built.results[0]!.error_text).toHaveLength(2000);
     // A flake's passing retry has no error; the evidence is its last failure.
     expect(built.results[1]!.error_text).toBe('second');
     expect(built.results[2]!.error_text ?? null).toBeNull();
   });
   ```

2. Run `npx vitest run test/history-record-playwright.test.ts`. The new test
   should fail on `results[1]` (it is `undefined` today).
3. In `ts/src/history/formats/playwright-report.ts`, replace `errorText` (lines
   150-156) with:

   ```ts
   function attemptMessage(a: PwAttempt): unknown {
     return a.error?.message ?? a.errors?.[0]?.message;
   }

   /**
    * The message of the last attempt that carries one. For a flake that is its
    * last failing retry, not the passing one: without it a flake cannot be
    * categorised (#1125, G8).
    */
   function errorText(attempts: PwAttempt[]): string | undefined {
     const message = attempts
       .map(attemptMessage)
       .filter((m) => m !== undefined)
       .pop();
     return message === undefined
       ? undefined
       : String(message).slice(0, ERROR_TEXT_LIMIT);
   }
   ```

   Then add `const ERROR_STATUSES = new Set(['failed', 'flaky']);` next to
   `ERROR_TEXT_LIMIT` (line 78), and in `toResultRow` change line 172 to:

   ```ts
   const error = ERROR_STATUSES.has(status) ? errorText(attempts) : undefined;
   ```

4. Run

   ```text
   npx vitest run test/history-record-playwright.test.ts test/history-record.test.ts
   ```

   Both should pass.

5. Run `harness validate` from the repo root.
6. Commit:

   ```text
   fix(history): Playwright flakes keep their last failing error text (#1125 G8)
   ```

### Task 5: `HistoryDeps.enrichResults` seam in `record`

**Depends on:** none | **Files:** `ts/src/history/cli-deps.ts`,
`ts/src/history/record/cli.ts`, `ts/test/history-record-enrich.test.ts`

1. Create `ts/test/history-record-enrich.test.ts`:

   ```ts
   /**
    * The #1125 seam: `record` applies an injected enricher and prints its
    * notes. Without one, rows are stored exactly as the reader built them.
    */
   import { mkdirSync, writeFileSync } from 'node:fs';
   import { join } from 'node:path';

   import { afterEach, beforeEach, describe, expect, it } from 'vitest';

   import { CliExitError } from '../src/cli-common.js';
   import {
     createHistoryCommand,
     type HistoryDeps,
   } from '../src/history/cli.js';
   import type { RunInput, TestResultInput } from '../src/history/schema.js';
   import type { AsyncHistoryStore } from '../src/history/store.js';
   import { mkTmp, rmTmp } from './canary-cli-testkit.js';

   const ENV = {
     GITHUB_REPOSITORY: 'acme/widgets',
     GITHUB_SHA: 'a'.repeat(40),
   };

   let tmp: string;
   let src: string;
   beforeEach(() => {
     tmp = mkTmp();
     mkdirSync(tmp, { recursive: true });
     src = join(tmp, 'vitest.json');
     writeFileSync(
       src,
       JSON.stringify({
         startTime: 1_754_000_000_000,
         testResults: [
           {
             name: 'test/checkout.test.ts',
             assertionResults: [
               {
                 fullName: 't',
                 title: 't',
                 status: 'failed',
                 duration: 5,
                 failureMessages: ['boom'],
               },
             ],
           },
         ],
       }),
       'utf-8',
     );
   });
   afterEach(() => {
     rmTmp(tmp);
   });

   async function record(extra: Partial<HistoryDeps>) {
     const pushed: TestResultInput[][] = [];
     const runs: RunInput[] = [];
     const store: AsyncHistoryStore = {
       pushRun: async (run, results) => {
         runs.push(run);
         pushed.push(results);
       },
       countRuns: async () => runs.length,
       queryFlaky: async () => [],
       queryTimeline: async () => [],
       querySummary: async (suite) => ({
         suite,
         total_runs: 0,
         avg_pass_rate: 0,
       }),
     };
     const err: string[] = [];
     let code = 0;
     try {
       await createHistoryCommand({
         out: () => {},
         err: (s) => err.push(s),
         env: ENV as NodeJS.ProcessEnv,
         makeStore: () => store,
         git: () => null,
         cwd: () => tmp,
         ...extra,
       }).parseAsync(['record', src, '--suite', 'api'], { from: 'user' });
     } catch (e) {
       if (!(e instanceof CliExitError)) throw e;
       code = e.code;
     }
     return { code, rows: pushed[0] ?? [], stderr: err.join('\n') };
   }

   describe('history record enrichResults seam (#1125)', () => {
     it('stores the enricher output and prints its notes', async () => {
       const seen: string[] = [];
       const res = await record({
         enrichResults: (results, cwd) => {
           seen.push(cwd);
           return {
             results: results.map((r) => ({ ...r, area: 'src/checkout.ts' })),
             notes: ['enricher says hi'],
           };
         },
       });
       expect(res.code).toBe(0);
       expect(seen).toEqual([tmp]);
       expect(res.rows.map((r) => r.area)).toEqual(['src/checkout.ts']);
       expect(res.stderr).toContain('note: enricher says hi');
     });

     it('stores rows unenriched and prints nothing extra without an enricher', async () => {
       const res = await record({});
       expect(res.code).toBe(0);
       expect(res.rows).toHaveLength(1);
       expect('area' in res.rows[0]!).toBe(false);
       expect(res.stderr).not.toContain('area not recorded');
     });
   });
   ```

2. Run `npx vitest run test/history-record-enrich.test.ts`. It should fail:
   typecheck rejects `enrichResults`, or the first test sees no `area`.
3. In `ts/src/history/cli-deps.ts`, add
   `import type { TestResultInput } from './schema.js';` after the existing
   imports, and add this member to `HistoryDeps` after `cwd(): string;`:

   ```ts
     /**
      * Optional record-time enricher (#1125), filled by the engine registry
      * from `analysis/enrich`. Absent, `record` stores rows as read.
      */
     enrichResults?: (
       results: TestResultInput[],
       cwd: string,
     ) => { results: TestResultInput[]; notes: string[] };
   ```

   Leave `defaultHistoryDeps()` unchanged (no default, by design F4).

4. In `ts/src/history/record/cli.ts` `recordCmd`, rename the existing
   `const built = prepareRecordedRun(...)` binding to `const prepared`, and add
   on the next line `const built = enrich(prepared, deps);`. Everything below it
   (dry-run, pushRun, reportRecorded) keeps reading `built`, so the dry-run
   shows enriched rows as well. Then add below `buildOrRefuse`:

   ```ts
   /** Apply the injected enricher (#1125); history knows no areas itself. */
   function enrich(run: KeyedRun, deps: HistoryDeps): KeyedRun {
     if (!deps.enrichResults) return run;
     const { results, notes } = deps.enrichResults(run.results, deps.cwd());
     for (const note of notes) deps.err(`note: ${note}`);
     return { ...run, results };
   }
   ```

   `KeyedRun` is already imported as a type (line 42).

5. Run

   ```text
   npx vitest run test/history-record-enrich.test.ts test/history-record.test.ts
   ```

   All should pass.

6. From the repo root, run `harness validate` and `harness check-deps`.
7. Commit:
   `feat(history): optional enrichResults seam for history record (#1125)`

### Task 6: Wire the enricher and invert the clocktower e2e

**Depends on:** Task 3, Task 4, Task 5 | **Files:**
`ts/src/commands/engine/cli.ts`, `ts/test/clocktower-e2e.test.ts`

1. In `ts/test/clocktower-e2e.test.ts`:
   - Rewrite the file header comment. It now reads: "End-to-end proof that
     `canary history record` feeds the #610 consumers (#1125). A Playwright
     report recorded where `.canary/critical-areas.json` maps its spec file
     yields `area` and `failure_category`. Without the file, `area` abstains
     with a note. The test goes red the day either writer path regresses."
   - Replace `recordThenGaps` with:

     ```ts
     /** Maps the fixture's one spec file (`checkout.spec.ts`) to an area. */
     const AREAS = { areas: [{ path: 'src/checkout.ts', risk_score: 0.9 }] };

     async function recordThenGaps(
       areas?: unknown,
     ): Promise<{ code: number; recStderr: string; gaps: Gap[] }> {
       if (areas !== undefined) {
         mkdirSync(join(tmp, '.canary'), { recursive: true });
         writeFileSync(
           join(tmp, '.canary', 'critical-areas.json'),
           JSON.stringify(areas),
           'utf-8',
         );
       }
       const src = join(tmp, 'pw.json');
       mkdirSync(dirname(src), { recursive: true });
       writeFileSync(src, JSON.stringify(playwrightReport()), 'utf-8');
       const rec = await invokeCanary(
         ['history', 'record', src, '--suite', 'web'],
         {
           cwd: tmp,
           env: CI_ENV,
         },
       );
       expect(rec.code).toBe(0);
       const res = await invokeCanary(['history', 'gaps', '--json'], {
         cwd: tmp,
         env: CI_ENV,
       });
       const body = JSON.parse(res.stdout) as { consumers: Gap[] };
       return { code: res.code, recStderr: rec.stderr, gaps: body.consumers };
     }
     ```

   - Replace the tests `'reproduces G1 and G2 …'` and
     `'reports the screech owning-area and cluster half as dark (C1)'` with:

     ```ts
     it('feeds flaky-area, screech-cluster and failure-categories when critical-areas.json maps the spec (G1, G2, G8 closed)', async () => {
       const { code, recStderr, gaps } = await recordThenGaps(AREAS);
       expect(recStderr).not.toContain('area not recorded');
       expect(find(gaps, 'flaky-area').coverage[0]).toMatchObject({
         carried: 3,
         applicable: 3,
       });
       expect(find(gaps, 'flaky-area').status).toBe('fed');
       expect(find(gaps, 'screech-cluster').status).toBe('fed');
       const categories = find(gaps, 'failure-categories');
       expect(categories.status).toBe('fed');
       // The failure AND the flake now carry error text (G8) and a category.
       expect(
         categories.coverage.map((c) => [c.field, c.carried, c.applicable]),
       ).toEqual([
         ['error_text', 2, 2],
         ['failure_category', 2, 2],
       ]);
       // Every counted consumer is fed; order-ttff is opt-in and skipped.
       expect(code).toBe(0);
     });

     it('keeps area dark, and says so, when critical-areas.json is absent', async () => {
       const { code, recStderr, gaps } = await recordThenGaps();
       expect(recStderr).toContain('note: area not recorded');
       expect(recStderr).toContain('.canary/critical-areas.json');
       expect(find(gaps, 'flaky-area').status).toBe('dark');
       const cluster = find(gaps, 'screech-cluster');
       expect(cluster.status).toBe('dark');
       // Only the hard failure: screech's isFailure does not count a flake.
       expect(
         cluster.coverage.map((c) => [c.field, c.carried, c.applicable]),
       ).toEqual([
         ['area', 0, 1],
         ['failure_category', 1, 1],
       ]);
       expect(find(gaps, 'failure-categories').status).toBe('fed');
       expect(code).toBe(1);
     });
     ```

   - Keep `'reports the fields the writer does fill as fed'` and
     `'reports order-ttff dark …'` as they are. They call `recordThenGaps()`
     with no areas, which is still valid.

2. Run `npx vitest run test/clocktower-e2e.test.ts`. The positive test should
   fail (`flaky-area` is dark because nothing is wired yet).
3. In `ts/src/commands/engine/cli.ts`, add
   `import { enrichRecordedResults } from '../../analysis/enrich/enrich.js';`
   after the `createAnalyzeCommand` import. Change line 25 to:

   ```ts
   // #1125: `area` / `failure_category` are filled at record time by an
   // analysis-side enricher; `history` only exposes the seam.
   const history = createHistoryCommand({
     out: deps.out,
     err: deps.err,
     enrichResults: enrichRecordedResults,
   });
   ```

4. Run

   ```text
   npx vitest run test/clocktower-e2e.test.ts test/cli-command-registry.test.ts test/history-record.test.ts test/history-record-repo-relative.test.ts test/history-replay-capture.test.ts
   ```

   All should pass. The last three prove the new stderr note breaks no existing
   record test.

5. From the repo root, run `harness validate` and `harness check-deps`.
6. Commit:

   ```text
   feat(history): history record fills area and failure_category via the engine registry (#1125)
   ```

### Task 7: Docs: Known gaps, Source links, README

**Depends on:** Task 6 | **Files:** `docs/guides/history-gaps.md`, `README.md` |
**Category:** integration

1. In `docs/guides/history-gaps.md`, change the heading
   `## Known gaps (2026-09-28)` to `## Known gaps (2026-09-29)`, and replace the
   G1, G2, G3 and G8 rows with:

   ```markdown
   | G1 | `area` was declared and read (screech, `history flaky`), but no reader
   wrote it. | fixed in #1125: `record` maps each test file to an area in
   `.canary/critical-areas.json`; without the file it prints a `note:` and
   leaves `area` unset | | G2 | `failure_category` was declared and read, but
   never written. | fixed in #1125: `record` categorises failed and flaky rows
   that carry error text (canary-fail-fast vocabulary) | | G3 | `tags` is
   declared and pushed, but never written. | opt-in field, no automatic writer:
   nothing reads it (#1125 F3) | | G8 | The Playwright reader kept `error_text`
   for failures but not for flakes. | fixed in #1125: a flake keeps its last
   failing attempt's error |
   ```

2. In the same file, append to `## Source`:

   ```markdown
   - [enrich.ts](../../ts/src/analysis/enrich/enrich.ts) — the record-time
     enricher `history record` calls (#1125): `area` and `failure_category`,
     plus the abstention note.
   - [area.ts](../../ts/src/analysis/enrich/area.ts) — test file to critical
     area, by file stem.
   - [failure-category.ts](../../ts/src/analysis/enrich/failure-category.ts) —
     the categoriser, ported from canary-fail-fast and pinned to it by a parity
     test.
   ```

3. In `README.md`, change the `canary history record …` row's description
   (line 296) to: append to the description that `record` fills `area` from
   `.canary/critical-areas.json` (a `note:` when absent) and `failure_category`
   from each failure's error text.
4. From the repo root, run
   `npx prettier --write docs/guides/history-gaps.md README.md`.
5. From the repo root, run `node scripts/check_doc_links.mjs`. It must report 0
   dead links.
6. Run `npx vitest run test/doc-links.test.ts test/entropy-doc-paths.test.ts`.
7. Run `harness validate` from the repo root.
8. Commit:
   `docs(history): record the #1125 writer dispositions for G1-G3 and G8`

### Task 8: Ratchets: entropy, perf, docs coverage, arch

**Depends on:** Task 7 | **Files:** conditional: `harness.config.json`,
`.harness/arch/allowances/feat-1125-history-writer-fields.json`,
`.harness/arch/baselines.json` | **Category:** integration

Measure every number. Never derive one. Run from the repo root, and compare
against a detached worktree of the merge base:

1. Create the base worktree:

   ```text
   git worktree add --detach ../canary-1125-base $(git merge-base HEAD origin/main)
   ```

2. Entropy:

   ```text
   harness cleanup --findings-json > "$TMPDIR"/1125-entropy.txt; (cd ../canary-1125-base && harness cleanup --findings-json) > "$TMPDIR"/1125-entropy-base.txt; node scripts/entropy-ratchet.mjs --cli-version "$(harness --version)" --report "$TMPDIR"/1125-entropy.txt --base-report "$TMPDIR"/1125-entropy-base.txt
   ```

   If it grew, grep the report for `analysis/enrich`. Declare each flagged file
   in **both** `entropy.entryPoints` and `performance.entryPoints` in
   `harness.config.json`, or drop an `export` only this file uses. Never raise
   `maxFindings`. Re-measure until the count is at or below base.

3. Perf:

   ```text
   harness check-perf > "$TMPDIR"/1125-perf.txt 2>&1; (cd ../canary-1125-base && harness check-perf) > "$TMPDIR"/1125-perf-base.txt 2>&1; node scripts/perf-ratchet.mjs --cli-version "$(harness --version)" --report "$TMPDIR"/1125-perf.txt --report-root . --base-report-root ../canary-1125-base --base-report "$TMPDIR"/1125-perf-base.txt
   ```

   Any new finding (complexity over 10, nesting over 4, a function over 50
   lines) gets refactored. There is no allowance for it.

4. Docs coverage:

   ```text
   harness check-docs --json --min-coverage 0 > "$TMPDIR"/1125-docs.json; (cd ../canary-1125-base && harness check-docs --json --min-coverage 0) > "$TMPDIR"/1125-docs-base.json; node scripts/docs-ratchet.mjs --report "$TMPDIR"/1125-docs.json --base-report "$TMPDIR"/1125-docs-base.json
   ```

   The Task 7 links should cover the three new files.

5. Arch: run `harness check-arch --json > "$TMPDIR"/1125-arch.json`. If
   `regressions` is empty, stop: no allowance and no floor bump (do not bump
   unconditionally). If module-size regressed, run
   `harness check-arch --update-baseline --allow-regress --reason "<why>"`.
   Rename or write the result as
   `.harness/arch/allowances/feat-1125-history-writer-fields.json`, with a
   reason that states the measured value, the commit it was measured against,
   and the attribution (three new `analysis/enrich` files plus about 20 lines in
   `history`). Then run `npx vitest run test/arch-baseline-freshness.test.ts`
   from `ts/`. If it fails, run `node scripts/refresh-arch-baseline.mjs` as its
   message directs (exit 0 = written; 1 = nothing to do; 3 = abstained, so
   investigate).
6. Remove the base worktree: `git worktree remove ../canary-1125-base`.
7. Run `harness validate` from the repo root.
8. Commit (only if a file changed):
   `chore(ratchets): declare #1125 enrich module in ratchet config`

### Task 9: Four gates and self-review

**Depends on:** Task 8 | **Files:** none (verification) | **Category:**
integration

1. From `ts/`, run
   `npm run build && npm run typecheck && npm run format:check && npm test`.
   Chain with `&&` and read the exit code, never through a pipe. Confirm the
   vitest summary counts are non-zero and that the four new test files appear in
   the run.
2. From the repo root, run `harness validate`, `harness check-deps` and
   `harness check-arch`.
3. Read `git diff origin/main...HEAD` as a reviewer. Check two things:
   `ts/src/history` grew only by the seam and G8 lines, and no doc still says
   `area` or `failure_category` is "never written"
   (`grep -rn "never written\|no reader writes" docs/guides`).
4. No commit unless step 3 finds something. If it does, fix it test-first and
   commit as `fix(history): <what>`.

## Traceability

| Truth | Tasks   |
| ----- | ------- |
| 1     | 2, 3, 6 |
| 2     | 3, 5, 6 |
| 3     | 1, 3    |
| 4     | 1       |
| 5     | 4, 6    |
| 6     | 6       |
| 7     | 5       |
| 8     | 8, 9    |
| 9     | 7       |
