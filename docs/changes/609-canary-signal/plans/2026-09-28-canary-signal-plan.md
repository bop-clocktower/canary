# Plan: canary-signal — QA impact digest (#609)

**Date:** 2026-09-28 | **Spec:** `docs/changes/609-canary-signal/proposal.md` |
**Tasks:** 10 | **Time:** ~45 min | **Integration Tier:** large (new skill) |
**Rigor:** standard

## Goal

`canary skills run canary-signal -- --history <jsonl>` emits a markdown digest
and a chat-ready block of what testing caught in a window. Every number shows
its denominator, and the digest abstains honestly when the sample is empty or
thin.

## Observable Truths (Acceptance Criteria)

Numbered to match the spec's success criteria (SC).

1. **SC1** — When the store holds ≥3 runs in the window, the system shall print
   `**Sample:** N runs across S suites on K days, <since> → <until>`, one line
   per metric with its denominator, and a fenced chat block of ≤8 plain lines
   whose first line carries the sample line. Exit 0.
2. **SC2** — When the window holds zero runs, the system shall print
   `ABSTAINED: no runs recorded in the window …` and shall not print
   `What testing caught`. Exit 0 advisory, 3 under `--strict`.
3. **SC3** — When the window holds 1–2 runs, the system shall print
   `**THIN SAMPLE:** N run(s) in the window`.
4. **SC4** — If no run in the window is on a non-default branch, then the system
   shall not print a number for the pre-merge line. It prints
   `ABSTAINED — no runs on branches other than <branch> in the window`.
5. **SC5** — If no windowed run has `reporter_format` ∈ {playwright, junit},
   then the system shall not print a flaky count. The line abstains.
6. **SC6** — When the ledger is absent at the default path
   `.canary/quarantine.json`, the Dark sources section shall name it. When an
   explicit `--ledger` path does not exist, the system shall exit 1.
7. **SC7** — The system shall always list `production escapes:` under Dark
   sources.
8. **SC8** — The skill's scripts shall import no network or process module. A
   run without `--out` shall leave its cwd and the store directory unchanged.
9. **SC9** — `--help` exits 0 and an unknown flag exits 2
   (`skill-cli-conformance.test.ts` discovers the skill through `cli:`).
10. The four gates and the entropy/perf/docs ratchets are green against the
    merge base, each with a non-zero denominator.

## Uncertainties

- [ASSUMPTION] A run whose `branch` is missing or empty is counted in
  **neither** branch line. The digest then shows it as a note
  (`N runs with no branch counted in neither branch line`). The spec does not
  say where branchless runs go. Counting them as pre-merge would inflate the
  number that makes QA look good.
- [ASSUMPTION] A "failing test" is `status === 'failed'` only. A `flaky` test
  passed on retry, so it has its own line and is never counted as a catch.
- [ASSUMPTION] The window is `[until − days×24h, until]`, inclusive at both
  ends. "Distinct days" means distinct UTC calendar days.
- [ASSUMPTION] A ledger file that exists but has zero entries is a dark source.
  This follows the spec's metrics table ("present and non-empty (else dark)").
- [ASSUMPTION] Ledger rows with an empty or unparseable `date` are excluded but
  counted. Katana writes `date: ''` when no commit is found
  (`canary-katana/scripts/cli.mjs:129`).
- [ASSUMPTION] The default ledger path resolves against cwd, as katana's does.
- [ASSUMPTION] The roadmap row is flipped to `done` **in place**, not moved to
  `roadmap-archive.md`. Changing the row count reds the AGENTS.md tests, so the
  archive move, if wanted, is a separate change.
- [DEFERRABLE] Final copy wording. The tests pin the load-bearing phrases
  (`ABSTAINED`, `THIN SAMPLE`, `Dark sources`, `production escapes:`, and the
  absence of "prevent").
- [DEFERRABLE] `loadRuns` duplicates `canary-screech/scripts/history.mjs`
  because skills are self-contained by contract (#479 tracks shared skill
  infrastructure). If the entropy scan flags the duplication in Task 10, treat
  it as a finding and do not raise `maxFindings`.

No blocking uncertainties.

## File Map

- CREATE `agents/skills/claude-code/canary-signal/scripts/sources.mjs`
- CREATE `agents/skills/claude-code/canary-signal/scripts/window.mjs`
- CREATE `agents/skills/claude-code/canary-signal/scripts/tally.mjs`
- CREATE `agents/skills/claude-code/canary-signal/scripts/digest.mjs`
- CREATE `agents/skills/claude-code/canary-signal/scripts/cli.mjs` (shebang,
  mode 755)
- CREATE `agents/skills/claude-code/canary-signal/SKILL.md`
- CREATE `agents/skills/test/canary-signal.test.ts`
- CREATE `docs/knowledge/gates/denominator-carrying-metric.md` (knowledge impact
  plus the docs-coverage link)
- MODIFY `docs/naming-registry.md` (`canary-signal` reserved → shipped; **must**
  land with Task 1, because `ts/test/bop-name-registry.test.ts` treats any
  existing directory as shipped)
- MODIFY `agents/skills/test/gate-conformance.test.ts` (abstention row)
- MODIFY `agents/skills/package.json` (`format:check` glob)
- MODIFY `agents/skills/vitest.config.ts` (coverage include)
- MODIFY `harness.config.json` (`entropy.entryPoints` and
  `performance.entryPoints`)
- MODIFY `agents/skills/README.md` (tree, bullet, Node-entry sentence)
- MODIFY `docs/roadmap.md` (`canary-signal` row → done, Spec, Plan)

## Skeleton

1. Read side: sources and window (~2 tasks, ~8 min)
2. Pure core: tally and digest (~2 tasks, ~12 min)
3. CLI and exit contract (~1 task, ~6 min)
4. Registrations: conformance row, globs, entryPoints (~2 tasks, ~6 min)
5. Docs: SKILL.md, README, knowledge, roadmap (~2 tasks, ~7 min)
6. Ratchets and four gates vs merge base (~1 task, ~6 min)

_Skeleton approved: pending. Relayed to the human by the orchestrator._

## Perf constraints (apply to every code task)

Each function must have cyclomatic complexity ≤10, nesting ≤4, and ≤50 lines,
and each file must stay under 300 lines. The code below is sized to fit. If you
change it, keep `main` a dispatcher. Precedent: screech's `writeArtifact` /
`strictExitFor` extraction.

Run all `npx vitest` / `npm` commands from `agents/skills/` unless stated
otherwise. Before every commit, run `npx prettier --write` on the files the task
touched. The snippets below show content, not final prettier formatting
(80-column, single quotes). A formatting diff at `format:check` in Task 7 means
an earlier task skipped this step.

## Tasks

### Task 1: sources.mjs: read the store and the ledger (plus registry flip)

**Depends on:** none | **Files:** `agents/skills/test/canary-signal.test.ts`,
`agents/skills/claude-code/canary-signal/scripts/sources.mjs`,
`docs/naming-registry.md` | **SC:** 6

1. Create `agents/skills/test/canary-signal.test.ts`:

   ```ts
   /**
    * canary-signal (#609) -- QA impact digest. Cases are tagged with the spec's
    * success criteria (SC1-SC9, docs/changes/609-canary-signal/proposal.md).
    * Fixtures are synthetic and de-identified; nothing here is copied from a
    * real store.
    */
   import fs from 'node:fs';
   import os from 'node:os';
   import path from 'node:path';
   import { fileURLToPath } from 'node:url';

   import { afterEach, describe, expect, it, vi } from 'vitest';

   import {
     DEFAULT_LEDGER,
     loadLedger,
     loadRuns,
   } from '../claude-code/canary-signal/scripts/sources.mjs';

   const SCRIPTS = path.join(
     path.dirname(fileURLToPath(import.meta.url)),
     '..',
     'claude-code',
     'canary-signal',
     'scripts',
   );
   const UNTIL = '2026-09-28T00:00:00.000Z';

   const tmps: string[] = [];
   function tmp(): string {
     const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-signal-'));
     tmps.push(dir);
     return dir;
   }
   afterEach(() => {
     vi.restoreAllMocks();
     while (tmps.length) {
       fs.rmSync(tmps.pop()!, { recursive: true, force: true });
     }
   });

   type Run = Record<string, unknown>;
   let seq = 0;
   /** A RunRecord (ts/src/history/record.ts) with in-window defaults. */
   function rec(over: Run = {}): Run {
     seq += 1;
     return {
       run_id: `r${seq}`,
       suite: 'unit',
       branch: 'main',
       timestamp: '2026-09-27T12:00:00Z',
       reporter_format: 'vitest',
       tests: [],
       ...over,
     };
   }
   const t = (test_name: string, status: string) => ({ test_name, status });

   function writeStore(dir: string, runs: Run[]): string {
     const file = path.join(dir, 'history-v2.jsonl');
     const body = runs.map((r) => JSON.stringify(r)).join('\n');
     fs.writeFileSync(file, body ? `${body}\n` : '', 'utf8');
     return file;
   }
   function writeLedger(dir: string, entries: unknown): string {
     const file = path.join(dir, 'quarantine.json');
     fs.writeFileSync(
       file,
       JSON.stringify({ schema_version: 2, entries }),
       'utf8',
     );
     return file;
   }
   function writeRaw(dir: string, name: string, body: string): string {
     const file = path.join(dir, name);
     fs.writeFileSync(file, body, 'utf8');
     return file;
   }

   describe('sources.loadRuns', () => {
     it('parses one record per non-blank line, any line ending', () => {
       const body = `${JSON.stringify(rec())}\n\n${JSON.stringify(rec())}\r\n`;
       expect(loadRuns(writeRaw(tmp(), 's.jsonl', body))).toHaveLength(2);
     });
     it('throws on a missing store -- a typo must look like a typo', () => {
       expect(() => loadRuns(path.join(tmp(), 'nope.jsonl'))).toThrow(
         /history store not found/,
       );
     });
     it('names the line of a malformed record', () => {
       const body = `${JSON.stringify(rec())}\n{oops\n`;
       expect(() => loadRuns(writeRaw(tmp(), 's.jsonl', body))).toThrow(
         /line 2/,
       );
     });
     it('rejects a line that parses but is not an object', () => {
       expect(() => loadRuns(writeRaw(tmp(), 's.jsonl', '[1]\n'))).toThrow(
         /line 1: not an object/,
       );
     });
   });

   describe('sources.loadLedger', () => {
     it('reads katana ledger entries', () => {
       const rows = [{ test: 'a', kind: 'skip' }];
       expect(loadLedger(writeLedger(tmp(), rows), true)).toEqual({
         state: 'read',
         rows,
         reason: null,
       });
     });
     it('SC6: the default path missing is a dark source, not an error', () => {
       const res = loadLedger(path.join(tmp(), DEFAULT_LEDGER), false);
       expect(res.state).toBe('dark');
       expect(res.reason).toContain('no quarantine ledger at');
     });
     it('SC6: an explicit --ledger that does not exist throws (D10)', () => {
       expect(() => loadLedger(path.join(tmp(), 'typo.json'), true)).toThrow(
         /quarantine ledger not found/,
       );
     });
     it('throws on malformed JSON', () => {
       const file = writeRaw(tmp(), 'q.json', '{nope');
       expect(() => loadLedger(file, true)).toThrow(
         /malformed quarantine ledger/,
       );
     });
     it('throws on a document that is not an object', () => {
       const file = writeRaw(tmp(), 'q.json', '[]');
       expect(() => loadLedger(file, true)).toThrow(/not an object/);
     });
     it('throws when entries is not an array', () => {
       const file = writeLedger(tmp(), { a: 1 });
       expect(() => loadLedger(file, true)).toThrow(/must be an array/);
     });
     it('treats a document without entries as an empty ledger', () => {
       const file = writeRaw(tmp(), 'q.json', '{"schema_version":2}');
       expect(loadLedger(file, true).rows).toEqual([]);
     });
   });
   ```

2. Run `npx vitest run test/canary-signal.test.ts` and confirm it fails because
   the module cannot be resolved.
3. Create `agents/skills/claude-code/canary-signal/scripts/sources.mjs`:

   ```js
   // sources -- the only module in canary-signal that reads the filesystem.
   //
   // Two persisted records of "what testing did": the run-history store
   // (history-v2.jsonl, one RunRecord per line -- ts/src/history/record.ts) and
   // the katana quarantine ledger ({schema_version, entries: [...]}).
   //
   // The two are NOT treated alike when absent, on purpose (spec D10). --history
   // is required, so a missing store is an error: returning [] would be
   // byte-identical to an empty store and print an abstention, a plausible wrong
   // answer to a typo. The ledger is optional: its DEFAULT path missing is a dark
   // source the digest names, but a path the caller typed that is missing is a
   // typo and must look like one.

   import fs from 'node:fs';

   /** Where canary-katana writes its ledger, relative to the working directory. */
   export const DEFAULT_LEDGER = '.canary/quarantine.json';

   const isPlainObject = (v) =>
     v !== null && typeof v === 'object' && !Array.isArray(v);

   function parseRecord(line, lineNo) {
     let record;
     try {
       record = JSON.parse(line);
     } catch (exc) {
       throw new Error(
         `malformed history record at line ${lineNo}: ${exc.message}`,
       );
     }
     if (!isPlainObject(record)) {
       throw new Error(
         `malformed history record at line ${lineNo}: not an object`,
       );
     }
     return record;
   }

   /**
    * @param {string} file path to history-v2.jsonl
    * @returns {object[]} one record per non-blank line, in file order
    */
   export function loadRuns(file) {
     if (!fs.existsSync(file)) {
       throw new Error(`history store not found: ${file}`);
     }
     const runs = [];
     fs.readFileSync(file, 'utf8')
       .split(/\r\n|\r|\n/)
       .forEach((raw, i) => {
         const line = raw.trim();
         if (line) runs.push(parseRecord(line, i + 1));
       });
     return runs;
   }

   function parseLedger(file) {
     let doc;
     try {
       doc = JSON.parse(fs.readFileSync(file, 'utf8'));
     } catch (exc) {
       throw new Error(`malformed quarantine ledger ${file}: ${exc.message}`);
     }
     if (!isPlainObject(doc)) {
       throw new Error(`malformed quarantine ledger ${file}: not an object`);
     }
     const rows = doc.entries ?? [];
     if (!Array.isArray(rows)) {
       throw new Error(`quarantine ledger entries must be an array: ${file}`);
     }
     return rows;
   }

   /**
    * @param {string} file ledger path
    * @param {boolean} explicit true when the caller passed --ledger
    * @returns {{state: 'read'|'dark', rows: object[], reason: string|null}}
    */
   export function loadLedger(file, explicit) {
     if (fs.existsSync(file)) {
       return { state: 'read', rows: parseLedger(file), reason: null };
     }
     if (explicit) throw new Error(`quarantine ledger not found: ${file}`);
     return {
       state: 'dark',
       rows: [],
       reason: `no quarantine ledger at ${file}`,
     };
   }
   ```

4. In `docs/naming-registry.md`, change the `canary-signal` row from
   `| reserved | 609 | QA impact digest |` to a `shipped` row whose description
   reads "QA impact digest (emit-only; every metric carries its denominator)".
   Then run `npx prettier --write docs/naming-registry.md` from the repo root.
   This must happen in this task: the directory now exists, and
   `bop-name-registry.test.ts` ("marks a shipped directory as shipped, not
   reserved") goes red without it.
5. Run `npx vitest run test/canary-signal.test.ts` and confirm it passes. Then
   run `cd ../../ts && npx vitest run test/bop-name-registry.test.ts` and
   confirm it passes.
6. Run `harness validate`.
7. Commit: `feat(signal): read run-history store and quarantine ledger (#609)`.

### Task 2: window.mjs: the digest window and undated accounting

**Depends on:** Task 1 | **Files:** `agents/skills/test/canary-signal.test.ts`,
`agents/skills/claude-code/canary-signal/scripts/window.mjs` | **SC:** 1, 2 (D6)

1. Add the import and cases to the test file:

   ```ts
   import {
     partitionByWindow,
     resolveWindow,
   } from '../claude-code/canary-signal/scripts/window.mjs';

   describe('window', () => {
     it('D6: spans --days ending at --until', () => {
       const w = resolveWindow(7, UNTIL).window!;
       expect(w.until.toISOString()).toBe(UNTIL);
       expect(w.since.toISOString()).toBe('2026-09-21T00:00:00.000Z');
     });
     it('defaults --until to now', () => {
       const before = Date.now();
       expect(
         resolveWindow(1, null).window!.until.getTime(),
       ).toBeGreaterThanOrEqual(before);
     });
     it('rejects an unparseable --until', () => {
       expect(resolveWindow(7, 'last tuesday').error).toMatch(/--until/);
     });
     it('rejects --days below 1', () => {
       expect(resolveWindow(0, UNTIL).error).toMatch(/--days/);
     });
     it('keeps inclusive bounds, drops outside rows, COUNTS undated ones', () => {
       const w = resolveWindow(7, UNTIL).window!;
       const items = [
         { d: '2026-09-21T00:00:00.000Z' },
         { d: UNTIL },
         { d: '2026-09-20T23:59:59Z' },
         { d: '2026-09-29T00:00:00Z' },
         { d: 'garbage' },
         {},
       ];
       const res = partitionByWindow(items, (i: { d?: string }) => i.d, w);
       expect(res.inside).toHaveLength(2);
       expect(res.undated).toBe(2);
     });
   });
   ```

2. Run `npx vitest run test/canary-signal.test.ts` and confirm the window cases
   fail.
3. Create `agents/skills/claude-code/canary-signal/scripts/window.mjs`:

   ```js
   // window -- which records a digest covers (spec D6).
   //
   // --until makes a digest reproducible: the same store and the same --until
   // always produce the same digest, which is what lets it be tested and
   // re-run for a past week. Records with no parseable date are COUNTED, never
   // silently dropped -- "N undated runs excluded" is the difference between a
   // thin week and a store that lost its timestamps.

   const DAY_MS = 86_400_000;

   /**
    * @param {number} days window length, >= 1
    * @param {string|null} until ISO-8601 end (inclusive); null = now
    * @returns {{window: {since: Date, until: Date}} | {error: string}}
    */
   export function resolveWindow(days, until) {
     if (!(days >= 1)) {
       return { error: `argument --days: must be >= 1, got ${days}` };
     }
     const end = until == null ? new Date() : new Date(until);
     if (Number.isNaN(end.getTime())) {
       return { error: `argument --until: not an ISO-8601 time: '${until}'` };
     }
     return {
       window: { since: new Date(end.getTime() - days * DAY_MS), until: end },
     };
   }

   /**
    * Split items into those dated inside [since, until] and a count of those
    * with no parseable date. Items dated outside the window are neither.
    */
   export function partitionByWindow(items, dateOf, window) {
     const lo = window.since.getTime();
     const hi = window.until.getTime();
     const inside = [];
     let undated = 0;
     for (const item of items) {
       const at = Date.parse(dateOf(item) ?? '');
       if (Number.isNaN(at)) undated += 1;
       else if (at >= lo && at <= hi) inside.push(item);
     }
     return { inside, undated };
   }
   ```

4. Run `npx vitest run test/canary-signal.test.ts` and confirm it passes.
5. Run `harness validate`.
6. Commit: `feat(signal): resolve the digest window and count undated records`.

### Task 3: tally.mjs: denominator-carrying metrics

**Depends on:** Task 2 | **Files:** `agents/skills/test/canary-signal.test.ts`,
`agents/skills/claude-code/canary-signal/scripts/tally.mjs` | **SC:** 1–7 (D4,
D5, D7, D8)

1. Add the import and cases:

   ```ts
   import {
     FLAKY_CAPABLE_FORMATS,
     PRODUCTION_ESCAPES_DARK,
     THIN_SAMPLE_RUNS,
     measured,
     tallyDigest,
   } from '../claude-code/canary-signal/scripts/tally.mjs';

   const WINDOW = resolveWindow(7, UNTIL).window!;
   const NO_LEDGER = {
     state: 'dark',
     rows: [],
     reason: 'no quarantine ledger at .canary/quarantine.json',
   };
   const tally = (runs: Run[], ledger: unknown = NO_LEDGER) =>
     tallyDigest({ runs, ledger, branch: 'main', window: WINDOW });

   describe('tally', () => {
     it('D4: a zero denominator abstains instead of measuring 0', () => {
       expect(measured(0, 0, 'why')).toEqual({
         abstained: true,
         reason: 'why',
       });
       expect(measured(0, 4, 'why')).toEqual({ value: 0, denominator: 4 });
     });
     it('SC2: zero runs in the window abstains the whole digest', () => {
       const old = rec({ timestamp: '2026-01-01T00:00:00Z' });
       expect(tally([old]).state).toBe('abstained');
     });
     it('SC3: 1-2 runs is a thin sample; 3 is not', () => {
       expect(THIN_SAMPLE_RUNS).toBe(3);
       expect(tally([rec(), rec()]).state).toBe('thin');
       expect(tally([rec(), rec(), rec()]).state).toBe('ok');
     });
     it('SC1: sample counts runs, suites and distinct UTC days', () => {
       const res = tally([
         rec({ suite: 'a', timestamp: '2026-09-26T01:00:00Z' }),
         rec({ suite: 'b', timestamp: '2026-09-26T02:00:00Z' }),
         rec({ suite: 'a', timestamp: '2026-09-27T01:00:00Z' }),
       ]);
       expect(res.sample).toEqual({ runs: 3, suites: 2, days: 2 });
     });
     it('counts undated runs instead of dropping them', () => {
       expect(tally([rec(), rec({ timestamp: undefined })]).undatedRuns).toBe(
         1,
       );
     });
     it('tests executed: tests.length, falling back to total', () => {
       const res = tally([
         rec({ tests: [t('a', 'passed'), t('b', 'failed')] }),
         rec({ tests: undefined, total: 5 }),
         rec({ tests: undefined }),
       ]);
       expect(res.tests).toEqual({ value: 7, denominator: 3 });
     });
     it('D7: failures split by branch, distinct by test name', () => {
       const res = tally([
         rec({ branch: 'feat/x', tests: [t('a', 'failed')] }),
         rec({
           branch: 'feat/y',
           tests: [t('a', 'failed'), t('b', 'failed'), t('c', 'passed')],
         }),
         rec({ tests: [t('d', 'failed'), t('e', 'flaky')] }),
       ]);
       expect(res.preMerge).toEqual({ value: 2, denominator: 2 });
       expect(res.reached).toEqual({ value: 1, denominator: 1 });
     });
     it('SC4: no non-default-branch runs => pre-merge abstains, never 0', () => {
       const res = tally([rec(), rec(), rec()]);
       expect(res.preMerge).toMatchObject({ abstained: true });
       expect(res.preMerge).not.toHaveProperty('value');
     });
     it('reached abstains when no run is on the default branch', () => {
       expect(tally([rec({ branch: 'feat/x' })]).reached).toMatchObject({
         abstained: true,
       });
     });
     it('counts runs with no branch in neither branch line', () => {
       const res = tally([
         rec({ branch: undefined }),
         rec(),
         rec({ branch: '' }),
       ]);
       expect(res.unbranched).toBe(2);
       expect(res.reached).toEqual({ value: 0, denominator: 1 });
     });
     it('SC5: no flaky-capable reporter => the flaky line abstains', () => {
       const res = tally([
         rec({ tests: [t('a', 'flaky')] }),
         rec({ reporter_format: undefined }),
       ]);
       expect(res.flaky).toMatchObject({ abstained: true });
     });
     it('D8: flaky counts only over flaky-capable runs', () => {
       expect(FLAKY_CAPABLE_FORMATS).toEqual(['playwright', 'junit']);
       const res = tally([
         rec({
           reporter_format: 'playwright',
           tests: [t('a', 'flaky'), t('a', 'flaky')],
         }),
         rec({ reporter_format: 'junit' }),
         rec({ tests: [t('z', 'flaky')] }),
       ]);
       expect(res.flaky).toEqual({ value: 1, denominator: 2 });
     });
     it('SC6: a dark ledger abstains and is named as a dark source', () => {
       const res = tally([rec()]);
       expect(res.quarantine).toMatchObject({ abstained: true });
       expect(res.dark).toContain(
         'quarantine ledger: no quarantine ledger at .canary/quarantine.json',
       );
     });
     it('an empty ledger is a dark source too', () => {
       const res = tally([rec()], { state: 'read', rows: [], reason: null });
       expect(res.dark).toContain(
         'quarantine ledger: the quarantine ledger holds no entries',
       );
     });
     it('quarantine trail: rows dated in window, by kind and cause', () => {
       const rows = [
         { kind: 'skip', cause: 'flaky', date: '2026-09-25T10:00:00-05:00' },
         { kind: 'constructor', cause: '', date: '2026-09-26T00:00:00Z' },
         { kind: 'skip', cause: 'flaky', date: '2026-01-01T00:00:00Z' },
         { kind: 'skip', date: '' },
       ];
       const res = tally([rec()], { state: 'read', rows, reason: null });
       expect(res.quarantine).toEqual({
         value: 2,
         denominator: 4,
         undated: 1,
         byKind: [
           ['constructor', 1],
           ['skip', 1],
         ],
         byCause: [
           ['flaky', 1],
           ['unrecorded', 1],
         ],
       });
       expect(
         res.dark.some((d: string) => d.startsWith('quarantine ledger')),
       ).toBe(false);
     });
     it('SC7: production escapes are always a dark source', () => {
       expect(tally([rec(), rec(), rec()]).dark).toContain(
         PRODUCTION_ESCAPES_DARK,
       );
       expect(tally([]).dark).toContain(PRODUCTION_ESCAPES_DARK);
     });
   });
   ```

2. Run `npx vitest run test/canary-signal.test.ts` and confirm the tally cases
   fail.
3. Create `agents/skills/claude-code/canary-signal/scripts/tally.mjs`:

   ```js
   // tally -- the digest's metrics, each carrying its own denominator (#609).
   //
   // Pure: windowed runs and a ledger in, numbers out. Every metric has exactly
   // one of two shapes, {value, denominator} or {abstained, reason}. There is no
   // third shape, so no renderer can print a bare 0 whose denominator collapsed
   // -- the "1 run, 0 escapes" digest that undersells QA (#508 D4, spec D4).

   import { partitionByWindow } from './window.mjs';

   /** Below this, one run is the whole story (spec D5). A constant, not a flag. */
   export const THIN_SAMPLE_RUNS = 3;

   /** Mirrors FLAKY_CAPABLE_FORMATS in ts/src/util/flake-window.ts (#604). */
   export const FLAKY_CAPABLE_FORMATS = ['playwright', 'junit'];

   export const PRODUCTION_ESCAPES_DARK =
     'production escapes: no canary store records them, so escapes avoided cannot be measured';

   export function measured(value, denominator, reason) {
     return denominator === 0
       ? { abstained: true, reason }
       : { value, denominator };
   }

   const testsOf = (run) => (Array.isArray(run.tests) ? run.tests : []);

   function distinctWithStatus(runs, status) {
     const names = new Set();
     for (const run of runs) {
       for (const test of testsOf(run)) {
         if (test.status === status) names.add(test.test_name);
       }
     }
     return names.size;
   }

   function sampleOf(runs) {
     const dayOf = (r) => new Date(r.timestamp).toISOString().slice(0, 10);
     return {
       runs: runs.length,
       suites: new Set(runs.map((r) => r.suite)).size,
       days: new Set(runs.map(dayOf)).size,
     };
   }

   function executedCount(run) {
     return Array.isArray(run.tests)
       ? run.tests.length
       : Number(run.total ?? 0);
   }

   // D7: "caught before <branch>" is a factual proxy (failures seen on other
   // branches), never a claim that a bug was prevented. A run with no branch is
   // provably neither, so it is counted in neither and surfaced as a note.
   function branchMetrics(runs, branch) {
     const other = runs.filter((r) => Boolean(r.branch) && r.branch !== branch);
     const onBranch = runs.filter((r) => r.branch === branch);
     return {
       preMerge: measured(
         distinctWithStatus(other, 'failed'),
         other.length,
         `no runs on branches other than ${branch} in the window`,
       ),
       reached: measured(
         distinctWithStatus(onBranch, 'failed'),
         onBranch.length,
         `no runs on ${branch} in the window`,
       ),
       unbranched: runs.length - other.length - onBranch.length,
     };
   }

   // D8: a vitest run cannot emit `flaky`, so its zero is structural, not
   // measured. Only flaky-capable runs are in the denominator.
   function flakySurfaced(runs) {
     const capable = runs.filter((r) =>
       FLAKY_CAPABLE_FORMATS.includes(r.reporter_format),
     );
     return measured(
       distinctWithStatus(capable, 'flaky'),
       capable.length,
       `no run in the window came from a reporter that can emit flaky (${FLAKY_CAPABLE_FORMATS.join(', ')})`,
     );
   }

   /** A Map, not an object: a ledger `kind` of "constructor" must count as 1. */
   function countBy(rows, field) {
     const counts = new Map();
     for (const row of rows) {
       const key = String(row[field] || 'unrecorded');
       counts.set(key, (counts.get(key) ?? 0) + 1);
     }
     return [...counts].sort(([a], [b]) => a.localeCompare(b));
   }

   function quarantineTrail(ledger, window) {
     if (ledger.state === 'dark') {
       return { abstained: true, reason: ledger.reason };
     }
     if (ledger.rows.length === 0) {
       return {
         abstained: true,
         reason: 'the quarantine ledger holds no entries',
       };
     }
     const { inside, undated } = partitionByWindow(
       ledger.rows,
       (r) => r.date,
       window,
     );
     return {
       value: inside.length,
       denominator: ledger.rows.length,
       undated,
       byKind: countBy(inside, 'kind'),
       byCause: countBy(inside, 'cause'),
     };
   }

   function darkSources(quarantine) {
     const ledger = quarantine.abstained
       ? [`quarantine ledger: ${quarantine.reason}`]
       : [];
     return [...ledger, PRODUCTION_ESCAPES_DARK];
   }

   function stateFor(runCount) {
     if (runCount === 0) return 'abstained';
     return runCount < THIN_SAMPLE_RUNS ? 'thin' : 'ok';
   }

   /**
    * @param {{runs: object[], ledger: {state: string, rows: object[], reason: string|null},
    *          branch: string, window: {since: Date, until: Date}}} input
    */
   export function tallyDigest({ runs, ledger, branch, window }) {
     const { inside, undated } = partitionByWindow(
       runs,
       (r) => r.timestamp,
       window,
     );
     const quarantine = quarantineTrail(ledger, window);
     const executed = inside.reduce((n, r) => n + executedCount(r), 0);
     return {
       state: stateFor(inside.length),
       branch,
       window,
       sample: sampleOf(inside),
       undatedRuns: undated,
       tests: measured(executed, inside.length, 'no runs in the window'),
       ...branchMetrics(inside, branch),
       flaky: flakySurfaced(inside),
       quarantine,
       dark: darkSources(quarantine),
     };
   }
   ```

4. Run `npx vitest run test/canary-signal.test.ts` and confirm it passes.
5. Run `harness validate`.
6. Commit: `feat(signal): tally denominator-carrying digest metrics`.

### Task 4: digest.mjs: render markdown and the chat block

**Depends on:** Task 3 | **Files:** `agents/skills/test/canary-signal.test.ts`,
`agents/skills/claude-code/canary-signal/scripts/digest.mjs` | **SC:** 1–7 (D7)

1. Add the import and cases:

   ````ts
   import {
     CHAT_MAX_LINES,
     renderDigest,
   } from '../claude-code/canary-signal/scripts/digest.mjs';

   const digest = (runs: Run[], ledger?: unknown) =>
     renderDigest(tally(runs, ledger));

   describe('digest', () => {
     it('SC1: sample line, per-metric denominators, fenced chat block', () => {
       const { markdown, chatBlock } = digest([
         rec({ branch: 'feat/x', tests: [t('a', 'failed')] }),
         rec(),
         rec({ reporter_format: 'playwright' }),
       ]);
       expect(markdown).toContain(
         '**Sample:** 3 runs across 1 suite on 1 day, 2026-09-21T00:00:00.000Z → 2026-09-28T00:00:00.000Z',
       );
       expect(markdown).toContain('## What testing caught');
       expect(markdown).toContain('- Tests executed: 1 across 3 runs');
       expect(markdown).toContain(
         '- Failures caught on branches other than main: 1 distinct failing test across 1 run',
       );
       expect(markdown).toContain(
         '- Flaky tests surfaced: 0 distinct tests across 1 flaky-capable run',
       );
       expect(markdown).toContain('```text\n' + chatBlock + '\n```');
     });
     it('SC1: chat block is <= 8 plain lines led by the sample line', () => {
       const cases: Run[][] = [[], [rec()], [rec(), rec(), rec()]];
       expect(CHAT_MAX_LINES).toBe(8);
       for (const runs of cases) {
         const lines = digest(runs).chatBlock.split('\n');
         expect(lines.length).toBeLessThanOrEqual(CHAT_MAX_LINES);
         expect(lines[0]).toMatch(/^canary-signal digest — \d+ runs? across/);
         expect(lines.join('\n')).not.toMatch(/\*\*|^#|^- /m);
       }
     });
     it('SC2: zero runs prints ABSTAINED and never the success copy', () => {
       const { markdown } = digest([]);
       expect(markdown).toContain('ABSTAINED: no runs recorded in the window');
       expect(markdown).not.toContain('What testing caught');
     });
     it('SC3: 1-2 runs prints a THIN SAMPLE banner stating the count', () => {
       expect(digest([rec(), rec()]).markdown).toContain(
         '**THIN SAMPLE:** 2 runs in the window',
       );
       expect(digest([rec()]).chatBlock).toContain('THIN SAMPLE');
       expect(digest([rec(), rec(), rec()]).markdown).not.toContain(
         'THIN SAMPLE',
       );
     });
     it('SC4/SC5: abstaining metrics print ABSTAINED and the reason', () => {
       const { markdown } = digest([rec(), rec(), rec()]);
       expect(markdown).toContain(
         '- Failures caught on branches other than main: ABSTAINED — no runs on branches other than main in the window',
       );
       expect(markdown).toMatch(
         /- Flaky tests surfaced: ABSTAINED — no run in the window came from a reporter that can emit flaky/,
       );
     });
     it('SC6/SC7: Dark sources names the missing ledger and escapes', () => {
       const dark = digest([rec()]).markdown.split('## Dark sources')[1];
       expect(dark).toContain('quarantine ledger: no quarantine ledger at');
       expect(dark).toContain('production escapes:');
     });
     it('D7: never claims a bug was prevented', () => {
       const runs = [rec({ branch: 'feat/x', tests: [t('a', 'failed')] })];
       expect(digest(runs).markdown).not.toMatch(/prevent/i);
     });
     it('renders the quarantine trail and the undated/unbranched notes', () => {
       const rows = [
         { kind: 'skip', cause: 'flaky', date: '2026-09-25T00:00:00Z' },
         { kind: 'skip', date: '' },
       ];
       const { markdown } = digest(
         [rec(), rec({ branch: undefined }), rec({ timestamp: 'nope' })],
         { state: 'read', rows, reason: null },
       );
       expect(markdown).toContain(
         '- Quarantine trail: 1 ledger row dated in the window of 2 (kind: skip 1; cause: flaky 1); 1 undated excluded',
       );
       expect(markdown).toContain(
         '- 1 undated run excluded (no parseable timestamp).',
       );
       expect(markdown).toContain(
         '- 1 run with no branch counted in neither branch line.',
       );
     });
     it('an in-window-empty ledger prints kind/cause as none', () => {
       const rows = [{ kind: 'skip', date: '2026-01-01T00:00:00Z' }];
       expect(
         digest([rec()], { state: 'read', rows, reason: null }).markdown,
       ).toContain(
         '0 ledger rows dated in the window of 1 (kind: none; cause: none)',
       );
     });
   });
   ````

2. Run `npx vitest run test/canary-signal.test.ts` and confirm the digest cases
   fail.
3. Create `agents/skills/claude-code/canary-signal/scripts/digest.mjs`:

   ````js
   // digest -- render a tally as markdown plus a chat-ready block (#609).
   //
   // Pure. Every number is printed beside the count it was measured over; a
   // metric whose count was zero prints ABSTAINED and why, never 0. The copy
   // says what was observed ("failures caught on branches other than main"),
   // never what we would like to be true ("bugs prevented") -- a failing test
   // may be a test bug, not a product bug (spec D7).
   //
   // The chat block always leads with the sample line: it is the one line a
   // reader of a forwarded message must not lose.

   import { THIN_SAMPLE_RUNS } from './tally.mjs';

   export const ABSTAINED_LINE =
     'ABSTAINED: no runs recorded in the window — this digest measured nothing, which is not the same as a quiet week.';

   /** Pinned by test; chat clients fold anything longer. */
   export const CHAT_MAX_LINES = 8;

   const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
   const day = (d) => d.toISOString().slice(0, 10);

   export function sampleLine(t) {
     const { runs, suites, days } = t.sample;
     const span = `${t.window.since.toISOString()} → ${t.window.until.toISOString()}`;
     return `${plural(runs, 'run')} across ${plural(suites, 'suite')} on ${plural(days, 'day')}, ${span}`;
   }

   function metricLine(label, m, describe) {
     const body = m.abstained ? `ABSTAINED — ${m.reason}` : describe(m);
     return `- ${label}: ${body}`;
   }

   const failures = (m) =>
     `${plural(m.value, 'distinct failing test')} across ${plural(m.denominator, 'run')}`;

   const pairs = (entries) =>
     entries.map(([k, n]) => `${k} ${n}`).join(', ') || 'none';

   function quarantineText(m) {
     const undated = m.undated > 0 ? `; ${m.undated} undated excluded` : '';
     return `${plural(m.value, 'ledger row')} dated in the window of ${m.denominator} (kind: ${pairs(m.byKind)}; cause: ${pairs(m.byCause)})${undated}`;
   }

   function caughtLines(t) {
     return [
       metricLine(
         'Tests executed',
         t.tests,
         (m) => `${m.value} across ${plural(m.denominator, 'run')}`,
       ),
       metricLine(
         `Failures caught on branches other than ${t.branch}`,
         t.preMerge,
         failures,
       ),
       metricLine(`Failures that reached ${t.branch}`, t.reached, failures),
       metricLine(
         'Flaky tests surfaced',
         t.flaky,
         (m) =>
           `${plural(m.value, 'distinct test')} across ${plural(m.denominator, 'flaky-capable run')}`,
       ),
       metricLine('Quarantine trail', t.quarantine, quarantineText),
     ];
   }

   function sampleNotes(t) {
     const notes = [];
     if (t.undatedRuns > 0) {
       notes.push(
         `- ${plural(t.undatedRuns, 'undated run')} excluded (no parseable timestamp).`,
       );
     }
     if (t.unbranched > 0) {
       notes.push(
         `- ${plural(t.unbranched, 'run')} with no branch counted in neither branch line.`,
       );
     }
     return notes;
   }

   function bodyLines(t) {
     if (t.state === 'abstained') return [`**${ABSTAINED_LINE}**`];
     const banner =
       t.state === 'thin'
         ? [
             `> **THIN SAMPLE:** ${plural(t.sample.runs, 'run')} in the window. Below ${THIN_SAMPLE_RUNS} runs, one run is the whole story — read every number below as anecdote, not trend.`,
             '',
           ]
         : [];
     return [...banner, '## What testing caught', '', ...caughtLines(t)];
   }

   function chatLines(t) {
     const head = `canary-signal digest — ${sampleLine(t)}`;
     if (t.state === 'abstained') return [head, ABSTAINED_LINE];
     const thin =
       t.state === 'thin' ? ['THIN SAMPLE — anecdote, not trend.'] : [];
     const body = caughtLines(t).map((line) => line.slice(2));
     return [
       head,
       ...thin,
       ...body,
       `Dark sources: ${t.dark.length} (see the digest)`,
     ];
   }

   /** @returns {{markdown: string, chatBlock: string}} */
   export function renderDigest(t) {
     const chatBlock = chatLines(t).join('\n');
     const markdown = [
       `# QA signal: ${day(t.window.since)} → ${day(t.window.until)}`,
       '',
       `**Sample:** ${sampleLine(t)}`,
       ...sampleNotes(t),
       '',
       ...bodyLines(t),
       '',
       '## Dark sources',
       '',
       ...t.dark.map((d) => `- ${d}`),
       '',
       '## Chat-ready',
       '',
       '```text',
       chatBlock,
       '```',
       '',
     ].join('\n');
     return { markdown, chatBlock };
   }
   ````

4. Run `npx vitest run test/canary-signal.test.ts` and confirm it passes.
5. Run `harness validate`.
6. Commit: `feat(signal): render the digest and chat-ready block`.

### Task 5: cli.mjs: parsing, orchestration, exit contract

**Depends on:** Task 4 | **Files:** `agents/skills/test/canary-signal.test.ts`,
`agents/skills/claude-code/canary-signal/scripts/cli.mjs` | **SC:** 1, 2, 6, 8,
9 (D9, D10)

1. Add the import and cases:

   ````ts
   import {
     CLI_SPEC,
     main,
   } from '../claude-code/canary-signal/scripts/cli.mjs';

   function runCli(argv: string[]) {
     const out: string[] = [];
     const err: string[] = [];
     vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
       out.push(a.join(' '));
     });
     vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
       err.push(a.join(' '));
     });
     const code = main(argv);
     return { code, stdout: out.join('\n'), stderr: err.join('\n') };
   }
   function inDir<T>(dir: string, fn: () => T): T {
     const cwd = process.cwd();
     process.chdir(dir);
     try {
       return fn();
     } finally {
       process.chdir(cwd);
     }
   }
   const three = () => [rec({ branch: 'feat/x' }), rec(), rec()];

   describe('cli', () => {
     it('SC1: three runs => a full digest, exit 0', () => {
       const dir = tmp();
       const ledger = writeLedger(dir, [
         { kind: 'skip', cause: 'flaky', date: '2026-09-25T00:00:00Z' },
       ]);
       const argv = ['--history', writeStore(dir, three()), '--ledger', ledger];
       const res = runCli([...argv, '--until', UNTIL]);
       expect(res.code).toBe(0);
       expect(res.stdout).toContain('**Sample:** 3 runs');
       expect(res.stdout).toContain('```text');
     });
     it('SC2: an empty store abstains; exit 0 advisory, 3 under --strict', () => {
       const store = writeStore(tmp(), []);
       const advisory = runCli(['--history', store]);
       expect(advisory.code).toBe(0);
       expect(advisory.stdout).toContain('ABSTAINED');
       vi.restoreAllMocks();
       expect(runCli(['--history', store, '--strict']).code).toBe(3);
     });
     it('D9: --strict exits 0 on thin and full samples', () => {
       const dir = tmp();
       const base = ['--until', UNTIL, '--strict'];
       expect(
         runCli(['--history', writeStore(dir, three()), ...base]).code,
       ).toBe(0);
       vi.restoreAllMocks();
       const thin = writeStore(tmp(), [rec()]);
       expect(runCli(['--history', thin, ...base]).code).toBe(0);
     });
     it('SC6: an explicit missing --ledger exits 1', () => {
       const dir = tmp();
       const res = runCli([
         '--history',
         writeStore(dir, three()),
         '--ledger',
         path.join(dir, 'typo.json'),
       ]);
       expect(res.code).toBe(1);
       expect(res.stderr).toContain(
         'canary-signal: quarantine ledger not found',
       );
     });
     it('SC6: the default ledger missing is a named dark source', () => {
       const dir = tmp();
       const store = writeStore(dir, three());
       const res = inDir(dir, () =>
         runCli(['--history', store, '--until', UNTIL]),
       );
       expect(res.code).toBe(0);
       expect(res.stdout).toContain(
         `quarantine ledger: no quarantine ledger at ${DEFAULT_LEDGER}`,
       );
     });
     it('a missing --history store exits 1, never "nothing caught"', () => {
       const res = runCli(['--history', path.join(tmp(), 'nope.jsonl')]);
       expect(res.code).toBe(1);
       expect(res.stderr).toContain('canary-signal: history store not found');
     });
     it('--days 0 and a bad --until are usage errors (exit 2)', () => {
       const store = writeStore(tmp(), []);
       const days = runCli(['--history', store, '--days', '0']);
       expect(days.code).toBe(2);
       expect(days.stderr).toContain('canary-signal: error: argument --days');
       vi.restoreAllMocks();
       expect(runCli(['--history', store, '--until', 'soon']).code).toBe(2);
     });
     it('--out writes the markdown, creating parent directories', () => {
       const dir = tmp();
       const out = path.join(dir, 'nested', 'signal.md');
       const argv = ['--history', writeStore(dir, three()), '--until', UNTIL];
       const res = runCli([...argv, '--out', out]);
       expect(res.code).toBe(0);
       expect(fs.readFileSync(out, 'utf8')).toBe(res.stdout);
     });
     it('an unwritable --out exits 1', () => {
       const dir = tmp();
       const blocker = writeRaw(dir, 'file', 'x');
       const res = runCli([
         '--history',
         writeStore(dir, three()),
         '--out',
         path.join(blocker, 'signal.md'),
       ]);
       expect(res.code).toBe(1);
       expect(res.stderr).toContain('cannot write artifact');
     });
     it('SC8: no network or process modules, and only cli.mjs writes', () => {
       const allowed =
         /^(node:fs|node:path|\.\.\/\.\.\/\.\.\/lib\/parse-args\.mjs|\.\/[a-z]+\.mjs)$/;
       const writers: string[] = [];
       for (const name of fs.readdirSync(SCRIPTS)) {
         const src = fs.readFileSync(path.join(SCRIPTS, name), 'utf8');
         for (const [, spec] of src.matchAll(/from '([^']+)'/g)) {
           expect(spec, `${name} imports ${spec}`).toMatch(allowed);
         }
         expect(src).not.toMatch(
           /\bfetch\(|child_process|node:https?|node:net/,
         );
         if (/writeFileSync|appendFileSync|createWriteStream/.test(src)) {
           writers.push(name);
         }
       }
       expect(writers).toEqual(['cli.mjs']);
     });
     it('SC8: without --out, nothing on disk changes', () => {
       const storeDir = tmp();
       const store = writeStore(storeDir, three());
       const cwd = tmp();
       inDir(cwd, () => runCli(['--history', store]));
       expect(fs.readdirSync(cwd)).toEqual([]);
       expect(fs.readdirSync(storeDir)).toEqual(['history-v2.jsonl']);
     });
     it('SC9: --help exits 0, an unknown flag exits 2', () => {
       const help = runCli(['--help']);
       expect(help.code).toBe(0);
       expect(help.stdout).toContain('usage: canary-signal');
       vi.restoreAllMocks();
       expect(runCli(['--history', 'x', '--bogus']).code).toBe(2);
     });
     it('exports CLI_SPEC and ships an executable entry', () => {
       expect(CLI_SPEC.prog).toBe('canary-signal');
       expect(CLI_SPEC.required).toEqual(['--history']);
       const entry = path.join(SCRIPTS, 'cli.mjs');
       expect(
         fs.readFileSync(entry, 'utf8').startsWith('#!/usr/bin/env node\n'),
       ).toBe(true);
       expect(fs.statSync(entry).mode & 0o111).not.toBe(0);
     });
   });
   ````

2. Run `npx vitest run test/canary-signal.test.ts` and confirm the cli cases
   fail.
3. Create `agents/skills/claude-code/canary-signal/scripts/cli.mjs`, then run
   `chmod 755 agents/skills/claude-code/canary-signal/scripts/cli.mjs` from the
   repo root:

   ```js
   #!/usr/bin/env node
   // canary-signal -- QA impact digest (#609).
   //
   // Reads what canary already persists -- the run-history store and the katana
   // quarantine ledger -- and emits a digest of what testing caught in a window,
   // so the work of testing is legible to people who do not open the code
   // (STRATEGY.md, "Quality made legible").
   //
   // It emits. It does not post: no Slack, no Teams, no webhook, no network.
   // Output is markdown on stdout (with a chat-ready block inside it) and, with
   // --out, the same markdown on disk -- the same contract as canary-screech.
   //
   // Advisory by default (#508 D3): exit 0. Under --strict: 3 = abstained (zero
   // runs in the window), 0 otherwise. There is no exit 1 "red" state -- a
   // digest has nothing to fail on. Read errors exit 1, usage errors 2.
   //
   // Invoked via `canary skills run canary-signal -- --history <jsonl> [...]`.

   import fs from 'node:fs';
   import path from 'node:path';

   import {
     createParser,
     formatUsageError,
     EXIT_USAGE,
   } from '../../../lib/parse-args.mjs';
   import { DEFAULT_LEDGER, loadLedger, loadRuns } from './sources.mjs';
   import { resolveWindow } from './window.mjs';
   import { tallyDigest } from './tally.mjs';
   import { renderDigest } from './digest.mjs';

   const PREFIX = 'canary-signal:';

   /** Exit code reserved family-wide for "abstained" (#508 D4). */
   const EXIT_ABSTAINED = 3;

   const USAGE =
     'usage: canary-signal [-h] --history PATH [--ledger PATH] [--branch NAME]\n' +
     '                     [--days N] [--until ISO] [--out PATH] [--strict]\n' +
     '\n' +
     'QA impact digest: what testing caught, every number beside its denominator.';

   // `--ledger` has no default ON PURPOSE: null is how main knows the caller did
   // not name one, which separates a dark source from a typo (spec D10).
   export const CLI_SPEC = {
     prog: 'canary-signal',
     booleans: { '--strict': 'strict' },
     values: {
       '--history': { key: 'history' },
       '--ledger': { key: 'ledger' },
       '--branch': { key: 'branch' },
       '--days': { key: 'days', type: 'int' },
       '--until': { key: 'until' },
       '--out': { key: 'out' },
     },
     defaults: { branch: 'main', days: 7 },
     required: ['--history'],
   };

   const parseArgs = createParser(CLI_SPEC);

   /** @returns {string|null} null on success */
   function writeArtifact(out, markdown) {
     try {
       fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
       fs.writeFileSync(out, markdown, 'utf8');
       return null;
     } catch (exc) {
       return `cannot write artifact: ${exc.message}`;
     }
   }

   function loadSources(args) {
     try {
       return {
         runs: loadRuns(args.history),
         ledger: loadLedger(
           args.ledger ?? DEFAULT_LEDGER,
           args.ledger !== null,
         ),
       };
     } catch (exc) {
       return { error: exc.message };
     }
   }

   function usageError(message) {
     console.error(formatUsageError(CLI_SPEC.prog, message));
     return EXIT_USAGE;
   }

   function emit(args, tally) {
     const { markdown } = renderDigest(tally);
     console.log(markdown);
     const failure = args.out ? writeArtifact(args.out, markdown) : null;
     if (failure) {
       console.error(`${PREFIX} ${failure}`);
       return 1;
     }
     return args.strict && tally.state === 'abstained' ? EXIT_ABSTAINED : 0;
   }

   export function main(argv = []) {
     const { opts: args, help, error } = parseArgs(argv);
     if (help) {
       console.log(USAGE);
       return 0;
     }
     if (error) return usageError(error);
     const resolved = resolveWindow(args.days, args.until);
     if (resolved.error) return usageError(resolved.error);
     const sources = loadSources(args);
     if (sources.error) {
       console.error(`${PREFIX} ${sources.error}`);
       return 1;
     }
     const tally = tallyDigest({
       runs: sources.runs,
       ledger: sources.ledger,
       branch: args.branch,
       window: resolved.window,
     });
     return emit(args, tally);
   }

   // `process.exitCode`, not `process.exit()`: a large payload exceeds the pipe
   // buffer and `process.exit` truncates it while still exiting 0 (#791).
   if (import.meta.url === `file://${process.argv[1]}`) {
     process.exitCode = main(process.argv.slice(2));
   }
   ```

4. Run `npx vitest run test/canary-signal.test.ts` and confirm it passes. Then
   run `npx vitest run test/skill-cli-conformance.test.ts`. That suite will not
   discover `canary-signal` until SKILL.md lands in Task 8, where it is re-run.
5. Run `harness validate`.
6. Commit: `feat(signal): CLI with emit-only digest and --strict exit contract`.

### Task 6: Register the abstention row in gate conformance

**Depends on:** Task 5 | **Files:**
`agents/skills/test/gate-conformance.test.ts` | **SC:** 2 (#508 D5)

1. Add the import beside the other skill imports:
   `import { main as signalMain } from '../claude-code/canary-signal/scripts/cli.mjs';`
2. Append this row to `ROWS`, after the `canary-sweep` row:

   ```ts
     {
       // An empty store: zero runs in the window. The tempting read is "a
       // quiet week, nothing caught" -- which undersells QA. In fact the
       // digest measured nothing at all (#609).
       command: 'canary-signal (zero runs in the digest window)',
       forbid: ['What testing caught'],
       run: (base) => run(signalMain, ['--history', emptyStore(base)]),
       strict: (base) =>
         run(signalMain, ['--history', emptyStore(base), '--strict']),
     },
   ```

3. Run `npx vitest run test/gate-conformance.test.ts` and confirm both new cases
   pass. Task 5 already implemented the contract; if either case is red, the
   abstention copy or the exit contract drifted, so fix `cli.mjs` or
   `digest.mjs` and do not loosen the row.
4. Run `harness validate`.
5. Commit: `test(signal): register canary-signal in skill gate conformance`.

### Task 7: Config registrations: format glob, coverage include, entryPoints

**Depends on:** Task 5 | **Files:** `agents/skills/package.json`,
`agents/skills/vitest.config.ts`, `harness.config.json`

1. `agents/skills/package.json`: in `format:check`, insert the
   `claude-code/canary-signal/scripts/**/*.mjs` glob immediately after the
   `claude-code/canary-screech/scripts/**/*.mjs` glob.
2. `agents/skills/vitest.config.ts`: in `coverage.include`, add
   `'claude-code/canary-signal/scripts/**/*.mjs',` after the `canary-screech`
   line.
3. `harness.config.json`: in **both** `entryPoints` arrays (entropy, about line
   193, and performance, about line 328), insert
   `"agents/skills/claude-code/canary-signal/scripts/cli.mjs",` between the
   `canary-shadow` and `canary-strix` lines. Never raise `maxFindings`.
4. Verify: `grep -c 'canary-signal/scripts/cli.mjs' harness.config.json` prints
   `2`.
5. Run `npm run format:check` (the signal glob must match 5 files; if prettier
   reports "No files matching", the glob is wrong) and `npm test`. The coverage
   run now includes signal and must meet the 90/90/85/90 floor.
6. Run `harness validate`.
7. Commit:
   `chore(signal): register canary-signal in format, coverage, entropy and perf`.

### Task 8: SKILL.md and the skills README

**Depends on:** Task 5 | **Files:**
`agents/skills/claude-code/canary-signal/SKILL.md`, `agents/skills/README.md` |
**Category:** integration | **SC:** 9

1. Run `npx vitest run test/skill-cli-conformance.test.ts` and record the
   discovered-row count N. canary-signal is not yet among them.
2. Create `agents/skills/claude-code/canary-signal/SKILL.md`:

   ````markdown
   ---
   name: canary-signal
   description:
     QA impact digest. Reads the run-history store and the katana quarantine
     ledger and emits a markdown digest plus a chat-ready block of what testing
     caught in a window -- failures caught on branches other than main, failures
     that reached main, flaky tests surfaced, and the quarantine trail. Every
     number is printed beside its denominator; a metric whose denominator is
     zero abstains, a window with no runs abstains, and a window with one or two
     runs carries a THIN SAMPLE banner. Emits only, never posts.
   cli: scripts/cli.mjs
   requires: [node>=20]
   ---

   # Canary Signal

   A digest reading "1 run, 0 escapes" says "QA did nothing this week". That
   undersells the work and inverts the point of a digest. `canary-signal` states
   its sample before it states anything else, and it declines to print a number
   it did not measure.

   ## What this is not

   - **Not a broadcaster.** No Slack, Teams, webhook, PR comment, credentials or
     network. It writes markdown to stdout and, with `--out`, to one file. Pipe
     the chat block wherever you like.
   - **Not a scheduler.** The digest is a pure function of its inputs; a cron
     workflow can call it (below).
   - **Not a claim that bugs were prevented.** A failure on a feature branch is
     reported as exactly that. A failing test can be a test bug.

   ## Invocation

   ```bash
   # Last 7 days to now, default ledger (.canary/quarantine.json):
   canary skills run canary-signal -- \
     --history test-results/reports/history-v2.jsonl

   # A reproducible past week, written to disk:
   canary skills run canary-signal -- \
     --history test-results/reports/history-v2.jsonl \
     --until 2026-09-28T00:00:00Z --days 7 --out reports/signal.md
   ```

   | Flag        | Default                   | Meaning                                                  |
   | ----------- | ------------------------- | -------------------------------------------------------- |
   | `--history` | required                  | run-history JSONL store; missing = exit 1                |
   | `--ledger`  | `.canary/quarantine.json` | katana ledger; default missing = dark, explicit = exit 1 |
   | `--branch`  | `main`                    | the default branch                                       |
   | `--days`    | `7`                       | window length                                            |
   | `--until`   | now                       | window end, ISO-8601                                     |
   | `--out`     | —                         | also write the markdown here                             |
   | `--strict`  | off                       | exit 3 when the digest abstained                         |

   ## What it measures

   | Line                         | Denominator (abstains at 0)                            |
   | ---------------------------- | ------------------------------------------------------ |
   | Tests executed               | runs in the window                                     |
   | Failures caught off `main`   | runs on other branches                                 |
   | Failures that reached `main` | runs on `main`                                         |
   | Flaky tests surfaced         | runs from a flaky-capable reporter (playwright, junit) |
   | Quarantine trail             | ledger present and non-empty                           |
   | Production escapes           | never measured -- always a dark source                 |

   Runs with no parseable timestamp, and runs with no branch, are counted and
   named, never silently dropped.

   ## Honest degradation

   - **0 runs in the window**: `ABSTAINED`. No "What testing caught" section.
   - **1–2 runs**: a `THIN SAMPLE` banner stating the count.
   - **Dark sources**: every source that could not be read is named with the
     reason. Production escapes are always listed, because no canary store
     records them.

   ## Exit codes

   `0` advisory (always, without `--strict`) · `1` a source could not be read or
   `--out` could not be written · `2` usage · `3` abstained, under `--strict`
   only.

   ## Scheduling it

   ```yaml
   on:
     schedule: [{ cron: '0 13 * * 1' }]
   jobs:
     signal:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v5
         - run:
             npx canary skills run canary-signal -- --history
             test-results/reports/history-v2.jsonl --out signal.md
   ```
   ````

3. `agents/skills/README.md`:
   - Tree: insert `│   ├── canary-signal/` after `│   ├── canary-ship/`.
   - After the `canary-screech` bullet, add:

     ```markdown
     - [`canary-signal`](./claude-code/canary-signal/SKILL.md) — Bundled
       executable skill (`scripts/cli.mjs`). QA impact digest: reads the
       run-history store and the katana quarantine ledger and emits a markdown
       digest plus a chat-ready block of what testing caught in a window. Every
       number carries its denominator; an empty window abstains and a one- or
       two-run window carries a THIN SAMPLE banner. Emits only, never posts.
     ```

   - In the "ship a Node entry" sentence, insert `canary-signal`, between
     `canary-shadow`, and `canary-strix`.

4. Run
   `npx prettier --write agents/skills/claude-code/canary-signal/SKILL.md agents/skills/README.md`
   from the repo root.
5. Run `npx vitest run test/skill-cli-conformance.test.ts` from `agents/skills/`
   and confirm the discovered count is N+1 and all cases pass. Then run the
   `ts/` suites `skill-surfaces`, `skill-cli-executable` and `doc-links`
   (`npx vitest run test/<name>.test.ts` from `ts/`).
6. Run `harness validate`.
7. Commit: `docs(signal): SKILL.md and skills README entry`.

### Task 9: Knowledge doc and roadmap row

**Depends on:** Task 8 | **Files:**
`docs/knowledge/gates/denominator-carrying-metric.md`, `docs/roadmap.md` |
**Category:** integration

1. Create `docs/knowledge/gates/denominator-carrying-metric.md`. It carries the
   spec's knowledge impact and the docs-coverage markdown links (harness counts
   only `[..](path)` links; a backtick path does nothing):

   ```markdown
   ---
   type: business_rule
   domain: gates
   source: authored
   related:
     - docs/knowledge/decisions/0009-exit-3-reserved-for-abstained.md
     - docs/changes/609-canary-signal/proposal.md
   ---

   # Denominator-carrying metrics

   A reported number travels with the count it was measured over. When that
   count is zero, the metric **abstains** — it prints `ABSTAINED` and why, never
   `0`.

   ## Why

   "0 failures caught" over zero pre-merge runs reads as a quiet week. It is
   actually an instrument that saw nothing. Printed in a digest meant to make QA
   visible, that zero undersells the work and inverts the goal (#609). It is the
   same false-green shape as "0 tests failed" out of zero tests (#508).

   ## The rule

   - A metric has exactly two shapes: `{value, denominator}` or
     `{abstained, reason}`. There is no bare number.
   - A structural zero is not a measured zero. A reporter that cannot emit
     `flaky` does not contribute to the flaky denominator (#604).
   - A source that could not be read is named as dark, with the reason, rather
     than contributing nothing silently. A source that does not exist at all
     (production escapes) is named too.
   - A thin sample is stated before any number is (`THIN SAMPLE`, below 3 runs).

   ## Where it is implemented

   - [`tally.mjs`](../../../agents/skills/claude-code/canary-signal/scripts/tally.mjs)
     — `measured()` and every metric.
   - [`digest.mjs`](../../../agents/skills/claude-code/canary-signal/scripts/digest.mjs)
     — renders abstentions and the dark-sources section.
   - [`window.mjs`](../../../agents/skills/claude-code/canary-signal/scripts/window.mjs)
     — counts undated records instead of dropping them.
   - [`sources.mjs`](../../../agents/skills/claude-code/canary-signal/scripts/sources.mjs)
     — separates a dark optional source from a mistyped path.
   ```

2. Edit the `docs/roadmap.md` `### canary-signal — QA impact digest` block:
   - `- **Status:** backlog` → `- **Status:** done`
   - `- **Spec:** —` → `- **Spec:** docs/changes/609-canary-signal/proposal.md`
   - `- **Plan:** —` →
     `- **Plan:** docs/changes/609-canary-signal/plans/2026-09-28-canary-signal-plan.md`
   - Leave the heading, Summary, Priority and External-ID untouched. Do not move
     the row to the archive, because a row-count change reds the AGENTS.md
     tests. Never run `harness roadmap sync --apply`.
3. Run
   `npx prettier --write docs/knowledge/gates/denominator-carrying-metric.md docs/roadmap.md`.
4. Run
   `cd ts && npx vitest run test/bop-name-registry.test.ts test/doc-links.test.ts`,
   then `node scripts/check_doc_links.mjs` from the repo root. All links must
   resolve.
5. Run `harness check-docs --json --min-coverage 0` and confirm that the four
   signal scripts appear in `documented`.
6. Run `harness validate`.
7. Commit:
   `docs(signal): denominator-carrying metric knowledge and roadmap done (#609)`.

### Task 10: Ratchets and four gates against the merge base

[checkpoint:human-verify]

**Depends on:** Tasks 6, 7, 9 | **Files:** none (verification only; any fix goes
back to the owning task's files)

Measure in a **fresh worktree** of the merge base. A mid-conflict or main
working tree gives meaningless numbers. For every ratchet, exit 3 means it
abstained, which is **not** a pass.

1. Skills gates, from `agents/skills/`:
   `npm test && npm run typecheck && npm run format:check`. Read the coverage
   table: the `canary-signal/scripts` rows must be present, and the global floor
   must hold.
2. Engine gates, from `ts/`:
   `npm run build && npm run typecheck && npm run format:check && npm test`
   (this suite includes bop-name-registry, doc-links, skill-surfaces and the
   AGENTS.md/roadmap tests).
3. From the repo root: `harness validate && harness check-deps`. Confirm the
   module count is non-zero.
4. Set up the merge-base worktree and CLI version:

   ```bash
   S=/private/tmp/claude-501/<session>/scratchpad   # any scratch dir
   BASE=$(git merge-base HEAD origin/main)
   git worktree add --detach "$S/signal-base" "$BASE"
   V=$(harness --version)
   ```

5. Entropy ratchet:

   ```bash
   harness cleanup --findings-json > "$S/entropy-head.txt" || true
   (cd "$S/signal-base" && harness cleanup --findings-json) > "$S/entropy-base.txt" || true
   node scripts/entropy-ratchet.mjs --report "$S/entropy-head.txt" --cli-version "$V" --base-report "$S/entropy-base.txt"
   ```

6. Perf ratchet. Every new function must have complexity ≤10, nesting ≤4 and ≤50
   lines, and every file must be under 300 lines:

   ```bash
   harness check-perf > "$S/perf-head.txt" 2>&1 || true
   (cd "$S/signal-base" && harness check-perf) > "$S/perf-base.txt" 2>&1 || true
   node scripts/perf-ratchet.mjs --report "$S/perf-head.txt" --cli-version "$V" \
     --report-root "$PWD" --base-report-root "$S/signal-base" --base-report "$S/perf-base.txt"
   ```

7. Docs ratchet:

   ```bash
   harness check-docs --json --min-coverage 0 > "$S/docs-head.json" || true
   (cd "$S/signal-base" && harness check-docs --json --min-coverage 0) > "$S/docs-base.json" || true
   node scripts/docs-ratchet.mjs --report "$S/docs-head.json" --base-report "$S/docs-base.json"
   ```

8. Arch: run `harness check-arch` and compare against the merge base's
   `baselines.json`. Read `rulesRun`, not just `passed`.
9. Clean up: `git worktree remove "$S/signal-base"`.
10. Self-review the full diff (`git diff origin/main...HEAD`) as a reviewer. Ask
    what docs this change makes wrong, and what behavior nothing tests.
11. Pause: show the human the gate and ratchet outputs with their denominators.
    Fix any red in the owning task's files; never raise a baseline or
    `maxFindings`.

## Traceability

| Truth / SC | Tasks (tests)                          |
| ---------- | -------------------------------------- |
| SC1        | 2, 3, 4, 5                             |
| SC2        | 3, 4, 5, 6 (gate-conformance row)      |
| SC3        | 3, 4                                   |
| SC4        | 3, 4                                   |
| SC5        | 3, 4                                   |
| SC6        | 1, 3, 4, 5                             |
| SC7        | 3, 4                                   |
| SC8        | 5                                      |
| SC9        | 5, 8 (skill-cli-conformance discovery) |
| 10 (gates) | 7, 10                                  |

## Integration tasks (from the spec's Integration Points)

- Entry point / registrations: Tasks 6, 7.
- Documentation updates: Tasks 1 (naming registry), 8 (README), 9 (docs link,
  roadmap).
- Architectural decisions: none (the spec says no ADR is warranted).
- Knowledge impact: Task 9
  (`docs/knowledge/gates/denominator-carrying-metric.md`).
