# Plan: Contract validator tightenings (#1154, phase 1)

**Date:** 2026-10-07 | **Spec:**
`docs/changes/1154-contract-validator-follow-ups/proposal.md` | **Tasks:** 7 |
**Time:** ~30 min | **Integration Tier:** small | **Rigor:** standard

## Goal

The zero-dependency contract validator in `agents/skills/lib/contracts/` stops
accepting the five things the #1153 review found (impossible dates,
non-repo-relative files, blank strings, a BOM-prefixed file) and reports a site
feed's `checked` count as every record it validated. The schemas, document shape
and exit codes do not change.

## Observable Truths (Acceptance Criteria)

1. **(S2, spec criterion 1)** When a timestamp names an impossible calendar date
   (`2026-02-30`, `2025-02-29`, `1900-02-29`, `2026-04-31`, month `00`, day
   `00`) or clock (`T24:00:00`, minute `:60`, second `:60`, offset `+24:00`,
   offset `+05:60`), the system shall refuse it at that field's path with
   `"<value>" matches the timestamp pattern but is not a real date`.
   `2024-02-29`, `2000-02-29` and `0000-02-29` are accepted.
2. **(S2)** If a timestamp string does not match the schema pattern, then
   `real-dates` shall not report it as well: the schema's `pattern` error is the
   only one.
3. **(S3, criterion 2)** When a `file` escapes the repo root (`../x`,
   `a/../../x`, `..\x`, `./../x`), is home-relative (`~/x`, `~`, `~bob/x`) or
   starts with `\`, the system shall refuse it at that file's path with
   `escapes the repository root (ADR 0029)`,
   `is home-relative (~), not repo-relative (ADR 0029)` or
   `is absolute (\), not repo-relative (ADR 0029)`. This applies in a run
   (`results[]`, `collected[]`) and in a site feed (`runs[i]`, `flaky[]`,
   `register[]`). `a/../b.spec.ts`, `..foo/x.spec.ts`, `./x.spec.ts` and
   `a/b~/c.spec.ts` are accepted.
4. **(S3)** If a `file` starts with `/` or a drive letter, then `repo-relative`
   shall not report it as well. The schema `pattern` error is the only one.
5. **(S4, criterion 3)** When a string field with `minLength >= 1` is
   whitespace-only (`title: "  "`, `scope.env: " \t"`), the system shall refuse
   it with `must not be blank`. `""` keeps its existing
   `must be at least 1 character(s)` message. A nullable field that is `null` is
   still accepted.
6. **(S7, criterion 4)** When the input starts with one U+FEFF, `validateText`
   validates the document as if there were no BOM. The CLI does the same for a
   file and for stdin, both in-process and as a real child process. A second
   leading BOM, or a BOM alone, is still refused with `checked: 0`.
7. **(S8, criterion 5)** A site feed's `checked` is
   `1 + runs + assessments + flaky + register`. The valid fixture reports `6`,
   and the CLI prints `valid canary.site/1: 6 records checked, 0 errors`.
   `scopes[]` and `suites[]` are not counted.
8. **(criterion 6)** The three `*.v1.schema.json` files are byte-identical to
   `origin/main`.
9. The three contract specs document `real-dates` (field ranges),
   `repo-relative`, `non-blank`, the BOM rule and the new `checked` formula.
10. `npm test`, `npm run typecheck` and `npm run format:check` in
    `agents/skills` pass. `harness validate` and `harness check-deps` pass.
    `harness check-perf` reports zero findings under
    `agents/skills/lib/contracts/`. `rules.mjs` stays at or under 300 lines.

## Uncertainties

- **[ASSUMPTION]** No producer in the tree emits a `file` that is `..`-escaping,
  `~`-rooted or `\`-rooted, and no producer emits a whitespace-only string.
  Checked by a dry run (see Evidence): `canary-starling.test.ts` and
  `site-kit-model.test.ts` pass against the new validator. If lane #1200's
  concurrent starling edits add one, Task 7's full suite catches it. That is a
  producer bug to file, and the validator should not be loosened for it.
- **[ASSUMPTION]** The perf `file-length` threshold is 300 lines, and the
  cyclomatic warning is 10. `harness check-perf` on this tree reports
  `File has N lines (threshold: 300)` and `warning threshold: 10`. The drafted
  `rules.mjs` is 295 lines, so there are only 5 lines of headroom. If execution
  pushes it past 300, stop and escalate. Do not trim unrelated code in the same
  PR, and do not raise any ceiling.
- **[ASSUMPTION]** A blank `reason` on a `not-assessed` assessment now yields
  **two** errors at `reason`: the schema's `must not be blank` and
  `status-shape`'s `is required when status is not-assessed (D4)`. Both
  statements are true, and the spec does not say to dedupe. Task 4 pins this so
  it is a recorded behavior, not an accident.
- **[ASSUMPTION]** D1's day check uses `setUTCFullYear` instead of the spec's
  `new Date(Date.UTC(y, m, 0))`, because `Date.UTC` maps years 0–99 to 1900–1999
  and would refuse `0000-02-29`, a real proleptic-Gregorian leap day. The intent
  is the same, and a test pins it.
- **[DEFERRABLE]** `.trim()` treats U+FEFF and NBSP as whitespace, so a field
  holding only a NBSP is blank. That matches "whitespace-only" and needs no
  decision now.
- **[DEFERRABLE]** A first segment that starts with `~` is refused even when it
  is a literal file name (`~tmp.spec.ts` at the repo root). D2 says "`~user`",
  and git repos almost never contain such names. Revisit only if a producer
  reports it.

## Evidence

- `agents/skills/lib/contracts/document.mjs:75-79`: `countRecords` returns
  `1 + len('runs') + len('assessments')`.
- `agents/skills/lib/contracts/document.mjs:122`: `JSON.parse(text)` with no BOM
  handling. In Node 22.23.2, `JSON.parse('﻿{}')` throws `Unexpected token`.
- `agents/skills/lib/contracts/rules.mjs:178-194`: `realDates` judges with
  `Date.parse`. In Node 22.23.2, `Date.parse` returns a finite number for
  `2026-02-30`, `2025-02-29`, `1900-02-29`, `2026-04-31` and `T24:00:00Z`, so
  those pass today.
- `agents/skills/lib/contracts/rules.mjs:208,221-229`: `REGISTER_RULES` and
  `crossFieldErrors`. `flaky[]` rows get no rules today.
- `agents/skills/lib/contracts/schema-check.mjs:113-116`: `checkMinLength`
  counts whitespace.
- `agents/skills/lib/contracts/run.v1.schema.json:102-106`: `repoPath` pattern
  `^(?!/|[A-Za-z]:[\\/])` with `minLength: 1`. `site.v1.schema.json:64,86`:
  `flaky.file` and `registerEntry.file` `$ref` it.
- `agents/skills/test/contracts-validate.test.ts:57`:
  `expect(validateDocument(valid('site')).checked).toBe(1 + 2 + 1)`.
- **Dry run.** Every snippet below was applied to a scratch copy of
  `agents/skills` (outside the repo). `npx vitest run test/contracts-*.test.ts`
  gave 199/199 passed. Against the **unmodified** lib, the same tests gave 28
  failed and 171 passed, and the 28 are exactly the new red tests named in each
  task. `npm run typecheck` and `npm run format:check` were clean. In the full
  suite, `canary-starling` and `site-kit-model` passed. 21 failures in
  `canary-cassandra`, `canary-test-reporter-voice` and `canary-barda-render`
  were artifacts of the scratch location: they resolve repo-root paths and a
  symlinked `node_modules`. Task 7 re-runs the full suite in the real worktree.

## File Map

- MODIFY `agents/skills/lib/contracts/document.mjs` (S8 `countRecords`, S7
  `stripBom`)
- MODIFY `agents/skills/lib/contracts/rules.mjs` (S2 `isRealInstant`, S3
  `repoRelative` / `fileRepoRelative`, `FLAKY_RULES`)
- MODIFY `agents/skills/lib/contracts/schema-check.mjs` (S4 `minLengthProblem`)
- MODIFY `agents/skills/test/contracts-validate.test.ts` (S8, S7, S4, S3)
- MODIFY `agents/skills/test/contracts-validate-cli.test.ts` (S8, S7)
- MODIFY `agents/skills/test/contracts-rules.test.ts` (S2, S3)
- MODIFY `agents/skills/test/contracts-schema-check.test.ts` (S4)
- MODIFY `docs/specs/canary-run-contract.md`
- MODIFY `docs/specs/canary-site-feed-contract.md`
- MODIFY `docs/specs/canary-assessment-contract.md`

No file is created under `lib/`, so `entropy.entryPoints` does not change. No
`*.schema.json` or fixture is modified.

## Skeleton

_Not produced: there are 7 tasks, below the standard-rigor threshold of 8._

## Changes to the validator (delta)

- [MODIFIED] `real-dates`: range-checks the timestamp's own fields instead of
  trusting `Date.parse`. A pattern-failing string is no longer double-reported.
- [ADDED] `repo-relative` on `results[].file`, `collected[].file`,
  `flaky[].file` and `register[].file`.
- [MODIFIED] `minLength >= 1` also refuses a whitespace-only string
  (`non-blank`).
- [MODIFIED] `validateText` strips one leading U+FEFF.
- [MODIFIED] Site `checked` adds `flaky` and `register` lengths.

## Tasks

All commands run from `/Users/bs/Github/canary-1154/agents/skills` unless they
say otherwise. Target test command: `npx vitest run test/contracts-*.test.ts`.
Each task ends with `npx prettier --write` on the files it touched (TS and JS
are single-quote, 80 col), then `harness validate` from the repo root, then the
commit. Commit messages use `Refs #1154`. Never put a closing keyword next to
`#1154`.

### Task 1: S8. Count flaky and register rows in a site feed's `checked`

**Depends on:** none | **Files:**
`agents/skills/test/contracts-validate.test.ts`,
`agents/skills/test/contracts-validate-cli.test.ts`,
`agents/skills/lib/contracts/document.mjs`

1. In `test/contracts-validate.test.ts`, replace the body of
   `it('reports its denominator: a site feed counts its nested records', ...)`
   and add a sibling test right after it:

   ```ts
   it('reports its denominator: a site feed counts its nested records', () => {
     expect(validateDocument(valid('run')).checked).toBe(1);
     // feed + 2 runs + 1 assessment + 1 flaky row + 1 register row (#1154 S8)
     expect(validateDocument(valid('site')).checked).toBe(1 + 2 + 1 + 1 + 1);
   });

   it('counts flaky[] and register[] rows, not scopes[] or suites[] (#1154 S8)', () => {
     const doc = valid('site');
     doc.flaky.push({ ...doc.flaky[0], title: 'second flaky' });
     doc.register.push({ ...doc.register[0], title: 'second row' });
     doc.scopes.push({ id: 'other', env: 'ci' });
     doc.suites.push({ ...doc.suites[0], suite: 'other' });
     expect(validateDocument(doc).checked).toBe(1 + 2 + 1 + 2 + 2);
   });
   ```

2. In `test/contracts-validate-cli.test.ts`, add after the `RUN` constant:

   ```ts
   const SITE = path.join(HERE, 'fixtures', 'contracts', 'site.valid.json');
   ```

   Then, inside `describe('validate.mjs CLI (in-process)')`, after
   `'exits 0 on a valid file and reports its denominator'`, add:

   ```ts
   it("counts a site feed's flaky and register rows (#1154 S8)", () => {
     expect(call([SITE]).stdout).toBe(
       'valid canary.site/1: 6 records checked, 0 errors',
     );
   });
   ```

3. Run `npx vitest run test/contracts-*.test.ts`. **Expect 3 failures:**
   `reports its denominator` (expected 6, received 4),
   `counts flaky[] and register[] rows` (expected 8, received 4), and the CLI
   test (`4 records` instead of `6 records`).
4. In `lib/contracts/document.mjs`, replace `countRecords` and its comment:

   ```js
   /**
    * A site feed's nested arrays whose rows are validated records (#1154 S8).
    * `scopes[]` and `suites[]` are keys records refer to, so they are not counted.
    */
   const SITE_RECORD_KEYS = ['runs', 'assessments', 'flaky', 'register'];

   /** The denominator: documents plus the records nested in a site feed. */
   function countRecords(layer, doc) {
     if (layer !== 'site') return 1;
     const len = (key) => (Array.isArray(doc[key]) ? doc[key].length : 0);
     return SITE_RECORD_KEYS.reduce((n, key) => n + len(key), 1);
   }
   ```

5. Run `npx vitest run test/contracts-*.test.ts` and confirm all pass.
6. Run

   ```bash
   npx prettier --write lib/contracts/document.mjs test/contracts-validate.test.ts test/contracts-validate-cli.test.ts
   ```

7. Run `harness validate` (repo root).
8. Commit:

   ```text
   fix(contracts): count flaky and register rows in a site feed's checked (Refs #1154)
   ```

### Task 2: S7. Strip one leading UTF-8 BOM in `validateText`

**Depends on:** Task 1 | **Files:**
`agents/skills/test/contracts-validate.test.ts`,
`agents/skills/test/contracts-validate-cli.test.ts`,
`agents/skills/lib/contracts/document.mjs`

1. Append to `test/contracts-validate.test.ts`:

   ```ts
   describe('#1154 S7: one leading UTF-8 byte-order mark is stripped', () => {
     const BOM = '﻿';

     it('validates a BOM-prefixed document as if there were no BOM', () => {
       const res = validateText(BOM + JSON.stringify(valid('run')));
       expect(res.errors).toEqual([]);
       expect(res).toMatchObject({ valid: true, checked: 1 });
     });

     it('still refuses a BOM followed by unparseable text (control)', () => {
       expect(validateText(BOM + '{').errors).toEqual([
         { path: '$', message: expect.stringMatching(/^not parseable JSON/) },
       ]);
     });

     it('strips only one: a second BOM is still a parse error', () => {
       const res = validateText(BOM + BOM + JSON.stringify(valid('run')));
       expect(res).toMatchObject({ valid: false, checked: 0 });
     });

     it('a BOM alone is empty input, so refused (criterion 18)', () => {
       expect(validateText(BOM)).toMatchObject({ valid: false, checked: 0 });
     });
   });
   ```

2. In `test/contracts-validate-cli.test.ts`, add the imports
   `import fs from 'node:fs';` and `import os from 'node:os';` after the
   `node:child_process` import. In the in-process describe, after the Task 1
   test, add:

   ```ts
   it('strips a leading BOM from a file and from stdin (#1154 S7)', () => {
     const text = '﻿' + fs.readFileSync(RUN, 'utf8');
     const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-bom-'));
     const file = path.join(dir, 'run.bom.json');
     fs.writeFileSync(file, text, 'utf8');
     try {
       expect(call([file]).code).toBe(0);
       expect(call(['-'], text).code).toBe(0);
     } finally {
       fs.rmSync(dir, { recursive: true, force: true });
     }
   });
   ```

   At the end of `describe('validate.mjs CLI (real process)')`, add:

   ```ts
   it('exits 0 on BOM-prefixed stdin (#1154 S7, end to end)', () => {
     const text = '﻿' + fs.readFileSync(RUN, 'utf8');
     expect(run(['-'], text).status).toBe(0);
   });
   ```

3. Run the target tests. **Expect 3 failures:**
   `validates a BOM-prefixed document` (errors are
   `not parseable JSON: Unexpected token`), the in-process CLI BOM test (code
   1), and the real-process BOM test (status 1). The other three S7 tests are
   controls and already pass.
4. In `lib/contracts/document.mjs`, add after `const schemaId = ...`:

   ```js
   /** One leading U+FEFF is an encoding marker, not JSON (#1154 S7). */
   const stripBom = (text) => (text.startsWith('﻿') ? text.slice(1) : text);
   ```

   In `validateText`, change `doc = JSON.parse(text);` to
   `doc = JSON.parse(stripBom(text));`. Keep the `﻿` escape in source. Never
   write a literal BOM character.

5. Run the target tests and confirm all pass.
6. Run prettier on the three files, then `harness validate`.
7. Commit:
   `fix(contracts): strip a leading UTF-8 BOM before parsing (Refs #1154)`.

### Task 3: S2. `real-dates` checks the calendar and clock, not `Date.parse`

**Depends on:** none | **Files:** `agents/skills/test/contracts-rules.test.ts`,
`agents/skills/lib/contracts/rules.mjs`

1. In `test/contracts-rules.test.ts`, inside
   `describe('real-dates (#1151 phase 3 review)')`, insert before
   `it('leaves a non-string timestamp to the schema', ...)`:

   ```ts
   it.each([
     '2026-02-30T00:00:00Z',
     '2025-02-29T00:00:00Z',
     '1900-02-29T00:00:00Z',
     '2026-04-31T00:00:00Z',
     '2026-00-10T00:00:00Z',
     '2026-10-00T00:00:00Z',
     '2026-10-06T24:00:00Z',
     '2026-10-06T23:60:00Z',
     '2026-10-06T23:59:60Z',
     '2026-10-06T10:00:00+24:00',
     '2026-10-06T10:00:00+05:60',
   ])('refuses %s: no such calendar date or clock (#1154 S2)', (ts) => {
     expect(crossFieldErrors('run', run(ts))).toEqual([
       {
         path: 'run.finished_at',
         message: `${JSON.stringify(ts)} matches the timestamp pattern but is not a real date`,
       },
     ]);
   });

   it.each([
     '2024-02-29T00:00:00Z',
     '2000-02-29T00:00:00Z',
     '0000-02-29T00:00:00Z',
     '2026-12-31T23:59:59.999-23:59',
   ])('accepts %s: a real instant, leap days included (control)', (ts) => {
     expect(crossFieldErrors('run', run(ts))).toEqual([]);
   });

   it('leaves a string the pattern refuses to the schema: one error, not two', () => {
     expect(crossFieldErrors('run', run('yesterday'))).toEqual([]);
   });
   ```

2. Run the target tests. **Expect 6 failures:** `2026-02-30`, `2025-02-29`,
   `1900-02-29`, `2026-04-31` and `T24:00:00Z`, because `Date.parse` accepts
   them, and `yesterday`, because it is reported today. The other six refusals
   already fail `Date.parse`, so they pass as regression guards, and the four
   accepts are controls.
3. In `lib/contracts/rules.mjs`, insert directly above the `real-dates` doc
   comment:

   ```js
   const TIMESTAMP_RE =
     /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;
   /** Hour, minute, second, offset hour, offset minute. A leap second is refused. */
   const CLOCK_MAX = [23, 59, 59, 23, 59];

   /** setUTCFullYear, not Date.UTC: Date.UTC reads years 0-99 as 1900-1999. */
   const daysInMonth = (year, month) =>
     new Date(new Date(0).setUTCFullYear(year, month, 0)).getUTCDate();

   const isRealDay = (y, mo, d) =>
     mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);

   /**
    * Range-checks the timestamp's own fields; `Date.parse` rolls 02-30 over to
    * 03-02 (#1154 S2). A string the pattern refuses is the schema's error.
    */
   function isRealInstant(value) {
     const m = TIMESTAMP_RE.exec(value);
     if (m === null) return true;
     const [y, mo, d, ...clock] = m.slice(1).map((g) => Number(g ?? 0));
     return isRealDay(y, mo, d) && clock.every((v, i) => v <= CLOCK_MAX[i]);
   }
   ```

   `TIMESTAMP_RE` mirrors `run.v1.schema.json#/$defs/timestamp`. It must match
   exactly the strings the schema pattern admits, and nothing else.

4. Replace the `real-dates` doc comment with:

   ```js
   /**
    * Rule `real-dates`: a timestamp names an instant. The pattern admits month 13
    * or February 30, which a reader sorts or dates wrongly (#1151 phase 3 review,
    * #1154 S2). Only strings are checked; a non-string is the schema's error.
    */
   ```

   In the `realDates` body, replace the two-line guard

   ```text
   if (typeof value !== 'string' || Number.isFinite(Date.parse(value))) return [];
   ```

   with:

   ```js
   if (typeof value !== 'string' || isRealInstant(value)) return [];
   ```

   The signature, paths and message do not change.

5. Run the target tests and confirm all pass. Also run
   `npx vitest run test/site-kit-*.test.ts test/canary-starling.test.ts`: the
   site kit has its own `undated` handling and must stay green.
6. Run
   `npx prettier --write lib/contracts/rules.mjs test/contracts-rules.test.ts`,
   then `harness validate`.
7. Commit:

   ```text
   fix(contracts): real-dates checks calendar and clock ranges, not Date.parse (Refs #1154)
   ```

### Task 4: S4. `minLength >= 1` refuses a whitespace-only string (`non-blank`)

**Depends on:** Task 2 | **Files:**
`agents/skills/test/contracts-schema-check.test.ts`,
`agents/skills/test/contracts-validate.test.ts`,
`agents/skills/lib/contracts/schema-check.mjs`

1. In `test/contracts-schema-check.test.ts`, inside
   `describe('checkValue — keywords')`, insert before the `$ref resolves` test:

   ```ts
   it('minLength >= 1 refuses a whitespace-only string as blank (#1154 S4)', () => {
     const blank = [{ path: '$', message: 'must not be blank' }];
     expect(check({ minLength: 1 }, '  ')).toEqual(blank);
     expect(check({ minLength: 1 }, '\t\n')).toEqual(blank);
     expect(check({ minLength: 1 }, '')).toEqual([
       { path: '$', message: 'must be at least 1 character(s)' },
     ]);
     expect(check({ minLength: 1 }, ' x ')).toEqual([]);
     expect(check({ minLength: 0 }, '  ')).toEqual([]);
     expect(check({ type: ['string', 'null'], minLength: 1 }, null)).toEqual(
       [],
     );
   });
   ```

2. Append to `test/contracts-validate.test.ts`:

   ```ts
   describe('#1154 S4: rule non-blank', () => {
     it('refuses a whitespace-only title, naming results[0].title', () => {
       const doc = valid('run');
       doc.results[0].title = '  ';
       expect(validateDocument(doc).errors).toEqual([
         { path: 'results[0].title', message: 'must not be blank' },
       ]);
     });

     it('refuses a blank env nested in a site feed, naming runs[0].scope.env', () => {
       const doc = valid('site');
       doc.runs[0].scope.env = ' \t';
       expect(refusedPaths(doc)).toEqual(['runs[0].scope.env']);
     });

     it('a blank not-assessed reason is refused by both the schema and status-shape', () => {
       const errors = validateDocument({
         ...valid('assessment'),
         status: 'not-assessed',
         value: null,
         reason: '   ',
       }).errors;
       expect(errors).toEqual([
         { path: 'reason', message: 'must not be blank' },
         { path: 'reason', message: expect.stringMatching(/is required/) },
       ]);
     });

     it('accepts null in a nullable non-empty field (control)', () => {
       expect(
         validateDocument({ ...valid('assessment'), unit: null }).errors,
       ).toEqual([]);
     });
   });
   ```

3. Run the target tests. **Expect 4 failures:** the schema-check test (`'  '`
   returns `[]`), `whitespace-only title` (no errors), `blank env` (the document
   is valid, so `refusedPaths` fails `valid === false`), and
   `blank not-assessed reason` (only the status-shape error). The `null` control
   passes.
4. In `lib/contracts/schema-check.mjs`, replace `checkMinLength` with:

   ```js
   /**
    * Rule `non-blank` (#1154 S4): unlike stock JSON Schema, a minimum of 1 or
    * more also refuses a whitespace-only string, so `"  "` is not "non-empty".
    */
   function minLengthProblem(min, value) {
     if ([...value].length < min) return `must be at least ${min} character(s)`;
     return min >= 1 && value.trim() === '' ? 'must not be blank' : null;
   }

   function checkMinLength(min, value, path, ctx) {
     if (typeof value !== 'string') return;
     const problem = minLengthProblem(min, value);
     if (problem) report(ctx, path, problem);
   }
   ```

   This is split into two functions so that `checkMinLength` gains no cyclomatic
   complexity (perf ratchet). `CHECKS.minLength` still points at
   `checkMinLength`, and `SUPPORTED_KEYWORDS` does not change.

5. Run the target tests and confirm all pass. The existing
   `criterion 16: refuses a blank env` test (`env = ''`) must still report only
   `scope.env`.
6. Run prettier on the three files, then `harness validate`.
7. Commit:

   ```text
   fix(contracts): minLength refuses whitespace-only strings as blank (Refs #1154)
   ```

### Task 5: S3. New rule `repo-relative` on every `file`

**Depends on:** Task 3, Task 4 | **Files:**
`agents/skills/test/contracts-rules.test.ts`,
`agents/skills/test/contracts-validate.test.ts`,
`agents/skills/lib/contracts/rules.mjs`

1. Append to `test/contracts-rules.test.ts`:

   ```ts
   describe('repo-relative (#1154 S3, ADR 0029)', () => {
     const ESCAPES = 'escapes the repository root (ADR 0029)';
     const HOME = 'is home-relative (~), not repo-relative (ADR 0029)';
     const ROOTED = 'is absolute (\\), not repo-relative (ADR 0029)';
     const runWith = (file: unknown) => ({
       totals: totals(),
       results: [{ file, duration_ms: 1, retries: 0 }],
       collected: [{ title: 't', file }],
     });

     it.each([
       ['../x.spec.ts', ESCAPES],
       ['a/../../x.spec.ts', ESCAPES],
       ['..\\x.spec.ts', ESCAPES],
       ['./../x.spec.ts', ESCAPES],
       ['~/x.spec.ts', HOME],
       ['~', HOME],
       ['~bob/x.spec.ts', HOME],
       ['\\x.spec.ts', ROOTED],
       ['\\\\server\\share\\x.spec.ts', ROOTED],
     ])('refuses %j in results[] and collected[]', (file, message) => {
       expect(crossFieldErrors('run', runWith(file))).toEqual([
         { path: 'results[0].file', message },
         { path: 'collected[0].file', message },
       ]);
     });

     it.each([
       'a/../b.spec.ts',
       '..foo/x.spec.ts',
       './x.spec.ts',
       'a/b~/c.spec.ts',
       'tests/x.spec.ts',
     ])('accepts %j (control)', (file) => {
       expect(crossFieldErrors('run', runWith(file))).toEqual([]);
     });

     it('leaves a non-string file, a null row and a non-array list to the schema', () => {
       const run = {
         totals: totals({ passed: 2, total: 2 }),
         results: [{ file: 7, duration_ms: 1, retries: 0 }, null],
         collected: 'x',
       };
       expect(crossFieldErrors('run', run)).toEqual([]);
     });

     it('checks runs[], flaky[] and register[] in a site feed, with paths', () => {
       const errs = crossFieldErrors('site', {
         runs: [{ ...runWith('../x.spec.ts'), collected: null }],
         flaky: [{ file: '~/x.spec.ts' }],
         register: [{ file: '\\x.spec.ts' }],
       });
       expect(paths(errs)).toEqual([
         'runs[0].results[0].file',
         'flaky[0].file',
         'register[0].file',
       ]);
     });
   });
   ```

2. Append to `test/contracts-validate.test.ts`:

   ```ts
   describe('#1154 S3: rule repo-relative (ADR 0029)', () => {
     it('refuses a run file that escapes the repo root, naming results[0].file', () => {
       const doc = valid('run');
       doc.results[0].file = '../outside.spec.ts';
       expect(validateDocument(doc).errors).toEqual([
         {
           path: 'results[0].file',
           message: 'escapes the repository root (ADR 0029)',
         },
       ]);
     });

     it('refuses home-relative and backslash-rooted files in flaky[] and register[]', () => {
       const doc = valid('site');
       doc.flaky[0].file = '~/x.spec.ts';
       doc.register[0].file = '\\x.spec.ts';
       expect(refusedPaths(doc)).toEqual(['flaky[0].file', 'register[0].file']);
     });

     it("a leading / stays the schema pattern's one error, not two", () => {
       const doc = valid('run');
       doc.collected[0].file = '/abs.spec.ts';
       expect(validateDocument(doc).errors).toEqual([
         {
           path: 'collected[0].file',
           message: expect.stringMatching(/does not match the pattern/),
         },
       ]);
     });
   });
   ```

3. Run the target tests. **Expect 12 failures:** the 9 `refuses %j` cases, the
   site-paths test, and the two `validate` refusals. The 5 accept controls, the
   non-string test and the leading-`/` test pass, because no rule exists yet.
4. In `lib/contracts/rules.mjs`, insert between the end of `realDates` and
   `const RUN_RULES`:

   ```js
   const HOME = 'is home-relative (~), not repo-relative (ADR 0029)';
   const ROOTED = 'is absolute (\\), not repo-relative (ADR 0029)';
   const ESCAPES = 'escapes the repository root (ADR 0029)';

   /** +1 per directory entered, -1 per `..`; `.` and empty segments stay put. */
   const depthStep = (seg) =>
     seg === '..' ? -1 : Number(seg !== '' && seg !== '.');

   /** Why `file` is not a path `git ls-files` could print, or null (ADR 0029). */
   function notRepoRelative(file) {
     const segments = file.split(/[\\/]/);
     if (segments[0].startsWith('~')) return HOME;
     if (file.startsWith('\\')) return ROOTED;
     let depth = 0;
     const climbs = segments.some((seg) => (depth += depthStep(seg)) < 0);
     return climbs ? ESCAPES : null;
   }

   /**
    * Rule `repo-relative` on one row's `file` (#1154 S3); the schema pattern
    * already refuses `/` and a drive letter. A non-string is the schema's error.
    */
   function fileRepoRelative(row, prefix) {
     const file = isPlainObject(row) ? row.file : undefined;
     const message = typeof file === 'string' ? notRepoRelative(file) : null;
     return message ? [{ path: at(prefix, 'file'), message }] : [];
   }

   const repoRelative =
     (...keys) =>
     (record, prefix) =>
       keys.flatMap((key) =>
         (Array.isArray(record[key]) ? record[key] : []).flatMap((row, i) =>
           fileRepoRelative(row, at(prefix, `${key}[${i}]`)),
         ),
       );
   ```

5. Wire the rules in. Append `repoRelative('results', 'collected'),` as the last
   entry of `RUN_RULES`. Replace the `REGISTER_RULES` line with:

   ```js
   const FLAKY_RULES = [fileRepoRelative];
   const REGISTER_RULES = [
     authorExcluded,
     realDates(['recorded_at']),
     fileRepoRelative,
   ];
   ```

   In `crossFieldErrors`, add `...nested(doc, 'flaky', FLAKY_RULES),` between
   the `assessments` and `register` lines.

6. Run the target tests and confirm all pass. Then run

   ```bash
   npx vitest run test/canary-starling.test.ts test/site-kit-model.test.ts test/canary-barda*.test.ts
   ```

   These are the producer and consumer suites that validate real output. A new
   refusal there is a producer bug: stop and report it. Do not loosen the rule.

7. Run `wc -l lib/contracts/rules.mjs` and confirm the count is ≤ 300 (the dry
   run gave 295).
8. Run prettier on the three files, then `harness validate`, then
   `harness check-deps` (repo root).
9. Commit:
   `fix(contracts): add rule repo-relative for every file path (Refs #1154)`.

### Task 6: Document the tightenings in the three contract specs

**Depends on:** Task 5 | **Files:** `docs/specs/canary-run-contract.md`,
`docs/specs/canary-site-feed-contract.md`,
`docs/specs/canary-assessment-contract.md` | **Category:** integration

1. `docs/specs/canary-run-contract.md`, "Conventions (frozen)". Replace the
   `real-dates` bullet and the "`file` is repo-relative" bullet with:

   ```markdown
   - **Rule `real-dates`.** `run.started_at` and `run.finished_at` name a real
     instant: month 1–12, a day that exists in that month (leap years included),
     hour ≤ 23, minute and second ≤ 59 (no leap second), and an offset of at
     most `±23:59`. The pattern admits `2026-02-30` or `T24:00:00`, which a date
     parser silently rolls over to another day; such a record is refused. A
     string the pattern itself refuses gets only the pattern error.
   - **Rule `repo-relative`** (ADR 0029). `title` plus `file` is the join key
     between `results[]`, `collected[]` and other canary records, so every
     `file` is a path `git ls-files` could print. The schema pattern refuses a
     leading `/` or drive letter. The validator also refuses a path whose first
     segment is `~` or `~user`, a path that starts with `\`, and a path whose
     `..` segments climb above the repository root. `/` and `\` both separate
     segments. `a/../b.spec.ts` does not escape, so it is accepted.
   - **Rule `non-blank`.** A string field the schema gives `minLength: 1` must
     also hold a non-whitespace character: `"  "` is refused with
     `must not be blank`. This is stricter than stock JSON Schema `minLength`,
     so a producer validating with another library can pass a value canary
     refuses. A nullable field that is `null` is unaffected.
   ```

2. Same file, "Validating" section. After the sentence
   `Unparseable or empty input is a refusal (exit 1), never a pass.`, add:

   ```text
   One leading UTF-8 byte-order mark (U+FEFF) is ignored, whether the input is a file or stdin; a second one is a parse error.
   ```

3. `docs/specs/canary-site-feed-contract.md`, "Conventions (frozen)". In the
   "Nested rules apply in place" bullet, change the run-rule list to

   ```text
   (`counts-safe`, `totals-match-results`, `totals-sum`, `real-dates`, `repo-relative`, `non-blank`)
   ```

   and the assessment-rule list to

   ```text
   (`status-shape`, `verified-derived`, `verification-pair`, `real-dates`, `non-blank`)
   ```

   After the `real-dates` bullet, add:

   ```markdown
   - **Rule `repo-relative`.** Every `flaky[].file` and `register[].file` is
     repo-relative, as in the run contract.
   ```

4. Same file, "Validating" section. Replace the sentence, which is wrapped
   across about lines 241–243,

   ```text
   counts the feed plus its nested runs and assessments: the fixture above reports `1 + 2 + 1 = 4`.
   ```

   with:

   ```text
   counts the feed plus its nested runs, assessments, flaky rows and register rows: the fixture above reports `1 + 2 + 1 + 1 + 1 = 6`. `scopes[]` and `suites[]` entries are keys that records refer to, not records, so they are not counted.
   ```

5. `docs/specs/canary-assessment-contract.md`, "Conventions (frozen)". After the
   `real-dates` bullet, add:

   ```markdown
   - **Rule `non-blank`.** `unit`, `reason`, `verified_by` and every other
     string the schema gives `minLength: 1` must hold a non-whitespace character
     (see the run contract). A blank `reason` on `not-assessed` is reported
     twice, by `non-blank` and by `status-shape`.
   ```

6. From the repo root, run these. A prettier-clean file is not necessarily
   markdownlint-clean, so run both.

   ```bash
   SPECS="docs/specs/canary-run-contract.md docs/specs/canary-site-feed-contract.md docs/specs/canary-assessment-contract.md"
   npx prettier --write $SPECS
   npx --yes markdownlint-cli $SPECS
   node scripts/check_doc_fences.mjs
   ```

7. Run `harness validate`.
8. Commit:

   ```text
   docs(contracts): document real-dates ranges, repo-relative, non-blank and BOM (Refs #1154)
   ```

### Task 7: Gates [checkpoint:human-verify]

**Depends on:** Task 6 | **Files:** none (verification only)

1. Schema identity (criterion 6). From the repo root, run

   ```bash
   git fetch origin && git diff --exit-code origin/main -- agents/skills/lib/contracts/run.v1.schema.json agents/skills/lib/contracts/assessment.v1.schema.json agents/skills/lib/contracts/site.v1.schema.json agents/skills/test/fixtures/contracts/
   ```

   It must exit 0 with no output.

2. In `agents/skills`, run `npx vitest run test/contracts-*.test.ts`, then
   `npm test`, `npm run typecheck` and `npm run format:check`. Read the
   **counts**: the contract files should report 199 tests (171 before this plan
   plus 28 new). A smaller denominator means a test file did not load. That is
   an abstention, not a pass.
3. Repo root: run `harness validate` and `harness check-deps`.
4. Perf and entropy. Run `harness check-perf 2>&1 | grep -A1 'lib/contracts'`.
   It must print nothing. Before this plan, there were 0 findings under
   `lib/contracts`. Confirm `wc -l agents/skills/lib/contracts/*.mjs` shows
   every file at or under 300. Run `git diff --stat origin/main` and confirm
   that no file was added under `agents/skills/lib/` (entropy `entryPoints`
   unchanged).
5. Doc drift (rule 8). Run

   ```text
   grep -rn "1 + 2 + 1 = 4\|parses as NaN" docs/specs agents/skills/lib/contracts
   ```

   It must return nothing: both phrases describe the pre-#1154 behavior.

6. Present the gate counts to the human before the PR is opened.

## Traceability

| Observable truth           | Task(s)        |
| -------------------------- | -------------- |
| 1, 2 (S2)                  | Task 3         |
| 3, 4 (S3)                  | Task 5         |
| 5 (S4)                     | Task 4         |
| 6 (S7)                     | Task 2         |
| 7 (S8)                     | Task 1         |
| 8 (schemas byte-identical) | Task 7 step 1  |
| 9 (spec docs)              | Task 6         |
| 10 (gates, perf, line cap) | Task 5, Task 7 |

## Parallelism

Tasks 1→2→4 share `contracts-validate.test.ts`. Tasks 3→5 share `rules.mjs`, and
Task 5 also touches `contracts-validate.test.ts`. Run them serially in spec
order (S8, S7, S2, S4, S3). The overlap makes a parallel wave save less than the
merge risk it adds.
