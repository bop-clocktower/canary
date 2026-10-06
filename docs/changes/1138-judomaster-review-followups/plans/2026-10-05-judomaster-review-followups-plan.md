<!-- markdownlint-disable MD013 -->

# Plan: canary-judomaster review follow-ups (containment, runner cwd/no-fetch, mock warning, exception chain)

**Date:** 2026-10-05 | **Spec:**
`docs/changes/1138-judomaster-review-followups/proposal.md` | **Tasks:** 10 |
**Time:** ~40 min | **Integration Tier:** medium | **Rigor:** fast (no skeleton)
| **Branch:** `feat/1138-judomaster-review-followups` (worktree
`/Users/bs/Github/canary-1138`)

## Goal

`canary judomaster` stops misleading its user in four places: `--root /`
resolves frames, `verify` runs the runner from `--root` and never downloads it,
a generated test that mocks the suspect gets a warning, and chained exceptions
are listed with the root cause marked.

## Observable Truths (Acceptance Criteria)

1. The system shall treat `isWithin(base, candidate)` as true only when
   `path.relative(base, candidate)` is non-empty, not `..`, not `../...` and not
   absolute: `isWithin('/', '/a/b')` true, `isWithin('/repo', '/repo-other/x')`
   false, `isWithin('/repo', '/repo')` false, `isWithin('/repo', '/repo/..foo')`
   true. (Task 1)
2. When `resolveFrames` runs with root `/`, an absolute frame path of an
   existing file shall resolve (`status: 'resolved'`, path relative to `/`); a
   frame under `<tmp>/repo-other/` shall never resolve against root
   `<tmp>/repo`. (Task 1)
3. Where `execute(..., { fetch: false })` is used and the command starts with
   `npx`, the system shall spawn `npx --no ...` with no `--yes`/`-y` among npx's
   own flags; `pytest {file}` is unchanged; with no options argv and spawn
   options are byte-identical to today (no `cwd` key). (Task 2)
4. When `execute(..., { cwd })` is used, spawnSync receives that `cwd`. (Task 2)
5. When runner output contains `npx canceled due to missing packages`, the
   verdict shall be `unverified — could not reproduce` and the reason shall name
   the runner parsed from `["vitest@5.0.3"]` (fallback: the framework) and say
   verify does not fetch runners. (Task 3)
6. `canary judomaster verify` shall call the executor with
   `(realpath(test), framework, timeout, { cwd: realpath(root), fetch: false })`;
   a npx-cancel run exits 3. (Task 4)
7. When the test source mocks the suspect module in any C7 form
   (`vi.mock`/`vi.doMock`/`jest.mock`/`jest.doMock` relative, `@/`, `~/`, bare
   suffix; Python `patch`/`mock.patch`/`mocker.patch`/`monkeypatch.setattr`/
   `monkeypatch.delattr` dotted string; `patch.object(X,`/
   `monkeypatch.setattr(X,` by stem), `mockedSuspectWarnings` returns one
   warning per match; a mock of a different module returns `[]`. (Task 5)
8. When the brief has a suspect and the test mocks it, `verify` prints
   `WARNING: the test mocks the suspect module ...` after the vacuity line and
   `--json` carries `warnings`; verdict and exit code are unchanged; without
   `--brief` there is no `warnings` key. (Task 6)
9. When a V8 trace carries `[cause]: <ErrorLine>`, `ParsedTrace.chain` lists it
   with relation `cause` and `start` at the first cause frame; a frame line
   ending in `{` parses. When a CPython trace has either separator sentence, the
   chain is listed outward-in with the matching relation, and
   `errorType`/`message`/`frames` are identical to today's flat parse. If any
   block has no error line, `chain` is absent. (Task 7)
10. An unchained trace produces no `chain` key in `ParsedTrace`, the brief JSON,
    or markdown changes. (Tasks 7, 8)
11. When a brief has a chain, the requirement ends with
    `The reported <T> wraps a root cause, <RootT>: <msg>[ at path:line]; exercise the code path that raises it.`;
    the markdown has `## Exception chain (reported first)` with `(root cause)`
    on the last link, and `- --- caused by ... ---` /
    `- --- while handling ... ---` before each link's first frame. Suspect and
    signature are unchanged (C1/C2). (Task 8)
12. SKILL.md, the guide and CHANGELOG no longer claim `verify` runs from the
    process cwd or can download a runner, and describe the chain and mock
    warning. (Task 9)
13. Four gates from `ts/` pass, plus `harness validate`, `harness check-deps`,
    `harness check-arch` (with an allowance if module-size grew),
    `harness check-perf` delta OK, entropy unchanged. (Task 10)

## Uncertainties

- [ASSUMPTION] `mockedSuspectWarnings` lives in `resolve.ts`, not `verify.ts`.
  `verify.ts` is 237 lines; the npx-cancel branch (+~15) and the detector (+~55)
  would cross the 300-line perf threshold. Resolving a mock specifier against
  the suspect path is path/module resolution, which is `resolve.ts`'s job; no
  new source module (entropy). The spec's `verify.ts:mockedSuspect` location is
  the only deviation; the `VerifyResult.warnings` field stays in `verify.ts`.
- [ASSUMPTION] The npx rewrite only touches npx's own leading flags (tokens
  between `npx` and the first non-flag token), so a runner arg such as
  `vitest -y` is never stripped. Result is always
  `npx --no <flags...> <pkg> ...`.
- [ASSUMPTION] Mock language is chosen by the suspect's extension (`.py` →
  Python forms, otherwise JS forms).
- [ASSUMPTION] The brief's `suspect.path` is relative to the same root passed to
  `verify --root`. If the brief was built against a different root the mock
  check silently misses (warning-only, verdict unaffected). Documented in the
  guide.
- [ASSUMPTION] A CPython block with no error line (with or without frames) drops
  the whole chain; the trace parses exactly as today.
- [ASSUMPTION] V8 links are always relation `cause`; `AggregateError`'s
  `[errors]: [...]` is out of scope. A `[cause]:` whose value is not an error
  line (e.g. an object) is skipped.
- [DEFERRABLE] The arch module-size number for the allowance is measured in Task
  10 against the merge base; it cannot be known now.
- [DEFERRABLE] A Python suspect that is a package `__init__.py` maps to
  `pkg.__init__`, so `patch("pkg.x")` does not warn. Not in C7; leave for a
  follow-up if it shows up.

## File Map

- MODIFY `ts/src/analysis/judomaster/resolve.ts` (isWithin,
  mockedSuspectWarnings)
- MODIFY `ts/src/analysis/judomaster/verify.ts` (isWithin in
  containedInGenerated, npx-cancel reason, `warnings?`)
- MODIFY `ts/src/core/executor.ts` (`opts: { cwd?, fetch? }`)
- MODIFY `ts/src/judomaster/judomaster-verify-cli.ts` (cwd/no-fetch, warnings,
  header)
- MODIFY `ts/src/judomaster/judomaster-cli.ts` (header comment only)
- MODIFY `ts/src/analysis/judomaster/types.ts` (ChainLink, chain fields)
- MODIFY `ts/src/analysis/judomaster/parse.ts` (V8 `[cause]`, `{` frames,
  CPython blocks)
- MODIFY `ts/src/analysis/judomaster/brief.ts` (per-link suspect, requirement
  sentence)
- MODIFY `ts/src/analysis/judomaster/render.ts` (chain section, boundaries,
  WARNING lines)
- MODIFY `ts/test/judomaster-resolve.test.ts`
- MODIFY `ts/test/judomaster-verify.test.ts`
- MODIFY `ts/test/executor.test.ts`
- MODIFY `ts/test/judomaster-cli.test.ts`
- MODIFY `ts/test/judomaster-parse.test.ts`
- MODIFY `ts/test/judomaster-brief.test.ts`
- MODIFY `ts/test/judomaster-render.test.ts`
- MODIFY `agents/skills/claude-code/canary-judomaster/SKILL.md`
- MODIFY `docs/guides/incident-to-regression-test.md`
- MODIFY `CHANGELOG.md`
- CREATE `.harness/arch/allowances/feat-1138-judomaster-review-followups.json`
  (only if `check-arch` reports module-size growth)

No new source modules (`ts/src/**`): the entropy ratchet trips on new modules.

## Evidence (existing code)

- `resolve.ts:32-40` `inside()` uses `real.startsWith(rootReal + sep)`; with
  root `/` the prefix is `//`.
- `verify.ts:225-237` `containedInGenerated` uses `real.startsWith(base + sep)`.
- `verify.ts:60-77` `couldNotRun`; `verify.ts:193-207` `classifyRun`.
- `executor.ts:136-140` `execute(filePath, frameworkName, timeout = 30)`;
  `executor.ts:164-173` spawnSync options have no `cwd`.
- `ts/src/data/frameworks/registry.json:10,35,140`:
  `npx --yes playwright test {file}` / `npx --yes vitest run {file}`.
- `judomaster-verify-cli.ts:1-9` header documents process cwd + `npx --yes`;
  `:104-115` `execSafely`; `:161-176` `gradeRun`; `:178-200` `runVerify`.
- `judomaster-cli.ts:8-11` header repeats the cwd / `npx --yes` claim.
- `main-deps.ts:77` `makeExecutor(): CanaryTestExecutor` (so the new optional
  4th parameter is visible to the CLI with no deps change).
- `parse.ts:19` `V8_FRAME` ends `\)?$` (a frame ending `{` is dropped);
  `parse.ts:94-114` `parseV8`/`parsePython`.
- `brief.ts:25-30` `pickSuspect`; `:62-76` `requirementFor`; `:79-96`
  `buildBrief`.
- `render.ts:30-35` `frameLines`; `:38-57` `renderBrief`; `:74-85`
  `renderVerify`.
- `judomaster-cli.test.ts:268,295,302` assert
  `toHaveBeenCalledWith(..., 'vitest'|'pytest', 60|5)` with three args;
  `:126-129` `executorReturning`.
- `executor.test.ts:48-51` `lastArgv()`; `:133-143` reads
  `spawnSync.mock.calls[0][2]`.
- `tsconfig.json:13` `declaration: true` → the executor options type is an
  inline literal (a non-exported interface on a public method would fail
  declaration emit; an exported one would be a dead export).

## Conventions for every task

- Work only in `/Users/bs/Github/canary-1138`. Run test commands from
  `/Users/bs/Github/canary-1138/ts`.
- Red first: run the named test file, confirm the new cases fail for the
  expected reason (not a syntax error), then implement, then green.
- `npx prettier --write <changed files>` before each commit (single quote, 80
  col). Never `--no-verify`.
- Keep every function small (perf complexity ratchet) and every source file
  under 300 lines.
- Each task ends with `harness validate` and a Conventional Commit. Commit
  bodies carry `Refs #1138` (never a closing keyword).

## Tasks

### Task 1: `isWithin` containment helper

**Depends on:** none | **Files:** `ts/src/analysis/judomaster/resolve.ts`,
`ts/src/analysis/judomaster/verify.ts`, `ts/test/judomaster-resolve.test.ts`

1. Append to `ts/test/judomaster-resolve.test.ts` (add `isWithin` to the import
   from `../src/analysis/judomaster/resolve.js`, add `realpathSync` to the
   `node:fs` import):

   ```ts
   describe('isWithin', () => {
     it('is true for a path strictly inside the base, including root /', () => {
       expect(isWithin('/', '/a/b')).toBe(true);
       expect(isWithin('/repo', '/repo/..foo')).toBe(true);
     });

     it('is false for a sibling with a shared prefix, the base itself, or a parent', () => {
       expect(isWithin('/repo', '/repo-other/x')).toBe(false);
       expect(isWithin('/repo', '/repo')).toBe(false);
       expect(isWithin('/repo', '/')).toBe(false);
     });
   });

   describe('resolveFrames containment', () => {
     it('resolves an absolute in-repo frame when the root is /', () => {
       const real = realpathSync(join(root, 'src', 'cart', 'total.ts'));
       const f = resolveFrames([{ file: real, line: 3 }], '/')[0]!;
       expect(f.status).toBe('resolved');
       expect(f.path).toBe(real.slice(1));
     });

     it('never resolves a frame under a sibling repo-other directory', () => {
       mkdirSync(join(base, 'repo-other', 'src'), { recursive: true });
       const other = join(base, 'repo-other', 'src', 'a.ts');
       writeFileSync(other, 'a\n');
       const f = resolveFrames([{ file: other, line: 1 }], root)[0]!;
       expect(f.status).toBe('missing');
     });
   });
   ```

   (The sibling case already passes today; it is a regression guard. The
   `isWithin` cases and the root-`/` case are the red ones.)

2. Run `npx vitest run test/judomaster-resolve.test.ts` — expect failure
   (`isWithin` not exported; root `/` frame reads `missing`).
3. In `resolve.ts`, add after `isExternal` and use it in `inside()`:

   ```ts
   /**
    * True when `candidate` lies strictly inside `base`. Built on relative()
    * rather than a string prefix: `base + sep` is `//` for root `/` and
    * `/repo` is a prefix of `/repo-other`.
    */
   export function isWithin(base: string, candidate: string): boolean {
     const rel = relative(base, candidate);
     return (
       rel !== '' &&
       rel !== '..' &&
       !rel.startsWith(`..${sep}`) &&
       !isAbsolute(rel)
     );
   }
   ```

   and in `inside()` replace
   `if (!real.startsWith(rootReal + sep)) return null;` with
   `if (!isWithin(rootReal, real)) return null;`.

4. In `verify.ts`: `import { isWithin } from './resolve.js';`, replace
   `if (!real.startsWith(base + sep)) return null;` with
   `if (!isWithin(base, real)) return null;`, drop `sep` from the `node:path`
   import.
5. Run
   `npx vitest run test/judomaster-resolve.test.ts test/judomaster-verify.test.ts`
   — green.
6. Run `harness validate`.
7. Commit:
   `fix(judomaster): path containment via relative(), not a string prefix`

### Task 2: executor `cwd` and no-fetch option

**Depends on:** none | **Files:** `ts/src/core/executor.ts`,
`ts/test/executor.test.ts`

1. Add to the `CanaryTestExecutor` describe in `ts/test/executor.test.ts`:

   ```ts
   it('keeps npx --yes and sets no cwd by default', () => {
     mockSpawn({ status: 0 });
     executor.execute('/t/a.test.ts', 'vitest');
     expect(lastArgv().slice(0, 2)).toEqual(['npx', '--yes']);
     expect(vi.mocked(spawnSync).mock.calls[0]![2]).not.toHaveProperty('cwd');
   });

   it('runs with npx --no and the given cwd when fetch is false', () => {
     mockSpawn({ status: 0 });
     executor.execute('/t/a.test.ts', 'vitest', 30, {
       cwd: '/repo',
       fetch: false,
     });
     const argv = lastArgv();
     expect(argv.slice(0, 2)).toEqual(['npx', '--no']);
     expect(argv).not.toContain('--yes');
     expect(argv).toContain('/t/a.test.ts');
     const opts = vi.mocked(spawnSync).mock.calls[0]![2] as { cwd?: string };
     expect(opts.cwd).toBe('/repo');
   });

   it('leaves a non-npx command alone when fetch is false', () => {
     mockSpawn({ status: 0 });
     executor.execute('/t/test_a.py', 'pytest', 30, { fetch: false });
     expect(lastArgv()).toEqual(['pytest', '/t/test_a.py']);
   });
   ```

2. Run `npx vitest run test/executor.test.ts` — the second and third fail (TS
   arg count is erased at runtime; argv still has `--yes`, no cwd).
3. In `executor.ts`, add above the class:

   ```ts
   /**
    * `npx --no` in place of `--yes` / `-y`: npx then refuses to download a
    * runner the project does not have. Only npx's own leading flags are
    * touched, so a runner argument such as `-y` after the package survives.
    */
   function withoutFetch(cmd: string[]): string[] {
     if (cmd[0] !== 'npx') return cmd;
     const pkg = cmd.findIndex((tok, i) => i > 0 && !tok.startsWith('-'));
     const end = pkg === -1 ? cmd.length : pkg;
     const flags = cmd
       .slice(1, end)
       .filter((tok) => !['--yes', '-y', '--no'].includes(tok));
     return ['npx', '--no', ...flags, ...cmd.slice(end)];
   }
   ```

   Change the signature (inline type, see Evidence: `declaration: true`):

   ```ts
   execute(
     filePath: string,
     frameworkName: string,
     timeout = 30,
     opts: { cwd?: string; fetch?: boolean } = {},
   ): ExecuteResult {
   ```

   Document `@param opts` (`cwd`: directory to run in, default the process cwd;
   `fetch: false`: never let npx download the runner). After the CI-flag push:
   `const argv = opts.fetch === false ? withoutFetch(cmd) : cmd;` and spawn
   `argv[0]!, argv.slice(1)` with
   `...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),` added to the options
   object.

4. Run `npx vitest run test/executor.test.ts` — green.
5. Run `harness validate`.
6. Commit: `feat(executor): optional cwd and no-fetch execution options`

### Task 3: classify a npx "missing packages" refusal as could-not-run

**Depends on:** none | **Files:** `ts/src/analysis/judomaster/verify.ts`,
`ts/test/judomaster-verify.test.ts`

1. Add to the `classifyRun` describe in `ts/test/judomaster-verify.test.ts`:

   ```ts
   const NPX_CANCEL =
     'npm error npx canceled due to missing packages and no YES option: ["vitest@5.0.3"]\nnpm error A complete log of this run can be found in: /x.log';

   it('names the runner when npx refuses to fetch it', () => {
     const r = classifyRun([1, '', NPX_CANCEL], SIG, 'vitest');
     expect(r.verdict).toBe('unverified');
     expect(r.label).toBe(COULD_NOT);
     expect(r.reason).toBe(
       'the runner vitest is not installed under the root; verify does not fetch runners (install it, e.g. npm i -D vitest)',
     );
   });

   it('falls back to the framework name when npx lists no package', () => {
     const r = classifyRun(
       [1, '', 'npm error npx canceled due to missing packages'],
       SIG,
       'playwright',
     );
     expect(r.label).toBe(COULD_NOT);
     expect(r.reason).toContain('the runner playwright is not installed');
   });
   ```

2. Run `npx vitest run test/judomaster-verify.test.ts` — both fail (verdict
   `failed-other-reason`).
3. In `verify.ts`, below `couldNotRun` (kept unchanged so its complexity does
   not grow):

   ```ts
   const NPX_CANCELED = /npx canceled due to missing packages/;
   const NPX_PACKAGE = /\["(@?[^"@]+)/;

   /** `verify` runs `npx --no`: a runner the root lacks is never downloaded. */
   function npxCanceled(output: string, framework: string): string | null {
     const at = output.search(NPX_CANCELED);
     if (at === -1) return null;
     const runner = NPX_PACKAGE.exec(output.slice(at))?.[1] ?? framework;
     return `the runner ${runner} is not installed under the root; verify does not fetch runners (install it, e.g. npm i -D ${runner})`;
   }
   ```

   In `classifyRun`:
   `const notRun = couldNotRun(exec, framework) ?? npxCanceled(output, framework);`

4. Run
   `npx vitest run test/judomaster-verify.test.ts test/judomaster-review.test.ts`
   — green.
5. Run `harness validate`.
6. Commit: `feat(judomaster): name the runner when npx refuses to fetch it`

### Task 4: `verify` runs from `--root` without fetching

**Depends on:** Task 2, Task 3 | **Files:**
`ts/src/judomaster/judomaster-verify-cli.ts`,
`ts/src/judomaster/judomaster-cli.ts` (comment only),
`ts/test/judomaster-cli.test.ts`

1. In `ts/test/judomaster-cli.test.ts` add
   `const RUN_OPTS = () => ({ cwd: realpathSync(root), fetch: false });` and
   update the three executor assertions:
   - line 268:
     `toHaveBeenCalledWith(expect.any(String), 'vitest', 60, RUN_OPTS())`
   - line 295:
     `toHaveBeenCalledWith(realpathSync(test), 'pytest', 5, RUN_OPTS())`
   - line 302:
     `toHaveBeenCalledWith(realpathSync(test), 'vitest', 60, RUN_OPTS())`

   and add:

   ```ts
   it('exits 3 naming the runner when npx refuses to fetch it', async () => {
     const test = seedGenerated();
     const exec = executorReturning([
       1,
       '',
       'npm error npx canceled due to missing packages and no YES option: ["vitest@5.0.3"]',
     ]);
     const res = await verify(exec, test, '--expect', SIG);
     expect(res.code).toBe(3);
     expect(res.stdout).toContain('verify does not fetch runners');
   });
   ```

2. Run `npx vitest run test/judomaster-cli.test.ts` — the three updated
   assertions fail (called with 3 args). The new case already passes via Task 3
   (guard).
3. In `judomaster-verify-cli.ts`:
   - `import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';`
   - `execSafely(deps, test, framework, timeout, cwd: string)` calls
     `deps.makeExecutor().execute(test, framework, timeout, { cwd, fetch: false })`.
   - `gradeRun(..., signature, rootReal: string)` passes `rootReal` through.
   - In `runVerify`, after `containedTest(...)` (which already exits 2 for a
     missing root): `const rootReal = realpathSync(root);` and pass it to
     `gradeRun`.
   - Replace header lines 6-8 with:

     ```ts
      * The runner is the framework's registry command, spawned with cwd set to
      * the realpath of `--root` (default: the current directory) so it finds
      * the project's config, and with `npx --no` in place of `npx --yes`: a
      * runner the root does not have installed is reported as unverified,
      * never downloaded (#1138).
     ```

4. In `judomaster-cli.ts` replace lines 8-11 (from "`verify` runs the" to "the
   project's config.") with:
   `` `verify` runs the framework's registry command from `--root` and never downloads a runner (see judomaster-verify-cli.ts). ``
5. Run
   `npx vitest run test/judomaster-cli.test.ts test/judomaster-cli-stdin.test.ts`
   — green.
6. Run `harness validate` and `harness check-deps`.
7. Commit:
   `feat(judomaster): verify runs the runner from --root and never fetches it`

### Task 5: detect a test that mocks the suspect module

**Depends on:** Task 1 | **Files:** `ts/src/analysis/judomaster/resolve.ts`,
`ts/src/analysis/judomaster/verify.ts`, `ts/test/judomaster-resolve.test.ts`

1. Append to `ts/test/judomaster-resolve.test.ts` (import
   `mockedSuspectWarnings` from `resolve.js`):

   ```ts
   describe('mockedSuspectWarnings', () => {
     const DIR = 'tests/generated/regression';
     const JS = 'src/cart/total.ts';
     const PY = 'src/cart/total.py';
     const warn = (src: string, suspect: string) =>
       mockedSuspectWarnings(src, DIR, suspect);

     it('flags vi.mock of the suspect by relative path and names both', () => {
       const w = warn("vi.mock('../../../src/cart/total', () => ({}));", JS);
       expect(w).toEqual([
         "the test mocks the suspect module src/cart/total.ts (vi.mock('../../../src/cart/total')); a regression test that mocks the code it should exercise cannot reproduce the defect",
       ]);
     });

     it('flags jest.doMock with an extension, and @/ ~/ bare suffixes', () => {
       expect(
         warn('jest.doMock("../../../src/cart/total.js")', JS),
       ).toHaveLength(1);
       expect(warn("vi.mock('@/cart/total')", JS)).toHaveLength(1);
       expect(warn("jest.mock('~/cart/total')", JS)).toHaveLength(1);
       expect(warn("vi.doMock('cart/total')", JS)).toHaveLength(1);
     });

     it('ignores a mock of another module and vi.mocked()', () => {
       expect(warn("vi.mock('../../../src/cart/tax')", JS)).toEqual([]);
       expect(warn("vi.mock('../../../src/cart/totals')", JS)).toEqual([]);
       expect(warn('vi.mocked(total).mockReturnValue(1)', JS)).toEqual([]);
     });

     it('flags Python string patch targets inside the suspect module', () => {
       expect(warn('@mock.patch("cart.total.compute")', PY)).toHaveLength(1);
       expect(warn("mocker.patch('src.cart.total')", PY)).toHaveLength(1);
       expect(
         warn('monkeypatch.setattr("cart.total.TAX", 0)', PY),
       ).toHaveLength(1);
       expect(warn("monkeypatch.delattr('cart.total.TAX')", PY)).toHaveLength(
         1,
       );
       expect(warn("with patch('cart.total.rate'):", PY)).toHaveLength(1);
     });

     it('flags Python object forms by the module stem only', () => {
       expect(warn('patch.object(total, "compute")', PY)).toEqual([
         'the test mocks the suspect module src/cart/total.py (patch.object(total, ...)); a regression test that mocks the code it should exercise cannot reproduce the defect',
       ]);
       expect(warn('monkeypatch.setattr(total, "TAX", 0)', PY)).toHaveLength(1);
       expect(warn('monkeypatch.setattr(tax, "rate", 0)', PY)).toEqual([]);
     });

     it('ignores Python patches of other modules', () => {
       expect(warn("mocker.patch('cart.tax.rate')", PY)).toEqual([]);
       expect(warn("patch('cart.totals.x')", PY)).toEqual([]);
       expect(warn("patch('total.x')", PY)).toEqual([]);
     });
   });
   ```

   (`patch('total.x')` must not warn: single-segment suffixes are excluded
   unless the module itself is single-segment.)

2. Run `npx vitest run test/judomaster-resolve.test.ts` — fails (not exported).
3. In `resolve.ts` change the path import to
   `import { isAbsolute, posix, relative, resolve, sep } from 'node:path';` and
   append:

   ```ts
   const JS_EXT = /\.[cm]?[jt]sx?$/;
   const JS_MOCK = /\b(?:vi|jest)\.(?:do)?[mM]ock\(\s*(['"`])([^'"`]+)\1/g;
   const PY_PATCH =
     /\b(?:mock\.patch|mocker\.patch|patch|monkeypatch\.(?:setattr|delattr))\(\s*(['"])([\w.]+)\1/g;
   const PY_OBJECT =
     /\b(?:patch\.object|monkeypatch\.setattr)\(\s*([A-Za-z_]\w*)\s*,/g;

   /** A JS mock specifier as a root-relative path stem, or a bare suffix. */
   function jsMocksSuspect(spec: string, dir: string, stem: string): boolean {
     if (spec.startsWith('.')) {
       return (
         posix.normalize(posix.join(dir, spec)).replace(JS_EXT, '') === stem
       );
     }
     const bare = spec.replace(/^[@~]\//, '').replace(JS_EXT, '');
     return bare === stem || stem.endsWith(`/${bare}`);
   }

   function jsMocks(source: string, dir: string, suspect: string): string[] {
     const stem = suspect.replace(JS_EXT, '');
     return [...source.matchAll(JS_MOCK)]
       .filter((m) => jsMocksSuspect(m[2]!, dir, stem))
       .map((m) => `${m[0]})`);
   }

   /** The suspect's dotted module path and each dotted suffix of 2+ parts. */
   function pyModules(suspect: string): string[] {
     const parts = suspect.replace(/\.py$/, '').split('/');
     return parts
       .map((_, i) => parts.slice(i).join('.'))
       .filter((mod, i) => i === 0 || mod.includes('.'));
   }

   function pyMocks(source: string, suspect: string): string[] {
     const mods = pyModules(suspect);
     const stem = posix.basename(suspect, '.py');
     const strings = [...source.matchAll(PY_PATCH)]
       .filter((m) =>
         mods.some((mod) => m[2] === mod || m[2]!.startsWith(`${mod}.`)),
       )
       .map((m) => `${m[0]})`);
     const objects = [...source.matchAll(PY_OBJECT)]
       .filter((m) => m[1] === stem)
       .map((m) => `${m[0]} ...)`);
     return [...strings, ...objects];
   }

   /**
    * C6/C7 (#1138): one warning per call in `testSource` that mocks the
    * suspect module. `testRelDir` and `suspectPath` are root-relative posix
    * paths. A warning only: a test that mocks the code it should exercise can
    * still go red for an unrelated reason, so `verify` says so.
    */
   export function mockedSuspectWarnings(
     testSource: string,
     testRelDir: string,
     suspectPath: string,
   ): string[] {
     const calls = suspectPath.endsWith('.py')
       ? pyMocks(testSource, suspectPath)
       : jsMocks(testSource, testRelDir, suspectPath);
     return calls.map(
       (call) =>
         `the test mocks the suspect module ${suspectPath} (${call}); a regression test that mocks the code it should exercise cannot reproduce the defect`,
     );
   }
   ```

   Update the `resolve.ts` header with one paragraph naming the mock check.

4. In `verify.ts` add to `VerifyResult`:
   `/** Mock-the-suspect warnings (#1138); set only when non-empty. Never change the verdict. */ warnings?: string[];`
5. Run `npx vitest run test/judomaster-resolve.test.ts` — green.
   `wc -l src/analysis/judomaster/resolve.ts` < 300.
6. Run `harness validate`.
7. Commit: `feat(judomaster): detect a regression test that mocks its suspect`

### Task 6: print mock warnings from `verify`

**Depends on:** Task 4, Task 5 | **Files:**
`ts/src/judomaster/judomaster-verify-cli.ts`,
`ts/src/analysis/judomaster/render.ts`, `ts/test/judomaster-render.test.ts`,
`ts/test/judomaster-cli.test.ts`

1. Add to the `renderVerify` describe in `ts/test/judomaster-render.test.ts`:

   ```ts
   it('prints each warning after the vacuity line, verdict unchanged', () => {
     const md = renderVerify({
       verdict: 'not-reproduced',
       label: 'not-reproduced',
       vacuity: true,
       reason: 'the test passed against the code it was written to catch',
       warnings: ['the test mocks the suspect module src/cart/total.ts (x)'],
     });
     const lines = md.split('\n');
     const vac = lines.findIndex((l) => l.startsWith('VACUITY RED FLAG'));
     const warn = lines.indexOf(
       'WARNING: the test mocks the suspect module src/cart/total.ts (x)',
     );
     expect(warn).toBeGreaterThan(vac);
     expect(warn).toBeLessThan(lines.findIndex((l) => l.startsWith('Reason:')));
   });
   ```

   Add to `ts/test/judomaster-cli.test.ts` (verify describe):

   ```ts
   const MOCKING = "vi.mock('../../../src/cart/total', () => ({}));\n";

   it('warns when the test mocks the suspect, verdict and exit unchanged', async () => {
     const test = seedGenerated(TEST_REL, MOCKING);
     const exec = executorReturning([1, `TypeError: ${SIG}`, '']);
     const res = await verify(
       exec,
       test,
       '--brief',
       await writeBrief(),
       '--json',
     );
     expect(res.code).toBe(0);
     const parsed = JSON.parse(res.stdout);
     expect(parsed.verdict).toBe('reproduced');
     expect(parsed.warnings).toEqual([
       expect.stringContaining('mocks the suspect module src/cart/total.ts'),
     ]);
   });

   it('prints a WARNING line in markdown', async () => {
     const test = seedGenerated(TEST_REL, MOCKING);
     const exec = executorReturning([1, `TypeError: ${SIG}`, '']);
     const res = await verify(exec, test, '--brief', await writeBrief());
     expect(res.stdout).toContain('WARNING: the test mocks the suspect module');
   });

   it('does not check mocks without --brief', async () => {
     const test = seedGenerated(TEST_REL, MOCKING);
     const exec = executorReturning([1, `TypeError: ${SIG}`, '']);
     const res = await verify(exec, test, '--expect', SIG, '--json');
     expect(JSON.parse(res.stdout)).not.toHaveProperty('warnings');
   });

   it('does not warn about a mock of another module', async () => {
     const test = seedGenerated(
       TEST_REL,
       "vi.mock('../../../src/cart/tax');\n",
     );
     const exec = executorReturning([1, `TypeError: ${SIG}`, '']);
     const res = await verify(
       exec,
       test,
       '--brief',
       await writeBrief(),
       '--json',
     );
     expect(JSON.parse(res.stdout)).not.toHaveProperty('warnings');
   });
   ```

2. Run
   `npx vitest run test/judomaster-render.test.ts test/judomaster-cli.test.ts` —
   new cases fail.
3. In `render.ts` `renderVerify`, after the vacuity spread:
   `...(result.warnings ?? []).flatMap((w) => [`WARNING: ${w}`, '']),`
4. In `judomaster-verify-cli.ts`: add `relative, sep` to the `node:path` import,
   import `mockedSuspectWarnings` from `'../analysis/judomaster/resolve.js'`,
   and add:

   ```ts
   /**
    * C6 (#1138): a warning, never a verdict change. Reads the test's own
    * source only; needs the brief's suspect, so without --brief it is skipped.
    */
   function withMockWarnings(
     result: VerifyResult,
     brief: RegressionBrief | null,
     real: string,
     rootReal: string,
   ): VerifyResult {
     const suspect = brief?.suspect?.path;
     if (suspect === undefined) return result;
     const dir = relative(rootReal, dirname(real)).split(sep).join('/');
     const source = readFileSync(real, 'utf-8');
     const warnings = mockedSuspectWarnings(source, dir, suspect);
     return warnings.length === 0 ? result : { ...result, warnings };
   }
   ```

   In `runVerify`:
   `const result = withMockWarnings(gradeRun(...), brief, real, rootReal);` (the
   JSON payload already spreads `result`).

5. Run
   `npx vitest run test/judomaster-render.test.ts test/judomaster-cli.test.ts` —
   green.
6. Run `harness validate` and `harness check-deps`.
7. Commit: `feat(judomaster): verify warns when the test mocks the suspect`

### Task 7: parse exception-chain boundaries (types + parser)

**Depends on:** none | **Files:** `ts/src/analysis/judomaster/types.ts`,
`ts/src/analysis/judomaster/parse.ts`, `ts/test/judomaster-parse.test.ts`

1. Append to `ts/test/judomaster-parse.test.ts`:

   ```ts
   const QTY = "Cannot read properties of undefined (reading 'qty')";
   const V8_CHAIN = [
     'Error: checkout failed',
     '    at checkout (/app/src/cart/checkout.ts:30:10)',
     '    at main (/app/src/main.ts:5:3) {',
     `  [cause]: TypeError: ${QTY}`,
     '      at cartTotal (/app/src/cart/total.ts:12:7)',
     '      ... 2 lines matching cause stack trace ...',
     '      at main (/app/src/main.ts:5:3)',
     '}',
   ].join('\n');

   const pyBlock = (file: string, line: number, error: string) => [
     'Traceback (most recent call last):',
     `  File "${file}", line ${line}, in fn`,
     '    pass',
     error,
   ];
   const CAUSE =
     'The above exception was the direct cause of the following exception:';
   const CONTEXT =
     'During handling of the above exception, another exception occurred:';

   describe('parseTrace: exception chains', () => {
     it('reads a frame line that ends in " {"', () => {
       const t = parseTrace('TypeError: x\n    at f (/app/src/a.ts:1:2) {')!;
       expect(t.frames[0]).toEqual({
         file: '/app/src/a.ts',
         line: 1,
         column: 2,
         fn: 'f',
       });
     });

     it('keeps the V8 wrapper as the reported error and links its [cause]', () => {
       const t = parseTrace(V8_CHAIN)!;
       expect([t.errorType, t.message]).toEqual(['Error', 'checkout failed']);
       expect(t.frames.map((f) => f.line)).toEqual([30, 5, 12, 5]);
       expect(t.chain).toEqual([
         { errorType: 'TypeError', message: QTY, relation: 'cause', start: 2 },
       ]);
     });

     it('links CPython blocks outward-in with their relation', () => {
       const text = [
         ...pyBlock('/srv/app/cart/db.py', 3, "KeyError: 'qty'"),
         '',
         CONTEXT,
         '',
         ...pyBlock('/srv/app/cart/total.py', 8, 'ValueError: bad qty'),
         '',
         CAUSE,
         '',
         ...pyBlock(
           '/srv/app/cart/api.py',
           20,
           'cart.errors.CartError: bad cart',
         ),
       ].join('\n');
       const t = parseTrace(text)!;
       expect([t.errorType, t.message]).toEqual([
         'cart.errors.CartError',
         'bad cart',
       ]);
       expect(t.frames.map((f) => f.line)).toEqual([20, 8, 3]);
       expect(t.chain).toEqual([
         {
           errorType: 'ValueError',
           message: 'bad qty',
           relation: 'cause',
           start: 1,
         },
         {
           errorType: 'KeyError',
           message: "'qty'",
           relation: 'context',
           start: 2,
         },
       ]);
     });

     it('drops the chain when a block has no error line', () => {
       const text = [
         'Traceback (most recent call last):',
         '  File "/srv/app/cart/total.py", line 8, in total',
         '',
         CAUSE,
         '',
         ...pyBlock('/srv/app/cart/api.py', 20, 'ValueError: bad qty'),
       ].join('\n');
       const t = parseTrace(text)!;
       expect(t).not.toHaveProperty('chain');
       expect(t.errorType).toBe('ValueError');
       expect(t.frames.map((f) => f.line)).toEqual([20, 8]);
     });

     it('adds no chain key to an unchained trace', () => {
       expect(parseTrace(V8_TRACE)).not.toHaveProperty('chain');
       expect(parseTrace(PY_TRACE)).not.toHaveProperty('chain');
     });
   });
   ```

2. Run `npx vitest run test/judomaster-parse.test.ts` — the new cases fail (`{`
   frame dropped, no `chain`).
3. In `types.ts` add above `ParsedTrace`:

   ```ts
   /**
    * One cause in an exception chain (#1138). `start` indexes the flat,
    * innermost-first `frames` list where this error's frames begin.
    */
   export interface ChainLink {
     errorType: string;
     message: string;
     relation: 'cause' | 'context';
     start: number;
   }
   ```

   add to `ParsedTrace`:
   `/** Outward-in: [0] caused the reported error, the last is the root cause. Absent when unchained. */ chain?: ChainLink[];`
   and to `RegressionBrief` (after `frames`):
   `chain?: (ChainLink & { suspect: ResolvedFrame | null })[];`

4. In `parse.ts`:
   - `V8_FRAME = /^\s*at (?:(.+?) \()?(?:file:\/\/)?(.+?):(\d+):(\d+)\)?(?: \{)?$/;`
     (V8 ends the last wrapper frame with `{` when the error has a cause.)
   - add constants:

     ```ts
     const V8_CAUSE = /^\s*\[cause\]:\s*(.+)$/;
     const PY_RELATION = new Map<string, ChainLink['relation']>([
       [
         'The above exception was the direct cause of the following exception:',
         'cause',
       ],
       [
         'During handling of the above exception, another exception occurred:',
         'context',
       ],
     ]);
     ```

   - helpers:

     ```ts
     function withChain(trace: ParsedTrace | null, chain: ChainLink[]) {
       return trace === null || chain.length === 0
         ? trace
         : { ...trace, chain };
     }

     /** V8 prints `[cause]: <ErrorLine>` then the cause's own frames. */
     function v8Chain(
       lines: string[],
       frames: Located<RawFrame>[],
     ): ChainLink[] {
       const causes = locate(lines, (line) => {
         const m = V8_CAUSE.exec(line);
         return m === null ? null : errorLine(m[1]!);
       });
       return causes.map(({ at, value }) => ({
         errorType: value[1]!,
         message: (value[2] ?? '').trim(),
         relation: 'cause' as const,
         start: frames.filter((f) => f.at < at).length,
       }));
     }
     ```

     `parseV8` returns `withChain(assemble(...), v8Chain(lines, frames))`.

   - CPython: rename today's `parsePython` body to
     `parsePyBlock(lines): ParsedTrace | null` but make the error search work
     for a frameless block (`const last = frames[frames.length - 1]?.at ?? -1;`)
     and keep the `assemble` frames>0 rule only for the flat path:

     ```ts
     function pyBlock(lines: string[]): ParsedTrace | null {
       const frames = locate(lines, pyFrame);
       const last = frames[frames.length - 1]?.at ?? -1;
       const error = locate(lines, errorLine).find((e) => e.at > last)?.value;
       if (error === undefined) return null;
       const inner = frames.map((f) => f.value).reverse();
       return {
         format: 'python',
         errorType: error[1]!,
         message: (error[2] ?? '').trim(),
         frames: inner,
       };
     }

     function splitPyBlocks(lines: string[]) {
       const blocks: string[][] = [[]];
       const relations: ChainLink['relation'][] = [];
       for (const line of lines) {
         const relation = PY_RELATION.get(line.trim());
         if (relation === undefined) blocks[blocks.length - 1]!.push(line);
         else (relations.push(relation), blocks.push([]));
       }
       return { blocks, relations };
     }

     /**
      * CPython prints the root cause first and the reported error last, each
      * block outermost frame first; the flat innermost-first list is the
      * blocks reversed with each block reversed (today's global reverse).
      * Any block without an error line drops the chain (null).
      */
     function pyChained(lines: string[]): ParsedTrace | null {
       const { blocks, relations } = splitPyBlocks(lines);
       if (relations.length === 0) return null;
       const parsed = blocks.map(pyBlock);
       if (parsed.some((b) => b === null)) return null;
       const outward = (parsed as ParsedTrace[]).reverse();
       const frames = outward.flatMap((b) => b.frames);
       if (frames.length === 0) return null;
       const chain: ChainLink[] = [];
       let start = outward[0]!.frames.length;
       for (let i = 1; i < outward.length; i++) {
         const { errorType, message } = outward[i]!;
         const relation = relations[relations.length - i]!;
         chain.push({ errorType, message, relation, start });
         start += outward[i]!.frames.length;
       }
       return { ...outward[0]!, frames, chain };
     }
     ```

     (Replace `else (a, b)` with a braced `else { ... }` if prettier or lint
     prefers.) `parsePython(lines)` becomes
     `return pyChained(lines) ?? parsePythonFlat(lines);` where
     `parsePythonFlat` is today's body unchanged (so the fallback is
     byte-identical). Import `ChainLink` in the type import.
5. Run
   `npx vitest run test/judomaster-parse.test.ts test/judomaster-review.test.ts`
   — green. `wc -l src/analysis/judomaster/parse.ts` < 300.
6. Run `harness validate`.
7. Commit: `feat(judomaster): parse V8 and CPython exception-chain boundaries`

### Task 8: chain in the brief and its markdown

**Depends on:** Task 7 | **Files:** `ts/src/analysis/judomaster/brief.ts`,
`ts/src/analysis/judomaster/render.ts`, `ts/test/judomaster-brief.test.ts`,
`ts/test/judomaster-render.test.ts`

1. Append to `ts/test/judomaster-brief.test.ts`:

   ```ts
   describe('buildBrief: exception chain', () => {
     const QTY = "Cannot read properties of undefined (reading 'qty')";
     const trace: ParsedTrace = {
       format: 'v8',
       errorType: 'Error',
       message: 'checkout failed',
       frames: [
         { file: '/app/src/cart/checkout.ts', line: 30 },
         { file: '/app/src/cart/total.ts', line: 12 },
       ],
       chain: [
         { errorType: 'TypeError', message: QTY, relation: 'cause', start: 1 },
       ],
     };
     const frames: ResolvedFrame[] = [
       {
         ...trace.frames[0]!,
         status: 'resolved',
         path: 'src/cart/checkout.ts',
       },
       { ...trace.frames[1]!, status: 'resolved', path: 'src/cart/total.ts' },
     ];

     it('keeps the reported suspect and signature, and gives each link its own suspect', () => {
       const b = buildBrief(trace, frames);
       expect(b.suspect!.path).toBe('src/cart/checkout.ts');
       expect(b.signature.text).toBe('checkout failed');
       expect(b.chain![0]!.suspect!.path).toBe('src/cart/total.ts');
     });

     it('names the root cause and where it was raised in the requirement', () => {
       expect(buildBrief(trace, frames).requirement).toContain(
         `The reported Error wraps a root cause, TypeError: ${QTY} at src/cart/total.ts:12; exercise the code path that raises it.`,
       );
     });

     it('adds no chain key for an unchained trace', () => {
       const { chain: _drop, ...flat } = trace;
       expect(buildBrief(flat, frames)).not.toHaveProperty('chain');
     });
   });
   ```

   (Import `ParsedTrace`, `ResolvedFrame` types if not already imported.) Append
   to `ts/test/judomaster-render.test.ts`:

   ```ts
   describe('renderBrief: exception chain', () => {
     const chained: RegressionBrief = {
       ...BRIEF,
       errorType: 'Error',
       message: 'checkout failed',
       chain: [
         {
           errorType: 'RangeError',
           message: 'mid',
           relation: 'context',
           start: 1,
           suspect: null,
         },
         {
           errorType: 'TypeError',
           message: 'qty',
           relation: 'cause',
           start: 2,
           suspect: BRIEF.frames[1]!,
         },
       ],
     };

     it('lists the chain reported first with the root cause marked', () => {
       const md = renderBrief(chained);
       expect(md).toContain('## Exception chain (reported first)');
       expect(md).toContain('1. Error: checkout failed (reported)');
       expect(md).toContain('2. while handling RangeError: mid');
       expect(md).toContain(
         '3. caused by TypeError: qty at `src/cart/total.ts:12` (root cause)',
       );
     });

     it('marks each boundary in the frame list before the link start frame', () => {
       const lines = renderBrief(chained).split('\n');
       const at = lines.indexOf('- --- while handling RangeError: mid ---');
       expect(at).toBeGreaterThan(lines.indexOf('## Frames (innermost first)'));
       expect(lines[at + 1]).toContain('src/cart/total.ts:12');
     });

     it('leaves an unchained brief unchanged', () => {
       const md = renderBrief(BRIEF);
       expect(md).not.toContain('Exception chain');
       expect(md).not.toContain('- ---');
     });
   });
   ```

   (If `BRIEF.frames` has fewer than 3 entries, the `start: 2` boundary is
   simply not printed; the assertions above do not depend on it.)

2. Run
   `npx vitest run test/judomaster-brief.test.ts test/judomaster-render.test.ts`
   — new cases fail.
3. In `brief.ts`:

   ```ts
   type BriefChain = NonNullable<RegressionBrief['chain']>;

   /** Each link's own first in-repo frame, within its slice of `frames`. */
   function chainOf(
     trace: ParsedTrace,
     frames: ResolvedFrame[],
   ): BriefChain | undefined {
     const chain = trace.chain;
     if (chain === undefined || chain.length === 0) return undefined;
     return chain.map((link, i) => {
       const end = chain[i + 1]?.start ?? frames.length;
       return { ...link, suspect: pickSuspect(frames.slice(link.start, end)) };
     });
   }

   function rootCauseSentence(errorType: string, chain: BriefChain): string {
     const root = chain[chain.length - 1]!;
     const s = root.suspect;
     const at = s === null ? '' : ` at ${s.path}:${s.line}`;
     return `The reported ${errorType} wraps a root cause, ${root.errorType}: ${root.message}${at}; exercise the code path that raises it.`;
   }
   ```

   In `requirementFor`, push `rootCauseSentence(brief.errorType, brief.chain)`
   onto the array when `brief.chain !== undefined`. In `buildBrief`, compute
   `const chain = chainOf(trace, frames);` and add
   `...(chain === undefined ? {} : { chain }),` right after `frames` in
   `partial` (so unchained JSON keeps today's key set and order).

4. In `render.ts`:

   ```ts
   type Link = NonNullable<RegressionBrief['chain']>[number];
   const relationWord = (l: Link) =>
     l.relation === 'cause' ? 'caused by' : 'while handling';

   function chainBlock(brief: RegressionBrief): string[] {
     const chain = brief.chain;
     if (chain === undefined) return [];
     const links = chain.map((l, i) => {
       const at = l.suspect === null ? '' : ` at \`${where(l.suspect)}\``;
       const root = i === chain.length - 1 ? ' (root cause)' : '';
       return `${i + 2}. ${relationWord(l)} ${l.errorType}: ${l.message}${at}${root}`;
     });
     return [
       '',
       '## Exception chain (reported first)',
       '',
       `1. ${brief.errorType}: ${brief.message} (reported)`,
       ...links,
     ];
   }
   ```

   Change `frameLines` to take the brief and prefix boundaries:

   ```ts
   function frameLines(brief: RegressionBrief): string[] {
     return brief.frames.flatMap((f, i) => {
       const marks = (brief.chain ?? [])
         .filter((l) => l.start === i)
         .map(
           (l) => `- --- ${relationWord(l)} ${l.errorType}: ${l.message} ---`,
         );
       const fn = f.fn === undefined ? '' : ` in \`${f.fn}\``;
       return [...marks, `- \`${where(f)}\`${fn}: ${f.status}`];
     });
   }
   ```

   In `renderBrief`, add `...chainBlock(brief),` after `...excerptBlock(brief),`
   and call `frameLines(brief)`.

5. Run
   `npx vitest run test/judomaster-brief.test.ts test/judomaster-render.test.ts test/judomaster-cli.test.ts`
   — green (CLI brief tests prove unchained output unchanged).
6. Run `harness validate`.
7. Commit:
   `feat(judomaster): list the exception chain and root cause in the brief`

### Task 9: docs — SKILL.md, guide, CHANGELOG

**Depends on:** Tasks 1-8 | **Files:**
`agents/skills/claude-code/canary-judomaster/SKILL.md`,
`docs/guides/incident-to-regression-test.md`, `CHANGELOG.md` | **Category:**
integration

1. Guide, section `## 4. Verify it` (lines ~72-77): replace the paragraph
   beginning "The framework comes from `--framework`" with:

   > The framework comes from `--framework`, then the brief, then the extension:
   > `.py` is pytest, `.spec.*` or `.e2e.*` is Playwright, and other
   > `.ts/.js/.mts/.mjs` files are Vitest. The run goes through canary's
   > framework registry and test executor with its working directory set to
   > `--root` (default: the current directory), so the runner finds the
   > project's config there. `verify` never downloads a runner: the registry's
   > `npx --yes ...` runs as `npx --no ...`, and when the runner is not
   > installed under the root the verdict is `unverified — could not reproduce`
   > (exit 3), naming the runner to install.

   Add after the "The signature has to come from the code under test" paragraph:

   > A test that mocks the suspect module (`vi.mock`/`jest.mock` of its path, or
   > `patch`/`mock.patch`/`mocker.patch`/`monkeypatch` of a target inside it)
   > cannot exercise the defect. With `--brief`, `verify` prints a `WARNING:`
   > line naming the mock and the suspect (and `warnings` in `--json`). The
   > verdict and exit code do not change. Run `verify` with the same `--root`
   > the brief was built against, since the suspect path is relative to it.

   In `## 2. Build the brief`, after the paragraph listing what the brief names,
   add:

   > A chained exception (V8 `[cause]:`, CPython "The above exception was the
   > direct cause..." or "During handling of the above exception...") keeps the
   > reported, outermost error as the signature and suspect. The brief adds an
   > `Exception chain (reported first)` section with the root cause marked,
   > boundary lines in the frame list, and a requirement sentence naming the
   > root cause and where it was raised (`chain` in the JSON).

2. SKILL.md: in step 1 INTAKE add one sentence: "For a chained exception the
   brief lists the chain with the root cause marked; the signature stays on the
   reported error." In step 3 VERIFY, after the refuse sentence add: "`verify`
   runs the runner from `--root` and never downloads it (`npx --no`); a missing
   runner is `unverified — could not reproduce`. A `WARNING:` line means the
   test mocks the suspect module: rewrite it to call the real code, even if the
   verdict is `reproduced`." Add a Rationalizations row:
   `| "Mock the suspect so the test is deterministic." | A test that mocks the code it should exercise cannot reproduce the defect; verify warns. |`
3. CHANGELOG.md, under `## [Unreleased]` → `### Changed` (line ~171), add a
   bullet with a headline distinct from the #614 one (changelog-hygiene test):

   ```markdown
   - **canary-judomaster: exception chains, runner cwd, no runner fetch, mock
     warning** (Refs #1138). `canary judomaster brief` lists a chained exception
     (V8 `[cause]:`, CPython `raise ... from` and "During handling") with the
     root cause marked and named in the requirement; the signature and suspect
     stay on the reported error, and an unchained brief is unchanged. `verify`
     runs the runner from `--root` and with `npx --no` instead of `npx --yes`,
     so a runner the project lacks is `unverified — could not reproduce`
     (exit 3) naming it, never downloaded. With `--brief`, a test that mocks the
     suspect module prints a `WARNING:` (verdict unchanged). Frame and
     `tests/generated` containment use `path.relative`, so `--root /` resolves
     frames.
   ```

4. Run `npx prettier --write` on the three files, then from `ts/`:
   `npx vitest run test/changelog-hygiene.test.ts` and any doc/skill tests
   (`npx vitest run test/ -t "skill"` if the skill-surface tests exist) — green.
5. Run `harness validate` and `harness check-docs --json --min-coverage 0`.
6. Commit:
   `docs(judomaster): document chain, root cwd, no-fetch and mock warning`

### Task 10: gates and ratchets

**Depends on:** Task 9 | **Files:** (conditional)
`.harness/arch/allowances/feat-1138-judomaster-review-followups.json`

1. From `/Users/bs/Github/canary-1138/ts`: `npm run build`, `npm run typecheck`,
   `npm run format:check`, `npm test`. Check each exit code directly (no pipe)
   and that the test count is non-zero.
2. From the repo root: `harness validate`, `harness check-deps`,
   `harness check-perf` (delta must not grow; every judomaster file < 300 lines:
   `wc -l ts/src/analysis/judomaster/*.ts ts/src/judomaster/*.ts ts/src/core/executor.ts`),
   `harness cleanup --findings-json <scratch>` (no new dead exports: `isWithin`,
   `mockedSuspectWarnings`, `ChainLink` each have an importer), entropy count
   unchanged (no new modules).
3. `harness check-arch --json` in this worktree and in a detached worktree of
   the merge base (`git merge-base HEAD origin/main`). If only `module-size`
   regressed, create the allowance file, modelled on
   `.harness/arch/allowances/feat-614-canary-judomaster.json`:

   ```json
   {
     "reason": "canary-judomaster review follow-ups (#1138, docs/changes/1138-judomaster-review-followups/proposal.md): module-size <base>-><measured> (+N) at merge base <sha>, measured with `harness check-arch --json` on this branch and a detached worktree of the merge base. Growth is the feature, inside existing modules only (no new source files): isWithin + mock detection in resolve.ts, chain parsing in parse.ts, chain brief/render, the executor cwd/no-fetch option, verify wiring. newViolations is [].",
     "categories": { "module-size": <measured> },
     "violationIds": [],
     "createdFrom": "<merge-base short sha>"
   }
   ```

   Any other regressed category is a stop-and-report, not an allowance.

4. Run `harness validate`.
5. Commit (only if the allowance was created):
   `chore(arch): module-size allowance for judomaster follow-ups`

## Traceability

| Truth | Tasks |
| ----- | ----- |
| 1, 2  | 1     |
| 3, 4  | 2     |
| 5     | 3     |
| 6     | 4     |
| 7     | 5     |
| 8     | 6     |
| 9, 10 | 7, 8  |
| 11    | 8     |
| 12    | 9     |
| 13    | 10    |

## Parallelism

Tasks 1, 2, 3 and 7 have no dependencies on each other but 1 and 3 both edit
`verify.ts`, and 1 and 5 both edit `resolve.ts`; run sequentially in the order
above (the spec's Implementation Order) to avoid conflicts.
