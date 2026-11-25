# Plan: canary-cry P1 — schema, patterns, matrix; `cry validate` / `cry matrix`

**Date:** 2026-11-25 | **Spec:**
[docs/changes/canary-cry/proposal.md](../proposal.md) (P1 row of Implementation
Order) | **ADR:**
[0046](../../../knowledge/decisions/0046-live-target-skills-confirmed-manifest-no-replay-no-finding.md)
| **Issue:** #608 | **Tasks:** 16 | **Checkpoints:** 3 | **Time:** ~60 min |
**Integration Tier:** medium | **Rigor:** standard | **Session:**
`changes--canary-cry--proposal`

Worktree: `/Users/bs/Github/canary-608-cry-p1`, branch `feat/608-canary-cry-p1`,
base `main` @ `71f5a1a7`. Every command below uses absolute paths or `git -C`;
never touch `/Users/bs/Github/canary`.

## Goal

Ship the Tier-0 half of `canary-cry`: a self-contained skill CLI whose
`validate` checks `.canary/cry/flows.json` + `targets.json` (every error names
its JSON path, exit 2) and whose `matrix` emits a deterministic, ranked scenario
matrix (flows × abuse patterns, cut to a whisper/shout/scream budget), fully
registered so every existing repo gate stays green.

## Observable Truths (Acceptance Criteria)

1. **SC1.** When `canary-cry matrix --json` runs twice (in-process and as two
   separate processes) with the same flows file, amplitude and seed, the system
   shall print byte-identical output. _(T6, T8)_
2. **SC2.** When amplitude is `whisper`, the matrix shall contain exactly the
   top 3 flows × {`multi-submit`, `abandon-midflow`} × i1; `shout` = top 8 flows
   × all six patterns × i1,i2; `scream` = all flows × all patterns × i1..i3
   (10-flow fixture: 9 / 128 / 240 scenarios). _(T6)_
3. **SC3.** The system shall not schedule a pattern against a step it does not
   apply to (write-keyed, not-last, awaited-response, first-write+session-keys,
   last-step+accounts A/B+auth). _(T6)_
4. **SC4.** When critical areas are read, output shall say
   `ranking: declared+critical-areas` and add +2 for an area at/under
   `criticalArea` with `risk_score >= 0.7`; otherwise `ranking: declared`. _(T6,
   T8)_
5. **SC5.** If flows.json or targets.json fails validation, then the system
   shall exit 2 naming `<file>: <json path>: <problem>` and shall print no
   matrix. _(T4, T5, T8)_
6. **SC6.** The static import closure of `cli.mjs` shall contain no network,
   process or model module, no network global, and no dynamic import. _(T10)_
7. **SC24.** If the matrix has zero scenarios, then the system shall print
   `ABSTAINED: zero scenarios` plus the #508 abstained line, exit 0 advisory and
   exit 3 under `--strict`; it is registered in the skill gate-conformance
   registry. _(T6, T8, T9)_
8. **SC19 (partial).** `plugin-skills.test.ts`, `bop-name-registry.test.ts`,
   `skill-cli-conformance.test.ts`, `skill-examples.test.ts`, the
   entropy/perf/docs ratchets and `format:check` pass with the skill registered.
   _(T2, T8, T11, T14, T15)_
9. While `run` or `report` is not built, the system shall exit 2 with
   `'<cmd>' is not yet supported (a later phase of #608)`. _(T8)_
10. `harness validate` and `harness check-deps` (repo root) pass. _(T15, T16)_

## Uncertainties

No BLOCKING items. Every ASSUMPTION below is also a `concerns[]` entry in the
handoff; the decision checkpoint at Task 3 is where the human can overturn them
before any code lands.

- [ASSUMPTION] **`cry matrix --target <name>`** (not in the spec's CLI
  synopsis). `token-expiry` and `shared-machine` "apply to" a target, but
  `matrix` has no target. Without `--target` they are listed on a
  `target-scoped patterns not scheduled (no --target)` line, never silently
  dropped. P2's `run --live <t>` supplies the target the same way. If wrong: T6
  (`unscheduled`), T8 (flag), SKILL.md.
- [ASSUMPTION] **Pattern weights** (spec fixes that a weight exists, not its
  value): multi-submit 5, shared-machine 5, abandon-midflow 4, stale-optimistic
  4, duplicate-tab 3, token-expiry 3. If wrong: `patterns.mjs` plus the expected
  ids/scores in the matrix and CLI tests.
- [ASSUMPTION] **Flow ranking for the radius cut** = the flow's best scenario
  score; a flow that no scheduled pattern applies to is not ranked (it would
  contribute zero scenarios and waste a whisper slot). Ties break on id
  (code-unit compare, never `localeCompare`).
- [ASSUMPTION] **Scenario id `s<step>` uses the step id**
  (`checkout:multi-submit:i1:spay`), not its index: ids are unique and survive
  step insertion, so P4 fingerprints/resume stay stable.
- [ASSUMPTION] **`matrix` accepts `--strict`** (the failure-modes table says
  "exit 3 under --strict"; the synopsis omits it). Needed for the
  gate-conformance row.
- [ASSUMPTION] **`matrix` supports all three amplitudes in P1.** The P4
  "`shout`/`scream` exit 2 not yet supported" rule is about `run`; SC2 (a P1
  criterion) needs shout/scream matrices.
- [ASSUMPTION] Defaults: amplitude `whisper`, seed `0` (a random default would
  break SC1).
- [ASSUMPTION] A **present-but-malformed critical-areas file is exit 2**, not a
  silent degrade (canary-katana degrades instead). The default path may be
  absent; an explicit `--critical-areas` path must exist.
- [ASSUMPTION] `auth` requires all of `signIn`, `signOut`, `sessionKeys`
  (matches the spec example). `token-expiry` anchors on the first write step;
  `shared-machine` on the last step.
- [ASSUMPTION] `--json` output **is** the future `matrix.json`
  (`"format": "canary.cry-matrix/1"`, no timestamp).
- [ASSUMPTION] Schema is split into `schema.mjs` (flows + loaders),
  `schema-core.mjs` (helpers) and `schema-targets.mjs`. A single file measured
  408 lines after prettier, over the 300-line perf budget. This adds two names
  the spec's file layout does not list.
- [ASSUMPTION] Only `cli.mjs` goes into both `entryPoints` arrays in P1. The
  spec also names `scripts/runtime/cry-runtime.mjs`, but that file lands in P3
  and should be declared there.
- [ASSUMPTION] An unexpected exception exits 1 (family convention, as in
  canary-unquarantine). The spec reserves 1 for `--strict` + corrupted; that
  only collides once `report` exists (P3/P5 must decide).
- [DEFERRABLE] `{{unique.<kind>}}` is checked for syntax only; P3 fixes the kind
  catalog.
- [DEFERRABLE] How the `signIn` flow is parameterised for account B (the example
  uses `{{account.A.*}}`). This is P3 runtime design.
- [DEFERRABLE] Cross-checking `{{account.K.*}}` against a target's accounts.
  This belongs to the P2 gate, which reads env vars.
- [DEFERRABLE] In-process tests resolve the default
  `.canary/critical-areas.json` against `agents/skills/` (cwd). A stray
  untracked file there would change rankings. Low risk because `.canary/` is
  gitignored.

## Verification already done (design input, not delivery)

Every module and test below was drafted **outside the repo** (session
scratchpad), then checked against copies of `agents/skills/lib`,
`package-lock.json` (vitest 5.1.1, TS 5.9.3, prettier 3.10.1) and
`harness.config.json`:

- 123 tests passed.
- `tsc -p tsconfig.json --noEmit` was clean.
- `prettier --check` was clean, and so was `markdownlint-cli` with the repo
  config.
- `harness check-perf --severity info` reported only the allowed `cli.mjs`
  coupling. That allowance is a pre-existing `deltaAllowances` glob for
  `agents/skills/claude-code/*/scripts/cli.mjs`.
- canary-cry's rows of `skill-cli-conformance.test.ts` passed.
- Coverage of `canary-cry/scripts/*.mjs` was 95% statements, 91% branches and
  100% functions.
- Two perf findings came out in the draft and were fixed: nesting 5 in
  `checkTemplates` and complexity 16 in `buildMatrix`.

None of this counts as done until execution commits it; the gates are re-run in
the worktree (T14, T15).

## File Map

- CREATE `agents/skills/claude-code/canary-cry/SKILL.md`
- CREATE `agents/skills/claude-code/canary-cry/scripts/patterns.mjs`
- CREATE `agents/skills/claude-code/canary-cry/scripts/schema-core.mjs`
- CREATE `agents/skills/claude-code/canary-cry/scripts/schema-targets.mjs`
- CREATE `agents/skills/claude-code/canary-cry/scripts/schema.mjs`
- CREATE `agents/skills/claude-code/canary-cry/scripts/matrix.mjs`
- CREATE `agents/skills/claude-code/canary-cry/scripts/cli.mjs` (mode 755)
- CREATE `agents/skills/claude-code/canary-cry/scripts/flows.example.json`
- CREATE `agents/skills/claude-code/canary-cry/scripts/targets.example.json`
- CREATE `agents/skills/test/canary-cry-patterns.test.ts`
- CREATE `agents/skills/test/canary-cry-targets.test.ts`
- CREATE `agents/skills/test/canary-cry-schema.test.ts`
- CREATE `agents/skills/test/canary-cry-matrix.test.ts`
- CREATE `agents/skills/test/canary-cry-cli.test.ts`
- CREATE `agents/skills/test/canary-cry-tier.test.ts`
- CREATE `agents/skills/test/canary-cry-docs.test.ts`
- MODIFY `agents/skills/test/gate-conformance.test.ts` (import + one row +
  helper)
- MODIFY `docs/naming-registry.md` (canary-cry `reserved` → `shipped`, line 85)
- MODIFY `.claude-plugin/plugin.json` (`skills` += canary-cry)
- MODIFY `agents/skills/package.json` (`format:check` glob)
- MODIFY `agents/skills/vitest.config.ts` (coverage include)
- MODIFY `harness.config.json` (`entropy.entryPoints` **and**
  `performance.entryPoints`)
- MODIFY `agents/skills/README.md` (tree, count 36→38, Discovery bullet,
  Programmatic list)

Out of scope (P2+): gate, manifest, `run --live`, codegen, runtime, verdict,
fixture app, `cry-e2e.yml`, the `@playwright/test` devDependency, AGENTS.md,
root README, the roadmap `done` flip, CHANGELOG.

## Skeleton

1. Setup + scaffold the skill so the registry tests stay green (~2 tasks, ~6
   min)
2. Pure modules with TDD: patterns, schema (targets, flows), matrix (~4 tasks,
   ~18 min)
3. Examples + CLI + conformance/tier registries (~4 tasks, ~15 min)
4. Registrations + full SKILL.md + README (~3 tasks, ~9 min)
5. Gates, ratchets from root, doc-drift/testing-gap review (~3 tasks, ~12 min)

**Estimated total:** 16 tasks, ~60 min. _Skeleton approved: **pending.** The
planner ran as a subagent with no human in the loop. Approval is requested
together with plan sign-off; see `concerns[]`._

## Tasks

### Task 1: Prepare the worktree

**Depends on:** none | **Files:** none (no commit)

1. `cd /Users/bs/Github/canary-608-cry-p1 && git branch --show-current` →
   `feat/608-canary-cry-p1`. Then run `git status --short`; it should be empty.
   Then `git stash list | wc -l`; it should print `0`.
2. `git -C /Users/bs/Github/canary-608-cry-p1 fetch origin` and confirm `main`
   has not moved past `71f5a1a7`. If it has, rebase:
   `git -C /Users/bs/Github/canary-608-cry-p1 rebase origin/main`.
3. `cd /Users/bs/Github/canary-608-cry-p1 && source ~/.nvm/nvm.sh && nvm use`
   (pins 22.23.2 via `.nvmrc`; mise users get it via
   `idiomatic_version_file_enable_tools`).
4. Build the engine; the skills suite's globalSetup fails if `ts/dist` is
   missing:

   ```bash
   npm ci --prefix /Users/bs/Github/canary-608-cry-p1/ts
   npm run build --prefix /Users/bs/Github/canary-608-cry-p1/ts
   ```

5. `npm ci --prefix /Users/bs/Github/canary-608-cry-p1/agents/skills`
6. Baseline (all pass; record the test count):

   ```bash
   cd /Users/bs/Github/canary-608-cry-p1/agents/skills
   npx vitest run test/skill-cli-conformance.test.ts \
     test/gate-conformance.test.ts
   ```

### Task 2: Scaffold the skill directory and register it

**Depends on:** Task 1 | **Files:**
`agents/skills/claude-code/canary-cry/SKILL.md`, `docs/naming-registry.md`,
`.claude-plugin/plugin.json`

The moment `agents/skills/claude-code/canary-cry/` exists, two tests fail.
`bop-name-registry.test.ts` fails because the directory is still `reserved`.
`plugin-skills.test.ts` fails because the directory is an unclassified skill. So
the directory, the flip and the registration land in one commit. The SKILL.md
here deliberately has **no `cli:` line**: declaring one before `scripts/cli.mjs`
exists fails `skill-cli-executable`, `skill-cli-conformance` and
`skill-examples`.

1. Create `agents/skills/claude-code/canary-cry/SKILL.md`:

   ```markdown
   ---
   name: canary-cry
   description:
     Pre-launch "try to break it" sweep of ordinary user flows, run ahead of a
     launch, a client onboarding or a demo so a sales demo never has to explain
     away a bug. It abuses flows the way real people do (an impatient
     double-submit on a slow network, abandoning a multi-form flow after it
     wrote partial rows, a second user on a shared machine, a duplicated tab, a
     token that expires mid-flow) and judges by state corruption, not by
     rendering. This release ships the deterministic half. `validate` checks the
     declared .canary/cry/flows.json and targets.json and names the JSON path of
     every error; `matrix` emits the ranked scenario matrix (flows x abuse
     patterns, cut to a whisper, shout or scream budget) with no network and no
     agent. Live runs against an allowlisted non-prod target arrive in later
     phases. NOT input fuzzing and NOT targeted bug pursuit (that is
     canary-huntress).
   requires: [node>=20]
   ---

   # Canary Cry

   Pre-launch "try to break it" sweep of ordinary user flows (#608). Phase 1 is
   in progress; see the
   [canary-cry spec](../../../../docs/changes/canary-cry/proposal.md).
   ```

2. Run (red):

   ```bash
   cd /Users/bs/Github/canary-608-cry-p1/ts
   npx vitest run test/bop-name-registry.test.ts test/plugin-skills.test.ts
   ```

   Expect failures in `marks a shipped directory as shipped, not reserved` and
   `registers exactly the adopter-facing skills`.

3. Edit `docs/naming-registry.md` line 85: change `| \`canary-cry\` | reserved |
   608 |`to`| \`canary-cry\` | shipped | 608 |` (keep the column padding;
   prettier will re-pad).
4. Edit `.claude-plugin/plugin.json` `skills`: insert
   `"./agents/skills/claude-code/canary-cry",` after the
   `"./agents/skills/claude-code/canary-critical-areas",` line.
5. Run (green): the same vitest command plus
   `test/skill-surfaces.test.ts test/skill-examples.test.ts test/skill-cli-executable.test.ts`.
6. Format the touched files:

   ```bash
   cd /Users/bs/Github/canary-608-cry-p1
   npx --prefix agents/skills prettier --write docs/naming-registry.md \
     .claude-plugin/plugin.json agents/skills/claude-code/canary-cry/SKILL.md
   ```

7. `cd /Users/bs/Github/canary-608-cry-p1 && harness validate`
8. Commit:
   `feat(canary-cry): scaffold the skill and mark the name shipped (#608 P1)`
   with a body line `Refs #608`. Never use a closing keyword next to `#608`.

### Task 3: Abuse-pattern catalog (data only)

**Depends on:** Task 2 | **Files:**
`agents/skills/claude-code/canary-cry/scripts/patterns.mjs`,
`agents/skills/test/canary-cry-patterns.test.ts`

`[checkpoint:decision]` — Before writing code, confirm the P1 judgment calls
listed under Uncertainties: the weights, `--target`, the flow-ranking rule, the
step-id scenario ids, `matrix --strict`, and exit 2 on a malformed
critical-areas file. If the human already answered them at plan sign-off,
proceed. If a weight changes, update `patterns.mjs` and the expected ids/scores
in Task 6/8 tests together.

1. Create `agents/skills/test/canary-cry-patterns.test.ts`:

   ```ts
   /**
    * canary-cry abuse-pattern catalog (#608 P1). The catalog is data the matrix
    * reads, so its shape is the contract: six patterns, the whisper core set,
    * one description per intensity up to the ceiling, and nothing mutable.
    */
   import { describe, expect, it } from 'vitest';

   import {
     INTENSITY_CEILING,
     PATTERNS,
   } from '../claude-code/canary-cry/scripts/patterns.mjs';

   const ANCHORS = [
     'write',
     'write-not-last',
     'await-response',
     'first-write',
     'last-step',
   ];

   describe('abuse-pattern catalog', () => {
     it('lists the six spec patterns in catalog order', () => {
       expect(PATTERNS.map((p) => p.id)).toEqual([
         'multi-submit',
         'abandon-midflow',
         'stale-optimistic',
         'duplicate-tab',
         'token-expiry',
         'shared-machine',
       ]);
     });

     it('marks exactly multi-submit and abandon-midflow as the whisper core', () => {
       expect(PATTERNS.filter((p) => p.core).map((p) => p.id)).toEqual([
         'multi-submit',
         'abandon-midflow',
       ]);
     });

     it('scopes only token-expiry and shared-machine to a target', () => {
       expect(
         PATTERNS.filter((p) => p.requires !== null).map((p) => [
           p.id,
           p.requires,
         ]),
       ).toEqual([
         ['token-expiry', 'session-keys'],
         ['shared-machine', 'two-accounts'],
       ]);
     });

     it('gives each pattern a weight, a known anchor and one line per intensity', () => {
       expect(INTENSITY_CEILING).toBe(3);
       for (const p of PATTERNS) {
         expect(Number.isInteger(p.weight) && p.weight > 0, p.id).toBe(true);
         expect(ANCHORS, p.id).toContain(p.anchor);
         expect(p.intensities, p.id).toHaveLength(INTENSITY_CEILING);
       }
     });

     it('is frozen all the way down, so no caller can re-rank the catalog', () => {
       expect(Object.isFrozen(PATTERNS)).toBe(true);
       for (const p of PATTERNS) {
         expect(Object.isFrozen(p), p.id).toBe(true);
         expect(Object.isFrozen(p.intensities), p.id).toBe(true);
       }
     });
   });
   ```

2. Run:
   `cd /Users/bs/Github/canary-608-cry-p1/agents/skills && npx vitest run test/canary-cry-patterns.test.ts`
   → fails (module missing).
3. Create `agents/skills/claude-code/canary-cry/scripts/patterns.mjs`:

   ```js
   // canary-cry abuse-pattern catalog -- DATA ONLY (spec "Abuse-pattern
   // catalog", #608). Nothing here executes. `anchor` names which steps of a flow
   // a pattern attacks and `requires` names what the target must declare; the
   // matrix (matrix.mjs) is what reads them. `intensities` describes levels 1, 2
   // and 3 in words for the manifest -- the code that injects them is the runtime
   // (#608 P3), not this file.
   //
   // `weight` feeds the ranking score, flow.risk x weight. The spec fixes that a
   // weight exists, not its value; these are the P1 values recorded in the plan
   // (docs/changes/canary-cry/plans/2026-11-25-canary-cry-p1-plan.md): a pattern
   // that corrupts state or leaks across accounts outranks one that only strains
   // session handling.

   /** The highest intensity any pattern runs at (spec D5: the ceiling). */
   export const INTENSITY_CEILING = 3;

   const pattern = (spec) =>
     Object.freeze({ ...spec, intensities: Object.freeze(spec.intensities) });

   /** Catalog order is the order patterns are listed in every matrix. */
   export const PATTERNS = Object.freeze([
     pattern({
       id: 'multi-submit',
       core: true,
       weight: 5,
       anchor: 'write',
       requires: null,
       intensities: ['2x @ no throttle', '3x @ 400 ms', '5x @ 3 s'],
     }),
     pattern({
       id: 'abandon-midflow',
       core: true,
       weight: 4,
       anchor: 'write-not-last',
       requires: null,
       intensities: ['back', 'reload', 'context.close()'],
     }),
     pattern({
       id: 'stale-optimistic',
       core: false,
       weight: 4,
       anchor: 'await-response',
       requires: null,
       intensities: ['delay past UI timeout', 'fake 500', 'drop'],
     }),
     pattern({
       id: 'duplicate-tab',
       core: false,
       weight: 3,
       anchor: 'write',
       requires: null,
       intensities: ['2 tabs racing', '3 tabs racing', '3 tabs racing'],
     }),
     pattern({
       id: 'token-expiry',
       core: false,
       weight: 3,
       anchor: 'first-write',
       requires: 'session-keys',
       intensities: ['before the write', 'between writes', 'before every step'],
     }),
     pattern({
       id: 'shared-machine',
       core: false,
       weight: 5,
       anchor: 'last-step',
       requires: 'two-accounts',
       intensities: ['sign-out', 'sign-out + back', 'no sign-out'],
     }),
   ]);
   ```

4. Run the same command → 5 pass.
5. `npx prettier --write claude-code/canary-cry/scripts/patterns.mjs test/canary-cry-patterns.test.ts`
   (from `agents/skills`).
6. `cd /Users/bs/Github/canary-608-cry-p1 && harness validate`
7. Commit: `feat(canary-cry): add the abuse-pattern catalog (#608 P1)`

### Task 4: Schema helpers + targets.json validation

**Depends on:** Task 3 | **Files:**
`agents/skills/claude-code/canary-cry/scripts/schema-core.mjs`,
`agents/skills/claude-code/canary-cry/scripts/schema-targets.mjs`,
`agents/skills/test/canary-cry-targets.test.ts`

1. Create `agents/skills/test/canary-cry-targets.test.ts`:

   ```ts
   /**
    * canary-cry targets.json schema (#608 P1, SC5).
    *
    * Shape only. Which environments may run and which hosts are production are
    * the live gate's rules (#608 P2, exit 4 per ADR 0046): a schema check that
    * refused `environment: "production"` would report a safety stop as a typo
    * (exit 2), which is exactly the confusion ADR 0046 gave exit 4 to prevent.
    */
   import { describe, expect, it } from 'vitest';

   import { validateTargets } from '../claude-code/canary-cry/scripts/schema-targets.mjs';

   function targetsDoc(): any {
     return {
       version: 1,
       prodHosts: ['*.example.com'],
       targets: {
         staging: {
           baseURL: 'https://staging.example.test',
           environment: 'staging',
           hosts: ['staging.example.test'],
           accounts: {
             A: { env: 'CRY_ACCOUNT_A' },
             B: { env: 'CRY_ACCOUNT_B' },
           },
           auth: {
             signIn: 'login',
             signOut: 'logout',
             sessionKeys: ['cookie:session'],
           },
         },
       },
     };
   }

   function errorsAfter(
     mutate: (doc: any) => void,
     flowIds: Set<string> | null = null,
   ): string[] {
     const doc = targetsDoc();
     mutate(doc);
     return validateTargets(doc, flowIds);
   }

   const staging = '$.targets.staging';

   describe('validateTargets', () => {
     it('accepts the spec-shaped document', () => {
       expect(validateTargets(targetsDoc())).toEqual([]);
     });

     it('leaves environment and prodHosts policy to the live gate', () => {
       expect(
         errorsAfter((d) => (d.targets.staging.environment = 'production')),
       ).toEqual([]);
       expect(
         errorsAfter((d) => (d.targets.staging.hosts = ['shop.example.com'])),
       ).toEqual([]);
     });

     it.each<[string, (d: any) => void, string]>([
       ['version', (d) => (d.version = 0), '$.version: must be 1'],
       [
         'prodHosts',
         (d) => delete d.prodHosts,
         '$.prodHosts: must be an array (it may be empty)',
       ],
       [
         'empty targets',
         (d) => (d.targets = {}),
         '$.targets: must declare at least one target',
       ],
       [
         'target name',
         (d) => (d.targets['my target'] = d.targets.staging),
         '$.targets["my target"]: name must match /^[a-z0-9][a-z0-9-]*$/',
       ],
       [
         'baseURL',
         (d) => (d.targets.staging.baseURL = 'ftp://staging.example.test'),
         `${staging}.baseURL: must be an http(s) URL`,
       ],
       [
         'unparseable baseURL',
         (d) => (d.targets.staging.baseURL = 'not a url'),
         `${staging}.baseURL: must be an http(s) URL`,
       ],
       [
         'hosts',
         (d) => (d.targets.staging.hosts = []),
         `${staging}.hosts: must be a non-empty array`,
       ],
       [
         'account env',
         (d) => (d.targets.staging.accounts.A.env = 'cry_a'),
         `${staging}.accounts.A.env: must name an environment variable`,
       ],
       [
         'secret in an account',
         (d) => (d.targets.staging.accounts.A.password = 'hunter2'),
         `${staging}.accounts.A.password: unknown key`,
       ],
       [
         'session key',
         (d) => (d.targets.staging.auth.sessionKeys = ['session']),
         `${staging}.auth.sessionKeys[0]: must be cookie:, localStorage: or sessionStorage:<key>`,
       ],
       [
         'auth flow',
         (d) => delete d.targets.staging.auth.signOut,
         `${staging}.auth.signOut: must be a non-empty string`,
       ],
     ])('names the JSON path of a bad %s', (_label, mutate, expected) => {
       expect(errorsAfter(mutate)).toContain(expected);
     });

     it('cross-checks auth flow names against flows.json when given its ids', () => {
       expect(errorsAfter(() => {}, new Set(['login', 'logout']))).toEqual([]);
       expect(errorsAfter(() => {}, new Set(['checkout']))).toEqual([
         `${staging}.auth.signIn: names no flow in flows.json ('login')`,
         `${staging}.auth.signOut: names no flow in flows.json ('logout')`,
       ]);
     });
   });
   ```

2. Run: `npx vitest run test/canary-cry-targets.test.ts` (from `agents/skills`)
   → fails.
3. Create `agents/skills/claude-code/canary-cry/scripts/schema-core.mjs`:

   ```js
   // canary-cry schema helpers shared by the flows and targets validators
   // (schema.mjs, schema-targets.mjs). Every error is `<json path>: <problem>`.
   // Unknown keys are errors; a `"//"` key is the family's comment convention
   // (canary-shadow's example file) and is allowed in any object.

   import fs from 'node:fs';

   // Ids feed scenario ids `<flow>:<pattern>:i<n>:s<step>`, so ':' is never legal.
   export const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
   const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

   const isObj = (v) =>
     v !== null && typeof v === 'object' && !Array.isArray(v);
   export const isText = (v) => typeof v === 'string' && v.trim() !== '';
   export const declared = (obj) => Object.keys(obj).filter((k) => k !== '//');

   /** `$.a`, `$.a[0]`, or `$.a["two words"]`. */
   export function at(path, key) {
     if (typeof key === 'number') return `${path}[${key}]`;
     if (PLAIN_KEY.test(key)) return `${path}.${key}`;
     return `${path}[${JSON.stringify(key)}]`;
   }

   export function unknownKeys(obj, allowed, path, errors) {
     for (const key of declared(obj)) {
       if (!allowed.includes(key)) errors.push(`${at(path, key)}: unknown key`);
     }
   }

   export function needObject(value, path, errors) {
     if (isObj(value)) return true;
     errors.push(`${path}: must be an object`);
     return false;
   }

   export function needText(value, path, errors) {
     if (isText(value)) return true;
     errors.push(`${path}: must be a non-empty string`);
     return false;
   }

   export function needId(value, path, seen, errors) {
     if (typeof value !== 'string' || !ID_RE.test(value)) {
       errors.push(`${path}: must match ${ID_RE}`);
       return;
     }
     if (seen.has(value)) errors.push(`${path}: duplicate id '${value}'`);
     seen.add(value);
   }

   /** Visit each item of an array, or report the array itself. */
   export function eachItem(list, path, errors, required, visit) {
     if (list === undefined && !required) return;
     if (!Array.isArray(list) || (required && list.length === 0)) {
       const shape = required ? 'a non-empty array' : 'an array';
       errors.push(`${path}: must be ${shape}`);
       return;
     }
     list.forEach((item, i) => visit(item, at(path, i)));
   }

   /** Read and parse a JSON input: `{doc}` or `{error}`. Never throws. */
   export function readJsonFile(file, label) {
     if (!fs.existsSync(file))
       return { error: `${label} file not found: ${file}` };
     try {
       return { doc: JSON.parse(fs.readFileSync(file, 'utf8')) };
     } catch (exc) {
       return {
         error: `${label} file is not valid JSON: ${file}: ${exc.message}`,
       };
     }
   }
   ```

4. Create `agents/skills/claude-code/canary-cry/scripts/schema-targets.mjs`:

   ```js
   // canary-cry targets.json schema (#608, spec "Inputs"). Shape only: the
   // environment allowlist and the prodHosts refusal are the live gate's rules
   // (#608 P2, exit 4 per ADR 0046), never a schema error (exit 2). Accounts are
   // env-var NAMES; no value is read here.

   import {
     ID_RE,
     at,
     declared,
     eachItem,
     needObject,
     needText,
     unknownKeys,
   } from './schema-core.mjs';

   const ENV_RE = /^[A-Z_][A-Z0-9_]*$/;
   const ACCOUNT_RE = /^[A-Za-z0-9_]+$/;
   const SESSION_KEY_RE = /^(cookie|localStorage|sessionStorage):\S+$/;
   const TARGET_KEYS = ['baseURL', 'environment', 'hosts', 'accounts', 'auth'];

   function checkBaseUrl(value, path, errors) {
     let url = null;
     try {
       url = new URL(value);
     } catch {
       // Unparseable: reported below with the same message as a bad scheme.
     }
     if (url === null || !['http:', 'https:'].includes(url.protocol)) {
       errors.push(`${path}: must be an http(s) URL`);
     }
   }

   function checkAccounts(accounts, path, errors) {
     if (!needObject(accounts, path, errors)) return;
     for (const key of declared(accounts)) {
       const p = at(path, key);
       if (!ACCOUNT_RE.test(key))
         errors.push(`${p}: key must match ${ACCOUNT_RE}`);
       if (!needObject(accounts[key], p, errors)) continue;
       // Only `env` is legal: a `password` here would be a committed secret.
       unknownKeys(accounts[key], ['env'], p, errors);
       const { env } = accounts[key];
       if (typeof env !== 'string' || !ENV_RE.test(env)) {
         errors.push(`${at(p, 'env')}: must name an environment variable`);
       }
     }
   }

   function checkAuth(auth, path, errors, flowIds) {
     if (!needObject(auth, path, errors)) return;
     unknownKeys(auth, ['signIn', 'signOut', 'sessionKeys'], path, errors);
     for (const key of ['signIn', 'signOut']) {
       const p = at(path, key);
       const known = flowIds === null || flowIds.has(auth[key]);
       if (needText(auth[key], p, errors) && !known) {
         errors.push(`${p}: names no flow in flows.json ('${auth[key]}')`);
       }
     }
     const keys = at(path, 'sessionKeys');
     eachItem(auth.sessionKeys, keys, errors, true, (key, p) => {
       if (typeof key !== 'string' || !SESSION_KEY_RE.test(key)) {
         errors.push(
           `${p}: must be cookie:, localStorage: or sessionStorage:<key>`,
         );
       }
     });
   }

   function checkTarget(name, target, path, errors, flowIds) {
     if (!ID_RE.test(name)) errors.push(`${path}: name must match ${ID_RE}`);
     if (!needObject(target, path, errors)) return;
     unknownKeys(target, TARGET_KEYS, path, errors);
     checkBaseUrl(target.baseURL, at(path, 'baseURL'), errors);
     // Any non-empty string passes HERE: which environments may run is the live
     // gate's rule (exit 4), so a schema check must not pre-empt it as exit 2.
     needText(target.environment, at(path, 'environment'), errors);
     eachItem(target.hosts, at(path, 'hosts'), errors, true, (h, p) =>
       needText(h, p, errors),
     );
     if (target.accounts !== undefined) {
       checkAccounts(target.accounts, at(path, 'accounts'), errors);
     }
     if (target.auth !== undefined) {
       checkAuth(target.auth, at(path, 'auth'), errors, flowIds);
     }
   }

   /**
    * Every problem in a parsed targets.json. With `flowIds` (a Set of flow ids),
    * auth.signIn and auth.signOut must each name a declared flow.
    * @param {unknown} doc
    * @param {Set<string> | null} [flowIds]
    * @returns {string[]}
    */
   export function validateTargets(doc, flowIds = null) {
     const errors = [];
     if (!needObject(doc, '$', errors)) return errors;
     unknownKeys(doc, ['version', 'prodHosts', 'targets'], '$', errors);
     if (doc.version !== 1) errors.push('$.version: must be 1');
     if (Array.isArray(doc.prodHosts)) {
       doc.prodHosts.forEach((h, i) =>
         needText(h, at('$.prodHosts', i), errors),
       );
     } else {
       errors.push('$.prodHosts: must be an array (it may be empty)');
     }
     if (!needObject(doc.targets, '$.targets', errors)) return errors;
     const names = declared(doc.targets);
     if (!names.length)
       errors.push('$.targets: must declare at least one target');
     for (const name of names) {
       checkTarget(
         name,
         doc.targets[name],
         at('$.targets', name),
         errors,
         flowIds,
       );
     }
     return errors;
   }
   ```

5. Run → all pass. Note the
   `leaves environment and prodHosts policy to the live gate` case: it keeps a
   P2 exit-4 refusal from being pre-empted as an exit-2 schema error.
6. Prettier on the three files; `harness validate`.
7. Commit:
   `feat(canary-cry): validate targets.json with JSON-path errors (#608 P1)`

### Task 5: flows.json validation + loaders

**Depends on:** Task 4 | **Files:**
`agents/skills/claude-code/canary-cry/scripts/schema.mjs`,
`agents/skills/test/canary-cry-schema.test.ts`

1. Create `agents/skills/test/canary-cry-schema.test.ts` (the shipped-examples
   block is appended in Task 7, not now):

   ```ts
   /**
    * canary-cry flows.json schema (#608 P1, SC5).
    *
    * Every error names the JSON path at fault, so `validate` and `matrix` exit 2
    * before a matrix exists. Unknown keys are errors: a `write` typed for
    * `writes` would otherwise drop a step out of every write-keyed pattern
    * without a word.
    */
   import fs from 'node:fs';
   import os from 'node:os';
   import path from 'node:path';
   import { fileURLToPath } from 'node:url';

   import { afterEach, describe, expect, it } from 'vitest';

   import {
     loadFlows,
     loadTargets,
     validateFlows,
   } from '../claude-code/canary-cry/scripts/schema.mjs';

   const tmps: string[] = [];
   afterEach(() => {
     while (tmps.length)
       fs.rmSync(tmps.pop()!, { recursive: true, force: true });
   });
   function writeTmp(name: string, body: string): string {
     const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-cry-schema-'));
     tmps.push(dir);
     const file = path.join(dir, name);
     fs.writeFileSync(file, body);
     return file;
   }

   /** A minimal valid flows document; every test mutates a fresh copy. */
   function flowsDoc(): any {
     return {
       version: 1,
       fixtures: { card: '4242424242424242' },
       flows: [
         {
           id: 'checkout',
           risk: 5,
           steps: [
             { id: 'open', action: 'goto', url: '/cart' },
             {
               id: 'card',
               action: 'fill',
               selector: '[name=card]',
               value: '{{fixture.card}}',
             },
             {
               id: 'pay',
               action: 'click',
               selector: 'button[type=submit]',
               writes: true,
               awaitResponse: 'POST /api/orders',
             },
           ],
           invariants: [
             {
               id: 'one-order',
               probe: {
                 http: {
                   method: 'GET',
                   path: '/api/orders?u={{account.A.id}}',
                 },
               },
               expect: { jsonPath: '$.length', delta: 1 },
             },
           ],
         },
       ],
     };
   }

   /** Apply `mutate` to a fresh valid doc and return its errors. */
   function errorsAfter(mutate: (doc: any) => void): string[] {
     const doc = flowsDoc();
     mutate(doc);
     return validateFlows(doc);
   }

   describe('validateFlows', () => {
     it('accepts the spec-shaped document', () => {
       expect(validateFlows(flowsDoc())).toEqual([]);
     });

     it('accepts an empty flows list (the matrix abstains; it is not a schema error)', () => {
       expect(validateFlows({ version: 1, flows: [] })).toEqual([]);
     });

     it('accepts a "//" comment key in any object', () => {
       expect(
         errorsAfter((d) => {
           d['//'] = 'top';
           d.flows[0]['//'] = 'flow';
           d.flows[0].steps[0]['//'] = 'step';
         }),
       ).toEqual([]);
     });

     it('rejects a non-object document', () => {
       expect(validateFlows([])).toEqual(['$: must be an object']);
     });

     it.each<[string, (d: any) => void, string]>([
       ['version', (d) => (d.version = 2), '$.version: must be 1'],
       ['flows', (d) => (d.flows = {}), '$.flows: must be an array'],
       [
         'action',
         (d) => (d.flows[0].steps[0].action = 'hover'),
         '$.flows[0].steps[0].action: must be one of goto, fill, click, select, press, waitFor',
       ],
       [
         'required field',
         (d) => delete d.flows[0].steps[0].url,
         '$.flows[0].steps[0].url: must be a non-empty string',
       ],
       [
         'typo key',
         (d) => (d.flows[0].steps[2].write = true),
         '$.flows[0].steps[2].write: unknown key',
       ],
       [
         'writes',
         (d) => (d.flows[0].steps[2].writes = 'yes'),
         '$.flows[0].steps[2].writes: must be true or false',
       ],
       [
         'awaitResponse',
         (d) => (d.flows[0].steps[2].awaitResponse = 'orders'),
         "$.flows[0].steps[2].awaitResponse: must be '<METHOD> /path', e.g. 'POST /api/orders'",
       ],
       [
         'risk',
         (d) => (d.flows[0].risk = 6),
         '$.flows[0].risk: must be an integer 1-5',
       ],
       [
         'duplicate step id',
         (d) => (d.flows[0].steps[1].id = 'open'),
         "$.flows[0].steps[1].id: duplicate id 'open'",
       ],
       [
         'colon in id',
         (d) => (d.flows[0].id = 'check:out'),
         '$.flows[0].id: must match /^[a-z0-9][a-z0-9-]*$/',
       ],
       [
         'empty steps',
         (d) => (d.flows[0].steps = []),
         '$.flows[0].steps: must be a non-empty array',
       ],
       [
         'undeclared fixture',
         (d) => (d.flows[0].steps[1].value = '{{fixture.cvv}}'),
         "$.flows[0].steps[1].value: fixture 'cvv' is not in $.fixtures",
       ],
       [
         'unknown template',
         (d) => (d.flows[0].steps[1].value = '{{secret.x}}'),
         '$.flows[0].steps[1].value: unknown template {{secret.x}}',
       ],
       [
         'two probe kinds',
         (d) => (d.flows[0].invariants[0].probe.shell = { argv: ['true'] }),
         '$.flows[0].invariants[0].probe: must declare exactly one of http, shell',
       ],
       [
         'shell string',
         (d) =>
           (d.flows[0].invariants[0].probe = { shell: { argv: 'psql -c x' } }),
         '$.flows[0].invariants[0].probe.shell.argv: must be a non-empty array of strings (run with execFile, never as a shell string)',
       ],
       [
         'probe path',
         (d) => (d.flows[0].invariants[0].probe.http.path = 'api/orders'),
         "$.flows[0].invariants[0].probe.http.path: must start with '/'",
       ],
       [
         'probe method',
         (d) => (d.flows[0].invariants[0].probe.http.method = 'FETCH'),
         '$.flows[0].invariants[0].probe.http.method: must be one of GET, HEAD, POST, PUT, PATCH, DELETE',
       ],
       [
         'delta and equals',
         (d) => (d.flows[0].invariants[0].expect.equals = 1),
         '$.flows[0].invariants[0].expect: must declare exactly one of delta, equals',
       ],
       [
         'delta type',
         (d) => (d.flows[0].invariants[0].expect.delta = '1'),
         '$.flows[0].invariants[0].expect.delta: must be a number',
       ],
       [
         'jsonPath',
         (d) => (d.flows[0].invariants[0].expect.jsonPath = 'length'),
         "$.flows[0].invariants[0].expect.jsonPath: must be a string starting with '$'",
       ],
       [
         'symptoms',
         (d) => (d.flows[0].symptoms = { selectors: [] }),
         '$.flows[0].symptoms.selectors: must be a non-empty array',
       ],
       [
         'fixture value',
         (d) => (d.fixtures.card = { n: 1 }),
         '$.fixtures.card: must be a string, number or boolean',
       ],
     ])('names the JSON path of a bad %s', (_label, mutate, expected) => {
       expect(errorsAfter(mutate)).toContain(expected);
     });

     it('allows an empty fill value (clearing a field is a real step)', () => {
       expect(errorsAfter((d) => (d.flows[0].steps[1].value = ''))).toEqual([]);
     });

     it('accepts a shell probe given as an argv array', () => {
       const shell = { argv: ['psql', '-tAc', 'select count(*) from orders'] };
       expect(
         errorsAfter((d) => (d.flows[0].invariants[0].probe = { shell })),
       ).toEqual([]);
     });

     it.each(['toString', 'constructor', 'hasOwnProperty'])(
       'does not resolve the inherited key {{fixture.%s}} as declared',
       (name) => {
         // `fixtures` is parsed JSON: on a plain lookup an inherited key reads as
         // declared, and a typo'd fixture would ship to the runtime unresolved.
         expect(
           errorsAfter(
             (d) => (d.flows[0].steps[1].value = `{{fixture.${name}}}`),
           ),
         ).toContain(
           `$.flows[0].steps[1].value: fixture '${name}' is not in $.fixtures`,
         );
       },
     );
   });

   describe('loadFlows', () => {
     it('returns the document when it validates', () => {
       const file = writeTmp('flows.json', JSON.stringify(flowsDoc()));
       const r = loadFlows(file);
       expect(r.errors).toEqual([]);
       expect(r.doc.flows[0].id).toBe('checkout');
     });

     it('names a missing file', () => {
       const file = path.join(os.tmpdir(), 'canary-cry-no-such', 'flows.json');
       expect(loadFlows(file)).toEqual({
         doc: null,
         errors: [`flows file not found: ${file}`],
       });
     });

     it('names a file that is not JSON', () => {
       const file = writeTmp('flows.json', '{ "version": 1, ');
       const r = loadFlows(file);
       expect(r.doc).toBeNull();
       expect(r.errors[0]).toMatch(
         new RegExp(`^flows file is not valid JSON: ${file}: `),
       );
     });

     it('prefixes every schema error with the file, and returns no doc', () => {
       const file = writeTmp(
         'flows.json',
         JSON.stringify({ version: 2, flows: [] }),
       );
       expect(loadFlows(file)).toEqual({
         doc: null,
         errors: [`${file}: $.version: must be 1`],
       });
     });
   });

   describe('loadTargets', () => {
     it('names a missing file', () => {
       const file = path.join(
         os.tmpdir(),
         'canary-cry-no-such',
         'targets.json',
       );
       expect(loadTargets(file).errors).toEqual([
         `targets file not found: ${file}`,
       ]);
     });

     it('prefixes schema errors with the file', () => {
       const dir = fs.mkdtempSync(
         path.join(os.tmpdir(), 'canary-cry-targets-'),
       );
       tmps.push(dir);
       const file = path.join(dir, 'targets.json');
       fs.writeFileSync(
         file,
         JSON.stringify({ version: 2, prodHosts: [], targets: {} }),
       );
       expect(loadTargets(file).errors).toContain(
         `${file}: $.version: must be 1`,
       );
     });
   });
   ```

2. Run: `npx vitest run test/canary-cry-schema.test.ts` → fails.
3. Create `agents/skills/claude-code/canary-cry/scripts/schema.mjs`:

   ```js
   // canary-cry input schemas (#608, spec "Inputs"): .canary/cry/flows.json and
   // .canary/cry/targets.json. Every error is `<json path>: <problem>`, so a bad
   // file fails at the desk (exit 2) and says where, instead of half-running a
   // sweep. Hand-rolled on purpose: a skill imports nothing installed.
   //
   // Unknown keys are errors: `"write": true` typed for `"writes": true` would
   // otherwise drop a step out of every write-keyed pattern without a word. A
   // `"//"` key is the family's comment convention (canary-shadow's example) and
   // is allowed in any object.
   //
   // No secret is read here. Accounts are env-var NAMES. Reading their values,
   // the environment allowlist and the prodHosts refusal belong to the live gate
   // (#608 P2, exit 4 per ADR 0046), never to schema validation (exit 2).

   import {
     at,
     eachItem,
     isText,
     needId,
     needObject,
     needText,
     readJsonFile,
     unknownKeys,
   } from './schema-core.mjs';
   import { validateTargets } from './schema-targets.mjs';

   const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];
   const AWAIT_RE = new RegExp(`^(${HTTP_METHODS.join('|')}) /\\S*$`);
   const TEMPLATE_RE = /\{\{([^}]*)\}\}/g;
   const TEMPLATE_KINDS = [
     /^account\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/,
     /^fixture\.[A-Za-z0-9_-]+$/,
     /^unique\.[a-z][a-z0-9-]*$/,
   ];

   /** The fields each step action needs. */
   const ACTION_FIELDS = Object.freeze({
     goto: ['url'],
     fill: ['selector', 'value'],
     click: ['selector'],
     select: ['selector', 'value'],
     press: ['key'],
     waitFor: ['selector'],
   });
   const STEP_KEYS = [
     'id',
     'action',
     'url',
     'selector',
     'value',
     'key',
     'writes',
     'awaitResponse',
   ];
   const FLOW_KEYS = [
     'id',
     'risk',
     'criticalArea',
     'steps',
     'invariants',
     'symptoms',
   ];

   /** Why a `{{...}}` reference is unusable, or null when it is fine. */
   function templateError(ref, fixtures) {
     if (!TEMPLATE_KINDS.some((re) => re.test(ref))) {
       return `unknown template {{${ref}}}`;
     }
     if (!ref.startsWith('fixture.')) return null;
     const name = ref.slice('fixture.'.length);
     if (Object.hasOwn(fixtures, name)) return null;
     return `fixture '${name}' is not in $.fixtures`;
   }

   function checkTemplates(value, path, ctx) {
     if (typeof value !== 'string') return;
     for (const [, ref] of value.matchAll(TEMPLATE_RE)) {
       const problem = templateError(ref, ctx.fixtures);
       if (problem !== null) ctx.errors.push(`${path}: ${problem}`);
     }
   }

   function checkAction(step, path, ctx) {
     if (!Object.hasOwn(ACTION_FIELDS, step.action)) {
       const choices = Object.keys(ACTION_FIELDS).join(', ');
       ctx.errors.push(`${at(path, 'action')}: must be one of ${choices}`);
       return;
     }
     for (const field of ACTION_FIELDS[step.action]) {
       // `value` may be '' (filling a field empty is a real step).
       if (field === 'value' && typeof step.value === 'string') continue;
       needText(step[field], at(path, field), ctx.errors);
     }
   }

   function checkStepFlags(step, path, errors) {
     if (step.writes !== undefined && typeof step.writes !== 'boolean') {
       errors.push(`${at(path, 'writes')}: must be true or false`);
     }
     const wait = step.awaitResponse;
     if (
       wait !== undefined &&
       !(typeof wait === 'string' && AWAIT_RE.test(wait))
     ) {
       errors.push(
         `${at(path, 'awaitResponse')}: must be '<METHOD> /path', ` +
           `e.g. 'POST /api/orders'`,
       );
     }
   }

   function checkStep(step, path, ctx) {
     if (!needObject(step, path, ctx.errors)) return;
     unknownKeys(step, STEP_KEYS, path, ctx.errors);
     needId(step.id, at(path, 'id'), ctx.stepIds, ctx.errors);
     checkAction(step, path, ctx);
     checkStepFlags(step, path, ctx.errors);
     for (const field of ['url', 'selector', 'value', 'key']) {
       checkTemplates(step[field], at(path, field), ctx);
     }
   }

   function checkHttpProbe(http, path, ctx) {
     if (!needObject(http, path, ctx.errors)) return;
     unknownKeys(http, ['method', 'path'], path, ctx.errors);
     if (!HTTP_METHODS.includes(http.method)) {
       const choices = HTTP_METHODS.join(', ');
       ctx.errors.push(`${at(path, 'method')}: must be one of ${choices}`);
     }
     if (typeof http.path !== 'string' || !http.path.startsWith('/')) {
       ctx.errors.push(`${at(path, 'path')}: must start with '/'`);
     }
     checkTemplates(http.path, at(path, 'path'), ctx);
   }

   function checkShellProbe(shell, path, ctx) {
     if (!needObject(shell, path, ctx.errors)) return;
     unknownKeys(shell, ['argv'], path, ctx.errors);
     const argvPath = at(path, 'argv');
     const { argv } = shell;
     if (!Array.isArray(argv) || argv.length === 0 || !argv.every(isText)) {
       ctx.errors.push(
         `${argvPath}: must be a non-empty array of strings ` +
           '(run with execFile, never as a shell string)',
       );
       return;
     }
     argv.forEach((arg, i) => checkTemplates(arg, at(argvPath, i), ctx));
   }

   function checkProbe(probe, path, ctx) {
     if (!needObject(probe, path, ctx.errors)) return;
     unknownKeys(probe, ['http', 'shell'], path, ctx.errors);
     const kinds = ['http', 'shell'].filter((k) => probe[k] !== undefined);
     if (kinds.length !== 1) {
       ctx.errors.push(`${path}: must declare exactly one of http, shell`);
     } else if (kinds[0] === 'http') {
       checkHttpProbe(probe.http, at(path, 'http'), ctx);
     } else {
       checkShellProbe(probe.shell, at(path, 'shell'), ctx);
     }
   }

   function checkExpect(expect, path, errors) {
     if (!needObject(expect, path, errors)) return;
     unknownKeys(expect, ['jsonPath', 'delta', 'equals'], path, errors);
     const jp = expect.jsonPath;
     if (jp !== undefined && !(typeof jp === 'string' && jp.startsWith('$'))) {
       errors.push(
         `${at(path, 'jsonPath')}: must be a string starting with '$'`,
       );
     }
     const has = ['delta', 'equals'].filter((k) => Object.hasOwn(expect, k));
     if (has.length !== 1) {
       errors.push(`${path}: must declare exactly one of delta, equals`);
     } else if (has[0] === 'delta' && !Number.isFinite(expect.delta)) {
       errors.push(`${at(path, 'delta')}: must be a number`);
     }
   }

   function checkInvariant(inv, path, ctx) {
     if (!needObject(inv, path, ctx.errors)) return;
     unknownKeys(inv, ['id', 'probe', 'expect'], path, ctx.errors);
     needId(inv.id, at(path, 'id'), ctx.invariantIds, ctx.errors);
     checkProbe(inv.probe, at(path, 'probe'), ctx);
     checkExpect(inv.expect, at(path, 'expect'), ctx.errors);
   }

   function checkSymptoms(symptoms, path, errors) {
     if (!needObject(symptoms, path, errors)) return;
     unknownKeys(symptoms, ['selectors'], path, errors);
     const selectors = at(path, 'selectors');
     eachItem(symptoms.selectors, selectors, errors, true, (s, p) =>
       needText(s, p, errors),
     );
   }

   function checkFlow(flow, path, ctx) {
     const { errors } = ctx;
     if (!needObject(flow, path, errors)) return;
     unknownKeys(flow, FLOW_KEYS, path, errors);
     needId(flow.id, at(path, 'id'), ctx.flowIds, errors);
     if (!Number.isInteger(flow.risk) || flow.risk < 1 || flow.risk > 5) {
       errors.push(`${at(path, 'risk')}: must be an integer 1-5`);
     }
     if (flow.criticalArea !== undefined) {
       needText(flow.criticalArea, at(path, 'criticalArea'), errors);
     }
     const inner = { ...ctx, stepIds: new Set(), invariantIds: new Set() };
     eachItem(flow.steps, at(path, 'steps'), errors, true, (s, p) =>
       checkStep(s, p, inner),
     );
     eachItem(flow.invariants, at(path, 'invariants'), errors, false, (v, p) =>
       checkInvariant(v, p, inner),
     );
     if (flow.symptoms !== undefined) {
       checkSymptoms(flow.symptoms, at(path, 'symptoms'), errors);
     }
   }

   function checkFixtures(fixtures, errors) {
     if (fixtures === undefined) return {};
     if (!needObject(fixtures, '$.fixtures', errors)) return {};
     for (const [name, value] of Object.entries(fixtures)) {
       if (!['string', 'number', 'boolean'].includes(typeof value)) {
         errors.push(
           `${at('$.fixtures', name)}: must be a string, number or boolean`,
         );
       }
     }
     return fixtures;
   }

   /** Every problem in a parsed flows.json, each `"<json path>: <problem>"`. */
   export function validateFlows(doc) {
     const errors = [];
     if (!needObject(doc, '$', errors)) return errors;
     unknownKeys(doc, ['version', 'fixtures', 'flows'], '$', errors);
     if (doc.version !== 1) errors.push('$.version: must be 1');
     const fixtures = checkFixtures(doc.fixtures, errors);
     const ctx = { errors, fixtures, flowIds: new Set() };
     if (Array.isArray(doc.flows)) {
       doc.flows.forEach((flow, i) => checkFlow(flow, at('$.flows', i), ctx));
     } else {
       errors.push('$.flows: must be an array');
     }
     return errors;
   }

   function load(file, label, validate) {
     const read = readJsonFile(file, label);
     if (read.error !== undefined) return { doc: null, errors: [read.error] };
     const errors = validate(read.doc).map((e) => `${file}: ${e}`);
     return { doc: errors.length ? null : read.doc, errors };
   }

   /** flows.json, validated. `doc` is non-null exactly when `errors` is empty. */
   export const loadFlows = (file) => load(file, 'flows', validateFlows);

   /**
    * targets.json, validated; `flowIds` cross-checks the auth flow names.
    * @param {string} file
    * @param {Set<string> | null} [flowIds]
    */
   export const loadTargets = (file, flowIds = null) =>
     load(file, 'targets', (doc) => validateTargets(doc, flowIds));
   ```

4. Run
   `npx vitest run test/canary-cry-schema.test.ts test/canary-cry-targets.test.ts`
   → all pass. That includes the `{{fixture.toString}}` prototype-hole cases:
   the lookup goes through `Object.hasOwn`.
5. Prettier; `harness validate`.
6. Commit: `feat(canary-cry): validate flows.json by JSON path (#608 P1)`

### Task 6: Scenario matrix (pure)

**Depends on:** Task 3 | **Files:**
`agents/skills/claude-code/canary-cry/scripts/matrix.mjs`,
`agents/skills/test/canary-cry-matrix.test.ts`

Covers SC1–SC4 and SC24 at module level. One task, because the verified module
is one unit. The test file is written whole, then the module.

1. Create `agents/skills/test/canary-cry-matrix.test.ts`:

   ```ts
   /**
    * canary-cry scenario matrix (#608 P1: SC1-SC4, SC24 at the module).
    *
    * The 10-flow fixture spreads risk 1..5 twice, so every rank is decided by
    * score and the documented id tie-break: f04 and f09 are risk 5, f03 and f08
    * risk 4, and so on. Each flow has two write steps (`save`, which also awaits
    * a response, and `done`, the last step), which is enough for every pattern's
    * anchor to fire at least once.
    */
   import { afterEach, describe, expect, it, vi } from 'vitest';

   import {
     AMPLITUDES,
     buildMatrix,
     matrixJson,
   } from '../claude-code/canary-cry/scripts/matrix.mjs';
   import { PATTERNS } from '../claude-code/canary-cry/scripts/patterns.mjs';

   afterEach(() => vi.restoreAllMocks());

   function flows10(): any[] {
     return Array.from({ length: 10 }, (_, k) => ({
       id: `f${String(k).padStart(2, '0')}`,
       risk: (k % 5) + 1,
       steps: [
         { id: 'open', action: 'goto', url: '/' },
         {
           id: 'save',
           action: 'click',
           selector: '#save',
           writes: true,
           awaitResponse: 'POST /api/save',
         },
         { id: 'done', action: 'click', selector: '#done', writes: true },
       ],
     }));
   }

   /** A target that every target-scoped pattern applies to. */
   const FULL_TARGET = {
     name: 'staging',
     spec: {
       accounts: { A: { env: 'CRY_A' }, B: { env: 'CRY_B' } },
       auth: { signIn: 'f00', signOut: 'f01', sessionKeys: ['cookie:session'] },
     },
   };

   const ALL = PATTERNS.map((p) => p.id);
   const pairs = (m: any) =>
     [...new Set(m.scenarios.map((s: any) => `${s.flow}/${s.pattern}`))].sort();
   const cartesian = (flows: string[], patterns: string[]) =>
     flows.flatMap((f) => patterns.map((p) => `${f}/${p}`)).sort();

   describe('budgets (SC2)', () => {
     it('whisper is exactly the top 3 flows x the core patterns x i1', () => {
       const m = buildMatrix({
         flows: flows10(),
         amplitude: 'whisper',
         seed: 0,
       });
       expect(m.flows).toEqual(['f04', 'f09', 'f03']);
       expect(m.patterns).toEqual(['multi-submit', 'abandon-midflow']);
       expect(m.intensities).toEqual([1]);
       expect(m.scenarios.map((s: any) => s.id)).toEqual([
         'f04:multi-submit:i1:sdone',
         'f04:multi-submit:i1:ssave',
         'f09:multi-submit:i1:sdone',
         'f09:multi-submit:i1:ssave',
         'f03:multi-submit:i1:sdone',
         'f03:multi-submit:i1:ssave',
         'f04:abandon-midflow:i1:ssave',
         'f09:abandon-midflow:i1:ssave',
         'f03:abandon-midflow:i1:ssave',
       ]);
       expect(m.scenarios.map((s: any) => s.score)).toEqual([
         25, 25, 25, 25, 20, 20, 20, 20, 16,
       ]);
     });

     it('shout is the top 8 flows x every pattern x i1, i2', () => {
       const m = buildMatrix({
         flows: flows10(),
         amplitude: 'shout',
         seed: 0,
         target: FULL_TARGET,
       });
       const top8 = ['f04', 'f09', 'f03', 'f08', 'f02', 'f07', 'f01', 'f06'];
       expect(m.flows).toEqual(top8);
       expect(m.patterns).toEqual(ALL);
       expect(m.intensities).toEqual([1, 2]);
       expect(pairs(m)).toEqual(cartesian(top8, ALL));
       // 8 anchored steps per flow (multi-submit 2, abandon 1, stale 1,
       // duplicate-tab 2, token-expiry 1, shared-machine 1) x 8 flows x 2 rounds.
       expect(m.scenarios).toHaveLength(128);
     });

     it('scream is every flow x every pattern x i1..i3, never past the ceiling', () => {
       const m = buildMatrix({
         flows: flows10(),
         amplitude: 'scream',
         seed: 0,
         target: FULL_TARGET,
       });
       expect(m.flows).toHaveLength(10);
       expect(m.intensities).toEqual([1, 2, 3]);
       expect(m.scenarios).toHaveLength(240);
       expect(Math.max(...m.scenarios.map((s: any) => s.intensity))).toBe(3);
     });

     it('orders scenarios round by round, then by score, then by id', () => {
       const m = buildMatrix({ flows: flows10(), amplitude: 'shout', seed: 0 });
       const rounds = m.scenarios.map((s: any) => s.intensity);
       expect(rounds).toEqual(
         [...rounds].sort((a: number, b: number) => a - b),
       );
       expect(m.scenarios[0].id).toBe('f04:multi-submit:i1:sdone');
     });

     it('exposes the three documented budgets and no others', () => {
       expect(Object.keys(AMPLITUDES)).toEqual(['whisper', 'shout', 'scream']);
       expect(() =>
         buildMatrix({ flows: flows10(), amplitude: 'loud', seed: 0 }),
       ).toThrow('unknown amplitude: loud');
     });
   });

   describe('applicability (SC3)', () => {
     const scream = (target: any = FULL_TARGET, flows = flows10()) =>
       buildMatrix({ flows, amplitude: 'scream', seed: 0, target });

     it('anchors every pattern only on a step it applies to', () => {
       const byId = new Map<string, any>(
         flows10()[0].steps.map((s: any, i: number) => [s.id, { ...s, i }]),
       );
       for (const s of scream().scenarios) {
         const step = byId.get(s.step)!;
         const rule: Record<string, boolean> = {
           'multi-submit': step.writes === true,
           'abandon-midflow': step.writes === true && step.i < 2,
           'stale-optimistic': typeof step.awaitResponse === 'string',
           'duplicate-tab': step.writes === true,
           'token-expiry': step.id === 'save',
           'shared-machine': step.id === 'done',
         };
         expect(rule[s.pattern], s.id).toBe(true);
       }
     });

     it('schedules nothing against a flow with no writes and no awaited response', () => {
       const readOnly = [
         {
           id: 'browse',
           risk: 5,
           steps: [{ id: 'open', action: 'goto', url: '/' }],
         },
       ];
       const m = buildMatrix({ flows: readOnly, amplitude: 'shout', seed: 0 });
       expect(m.scenarios).toEqual([]);
     });

     it('needs session keys for token-expiry and accounts A and B for shared-machine', () => {
       const onlyA = {
         name: 't',
         spec: {
           accounts: { A: { env: 'CRY_A' } },
           auth: { signIn: 'f00', signOut: 'f01', sessionKeys: [] },
         },
       };
       const patterns = new Set(
         scream(onlyA).scenarios.map((s: any) => s.pattern),
       );
       expect(patterns.has('token-expiry')).toBe(false);
       expect(patterns.has('shared-machine')).toBe(false);
       expect(patterns.has('multi-submit')).toBe(true);
     });

     it('does not read an inherited key as a declared account', () => {
       const inherited = {
         name: 't',
         spec: { accounts: {}, auth: { sessionKeys: ['cookie:s'] } },
       };
       Object.setPrototypeOf(inherited.spec.accounts, { A: {}, B: {} });
       const patterns = new Set(
         scream(inherited).scenarios.map((s: any) => s.pattern),
       );
       expect(patterns.has('shared-machine')).toBe(false);
     });

     it('lists the target-scoped patterns it left out when no target is named', () => {
       const m = buildMatrix({ flows: flows10(), amplitude: 'shout', seed: 0 });
       expect(m.unscheduled).toEqual([
         { pattern: 'token-expiry', reason: 'no --target' },
         { pattern: 'shared-machine', reason: 'no --target' },
       ]);
       expect(m.scenarios.some((s: any) => s.pattern === 'token-expiry')).toBe(
         false,
       );
       const whisper = buildMatrix({
         flows: flows10(),
         amplitude: 'whisper',
         seed: 0,
       });
       expect(whisper.unscheduled).toEqual([]);
     });
   });

   describe('critical-areas ranking (SC4)', () => {
     const twoFlows = () => [
       { ...flows10()[3], id: 'aa' }, // risk 4, not critical
       { ...flows10()[3], id: 'zz', criticalArea: 'src/checkout' }, // risk 4
     ];

     it('says ranking: declared when no critical areas are given', () => {
       const m = buildMatrix({
         flows: twoFlows(),
         amplitude: 'whisper',
         seed: 0,
       });
       expect(m.ranking).toBe('declared');
       expect(m.flows).toEqual(['aa', 'zz']);
     });

     it('boosts a flow by 2 when a high-risk area lies under its criticalArea', () => {
       const areas = [{ path: 'src/checkout/pay.ts', risk_score: 0.9 }];
       const m = buildMatrix({
         flows: twoFlows(),
         amplitude: 'whisper',
         seed: 0,
         areas,
       });
       expect(m.ranking).toBe('declared+critical-areas');
       expect(m.flows).toEqual(['zz', 'aa']);
       expect(m.scenarios[0]).toMatchObject({ flow: 'zz', score: 22 });
     });

     it.each([
       ['below the 0.7 cut', { path: 'src/checkout/pay.ts', risk_score: 0.69 }],
       ['a sibling prefix', { path: 'src/checkoutx/pay.ts', risk_score: 0.9 }],
     ])('does not boost for %s, but still reports the source', (_l, area) => {
       const m = buildMatrix({
         flows: twoFlows(),
         amplitude: 'whisper',
         seed: 0,
         areas: [area],
       });
       expect(m.ranking).toBe('declared+critical-areas');
       expect(m.flows).toEqual(['aa', 'zz']);
     });
   });

   describe('determinism (SC1) and abstention (SC24)', () => {
     it('serializes equal input to byte-identical JSON', () => {
       const a = matrixJson(
         buildMatrix({ flows: flows10(), amplitude: 'shout', seed: 9 }),
       );
       const b = matrixJson(
         buildMatrix({ flows: flows10(), amplitude: 'shout', seed: 9 }),
       );
       expect(a).toBe(b);
       expect(JSON.parse(a).format).toBe('canary.cry-matrix/1');
     });

     it('records the seed without letting it select scenarios', () => {
       const at = (seed: number) =>
         buildMatrix({ flows: flows10(), amplitude: 'shout', seed });
       expect(at(1).seed).toBe(1);
       expect(at(1).scenarios).toEqual(at(2).scenarios);
     });

     it('reads no clock and no randomness', () => {
       vi.spyOn(Math, 'random').mockImplementation(() => {
         throw new Error('Math.random read');
       });
       vi.spyOn(Date, 'now').mockImplementation(() => {
         throw new Error('Date.now read');
       });
       expect(() =>
         buildMatrix({ flows: flows10(), amplitude: 'scream', seed: 0 }),
       ).not.toThrow();
     });

     it('abstains on zero scenarios instead of returning an empty pass', () => {
       const m = buildMatrix({ flows: [], amplitude: 'whisper', seed: 0 });
       expect(m).toMatchObject({
         status: 'abstained',
         reason: 'zero scenarios',
         scenarios: [],
       });
       const ok = buildMatrix({
         flows: flows10(),
         amplitude: 'whisper',
         seed: 0,
       });
       expect(ok).toMatchObject({ status: 'ok', reason: null });
     });
   });
   ```

2. Run: `npx vitest run test/canary-cry-matrix.test.ts` → fails.
3. Create `agents/skills/claude-code/canary-cry/scripts/matrix.mjs`:

   ```js
   // canary-cry scenario matrix -- PURE (spec "Matrix", #608; Tier-0: no
   // network, no agent, no clock). Declared flows x the abuse-pattern catalog,
   // ranked and cut to an amplitude's budget. The same flows, amplitude, seed,
   // target and critical areas always give the same document, byte for byte
   // (SC1): nothing here reads the time, the environment, or Math.random, and
   // every sort is a code-unit comparison, never a locale one.
   //
   // The seed is RECORDED, never consumed: at run time it feeds only
   // {{unique.*}} test data (#608 P3). It never selects a scenario.

   import { INTENSITY_CEILING, PATTERNS } from './patterns.mjs';

   // The house high-risk cut (canary-katana areas.mjs, canary-failure-impact).
   const CRITICAL_RISK = 0.7;
   const CRITICAL_BOOST = 2;

   const rounds = (n) => Array.from({ length: n }, (_, i) => i + 1);

   /** Budgets (spec D5): flows hit, pattern set, and intensity rounds. */
   export const AMPLITUDES = Object.freeze({
     whisper: Object.freeze({ radius: 3, coreOnly: true, intensities: [1] }),
     shout: Object.freeze({ radius: 8, coreOnly: false, intensities: [1, 2] }),
     scream: Object.freeze({
       radius: Infinity,
       coreOnly: false,
       intensities: rounds(INTENSITY_CEILING),
     }),
   });

   const writes = (steps) => steps.filter((s) => s.writes === true);

   /** The steps each pattern `anchor` attacks (patterns.mjs names them). */
   const ANCHORS = Object.freeze({
     write: (flow) => writes(flow.steps),
     'write-not-last': (flow) => writes(flow.steps.slice(0, -1)),
     'await-response': (flow) =>
       flow.steps.filter((s) => typeof s.awaitResponse === 'string'),
     'first-write': (flow) => writes(flow.steps).slice(0, 1),
     'last-step': (flow) => flow.steps.slice(-1),
   });

   const hasAccount = (target, key) =>
     target.accounts !== null &&
     typeof target.accounts === 'object' &&
     Object.hasOwn(target.accounts, key);

   /** What a target-scoped pattern needs the target to declare. */
   const REQUIRES = Object.freeze({
     'session-keys': (target) => (target.auth?.sessionKeys?.length ?? 0) > 0,
     'two-accounts': (target) =>
       Boolean(target.auth) &&
       hasAccount(target, 'A') &&
       hasAccount(target, 'B'),
   });

   const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
   const byScoreThenId = (a, b) => b.score - a.score || byCodeUnit(a.id, b.id);

   const norm = (p) => String(p).replace(/^\.\//, '').replace(/\/+$/, '');

   /** An area at or under the flow's criticalArea, at the high-risk cut. */
   function isCritical(flow, areas) {
     if (areas === null || typeof flow.criticalArea !== 'string') return false;
     const root = norm(flow.criticalArea);
     return areas.some((area) => {
       const p = norm(area.path);
       const under = p === root || p.startsWith(`${root}/`);
       return under && Number(area.risk_score) >= CRITICAL_RISK;
     });
   }

   function applies(pattern, target) {
     if (pattern.requires === null) return true;
     return target !== null && REQUIRES[pattern.requires](target);
   }

   /** One flow's scenarios before intensity: every pattern x anchored step. */
   function flowScenarios(flow, patterns, target, areas) {
     const boost = isCritical(flow, areas) ? CRITICAL_BOOST : 0;
     const out = [];
     for (const pattern of patterns.filter((p) => applies(p, target))) {
       for (const step of ANCHORS[pattern.anchor](flow)) {
         const score = flow.risk * pattern.weight + boost;
         out.push({ flow: flow.id, pattern: pattern.id, step: step.id, score });
       }
     }
     return out;
   }

   /** Flows ranked by their best scenario; a flow nothing applies to drops. */
   function rankFlows(flows, patterns, target, areas) {
     return flows
       .map((flow) => {
         const base = flowScenarios(flow, patterns, target, areas);
         const score = Math.max(0, ...base.map((s) => s.score));
         return { id: flow.id, score, base };
       })
       .filter((ranked) => ranked.base.length > 0)
       .sort(byScoreThenId);
   }

   function atIntensity(chosen, n) {
     return chosen
       .flatMap((ranked) => ranked.base)
       .map((s) => ({
         id: `${s.flow}:${s.pattern}:i${n}:s${s.step}`,
         flow: s.flow,
         pattern: s.pattern,
         intensity: n,
         step: s.step,
         score: s.score,
       }))
       .sort(byScoreThenId);
   }

   /** Target-scoped patterns left out for want of --target: listed, not hidden. */
   function unscheduled(patterns, target) {
     if (target !== null) return [];
     return patterns
       .filter((p) => p.requires !== null)
       .map((p) => ({ pattern: p.id, reason: 'no --target' }));
   }

   function budgetFor(amplitude) {
     if (!Object.hasOwn(AMPLITUDES, amplitude)) {
       throw new Error(`unknown amplitude: ${amplitude}`);
     }
     return AMPLITUDES[amplitude];
   }

   /** Zero scenarios is an abstention, never an empty pass (SC24, #508). */
   const outcome = (scenarios) =>
     scenarios.length
       ? { status: 'ok', reason: null }
       : { status: 'abstained', reason: 'zero scenarios' };

   /**
    * The matrix document (`cry matrix --json`; P3 writes it as matrix.json).
    * @param {{flows: object[], amplitude: string, seed: number,
    *   target?: {name: string, spec: object} | null,
    *   areas?: object[] | null}} input
    */
   export function buildMatrix(input) {
     const budget = budgetFor(input.amplitude);
     const target = input.target ?? null;
     const areas = input.areas ?? null;
     const patterns = PATTERNS.filter((p) => p.core || !budget.coreOnly);
     const spec = target === null ? null : target.spec;
     const chosen = rankFlows(input.flows, patterns, spec, areas).slice(
       0,
       budget.radius,
     );
     const scenarios = budget.intensities.flatMap((n) =>
       atIntensity(chosen, n),
     );
     return {
       format: 'canary.cry-matrix/1',
       ...outcome(scenarios),
       amplitude: input.amplitude,
       seed: input.seed,
       ranking: areas === null ? 'declared' : 'declared+critical-areas',
       target: target === null ? null : target.name,
       patterns: patterns.map((p) => p.id),
       intensities: [...budget.intensities],
       flows: chosen.map((ranked) => ranked.id),
       unscheduled: unscheduled(patterns, target),
       scenarios,
     };
   }

   /** The canonical serialization, so equal input gives equal bytes. */
   export function matrixJson(matrix) {
     return JSON.stringify(matrix, null, 2);
   }
   ```

4. Run → all pass (whisper 9 ids in order, shout 128, scream 240, critical boost
   22).
5. Plant check, so the determinism test is not vacuous. Back up `matrix.mjs` to
   the scratchpad first. Plant `Math.random()` inside `buildMatrix`, confirm
   `reads no clock and no randomness` fails, then restore from the copy, never
   with `git checkout`.
6. Prettier; `harness validate`.
7. Commit: `feat(canary-cry): rank flows x patterns into a matrix (#608 P1)`

### Task 7: Example flows and targets files

**Depends on:** Task 5 | **Files:**
`agents/skills/claude-code/canary-cry/scripts/flows.example.json`,
`agents/skills/claude-code/canary-cry/scripts/targets.example.json`,
`agents/skills/test/canary-cry-schema.test.ts`

1. Append to `agents/skills/test/canary-cry-schema.test.ts`. Add
   `import { fileURLToPath } from 'node:url';` after the `node:path` import,
   then append this block at the end:

   ```ts
   describe('the shipped examples', () => {
     const scripts = path.join(
       path.dirname(fileURLToPath(import.meta.url)),
       '..',
       'claude-code',
       'canary-cry',
       'scripts',
     );

     it('flows.example.json and targets.example.json validate together', () => {
       const flows = loadFlows(path.join(scripts, 'flows.example.json'));
       expect(flows.errors).toEqual([]);
       const ids = new Set<string>(flows.doc.flows.map((f: any) => f.id));
       const targets = loadTargets(
         path.join(scripts, 'targets.example.json'),
         ids,
       );
       expect(targets.errors).toEqual([]);
     });
   });
   ```

2. Run `npx vitest run test/canary-cry-schema.test.ts` → the new case fails
   (files missing).
3. Create `agents/skills/claude-code/canary-cry/scripts/flows.example.json`:

   ```json
   {
     "//": "Example canary-cry flows file. Copy it to .canary/cry/flows.json in the project under test and edit it. Accounts are referenced by NAME through targets.json: never put a secret here. Probes must be read-only, because a probe that writes invalidates its own before/after comparison.",
     "version": 1,
     "fixtures": { "card": "4242424242424242" },
     "flows": [
       {
         "id": "login",
         "risk": 3,
         "steps": [
           { "id": "open", "action": "goto", "url": "/login" },
           {
             "id": "email",
             "action": "fill",
             "selector": "[name=email]",
             "value": "{{account.A.email}}"
           },
           {
             "id": "password",
             "action": "fill",
             "selector": "[name=password]",
             "value": "{{account.A.password}}"
           },
           {
             "id": "submit",
             "action": "click",
             "selector": "button[type=submit]",
             "awaitResponse": "POST /api/session"
           }
         ]
       },
       {
         "id": "logout",
         "risk": 1,
         "steps": [
           { "id": "open", "action": "goto", "url": "/account" },
           { "id": "sign-out", "action": "click", "selector": "#sign-out" }
         ]
       },
       {
         "id": "checkout",
         "risk": 5,
         "criticalArea": "src/checkout",
         "steps": [
           { "id": "open", "action": "goto", "url": "/cart" },
           {
             "id": "address",
             "action": "click",
             "selector": "#save-address",
             "writes": true,
             "awaitResponse": "POST /api/addresses"
           },
           {
             "id": "card",
             "action": "fill",
             "selector": "[name=card]",
             "value": "{{fixture.card}}"
           },
           {
             "id": "pay",
             "action": "click",
             "selector": "button[type=submit]",
             "writes": true,
             "awaitResponse": "POST /api/orders"
           }
         ],
         "invariants": [
           {
             "id": "one-order",
             "probe": {
               "http": {
                 "method": "GET",
                 "path": "/api/orders?user={{account.A.id}}"
               }
             },
             "expect": { "jsonPath": "$.length", "delta": 1 }
           }
         ],
         "symptoms": { "selectors": [".error-banner"] }
       }
     ]
   }
   ```

4. Create `agents/skills/claude-code/canary-cry/scripts/targets.example.json`:

   ```json
   {
     "//": "Example canary-cry targets file. Copy it to .canary/cry/targets.json and edit it. Each account names an environment variable holding a JSON object such as {\"email\": ..., \"password\": ..., \"id\": ...}; the value is read at run time only and never written to any artifact. Any host matching prodHosts is always refused.",
     "version": 1,
     "prodHosts": ["*.example.com"],
     "targets": {
       "staging": {
         "baseURL": "https://staging.example.test",
         "environment": "staging",
         "hosts": ["staging.example.test"],
         "accounts": {
           "A": { "env": "CRY_ACCOUNT_A" },
           "B": { "env": "CRY_ACCOUNT_B" }
         },
         "auth": {
           "signIn": "login",
           "signOut": "logout",
           "sessionKeys": ["cookie:session"]
         }
       }
     }
   }
   ```

5. Run → pass. `npx prettier --write` the two JSON files and the test;
   `harness validate`.
6. Commit: `docs(canary-cry): ship example flows and targets files (#608 P1)`

### Task 8: The `canary-cry` CLI — `validate` and `matrix`

**Depends on:** Tasks 6, 7 | **Files:**
`agents/skills/claude-code/canary-cry/scripts/cli.mjs`,
`agents/skills/test/canary-cry-cli.test.ts`,
`agents/skills/claude-code/canary-cry/SKILL.md`

Subcommand dispatch mirrors canary-unquarantine. It uses the shared
`createParser`, a `command` positional, `usageError()`, `isMain()` and
`process.exitCode`. The CLI is invoked as
`canary skills run canary-cry -- <command> [options]`.

1. Create `agents/skills/test/canary-cry-cli.test.ts`:

   ```ts
   /**
    * canary-cry CLI (#608 P1): `validate` and `matrix`, their exit codes, and
    * the SC1 / SC4 / SC5 / SC24 behaviour end to end. The shared contract
    * (--help, unknown flags, empty values, the exec bit) is
    * skill-cli-conformance.test.ts's job and is not repeated here.
    */
   import { spawnSync } from 'node:child_process';
   import fs from 'node:fs';
   import os from 'node:os';
   import path from 'node:path';
   import { fileURLToPath } from 'node:url';

   import { afterEach, describe, expect, it, vi } from 'vitest';

   import { main } from '../claude-code/canary-cry/scripts/cli.mjs';

   const HERE = path.dirname(fileURLToPath(import.meta.url));
   const SCRIPTS = path.join(
     HERE,
     '..',
     'claude-code',
     'canary-cry',
     'scripts',
   );
   const CLI = path.join(SCRIPTS, 'cli.mjs');
   const FLOWS_EXAMPLE = path.join(SCRIPTS, 'flows.example.json');
   const TARGETS_EXAMPLE = path.join(SCRIPTS, 'targets.example.json');

   const tmps: string[] = [];
   afterEach(() => {
     vi.restoreAllMocks();
     while (tmps.length)
       fs.rmSync(tmps.pop()!, { recursive: true, force: true });
   });
   function tmp(): string {
     const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-cry-cli-'));
     tmps.push(dir);
     return dir;
   }
   function write(dir: string, name: string, doc: unknown): string {
     const file = path.join(dir, name);
     fs.mkdirSync(path.dirname(file), { recursive: true });
     fs.writeFileSync(
       file,
       typeof doc === 'string' ? doc : JSON.stringify(doc),
     );
     return file;
   }

   function run(argv: string[]): {
     code: number;
     stdout: string;
     stderr: string;
   } {
     const out: string[] = [];
     const err: string[] = [];
     vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
       out.push(a.join(' '));
     });
     vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
       err.push(a.join(' '));
     });
     const code = main(argv);
     vi.restoreAllMocks();
     return { code, stdout: out.join('\n'), stderr: err.join('\n') };
   }

   /** One flow with two writes, so whisper has something to schedule. */
   function flowsDoc(): any {
     return {
       version: 1,
       flows: [
         {
           id: 'checkout',
           risk: 5,
           criticalArea: 'src/checkout',
           steps: [
             { id: 'open', action: 'goto', url: '/cart' },
             { id: 'address', action: 'click', selector: '#a', writes: true },
             { id: 'pay', action: 'click', selector: '#p', writes: true },
           ],
         },
         {
           id: 'login',
           risk: 1,
           steps: [{ id: 'open', action: 'goto', url: '/login' }],
         },
       ],
     };
   }

   function targetsDoc(): any {
     return {
       version: 1,
       prodHosts: [],
       targets: {
         staging: {
           baseURL: 'https://staging.example.test',
           environment: 'staging',
           hosts: ['staging.example.test'],
           accounts: { A: { env: 'CRY_A' }, B: { env: 'CRY_B' } },
           auth: {
             signIn: 'login',
             signOut: 'login',
             sessionKeys: ['cookie:session'],
           },
         },
       },
     };
   }

   function inputs(): { dir: string; flows: string; targets: string } {
     const dir = tmp();
     return {
       dir,
       flows: write(dir, 'flows.json', flowsDoc()),
       targets: write(dir, 'targets.json', targetsDoc()),
     };
   }

   describe('command dispatch', () => {
     it.each<[string[], RegExp]>([
       [[], /the following arguments are required: command/],
       [['run'], /'run' is not yet supported \(a later phase of #608\)/],
       [['report'], /'report' is not yet supported/],
       [['frobnicate'], /invalid choice: 'frobnicate'/],
       [['validate', 'extra'], /unrecognized arguments: extra/],
     ])('rejects %j with exit 2', (argv, message) => {
       const r = run(argv);
       expect(r.code).toBe(2);
       expect(r.stderr).toMatch(/^canary-cry: error: /);
       expect(r.stderr).toMatch(message);
       expect(r.stdout).toBe('');
     });
   });

   describe('validate', () => {
     it('passes valid files and says how many flows and targets it read', () => {
       const { flows, targets } = inputs();
       const r = run(['validate', '--flows', flows, '--targets', targets]);
       expect(r.code).toBe(0);
       expect(r.stdout).toBe(
         `canary-cry: valid -- 2 flow(s) in ${flows}, 1 target(s) in ${targets}`,
       );
     });

     it('validates the shipped example files', () => {
       const r = run([
         'validate',
         '--flows',
         FLOWS_EXAMPLE,
         '--targets',
         TARGETS_EXAMPLE,
       ]);
       expect(r.stderr).toBe('');
       expect(r.code).toBe(0);
     });

     it('exits 2 naming the file and JSON path of a schema error (SC5)', () => {
       const { dir, targets } = inputs();
       const doc = flowsDoc();
       doc.flows[0].risk = 0;
       const flows = write(dir, 'bad.json', doc);
       const r = run(['validate', '--flows', flows, '--targets', targets]);
       expect(r.code).toBe(2);
       expect(r.stderr).toContain(
         `canary-cry: error: ${flows}: $.flows[0].risk: must be an integer 1-5`,
       );
     });

     it('exits 2 when either file is missing', () => {
       const { dir, flows } = inputs();
       const missing = path.join(dir, 'nope.json');
       expect(run(['validate', '--flows', missing]).stderr).toContain(
         `flows file not found: ${missing}`,
       );
       const r = run(['validate', '--flows', flows, '--targets', missing]);
       expect(r.code).toBe(2);
       expect(r.stderr).toContain(`targets file not found: ${missing}`);
     });

     it('cross-checks auth flow names against the flows file', () => {
       const { dir, flows } = inputs();
       const doc = targetsDoc();
       doc.targets.staging.auth.signIn = 'sign-in';
       const targets = write(dir, 't.json', doc);
       const r = run(['validate', '--flows', flows, '--targets', targets]);
       expect(r.code).toBe(2);
       expect(r.stderr).toContain(
         "$.targets.staging.auth.signIn: names no flow in flows.json ('sign-in')",
       );
     });
   });

   describe('matrix', () => {
     it('prints the ranked matrix with its ranking source', () => {
       const { flows } = inputs();
       const r = run(['matrix', '--flows', flows]);
       expect(r.code).toBe(0);
       expect(r.stdout.split('\n').slice(0, 2)).toEqual([
         'canary-cry matrix -- amplitude whisper, seed 0, ranking: declared',
         '3 scenario(s) over 1 flow(s); patterns: multi-submit, abandon-midflow; intensity: i1',
       ]);
       expect(r.stdout).toContain('checkout:abandon-midflow:i1:saddress');
     });

     it('prints byte-identical --json for the same input (SC1)', () => {
       const { flows } = inputs();
       const argv = ['matrix', '--flows', flows, '--seed', '42', '--json'];
       const first = run(argv);
       expect(first.code).toBe(0);
       expect(run(argv).stdout).toBe(first.stdout);
       expect(JSON.parse(first.stdout)).toMatchObject({
         format: 'canary.cry-matrix/1',
         seed: 42,
       });
     });

     it('is byte-identical across separate processes too (SC1)', () => {
       const { flows } = inputs();
       const once = () =>
         spawnSync(CLI, ['matrix', '--flows', flows, '--json'], {
           encoding: 'utf8',
           timeout: 20_000,
         });
       const [a, b] = [once(), once()];
       expect(a.status, a.stderr).toBe(0);
       expect(b.stdout).toBe(a.stdout);
     });

     it('emits no matrix when the flows file fails validation (SC5)', () => {
       const { dir } = inputs();
       const flows = write(dir, 'bad.json', {
         version: 1,
         flows: [{ id: 'x' }],
       });
       const r = run(['matrix', '--flows', flows, '--json']);
       expect(r.code).toBe(2);
       expect(r.stdout).toBe('');
       expect(r.stderr).toContain(`${flows}: $.flows[0].risk:`);
     });

     it.each<[string[], RegExp]>([
       [
         ['--amplitude', 'loud'],
         /argument --amplitude: invalid choice: 'loud' \(choose from 'whisper', 'shout', 'scream'\)/,
       ],
       [['--seed', '1.5'], /argument --seed: invalid int value: '1.5'/],
       [['--target', 'prod'], /no target named 'prod' \(declared: staging\)/],
     ])('rejects %j with exit 2', (extra, message) => {
       const { flows, targets } = inputs();
       const r = run([
         'matrix',
         '--flows',
         flows,
         '--targets',
         targets,
         ...extra,
       ]);
       expect(r.code).toBe(2);
       expect(r.stderr).toMatch(message);
       expect(r.stdout).toBe('');
     });

     it('runs shout and scream (the P4 "not yet supported" guard is for run only)', () => {
       const { flows } = inputs();
       for (const amplitude of ['shout', 'scream']) {
         const r = run(['matrix', '--flows', flows, '--amplitude', amplitude]);
         expect(r.code, amplitude).toBe(0);
         expect(r.stdout).toContain(`amplitude ${amplitude}`);
       }
     });

     it('says which target-scoped patterns it skipped without --target', () => {
       const { flows } = inputs();
       const r = run(['matrix', '--flows', flows, '--amplitude', 'shout']);
       expect(r.stdout).toContain(
         'target-scoped patterns not scheduled (no --target): token-expiry, shared-machine',
       );
     });

     it('schedules them for a named target', () => {
       const { flows, targets } = inputs();
       const r = run([
         'matrix',
         '--flows',
         flows,
         '--targets',
         targets,
         '--target',
         'staging',
         '--amplitude',
         'shout',
       ]);
       expect(r.code).toBe(0);
       expect(r.stdout).toContain(', target staging');
       expect(r.stdout).toContain('checkout:token-expiry:i1:saddress');
       expect(r.stdout).not.toContain('not scheduled');
     });

     describe('critical areas (SC4)', () => {
       const areas = {
         areas: [{ path: 'src/checkout/pay.ts', risk_score: 0.9 }],
       };

       it('ranks with an explicit file and prints declared+critical-areas', () => {
         const { dir, flows } = inputs();
         const file = write(dir, 'ca.json', areas);
         const r = run(['matrix', '--flows', flows, '--critical-areas', file]);
         expect(r.code).toBe(0);
         expect(r.stdout).toContain('ranking: declared+critical-areas');
         expect(r.stdout).toContain(' 27  checkout:multi-submit:i1:saddress');
       });

       it('reads the default .canary/critical-areas.json from the working directory', () => {
         const { dir, flows } = inputs();
         const plain = spawnSync(CLI, ['matrix', '--flows', flows], {
           cwd: dir,
           encoding: 'utf8',
           timeout: 20_000,
         });
         expect(plain.stdout).toContain('ranking: declared\n');
         write(dir, '.canary/critical-areas.json', areas);
         const ranked = spawnSync(CLI, ['matrix', '--flows', flows], {
           cwd: dir,
           encoding: 'utf8',
           timeout: 20_000,
         });
         expect(ranked.status, ranked.stderr).toBe(0);
         expect(ranked.stdout).toContain('ranking: declared+critical-areas');
       });

       it('exits 2 for a named file that is missing or malformed', () => {
         const { dir, flows } = inputs();
         const missing = path.join(dir, 'none.json');
         const r = run([
           'matrix',
           '--flows',
           flows,
           '--critical-areas',
           missing,
         ]);
         expect(r.code).toBe(2);
         expect(r.stderr).toContain(
           `critical-areas file not found: ${missing}`,
         );
         const bad = write(dir, 'bad.json', { areas: 'x' });
         const r2 = run(['matrix', '--flows', flows, '--critical-areas', bad]);
         expect(r2.code).toBe(2);
         expect(r2.stderr).toContain(`${bad}: areas:`);
         expect(r2.stdout).toBe('');
       });
     });

     describe('zero scenarios (SC24)', () => {
       const readOnly = {
         version: 1,
         flows: [
           {
             id: 'browse',
             risk: 5,
             steps: [{ id: 'o', action: 'goto', url: '/' }],
           },
         ],
       };

       it('reports ABSTAINED, advisory exit 0', () => {
         const flows = write(tmp(), 'flows.json', readOnly);
         const r = run(['matrix', '--flows', flows]);
         expect(r.code).toBe(0);
         expect(r.stdout).toContain('ABSTAINED: zero scenarios');
         expect(r.stdout).toContain('this is not a pass');
         expect(r.stdout).not.toContain('scenario(s) over');
       });

       it('exits 3 under --strict, in text and in --json', () => {
         const flows = write(tmp(), 'flows.json', readOnly);
         expect(run(['matrix', '--flows', flows, '--strict']).code).toBe(3);
         const r = run(['matrix', '--flows', flows, '--strict', '--json']);
         expect(r.code).toBe(3);
         expect(JSON.parse(r.stdout)).toMatchObject({
           status: 'abstained',
           reason: 'zero scenarios',
         });
       });

       it('keeps exit 0 under --strict when the matrix is not empty', () => {
         const { flows } = inputs();
         expect(run(['matrix', '--flows', flows, '--strict']).code).toBe(0);
       });
     });

     it('builds a target-scoped matrix from the shipped examples', () => {
       const r = run([
         'matrix',
         '--flows',
         FLOWS_EXAMPLE,
         '--targets',
         TARGETS_EXAMPLE,
         '--target',
         'staging',
         '--amplitude',
         'shout',
         '--json',
       ]);
       expect(r.code).toBe(0);
       const m = JSON.parse(r.stdout);
       expect(m.status).toBe('ok');
       expect(new Set(m.scenarios.map((s: any) => s.pattern))).toEqual(
         new Set([
           'multi-submit',
           'abandon-midflow',
           'stale-optimistic',
           'duplicate-tab',
           'token-expiry',
           'shared-machine',
         ]),
       );
     });
   });
   ```

2. Run: `npx vitest run test/canary-cry-cli.test.ts` → fails.
3. Create `agents/skills/claude-code/canary-cry/scripts/cli.mjs`. Do not write
   the tokens `fetch(`, `import(` or `WebSocket` anywhere in this file or its
   imports, comments included: Task 10's closure test would flag them.

   ```js
   #!/usr/bin/env node
   // canary-cry -- pre-launch "try to break it" sweep of ordinary user flows.
   //
   // Phase 1 (#608 P1) ships the Tier-0 half: deterministic, no network, no agent.
   //
   //   validate  check .canary/cry/flows.json and targets.json; every error names
   //             the JSON path at fault
   //   matrix    the ranked scenario matrix: flows x the abuse-pattern catalog,
   //             cut to an --amplitude budget; same input, byte-identical --json
   //
   // `run` and `report` arrive in later phases and exit 2 "not yet supported"
   // until then, rather than doing something smaller under the same name.
   //
   // Exit codes: 0 ok (advisory), 2 usage or schema error, 3 --strict and the
   // matrix abstained (zero scenarios). 1 and 4 (ADR 0046: refused by a safety
   // gate) belong to `run`.
   //
   // Invoked via `canary skills run canary-cry -- <command> [options]`.

   import fs from 'node:fs';

   import {
     createParser,
     formatUsageError,
     EXIT_USAGE,
   } from '../../../lib/parse-args.mjs';
   import { isMain } from '../../../lib/is-main.mjs';
   import { validateCriticalAreas } from '../../../lib/contracts/critical-areas.mjs';
   import { readJsonFile } from './schema-core.mjs';
   import { loadFlows, loadTargets } from './schema.mjs';
   import { AMPLITUDES, buildMatrix, matrixJson } from './matrix.mjs';

   const PROG = 'canary-cry';
   const EXIT_ABSTAINED = 3;

   // #508 convention line, written as escapes so this source stays ASCII (the
   // same wording as ts/src/core/gate-result.ts and the other skill CLIs).
   const ABSTAINED_LINE =
     '\u{26A0} Abstained \u{2014} verified zero items; this is not a pass.';

   const DEFAULT_AREAS = '.canary/critical-areas.json';
   const LATER = new Set(['run', 'report']);

   const USAGE =
     'usage: canary-cry [-h] {validate,matrix} [--flows PATH] [--targets PATH]\n' +
     '                  [--target NAME] [--critical-areas PATH]\n' +
     '                  [--amplitude {whisper,shout,scream}] [--seed N]\n' +
     '                  [--json] [--strict]\n' +
     '\n' +
     'Pre-launch "try to break it" sweep of ordinary user flows. This phase ships\n' +
     'the deterministic scenario matrix: no network, no agent.\n' +
     '\n' +
     'commands:\n' +
     '  validate              check flows.json and targets.json\n' +
     '  matrix                rank flows x abuse patterns, cut to a budget\n' +
     '\n' +
     'options:\n' +
     '  -h, --help            show this help message and exit\n' +
     '  --flows PATH          flows file (default: .canary/cry/flows.json)\n' +
     '  --targets PATH        targets file (default: .canary/cry/targets.json)\n' +
     '  --target NAME         matrix: also schedule the target-scoped patterns\n' +
     '  --critical-areas PATH matrix: rank with critical areas (default:\n' +
     '                        .canary/critical-areas.json, when present)\n' +
     '  --amplitude A         matrix budget: whisper (default), shout, scream\n' +
     '  --seed N              recorded for {{unique.*}} test data; never selects\n' +
     '                        scenarios (default: 0)\n' +
     '  --json                matrix: print the canonical matrix.json document\n' +
     '  --strict              matrix: exit 3 when the matrix abstained';

   export const CLI_SPEC = {
     prog: PROG,
     booleans: { '--json': 'json', '--strict': 'strict' },
     values: {
       '--flows': { key: 'flows' },
       '--targets': { key: 'targets' },
       '--target': { key: 'target' },
       '--critical-areas': { key: 'criticalAreas' },
       '--amplitude': { key: 'amplitude' },
       '--seed': { key: 'seed', type: 'int' },
     },
     defaults: {
       flows: '.canary/cry/flows.json',
       targets: '.canary/cry/targets.json',
       amplitude: 'whisper',
       seed: 0,
     },
     positionals: { key: 'command' },
   };

   const parseArgs = createParser(CLI_SPEC);

   const COMMANDS = { validate: validateCommand, matrix: matrixCommand };

   /** A usage error for argv, or null. */
   function usageError(error, positionals) {
     if (error) return error;
     const [command, ...extra] = positionals;
     if (command === undefined) {
       return 'the following arguments are required: command';
     }
     if (LATER.has(command)) {
       return `'${command}' is not yet supported (a later phase of #608)`;
     }
     if (!Object.hasOwn(COMMANDS, command)) {
       return `argument command: invalid choice: '${command}' (choose from 'validate', 'matrix')`;
     }
     if (extra.length) return `unrecognized arguments: ${extra.join(' ')}`;
     return null;
   }

   function fail(lines) {
     for (const line of lines) console.error(formatUsageError(PROG, line));
     return EXIT_USAGE;
   }

   const flowIds = (doc) => new Set(doc.flows.map((f) => f.id));
   const targetNames = (doc) =>
     Object.keys(doc.targets).filter((k) => k !== '//');

   function validateCommand(opts) {
     const flows = loadFlows(opts.flows);
     if (flows.errors.length) return fail(flows.errors);
     const targets = loadTargets(opts.targets, flowIds(flows.doc));
     if (targets.errors.length) return fail(targets.errors);
     const nFlows = flows.doc.flows.length;
     const nTargets = targetNames(targets.doc).length;
     console.log(
       `${PROG}: valid -- ${nFlows} flow(s) in ${opts.flows}, ` +
         `${nTargets} target(s) in ${opts.targets}`,
     );
     return 0;
   }

   /** `{value: {name, spec} | null, errors}`; targets.json is read only for --target. */
   function resolveTarget(opts, flowsDoc) {
     if (opts.target === null) return { value: null, errors: [] };
     const targets = loadTargets(opts.targets, flowIds(flowsDoc));
     if (targets.errors.length) return { value: null, errors: targets.errors };
     const names = targetNames(targets.doc);
     if (!names.includes(opts.target)) {
       const known = names.join(', ');
       const error = `${opts.targets}: no target named '${opts.target}' (declared: ${known})`;
       return { value: null, errors: [error] };
     }
     const spec = targets.doc.targets[opts.target];
     return { value: { name: opts.target, spec }, errors: [] };
   }

   /**
    * critical-areas.json. The default path may be absent: the ranking then stays
    * `declared` and says so. A path given with --critical-areas must exist, and a
    * file that is present but malformed is an input error either way -- a
    * ranking boost is never guessed from a file that does not validate.
    */
   function loadAreas(explicit) {
     const file = explicit ?? DEFAULT_AREAS;
     if (explicit === null && !fs.existsSync(file)) {
       return { value: null, errors: [] };
     }
     const read = readJsonFile(file, 'critical-areas');
     if (read.error !== undefined) return { value: null, errors: [read.error] };
     const { errors } = validateCriticalAreas(read.doc);
     if (errors.length) {
       const lines = errors.map((e) => `${file}: ${e.path}: ${e.message}`);
       return { value: null, errors: lines };
     }
     return { value: read.doc.areas, errors: [] };
   }

   function renderMatrix(m) {
     const where = m.target === null ? '' : `, target ${m.target}`;
     const lines = [
       `${PROG} matrix -- amplitude ${m.amplitude}, seed ${m.seed}, ` +
         `ranking: ${m.ranking}${where}`,
     ];
     if (m.status === 'abstained') {
       lines.push(
         `ABSTAINED: zero scenarios -- no scheduled pattern ` +
           `(${m.patterns.join(', ')}) applies to any declared step.`,
       );
       lines.push(ABSTAINED_LINE);
     } else {
       const rounds = m.intensities.map((n) => `i${n}`).join(', ');
       lines.push(
         `${m.scenarios.length} scenario(s) over ${m.flows.length} flow(s); ` +
           `patterns: ${m.patterns.join(', ')}; intensity: ${rounds}`,
       );
       for (const s of m.scenarios) {
         lines.push(`  ${String(s.score).padStart(3)}  ${s.id}`);
       }
     }
     if (m.unscheduled.length) {
       const names = m.unscheduled.map((u) => u.pattern).join(', ');
       lines.push(
         `target-scoped patterns not scheduled (no --target): ${names}`,
       );
     }
     return lines.join('\n');
   }

   function amplitudeError(amplitude) {
     if (Object.hasOwn(AMPLITUDES, amplitude)) return null;
     const choices = Object.keys(AMPLITUDES).map((a) => `'${a}'`);
     return (
       `argument --amplitude: invalid choice: '${amplitude}' ` +
       `(choose from ${choices.join(', ')})`
     );
   }

   function matrixCommand(opts) {
     const bad = amplitudeError(opts.amplitude);
     if (bad !== null) return fail([bad]);
     const flows = loadFlows(opts.flows);
     if (flows.errors.length) return fail(flows.errors);
     const target = resolveTarget(opts, flows.doc);
     if (target.errors.length) return fail(target.errors);
     const areas = loadAreas(opts.criticalAreas);
     if (areas.errors.length) return fail(areas.errors);
     const matrix = buildMatrix({
       flows: flows.doc.flows,
       amplitude: opts.amplitude,
       seed: opts.seed,
       target: target.value,
       areas: areas.value,
     });
     console.log(opts.json ? matrixJson(matrix) : renderMatrix(matrix));
     return matrix.status === 'abstained' && opts.strict ? EXIT_ABSTAINED : 0;
   }

   /** @param {string[]} argv */
   export function main(argv = []) {
     const { opts, positionals, help, error } = parseArgs(argv);
     if (help) {
       console.log(USAGE);
       return 0;
     }
     const bad = usageError(error, positionals);
     if (bad) {
       console.error(formatUsageError(PROG, bad));
       return EXIT_USAGE;
     }
     try {
       return COMMANDS[positionals[0]](opts);
     } catch (exc) {
       console.error(`${PROG}: ${exc.message}`);
       return 1;
     }
   }

   // `process.exitCode`, not `process.exit()`: a large `--json` payload must
   // drain before the process ends (#791).
   if (isMain(import.meta.url)) {
     process.exitCode = main(process.argv.slice(2));
   }
   ```

4. `chmod 755 /Users/bs/Github/canary-608-cry-p1/agents/skills/claude-code/canary-cry/scripts/cli.mjs`.
   Git must record mode 100755, which you can confirm after staging with
   `git -C /Users/bs/Github/canary-608-cry-p1 ls-files -s agents/skills/claude-code/canary-cry/scripts/cli.mjs`.
5. Edit `SKILL.md` in two places. First, add the line `cli: scripts/cli.mjs`
   between `description:` and `requires:`. Second, insert this section under the
   H1, before the last paragraph:

   ````markdown
   ## Quick start

   ```bash
   canary skills run canary-cry -- --help
   ```
   ````

   `skill-examples.test.ts` requires every `cli:` skill to document one
   runnable, help-shaped example.

6. Run:
   `npx vitest run test/canary-cry-cli.test.ts test/skill-cli-conformance.test.ts`
   → all pass. Then, all passing:

   ```bash
   cd /Users/bs/Github/canary-608-cry-p1/ts
   npx vitest run test/skill-examples.test.ts test/skill-cli-executable.test.ts \
     test/skill-surfaces.test.ts test/plugin-skills.test.ts
   ```

7. Prettier; `harness validate`.
8. Commit: `feat(canary-cry): add the validate and matrix commands (#608 P1)`

### Task 9: Zero-scenario row in the gate-conformance registry (SC24)

**Depends on:** Task 8 | **Files:**
`agents/skills/test/gate-conformance.test.ts`

1. Edit `agents/skills/test/gate-conformance.test.ts`. First, add this after the
   `unquarantineMain` import:

   ```ts
   import { main as cryMain } from '../claude-code/canary-cry/scripts/cli.mjs';
   ```

   Second, append this row to `ROWS`, after the `canary-barda` row:

   ```ts
     {
       // flows.json parses and validates but declares no flow, so the matrix
       // holds zero scenarios. The tempting read is "nothing to attack, the
       // flows are safe"; in fact nothing was scheduled at all (#608, SC24).
       command: 'canary-cry matrix (zero scenarios)',
       forbid: ['scenario(s) over'],
       run: (base) => run(cryMain, ['matrix', '--flows', emptyFlows(base)]),
       strict: (base) =>
         run(cryMain, ['matrix', '--flows', emptyFlows(base), '--strict']),
     },
   ```

   Third, add this helper next to `emptyDiff`:

   ```ts
   /** A valid flows.json that declares no flow: zero scenarios to schedule. */
   function emptyFlows(base: string): string {
     const file = path.join(base, 'flows.json');
     fs.writeFileSync(file, JSON.stringify({ version: 1, flows: [] }));
     return file;
   }
   ```

2. Plant first, to prove the row bites. Back up `cli.mjs` to the scratchpad and
   change `EXIT_ABSTAINED = 3` to `0`. Run
   `npx vitest run test/gate-conformance.test.ts` and expect the
   `inherits exit 3 under --strict` row for canary-cry to fail. Restore from the
   copy.
3. Run → all pass. Prettier; `harness validate`.
4. Commit: `test(canary-cry): register the zero-scenario abstention (#608 P1)`

### Task 10: Tier-0 import-closure test (SC6)

**Depends on:** Task 8 | **Files:** `agents/skills/test/canary-cry-tier.test.ts`

1. Create `agents/skills/test/canary-cry-tier.test.ts`:

   ```ts
   /**
    * canary-cry's Tier-0 half imports no network, process or model module
    * (#608 SC6).
    *
    * `validate` and `matrix` are deterministic, offline and agent-free by
    * contract (spec "Capability axes"; ADR 0015). Nothing else enforces it: an
    * `import 'node:http'` or a bare global fetch added under scripts/ would keep
    * every other gate green. This walks the STATIC import closure of cli.mjs --
    * every relative specifier, transitively, the method of
    * ts/test/gen-data-model-free.test.ts -- and forbids network, process and
    * model-SDK modules anywhere in it, plus the network globals that need no
    * import at all.
    *
    * Later phases add `run`, which needs a browser and a child process. It must
    * arrive through a lazy dynamic import of a separate run module, so this
    * closure stays the Tier-0 one. Dynamic imports are LISTED, never skipped:
    * the day one lands in the closure this test fails and forces that review.
    */
   import fs from 'node:fs';
   import os from 'node:os';
   import path from 'node:path';
   import { fileURLToPath } from 'node:url';

   import { afterEach, describe, expect, it } from 'vitest';

   const HERE = path.dirname(fileURLToPath(import.meta.url));
   const SKILLS = path.join(HERE, '..');
   const CLI = path.join(
     SKILLS,
     'claude-code',
     'canary-cry',
     'scripts',
     'cli.mjs',
   );

   /** Bare specifiers that reach a network, a process, or a model. */
   const FORBIDDEN = [
     /^(node:)?(http|https|http2|net|tls|dgram|dns|child_process|cluster|worker_threads)$/,
     /^(undici|ws|axios|node-fetch|playwright|playwright-core|@playwright\/test)$/,
     /^(@anthropic-ai\/|openai$|@openai\/|@google\/genai|@google\/generative-ai|@ai-sdk\/|ai$|langchain|@langchain\/)/,
   ];
   /** Globals that reach the network with no import. */
   const NETWORK_GLOBALS =
     /\bfetch\s*\(|\bWebSocket\b|\bXMLHttpRequest\b|\bEventSource\b/;
   const STATIC_IMPORT =
     /^\s*(?:import|export)\s[^'"]*?\sfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm;
   const DYNAMIC_IMPORT = /\bimport\s*\(/;

   interface Closure {
     files: string[];
     bare: string[];
     dynamic: string[];
     globals: string[];
   }

   function closure(entry: string): Closure {
     const seen = new Set<string>();
     const bare = new Set<string>();
     const dynamic: string[] = [];
     const globals: string[] = [];
     const queue = [entry];
     while (queue.length) {
       const file = queue.pop()!;
       if (seen.has(file)) continue;
       seen.add(file);
       const src = fs.readFileSync(file, 'utf8');
       for (const m of src.matchAll(STATIC_IMPORT)) {
         const spec = m[1] ?? m[2]!;
         if (spec.startsWith('.'))
           queue.push(path.resolve(path.dirname(file), spec));
         else bare.add(spec);
       }
       if (DYNAMIC_IMPORT.test(src)) dynamic.push(file);
       if (NETWORK_GLOBALS.test(src)) globals.push(file);
     }
     const rel = (f: string) =>
       path.relative(SKILLS, f).split(path.sep).join('/');
     return {
       files: [...seen].map(rel).sort(),
       bare: [...bare].sort(),
       dynamic: dynamic.map(rel).sort(),
       globals: globals.map(rel).sort(),
     };
   }

   const forbidden = (specs: string[]) =>
     specs.filter((s) => FORBIDDEN.some((re) => re.test(s)));

   describe('canary-cry Tier-0 import closure (SC6)', () => {
     const c = closure(CLI);

     it('walks the modules it claims to (a vacuous walk would pass anything)', () => {
       expect(c.files).toEqual(
         expect.arrayContaining([
           'claude-code/canary-cry/scripts/cli.mjs',
           'claude-code/canary-cry/scripts/schema.mjs',
           'claude-code/canary-cry/scripts/schema-core.mjs',
           'claude-code/canary-cry/scripts/schema-targets.mjs',
           'claude-code/canary-cry/scripts/matrix.mjs',
           'claude-code/canary-cry/scripts/patterns.mjs',
           'lib/parse-args.mjs',
           'lib/contracts/critical-areas.mjs',
         ]),
       );
       expect(c.bare).toContain('node:fs');
     });

     it('imports no network, process or model module', () => {
       expect(forbidden(c.bare)).toEqual([]);
     });

     it('touches no network global', () => {
       expect(c.globals).toEqual([]);
     });

     it('has no dynamic import (the future run path must stay outside)', () => {
       expect(c.dynamic).toEqual([]);
     });
   });

   describe('the closure check bites', () => {
     const tmps: string[] = [];
     afterEach(() => {
       while (tmps.length)
         fs.rmSync(tmps.pop()!, { recursive: true, force: true });
     });

     it('flags a forbidden import two hops away, a global, and a dynamic import', () => {
       const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-cry-tier-'));
       tmps.push(dir);
       fs.writeFileSync(
         path.join(dir, 'entry.mjs'),
         "import { x } from './a.mjs';\n",
       );
       fs.writeFileSync(
         path.join(dir, 'a.mjs'),
         "export { y as x } from './b.mjs';\n",
       );
       fs.writeFileSync(
         path.join(dir, 'b.mjs'),
         "import https from 'node:https';\n" +
           'export const y = () => fetch(https);\n' +
           "export const z = () => import('./c.mjs');\n",
       );
       const c = closure(path.join(dir, 'entry.mjs'));
       expect(forbidden(c.bare)).toEqual(['node:https']);
       expect(c.globals).toHaveLength(1);
       expect(c.dynamic).toHaveLength(1);
     });
   });
   ```

2. Run `npx vitest run test/canary-cry-tier.test.ts` → all 5 pass. This test
   asserts an existing property, so its "red" is the built-in plant case. Also
   plant for real: back up `matrix.mjs`, append `import 'node:http';`, confirm
   the forbidden-import case fails, then restore from the copy.
3. Prettier; `harness validate`.
4. Commit: `test(canary-cry): pin the Tier-0 import closure (#608 P1)`

### Task 11: Format, coverage and entry-point registrations

**Depends on:** Task 8 | **Files:** `agents/skills/package.json`,
`agents/skills/vitest.config.ts`, `harness.config.json` | **Category:**
integration

1. `agents/skills/package.json` `format:check`: add the glob below after the
   `canary-cassandra` glob, inside the escaped-quote list, with one space before
   and after. The spec asks for `**/*.mjs`; `json` is added so the example files
   stay formatted.

   ```text
   \"claude-code/canary-cry/scripts/**/*.{mjs,json}\"
   ```

2. `agents/skills/vitest.config.ts` `coverage.include`: add
   `'claude-code/canary-cry/scripts/*.mjs',` after
   `'claude-code/canary-cassandra/scripts/**/*.mjs',`. It is top-level only,
   like canary-misfit, so P3's `scripts/runtime/cry-runtime.mjs` (needs a live
   browser) does not drag the gate down.
3. `harness.config.json`: add
   `"agents/skills/claude-code/canary-cry/scripts/cli.mjs",` after
   `"agents/skills/claude-code/canary-cassandra/scripts/engine.mjs",` in
   **both** `entropy.entryPoints` (≈line 214) **and** `performance.entryPoints`
   (≈line 400). Verify with
   `grep -c 'canary-cry/scripts/cli.mjs' /Users/bs/Github/canary-608-cry-p1/harness.config.json`
   → `2`. Never touch `maxFindings`.
4. Run the gates below. They should be green, with the coverage thresholds of
   90/90/85/90 holding.

   ```bash
   cd /Users/bs/Github/canary-608-cry-p1/agents/skills
   npm run format:check && npm test
   ```

5. `cd /Users/bs/Github/canary-608-cry-p1 && harness validate`
6. Commit:
   `chore(canary-cry): register with format, coverage, entropy (#608 P1)`

### Task 12: Full P1 SKILL.md + docs-drift test

**Depends on:** Task 11 | **Files:**
`agents/skills/claude-code/canary-cry/SKILL.md`,
`agents/skills/test/canary-cry-docs.test.ts`

`[checkpoint:human-verify]` — Show the rendered SKILL.md (description, pattern
table, exit codes) to the human before committing.

1. Create `agents/skills/test/canary-cry-docs.test.ts`:

   ```ts
   /**
    * canary-cry's SKILL.md says what the P1 code does (#608 P1; the full SC20
    * check lands with `run` and `report` in P5).
    *
    * The pattern table and the budget table are copies of data the code owns
    * (patterns.mjs, matrix.mjs AMPLITUDES), so they are read back against it: a
    * re-weighted pattern or a re-sized budget fails here, not in a reader's head.
    */
   import fs from 'node:fs';
   import path from 'node:path';
   import { fileURLToPath } from 'node:url';

   import { describe, expect, it } from 'vitest';

   import { AMPLITUDES } from '../claude-code/canary-cry/scripts/matrix.mjs';
   import { PATTERNS } from '../claude-code/canary-cry/scripts/patterns.mjs';

   const HERE = path.dirname(fileURLToPath(import.meta.url));
   const SKILL_MD = fs.readFileSync(
     path.join(HERE, '..', 'claude-code', 'canary-cry', 'SKILL.md'),
     'utf8',
   );

   // Prose is re-wrapped by prettier (proseWrap: always), so a literal sentence is
   // matched with its whitespace collapsed.
   const PROSE = SKILL_MD.replace(/\s+/g, ' ');

   const row = (first: string) =>
     SKILL_MD.split('\n').find((l) =>
       new RegExp(`^\\|\\s*${first}\\s*\\|`).test(l),
     );
   const cells = (line: string | undefined) =>
     (line ?? '')
       .split('|')
       .slice(1, -1)
       .map((c) => c.trim());

   describe('canary-cry SKILL.md (P1)', () => {
     it.each(['validate', 'matrix'])('has a section for `%s`', (command) => {
       expect(SKILL_MD).toMatch(new RegExp(`^## \`${command}\``, 'm'));
     });

     it.each(['0', '2', '3'])('has an exit-code row for %s', (code) => {
       expect(row(`\`${code}\``), `exit ${code}`).toBeDefined();
     });

     it('documents the abstention line verbatim', () => {
       expect(PROSE).toContain('ABSTAINED: zero scenarios');
     });

     it('states the server-side limit line verbatim', () => {
       expect(PROSE).toContain(
         'server-side side effects (email, webhooks, payments) are NOT intercepted by canary-cry.',
       );
     });

     it.each(PATTERNS.map((p) => [p.id, p]))(
       'lists pattern %s with its catalog weight and core flag',
       (id, p: any) => {
         const [, core, weight] = cells(row(`\`${id}\``));
         expect(weight, id).toBe(String(p.weight));
         expect(core, id).toBe(p.core ? 'yes' : 'no');
       },
     );

     it.each(Object.entries(AMPLITUDES))(
       'states the %s radius the matrix uses',
       (name, budget: any) => {
         const [, radius] = cells(row(`\`${name}\``));
         const expected =
           budget.radius === Infinity
             ? 'all flows'
             : `top ${budget.radius} flows`;
         expect(radius, name).toBe(expected);
       },
     );
   });
   ```

2. Run `npx vitest run test/canary-cry-docs.test.ts` → fails (sections missing).
3. Replace `agents/skills/claude-code/canary-cry/SKILL.md` with:

   ````markdown
   ---
   name: canary-cry
   description:
     Pre-launch "try to break it" sweep of ordinary user flows, run ahead of a
     launch, a client onboarding or a demo so a sales demo never has to explain
     away a bug. It abuses flows the way real people do (an impatient
     double-submit on a slow network, abandoning a multi-form flow after it
     wrote partial rows, a second user on a shared machine, a duplicated tab, a
     token that expires mid-flow) and judges by state corruption, not by
     rendering. This release ships the deterministic half. `validate` checks the
     declared .canary/cry/flows.json and targets.json and names the JSON path of
     every error; `matrix` emits the ranked scenario matrix (flows x abuse
     patterns, cut to a whisper, shout or scream budget) with no network and no
     agent. Live runs against an allowlisted non-prod target arrive in later
     phases. NOT input fuzzing and NOT targeted bug pursuit (that is
     canary-huntress).
   cli: scripts/cli.mjs
   requires: [node>=20]
   ---

   # Canary Cry

   A demo that dies on a double-click was never tested the way a nervous buyer
   clicks. canary-cry sweeps **ordinary user flows** with the abuse real people
   commit, and its success criterion is **state corruption**: the platform left
   in a bad state, not a pixel out of place.

   This phase ships the **Tier-0 half** by the definition in
   [ADR 0015](../../../../docs/knowledge/decisions/0015-skill-capability-vocabulary.md):
   `validate` and `matrix` are deterministic, need no network and call no agent.
   The live tier (`run`, `report`) arrives in later phases behind the
   confirmed-manifest gate of
   [ADR 0046](../../../../docs/knowledge/decisions/0046-live-target-skills-confirmed-manifest-no-replay-no-finding.md).
   Until then both exit 2 with `not yet supported` rather than doing something
   smaller under the same name. The full design is
   [the canary-cry spec](../../../../docs/changes/canary-cry/proposal.md).

   When live runs land, this limit holds for every one of them and is printed in
   every manifest: server-side side effects (email, webhooks, payments) are NOT
   intercepted by canary-cry.

   ## Quick start

   ```bash
   canary skills run canary-cry -- --help
   ```

   <!-- canary:illustrative -->

   ```bash
   canary skills run canary-cry -- validate
   canary skills run canary-cry -- matrix --amplitude whisper
   canary skills run canary-cry -- matrix --target staging --amplitude shout --json
   ```

   Start from the examples in this skill:
   [`flows.example.json`](scripts/flows.example.json) and
   [`targets.example.json`](scripts/targets.example.json). Copy them to
   `.canary/cry/` in the project under test. Both files are meant to be
   committed, and neither ever holds a secret.

   ## Inputs

   `.canary/cry/flows.json` declares the flows to attack. The agent layer may
   draft it later; the human confirms it, and the engine reads only the file.

   - A flow has an `id`, a `risk` from 1 to 5, optional `criticalArea` (a path
     joined to `.canary/critical-areas.json`), `steps`, optional `invariants`,
     and optional `symptoms.selectors`.
   - A step `action` is one of `goto`, `fill`, `click`, `select`, `press`,
     `waitFor`. `writes: true` marks a step that mutates server state;
     `awaitResponse: "POST /api/orders"` names the response it waits on.
     Patterns key off both.
   - An invariant pairs a **read-only** `probe` with an `expect`. A probe is
     either `http` (`method` and a `/path` against the target's `baseURL`) or
     `shell` (an `argv` array, run with `execFile`, never a shell string).
     `expect` is `{ "jsonPath"?: "$...", "delta": n }` or `{ "equals": value }`.
     A probe that writes invalidates its own before/after comparison.
   - Template values: `{{account.<K>.<field>}}`, `{{fixture.<name>}}` (from the
     top-level `fixtures` map) and `{{unique.<kind>}}`.
   - Ids are lowercase letters, digits and `-`. A `:` is never legal: it
     separates the fields of a scenario id.

   `.canary/cry/targets.json` declares where a live run may go: `prodHosts`
   (always refused) and named `targets`, each with `baseURL`, `environment`,
   `hosts`, optional `accounts` (each an env-var **name**, never a value) and
   optional `auth` (`signIn` and `signOut` flow ids, and `sessionKeys` such as
   `cookie:session`).

   Unknown keys are errors in both files, so a typo such as `write` for `writes`
   fails at the desk. A `"//"` key is a comment and is allowed in any object.

   ## `validate`

   ```text
   canary-cry validate [--flows PATH] [--targets PATH]
   ```

   Checks both files and cross-checks that `auth.signIn` and `auth.signOut` name
   declared flows. Every error names the file and the JSON path at fault, and
   the command exits 2:

   ```text
   canary-cry: error: .canary/cry/flows.json: $.flows[0].steps[2].action: must be one of goto, fill, click, select, press, waitFor
   ```

   `validate` checks **shape only**. Whether an `environment` may run and
   whether a host is production are the live gate's rules (exit 4, ADR 0046),
   not schema errors.

   ## `matrix`

   ```text
   canary-cry matrix [--flows PATH] [--target NAME] [--targets PATH]
                     [--critical-areas PATH] [--amplitude A] [--seed N]
                     [--json] [--strict]
   ```

   The ranked scenario matrix: every declared flow crossed with the
   abuse-pattern catalog, ranked and cut to a budget.

   - **Score** is `flow.risk x pattern.weight`, plus 2 when
     `.canary/critical-areas.json` has an area at or under the flow's
     `criticalArea` with `risk_score >= 0.7`. A flow ranks by its best scenario;
     a flow no pattern applies to is not ranked. Ties break on id.
   - The first line prints the ranking source: `ranking: declared`, or
     `ranking: declared+critical-areas` when the critical-areas file is read.
     The default path is used when present. A path named with `--critical-areas`
     must exist, and a file that is present but malformed is an exit-2 error,
     never a guessed boost.
   - **Scenario id** is `<flow>:<pattern>:i<n>:s<step>`, with the step's id.
   - `--seed N` (default 0) is recorded in the matrix and feeds only
     `{{unique.*}}` test data at run time. It never selects a scenario.
   - `--target NAME` reads `targets.json` and schedules the two target-scoped
     patterns. Without it they are listed on a
     `target-scoped patterns not scheduled (no --target)` line, never silently
     dropped.
   - `--json` prints the canonical `canary.cry-matrix/1` document. The same
     flows, amplitude, seed, target and critical areas give byte-identical
     output.
   - A matrix with no scenario prints `ABSTAINED: zero scenarios`. That is an
     abstention, not a pass: `--strict` turns it into exit 3.

   | Amplitude | Radius      | Patterns | Rounds (intensity) |
   | --------- | ----------- | -------- | ------------------ |
   | `whisper` | top 3 flows | core     | i1                 |
   | `shout`   | top 8 flows | all      | i1, i2             |
   | `scream`  | all flows   | all      | i1, i2, i3         |

   `scream` lists every round up to the ceiling. Stopping early after two barren
   rounds is a property of a live run, not of the matrix.

   ## Abuse patterns

   | Pattern            | Core | Weight | Applies to                                                  | Intensity 1 / 2 / 3                                   |
   | ------------------ | ---- | ------ | ----------------------------------------------------------- | ----------------------------------------------------- |
   | `multi-submit`     | yes  | 5      | each step with `writes`                                     | 2x @ no throttle / 3x @ 400 ms / 5x @ 3 s             |
   | `abandon-midflow`  | yes  | 4      | each `writes` step that is not the last step                | back / reload / context.close()                       |
   | `stale-optimistic` | no   | 4      | each step with `awaitResponse`                              | delay past UI timeout / fake 500 / drop               |
   | `duplicate-tab`    | no   | 3      | each step with `writes`                                     | 2 / 3 / 3 tabs racing                                 |
   | `token-expiry`     | no   | 3      | the first `writes` step, on a target with session keys      | before the write / between writes / before every step |
   | `shared-machine`   | no   | 5      | the last step, on a target with accounts A and B and `auth` | sign-out / sign-out + back / no sign-out              |

   ## Exit codes

   | Code | Meaning                                                                                                                                      |
   | ---- | -------------------------------------------------------------------------------------------------------------------------------------------- |
   | `0`  | Success. Advisory by default: an abstained matrix still exits 0 without `--strict`.                                                          |
   | `2`  | Usage or input error: an unknown flag or command, `run`/`report` (not yet supported), a file not found or not valid JSON, or a schema error. |
   | `3`  | `--strict` and the matrix abstained (zero scenarios).                                                                                        |

   Exit 1 (`--strict` and a state-verified corruption) and exit 4 (refused by a
   safety gate, ADR 0046) belong to `run` and arrive with it.

   ## Limits in this phase

   - No live run, no report: `run` and `report` exit 2 `not yet supported`.
   - `{{unique.<kind>}}` is checked for syntax only; the kinds are fixed with
     the runtime that generates them.
   - Account references in flows are not yet checked against a target's
     accounts. That check needs the env vars, so it belongs to the live gate.
   ````

4. Run the docs test again (pass), then these engine-side checks (pass):

   ```bash
   cd /Users/bs/Github/canary-608-cry-p1/ts
   npx vitest run test/skill-examples.test.ts test/doc-links.test.ts \
     test/entropy-doc-paths.test.ts test/plugin-skills.test.ts
   ```

5. Format, lint and validate:

   ```bash
   cd /Users/bs/Github/canary-608-cry-p1
   npx --prefix agents/skills prettier --write \
     agents/skills/claude-code/canary-cry/SKILL.md
   npx --yes markdownlint-cli agents/skills/claude-code/canary-cry/SKILL.md
   node scripts/check_doc_fences.mjs && harness validate
   ```

6. Commit: `docs(canary-cry): document validate and matrix (#608 P1)`

### Task 13: agents/skills README

**Depends on:** Task 12 | **Files:** `agents/skills/README.md` | **Category:**
integration

1. Make these edits to `agents/skills/README.md`:
   - Structure tree: insert `│   ├── canary-cry/` after
     `│   ├── canary-critical-areas/`. Change `# Claude Code skills (36)` to
     `(38)`. The tree already lists 37 directories, so the old count is
     pre-existing drift, corrected in passing on the same line.
   - Under `### Discovery & prioritization`, add this bullet after
     canary-critical-areas:

     ```markdown
     - [`canary-cry`](./claude-code/canary-cry/SKILL.md) — Bundled executable
       skill (`scripts/cli.mjs`). Pre-launch "try to break it" sweep of ordinary
       user flows. This phase ships the deterministic half: `validate` checks
       `.canary/cry/flows.json` and `targets.json`, and `matrix` ranks flows ×
       abuse patterns (double-submit, abandon mid-flow, duplicate tab, token
       expiry, shared machine, stale optimistic UI) into a whisper/shout/scream
       budget. A matrix with zero scenarios abstains instead of reading as
       clean. Live runs arrive later behind ADR 0046's confirmed-manifest gate.
     ```

   - Under `### Programmatic`, insert `` `canary-cry`, `` after
     `` `canary-cassandra`, `` in the Node-entry list.
2. `npx prettier --write agents/skills/README.md`;
   `npx --yes markdownlint-cli agents/skills/README.md`;
   `cd ts && npx vitest run test/doc-links.test.ts`.
3. `harness validate`
4. Commit: `docs(skills): list canary-cry in the skills README (#608 P1)`

### Task 14: Four gates (from `ts/` and `agents/skills/`)

**Depends on:** Task 13 | **Files:** none (fix-forward commits only if something
fails)

This repo has no lint script. Gate on each exit code with `&&`, never `;` and
never `$?` after a pipe.

1. Engine gates:

   ```bash
   cd /Users/bs/Github/canary-608-cry-p1/ts
   npm run build && npm run typecheck && npm run format:check && npm test
   ```

2. Skills gates:

   ```bash
   cd /Users/bs/Github/canary-608-cry-p1/agents/skills
   npm run typecheck && npm run format:check && npm test
   ```

3. Docs lint, the same way CI runs it:

   ```bash
   cd /Users/bs/Github/canary-608-cry-p1
   npx --yes markdownlint-cli "**/*.md" --ignore node_modules --ignore plugins \
     --ignore agents/agents --ignore agents/commands
   node scripts/check_doc_fences.mjs
   ```

4. Rebuild before trusting a CLI result (step 1 did), then run the checks below.
   `--help` should exit 0, and the matrix should print 3 scenarios.

   ```bash
   cd /Users/bs/Github/canary-608-cry-p1
   node ts/bin/canary.js skills run canary-cry -- --help
   node ts/bin/canary.js skills run canary-cry -- matrix \
     --flows agents/skills/claude-code/canary-cry/scripts/flows.example.json
   ```

5. Denominator check (rule 2): confirm the skills suite's test count rose by
   about 130 over the Task 1 baseline. Also confirm `canary-cry` appears in the
   conformance and gate-conformance output, so a zero-row pass cannot hide.

### Task 15: Ratchets from the repo ROOT, in a clean worktree

**Depends on:** Task 14 | **Files:** none, or allowance files only if the human
approves

`[checkpoint:human-verify]` — If any ratchet needs an allowance or a restamp,
stop and show the numbers. Never raise `maxFindings` or lower a floor.

Local gates miss dead exports, perf deltas, arch size and docs coverage. Measure
in fresh detached worktrees of base and head, because the shared tree
over-counts: `npm test` stages `npm/agents/`. Pass SHAs, not `HEAD`.

1. Create the two worktrees:

   ```bash
   W=/Users/bs/Github/canary-608-cry-p1
   H=$(git -C $W rev-parse HEAD); B=$(git -C $W merge-base HEAD origin/main)
   git -C $W worktree add --detach /Users/bs/Github/canary-608-ratchet-head $H
   git -C $W worktree add --detach /Users/bs/Github/canary-608-ratchet-base $B
   ```

2. In both: `harness check-deps` (root) → passes, and `harness check-arch` → no
   new module-size violation. If it reports one, follow the arch-ratchet
   allowance flow and checkpoint.
3. Entropy (dead exports): `harness cleanup --findings-json > /tmp/...` in both.
   Compare category counts with
   `harness cleanup --type dead-code --findings-json`. The head must not exceed
   the base. Every export of the new modules is imported somewhere:
   `schema-core` helpers by schema/schema-targets, `validate*`/`load*` by cli or
   tests, `PATTERNS`/`INTENSITY_CEILING` by matrix,
   `AMPLITUDES`/`buildMatrix`/`matrixJson` by cli. If dead code rises, declare
   the module in BOTH entryPoints arrays or drop the unused `export`.
4. Perf: run `harness check-perf > perf-report.txt` in both worktrees, then run
   the ratchet from the head worktree. Read the **delta** line, not the ceiling
   line. The only expected new finding is the `cli.mjs` coupling ratio, which
   the existing `agents/skills/claude-code/*/scripts/cli.mjs` delta allowance
   covers.

   ```bash
   cd /Users/bs/Github/canary-608-ratchet-head
   BASE=/Users/bs/Github/canary-608-ratchet-base
   node scripts/perf-ratchet.mjs --report perf-report.txt \
     --base-report $BASE/perf-report.txt \
     --base-baseline $BASE/.harness/perf-baseline.json
   ```

5. Docs coverage, in the head worktree:

   ```bash
   harness check-docs --json --min-coverage 0 > docs-report.json
   node scripts/docs-ratchet.mjs --report docs-report.json \
     --cli-version "$(harness --version)"
   ```

   Expect +6 scanned / +0 documented. The six are `cli.mjs`, `matrix.mjs`,
   `patterns.mjs`, `schema*.mjs` ×3; roughly 87/471 = 18.47% against the 18.04
   floor. That passes, but it spends about 6 of the shared headroom. Report the
   numbers.

6. `git -C /Users/bs/Github/canary-608-cry-p1 worktree remove /Users/bs/Github/canary-608-ratchet-head`
   (and base).

### Task 16: Doc-drift + testing-gap review, final validate

**Depends on:** Task 15 | **Files:** none, or follow-up issues | **Category:**
integration

1. Read the full diff as a reviewer:
   `git -C /Users/bs/Github/canary-608-cry-p1 diff 71f5a1a7...HEAD`.
2. Doc drift (rule 8). Consider each of these:
   - the roadmap row (`docs/roadmap.md:46`, still `planned`, Plan field `—`;
     optionally set `Plan:` to this file, without `manage_roadmap promote`
     because of the Assignee churn);
   - AGENTS.md and the root README (deferred to P5 by the spec);
   - the spec's file layout, which lacks `schema-core.mjs` and
     `schema-targets.mjs`; append a P1 note to the spec only if the human
     agrees.
3. Testing gaps: compare every observable truth above against its test. File
   anything uncovered as an issue (`gh issue create`), and do not widen scope.
4. `cd /Users/bs/Github/canary-608-cry-p1 && harness validate && harness check-deps`
5. Hand off to the PR step. The PR body ends with `Refs #608`, and the branch
   stays `feat/608-canary-cry-p1`.

## Traceability

| Truth                            | Tasks            |
| -------------------------------- | ---------------- |
| SC1                              | 6, 8             |
| SC2, SC3                         | 6                |
| SC4                              | 6, 8             |
| SC5                              | 4, 5, 8          |
| SC6                              | 10               |
| SC24                             | 6, 8, 9          |
| SC19 (partial)                   | 2, 8, 11, 14, 15 |
| `run`/`report` not yet supported | 8                |
| validate / check-deps            | 15, 16           |

## Forward constraints for P2+

- P2/P3 must load the `run` path through a lazy dynamic import of a separate
  module. A static import would put `child_process`/Playwright into the Tier-0
  closure that `canary-cry-tier.test.ts` pins.
- P3 adds `scripts/runtime/cry-runtime.mjs` to BOTH entryPoints arrays (it is
  loaded only by generated specs).
- P3/P5 must settle exit 1: today it means "unexpected exception"; the spec
  reserves it for `--strict` + corrupted.
