# Plan: No Silent Abstention — Wave 2 (Guardian)

**Date:** 2026-07-31 | **Spec:** `docs/changes/no-silent-abstention/proposal.md`
(Implementation Order item 2; audit rows 3-4) | **Issue:** #508 (+ the #456
defect class) | **Tasks:** 12 | **Time:** ~45 min | **Integration Tier:** medium
(doctrine docs / CHANGELOG / workflow templates are Wave 5 by design, D6)

**Branch:** `feat/abstention-wave2-guardian`, based on `origin/main`. Wave 1
merged in v6.4.0 (PR #518), so `main` already carries `gate-result.ts`. Baseline
on `main` as of v6.4.0: **1671 tests** (1657 at Wave 1's tip, plus PR #514's
overlay-parser regression tests).

## Goal

Guardian `pr-check` and `harden-gate` exit `EXIT_ABSTAINED` (3) loudly when
their denominator collapses to zero; `analyze` and `validate-coverage` warn
unmissably (advisory, exit unchanged) — all through the Wave 1 `gateOutcome`
helper, with conformance-registry rows proving each loud outcome through the
real CLI, and every non-zero-denominator path byte-identical.

## Observable Truths (Acceptance Criteria)

1. **[Event-driven]** When `guardian pr-check` scopes zero findings-eligible
   units (empty diff, or every unit consumed by skipGlobs / test-path / barrel /
   heuristic-noise filters) and there are zero findings, the system shall print
   the `gateOutcome` abstention line (skipped paths visible, D7) plus
   remediation and exit 3 — never `nothing to verify` + exit 0. (SC4, the #456
   class, with a permanent negative fixture.)
2. **[Ubiquitous]** `pr-check --format json` payloads shall carry `checked`
   (findings-eligible units that received a coverage verdict:
   `scoredResults.length`) and `abstained`, additively; the emitted analysis
   record envelope shall carry the same two fields additively.
3. **[Event-driven]** When `guardian harden-gate --apply` (without `--force`)
   observes zero reported check contexts on the branch — its eligible
   verification population — the system shall exit 3 with the abstention line
   and the manual playbook, distinct from real blockers (exit 1).
4. **[Event-driven]** When `guardian analyze`'s spec diff contains zero
   endpoints (`added + removed + changed === 0`), the system shall print an
   unmissable abstention warning, `--json` shall carry
   `checked: 0, abstained: true` (additive), and the exit code shall remain 0.
5. **[Event-driven]** When `guardian validate-coverage` reads a valid document
   with zero `files` entries, the system shall not print
   `valid coverage-json document`; it shall print the abstention line +
   remediation, `--json` shall carry `checked`/`abstained` additively, and exits
   shall remain unchanged (0 clean / 1 errors-or-strict-warnings / 2
   unreadable).
6. **[Ubiquitous]** `ts/test/gate-conformance.test.ts` shall contain one
   registry row per surface (4 new rows), each collapsing the denominator
   through the real CLI (guardian testkit) and asserting the loud outcome +
   forbidden success copy.
7. **[Unwanted]** If the denominator is non-zero, then the system shall not
   change any existing output byte or exit code — the full guardian suites pass
   with only the pins that asserted silent success updated (spec SC5).
8. **[Ubiquitous]** Full suite (1671 baseline + new tests), `tsc --noEmit`, and
   the prettier gate shall be green at the wave boundary (D6).

## Uncertainties

- **[DECISION]** A docs-only / all-skipped PR now exits 3 from `pr-check` in CI.
  This is D1 ("a consumer seeing a new exit 3 is the doctrine working");
  workflow templates that consume the exit code are updated in Wave 5 with
  version bumps. Recorded as a known consequence, not a bug.
- **[DECISION]** `pr.enabled: false` + `--post-comment` keeps its exit-0 skip:
  an explicit operator disable with a printed notice is not _silent_ abstention.
  Same for `harden-gate` dry-run (no `--apply`) — it claims to verify nothing
  and exits 0.
- **[DECISION]** An abstained `pr-check` exits before `--emit-analysis`
  (matching today's early-exit shape: no record was written on the
  nothing-to-verify path either). The `checked`/`abstained` envelope fields ride
  the normal path. Revisit in Wave 5 if the harness consumer wants abstention
  records. **[DEFERRABLE]**
- **[DECISION]** `validate-coverage --strict` does not escalate the abstention
  (spec audit row classifies it advisory; strict-inherits-exit-3 is the
  skill-CLI convention scoped to Wave 4).
- **[DECISION]** Analysis-record fields are additive under `schemaVersion` "1.0"
  — the #503 precedent (additive `checked`/`abstained`) applies; harness's
  consumer reads known fields only.
- **[RESOLVED 2026-08-02]** The baseline assumption is settled: `main` at v6.4.0
  runs **1671** tests (verified, 82 files). The hand-off's 1657 was Wave 1's own
  tip; PR #514 landed after it. Task 12 expects 1671 + new tests.

## File Map

- MODIFY `ts/src/guardian/pr-check.ts` (render json gains optional gate meta)
- MODIFY `ts/src/guardian/cli.ts` (pr-check abstention, harden-gate catch,
  analyze + validate-coverage advisory warnings)
- MODIFY `ts/src/guardian/hard-gate.ts` (`HardGateAbstained` subclass)
- MODIFY `ts/src/guardian/analysis-emit.ts` (envelope `checked`/`abstained`)
- MODIFY `ts/test/guardian-pr-check.test.ts` (render meta tests)
- MODIFY `ts/test/guardian-cli.test.ts` (abstention tests + 4 pin updates,
  analyze abstention tests)
- MODIFY `ts/test/guardian-heuristic-source-gate.test.ts` (2 pin updates)
- MODIFY `ts/test/guardian-pr-check-ci-diff.test.ts` (3 pin updates)
- MODIFY `ts/test/guardian-hard-gate.test.ts` (abstained-subclass test)
- MODIFY `ts/test/guardian-harden-gate-cli.test.ts` (exit-3 CLI test)
- MODIFY `ts/test/guardian-analysis-emit.test.ts` (envelope field tests)
- MODIFY `ts/test/guardian-validate-coverage-cli.test.ts` (abstention tests)
- MODIFY `ts/test/gate-conformance.test.ts` (run-seam refactor + 4 rows)
- CREATE `docs/changes/no-silent-abstention/plans/wave2-guardian.md` (this file,
  committed in Task 1)

No new files in `ts/src` — the helper (`ts/src/core/gate-result.ts`) shipped in
Wave 1 and is imported as-is. `ts/test/guardian-cli-testkit.ts` is reused
unchanged (it already injects deps/cwd/stdin and returns `{code, stdout}`).

## Skeleton

1. Branch + plan commit (~1 task, ~2 min)
2. pr-check gate: render meta, abstention + pins, json payload, analysis record
   (~4 tasks, ~16 min)
3. harden-gate gate: lib subclass, CLI exit 3 (~2 tasks, ~7 min)
4. analyze + validate-coverage advisory (~2 tasks, ~8 min)
5. Conformance harness refactor + 4 registry rows (~2 tasks, ~8 min)
6. Wave boundary gate: full suite + tsc + prettier (~1 task, ~4 min)

_Skeleton approved: implicitly, via the delegated Wave 2 scope brief (surfaces,
semantics, and constraints were fully specified by the requester)._

## Conventions (apply to every task)

- Working dir for all verification commands: `/Users/bs/Github/canary/ts`.
- Strict TDD: write the test, run it and observe the failure, implement, run it
  green, then commit.
- ASCII source: any emitted non-ASCII glyph is written as a `\u{...}` escape
  (the existing `EM_DASH`/`WARN` pattern; `gateOutcome`'s summary line already
  carries U+26A0/U+2014 for you).
- Before each commit: `npx prettier --write <touched files>` then re-stage.
- Conventional commits referencing #508 (Task 3 also cites #456). **No co-author
  trailer.**
- Behavior preservation: never touch an output byte or exit code on a path whose
  denominator is non-zero.

---

## Tasks

### Task 1: Create the Wave 2 branch and commit this plan

**Depends on:** none | **Files:**
`docs/changes/no-silent-abstention/plans/wave2-guardian.md`

1. Branch off `main` — Wave 1 merged in v6.4.0 (PR #518) and its branch is gone,
   so `main` already carries `gate-result.ts`:

   ```bash
   git fetch origin
   git worktree add -b feat/abstention-wave2-guardian <path> origin/main
   ```

2. `npx prettier --write docs/changes/no-silent-abstention/plans/wave2-guardian.md`
3. Commit the plan:

   ```bash
   git add docs/changes/no-silent-abstention/plans/wave2-guardian.md
   git commit -m "docs(no-silent-abstention): add wave 2 guardian plan (#508)"
   ```

### Task 2: `render` json accepts additive gate meta (TDD)

**Depends on:** Task 1 | **Files:** `ts/src/guardian/pr-check.ts`,
`ts/test/guardian-pr-check.test.ts`

1. Add to `ts/test/guardian-pr-check.test.ts` (in/next to the existing `render`
   describe):

   ```ts
   describe('render json gate meta (#508)', () => {
     it('adds checked/abstained when meta is provided', () => {
       const out = JSON.parse(
         render([], 'json', 0, null, { checked: 3, abstained: false }),
       );
       expect(out.checked).toBe(3);
       expect(out.abstained).toBe(false);
       expect(out.findings).toEqual([]);
     });

     it('omits the fields when meta is absent (byte-stable for emit)', () => {
       const out = JSON.parse(render([], 'json'));
       expect('checked' in out).toBe(false);
       expect('abstained' in out).toBe(false);
     });
   });
   ```

2. `npx vitest run test/guardian-pr-check.test.ts` — observe the two failures
   (extra argument rejected / fields absent).
3. In `ts/src/guardian/pr-check.ts`, extend `render`:

   ```ts
   /** Additive gate denominator for the json format (#508). */
   export interface GateMeta {
     checked: number;
     abstained: boolean;
   }

   export function render(
     findings: Finding[],
     fmt: string,
     tier = 0,
     degradedNotice: string | null = null,
     gateMeta: GateMeta | null = null,
   ): string {
   ```

   and in the `fmt === 'json'` branch, after the `degraded_notice` line:

   ```ts
   if (gateMeta !== null) {
     payload['checked'] = gateMeta.checked;
     payload['abstained'] = gateMeta.abstained;
   }
   ```

   `comment`/`text` branches ignore the meta. With `gateMeta` omitted the
   payload is byte-identical, so `emitAnalysis`'s inner `render` call and every
   existing json assertion are untouched.

4. `npx vitest run test/guardian-pr-check.test.ts` — green.
5. `npx vitest run test/guardian-analysis-emit.test.ts test/guardian-cli.test.ts`
   — green (byte-stability spot check).
6. `harness validate`
7. Commit:
   `feat(guardian): render json accepts additive checked/abstained meta (#508)`

### Task 3: `pr-check` abstains (exit 3) on zero findings-eligible units

**Depends on:** Task 1 | **Files:** `ts/src/guardian/cli.ts`,
`ts/test/guardian-cli.test.ts`,
`ts/test/guardian-heuristic-source-gate.test.ts`,
`ts/test/guardian-pr-check-ci-diff.test.ts`

> Exceeds the 3-file heuristic deliberately: the behavior flip and the nine test
> pins that asserted silent success (spec SC5 explicitly licenses updating
> those) must land in ONE commit or the suite is red mid-history. The pin edits
> are mechanical one-line expectation flips.

1. **New tests first** — add to `ts/test/guardian-cli.test.ts` inside the
   pr-check describe:

   ```ts
   it('empty diff can never render as a pass (#456 permanent fixture)', async () => {
     const res = await invokeGuardian(['pr-check', '--diff', '-'], {
       input: '',
       cwd: tmp,
     });
     expect(res.code).toBe(3); // EXIT_ABSTAINED, reserved CLI-wide (D4)
     expect(res.stdout.toLowerCase()).toContain('abstained');
     expect(res.stdout).not.toContain('nothing to verify');
     expect(res.stdout).not.toContain('no test-coverage gaps');
   });

   it('abstention names the skipped paths (D7)', async () => {
     const res = await invokeGuardian(
       [
         'pr-check',
         '--diff',
         '-',
         '--config',
         writeConfig({ skipGlobs: ['docs/**'] }),
       ],
       { input: DIFF_DOCS_ONLY, cwd: tmp },
     );
     expect(res.code).toBe(3);
     expect(res.stdout).toContain('(1 skipped');
     expect(res.stdout).toContain('docs/'); // the path is visible, not a bare count
   });
   ```

2. `npx vitest run test/guardian-cli.test.ts` — observe both fail (exit 0,
   `nothing to verify`).
3. **Implement** in `ts/src/guardian/cli.ts`:
   - Add import (alphabetical among the `../core/` imports):

     ```ts
     import { gateOutcome, SkipEntry } from '../core/gate-result.js';
     ```

   - Replace the `nothingToVerify` helper (delete it — nothing else uses it)
     with:

     ```ts
     // D7: every filtered path stays visible as a SkipEntry, never folded
     // into "passed". One entry per path so the rendered count still equals
     // the path count the old `N path(s) skipped` line reported.
     function prCheckSkipEntries(
       skipped: ChangedUnit[],
       testUnits: ChangedUnit[],
       barrelUnits: ChangedUnit[],
       noisePaths: string[] = [],
     ): SkipEntry[] {
       return [
         ...skipped.map((u) => ({ name: u.path, reason: 'skipGlobs' })),
         ...testUnits.map((u) => ({ name: u.path, reason: 'test path' })),
         ...barrelUnits.map((u) => ({
           name: u.path,
           reason: 're-export barrel',
         })),
         ...noisePaths.map((p) => ({
           name: p,
           reason: 'heuristic-ineligible',
         })),
       ];
     }

     // Remediation is required copy (#508): say WHY the denominator
     // collapsed and the first fix step. The #456 class, now loud.
     const PR_CHECK_ABSTAIN_REMEDIATION = [
       'guardian: the diff contained no findings-eligible units, so NO ' +
         'coverage was verified. This is not a pass (exit 3, abstained).',
       'If you expected verification: in CI, checkout with fetch-depth: 0 ' +
         'or pass --diff <base>...HEAD; locally, confirm the diff is ' +
         'non-empty and skipGlobs/heuristicExclude are not filtering ' +
         'every path.',
     ];

     /** Exit 3 with the structural abstention line + remediation (#508). */
     function abstainPrCheck(
       skipped: SkipEntry[],
       format: string,
       deps: GuardianDeps,
     ): never {
       const outcome = gateOutcome(
         { checked: 0, findings: [], skipped },
         'gate',
         { noun: 'unit(s)' },
       );
       deps.out(outcome.summaryLine);
       for (const line of PR_CHECK_ABSTAIN_REMEDIATION) deps.out(line);
       throw new CliExit(outcome.exitCode); // EXIT_ABSTAINED
     }
     ```

     Note `ChangedUnit` needs importing into cli.ts from `./coverage.js` if not
     already in scope (it is exported there).

   - Replace the first early exit in `prCheckCmd`:

     ```ts
     if (kept.length === 0 && weakFindings.length === 0) {
       abstainPrCheck(
         prCheckSkipEntries(skipped, testUnits, barrelUnits),
         opts.format,
         deps,
       );
     }
     ```

   - Replace the second (post-heuristic-filter) early exit:

     ```ts
     if (scoredResults.length === 0 && findings.length === 0) {
       abstainPrCheck(
         prCheckSkipEntries(
           skipped,
           testUnits,
           barrelUnits,
           noiseResults.map((r) => r.unit.path),
         ),
         opts.format,
         deps,
       );
     }
     ```

   - Leave `warnIfEmptyCiDiff` (the `::warning::` + step-summary annotation)
     untouched — it fires _before_ the abstention and remains accurate; and
     leave the `pr.enabled === false` exit-0 skip untouched (explicit disable,
     see Uncertainties).

4. **Update the nine stale pins** (each asserted silent success on a zero
   denominator):
   - `ts/test/guardian-cli.test.ts`
     - `docs-only skips and posts nothing` (~line 376):
       `expect(res.code).toBe(3);`, replace the `nothing to verify` assertion
       with `expect(res.stdout.toLowerCase()).toContain('abstained');` — keep
       `expect(fake.comments).toEqual([]);` (still nothing posted).
     - `lockfile-only skips by default` (~404): same flip (code 3 +
       'abstained').
     - `empty skipGlobs still cannot force a heuristic finding on a lockfile`
       (~434): same flip.
     - `barrel index.ts is not flagged` (~443): same flip.
   - `ts/test/guardian-heuristic-source-gate.test.ts`
     - `counts a suppressed heuristic path as skipped, not verified` (~265):
       code 3, 'abstained', and replace `1 path(s) skipped` with `'(1 skipped'`
       (the D7 suffix keeps the count visible).
     - `--heuristic-exclude suppresses an ad-hoc source path` (~287): code 3,
       'abstained', `'(2 skipped'`.
   - `ts/test/guardian-pr-check-ci-diff.test.ts`
     - `warns loudly on an empty auto-resolved diff in CI` (~218): code 3; keep
       the `::warning::` and stderr assertions (the #369 annotation still
       fires); add `expect(res.stdout.toLowerCase()).toContain('abstained');`.
     - `stays silent on an empty diff outside CI` (~236): rename to
       `abstains loudly on an empty diff outside CI (#508)`; code 3,
       'abstained', keep `not.toContain('::warning::')` (the CI annotation stays
       CI-only) and drop the empty-stderr pin if remediation writes there (it
       does not — stdout only).
     - `does not warn when an explicit --diff is empty` (~249): code 3, keep
       `not.toContain('::warning::')`, add 'abstained'.
5. Re-run the touched suites — all green:

   ```bash
   npx vitest run test/guardian-cli.test.ts \
     test/guardian-heuristic-source-gate.test.ts \
     test/guardian-pr-check-ci-diff.test.ts
   ```

6. `npx vitest run` (guardian suites contain more pr-check consumers — fidelity,
   loop-guard, delta; confirm nothing else pinned the old copy) and
   `harness validate`.
7. Commit:

   ```text
   feat(guardian): pr-check exits 3 abstained on zero findings-eligible units (#456, #508)
   ```

### Task 4: `pr-check --format json` carries checked/abstained

**Depends on:** Tasks 2, 3 | **Files:** `ts/src/guardian/cli.ts`,
`ts/test/guardian-cli.test.ts`

1. Tests first (guardian-cli.test.ts, pr-check describe):

   ```ts
   it('json output carries checked and abstained (#508)', async () => {
     mkdirSync(join(tmp, 'agent', 'core'), { recursive: true });
     writeFileSync(
       join(tmp, 'agent', 'core', 'foo.py'),
       'def foo():\n    return 1\n',
       'utf-8',
     );
     const res = await invokeGuardian(
       ['pr-check', '--diff', '-', '--format', 'json', '--gate', 'soft'],
       { input: DIFF_SRC_AND_TEST, cwd: tmp },
     );
     expect(res.code).toBe(0);
     const data = JSON.parse(res.stdout);
     expect(data.abstained).toBe(false);
     expect(data.checked).toBeGreaterThan(0);
   });

   it('abstained json payload is machine-readable after the loud lines', async () => {
     const res = await invokeGuardian(
       ['pr-check', '--diff', '-', '--format', 'json'],
       { input: '', cwd: tmp },
     );
     expect(res.code).toBe(3);
     // Loud lines print first; parse from the first brace (the analyze
     // --json precedent in this suite).
     const data = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
     expect(data).toMatchObject({ findings: [], checked: 0, abstained: true });
   });
   ```

2. `npx vitest run test/guardian-cli.test.ts` — observe failures.
3. Implement in `cli.ts`:
   - In `abstainPrCheck`, after the remediation loop and before the `throw`:

     ```ts
     if (format === 'json') {
       deps.out(
         ensureAscii(
           JSON.stringify(
             { findings: [], tier: 0, checked: 0, abstained: true },
             null,
             2,
           ),
         ),
       );
     }
     ```

   - In `prCheckCmd`'s local render fallback (the
     `!opts.emitAnalysis && !opts.postComment` branch), thread the meta:

     ```ts
     deps.out(
       render(
         findings,
         opts.format,
         resolution.effective,
         resolution.degraded_notice,
         { checked: scoredResults.length, abstained: false },
       ),
     );
     ```

     (`comment`/`text` formats ignore the meta, so only the json bytes gain the
     two additive keys — existing json tests parse named fields and stay green.)
4. `npx vitest run test/guardian-cli.test.ts test/guardian-heuristic-source-gate.test.ts`
   — green.
5. `harness validate`
6. Commit:
   `feat(guardian): pr-check json carries checked/abstained additively (#508)`

### Task 5: Analysis record envelope carries checked/abstained

**Depends on:** Task 4 | **Files:** `ts/src/guardian/analysis-emit.ts`,
`ts/src/guardian/cli.ts`, `ts/test/guardian-analysis-emit.test.ts`

1. Test first (guardian-analysis-emit.test.ts, next to the existing
   `buildAnalysisRecord` tests — reuse that suite's args fixture):

   ```ts
   it('envelope carries checked/abstained additively (#508)', () => {
     const record = buildAnalysisRecord([], {
       ref: 'pr-1',
       gate: 'soft',
       effective_tier: 0,
       degraded_notice: null,
       exit_code: 0,
       checked: 4,
       abstained: false,
     });
     expect(record.checked).toBe(4);
     expect(record.abstained).toBe(false);
   });

   it('fields default when a caller predates #508', () => {
     const record = buildAnalysisRecord([], {
       ref: 'pr-1',
       gate: 'soft',
       effective_tier: 0,
       degraded_notice: null,
       exit_code: 0,
     });
     expect(record.checked).toBe(0);
     expect(record.abstained).toBe(false);
   });
   ```

2. `npx vitest run test/guardian-analysis-emit.test.ts` — observe failures.
3. Implement in `analysis-emit.ts`:
   - `AnalysisRecord`: add `checked: number;` and `abstained: boolean;` directly
     after `exitCode`.
   - `BuildAnalysisRecordArgs`: add optional `checked?: number;` and
     `abstained?: boolean;` (optional = additive; the schema stays "1.0" — see
     Uncertainties).
   - In `buildAnalysisRecord`'s returned literal, after `exitCode`:

     ```ts
     checked: args.checked ?? 0,
     abstained: args.abstained ?? false,
     ```

4. In `cli.ts`'s `prCheckCmd`, extend the `emitAnalysis(...)` args:

   ```ts
   checked: scoredResults.length,
   abstained: false, // an abstained run exits before emit (see plan)
   ```

5. `npx vitest run test/guardian-analysis-emit.test.ts test/guardian-cli.test.ts`
   — green.
6. `harness validate`
7. Commit:
   `feat(guardian): analysis record envelope carries checked/abstained (#508)`

### Task 6: `hard-gate` library distinguishes abstention from blockers

**Depends on:** Task 1 | **Files:** `ts/src/guardian/hard-gate.ts`,
`ts/test/guardian-hard-gate.test.ts`

The eligible population (read from the code): the check contexts a recent commit
actually reported (`observedCheckContexts`). Zero observed = the gate verified
`checkContext` against nothing = abstention. Context-not-among- observed,
permission, plan, and network failures verified a non-empty population and stay
`HardGateBlocked` (exit 1) byte-identically. `--force` skips verification
entirely and is untouched.

1. Test first (guardian-hard-gate.test.ts, in the applyHardGate describe):

   ```ts
   it('no observed checks is an ABSTENTION, not a generic blocker (#508)', async () => {
     const c = new FakeBranchProtectionClient({
       contexts: ['build'],
       observed: [],
     });
     await expect(
       applyHardGate(c, 'owner/repo', 'main', 'guardian'),
     ).rejects.toBeInstanceOf(HardGateAbstained);
     expect(c.write_count).toBe(0);
   });
   ```

   Add `HardGateAbstained` to the file's import list.

2. `npx vitest run test/guardian-hard-gate.test.ts` — observe the failure (no
   such export).
3. Implement in `hard-gate.ts`, directly below `HardGateBlocked`:

   ```ts
   /**
    * The verification population was EMPTY (#508): no check has ever
    * reported on the branch, so the context could not be verified against
    * anything. A subclass of {@link HardGateBlocked} so pre-#508 catch
    * sites keep working; the CLI maps it to EXIT_ABSTAINED (3), distinct
    * from real blockers (1).
    */
   export class HardGateAbstained extends HardGateBlocked {
     constructor(reason: string, playbook: string) {
       super(reason, playbook);
       this.name = 'HardGateAbstained';
     }
   }
   ```

   In `applyHardGate`, change ONLY the `observed.length === 0` throw from
   `blocked(...)` to:

   ```ts
   throw new HardGateAbstained(
     `could not confirm any check has reported on ${repo}@${branch}, ` +
       `so cannot verify '${checkContext}' is a real context; ` +
       'requiring an unreported check would block every merge. ' +
       'Open a PR so the guardian check runs at least once, or pass ' +
       '--force to register it anyway.',
     playbook,
   );
   ```

   (Reason text byte-identical to today's.)

4. `npx vitest run test/guardian-hard-gate.test.ts` — green, including the
   pre-existing `no observed checks is refused` test (the subclass still
   satisfies `toBeInstanceOf(HardGateBlocked)`).
5. `harness validate` + `harness check-deps`
6. Commit:
   `feat(guardian): hard-gate abstains distinctly when zero checks observed (#508)`

### Task 7: `harden-gate` CLI exits 3 on the abstention

**Depends on:** Tasks 3, 6 | **Files:** `ts/src/guardian/cli.ts`,
`ts/test/guardian-harden-gate-cli.test.ts`

1. Test first (guardian-harden-gate-cli.test.ts, next to
   `apply unverified context exits one`):

   ```ts
   it('apply with zero observed checks exits 3 abstained with playbook (#508)', async () => {
     const fake = new FakeBranchProtectionClient({
       contexts: ['build'],
       observed: [],
     });
     const res = await invokeGuardian(
       ['harden-gate', '--repo', 'o/r', '--apply', '--token', 'x'],
       { deps: { buildBranchProtectionClient: () => fake } },
     );
     expect(res.code).toBe(3);
     expect(res.stdout.toLowerCase()).toContain('abstained');
     expect(res.stdout).toContain('settings/branches'); // playbook still prints
     expect(fake.write_count).toBe(0);
   });
   ```

2. `npx vitest run test/guardian-harden-gate-cli.test.ts` — observe the failure
   (exit 1 today).
3. Implement in `cli.ts`:
   - Extend the hard-gate import: `HardGateAbstained` alongside
     `HardGateBlocked`.
   - In `hardenGateCmd`'s catch, insert the subclass arm BEFORE the
     `HardGateBlocked` arm (order is load-bearing — the subclass also instanceof
     the parent):

     ```ts
     if (exc instanceof HardGateAbstained) {
       const outcome = gateOutcome({ checked: 0, findings: [] }, 'gate', {
         noun: 'check context(s)',
       });
       deps.out(outcome.summaryLine);
       deps.out(`${pc.red(pc.bold(`${CROSS} ${exc.reason}`))}\n`);
       deps.out(exc.playbook);
       throw new CliExit(outcome.exitCode); // 3, never 1
     }
     ```

   (No JSON surface exists on harden-gate, so the additive-JSON requirement is
   vacuous here — noted for the reviewer.)

4. `npx vitest run test/guardian-harden-gate-cli.test.ts test/guardian-hard-gate.test.ts`
   — green; the existing exit-1 blocker tests (`apply blocked`,
   `apply unverified context`) must pass UNCHANGED.
5. `harness validate`
6. Commit:
   `feat(guardian): harden-gate exits 3 abstained when zero checks observed (#508)`

### Task 8: `analyze` warns unmissably on a zero-endpoint diff (advisory)

**Depends on:** Task 3 | **Files:** `ts/src/guardian/cli.ts`,
`ts/test/guardian-cli.test.ts`

1. Tests first (analyze describe in guardian-cli.test.ts):

   ```ts
   it('zero-endpoint diff abstains visibly but exits 0 (#508, D3)', async () => {
     const res = await invokeGuardian(['analyze', 'abc1234', '--json']);
     expect(res.code).toBe(0); // advisory: an empty answer honestly labeled
     expect(res.stdout.toLowerCase()).toContain('abstained');
     const payload = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
     expect(payload.checked).toBe(0);
     expect(payload.abstained).toBe(true);
   });

   it('a real diff carries checked>0 and no abstention warning', async () => {
     const [before, after] = writeSpecs();
     const res = await invokeGuardian([
       'analyze',
       'abc1234',
       '--spec-before',
       before,
       '--spec-after',
       after,
       '--dry-run',
       '--json',
     ]);
     expect(res.code).toBe(0);
     expect(res.stdout.toLowerCase()).not.toContain('abstained');
     const payload = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
     expect(payload.checked).toBe(1); // one added endpoint
     expect(payload.abstained).toBe(false);
   });
   ```

2. `npx vitest run test/guardian-cli.test.ts` — observe failures.
3. Implement in `analyzeCmd`, after `const gaps = mapImpact(...)` and before the
   `opts.json` branch:

   ```ts
   // #508 advisory abstention (D3): a diff with zero endpoints analyzed
   // nothing. gateOutcome is the only decision point -- no local === 0.
   const endpointCount =
     diff.added.length + diff.removed.length + diff.changed.length;
   const outcome = gateOutcome(
     { checked: endpointCount, findings: gaps },
     'advisory',
     { noun: 'endpoint(s)' },
   );
   if (outcome.abstained) {
     deps.out(outcome.summaryLine);
     deps.out(
       'guardian: the spec diff contains zero endpoints, so there was no ' +
         'impact to analyze. Pass --spec-before/--spec-after pointing at ' +
         'specs that actually differ.',
     );
   }
   ```

   In the `opts.json` payload object, add after `changed`:

   ```ts
   checked: endpointCount,
   abstained: outcome.abstained,
   ```

   Exit code paths untouched (analyze has none beyond spec-not-found's 2). The
   markdown `buildSummary` output is unchanged — the warning prints above it,
   which is the abstention framing SC2 requires.

4. `npx vitest run test/guardian-cli.test.ts test/guardian-cli-fidelity.test.ts`
   — green (`no specs prints the tip and a JSON summary` already parses from the
   first brace, so the new warning lines are harmless; the fidelity YAML/`-s`
   tests pass specs or only assert exit 0).
5. `harness validate`
6. Commit:
   `feat(guardian): analyze warns unmissably on a zero-endpoint diff (#508)`

### Task 9: `validate-coverage` abstains loudly on zero file entries (advisory)

**Depends on:** Task 3 | **Files:** `ts/src/guardian/cli.ts`,
`ts/test/guardian-validate-coverage-cli.test.ts`

1. Tests first:

   ```ts
   it('zero file entries abstains loudly, exit 0 (#508, D3)', async () => {
     const path = write({ files: {} });
     const res = await invokeGuardian(['validate-coverage', path]);
     expect(res.code).toBe(0);
     expect(res.stdout.toLowerCase()).toContain('abstained');
     expect(res.stdout).not.toContain('valid coverage-json document');
   });

   it('json carries checked/abstained additively (#508)', async () => {
     const empty = write({ files: {} });
     const res = await invokeGuardian(['validate-coverage', empty, '--json']);
     expect(res.code).toBe(0);
     const data = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
     expect(data.valid).toBe(true);
     expect(data.checked).toBe(0);
     expect(data.abstained).toBe(true);
   });
   ```

   (The existing `valid clean document prints the success line` test uses a
   one-entry fixture — checked 1 — and stays green untouched.)

2. `npx vitest run test/guardian-validate-coverage-cli.test.ts` — observe
   failures (green success line + no fields today).
3. Implement in `cli.ts`:
   - Helper above `validateCoverageCmd`:

     ```ts
     /** The validator's denominator: entries in the `files` map (#508). */
     function coverageEntryCount(data: unknown): number {
       if (typeof data !== 'object' || data === null || Array.isArray(data)) {
         return 0;
       }
       const files = (data as Record<string, unknown>)['files'];
       if (
         typeof files !== 'object' ||
         files === null ||
         Array.isArray(files)
       ) {
         return 0;
       }
       return Object.keys(files).length;
     }
     ```

   - In `validateCoverageCmd`, after `const valid = ...`:

     ```ts
     const outcome = gateOutcome(
       { checked: coverageEntryCount(data), findings: problems },
       'advisory',
       { noun: 'file entrie(s)' },
     );
     ```

     (Findings outrank abstention in the helper, so a document whose only
     content is problems never masks its errors as an abstention.)

   - In the `opts.json` payload, after `problems`:

     ```ts
     checked: coverageEntryCount(data),
     abstained: outcome.abstained,
     ```

   - In the human branch, replace ONLY the clean-success arm:

     ```ts
     if (valid && warnings.length === 0) {
       if (outcome.abstained) {
         deps.out(outcome.summaryLine);
         deps.out(
           `guardian: ${path} carries zero file entries ${EM_DASH} nothing ` +
             'was validated. Check that the producer wrote a non-empty ' +
             "'files' map.",
         );
       } else {
         deps.out(
           pc.green(
             pc.bold(`${CHECK} ${path} is a valid coverage-json document.`),
           ),
         );
       }
     } else if (valid) {
     ```

   - Exit logic untouched: errors/`--strict` semantics unchanged, abstention
     exits 0 (see Uncertainties).
4. `npx vitest run test/guardian-validate-coverage-cli.test.ts` — green, every
   pre-existing exit-code pin unchanged.
5. `harness validate`
6. Commit:
   `feat(guardian): validate-coverage abstains loudly on zero file entries (#508)`

### Task 10: Conformance harness — rows invoke through a `run` seam

**Depends on:** Task 1 | **Files:** `ts/test/gate-conformance.test.ts`

The Wave 1 row shape (`fixture` returning `{args, home}`) is welded to
`invokeCanary`; guardian rows need `invokeGuardian` with deps/cwd/stdin. Give
each row a `run(base)` that builds its fixture and drives the real CLI,
returning `{ code, stdout }` — the declarative command/layer/kind/expect/forbid
columns (D5's reviewed registry) stay.

1. Refactor `GateRow`:

   ```ts
   interface GateRow {
     command: string;
     layer: 'engine' | 'npm' | 'skill' | 'workflow';
     kind: 'gate' | 'advisory';
     /** gate rows exit EXIT_ABSTAINED; advisory rows warn and exit 0. */
     expect: 'exit3' | 'warnLine';
     /** Success copy that must NEVER appear on a zero denominator. */
     forbid: string[];
     /** Build the zero-denominator fixture and run the REAL CLI. */
     run: (base: string) => Promise<{ code: number; stdout: string }>;
   }
   ```

2. Adapt the two Wave 1 rows: move each `fixture` body into `run`, ending with
   `return invokeCanary(args, { deps: { home: () => home } });` — the built
   fixture is unchanged, only the invocation moves inside the row.
3. Adapt the test body:

   ```ts
   const res = await row.run(base);
   expect(res.stdout.toLowerCase()).toContain('abstained');
   for (const text of row.forbid) {
     expect(res.stdout).not.toContain(text);
   }
   if (row.expect === 'exit3') {
     expect(res.code).toBe(EXIT_ABSTAINED);
   } else {
     expect(res.code).toBe(0);
   }
   ```

4. `npx vitest run test/gate-conformance.test.ts` — both Wave 1 rows green (pure
   refactor, no behavior change).
5. `harness validate`
6. Commit:
   `refactor(test): gate-conformance rows drive the CLI through a run seam (#508)`

### Task 11: Conformance registry rows for the four guardian surfaces

**Depends on:** Tasks 3, 7, 8, 9, 10 | **Files:**
`ts/test/gate-conformance.test.ts`

1. Add imports:

   ```ts
   import { FakeBranchProtectionClient } from '../src/guardian/hard-gate.js';
   import { invokeGuardian } from './guardian-cli-testkit.js';
   ```

2. Append four rows to `ROWS` (layer `'engine'` — they live in the ts engine and
   ship in `dist/engine/`):

   ```ts
   {
     command: 'guardian pr-check (empty diff)',
     layer: 'engine',
     kind: 'gate',
     expect: 'exit3',
     forbid: ['no test-coverage gaps', 'nothing to verify'],
     // #456 permanent negative fixture (spec SC4): the guardian silently
     // no-opped for weeks; an empty diff must never render as a pass again.
     run: (base) =>
       invokeGuardian(['pr-check', '--diff', '-'], { input: '', cwd: base }),
   },
   {
     command: 'guardian harden-gate --apply (zero observed checks)',
     layer: 'engine',
     kind: 'gate',
     expect: 'exit3',
     forbid: ['already required', 'Finish the flip'],
     run: () =>
       invokeGuardian(
         ['harden-gate', '--repo', 'o/r', '--apply', '--token', 'x'],
         {
           deps: {
             buildBranchProtectionClient: () =>
               new FakeBranchProtectionClient({
                 contexts: ['build'],
                 observed: [],
               }),
           },
         },
       ),
   },
   {
     command: 'guardian analyze (zero-endpoint diff)',
     layer: 'engine',
     kind: 'advisory',
     expect: 'warnLine',
     forbid: ['"abstained": false'],
     run: (base) =>
       invokeGuardian(['analyze', 'abc1234', '--json'], { cwd: base }),
   },
   {
     command: 'guardian validate-coverage (zero file entries)',
     layer: 'engine',
     kind: 'advisory',
     expect: 'warnLine',
     forbid: ['valid coverage-json document'],
     run: async (base) => {
       const path = join(base, 'coverage.json');
       writeFileSync(path, JSON.stringify({ files: {} }), 'utf-8');
       return invokeGuardian(['validate-coverage', path]);
     },
   },
   ```

3. `npx vitest run test/gate-conformance.test.ts` — six rows green.
4. `harness validate`
5. Commit:

   ```text
   test(guardian): conformance rows for pr-check, harden-gate, analyze, validate-coverage (#508)
   ```

### Task 12: Wave boundary gate — full suite, tsc, prettier

**Depends on:** Tasks 1-11 | **Files:** none new (formatting fixes only if the
gate finds any)

1. `cd /Users/bs/Github/canary/ts && npx vitest run` — everything green.
   Expected count: 1671 baseline + the ~15 tests added above (assert >= 1684;
   pin the exact number observed).
2. `npx tsc --noEmit` — clean.
3. `npx prettier --check src test` (and the plan doc:
   `npx prettier --check ../docs/changes/no-silent-abstention/plans/wave2-guardian.md`)
   — clean; if not, `--write`, re-run the suite, and commit
   `style(guardian): prettier (#508)`.
4. `harness validate && harness check-deps` — green.
5. Grep-review spec SC2 for the swept surfaces: no swept command prints success
   without `gateOutcome` framing — `grep -n "nothing to verify" src/guardian/`
   returns nothing; `grep -n "valid coverage-json document" src/guardian/cli.ts`
   appears only inside the non-abstained branch.
6. Push and open the PR against the Wave 1 branch (or `main` if Wave 1 has
   merged), title:

   ```text
   feat(guardian): wave 2 no-silent-abstention — pr-check/harden-gate exit 3, analyze/validate-coverage warn (#508)
   ```

   PR body must call out the deliberate behavior changes: docs-only / empty-diff
   PRs now exit 3 (D1), harden-gate zero-observed moves 1 -> 3 (D4), and the
   workflow-template handling lands in Wave 5.

---

## Verification Traceability

| Observable truth                       | Delivered by         |
| -------------------------------------- | -------------------- |
| 1 (pr-check exit 3, #456 fixture)      | Tasks 3, 11          |
| 2 (pr-check JSON + analysis record)    | Tasks 2, 4, 5        |
| 3 (harden-gate abstention exit 3)      | Tasks 6, 7, 11       |
| 4 (analyze advisory warning)           | Tasks 8, 11          |
| 5 (validate-coverage advisory warning) | Tasks 9, 11          |
| 6 (four registry rows)                 | Tasks 10, 11         |
| 7 (byte-identical non-zero paths)      | Every task's step 4+ |
| 8 (wave boundary gate)                 | Task 12              |
