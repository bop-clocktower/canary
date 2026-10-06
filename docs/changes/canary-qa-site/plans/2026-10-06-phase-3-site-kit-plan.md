# Plan: canary QA site, phase 3 — site kit and `canary-barda`

Issue: [#1151](https://github.com/bop-clocktower/canary/issues/1151) · Spec:
[proposal.md](../proposal.md) (Implementation Order item 3) · Date: 2026-10-06 ·
Base: `df661b1c` (`main`, phase 2 merged as #1198) · Branch:
`feat/1151-qa-site-kit` (worktree `../canary-1151-site-kit`) · Rigor: standard ·
**Tasks:** 23 (3a: 15, 3b: 8) · **Time:** ~105 min · **Integration Tier:** large
(new public kit, new skill, ADR)

## Goal

`canary-barda --feed … --out …` turns a validated `canary.site/1` feed into a
static page that renders six framework-free panels. Every panel renders an
abstention as text inside a live region, and no panel renders a composite score.

## Planning decisions (signed off 2026-10-06)

| #   | Decision                                                                                                                                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1  | **A1.** `<canary-failures-by-area>` reads only the feed. _failed_ = `failed` + `timed_out`; _not-run_ = `skipped` + `interrupted`; `area: null` goes to a visible `(unassigned)` bucket and is never dropped.                                                                                                |
| P1a | **Clarification of P1 (veto-able).** _Quarantined_ = a failed **or** not-run result whose `(scope, file, title)` is in `register[]`. A quarantined test is usually skipped, so counting only failing ones would file nearly every quarantine under not-run. A passing result in the register is not counted. |
| P2  | **B.** Pass rate per logical run = `(passed + flaky) / (total − skipped)`, rounded DOWN to one decimal from integers, so 100.0% appears only when every counted test passed. An empty denominator renders `—`.                                                                                               |
| P3  | **C.** The latest logical run decides the state: `passed` → passing, `failed` → failing, `cancelled` → cancelled (never passing). Dark is measured against the browser clock (injectable for tests), not `generated_at`, so a feed nobody regenerates goes dark on its own.                                  |
| P4  | **D.** `canary-barda` copies the kit into `<out>/kit/`. The site is self-contained and runs under `script-src 'self'`. CDN loading is phase 4 (`canary-vixen`).                                                                                                                                              |
| P5  | **E1.** Two PRs, merged one after the other: **3a** kit + ADR B (Tasks 1–15), **3b** `canary-barda` (Tasks 16–23). Task 13 records the split in the spec's Implementation Order.                                                                                                                             |
| P6  | NFR elicitation skipped on all four dimensions (static rendering of a feed capped at 30 runs per suite; the existing perf, security and entropy gates stand).                                                                                                                                                |

## Soundness-review amendments (2026-10-06)

`harness-soundness-review --mode plan` found 7 must-fix, 5 should-fix and 2
nits. Each was checked by running the plan's snippets in a scratch copy (vitest
5.0.3, happy-dom 20.14.5, `tsc` with DOM libs, harness 12.10.1 ratchets on
`df661b1c` copies). All are fixed **in place** in the tasks below; this list is
the record.

| #   | Sev    | Task(s) | Fix                                                                                                                                                                           |
| --- | ------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | must   | 12, 17  | Issue refs in comments (`#1151`) matched the color regex on every file. The rule now strips comments first, which also makes the planted check meaningful.                    |
| M2  | must   | 11      | Under happy-dom, `new URL(rel, import.meta.url)` is `http://localhost`, so the fixture is now read through `fileURLToPath`.                                                   |
| M3  | must   | 19      | Builds through the real CLI (`spawnSync`) under `node_modules/.barda-render/`. Importing `build.mjs` under happy-dom breaks schema loading, and `import()` from tmpdir fails. |
| M4  | must   | 3, 11   | Typecheck: JSDoc on `loadFeed`'s `fetchImpl`, and a typed `.map` callback in the model test.                                                                                  |
| M5  | must   | 3       | `site-kit-helpers.ts` is now in both `entryPoints` (entropy 141 → 142 otherwise). Task 3 also touches `harness.config.json`.                                                  |
| M6  | must   | 11, 17  | Perf delta +2 has no escape. `readFeed` moves to a new `scripts/feed.mjs` (imports `document.mjs`), and `canary-site.js` gets a `deltaAllowances` entry.                      |
| M7  | must   | 18      | The SKILL.md example is now a `bash` fence; `skill-examples.test.ts` reads only shell fences.                                                                                 |
| S1  | should | 16      | The registry row stays one table line.                                                                                                                                        |
| S2  | should | 13      | The spec's `canary-barda build` (`proposal.md:265`, criterion 21) and the plan Goal now use the flag form.                                                                    |
| S3  | should | 15, 23  | With an allowance, `baselines.json` `module-size.value` moves to the allowance value (the arch-baseline-freshness test requires it).                                          |
| S4  | should | 18      | `buildSite` errors (for example `ENOTDIR`) exit 1 with a message instead of a stack trace, with a test.                                                                       |
| S5  | should | 3       | A boolean assessment `value` renders yes/no, never `—` (D4).                                                                                                                  |
| N1  | nit    | 19      | `<link>` and `<script>` tags are stripped before `DOMParser`, so there is no fetch noise.                                                                                     |
| N2  | nit    | 2       | The `tokens.css` comment claims only colors.                                                                                                                                  |

Re-measured perf `maxViolations` is 220, and the actual count at `df661b1c` is
215 (the stamped `measuredCount` of 219 is stale). Measure against the real
count.

## Observable truths

| #   | Truth (EARS)                                                                                                                                                                                                                                  | Spec  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| T1  | When a pass-rate denominator is empty, `<canary-pass-rate>` shall render `—`; a 996/1000 run shall render `99.6%`, never `100.0%`.                                                                                                            | 9     |
| T2  | When a suite's latest run finished more than `DARK_AFTER_DAYS` ago, `<canary-pipeline-health>` shall render it dark; a declared suite with no runs shall render never-reported; when `suites` is null, the panel shall say none are declared. | 10    |
| T3  | When any panel abstains, the abstention shall be text inside that panel's `role="status"` `aria-live="polite"` region, and that region shall be the same node across re-renders.                                                              | 11    |
| T4  | When an assessment is `not-assessed`, `<canary-pillars>` shall render its `reason` as text; no panel shall render a composite score.                                                                                                          | 20    |
| T5  | When one test flakes in several runs, `<canary-flaky>` shall list it once with `flaky_runs/window_runs`.                                                                                                                                      | 23    |
| T6  | When `canary-barda --feed site.json --out dir` runs on a valid feed, `dir` shall hold a page whose six panels render that feed; if the feed is invalid or unparseable, nothing shall be written (exit 1).                                     | 21    |
| T7  | `DARK_AFTER_DAYS` shall be defined exactly once in the kit; kit sources shall contain no color literal, and every `var(--canary-*)` they use shall be defined in `tokens.css`.                                                                | spec  |
| T8  | ADR 0036 (pillars, no composite) shall exist with `number` and `title` frontmatter and an index row.                                                                                                                                          | ADR B |
| T9  | If a feed carries zero runs, then `canary-barda` shall print an `ABSTAINED` line (exit 0, or 3 under `--strict`) and shall not print its success copy.                                                                                        | #508  |
| T10 | Build, typecheck, format check and tests pass in `ts/` and `agents/skills/`; entropy, perf and arch ratchets pass without raising `maxFindings` or a baseline.                                                                                | 15    |

## Uncertainties

- [ASSUMPTION] vitest 5's per-file `// @vitest-environment happy-dom` works with
  `happy-dom@20.14.5`. Constructed stylesheets in shadow roots were checked
  against happy-dom 20.14.5 standalone during planning; Task 4 is the first test
  to run under vitest, so a failure surfaces there.
- [ASSUMPTION] Adding `"DOM"` to `agents/skills/tsconfig.json` `lib` does not
  break existing test typechecks (Task 1 runs `typecheck` before any kit code
  exists).
- [RESOLVED by soundness review] vitest cannot `import()` from `os.tmpdir()`;
  Task 19 builds under `node_modules/.barda-render/`.
- [ASSUMPTION] Arch `module-size` (a ratcheted sum) grows with the kit, as it
  did in phase 2. Tasks 15 and 23 carry a `[checkpoint:decision]`.
- [DEFERRABLE] **Contract gap, filed as
  [#1199](https://github.com/bop-clocktower/canary/issues/1199):**
  `canary.site/1` `register` is a required array, so a feed cannot tell "the
  ledger was empty" from "no ledger was read" (starling writes `[]` for a dark
  default ledger and only notes it on stderr). Until the contract can say so,
  `<canary-register>` announces that an empty register is ambiguous (Task 10)
  instead of claiming there is no debt.
- [DEFERRABLE] Exact panel copy can be tuned during review; the tests pin the
  rule-carrying fragments only (`—`, `dark`, `never reported`, the reason text).

## File map

### 3a — site kit (Tasks 1–15)

```text
MODIFY agents/skills/package.json            (happy-dom devDep; format globs)
MODIFY agents/skills/package-lock.json       (generated)
MODIFY agents/skills/tsconfig.json           (lib: DOM, DOM.Iterable)
MODIFY agents/skills/vitest.config.ts        (coverage include .js)
CREATE agents/skills/lib/site-kit/tokens.css
CREATE agents/skills/lib/site-kit/model.js
CREATE agents/skills/lib/site-kit/panel.js
CREATE agents/skills/lib/site-kit/panels/pipeline-health.js
CREATE agents/skills/lib/site-kit/panels/pass-rate.js
CREATE agents/skills/lib/site-kit/panels/failures-by-area.js
CREATE agents/skills/lib/site-kit/panels/flaky.js
CREATE agents/skills/lib/site-kit/panels/pillars.js
CREATE agents/skills/lib/site-kit/panels/register.js
CREATE agents/skills/lib/site-kit/canary-site.js
CREATE agents/skills/test/site-kit-helpers.ts
CREATE agents/skills/test/site-kit-model.test.ts
CREATE agents/skills/test/site-kit-panel.test.ts
CREATE agents/skills/test/site-kit-pipeline-health.test.ts
CREATE agents/skills/test/site-kit-pass-rate.test.ts
CREATE agents/skills/test/site-kit-failures-by-area.test.ts
CREATE agents/skills/test/site-kit-flaky.test.ts
CREATE agents/skills/test/site-kit-pillars.test.ts
CREATE agents/skills/test/site-kit-register.test.ts
CREATE agents/skills/test/site-kit-registry.test.ts
CREATE agents/skills/test/site-kit-rules.test.ts
MODIFY harness.config.json                   (canary-site.js + site-kit-helpers.ts in both entryPoints)
MODIFY .harness/perf-baseline.json           (deltaAllowances: canary-site.js coupling)
CREATE docs/knowledge/decisions/0036-pillars-no-composite-health-score.md
MODIFY docs/knowledge/decisions/README.md    (index row)
MODIFY docs/changes/canary-qa-site/proposal.md (Implementation Order: 3a/3b)
MAYBE  .harness/arch/allowances/feat-1151-qa-site-kit.json (Task 15 checkpoint)
```

### 3b — `canary-barda` (Tasks 16–23)

```text
CREATE agents/skills/claude-code/canary-barda/SKILL.md
CREATE agents/skills/claude-code/canary-barda/scripts/cli.mjs   (+x)
CREATE agents/skills/claude-code/canary-barda/scripts/build.mjs
CREATE agents/skills/claude-code/canary-barda/scripts/feed.mjs
CREATE agents/skills/claude-code/canary-barda/scripts/page.mjs
CREATE agents/skills/lib/site-kit/page.css
CREATE agents/skills/test/canary-barda.test.ts
CREATE agents/skills/test/canary-barda-render.test.ts
MODIFY agents/skills/test/site-kit-rules.test.ts (page.css under the token rule)
MODIFY agents/skills/test/gate-conformance.test.ts
MODIFY docs/naming-registry.md
MODIFY harness.config.json                   (barda cli.mjs in both entryPoints)
MODIFY agents/skills/package.json            (format glob)
MODIFY agents/skills/vitest.config.ts        (coverage include)
MODIFY agents/skills/README.md
MODIFY AGENTS.md
MODIFY docs/roadmap.md
MAYBE  .harness/arch/allowances/feat-1151-qa-site-barda.json (Task 23 checkpoint)
```

## Skeleton (approved 2026-10-06)

1. Foundation (Tasks 1–4) · 2. Six panels (5–10) · 3. Registry (11) · 4. Kit
   rules (12) · 5. ADR B + spec split (13) · 6. Docs/gates/ship 3a (14–15) · **—
   milestone: 3a merged —** · 7. Barda core (16–17) · 8. CLI (18) · 9.
   Built-site render (19) · 10. Registrations (20–21) · 11. Docs (22) · 12.
   Gates/ship 3b (23).

## Conventions every task follows

- Work in `/Users/bs/Github/canary-1151-site-kit`. Run test commands from
  `agents/skills/`.
- Kit files are browser ES modules (`.js`, two-space, single quotes, prettier).
  They import only each other — never `node:*`, never a skill script — because
  `canary-barda` copies `lib/site-kit/` verbatim into a site.
- DOM tests start with the line `// @vitest-environment happy-dom`.
- Kit private fields must not be spelled with hex letters only (`#feed`,
  `#face`): the Task 12 color-literal rule would read them as colors. This plan
  uses `#doc`, `#problem`, `#live`. (Comments are stripped before the rule runs,
  so issue refs like `#1151` in comments are fine.)
- Each task ends: `npx prettier --write <touched files>`, `harness validate`,
  then the commit. Never `--no-verify`.

---

## Milestone 3a — site kit

### Task 1: Tooling — happy-dom, DOM types, `.js` globs

**Depends on:** none | **Files:** `agents/skills/package.json`,
`agents/skills/package-lock.json`, `agents/skills/tsconfig.json`,
`agents/skills/vitest.config.ts`

1. `cd agents/skills && npm ci && npm i -D happy-dom@^20.14.5` (the lockfile is
   generated).
2. `package.json` `format:check`: replace `\"lib/**/*.mjs\"` with
   `\"lib/**/*.{mjs,js}\"`. (A brace pattern that matches the existing `.mjs`
   files keeps prettier from failing on "no files matching" before the kit
   exists.)
3. `tsconfig.json`: `"lib": ["ES2022", "DOM", "DOM.Iterable"]`.
4. `vitest.config.ts` coverage `include`: replace `'lib/**/*.mjs'` with
   `'lib/**/*.{mjs,js}'` and extend the comment above it:

   ```text
   // .js too (#1151 phase 3): the site kit is browser ESM under lib/site-kit/.
   ```

5. Verify, recording each denominator: `npm run -s typecheck`,
   `npm run -s format:check`, `npm test` (same test count as on `main`; a lower
   count is a failure).
6. Commit:
   `chore(skills): add happy-dom and DOM types for the QA site kit (Refs #1151)`

### Task 2: `tokens.css`

**Depends on:** Task 1 | **Files:** `agents/skills/lib/site-kit/tokens.css`,
`agents/skills/package.json`

1. Create `agents/skills/lib/site-kit/tokens.css`:

   ```css
   /*
    * canary QA site design tokens (#1151 phase 3). The ONLY file in the kit that
    * holds a literal color; panels read these through var(--…), so
    * a host re-themes the kit by redefining tokens (canary-vixen, phase 4).
    * Gold is the canary mark (docs/assets/icon-gold.svg).
    */
   :root {
     --canary-font: system-ui, -apple-system, 'Segoe UI', sans-serif;
     --canary-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
     --canary-space-1: 4px;
     --canary-space-2: 12px;
     --canary-radius: 8px;
     --canary-bg: #fffbea;
     --canary-surface: #ffffff;
     --canary-text: #1c1a14;
     --canary-muted: #5c5646;
     --canary-border: #e8dfc0;
     --canary-accent: #f0c040;
     --canary-ok: #1a7f37;
     --canary-fail: #b42318;
     --canary-warn: #9a6700;
     --canary-dark: #57534e;
     --canary-abstain: #5c5646;
   }

   @media (prefers-color-scheme: dark) {
     :root:not([data-theme='light']) {
       --canary-bg: #0a0a0a;
       --canary-surface: #17150f;
       --canary-text: #f4efdc;
       --canary-muted: #b3ab92;
       --canary-border: #3a3526;
       --canary-ok: #4ac26b;
       --canary-fail: #ff7b72;
       --canary-warn: #e3b341;
       --canary-dark: #a8a29e;
       --canary-abstain: #b3ab92;
     }
   }

   :root[data-theme='dark'] {
     --canary-bg: #0a0a0a;
     --canary-surface: #17150f;
     --canary-text: #f4efdc;
     --canary-muted: #b3ab92;
     --canary-border: #3a3526;
     --canary-ok: #4ac26b;
     --canary-fail: #ff7b72;
     --canary-warn: #e3b341;
     --canary-dark: #a8a29e;
     --canary-abstain: #b3ab92;
   }
   ```

2. `package.json` `format:check`: add `\"lib/site-kit/*.css\"` after the lib
   glob.
3. `npm run -s format:check`.
4. Commit: `feat(site-kit): design tokens for the QA site panels (Refs #1151)`

### Task 3: `model.js` — the pure rules every panel shares

**Depends on:** Task 1 | **Files:** `agents/skills/lib/site-kit/model.js`,
`agents/skills/test/site-kit-model.test.ts`,
`agents/skills/test/site-kit-helpers.ts`, `harness.config.json`

1. Create `agents/skills/test/site-kit-helpers.ts` (shared by every kit test;
   not itself a test file):

   ```ts
   // Builders for site-kit tests (#1151 phase 3). Every builder produces a record
   // the contract validator accepts (asserted in site-kit-model.test.ts), so a
   // panel test never passes on a feed no producer could write.

   export const SCOPE = { id: 'canary', env: 'ci' };
   export const NOW = Date.parse('2026-10-06T12:00:00Z');
   export const DAY = 86_400_000;
   export const iso = (ms: number) => new Date(ms).toISOString();

   const STATUSES = [
     'passed',
     'failed',
     'flaky',
     'skipped',
     'timed_out',
     'interrupted',
   ] as const;

   type Result = Record<string, unknown> & { status: string };
   type Totals = Record<(typeof STATUSES)[number] | 'total', number>;

   export const result = (over: Record<string, unknown> = {}): Result => ({
     title: 't',
     file: 'test/a.test.ts',
     status: 'passed',
     duration_ms: 1,
     retries: 0,
     area: null,
     tags: [],
     error: null,
     ...over,
   });

   const totalsOf = (list: Result[]): Totals => ({
     ...(Object.fromEntries(
       STATUSES.map((s) => [s, list.filter((r) => r.status === s).length]),
     ) as Record<(typeof STATUSES)[number], number>),
     total: list.length,
   });

   interface RunOver {
     id?: string;
     suite?: string;
     scope?: { id: string; env: string };
     finished?: string;
     status?: 'passed' | 'failed' | 'cancelled';
     shard?: { index: number; total: number } | null;
     totals?: Partial<Totals>;
     results?: Result[] | null;
   }

   /** A canary.run/1 record; totals derive from `results` when it is a list. */
   export function runRecord(over: RunOver = {}) {
     const finished = over.finished ?? iso(NOW - DAY);
     const results = over.results ?? null;
     const totals = results
       ? totalsOf(results)
       : {
           passed: 1,
           failed: 0,
           flaky: 0,
           skipped: 0,
           timed_out: 0,
           interrupted: 0,
           total: 1,
           ...over.totals,
         };
     return {
       contract: 'canary.run/1',
       scope: over.scope ?? SCOPE,
       producer: { name: 'test', version: '0', channel: 'ci' },
       run: {
         id: over.id ?? 'r1',
         suite: over.suite ?? 'ts-engine',
         branch: 'main',
         commit_sha: null,
         started_at: iso(Date.parse(finished) - 60_000),
         finished_at: finished,
         ci_url: null,
         status: over.status ?? 'passed',
         shard: over.shard ?? null,
       },
       totals,
       results,
       collected: null,
     };
   }

   export const assessment = (over: Record<string, unknown> = {}) => ({
     contract: 'canary.assessment/1',
     scope: SCOPE,
     source: 'canary.ci-ready',
     metric: 'flakiness',
     status: 'healthy',
     value: 0.012,
     unit: 'ratio',
     reason: null,
     evidence: { tier: 'heuristic', denominator: 30 },
     observed_at: iso(NOW - DAY),
     sources: ['history-v2.jsonl'],
     verified_by: null,
     verified_at: null,
     ...over,
   });

   export const registerRow = (over: Record<string, unknown> = {}) => ({
     scope: SCOPE,
     title: 't',
     file: 'test/a.test.ts',
     kind: 'skipped',
     reason: 'flaky on CI',
     recorded_at: iso(NOW - 10 * DAY),
     commit: 'abc1234',
     cause: null,
     issue: null,
     ...over,
   });

   export const siteFeed = (over: Record<string, unknown> = {}) => ({
     contract: 'canary.site/1',
     generated_at: iso(NOW - 3_600_000),
     scopes: [SCOPE],
     suites: null,
     runs: [],
     flaky: [],
     assessments: [],
     register: [],
     ...over,
   });

   let tags = 0;
   type Mounted = HTMLElement & { now: () => number; feed: unknown };

   /**
    * Defines `cls` under a fresh tag (one constructor cannot back two tags, so it
    * is subclassed), mounts it with a pinned clock, and sets `feed` unless it is
    * undefined. Returns the panel's shadow root.
    */
   export function mount(
     cls: CustomElementConstructor,
     feed?: unknown,
     now = NOW,
   ): ShadowRoot {
     const tag = `test-panel-${++tags}`;
     customElements.define(tag, class extends cls {});
     const node = document.createElement(tag) as Mounted;
     node.now = () => now;
     document.body.append(node);
     if (feed !== undefined) node.feed = feed;
     return node.shadowRoot!;
   }

   /** The panel's live region text: where every abstention must land. */
   export const live = (root: ShadowRoot) =>
     root.querySelector('[role="status"][aria-live="polite"]')?.textContent ??
     '';
   ```

2. Create `agents/skills/test/site-kit-model.test.ts`:

   ```ts
   import { describe, expect, it } from 'vitest';
   import {
     ABSENT,
     ageDays,
     DARK_AFTER_DAYS,
     formatMeasure,
     isDark,
     logicalRuns,
     passCounts,
     percent,
     suiteKey,
   } from '../lib/site-kit/model.js';
   import { validateDocument } from '../lib/contracts/validate.mjs';
   import {
     assessment,
     DAY,
     iso,
     NOW,
     registerRow,
     result,
     runRecord,
     SCOPE,
     siteFeed,
   } from './site-kit-helpers.js';

   describe('site-kit model (#1151 phase 3)', () => {
     it('pins DARK_AFTER_DAYS to the spec value (D15)', () => {
       expect(DARK_AFTER_DAYS).toBe(7);
     });

     it.each([
       [0, 0, ABSENT],
       [996, 1000, '99.6%'],
       [999, 1000, '99.9%'],
       [1999, 2000, '99.9%'],
       [2, 2, '100.0%'],
       [1, 3, '33.3%'],
     ])('percent(%i, %i) is %s: rounded down, never up to 100', (n, d, out) => {
       expect(percent(n, d)).toBe(out);
     });

     it('counts a recovered flake as a pass and leaves skips out', () => {
       const t = {
         passed: 3,
         failed: 1,
         flaky: 1,
         skipped: 2,
         timed_out: 0,
         interrupted: 0,
         total: 7,
       };
       expect(passCounts(t)).toEqual({ numerator: 4, denominator: 5 });
     });

     it('merges the shards of one run into one logical run', () => {
       const a = runRecord({
         id: 'r9-s1of2',
         shard: { index: 1, total: 2 },
         results: [result({ title: 'a' })],
         finished: iso(NOW - 2 * DAY),
       });
       const b = runRecord({
         id: 'r9-s2of2',
         shard: { index: 2, total: 2 },
         status: 'failed',
         results: [result({ title: 'b', status: 'failed' })],
         finished: iso(NOW - DAY),
       });
       const [run] = logicalRuns([a, b]).get(suiteKey(SCOPE, 'ts-engine'))!;
       expect(run.id).toBe('r9');
       expect(run.status).toBe('failed');
       expect(run.totals.total).toBe(2);
       expect(run.finished).toBe(NOW - DAY);
       expect(run.results.map((r: { title: string }) => r.title)).toEqual([
         'a',
         'b',
       ]);
     });

     it('a shard without results makes the logical run results null (not carried)', () => {
       const a = runRecord({ id: 'x-s1of2', shard: { index: 1, total: 2 } });
       const b = runRecord({
         id: 'x-s2of2',
         shard: { index: 2, total: 2 },
         results: [result()],
       });
       const [run] = logicalRuns([a, b]).get(suiteKey(SCOPE, 'ts-engine'))!;
       expect(run.results).toBeNull();
     });

     it('failed outranks cancelled, which outranks passed', () => {
       const shard = (i: number, status: 'passed' | 'failed' | 'cancelled') =>
         runRecord({ id: `y-s${i}of2`, shard: { index: i, total: 2 }, status });
       const state = (...runs: ReturnType<typeof runRecord>[]) =>
         logicalRuns(runs).get(suiteKey(SCOPE, 'ts-engine'))![0].status;
       expect(state(shard(1, 'passed'), shard(2, 'cancelled'))).toBe(
         'cancelled',
       );
       expect(state(shard(1, 'failed'), shard(2, 'cancelled'))).toBe('failed');
       expect(state(shard(1, 'passed'), shard(2, 'passed'))).toBe('passed');
     });

     it('orders each suite newest first and keeps suites apart', () => {
       const runs = [
         runRecord({ id: 'old', finished: iso(NOW - 3 * DAY) }),
         runRecord({ id: 'new', finished: iso(NOW - DAY) }),
         runRecord({ id: 'e2e', suite: 'e2e' }),
       ];
       const bySuite = logicalRuns(runs);
       expect(
         bySuite
           .get(suiteKey(SCOPE, 'ts-engine'))!
           .map((r: { id: string }) => r.id),
       ).toEqual(['new', 'old']);
       expect(bySuite.get(suiteKey(SCOPE, 'e2e'))!).toHaveLength(1);
     });

     it('is dark only after DARK_AFTER_DAYS have fully passed', () => {
       expect(isDark(NOW - 7 * DAY, NOW)).toBe(false);
       expect(isDark(NOW - 7 * DAY - 1, NOW)).toBe(true);
     });

     it('ages a timestamp in whole days', () => {
       expect(ageDays(iso(NOW - 10 * DAY - 5), NOW)).toBe(10);
     });

     it.each([
       [0.012, 'ratio', '1.2%'],
       [0.9999, 'ratio', '99.9%'],
       [0.57, 'ratio', '57.0%'],
       [1234.4, 'ms', '1234 ms'],
       [3, 'count', '3'],
       [null, 'ratio', ABSENT],
       [true, 'count', 'yes'],
       [false, 'count', 'no'],
     ])('formatMeasure(%s, %s) is %s', (v, unit, out) => {
       expect(formatMeasure(v, unit)).toBe(out);
     });

     it('the test builders produce feeds the contract accepts', () => {
       const doc = siteFeed({
         suites: [{ scope: SCOPE, suite: 'ts-engine' }],
         runs: [runRecord({ results: [result(), result({ title: 'u' })] })],
         assessments: [assessment()],
         register: [registerRow()],
       });
       const v = validateDocument(doc);
       expect(v.errors).toEqual([]);
       expect(v.valid).toBe(true);
     });
   });
   ```

3. Run `npx vitest run test/site-kit-model.test.ts` and confirm it fails because
   the module is missing.
4. Create `agents/skills/lib/site-kit/model.js`:

   ```js
   // model -- the pure rules every site-kit panel shares (#1151 phase 3).
   //
   // No DOM here: panel.js renders, this file decides. The rules that make a
   // number honest live in one place, tested without a browser: null is not 0
   // (D4), a pass rate never rounds up to 100%, a suite with no recent run is
   // dark (D15), and a sharded run counts once.
   //
   // The kit is copied verbatim into a built site, so it cannot import the
   // node-side skill scripts. The shard rule below mirrors canary-starling's
   // runs.mjs logicalId (#1148) on purpose.

   /** D15: a suite with no run inside this many days is dark. Defined once. */
   export const DARK_AFTER_DAYS = 7;
   const DAY_MS = 86_400_000;

   /** What a panel renders for a value it could not measure (D4). */
   export const ABSENT = '—';

   export const scopeLabel = (scope) => `${scope.id}/${scope.env}`;
   export const suiteKey = (scope, suite) =>
     `${scope.id}\u0000${scope.env}\u0000${suite}`;

   const logicalId = (r) =>
     r.run.shard ? r.run.id.replace(/-s\d+of\d+$/, '') : r.run.id;

   const COUNTS = [
     'passed',
     'failed',
     'flaky',
     'skipped',
     'timed_out',
     'interrupted',
     'total',
   ];

   function worst(statuses) {
     if (statuses.includes('failed')) return 'failed';
     if (statuses.includes('cancelled')) return 'cancelled';
     return 'passed';
   }

   function merge(records) {
     const lists = records.map((r) => r.results);
     return {
       scope: records[0].scope,
       suite: records[0].run.suite,
       id: logicalId(records[0]),
       finished: Math.max(...records.map((r) => Date.parse(r.run.finished_at))),
       status: worst(records.map((r) => r.run.status)),
       totals: Object.fromEntries(
         COUNTS.map((k) => [k, records.reduce((n, r) => n + r.totals[k], 0)]),
       ),
       // One shard without results makes the run's list unknown, not shorter.
       results: lists.includes(null) ? null : lists.flat(),
     };
   }

   /**
    * Feed runs as logical runs (the shards of one run are one), keyed by
    * suiteKey, each suite newest first.
    */
   export function logicalRuns(runs) {
     const bySuite = new Map();
     for (const r of runs) {
       const key = suiteKey(r.scope, r.run.suite);
       const ofSuite = bySuite.get(key) ?? new Map();
       const id = logicalId(r);
       ofSuite.set(id, [...(ofSuite.get(id) ?? []), r]);
       bySuite.set(key, ofSuite);
     }
     const out = new Map();
     for (const [key, ofSuite] of bySuite) {
       const merged = [...ofSuite.values()].map(merge);
       out.set(
         key,
         merged.sort((a, b) => b.finished - a.finished),
       );
     }
     return out;
   }

   /** A recovered flake is a pass (its run is `passed`); a skip is not counted. */
   export const passCounts = (t) => ({
     numerator: t.passed + t.flaky,
     denominator: t.total - t.skipped,
   });

   /**
    * Rounded DOWN to one decimal from integers: 996/1000 is 99.6% and 999/1000
    * is never 100%. An empty denominator is ABSENT, never 0%.
    */
   export function percent(numerator, denominator) {
     if (!(denominator > 0)) return ABSENT;
     return `${(Math.floor((numerator * 1000) / denominator) / 10).toFixed(1)}%`;
   }

   /** An assessment value in its unit; a ratio rounds down like percent(). */
   export function formatMeasure(value, unit) {
     // The schema allows a boolean measurement; it is a value, not an absence.
     if (typeof value === 'boolean') return value ? 'yes' : 'no';
     if (value === null || !Number.isFinite(value)) return ABSENT;
     // The epsilon absorbs float error (0.57 * 1000 = 569.999…), not real data.
     if (unit === 'ratio')
       return `${(Math.floor(value * 1000 + 1e-9) / 10).toFixed(1)}%`;
     if (unit === 'ms') return `${Math.round(value)} ms`;
     return String(value);
   }

   export const isDark = (finishedMs, now) =>
     now - finishedMs > DARK_AFTER_DAYS * DAY_MS;

   export const ageDays = (isoTime, now) =>
     Math.floor((now - Date.parse(isoTime)) / DAY_MS);
   ```

5. Run the test again and confirm it passes.
6. `harness.config.json`: add `"agents/skills/test/site-kit-helpers.ts"` to
   **both** `entryPoints` arrays, next to `ts/test/batwoman-testkit.ts`. Test
   files are excluded from the entropy scan, so nothing visible imports the
   helper. Without this line, entropy counts 141 → 142.
7. Run `harness validate`, then commit:

   ```text
   feat(site-kit): shared model — logical runs, honest percent, dark rule (Refs #1151)
   ```

### Task 4: `panel.js` — base element, live region, styles

**Depends on:** Tasks 2, 3 | **Files:** `agents/skills/lib/site-kit/panel.js`,
`agents/skills/test/site-kit-panel.test.ts`

1. Create `agents/skills/test/site-kit-panel.test.ts`:

   ```ts
   // @vitest-environment happy-dom
   import { describe, expect, it } from 'vitest';
   import { CanaryPanel, el } from '../lib/site-kit/panel.js';
   import { live, mount, runRecord, siteFeed } from './site-kit-helpers.js';

   class Probe extends CanaryPanel {
     get heading() {
       return 'Probe';
     }
     build(doc: { runs: unknown[] }) {
       return doc.runs.length
         ? {
             nodes: [el('p', { 'data-n': String(doc.runs.length) }, 'ok')],
             abstentions: [],
           }
         : { nodes: [], abstentions: ['Nothing ran.'] };
     }
   }

   describe('CanaryPanel (#1151 phase 3)', () => {
     it('says so before any feed arrives', () => {
       const root = mount(Probe);
       expect(live(root)).toBe('No feed loaded yet.');
     });

     it('renders the heading and the built nodes', () => {
       const root = mount(Probe, siteFeed({ runs: [runRecord()] }));
       expect(root.querySelector('h2')!.textContent).toBe('Probe');
       expect(root.querySelector('[data-n="1"]')).not.toBeNull();
       expect(live(root)).toBe('');
     });

     it('puts an abstention as text in a polite status region (criterion 11)', () => {
       const root = mount(Probe, siteFeed());
       const region = root.querySelector('[aria-live]')!;
       expect(region.getAttribute('role')).toBe('status');
       expect(region.getAttribute('aria-live')).toBe('polite');
       expect(region.textContent).toBe('Nothing ran.');
     });

     it('keeps one live region node across renders, so changes are announced', () => {
       const root = mount(Probe, siteFeed());
       const before = root.querySelector('[aria-live]');
       (root.host as HTMLElement & { feed: unknown }).feed = siteFeed({
         runs: [runRecord()],
       });
       expect(root.querySelector('[aria-live]')).toBe(before);
     });

     it('refuse() drops the content and announces why', () => {
       const root = mount(Probe, siteFeed({ runs: [runRecord()] }));
       (root.host as unknown as CanaryPanel).refuse('Feed refused.');
       expect(root.querySelector('[data-n]')).toBeNull();
       expect(live(root)).toBe('Feed refused.');
     });

     it('el() sets attributes and skips null children', () => {
       const node = el(
         'li',
         { 'data-state': 'dark' },
         'a',
         null,
         el('b', {}, 'c'),
       );
       expect(node.getAttribute('data-state')).toBe('dark');
       expect(node.textContent).toBe('ac');
     });

     it('styles through one shared constructed sheet (no <style>, CSP-safe)', () => {
       const a = mount(Probe, siteFeed());
       const b = mount(Probe, siteFeed());
       expect(a.adoptedStyleSheets).toHaveLength(1);
       expect(a.adoptedStyleSheets[0]).toBe(b.adoptedStyleSheets[0]);
       expect(a.querySelector('style')).toBeNull();
     });
   });
   ```

2. Run `npx vitest run test/site-kit-panel.test.ts` and confirm it fails because
   the module is missing. If the failure is about the environment instead (for
   example happy-dom not found), stop: that disproves the Task 1 assumption.
3. Create `agents/skills/lib/site-kit/panel.js`:

   ```js
   // panel -- the base every site-kit custom element extends (#1151 phase 3).
   //
   // One rule lives here so no panel can skip it: an abstention is visible text
   // INSIDE a polite live region (criterion 11). The region is created once and
   // kept across renders -- a region inserted together with its text is often
   // not announced. Styles are one constructed stylesheet shared by every panel,
   // not a <style> element, so a host's strict CSP cannot block them, and they
   // read only tokens.css custom properties (no literal colors).

   const CSS = `
   :host {
     display: block;
     font: 0.95rem/1.4 var(--canary-font);
     color: var(--canary-text);
     background: var(--canary-surface);
     border: 1px solid var(--canary-border);
     border-radius: var(--canary-radius);
     padding: var(--canary-space-2);
   }
   h2 { font-size: 1rem; margin: 0 0 var(--canary-space-2); }
   h3 { font-size: 0.95rem; margin: var(--canary-space-2) 0 var(--canary-space-1); }
   ul, ol { list-style: none; margin: 0; padding: 0; }
   li { padding: var(--canary-space-1) 0; border-top: 1px solid var(--canary-border); }
   table { border-collapse: collapse; width: 100%; }
   th, td { text-align: left; padding: var(--canary-space-1); border-top: 1px solid var(--canary-border); }
   code { font-family: var(--canary-mono); }
   .muted { color: var(--canary-muted); }
   .abstain { color: var(--canary-abstain); font-style: italic; margin: 0; }
   [data-state='passing'], [data-state='healthy'] { color: var(--canary-ok); }
   [data-state='failing'], [data-state='critical'] { color: var(--canary-fail); }
   [data-state='cancelled'], [data-state='degraded'] { color: var(--canary-warn); }
   [data-state='dark'], [data-state='never-reported'], [data-state='not-assessed'] { color: var(--canary-dark); }
   `;

   let sheet = null;
   function styles() {
     if (!sheet) {
       sheet = new CSSStyleSheet();
       sheet.replaceSync(CSS);
     }
     return sheet;
   }

   /** el('li', {'data-state': 'dark'}, 'text', child): null children are skipped. */
   export function el(tag, attrs = {}, ...children) {
     const node = document.createElement(tag);
     for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
     node.append(...children.filter((c) => c !== null && c !== undefined));
     return node;
   }

   /**
    * Subclasses provide `get heading()` and `build(doc)`, which returns
    * `{nodes, abstentions}`: the content, and every reason the panel could not
    * show something. Abstentions are never optional copy.
    */
   export class CanaryPanel extends HTMLElement {
     #doc = null;
     #problem = null;
     #live;
     /** Milliseconds since the epoch; tests pin it. */
     now = () => Date.now();

     constructor() {
       super();
       const root = this.attachShadow({ mode: 'open' });
       root.adoptedStyleSheets = [styles()];
       this.#live = el('p', {
         role: 'status',
         'aria-live': 'polite',
         class: 'abstain',
       });
     }

     set feed(doc) {
       this.#doc = doc;
       this.#problem = null;
       this.render();
     }

     get feed() {
       return this.#doc;
     }

     /** The feed could not be used at all (load failed, wrong contract). */
     refuse(problem) {
       this.#doc = null;
       this.#problem = problem;
       this.render();
     }

     connectedCallback() {
       this.render();
     }

     render() {
       const { nodes, abstentions } = this.#doc
         ? this.build(this.#doc)
         : { nodes: [], abstentions: [this.#problem ?? 'No feed loaded yet.'] };
       this.shadowRoot.replaceChildren(
         el('h2', {}, this.heading),
         ...nodes,
         this.#live,
       );
       this.#live.textContent = abstentions.join(' ');
     }
   }
   ```

4. Run the test again and confirm it passes.
5. Run `harness validate`, then commit:

   ```text
   feat(site-kit): panel base with a persistent live region for abstentions (Refs #1151)
   ```

### Task 5: `<canary-pipeline-health>`

**Depends on:** Task 4 | **Files:**
`agents/skills/lib/site-kit/panels/pipeline-health.js`,
`agents/skills/test/site-kit-pipeline-health.test.ts`

1. Create the test:

   ```ts
   // @vitest-environment happy-dom
   import { describe, expect, it } from 'vitest';
   import { PipelineHealth } from '../lib/site-kit/panels/pipeline-health.js';
   import {
     DAY,
     iso,
     live,
     mount,
     NOW,
     runRecord,
     SCOPE,
     siteFeed,
   } from './site-kit-helpers.js';

   const declared = (...names: string[]) =>
     names.map((suite) => ({ scope: SCOPE, suite }));
   const states = (root: ShadowRoot) =>
     [...root.querySelectorAll('li')].map((li) =>
       li.getAttribute('data-state'),
     );

   describe('<canary-pipeline-health> (criterion 10)', () => {
     it('renders a suite whose latest run passed inside the window as passing', () => {
       const root = mount(
         PipelineHealth,
         siteFeed({ suites: declared('ts-engine'), runs: [runRecord()] }),
       );
       expect(states(root)).toEqual(['passing']);
       expect(root.querySelector('li')!.textContent).toContain(
         'canary/ci · ts-engine',
       );
     });

     it('renders failing when any shard of the latest run failed', () => {
       const shard = (i: number, status: 'passed' | 'failed') =>
         runRecord({ id: `r-s${i}of2`, shard: { index: i, total: 2 }, status });
       const root = mount(
         PipelineHealth,
         siteFeed({ runs: [shard(1, 'passed'), shard(2, 'failed')] }),
       );
       expect(states(root)).toEqual(['failing']);
     });

     it('renders a cancelled latest run as cancelled, never passing', () => {
       const root = mount(
         PipelineHealth,
         siteFeed({ runs: [runRecord({ status: 'cancelled' })] }),
       );
       expect(states(root)).toEqual(['cancelled']);
     });

     it('renders dark after DARK_AFTER_DAYS whatever the status was', () => {
       const root = mount(
         PipelineHealth,
         siteFeed({
           suites: declared('stale', 'fresh'),
           runs: [
             runRecord({ suite: 'stale', finished: iso(NOW - 8 * DAY) }),
             runRecord({ suite: 'fresh', finished: iso(NOW - 6 * DAY) }),
           ],
         }),
       );
       expect(states(root)).toEqual(['dark', 'passing']);
       expect(root.textContent).toContain('no run in 7 days');
     });

     it('renders a declared suite with no runs as never reported', () => {
       const root = mount(
         PipelineHealth,
         siteFeed({
           suites: declared('ts-engine', 'e2e'),
           runs: [runRecord()],
         }),
       );
       expect(states(root)).toEqual(['passing', 'never-reported']);
     });

     it('shows an undeclared suite that reported anyway', () => {
       const root = mount(
         PipelineHealth,
         siteFeed({
           suites: declared('ts-engine'),
           runs: [runRecord({ suite: 'extra' })],
         }),
       );
       expect(states(root)).toEqual(['never-reported', 'passing']);
     });

     it('with suites null, says none are declared and invents no never-reported row (D12)', () => {
       const root = mount(PipelineHealth, siteFeed({ runs: [runRecord()] }));
       expect(live(root)).toContain('No expected suites are declared');
       expect(states(root)).toEqual(['passing']);
     });

     it('abstains when nothing is declared and nothing reported', () => {
       const root = mount(PipelineHealth, siteFeed());
       expect(root.querySelector('ul')).toBeNull();
       expect(live(root)).toContain('No expected suites are declared');
       expect(live(root)).toContain('No suite has reported a run.');
     });

     it('abstains when zero suites are declared and none reported', () => {
       const root = mount(PipelineHealth, siteFeed({ suites: [] }));
       expect(live(root)).toBe('No suite has reported a run.');
     });
   });
   ```

2. Run `npx vitest run test/site-kit-pipeline-health.test.ts` and confirm it
   fails.
3. Create `agents/skills/lib/site-kit/panels/pipeline-health.js`:

   ```js
   // <canary-pipeline-health> -- per suite: passing / failing / cancelled / dark /
   // never reported (#1151 phase 3, criterion 10).
   //
   // "Never reported" needs a declared denominator (D12): with `suites: null`
   // the panel says nothing is declared rather than guessing which suites are
   // missing. Dark wins over any status: a green run from two weeks ago is not
   // evidence the suite is green now.

   import { CanaryPanel, el } from '../panel.js';
   import {
     DARK_AFTER_DAYS,
     isDark,
     logicalRuns,
     scopeLabel,
     suiteKey,
   } from '../model.js';

   const BY_STATUS = {
     passed: 'passing',
     failed: 'failing',
     cancelled: 'cancelled',
   };

   function stateOf(latest, now) {
     if (!latest) return { state: 'never-reported', text: 'never reported' };
     if (isDark(latest.finished, now))
       return {
         state: 'dark',
         text: `dark: no run in ${DARK_AFTER_DAYS} days`,
       };
     const state = BY_STATUS[latest.status];
     return { state, text: state };
   }

   /** Declared suites first, then any suite that reported without being declared. */
   function suiteRows(doc, bySuite) {
     const rows = new Map();
     for (const s of doc.suites ?? [])
       rows.set(suiteKey(s.scope, s.suite), { scope: s.scope, suite: s.suite });
     for (const [key, runs] of bySuite)
       if (!rows.has(key))
         rows.set(key, { scope: runs[0].scope, suite: runs[0].suite });
     return rows;
   }

   export class PipelineHealth extends CanaryPanel {
     get heading() {
       return 'Pipeline health';
     }

     build(doc) {
       const abstentions =
         doc.suites === null
           ? [
               'No expected suites are declared, so a suite that never reported cannot be shown.',
             ]
           : [];
       const bySuite = logicalRuns(doc.runs);
       const rows = suiteRows(doc, bySuite);
       if (rows.size === 0)
         return {
           nodes: [],
           abstentions: [...abstentions, 'No suite has reported a run.'],
         };
       const items = [...rows].map(([key, s]) => {
         const { state, text } = stateOf(bySuite.get(key)?.[0], this.now());
         return el(
           'li',
           { 'data-state': state },
           `${scopeLabel(s.scope)} · ${s.suite}: `,
           el('strong', {}, text),
         );
       });
       return { nodes: [el('ul', {}, ...items)], abstentions };
     }
   }
   ```

4. Run the test again and confirm it passes.
5. Run `harness validate`, then commit:

   ```text
   feat(site-kit): pipeline-health panel — dark and never-reported are states (Refs #1151)
   ```

### Task 6: `<canary-pass-rate>`

**Depends on:** Task 4 | **Files:**
`agents/skills/lib/site-kit/panels/pass-rate.js`,
`agents/skills/test/site-kit-pass-rate.test.ts`

1. Create the test:

   ```ts
   // @vitest-environment happy-dom
   import { describe, expect, it } from 'vitest';
   import { PassRate } from '../lib/site-kit/panels/pass-rate.js';
   import {
     DAY,
     iso,
     live,
     mount,
     NOW,
     runRecord,
     siteFeed,
   } from './site-kit-helpers.js';

   const totals = (over: Record<string, number>) => ({
     passed: 0,
     failed: 0,
     flaky: 0,
     skipped: 0,
     timed_out: 0,
     interrupted: 0,
     total: 0,
     ...over,
   });
   const rates = (root: ShadowRoot) =>
     [...root.querySelectorAll('li strong')].map((s) => s.textContent);

   describe('<canary-pass-rate> (criterion 9)', () => {
     it('renders 996/1000 as 99.6%, never 100%', () => {
       const run = runRecord({
         status: 'failed',
         totals: totals({ passed: 996, failed: 4, total: 1000 }),
       });
       const root = mount(PassRate, siteFeed({ runs: [run] }));
       expect(rates(root)).toEqual(['99.6%']);
       expect(root.textContent).not.toContain('100.0%');
     });

     it('renders an empty denominator as —, never 0%, and announces it', () => {
       const run = runRecord({ totals: totals({ skipped: 3, total: 3 }) });
       const root = mount(PassRate, siteFeed({ runs: [run] }));
       expect(rates(root)).toEqual(['—']);
       expect(root.textContent).not.toContain('0.0%');
       expect(live(root)).toContain('1 run(s) counted no tests');
     });

     it('counts a recovered flake as a pass', () => {
       const run = runRecord({
         totals: totals({ passed: 1, flaky: 1, total: 2 }),
       });
       expect(rates(mount(PassRate, siteFeed({ runs: [run] })))).toEqual([
         '100.0%',
       ]);
     });

     it('lists the trend newest first', () => {
       const runs = [
         runRecord({ id: 'a', finished: iso(NOW - 3 * DAY) }),
         runRecord({
           id: 'b',
           status: 'failed',
           finished: iso(NOW - DAY),
           totals: totals({ passed: 1, failed: 1, total: 2 }),
         }),
       ];
       const root = mount(PassRate, siteFeed({ runs }));
       expect(rates(root)).toEqual(['50.0%', '100.0%']);
       expect(root.querySelector('time')!.getAttribute('datetime')).toBe(
         iso(NOW - DAY),
       );
     });

     it('counts the shards of one run once', () => {
       const shard = (i: number) =>
         runRecord({
           id: `r-s${i}of2`,
           shard: { index: i, total: 2 },
           status: 'failed',
           totals: totals({ passed: 1, failed: 1, total: 2 }),
         });
       expect(
         rates(mount(PassRate, siteFeed({ runs: [shard(1), shard(2)] }))),
       ).toEqual(['50.0%']);
     });

     it('abstains with no runs', () => {
       const root = mount(PassRate, siteFeed());
       expect(root.querySelector('ol')).toBeNull();
       expect(live(root)).toBe(
         'No runs in the feed, so there is no pass rate.',
       );
     });
   });
   ```

2. Run `npx vitest run test/site-kit-pass-rate.test.ts` and confirm it fails.
3. Create `agents/skills/lib/site-kit/panels/pass-rate.js`:

   ```js
   // <canary-pass-rate> -- the pass-rate trend per suite, newest first (#1151
   // phase 3, criterion 9). A run that counted no tests renders "—" and is
   // announced; it is never 0%, and no rate rounds up to 100% (model.js).

   import { CanaryPanel, el } from '../panel.js';
   import { logicalRuns, passCounts, percent, scopeLabel } from '../model.js';

   function runItem(run) {
     const { numerator, denominator } = passCounts(run.totals);
     const when = new Date(run.finished).toISOString();
     return {
       empty: !(denominator > 0),
       node: el(
         'li',
         {},
         el('time', { datetime: when }, when.slice(0, 10)),
         ' ',
         el('strong', {}, percent(numerator, denominator)),
         el('span', { class: 'muted' }, ` (${numerator}/${denominator})`),
       ),
     };
   }

   export class PassRate extends CanaryPanel {
     get heading() {
       return 'Pass rate';
     }

     build(doc) {
       const bySuite = logicalRuns(doc.runs);
       if (bySuite.size === 0)
         return {
           nodes: [],
           abstentions: ['No runs in the feed, so there is no pass rate.'],
         };
       let empty = 0;
       const sections = [...bySuite.values()].map((runs) => {
         const items = runs.map(runItem);
         empty += items.filter((i) => i.empty).length;
         return el(
           'section',
           {},
           el('h3', {}, `${scopeLabel(runs[0].scope)} · ${runs[0].suite}`),
           el('ol', {}, ...items.map((i) => i.node)),
         );
       });
       const abstentions = empty
         ? [
             `${empty} run(s) counted no tests; their rate is shown as —, not 0%.`,
           ]
         : [];
       return { nodes: sections, abstentions };
     }
   }
   ```

4. Run the test again and confirm it passes.
5. Run `harness validate`, then commit:

   ```text
   feat(site-kit): pass-rate panel — empty denominator is —, never rounds up (Refs #1151)
   ```

### Task 7: `<canary-failures-by-area>`

**Depends on:** Task 4 | **Files:**
`agents/skills/lib/site-kit/panels/failures-by-area.js`,
`agents/skills/test/site-kit-failures-by-area.test.ts`

1. Create the test:

   ```ts
   // @vitest-environment happy-dom
   import { describe, expect, it } from 'vitest';
   import { FailuresByArea } from '../lib/site-kit/panels/failures-by-area.js';
   import {
     DAY,
     iso,
     live,
     mount,
     NOW,
     registerRow,
     result,
     runRecord,
     siteFeed,
   } from './site-kit-helpers.js';

   /** {area: [failed, quarantined, notRun]} from the rendered table. */
   function table(root: ShadowRoot) {
     return Object.fromEntries(
       [...root.querySelectorAll('tbody tr')].map((tr) => {
         const [area, ...counts] = [...tr.querySelectorAll('td')].map(
           (td) => td.textContent,
         );
         return [area, counts.map(Number)];
       }),
     );
   }

   describe('<canary-failures-by-area> (P1, P1a)', () => {
     it('counts failed and timed_out as failed, skipped and interrupted as not run', () => {
       const run = runRecord({
         status: 'failed',
         results: [
           result({ title: 'a', status: 'failed', area: 'checkout' }),
           result({ title: 'b', status: 'timed_out', area: 'checkout' }),
           result({ title: 'c', status: 'skipped', area: 'checkout' }),
           result({ title: 'd', status: 'interrupted', area: 'search' }),
           result({ title: 'e', status: 'passed', area: 'search' }),
         ],
       });
       expect(table(mount(FailuresByArea, siteFeed({ runs: [run] })))).toEqual({
         checkout: [2, 0, 1],
         search: [0, 0, 1],
       });
     });

     it('files a null area under (unassigned), never drops it', () => {
       const run = runRecord({
         status: 'failed',
         results: [result({ status: 'failed' })],
       });
       expect(table(mount(FailuresByArea, siteFeed({ runs: [run] })))).toEqual({
         '(unassigned)': [1, 0, 0],
       });
     });

     it('counts a failed or skipped test in the register as quarantined', () => {
       const run = runRecord({
         status: 'failed',
         results: [
           result({ title: 'q1', status: 'failed', area: 'x' }),
           result({ title: 'q2', status: 'skipped', area: 'x' }),
           result({ title: 'ok', status: 'passed', area: 'x' }),
         ],
       });
       const register = ['q1', 'q2', 'ok'].map((title) =>
         registerRow({ title }),
       );
       expect(
         table(mount(FailuresByArea, siteFeed({ runs: [run], register }))),
       ).toEqual({
         x: [0, 2, 0],
       });
     });

     it('a register row from another scope does not quarantine', () => {
       const run = runRecord({
         status: 'failed',
         results: [result({ status: 'failed' })],
       });
       const register = [registerRow({ scope: { id: 'other', env: 'ci' } })];
       expect(
         table(mount(FailuresByArea, siteFeed({ runs: [run], register }))),
       ).toEqual({
         '(unassigned)': [1, 0, 0],
       });
     });

     it('reads only the latest run of each suite', () => {
       const runs = [
         runRecord({
           id: 'old',
           status: 'failed',
           finished: iso(NOW - 3 * DAY),
           results: [result({ status: 'failed', area: 'old' })],
         }),
         runRecord({ id: 'new', results: [result()] }),
       ];
       const root = mount(FailuresByArea, siteFeed({ runs }));
       expect(root.querySelector('table')).toBeNull();
       expect(root.textContent).toContain(
         'No failed, quarantined or not-run tests in the latest run of 1 suite(s).',
       );
     });

     it('announces a suite whose latest run carries no per-test results', () => {
       const runs = [
         runRecord({ results: null }),
         runRecord({
           suite: 'e2e',
           status: 'failed',
           results: [result({ status: 'failed' })],
         }),
       ];
       const root = mount(FailuresByArea, siteFeed({ runs }));
       expect(live(root)).toContain('1 suite(s) carry no per-test results');
       expect(table(root)).toEqual({ '(unassigned)': [1, 0, 0] });
     });

     it('abstains with no runs', () => {
       const root = mount(FailuresByArea, siteFeed());
       expect(live(root)).toBe('No runs in the feed.');
     });
   });
   ```

2. Run `npx vitest run test/site-kit-failures-by-area.test.ts` and confirm it
   fails.
3. Create `agents/skills/lib/site-kit/panels/failures-by-area.js`:

   ```js
   // <canary-failures-by-area> -- the latest run of each suite, broken down by
   // area (#1151 phase 3, plan P1/P1a). Failed, quarantined (in the katana
   // register) and not-run are separate columns, so a quarantine is never read
   // as a failure or as a pass. A null area is a visible "(unassigned)" row.

   import { CanaryPanel, el } from '../panel.js';
   import { logicalRuns } from '../model.js';

   const FAILED = ['failed', 'timed_out'];
   const NOT_RUN = ['skipped', 'interrupted'];
   const UNASSIGNED = '(unassigned)';

   const testKey = (scope, file, title) =>
     [scope.id, scope.env, file, title].join('\u0000');

   function bucketOf(test, scope, quarantined) {
     const failed = FAILED.includes(test.status);
     if (!failed && !NOT_RUN.includes(test.status)) return null;
     if (quarantined.has(testKey(scope, test.file, test.title)))
       return 'quarantined';
     return failed ? 'failed' : 'notRun';
   }

   function tally(latest, quarantined) {
     const areas = new Map();
     for (const run of latest)
       for (const test of run.results) {
         const bucket = bucketOf(test, run.scope, quarantined);
         if (!bucket) continue;
         const area = test.area ?? UNASSIGNED;
         const row = areas.get(area) ?? {
           failed: 0,
           quarantined: 0,
           notRun: 0,
         };
         row[bucket] += 1;
         areas.set(area, row);
       }
     return areas;
   }

   function tableOf(areas) {
     const rows = [...areas]
       .sort(([a, x], [b, y]) => y.failed - x.failed || a.localeCompare(b))
       .map(([area, r]) =>
         el(
           'tr',
           {},
           el('td', {}, area),
           el('td', {}, String(r.failed)),
           el('td', {}, String(r.quarantined)),
           el('td', {}, String(r.notRun)),
         ),
       );
     const head = ['Area', 'Failed', 'Quarantined', 'Not run'].map((h) =>
       el('th', { scope: 'col' }, h),
     );
     return el(
       'table',
       {},
       el('thead', {}, el('tr', {}, ...head)),
       el('tbody', {}, ...rows),
     );
   }

   export class FailuresByArea extends CanaryPanel {
     get heading() {
       return 'Failures by area';
     }

     build(doc) {
       const latest = [...logicalRuns(doc.runs).values()].map(
         (runs) => runs[0],
       );
       if (latest.length === 0)
         return { nodes: [], abstentions: ['No runs in the feed.'] };
       const carried = latest.filter((r) => r.results !== null);
       const blind = latest.length - carried.length;
       const abstentions = blind
         ? [
             `${blind} suite(s) carry no per-test results in their latest run, so their failures cannot be broken down.`,
           ]
         : [];
       if (carried.length === 0) return { nodes: [], abstentions };
       const quarantined = new Set(
         doc.register.map((r) => testKey(r.scope, r.file, r.title)),
       );
       const areas = tally(carried, quarantined);
       const nodes = areas.size
         ? [tableOf(areas)]
         : [
             el(
               'p',
               {},
               `No failed, quarantined or not-run tests in the latest run of ${carried.length} suite(s).`,
             ),
           ];
       return { nodes, abstentions };
     }
   }
   ```

4. Run the test again and confirm it passes.
5. Run `harness validate`, then commit:

   ```text
   feat(site-kit): failures-by-area panel — quarantined and not-run kept apart (Refs #1151)
   ```

### Task 8: `<canary-flaky>`

**Depends on:** Task 4 | **Files:**
`agents/skills/lib/site-kit/panels/flaky.js`,
`agents/skills/test/site-kit-flaky.test.ts`

1. Create the test:

   ```ts
   // @vitest-environment happy-dom
   import { describe, expect, it } from 'vitest';
   import { Flaky } from '../lib/site-kit/panels/flaky.js';
   import {
     live,
     mount,
     result,
     runRecord,
     SCOPE,
     siteFeed,
   } from './site-kit-helpers.js';

   const flakyRow = (title: string, flaky_runs: number) => ({
     scope: SCOPE,
     suite: 'ts-engine',
     title,
     file: 'test/a.test.ts',
     flaky_runs,
     window_runs: 30,
   });
   const withResults = [runRecord({ results: [result()] })];

   describe('<canary-flaky> (criterion 23)', () => {
     it('lists each distinct test once with flaky runs over window runs', () => {
       const root = mount(
         Flaky,
         siteFeed({ runs: withResults, flaky: [flakyRow('a', 3)] }),
       );
       const items = root.querySelectorAll('li');
       expect(items).toHaveLength(1);
       expect(items[0].textContent).toContain('flaky in 3/30 runs');
       expect(root.textContent).toContain('1 distinct flaky test(s)');
     });

     it('puts the flakiest first', () => {
       const root = mount(
         Flaky,
         siteFeed({
           runs: withResults,
           flaky: [flakyRow('low', 1), flakyRow('high', 5)],
         }),
       );
       expect(root.querySelector('li strong')!.textContent).toBe('high');
     });

     it('says no test flaked when the window carried results', () => {
       const root = mount(Flaky, siteFeed({ runs: withResults }));
       expect(root.textContent).toContain('No test flaked in the window.');
       expect(live(root)).toBe('');
     });

     it('abstains when no run carries per-test results', () => {
       const root = mount(Flaky, siteFeed({ runs: [runRecord()] }));
       expect(root.textContent).not.toContain('No test flaked');
       expect(live(root)).toContain('No run carries per-test results');
     });

     it('abstains with no runs', () => {
       expect(live(mount(Flaky, siteFeed()))).toBe(
         'No runs in the feed, so flakiness was not measured.',
       );
     });
   });
   ```

2. Run `npx vitest run test/site-kit-flaky.test.ts` and confirm it fails.
3. Create `agents/skills/lib/site-kit/panels/flaky.js`:

   ```js
   // <canary-flaky> -- distinct flaky tests over the window, from the feed's
   // flaky[] section (#1151 phase 3, D13, criterion 23). One row per test, never
   // one per occurrence. "No test flaked" is said only when some run carried
   // per-test results; otherwise the panel abstains (nothing was measured).

   import { CanaryPanel, el } from '../panel.js';
   import { scopeLabel } from '../model.js';

   const row = (f) =>
     el(
       'li',
       {},
       el('strong', {}, f.title),
       ' ',
       el('code', {}, f.file),
       el(
         'span',
         { class: 'muted' },
         ` · ${scopeLabel(f.scope)} · ${f.suite} · flaky in ${f.flaky_runs}/${f.window_runs} runs`,
       ),
     );

   export class Flaky extends CanaryPanel {
     get heading() {
       return 'Flaky tests';
     }

     build(doc) {
       if (doc.runs.length === 0)
         return {
           nodes: [],
           abstentions: ['No runs in the feed, so flakiness was not measured.'],
         };
       if (doc.flaky.length > 0) {
         const rows = [...doc.flaky].sort(
           (a, b) =>
             b.flaky_runs - a.flaky_runs || a.title.localeCompare(b.title),
         );
         return {
           nodes: [
             el(
               'p',
               { class: 'muted' },
               `${rows.length} distinct flaky test(s)`,
             ),
             el('ul', {}, ...rows.map(row)),
           ],
           abstentions: [],
         };
       }
       if (doc.runs.every((r) => r.results === null))
         return {
           nodes: [],
           abstentions: [
             'No run carries per-test results, so flakiness was not measured.',
           ],
         };
       return {
         nodes: [el('p', {}, 'No test flaked in the window.')],
         abstentions: [],
       };
     }
   }
   ```

4. Run the test again and confirm it passes.
5. Run `harness validate`, then commit:

   ```text
   feat(site-kit): flaky panel — distinct tests, abstains without results (Refs #1151)
   ```

### Task 9: `<canary-pillars>`

**Depends on:** Task 4 | **Files:**
`agents/skills/lib/site-kit/panels/pillars.js`,
`agents/skills/test/site-kit-pillars.test.ts`

1. Create the test:

   ```ts
   // @vitest-environment happy-dom
   import { describe, expect, it } from 'vitest';
   import { Pillars } from '../lib/site-kit/panels/pillars.js';
   import { assessment, live, mount, siteFeed } from './site-kit-helpers.js';

   const notAssessed = assessment({
     metric: 'coverage-depth',
     status: 'not-assessed',
     value: null,
     reason: 'no coverage report was found',
     evidence: { tier: null, denominator: null },
   });

   describe('<canary-pillars> (criterion 20, D6)', () => {
     it('renders a not-assessed reason as text and announces it', () => {
       const root = mount(Pillars, siteFeed({ assessments: [notAssessed] }));
       const card = root.querySelector('li[data-state="not-assessed"]')!;
       expect(card.textContent).toContain('no coverage report was found');
       expect(live(root)).toContain(
         'coverage-depth: not assessed (no coverage report was found)',
       );
     });

     it('renders a measured pillar with its value, evidence tier and denominator', () => {
       const root = mount(Pillars, siteFeed({ assessments: [assessment()] }));
       const card = root.querySelector('li[data-state="healthy"]')!;
       expect(card.textContent).toContain('1.2%');
       expect(card.textContent).toContain('evidence: heuristic over 30');
       expect(live(root)).toBe('');
     });

     it('renders an observed duration in ms and an unknown tier as —', () => {
       const a = assessment({
         metric: 'suite-runtime',
         status: 'observed',
         value: 1234.4,
         unit: 'ms',
         evidence: { tier: null, denominator: null },
       });
       const card = mount(
         Pillars,
         siteFeed({ assessments: [a] }),
       ).querySelector('li')!;
       expect(card.textContent).toContain('1234 ms');
       expect(card.textContent).toContain('evidence: —');
     });

     it('shows every pillar side by side and no composite (D6)', () => {
       const metrics = [
         'coverage-depth',
         'flakiness',
         'assertion-quality',
         'critical-paths',
         'suite-runtime',
       ];
       const root = mount(
         Pillars,
         siteFeed({
           assessments: metrics.map((metric) => assessment({ metric })),
         }),
       );
       expect(root.querySelectorAll('li')).toHaveLength(5);
       expect(root.textContent).not.toMatch(/score|overall|average|\/\s*10\b/i);
     });

     it('abstains with no assessments', () => {
       expect(live(mount(Pillars, siteFeed()))).toBe(
         'No assessments in the feed.',
       );
     });
   });
   ```

2. Run `npx vitest run test/site-kit-pillars.test.ts` and confirm it fails.
3. Create `agents/skills/lib/site-kit/panels/pillars.js`:

   ```js
   // <canary-pillars> -- every assessment side by side, never a composite (#1151
   // phase 3, D6, ADR 0036, criterion 20). A not-assessed pillar shows its
   // reason as text and announces it; an absent value is "—", never 0.

   import { CanaryPanel, el } from '../panel.js';
   import { ABSENT, formatMeasure, scopeLabel } from '../model.js';

   const evidence = (e) =>
     ` · evidence: ${e.tier ?? ABSENT}${e.denominator === null ? '' : ` over ${e.denominator}`}`;

   const order = (a, b) =>
     scopeLabel(a.scope).localeCompare(scopeLabel(b.scope)) ||
     a.source.localeCompare(b.source) ||
     a.metric.localeCompare(b.metric);

   function card(a) {
     const detail =
       a.status === 'not-assessed'
         ? el('p', { class: 'abstain' }, a.reason)
         : el(
             'p',
             {},
             el('strong', {}, formatMeasure(a.value, a.unit)),
             evidence(a.evidence),
           );
     return el(
       'li',
       { 'data-state': a.status },
       el('h3', {}, a.metric),
       el(
         'p',
         { class: 'muted' },
         `${a.source} · ${scopeLabel(a.scope)} · ${a.status}`,
       ),
       detail,
     );
   }

   export class Pillars extends CanaryPanel {
     get heading() {
       return 'Pillars';
     }

     build(doc) {
       if (doc.assessments.length === 0)
         return { nodes: [], abstentions: ['No assessments in the feed.'] };
       const sorted = [...doc.assessments].sort(order);
       const abstentions = sorted
         .filter((a) => a.status === 'not-assessed')
         .map((a) => `${a.metric}: not assessed (${a.reason}).`);
       return { nodes: [el('ul', {}, ...sorted.map(card))], abstentions };
     }
   }
   ```

4. Run the test again and confirm it passes.
5. Run `harness validate`, then commit:
   `feat(site-kit): pillars panel — reasons as text, no composite (Refs #1151)`

### Task 10: `<canary-register>`

**Depends on:** Task 4 | **Files:**
`agents/skills/lib/site-kit/panels/register.js`,
`agents/skills/test/site-kit-register.test.ts`

1. Create the test:

   ```ts
   // @vitest-environment happy-dom
   import { describe, expect, it } from 'vitest';
   import { Register } from '../lib/site-kit/panels/register.js';
   import {
     DAY,
     iso,
     live,
     mount,
     NOW,
     registerRow,
     siteFeed,
   } from './site-kit-helpers.js';

   describe('<canary-register>', () => {
     it('shows each row with kind, reason, age and issue', () => {
       const row = registerRow({ title: 'checkout > pays', issue: '#42' });
       const li = mount(Register, siteFeed({ register: [row] })).querySelector(
         'li',
       )!;
       for (const text of [
         'checkout > pays',
         'test/a.test.ts',
         'skipped',
         'flaky on CI',
         '10 day(s) old',
         '#42',
       ])
         expect(li.textContent).toContain(text);
     });

     it('lists the oldest debt first', () => {
       const register = [
         registerRow({ title: 'young', recorded_at: iso(NOW - DAY) }),
         registerRow({ title: 'old', recorded_at: iso(NOW - 30 * DAY) }),
       ];
       const root = mount(Register, siteFeed({ register }));
       expect(root.querySelector('li strong')!.textContent).toBe('old');
     });

     it('announces that an empty register is ambiguous rather than claiming no debt', () => {
       const root = mount(Register, siteFeed());
       expect(root.querySelector('ul')).toBeNull();
       expect(live(root)).toContain(
         'An empty register can also mean no ledger was read',
       );
     });
   });
   ```

2. Run `npx vitest run test/site-kit-register.test.ts` and confirm it fails.
3. Create `agents/skills/lib/site-kit/panels/register.js`:

   ```js
   // <canary-register> -- skipped and removed tests as visible debt, oldest first
   // (#1151 phase 3). No author is shown (the contract refuses one).
   //
   // canary.site/1 cannot yet tell an empty ledger from an unread one (register
   // is a required array), so an empty register is announced as ambiguous
   // rather than rendered as "no debt" -- see #1199.

   import { CanaryPanel, el } from '../panel.js';
   import { ageDays } from '../model.js';

   function row(r, now) {
     const extra = [r.cause, r.issue].filter(Boolean).join(' · ');
     return el(
       'li',
       {},
       el('strong', {}, r.title),
       ' ',
       el('code', {}, r.file),
       el(
         'span',
         { class: 'muted' },
         ` · ${r.kind} · ${r.reason} · ${ageDays(r.recorded_at, now)} day(s) old${extra ? ` · ${extra}` : ''}`,
       ),
     );
   }

   export class Register extends CanaryPanel {
     get heading() {
       return 'Skipped and removed tests';
     }

     build(doc) {
       if (doc.register.length === 0)
         return {
           nodes: [],
           abstentions: [
             'The register lists no skipped or removed tests. An empty register can also mean no ledger was read; this feed does not say which.',
           ],
         };
       const rows = [...doc.register].sort(
         (a, b) => Date.parse(a.recorded_at) - Date.parse(b.recorded_at),
       );
       return {
         nodes: [el('ul', {}, ...rows.map((r) => row(r, this.now())))],
         abstentions: [],
       };
     }
   }
   ```

4. Run the test again and confirm it passes.
5. Run `harness validate`, then commit:

   ```text
   feat(site-kit): register panel — debt by age, empty is announced as ambiguous (Refs #1151)
   ```

### Task 11: `canary-site.js` — registry and feed loader

**Depends on:** Tasks 5–10 | **Files:**
`agents/skills/lib/site-kit/canary-site.js`,
`agents/skills/test/site-kit-registry.test.ts`, `harness.config.json`,
`.harness/perf-baseline.json`

1. Create the test:

   ```ts
   // @vitest-environment happy-dom
   import { readFileSync } from 'node:fs';
   import path from 'node:path';
   import { fileURLToPath } from 'node:url';
   import { beforeEach, describe, expect, it, vi } from 'vitest';
   import { define, loadFeed } from '../lib/site-kit/canary-site.js';
   import { live } from './site-kit-helpers.js';

   const TAGS = [
     'canary-pipeline-health',
     'canary-pass-rate',
     'canary-failures-by-area',
     'canary-flaky',
     'canary-pillars',
     'canary-register',
   ];
   // Under happy-dom, new URL(rel, import.meta.url) resolves to http://localhost,
   // which readFileSync refuses; build a file path instead.
   const HERE = path.dirname(fileURLToPath(import.meta.url));
   const FIXTURE = JSON.parse(
     readFileSync(
       path.join(HERE, 'fixtures/contracts/site.valid.json'),
       'utf8',
     ),
   );
   type Panel = HTMLElement & { feed: { contract: string } | null };
   const panels = () => TAGS.map((t) => document.querySelector(t) as Panel);
   const respond = (status: number, body: unknown) =>
     vi.fn(async () => ({ ok: status < 400, status, json: async () => body }));

   beforeEach(() => {
     document.head.innerHTML = '<meta name="canary-feed" content="site.json">';
     document.body.innerHTML = TAGS.map((t) => `<${t}></${t}>`).join('');
   });

   describe('canary-site.js (#1151 phase 3)', () => {
     it('registers the six panels, and registering twice is harmless', () => {
       expect(() => define()).not.toThrow();
       for (const t of TAGS) expect(customElements.get(t)).toBeDefined();
     });

     it('loads the declared feed into every panel', async () => {
       const fetch = respond(200, FIXTURE);
       await loadFeed(document, fetch);
       expect(fetch).toHaveBeenCalledWith('site.json');
       for (const p of panels()) expect(p.feed!.contract).toBe('canary.site/1');
     });

     it('refuses every panel, with the reason, when the fetch fails', async () => {
       await loadFeed(document, respond(404, null));
       for (const p of panels()) {
         expect(p.feed).toBeNull();
         expect(live(p.shadowRoot!)).toContain(
           'could not be loaded: site.json: HTTP 404',
         );
       }
     });

     it('refuses a feed of another contract or major version (D3)', async () => {
       await loadFeed(
         document,
         respond(200, { ...FIXTURE, contract: 'canary.site/2' }),
       );
       for (const p of panels())
         expect(live(p.shadowRoot!)).toContain('"canary.site/2"');
     });

     it('refuses when the network throws', async () => {
       const fetch = vi.fn(async () => {
         throw new Error('offline');
       });
       await loadFeed(document, fetch);
       for (const p of panels())
         expect(live(p.shadowRoot!)).toContain('offline');
     });

     it('does nothing on a page that declares no feed', async () => {
       document.head.innerHTML = '';
       const fetch = respond(200, FIXTURE);
       await loadFeed(document, fetch);
       expect(fetch).not.toHaveBeenCalled();
     });
   });
   ```

2. Run `npx vitest run test/site-kit-registry.test.ts` and confirm it fails.
3. Create `agents/skills/lib/site-kit/canary-site.js`:

   ```js
   // canary-site -- registers the six QA site panels and loads the feed (#1151
   // phase 3). The kit's one entry point.
   //
   // A page opts in with <meta name="canary-feed" content="site.json">; every
   // canary-* panel on it then gets the parsed feed. A failed fetch, or a feed
   // of another contract or major (D3), is refused on every panel with the
   // reason: a panel never renders "all clear" over a feed it could not read.
   // The kit does not re-validate the feed; canary-barda refuses an invalid one
   // before it is ever published.

   import { PipelineHealth } from './panels/pipeline-health.js';
   import { PassRate } from './panels/pass-rate.js';
   import { FailuresByArea } from './panels/failures-by-area.js';
   import { Flaky } from './panels/flaky.js';
   import { Pillars } from './panels/pillars.js';
   import { Register } from './panels/register.js';

   const CONTRACT = 'canary.site/1';
   const PANELS = {
     'canary-pipeline-health': PipelineHealth,
     'canary-pass-rate': PassRate,
     'canary-failures-by-area': FailuresByArea,
     'canary-flaky': Flaky,
     'canary-pillars': Pillars,
     'canary-register': Register,
   };

   export function define(registry = customElements) {
     for (const [tag, cls] of Object.entries(PANELS))
       if (!registry.get(tag)) registry.define(tag, cls);
   }

   async function read(url, fetchImpl) {
     const res = await fetchImpl(url);
     if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
     const doc = await res.json();
     if (doc?.contract !== CONTRACT)
       throw new Error(
         `${url} is ${JSON.stringify(doc?.contract ?? null)}, not ${CONTRACT}`,
       );
     return doc;
   }

   /**
    * Loads the page's declared feed into every panel; resolves either way.
    * @param {ParentNode} [root]
    * @param {(url: string) => Promise<{ok: boolean, status: number, json(): Promise<any>}>} [fetchImpl]
    */
   export async function loadFeed(
     root = document,
     fetchImpl = globalThis.fetch,
   ) {
     const url = root
       .querySelector('meta[name="canary-feed"]')
       ?.getAttribute('content');
     if (!url) return;
     const panels = root.querySelectorAll(Object.keys(PANELS).join(','));
     try {
       const doc = await read(url, fetchImpl);
       for (const p of panels) p.feed = doc;
     } catch (exc) {
       for (const p of panels)
         p.refuse(`The feed could not be loaded: ${exc.message}`);
     }
   }

   define();
   loadFeed();
   ```

4. `harness.config.json`: add `"agents/skills/lib/site-kit/canary-site.js"`
   directly after `"agents/skills/lib/contracts/validate.mjs"` in **both**
   `entryPoints` arrays (entropy at ~211, performance at ~355). Nothing imports
   it; a browser does. Also add a perf `deltaAllowances` entry to
   `.harness/perf-baseline.json` (precedent: the `npm/src/reporters/ingest.ts`
   entry). `canary-site.js` has coupling ratio 1.00: six imports, and nothing
   imports it. The delta rule has no `--admin` escape.

   ```json
   {
     "rule": "coupling",
     "path": "/agents/skills/lib/site-kit/canary-site.js",
     "why": "browser entry: registers the six panels; imported by no module, only by a page"
   }
   ```

5. Run the test again and confirm it passes. Then run the whole suite with
   `npm test` and confirm coverage stays at or above the floors (90/90/85/90).
6. Run `harness validate`, then commit:

   ```text
   feat(site-kit): canary-site entry — registers panels, refuses an unreadable feed (Refs #1151)
   ```

### Task 12: Kit source rules — tokens only, `DARK_AFTER_DAYS` once

**Depends on:** Task 11 | **Files:** `agents/skills/test/site-kit-rules.test.ts`

1. Create the test:

   ```ts
   // Source rules for the QA site kit (#1151 phase 3, spec "Panels"): panels
   // style only through tokens.css, and DARK_AFTER_DAYS is defined once.
   import { readdirSync, readFileSync } from 'node:fs';
   import { join } from 'node:path';
   import { fileURLToPath } from 'node:url';
   import { describe, expect, it } from 'vitest';

   const KIT = fileURLToPath(new URL('../lib/site-kit/', import.meta.url));
   const files = (ext: string) =>
     readdirSync(KIT, { recursive: true })
       .map(String)
       .filter((f) => f.endsWith(ext))
       .map((f) => ({ file: f, text: readFileSync(join(KIT, f), 'utf8') }));
   const COLOR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;
   // Comments carry issue refs (#1151, #1148) that read as hex colors; the
   // rule is about code, so comments are stripped before matching.
   const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');
   const TOKENS = readFileSync(join(KIT, 'tokens.css'), 'utf8');
   const defined = new Set(
     [...TOKENS.matchAll(/(--canary-[\w-]+)\s*:/g)].map((m) => m[1]),
   );

   describe('site-kit source rules', () => {
     it('reads the whole kit (a zero denominator here is an abstention, not a pass)', () => {
       expect(files('.js')).toHaveLength(9);
     });

     it.each(files('.js'))('$file holds no color literal', ({ text }) => {
       expect(code(text)).not.toMatch(COLOR);
     });

     it.each(files('.js'))(
       '$file uses only tokens tokens.css defines',
       ({ text }) => {
         for (const [, name] of text.matchAll(/var\((--canary-[\w-]+)\)/g))
           expect(defined, name).toContain(name);
       },
     );

     it('defines DARK_AFTER_DAYS exactly once, in model.js', () => {
       const hits = files('.js').filter(({ text }) =>
         /DARK_AFTER_DAYS\s*=/.test(text),
       );
       expect(hits.map((h) => h.file)).toEqual(['model.js']);
     });
   });
   ```

2. **Check the test can fail.** Temporarily add `color: #fff;` to the `CSS`
   string in `panel.js` and confirm the `panel.js holds no color literal` case
   goes red. Then temporarily add `var(--canary-nope)` and confirm the tokens
   case goes red. Revert both, then confirm the test passes.
3. Run `harness validate`, then commit:

   ```text
   test(site-kit): pin token-only styling and a single DARK_AFTER_DAYS (Refs #1151)
   ```

### Task 13: ADR 0036 and the spec's 3a/3b split

**Depends on:** none | **Files:**
`docs/knowledge/decisions/0036-pillars-no-composite-health-score.md`,
`docs/knowledge/decisions/README.md`, `docs/changes/canary-qa-site/proposal.md`

1. Create the ADR:

   ```markdown
   ---
   number: 0036
   title: QA health is shown as pillars, never one composite score
   date: 2026-10-06
   status: accepted
   tier: medium
   source: docs/changes/canary-qa-site/proposal.md
   ---

   <!-- markdownlint-disable-file MD025 -->

   # ADR 0036 — QA health is shown as pillars, never one composite score

   **Status:** accepted **Date:** 2026-10-06 **Deciders:** Bri Stevenski
   **Related:** [#1151](https://github.com/bop-clocktower/canary/issues/1151);
   `docs/changes/canary-qa-site/proposal.md` (D6); ADR 0035 (the two-layer QA
   data contract); ADR 0009 (exit 3 reserved for "abstained")

   ## Context

   An audited QA dashboard's best-explained output was a weighted 0–10 health
   score: each factor had a weight and a reason, and a factor with no data was
   excluded and named rather than counted as zero. The audit's verdict on it was
   "keep". A consumer's health-signal work reached the opposite rule, "pillars,
   never a composite", and canary's strategy is fidelity-labeled evidence over
   verdicts.

   A composite has three problems the factor list does not. Its weights are a
   policy that nobody reviews once they are buried in a number. A drop in one
   factor is masked by a rise in another. And when a factor abstains, the
   composite is either renormalised over fewer factors (a different number with
   the same label) or treated as zero (a false red), and neither is visible in
   the number.

   ## Decision

   The QA site shows every assessment side by side in `<canary-pillars>`:
   status, value with its unit, evidence tier and denominator. A `not-assessed`
   pillar shows its reason as text and announces it in a live region. No panel
   computes or renders a composite, weighted, averaged or "overall" health
   number, and `canary.assessment/1` has no field for one.

   The abstaining-factor behavior from the audited dashboard is kept; the
   weighted sum is not.

   ## Consequences

   - A reader sees which factor is weak, with its evidence tier, instead of one
     number they have to take on trust.
   - A panel test asserts that no composite appears
     (`site-kit-pillars.test.ts`).
   - A team that needs a single traffic light has to derive it outside the kit,
     with its own reviewed weights. Canary will not ship one.

   ## Alternatives Considered

   - **Weighted composite with abstaining factors excluded.** Keeps the audited
     dashboard's best output, but renormalising hides that the number now means
     something different. Rejected.
   - **Worst-of status** (the site is "critical" if any pillar is). Honest about
     direction but still a verdict over evidence, and it hides which pillar.
     Rejected; a reader sees the worst pillar directly.
   - **Composite shown next to the pillars.** The number becomes what people
     quote, which is the masking problem again. Rejected.
   ```

2. `docs/knowledge/decisions/README.md`: add a row after the 0035 row (line
   ~94):

   ```text
   | [0036](0036-pillars-no-composite-health-score.md) | QA health is shown as pillars, never one composite score | accepted |
   ```

3. `proposal.md` Implementation Order item 3: replace its text with

   ```markdown
   3. **Site kit** — two PRs (phase 3 plan, P5): **3a** `tokens.css`, the six
      panels and ADR B (criteria 9–11, 20, 23); **3b** `canary-barda` (criterion
      21).
   ```

   Also change the subcommand form to the flag form, as phase 2's amendment #8
   did for starling. Barda has no `build` subcommand. In `proposal.md:265`,
   `canary-barda build → ./site-out` becomes
   `canary-barda --feed site.json --out ./site-out`. In criterion 21
   (`proposal.md:380`), drop the word "build" after `canary-barda`.

4. Run `npx prettier --write` and `npx markdownlint-cli2` on all three files.
5. Run `harness validate`, then commit:
   `docs(adr): 0036 pillars, never a composite health score (Refs #1151)`

### Task 14: AGENTS.md and roadmap for 3a

**Depends on:** Task 13 | **Files:** `AGENTS.md`, `docs/roadmap.md` |
**Category:** integration

1. `AGENTS.md`: after the `canary-starling` bullet (~line 341), add:

   ```markdown
   - `agents/skills/lib/site-kit/` (#1151): the QA site kit. Six framework-free
     custom elements (pipeline health, pass rate, failures by area, flaky,
     pillars, register) loaded by `canary-site.js` from a page's
     `<meta name="canary-feed">`. Abstentions are text in a live region; styling
     reads only `tokens.css`; no composite score (ADR 0036).
   ```

2. `docs/roadmap.md` #1151 summary: after the phase 2 sentence, add
   `Phase 3a landed the site kit (six panels, tokens, ADR 0036).` Do not change
   the row count.
3. Run prettier and markdownlint on both files.
4. Run `harness validate`, then commit:

   ```text
   docs(canary-qa-site): record phase 3a in AGENTS.md and the roadmap (Refs #1151)
   ```

### Task 15: Gates, ratchets, ship 3a

**Depends on:** Tasks 1–14 | **Files:** none, or
`.harness/arch/allowances/feat-1151-qa-site-kit.json`

1. Fetch, and rebase onto `origin/main` if it moved.
2. Run the four gates on the latest tree and record each denominator (a zero is
   a failure):
   - `ts/`: `npm run -s build`, `typecheck`, `format:check`, `npm test`
   - `agents/skills/`: `npm run -s typecheck`, `format:check`, `npm test`
     (coverage floors hold)
3. Ratchets: measure `harness check-deps` (from the repo root),
   `harness check-perf`, `harness check-arch --json` and entropy in clean
   worktrees at the merge base and at the branch head. None may rise.
4. **[checkpoint:decision]** If arch `module-size` grew (expected: the kit is
   new code), stop and show both numbers. Then either add
   `.harness/arch/allowances/feat-1151-qa-site-kit.json`, shaped like
   `feat-1151-qa-site-producers.json` (reason, `categories.module-size`,
   `violationIds: []`, `createdFrom`), with your sign-off, or pay the growth
   down. With an allowance, set `.harness/arch/baselines.json`
   `module-size.value` to the allowance value in the same PR (as phase 2 did,
   50991 → 51697), or `ts/test/arch-baseline-freshness.test.ts` goes red. Never
   raise `maxFindings` and never raise any other baseline.
5. Ship through the `canary-ship` skill: reviewers on the diff, resolve every
   confirmed finding with a test, squash-merge on green with `--admin`. The PR
   body says `Refs #1151` and never a closing keyword (the issue tracks five
   phases).
6. After the merge, confirm `main` CI is green.

---

**— Milestone: 3a merged. Re-read Tasks 16–23 against the new `main` before
starting; correct any line number or snippet that drifted. —**

## Milestone 3b — `canary-barda`

New branch `feat/1151-qa-site-barda` off the post-3a `main`, in a new worktree.

### Task 16: `page.mjs` and the naming-registry row

**Depends on:** Task 15 | **Files:**
`agents/skills/claude-code/canary-barda/scripts/page.mjs`,
`agents/skills/test/canary-barda.test.ts`, `docs/naming-registry.md`

1. `docs/naming-registry.md`: add the following row alphabetically.
   `ts/test/bop-name-registry.test.ts` reds as soon as the skill directory
   exists without it.

   ```text
   | `canary-barda` | shipped | 1151 | QA site builder (static site from a validated canary.site/1 feed) |
   ```

2. Create `agents/skills/test/canary-barda.test.ts`:

   ```ts
   import { readFileSync } from 'node:fs';
   import { describe, expect, it } from 'vitest';
   import {
     page,
     PANEL_TAGS,
   } from '../claude-code/canary-barda/scripts/page.mjs';

   describe('canary-barda page', () => {
     const html = page({ title: 'QA' });

     it('places each of the six panels once', () => {
       expect(PANEL_TAGS).toHaveLength(6);
       for (const tag of PANEL_TAGS)
         expect(html.match(new RegExp(`<${tag}>`, 'g'))).toHaveLength(1);
     });

     it('names the same tags the kit registers', () => {
       const kit = readFileSync(
         new URL('../lib/site-kit/canary-site.js', import.meta.url),
         'utf8',
       );
       for (const tag of PANEL_TAGS) expect(kit).toContain(`'${tag}'`);
     });

     it("has no inline script, style or handler, so script-src 'self' holds", () => {
       expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
       expect(html).not.toMatch(/<style|\sstyle=|\son[a-z]+=/i);
       expect(html).toContain(
         '<script type="module" src="kit/canary-site.js"></script>',
       );
     });

     it('declares the feed for the kit', () => {
       expect(html).toContain('<meta name="canary-feed" content="site.json">');
     });

     it('escapes the title', () => {
       const out = page({ title: '<b>&"x\'' });
       expect(out).not.toContain('<b>');
       expect(out).toContain('&#60;b&#62;&#38;&#34;x&#39;');
     });
   });
   ```

3. Run `npx vitest run test/canary-barda.test.ts` and confirm it fails.
4. Create `agents/skills/claude-code/canary-barda/scripts/page.mjs`:

   ```js
   // page -- the index.html canary-barda writes (#1151 phase 3b).
   //
   // No inline script, no inline style and no handler attribute: the page loads
   // kit/canary-site.js and kit/*.css from its own origin, so it runs under a
   // `script-src 'self'` CSP. The kit finds the feed through the meta tag.

   /** Must match the tags lib/site-kit/canary-site.js registers (tested). */
   export const PANEL_TAGS = [
     'canary-pipeline-health',
     'canary-pass-rate',
     'canary-failures-by-area',
     'canary-flaky',
     'canary-pillars',
     'canary-register',
   ];

   const escape = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

   export function page({ title }) {
     const t = escape(title);
     return `<!doctype html>
   <html lang="en">
     <head>
       <meta charset="utf-8">
       <meta name="viewport" content="width=device-width, initial-scale=1">
       <meta name="canary-feed" content="site.json">
       <title>${t}</title>
       <link rel="stylesheet" href="kit/tokens.css">
       <link rel="stylesheet" href="kit/page.css">
       <script type="module" src="kit/canary-site.js"></script>
     </head>
     <body>
       <main>
         <h1>${t}</h1>
   ${PANEL_TAGS.map((tag) => `      <${tag}></${tag}>`).join('\n')}
       </main>
     </body>
   </html>
   `;
   }
   ```

5. Run the test again and confirm it passes. Then run
   `cd ../../ts && npx vitest run test/bop-name-registry.test.ts`.
6. Run `harness validate`, then commit:
   `feat(canary-barda): static page template and name registration (Refs #1151)`

### Task 17: `build.mjs`, `feed.mjs` and `page.css`

**Depends on:** Task 16 | **Files:**
`agents/skills/claude-code/canary-barda/scripts/build.mjs`,
`agents/skills/claude-code/canary-barda/scripts/feed.mjs`,
`agents/skills/lib/site-kit/page.css`, `agents/skills/test/canary-barda.test.ts`

1. Append to `canary-barda.test.ts`. Merge these imports into the top of the
   file (add `afterEach` to the existing vitest import):

   ```ts
   import fs from 'node:fs';
   import os from 'node:os';
   import path from 'node:path';
   import {
     buildSite,
     outProblem,
   } from '../claude-code/canary-barda/scripts/build.mjs';
   import { readFeed } from '../claude-code/canary-barda/scripts/feed.mjs';
   import { siteFeed } from './site-kit-helpers.js';
   ```

   Then append:

   ```ts
   const tmps: string[] = [];
   const tmp = () => {
     const d = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-barda-'));
     tmps.push(d);
     return d;
   };
   afterEach(() => {
     while (tmps.length)
       fs.rmSync(tmps.pop()!, { recursive: true, force: true });
   });
   const fixture = (name: string) =>
     new URL(`./fixtures/contracts/${name}`, import.meta.url).pathname;
   const write = (doc: unknown) => {
     const f = path.join(tmp(), 'site.json');
     fs.writeFileSync(f, typeof doc === 'string' ? doc : JSON.stringify(doc));
     return f;
   };

   describe('canary-barda build', () => {
     it('reads a valid feed', () => {
       const { doc, errors } = readFeed(fixture('site.valid.json'));
       expect(errors).toEqual([]);
       expect(doc!.contract).toBe('canary.site/1');
     });

     it.each([
       ['unparseable JSON', '{', 'not parseable JSON'],
       [
         'a run record, not a site feed',
         JSON.parse(fs.readFileSync(fixture('run.valid.json'), 'utf8')),
         'canary.run/1',
       ],
       [
         'a feed with a bare-string scope',
         { ...siteFeed(), scopes: ['canary'] },
         'scopes',
       ],
     ])('refuses %s', (_name, doc, needle) => {
       const { doc: got, errors } = readFeed(write(doc));
       expect(got).toBeNull();
       expect(errors.join('\n')).toContain(needle);
     });

     it('refuses a missing file', () => {
       expect(readFeed(path.join(tmp(), 'nope.json')).errors[0]).toMatch(
         /^cannot read /,
       );
     });

     it('accepts a missing or empty out dir and refuses anything else', () => {
       const base = tmp();
       expect(outProblem(path.join(base, 'new'))).toBeNull();
       expect(outProblem(base)).toBeNull();
       fs.writeFileSync(path.join(base, 'stale.txt'), 'x');
       expect(outProblem(base)).toMatch(/is not empty/);
       expect(outProblem(path.join(base, 'stale.txt'))).toMatch(
         /is not a directory/,
       );
     });

     it('writes index.html, the feed and the whole kit', () => {
       const out = path.join(tmp(), 'site');
       const doc = siteFeed();
       const count = buildSite(doc, out, { title: 'QA' });
       const kit = [
         'canary-site.js',
         'model.js',
         'panel.js',
         'tokens.css',
         'page.css',
       ];
       for (const f of [
         'index.html',
         'site.json',
         ...kit.map((k) => `kit/${k}`),
       ])
         expect(fs.existsSync(path.join(out, f)), f).toBe(true);
       expect(fs.readdirSync(path.join(out, 'kit/panels'))).toHaveLength(6);
       expect(
         JSON.parse(fs.readFileSync(path.join(out, 'site.json'), 'utf8')),
       ).toEqual(doc);
       expect(count).toBe(2 + 9 + 2);
     });
   });
   ```

   Before running, confirm that `run.valid.json`'s refusal message contains
   `canary.run/1` (`validateText(text, {layer: 'site'})` names the wrong layer).
   If the wording differs, use the actual fragment.

2. Run `npx vitest run test/canary-barda.test.ts` and confirm it fails.
3. Create `agents/skills/lib/site-kit/page.css`:

   ```css
   /* Layout for a canary-barda standalone page (#1151 phase 3b). Tokens only. */
   body {
     margin: 0;
     background: var(--canary-bg);
     color: var(--canary-text);
     font-family: var(--canary-font);
   }
   main {
     display: grid;
     gap: var(--canary-space-2);
     grid-template-columns: repeat(auto-fit, minmax(min(100%, 22rem), 1fr));
     max-width: 72rem;
     margin: 0 auto;
     padding: var(--canary-space-2);
   }
   h1 {
     grid-column: 1 / -1;
     margin: 0;
     font-size: 1.4rem;
   }
   ```

4. Create `agents/skills/claude-code/canary-barda/scripts/build.mjs`:

   ```js
   // build -- a validated canary.site/1 feed into a static site directory
   // (#1151 phase 3b).
   //
   // The feed is validated before anything is written: an invalid feed builds
   // nothing (spec criterion 21). The kit is copied verbatim from lib/site-kit/,
   // which ships beside this skill in the npm package. The out dir must be new or
   // empty -- barda never deletes or overwrites a file it did not write.

   import fs from 'node:fs';
   import path from 'node:path';
   import { fileURLToPath } from 'node:url';

   import { page } from './page.mjs';

   const KIT_DIR = fileURLToPath(
     new URL('../../../lib/site-kit/', import.meta.url),
   );

   /** Why `out` cannot be built into, or null. */
   export function outProblem(out) {
     if (!fs.existsSync(out)) return null;
     if (!fs.statSync(out).isDirectory()) return `${out} is not a directory`;
     if (fs.readdirSync(out).length > 0)
       return `${out} is not empty; build into a new or empty directory`;
     return null;
   }

   const countFiles = (dir) =>
     fs
       .readdirSync(dir, { recursive: true, withFileTypes: true })
       .filter((d) => d.isFile()).length;

   /** Writes index.html, site.json and kit/ into `out`; returns the file count. */
   export function buildSite(doc, out, { title }) {
     fs.mkdirSync(out, { recursive: true });
     fs.cpSync(KIT_DIR, path.join(out, 'kit'), { recursive: true });
     fs.writeFileSync(
       path.join(out, 'site.json'),
       JSON.stringify(doc) + '\n',
       'utf8',
     );
     fs.writeFileSync(path.join(out, 'index.html'), page({ title }), 'utf8');
     return countFiles(out);
   }
   ```

   Create `agents/skills/claude-code/canary-barda/scripts/feed.mjs`. It is split
   from `build.mjs` to keep both under the perf coupling rule
   (`fanIn + fanOut > 5` at a ratio above 0.7). It imports `document.mjs`, not
   `validate.mjs`; see the warning at `document.mjs:5-7` and starling's
   `feed.mjs:9`.

   ```js
   // feed -- read and validate the canary.site/1 feed canary-barda builds from
   // (#1151 phase 3b). An unreadable or invalid feed is a refusal, never a
   // partial build.

   import fs from 'node:fs';

   import { validateText } from '../../../lib/contracts/document.mjs';

   /** {doc, errors}: doc is null when the feed is unreadable or invalid. */
   export function readFeed(file) {
     let text;
     try {
       text = fs.readFileSync(file, 'utf8');
     } catch (exc) {
       return { doc: null, errors: [`cannot read ${file}: ${exc.message}`] };
     }
     const v = validateText(text, { layer: 'site' });
     if (!v.valid)
       return {
         doc: null,
         errors: v.errors.map((e) => `${e.path}: ${e.message}`),
       };
     return { doc: JSON.parse(text), errors: [] };
   }
   ```

5. In `test/site-kit-rules.test.ts`, extend the color rule to every kit CSS file
   except `tokens.css`:

   ```ts
   const sheets = files('.css').filter((f) => f.file !== 'tokens.css');
   it('styles page.css only through tokens', () => {
     expect(sheets.map((s) => s.file)).toEqual(['page.css']);
     for (const { text } of sheets) {
       expect(code(text)).not.toMatch(COLOR);
       for (const [, name] of text.matchAll(/var\((--canary-[\w-]+)\)/g))
         expect(defined, name).toContain(name);
     }
   });
   ```

6. Run both test files and confirm they pass. If `readdirSync` with
   `withFileTypes` and `recursive` miscounts on Node 20, use

   ```text
   fs.readdirSync(dir, {recursive: true}).filter((f) => fs.statSync(path.join(dir, f)).isFile())
   ```

7. Run `harness validate`, then commit:

   ```text
   feat(canary-barda): validated build into a self-contained site dir (Refs #1151)
   ```

### Task 18: `cli.mjs` and `SKILL.md`

**Depends on:** Task 17 | **Files:**
`agents/skills/claude-code/canary-barda/scripts/cli.mjs`,
`agents/skills/claude-code/canary-barda/SKILL.md`,
`agents/skills/test/canary-barda.test.ts`

1. Append CLI tests to `canary-barda.test.ts`. Add `vi` to the vitest import and

   ```text
   import { main as bardaMain } from '../claude-code/canary-barda/scripts/cli.mjs';
   ```

   ```ts
   function run(argv: string[]) {
     const out: string[] = [];
     const err: string[] = [];
     vi.spyOn(console, 'log').mockImplementation(
       (...a) => void out.push(a.join(' ')),
     );
     vi.spyOn(console, 'error').mockImplementation(
       (...a) => void err.push(a.join(' ')),
     );
     const code = bardaMain(argv);
     vi.restoreAllMocks();
     return { code, stdout: out.join('\n'), stderr: err.join('\n') };
   }

   describe('canary-barda cli', () => {
     it('builds a valid feed and says what it wrote', () => {
       const out = path.join(tmp(), 'site');
       const r = run([
         '--feed',
         fixture('site.valid.json'),
         '--out',
         out,
         '--title',
         'Canary QA',
       ]);
       expect(r.code).toBe(0);
       expect(r.stdout).toMatch(/built .*: 13 file\(s\), 6 panels, 2 run\(s\)/);
       expect(fs.readFileSync(path.join(out, 'index.html'), 'utf8')).toContain(
         '<title>Canary QA</title>',
       );
     });

     it('builds nothing from an invalid feed (exit 1)', () => {
       const out = path.join(tmp(), 'site');
       const r = run(['--feed', write('{'), '--out', out]);
       expect(r.code).toBe(1);
       expect(r.stderr).toContain('invalid feed');
       expect(r.stderr).toContain('nothing built');
       expect(fs.existsSync(out)).toBe(false);
     });

     it('refuses a non-empty out dir (exit 1)', () => {
       const out = tmp();
       fs.writeFileSync(path.join(out, 'keep.txt'), 'x');
       expect(
         run(['--feed', fixture('site.valid.json'), '--out', out]).code,
       ).toBe(1);
       expect(fs.readdirSync(out)).toEqual(['keep.txt']);
     });

     it('reports an out path it cannot create (exit 1, no stack trace)', () => {
       const file = path.join(tmp(), 'plain.txt');
       fs.writeFileSync(file, 'x');
       const r = run([
         '--feed',
         fixture('site.valid.json'),
         '--out',
         path.join(file, 'site'),
       ]);
       expect(r.code).toBe(1);
       expect(r.stderr).toContain('cannot build into');
     });

     it('abstains loudly on a feed with zero runs; exit 3 under --strict', () => {
       const feed = write(siteFeed());
       const soft = run(['--feed', feed, '--out', path.join(tmp(), 'a')]);
       expect(soft.code).toBe(0);
       expect(soft.stdout).toContain('ABSTAINED');
       expect(soft.stdout).not.toContain('6 panels,');
       expect(
         run(['--feed', feed, '--out', path.join(tmp(), 'b'), '--strict']).code,
       ).toBe(3);
     });

     it('is a usage error without --out (exit 2)', () => {
       expect(run(['--feed', fixture('site.valid.json')]).code).toBe(2);
     });
   });
   ```

2. Run `npx vitest run test/canary-barda.test.ts` and confirm the new cases
   fail.
3. Create `agents/skills/claude-code/canary-barda/scripts/cli.mjs`:

   ```js
   #!/usr/bin/env node
   // canary-barda -- build a standalone QA site from a canary.site/1 feed
   // (#1151 phase 3b).
   //
   // Validates the feed, then writes index.html, site.json and the site kit into
   // --out. An invalid feed builds nothing. A feed with zero runs still builds
   // (every run panel abstains on the page) but says so: ABSTAINED, exit 3 under
   // --strict (#508). Writes only, never deploys.
   //
   // Exit: 0 built · 1 unreadable/invalid feed or unusable --out · 2 usage ·
   // 3 under --strict when the feed carries zero runs.
   //
   // Invoked via `canary skills run canary-barda -- --feed <file> --out <dir>`.

   import {
     createParser,
     formatUsageError,
     EXIT_USAGE,
   } from '../../../lib/parse-args.mjs';
   import { isMain } from '../../../lib/is-main.mjs';
   import { buildSite, outProblem } from './build.mjs';
   import { readFeed } from './feed.mjs';

   const PREFIX = 'canary-barda:';
   const EXIT_ABSTAINED = 3;

   const USAGE =
     'usage: canary-barda [-h] --feed PATH --out DIR [--title TEXT] [--strict]\n' +
     '\n' +
     'Build a static QA site (index.html, site.json, kit/) from a canary.site/1\n' +
     'feed. The feed is validated first; an invalid feed builds nothing.';

   export const CLI_SPEC = {
     prog: 'canary-barda',
     booleans: { '--strict': 'strict' },
     values: {
       '--feed': { key: 'feed' },
       '--out': { key: 'out' },
       '--title': { key: 'title' },
     },
     defaults: { title: 'QA site' },
     required: ['--feed', '--out'],
   };

   const parseArgs = createParser(CLI_SPEC);

   function summarize(args, doc, files) {
     if (doc.runs.length === 0) {
       // A page of abstentions is honest; a "built" line over it reads as done.
       console.log(
         `${PREFIX} ABSTAINED: built ${args.out} from a feed with 0 runs; every run panel will abstain.`,
       );
       return args.strict ? EXIT_ABSTAINED : 0;
     }
     console.log(
       `${PREFIX} built ${args.out}: ${files} file(s), 6 panels, ${doc.runs.length} run(s)`,
     );
     return 0;
   }

   export function main(argv = []) {
     const { opts: args, help, error } = parseArgs(argv);
     if (help) {
       console.log(USAGE);
       return 0;
     }
     if (error) {
       console.error(formatUsageError(CLI_SPEC.prog, error));
       return EXIT_USAGE;
     }
     const { doc, errors } = readFeed(args.feed);
     if (!doc) {
       for (const e of errors) console.error(`${PREFIX} invalid feed: ${e}`);
       console.error(`${PREFIX} nothing built`);
       return 1;
     }
     const blocked = outProblem(args.out);
     if (blocked) {
       console.error(`${PREFIX} ${blocked}`);
       return 1;
     }
     let files;
     try {
       files = buildSite(doc, args.out, { title: args.title });
     } catch (exc) {
       // e.g. --out under a regular file: ENOTDIR, never a raw stack trace.
       console.error(`${PREFIX} cannot build into ${args.out}: ${exc.message}`);
       return 1;
     }
     return summarize(args, doc, files);
   }

   // `process.exitCode`, not `process.exit()` (#791).
   if (isMain(import.meta.url)) {
     process.exitCode = main(process.argv.slice(2));
   }
   ```

4. Make it executable: `chmod +x` on `cli.mjs`, then
   `git add --chmod=+x agents/skills/claude-code/canary-barda/scripts/cli.mjs`
   (`skill-cli-conformance.test.ts` checks the mode).
5. Create `agents/skills/claude-code/canary-barda/SKILL.md`:

   ````markdown
   ---
   name: canary-barda
   description:
     QA site builder. Turns a validated canary.site/1 feed (from
     canary-starling) into a self-contained static site — index.html, site.json
     and the site kit's six panels — that runs under a strict `script-src
     'self'` CSP. An invalid feed builds nothing; a feed with zero runs still
     builds but reports ABSTAINED. Writes only, never deploys.
   cli: scripts/cli.mjs
   requires: [node>=20]
   ---

   # Canary Barda

   `canary-starling` writes the feed; `canary-barda` turns it into a page. The
   page shows six panels — pipeline health, pass rate, failures by area, flaky
   tests, pillars, and the skipped/removed register — and every one of them says
   what it could not show instead of rendering an empty "all clear".

   ## What this is not

   - **Not a deployer.** It writes a directory. Publishing it is the site
     workflow's job.
   - **Not a feed composer.** It reads one `canary.site/1` file; build it with
     `canary-starling`.
   - **Not a dashboard server.** No server, database or auth: the output is
     static files.

   ## Invocation

   ```bash
   canary skills run canary-barda -- \
     --feed site/site.json --out site-out --title "Canary QA"

   # Usage and the full flag list (exits 0):
   canary skills run canary-barda -- --help
   ```

   | Flag       | Default   | Meaning                                      |
   | ---------- | --------- | -------------------------------------------- |
   | `--feed`   | required  | a `canary.site/1` feed; validated before use |
   | `--out`    | required  | a new or empty directory to build into       |
   | `--title`  | `QA site` | page title and heading                       |
   | `--strict` | off       | exit 3 when the feed carries zero runs       |

   ## Output

   ```text
   site-out/
     index.html      six panels, no inline script or style
     site.json       the feed, as validated
     kit/            canary-site.js, model.js, panel.js, panels/, tokens.css, page.css
   ```

   Serve the directory from any static host. `index.html` declares the feed with
   `<meta name="canary-feed" content="site.json">`; `kit/canary-site.js` loads
   it.

   ## Honest degradation

   - **Invalid or unparseable feed:** nothing is written (exit 1), and every
     validation error is printed.
   - **Non-empty `--out`:** refused (exit 1). Barda never overwrites a file it
     did not write.
   - **Zero runs:** the site builds, every run panel abstains on the page, and
     the CLI prints `ABSTAINED` (exit 3 under `--strict`).
   - **On the page:** a panel that cannot show something says why, in text,
     inside a live region. No panel shows a composite score (ADR 0036).

   ## Theming

   Panels read only the custom properties in `kit/tokens.css`. Redefine them on
   `:root` (or set `data-theme="dark"` / `"light"`) to re-theme. Embedding
   panels in an existing site is `canary-vixen`'s job (phase 4).
   ````

6. Run
   `npx vitest run test/canary-barda.test.ts test/skill-cli-conformance.test.ts`
   and confirm both pass (the conformance suite discovers barda from
   `SKILL.md`'s `cli:`). The Invocation example must stay a `bash` fence:
   `ts/src/core/skill-examples.ts:56` reads only shell-fenced blocks. Then, from
   `ts/`, run `npx vitest run test/skill-examples.test.ts`.
7. Run `harness validate`, then commit:
   `feat(canary-barda): CLI and skill doc (Refs #1151)`

### Task 19: The built site renders all six panels (criterion 21)

**Depends on:** Task 18 | **Files:**
`agents/skills/test/canary-barda-render.test.ts`

1. Create the test:

   ```ts
   // @vitest-environment happy-dom
   // Criterion 21 end to end: the kit as COPIED into a site built by the real
   // CLI (not the source tree) renders each of the six panels from the built
   // site.json.
   //
   // Two happy-dom constraints shape this (soundness review, must-fix 3):
   // build.mjs is not imported, because document.mjs resolves its schemas from
   // import.meta.url, which happy-dom rewrites to http://localhost; and vitest
   // cannot import() from os.tmpdir(), so the site is built under
   // node_modules/ (gitignored).
   import { spawnSync } from 'node:child_process';
   import fs from 'node:fs';
   import path from 'node:path';
   import { fileURLToPath, pathToFileURL } from 'node:url';
   import { afterAll, expect, it, vi } from 'vitest';
   import { PANEL_TAGS } from '../claude-code/canary-barda/scripts/page.mjs';

   const HERE = path.dirname(fileURLToPath(import.meta.url));
   const ROOT = path.join(process.cwd(), 'node_modules', '.barda-render');
   fs.mkdirSync(ROOT, { recursive: true });
   const out = path.join(fs.mkdtempSync(path.join(ROOT, 'r-')), 'site');
   afterAll(() =>
     fs.rmSync(path.dirname(out), { recursive: true, force: true }),
   );

   it('renders every panel of a built site from its own kit and feed', async () => {
     const built = spawnSync(
       process.execPath,
       [
         path.join(HERE, '../claude-code/canary-barda/scripts/cli.mjs'),
         '--feed',
         path.join(HERE, 'fixtures/contracts/site.valid.json'),
         '--out',
         out,
       ],
       { encoding: 'utf8', timeout: 20_000 },
     );
     expect(built.status, built.stderr).toBe(0);
     // Import before the page declares a feed, so the kit's own auto-load is a no-op.
     const kit = await import(
       pathToFileURL(path.join(out, 'kit', 'canary-site.js')).href
     );

     const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
     expect(html).toContain('<script type="module" src="kit/canary-site.js">');
     // Strip script and stylesheet tags so happy-dom fetches nothing.
     const parsed = new DOMParser().parseFromString(
       html.replace(/<script[^>]*><\/script>|<link[^>]*>/g, ''),
       'text/html',
     );
     document.head.innerHTML = parsed.head.innerHTML;
     document.body.innerHTML = parsed.body.innerHTML;

     const fetch = vi.fn(async (url: string) => ({
       ok: true,
       status: 200,
       json: async () =>
         JSON.parse(fs.readFileSync(path.join(out, url), 'utf8')),
     }));
     await kit.loadFeed(document, fetch);

     for (const tag of PANEL_TAGS) {
       const panel = document.querySelector(tag) as HTMLElement & {
         feed: unknown;
       };
       expect(panel.feed, tag).not.toBeNull();
       expect(panel.shadowRoot!.querySelector('h2')!.textContent, tag).not.toBe(
         '',
       );
       expect(panel.shadowRoot!.textContent, tag).not.toContain(
         'could not be loaded',
       );
     }
   });
   ```

2. Run `npx vitest run test/canary-barda-render.test.ts` and confirm it passes.
   It exercises code from Tasks 11, 17 and 18, so a pass on first run is
   expected. Check that it can fail: temporarily stop `buildSite` from copying
   `panels/` (for example, delete `kit/panels/flaky.js` right after the
   `cpSync`), confirm the test goes red, then revert.
3. Run `harness validate`, then commit:

   ```text
   test(canary-barda): the built site renders all six panels (criterion 21, Refs #1151)
   ```

### Task 20: Registrations — entry points, format, coverage

**Depends on:** Task 18 | **Files:** `harness.config.json`,
`agents/skills/package.json`, `agents/skills/vitest.config.ts` | **Category:**
integration

1. `harness.config.json`: add
   `"agents/skills/claude-code/canary-barda/scripts/cli.mjs"` after the
   `canary-starling` `cli.mjs` line in **both** `entryPoints` arrays.
2. `package.json` `format:check`: add
   `\"claude-code/canary-barda/scripts/*.mjs\"` after the starling glob.
3. `vitest.config.ts` coverage `include`: add
   `'claude-code/canary-barda/scripts/**/*.mjs',` after the starling line.
4. Run `npm run -s format:check` and `npm test` (coverage floors hold).
5. Run `harness validate`, then commit:

   ```text
   chore(canary-barda): register entry points, format and coverage globs (Refs #1151)
   ```

### Task 21: Gate-conformance row and the skills README

**Depends on:** Task 18 | **Files:**
`agents/skills/test/gate-conformance.test.ts`, `agents/skills/README.md` |
**Category:** integration

1. `gate-conformance.test.ts`: import

   ```ts
   import { main as bardaMain } from '../claude-code/canary-barda/scripts/cli.mjs';
   ```

   and add a row after starling's:

   ```ts
     {
       command: 'canary-barda (zero runs in the feed)',
       forbid: ['6 panels,'],
       run: (base) => run(bardaMain, bardaArgs(base)),
       strict: (base) => run(bardaMain, [...bardaArgs(base), '--strict']),
     },
   ```

   Add this helper next to `starlingArgs`:

   ```ts
   /** A valid feed with zero runs, and a fresh out dir per call. */
   function bardaArgs(base: string): string[] {
     const feed = path.join(base, 'site.json');
     fs.writeFileSync(
       feed,
       JSON.stringify({
         contract: 'canary.site/1',
         generated_at: '2026-10-06T00:00:00Z',
         scopes: [{ id: 'canary', env: 'ci' }],
         suites: null,
         runs: [],
         flaky: [],
         assessments: [],
         register: [],
       }),
     );
     return ['--feed', feed, '--out', fs.mkdtempSync(path.join(base, 'site-'))];
   }
   ```

2. `agents/skills/README.md`: add `│   ├── canary-barda/` to the tree (~line 40,
   alphabetical). Add this bullet before `canary-starling` (~line 131):

   ```markdown
   - [`canary-barda`](./claude-code/canary-barda/SKILL.md) — Bundled executable
     skill (`scripts/cli.mjs`). QA site builder: validates a `canary.site/1`
     feed and writes a self-contained static site (index.html, site.json, the
     six-panel kit) that runs under `script-src 'self'`. An invalid feed builds
     nothing; zero runs builds but reports ABSTAINED.
   ```

   Add `` `canary-barda`, `` to the executable-skills list (~line 306).

3. Run `npx vitest run test/gate-conformance.test.ts`, then prettier and
   markdownlint on the README.
4. Run `harness validate`, then commit:

   ```text
   test(canary-barda): hold the zero-run feed to the abstention contract (Refs #1151)
   ```

### Task 22: AGENTS.md and roadmap for 3b

**Depends on:** Task 21 | **Files:** `AGENTS.md`, `docs/roadmap.md` |
**Category:** integration

1. `AGENTS.md`: after the site-kit bullet from Task 14, add

   ```markdown
   - `canary-barda` (#1151): builds a self-contained static QA site from a
     validated `canary.site/1` feed (index.html + site.json + kit/). An invalid
     feed builds nothing; a non-empty out dir is refused; zero runs reports
     ABSTAINED.
   ```

2. `docs/roadmap.md` #1151 summary: change the 3a sentence to

   ```markdown
   Phase 3 landed the site kit (six panels, tokens, ADR 0036) and
   `canary-barda`.
   ```

3. Run prettier and markdownlint on both files.
4. Run `harness validate`, then commit:

   ```text
   docs(canary-qa-site): record phase 3b in AGENTS.md and the roadmap (Refs #1151)
   ```

### Task 23: Gates, ratchets, ship 3b

**Depends on:** Tasks 16–22 | **Files:** none, or
`.harness/arch/allowances/feat-1151-qa-site-barda.json`

Same steps as Task 15, on branch `feat/1151-qa-site-barda`, with the
**[checkpoint:decision]** for any arch growth. Also run

```text
canary skills run canary-barda -- --feed agents/skills/test/fixtures/contracts/site.valid.json --out <tmp>/site
```

and open `<tmp>/site/index.html` through a static server
(`npx http-server <tmp>/site`) to check it by eye. This is
**[checkpoint:human-verify]**: show a screenshot before shipping.

## Traceability

| Truth | Tasks          |
| ----- | -------------- |
| T1    | 3, 6           |
| T2    | 3, 5           |
| T3    | 4, 5–10, 11    |
| T4    | 9, 13          |
| T5    | 8              |
| T6    | 16, 17, 18, 19 |
| T7    | 2, 3, 12, 17   |
| T8    | 13             |
| T9    | 18, 21         |
| T10   | 1, 15, 20, 23  |
