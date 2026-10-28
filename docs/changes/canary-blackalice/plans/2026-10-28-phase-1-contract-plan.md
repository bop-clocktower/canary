# Plan: canary-blackalice, phase 1 — the `canary.tool-review/1` contract

Issue: [#1524](https://github.com/bop-clocktower/canary/issues/1524) · Spec:
[proposal.md](../proposal.md) (Implementation Order, sub-project 1, item 1) ·
Date: 2026-10-28 · Base: `5cb10f0b` (`origin/main`) · Branch:
`feat/blackalice-1-contract` · Worktree: `/Users/bs/Github/canary-blackalice-1`
· Rigor: standard · **Tasks:** 14 · **Checkpoints:** 4 (one conditional) ·
**Time:** ~65 min, plus gate runtime · **Integration Tier:** medium

`$WT` below means `/Users/bs/Github/canary-blackalice-1`. Work only there, with
absolute paths or `git -C "$WT"`. Never touch `/Users/bs/Github/canary`. `$M`
means `$WT/.harness/sessions/changes--canary-blackalice--proposal/measure`
(gitignored: `.harness/.gitignore` ignores `sessions/`).

## Goal

A producer can hand canary a `canary.tool-review/1` report and get a
zero-dependency, schema-driven verdict that refuses a finding with no evidence,
cost or persona, a finding that names neither a job nor a quality, a report
without `not_assessed`, and any composite score, naming the field it refused.

**Skills:** `harness-data-validation` (reference) applies to Tasks 2-7.
`design-design-documentation` (reference) applies to Tasks 9-10.
`node-http-server` from `SKILLS.md` does not apply to this phase: nothing here
serves HTTP.

## Observable truths (acceptance criteria, in scope)

| #   | Criterion | EARS statement                                                                                                                                                                                                                                        | Task  |
| --- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| T1  | —         | When `validateToolReview` runs on `tool-review.valid.json`, the validator shall return `{ valid: true, checked: 8, errors: [] }` (1 report + 5 ledger rows + 2 findings).                                                                             | 4     |
| T2  | 11        | If a finding has no `evidence`, `cost` or `persona` key, then the validator shall refuse it with `findings[i].<field>: missing required field`; a blank `cost` is refused as `must not be blank`.                                                     | 4     |
| T3  | 11        | If a finding has both `job` and `quality` null, then the validator shall refuse it with path `findings[i]` and a message naming rule `jobOrQuality`. Job only, quality only, or both set are accepted.                                                | 5     |
| T4  | 11 (P2)   | If a finding has `evidence: []`, then the validator shall refuse it with path `findings[i].evidence` and a message naming rule `evidenceRequired`.                                                                                                    | 7     |
| T5  | 12        | If `not_assessed` is absent, then the validator shall refuse the report with `not_assessed: missing required field`. `[]` and a list of run-level reasons are accepted; `null` is refused.                                                            | 4     |
| T6  | 15        | If a `score`, `overall`, `composite` or `rating` key is present on the report or on any finding, with any value including `null`, then the validator shall refuse it with path `<key>` or `findings[i].<key>`, naming `noCompositeScore`.             | 6     |
| T7  | —         | If a ledger row's `state` is `pending`, then the validator shall refuse it (path `ledger[i].state`).                                                                                                                                                  | 4     |
| T8  | —         | The shared `validateDocument` shall refuse `canary.tool-review/1` with `contract: not a canary contract string`, and `document.mjs`, `validate.mjs`, `rules.mjs`, `schema-check.mjs` and `schema-problems.mjs` shall be byte-identical to `5cb10f0b`. | 2, 14 |
| T9  | —         | `contracts-schemas.test.ts` shall declare `tool-review.v1.schema.json` under a `STANDALONE_CONTRACTS` list whose rows assert that `contract` is the schema's const, and `schemaProblems` over the registry shall be `[]`.                             | 3     |
| T10 | —         | `agents/skills/lib/contracts/tool-review.mjs` shall appear in both `entropy.entryPoints` and `performance.entryPoints`, in the same position, and `harness cleanup --findings-json` shall report no finding naming it.                                | 8, 13 |
| T11 | —         | `docs/specs/canary-tool-review-contract.md` and ADR 0045 shall exist, the ADR index test shall pass, and `AGENTS.md` and `CHANGELOG.md` shall describe the new contract.                                                                              | 9-11  |
| T12 | —         | The four gates shall pass in both `ts/` and `agents/skills/`, with the skills coverage thresholds (90/90/85/90) holding.                                                                                                                              | 12    |
| T13 | —         | Against the merge base, the entropy and perf ratchets shall report a +0 delta, `arch-verdict.mjs` shall exit 0 with 0 new violations, the docs ratchet shall pass, and `harness check-deps` shall analyze one more module than at base.               | 13    |

Criteria 1-10, 13, 14 and 16-21 belong to phases 2-4 and are out of scope.

## 1. EXPLORE — what is actually true (evidence)

- `agents/skills/lib/contracts/critical-areas.mjs:1-79` is the standalone-entry
  precedent. It imports only `node:fs`, `node:url` and `auditedValidator` from
  `./schema-problems.mjs`, loads one schema, and keeps its own non-schema rules
  (`symbolErrors`) in the entry point, not in `rules.mjs`. It returns
  `{ valid, checked, errors }`.
- `document.mjs:20-21`: `LAYERS = ['run', 'assessment', 'site']` and
  `CONTRACT_RE = /^canary\.([a-z]+)\/(\d+)$/`. The regex has no hyphen, so
  `canary.tool-review/1` is refused as `not a canary contract string`. Verified
  by running `validateDocument` on the draft fixture (scratch prototype).
- `schema-check.mjs:172-183`: the supported keywords are `type`, `required`,
  `properties`, `items`, `enum`, `const`, `pattern`, `minimum`, `minLength` and
  `$ref`, plus annotations. **There is no `minItems`**, so the spec's
  `evidence: [...] // ≥1` cannot be stated in the schema. See fork P2.
- `rules.mjs` is 258 lines. `check-perf` flags files over **300 lines**
  (`File has N lines (threshold: 300)`, measured on base 2026-10-28). The two
  spec rules plus a dispatcher would add about 40 lines. See fork P1.
- `test/contracts-schemas.test.ts:18-20` declares `LAYERS` and
  `INPUT_SCHEMAS = ['critical-areas.v1.schema.json']`. Every `INPUT_SCHEMAS` row
  asserts `properties.contract` is undefined, so a schema with a `contract`
  const needs a third list. The registry test requires the directory to hold
  exactly the declared schemas.
- `test/contracts-validate.test.ts:33-44` asserts that the `*.valid.json` corpus
  in `test/fixtures/contracts/` is **exactly** the three layer fixtures. Adding
  `tool-review.valid.json` turns it red. The spec's registration list missed
  this test. Task 2 updates it.
- `harness.config.json:226` and `:385` list
  `agents/skills/lib/contracts/validate.mjs` in `entropy.entryPoints` and
  `performance.entryPoints`. `ts/test/entropy-entrypoints.test.ts:178` requires
  the two lists to stay in lockstep and in the same order, and `:134` requires
  each entry to be git-tracked. `critical-areas.mjs` is not an entry point
  because katana imports it. `tool-review.mjs` has no non-test importer until
  phase 3, and entropy ignores test imports (`scripts/entropy-ratchet.mjs:12`),
  so without an entry its export would be dead.
- `agents/skills/package.json` `format:check` already covers
  `lib/**/*.{mjs,js}`, `lib/contracts/*.json`, `test/fixtures/contracts/*.json`
  and `test/**/*.ts`. `vitest.config.ts` coverage already includes
  `lib/**/*.{mjs,js}`. **No glob changes are needed.**
- `test/lib-portability.test.ts` lints every `lib/**/*.mjs` with ES globals
  only, so `URL` must be imported from `node:url` (as `critical-areas.mjs`
  does). It picks up the new file automatically.
- ADRs live in `docs/knowledge/decisions/`, not `docs/adr/`. The highest is
  0044, so **0045 is free**. No open PR or remote branch adds a `0045-*` file
  (checked 2026-10-28). `ts/test/adr-index.test.ts` requires one README row per
  ADR file, with a matching status.
- `CHANGELOG.md` `[Unreleased]` has `Security`, `Changed` and `Fixed`, but no
  `Added` section yet.
- `AGENTS.md:416-424` ("QA data contract") names exactly `canary.run/1`,
  `canary.assessment/1` and `canary.site/1`. This phase makes that bullet
  incomplete.
- Prettier: root `.prettierrc` (`singleQuote`, `printWidth 80`,
  `proseWrap: always`, `trailingComma: all`). markdownlint MD013 is 80 columns
  outside code blocks and tables.
- Base measurements (`5cb10f0b`, CLI 13.0.0): `harness validate` passes;
  `harness check-deps` reads 529 modules in 15 layers; `check-arch` totals
  module-size 55517 against a 55480 floor (1% tolerance ≈ 555), with 0 new and
  12 pre-existing violations; `arch-verdict.mjs` reports "BASELINE TRIP",
  exit 0. Re-measured in Task 1.
- `agents/skills/node_modules` is **not installed** in this worktree. `ts/` deps
  are installed. Task 1 installs the skills deps.
- The full draft (schema, module and fixture) was prototyped in the scratchpad
  against a copy of `lib/contracts/`. Every assertion in Tasks 2-7 was observed
  to produce the stated paths and messages, and prettier was run on the drafts.
  The listings below are the post-prettier text.

## 2. EVALUATE — forks, each with a recommended default

Confirm at the Task 1 checkpoint. Where a task disagrees with an amended
default, the amendment wins.

| Fork | Question                                                    | Options                                                                                                                                                                                                                                                | Default                                                                                                                                                                                                                                                                                                                                                                                     |
| ---- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1   | Where do the named rules live?                              | (a) `rules.mjs`, as the spec's file layout says. (b) `tool-review.mjs`, following `critical-areas.mjs`.                                                                                                                                                | **(b).** (a) takes `rules.mjs` from 258 lines to about 298, against `check-perf`'s 300-line threshold. A new file-length finding fails the perf delta ratchet, and phase 2+ rules would not fit. Every rule in `rules.mjs` today serves the three layers through `crossFieldErrors(layer, …)`, and (b) leaves that file and its export untouched. **Deviates from the spec's file layout.** |
| P2   | How is `evidence ≥1` on a finding enforced?                 | (a) Not at all: `evidence: []` passes, and criterion 11 reads "lacks" as "key absent". (b) A third named rule, `evidenceRequired`. (c) (b), plus contract-level ledger rules (walked/mapped need evidence, not-assessed/not-applicable need a reason). | **(b).** With (a) a finding with nothing to point at would validate, which is the overclaim D9 says the CLI refuses. (c) duplicates what `record` enforces at write time in phase 3. It is filed as a concern rather than built here (YAGNI). **Adds a rule the spec does not name.**                                                                                                       |
| P3   | Shape of `tool.commit_sha`, finding `surface`, finding `id` | Spec example only shows `"…"`.                                                                                                                                                                                                                         | `commit_sha`: required, non-empty string (for a hosted tool, the deployed version). `surface`: required, nullable (a job finding from MAP may have no surface). `id`: non-empty string, not a `f-NNN` pattern.                                                                                                                                                                              |
| P4   | Shape of ledger `evidence` items                            | Spec example shows `[]` only.                                                                                                                                                                                                                          | The same `{kind, ref}` object as finding evidence (`$defs/evidence`). `kind` is `screenshot`, `snapshot` or `file`.                                                                                                                                                                                                                                                                         |
| P5   | `reviewed_at` validation                                    | (a) Pattern only. (b) Pattern plus `rules.mjs`'s `real-dates`.                                                                                                                                                                                         | **(a).** The pattern is a hand copy of `run.v1.schema.json#/$defs/timestamp`, pinned equal by a test. Month 13 is accepted. That is a known gap for a field nobody sorts on yet, and it is listed as a concern. (b) would add an import edge to `field-checks.mjs`.                                                                                                                         |
| P6   | ADR status                                                  | `proposed` or `accepted`                                                                                                                                                                                                                               | `accepted`, matching the ADR 0035 precedent (accepted in its phase 1 PR). The human reviews it in the PR (Task 10 checkpoint).                                                                                                                                                                                                                                                              |

### Uncertainties

- [BLOCKING → fork P1, P2] The spec places the rules in `rules.mjs` and names
  only two. Both defaults deviate from the spec text, so the human confirms them
  at Task 1. If P1 is overridden to (a), Tasks 5-7 put the functions in
  `rules.mjs` and export one `toolReviewErrors(doc)`. Then Task 13 must show
  `rules.mjs` under 300 lines and no new perf finding.
- [ASSUMPTION] `harness check-perf` does not flag `tool-review.mjs` for its
  coupling ratio. It has one local import, `validate.mjs` (three local imports,
  no non-test importer) is not flagged today, and the flagged modules are wiring
  modules with many imports. If wrong, the Task 13 checkpoint applies.
- [ASSUMPTION] Declaring `tool-review.mjs` an entry point clears the dead-export
  finding. Task 8 measures it before and after.
- [ASSUMPTION] P3 and P4 shapes, as above. Contract fields are expensive to
  change after release (ADR 0035 D3), so they are surfaced rather than decided
  silently.
- [DEFERRABLE] The contract-level zero-walked abstention, the ledger row
  companions (fork P2c) and the exit codes are producer obligations the phase-3
  CLI enforces. The contract doc lists them under "Not checked by the
  validator".
- [DEFERRABLE] Knowledge pipeline:
  `harness knowledge-pipeline --domain tool-review` returned PASS with 0
  findings, but coverage is
  `N/A — no measurable domains (run harness graph scan)`. That is an abstention,
  not a pass. Knowledge-graph enrichment is in phase 4's Knowledge Impact.
- [DEFERRABLE] If `origin/main` moves before the PR opens, the Task 1 base
  measurements stop describing the merge base. Task 14 re-checks this.

## 3. File map

- CREATE `agents/skills/lib/contracts/tool-review.v1.schema.json`
- CREATE `agents/skills/lib/contracts/tool-review.mjs`
- CREATE `agents/skills/test/contracts-tool-review.test.ts`
- CREATE `agents/skills/test/fixtures/contracts/tool-review.valid.json`
- CREATE
  `agents/skills/test/fixtures/contracts/tool-review.job-or-quality.invalid.json`
- CREATE
  `agents/skills/test/fixtures/contracts/tool-review.no-composite-score.invalid.json`
- CREATE
  `agents/skills/test/fixtures/contracts/tool-review.evidence-required.invalid.json`
- MODIFY `agents/skills/test/contracts-schemas.test.ts` (`STANDALONE_CONTRACTS`)
- MODIFY `agents/skills/test/contracts-validate.test.ts` (fixture corpus, plus
  the pin that the shared validator refuses `canary.tool-review/1`)
- MODIFY `harness.config.json` (both `entryPoints` lists)
- CREATE `docs/specs/canary-tool-review-contract.md`
- CREATE `docs/knowledge/decisions/0045-tool-review-ledger-first-contract.md`
- MODIFY `docs/knowledge/decisions/README.md` (index row)
- MODIFY `docs/knowledge/decisions/0035-versioned-two-layer-qa-data-contract.md`
  (Related: points to ADR 0045's D3 extension)
- MODIFY `AGENTS.md` (QA data contract bullet, link reference)
- MODIFY `CHANGELOG.md` (`[Unreleased]` → `### Added`)

**Not touched (T8):** `document.mjs`, `validate.mjs`, `rules.mjs`,
`schema-check.mjs`, `schema-problems.mjs`, `field-checks.mjs`,
`agents/skills/package.json`, `agents/skills/vitest.config.ts`,
`.claude-plugin/plugin.json`, `docs/roadmap.md`, `docs/naming-registry.md`.

## Skeleton

1. Decisions, environment and base measurements (~1 task, ~5 min)
2. Fixture, schema and registry tests (~2 tasks, ~8 min)
3. Validator entry point and three named rules, TDD (~4 tasks, ~18 min)
4. Entry-point registration (~1 task, ~4 min)
5. Contract doc, ADR, AGENTS.md and CHANGELOG (~3 tasks, ~14 min)
6. Gates, ratchets, probes and the PR-ready check (~3 tasks, ~16 min)

**Estimated total:** 14 tasks, ~65 minutes. _Skeleton approval: pending. It is
presented with this plan for sign-off._

## 4. Tasks (TDD: test first in every code task)

### Task 1: confirm forks, install skills deps, measure the base

**Depends on:** none · **Files:** none (writes only under the gitignored `$M`) ·
**[checkpoint:decision]**

1. **Stop and confirm forks P1-P6 (§2)** with the human. Recommendations: P1(b),
   P2(b), P3/P4 as stated, P5(a), P6 accepted. Record the answers in
   `$M/decisions.txt`. If P1 is (a) or P2 is (a), apply the amendment noted in
   §2 Uncertainties before Task 5.
2. Check the tree, the base and the instrument:

   ```bash
   git -C "$WT" branch --show-current        # feat/blackalice-1-contract
   git -C "$WT" status --short               # must be empty
   git -C "$WT" fetch origin
   git -C "$WT" rev-parse --short HEAD origin/main   # both 5cb10f0b (else see Task 14 step 5)
   harness --version                          # 13.0.0; must equal both baselines' harnessCli
   node --version                             # v22.23.2
   ```

3. Install the skills harness deps and confirm `ts/dist` exists. The skills
   suite's `globalSetup` fails without it.

   ```bash
   cd "$WT/agents/skills" && npm ci
   cd "$WT/ts" && npm run build
   ```

4. Measure the base on this still-unchanged tree. It equals `5cb10f0b`, so it is
   the merge base.

   ```bash
   mkdir -p "$M" && cd "$WT"
   harness check-deps > "$M/deps-base.txt" 2>&1; grep 'Analyzed' "$M/deps-base.txt"   # 529 module(s)
   harness cleanup --findings-json > "$M/entropy-base.txt" 2>&1 || true
   harness check-perf > "$M/perf-base.txt" 2>&1 || true
   harness check-arch --json > "$M/arch-base.json" 2>/dev/null || true
   harness check-docs --json > "$M/docs-base.json" 2>/dev/null || true
   ```

   Then confirm each report is non-empty (`wc -c "$M"/*`). An empty file is an
   abstention, not a baseline.

5. No commit.

### Task 2: the valid fixture, and the corpus test that knows about it

**Depends on:** Task 1 · **Files:**
`agents/skills/test/fixtures/contracts/tool-review.valid.json`,
`agents/skills/test/contracts-validate.test.ts`

1. Create `agents/skills/test/fixtures/contracts/tool-review.valid.json`. It is
   generic: no real tool, route or name.

   ```json
   {
     "contract": "canary.tool-review/1",
     "tool": {
       "name": "example-tracker",
       "commit_sha": "0123456789abcdef0123456789abcdef01234567",
       "url": "https://staging.example.test"
     },
     "reviewed_at": "2026-10-28T14:00:00Z",
     "catalog_version": "jobs.v1",
     "overlay_sha": "89abcdef0123456789abcdef0123456789abcdef",
     "ledger": [
       {
         "id": "report.read-release-status-at-a-glance",
         "kind": "job",
         "state": "walked",
         "reason": null,
         "evidence": [
           { "kind": "snapshot", "ref": "snapshots/release-status.md" }
         ]
       },
       {
         "id": "triage.find-when-it-started-failing",
         "kind": "job",
         "state": "mapped",
         "reason": null,
         "evidence": [{ "kind": "file", "ref": "src/routes/history.ts:42" }]
       },
       {
         "id": "report.see-only-my-results",
         "kind": "job",
         "state": "not-assessed",
         "reason": "no external-viewer account in the seed data",
         "evidence": []
       },
       {
         "id": "plan.import-from-external-tracker",
         "kind": "job",
         "state": "not-applicable",
         "reason": "the tool has no external tracker",
         "evidence": []
       },
       {
         "id": "/dashboard",
         "kind": "surface",
         "state": "walked",
         "reason": null,
         "evidence": [
           { "kind": "screenshot", "ref": "screenshots/dashboard.png" }
         ]
       }
     ],
     "findings": [
       {
         "id": "f-001",
         "severity": "blocker",
         "persona": "pm-owner",
         "job": null,
         "quality": "Q2",
         "surface": "/dashboard",
         "what_happened": "A suite with no runs this week shows a green tick",
         "cost": "A PM reads 'all good' for a suite nobody ran",
         "evidence": [
           { "kind": "screenshot", "ref": "screenshots/dashboard.png" }
         ],
         "file_candidate": true
       },
       {
         "id": "f-002",
         "severity": "friction",
         "persona": "developer",
         "job": "triage.find-when-it-started-failing",
         "quality": "Q4",
         "surface": null,
         "what_happened": "A result links to its run but not to its build or its previous result",
         "cost": "A developer cannot tell when a test started failing without opening every older run",
         "evidence": [{ "kind": "file", "ref": "src/routes/history.ts:42" }],
         "file_candidate": false
       }
     ],
     "not_assessed": []
   }
   ```

2. **RED.**
   `cd "$WT/agents/skills" && npx vitest run test/contracts-validate.test.ts`.
   `holds one valid document per layer` must fail, because the corpus now has
   four files.
3. Edit `test/contracts-validate.test.ts`. The blocks below are shown dedented:
   in the file they sit inside `describe('valid corpus …')`, so every line
   carries two more leading spaces. Match and write them at that indentation
   (prettier will confirm it). Replace

   ```ts
   it('holds one valid document per layer (a zero denominator is not a pass)', () => {
     const corpus = fs
       .readdirSync(FIXTURES)
       .filter((f) => f.endsWith('.valid.json'))
       .sort();
     expect(corpus).toEqual([
       'assessment.valid.json',
       'run.valid.json',
       'site.valid.json',
     ]);
   });
   ```

   with

   ```ts
   it('holds one valid document per layer, plus each standalone contract (a zero denominator is not a pass)', () => {
     // tool-review.valid.json is canary.tool-review/1, validated by
     // tool-review.mjs (ADR 0045), not by validateDocument.
     const corpus = fs
       .readdirSync(FIXTURES)
       .filter((f) => f.endsWith('.valid.json'))
       .sort();
     expect(corpus).toEqual([
       'assessment.valid.json',
       'run.valid.json',
       'site.valid.json',
       'tool-review.valid.json',
     ]);
   });

   it('refuses canary.tool-review/1: a standalone contract has its own entry point (ADR 0045)', () => {
     // Pins the decision not to widen CONTRACT_RE or LAYERS in document.mjs.
     const doc = JSON.parse(
       fs.readFileSync(path.join(FIXTURES, 'tool-review.valid.json'), 'utf8'),
     );
     expect(validateDocument(doc).errors).toEqual([
       {
         path: 'contract',
         message: 'not a canary contract string: "canary.tool-review/1"',
       },
     ]);
   });
   ```

4. Format, then **GREEN**:

   ```bash
   cd "$WT/agents/skills"
   npx prettier --write test/fixtures/contracts/tool-review.valid.json test/contracts-validate.test.ts
   npx vitest run test/contracts-validate.test.ts
   ```

5. Run `harness validate` from `$WT`.
6. Commit:
   `test(contracts): add the canary.tool-review/1 valid fixture to the corpus`,
   with body `Refs #1524`.

### Task 3: the schema, declared as a standalone contract

**Depends on:** Task 2 · **Files:**
`agents/skills/lib/contracts/tool-review.v1.schema.json`,
`agents/skills/test/contracts-schemas.test.ts`

1. **Test first.** In `test/contracts-schemas.test.ts`, after the
   `INPUT_SCHEMAS` line, add:

   ```ts
   /**
    * Standalone contracts (ADR 0045): a document with a `contract` const that is
    * not a canary.* layer, so each has its own entry point (tool-review.mjs).
    * Named `canary.<name>/<major>`; `<name>` may contain hyphens.
    */
   const STANDALONE_CONTRACTS = ['tool-review'];
   ```

   Replace the registry test. As in Task 2, the blocks are shown dedented: in
   the file they sit inside `describe('contract schemas')` with two more leading
   spaces per line.

   ```ts
   it('ships one schema per layer plus the declared input schemas, and nothing else (a zero denominator is not a pass)', () => {
     // Plus the input files canary skills read that are not canary.* layers
     // (no `contract` field to dispatch on), each with its own entry point.
     expect(Object.keys(REGISTRY).sort()).toEqual(
       [...LAYERS.map((l) => `${l}.v1.schema.json`), ...INPUT_SCHEMAS].sort(),
     );
   });
   ```

   with:

   ```ts
   it('ships one schema per layer plus the declared input and standalone schemas, and nothing else (a zero denominator is not a pass)', () => {
     // Plus the input files canary skills read that are not canary.* layers
     // (no `contract` field to dispatch on), and the standalone contracts
     // (a `contract` const, but no layer), each with its own entry point.
     expect(Object.keys(REGISTRY).sort()).toEqual(
       [
         ...LAYERS.map((l) => `${l}.v1.schema.json`),
         ...INPUT_SCHEMAS,
         ...STANDALONE_CONTRACTS.map((c) => `${c}.v1.schema.json`),
       ].sort(),
     );
   });

   it.each(STANDALONE_CONTRACTS)(
     '%s: $id is its file name, contract its const (canary.<name>/1)',
     (name) => {
       const schema = REGISTRY[`${name}.v1.schema.json`];
       expect(schema.$id).toBe(`${name}.v1.schema.json`);
       expect(schema.properties.contract.const).toBe(`canary.${name}/1`);
     },
   );

   it.each(STANDALONE_CONTRACTS)(
     '%s: the valid fixture has zero schema errors',
     (name) => {
       expect(errorsFor(name, fixture(name))).toEqual([]);
     },
   );

   it('tool-review: reviewed_at uses the run timestamp pattern verbatim', () => {
     // A hand copy, not a cross-file $ref, so tool-review.mjs loads one file.
     const own = REGISTRY['tool-review.v1.schema.json'].$defs.timestamp;
     const run = REGISTRY['run.v1.schema.json'].$defs.timestamp;
     expect(own.type).toBe(run.type);
     expect(own.pattern).toBe(run.pattern);
   });
   ```

2. **RED.** `npx vitest run test/contracts-schemas.test.ts`. The registry test
   and the three new tests fail because the schema does not exist yet.
3. Create `agents/skills/lib/contracts/tool-review.v1.schema.json`:

   ```json
   {
     "$schema": "https://json-schema.org/draft/2020-12/schema",
     "$id": "tool-review.v1.schema.json",
     "title": "canary.tool-review/1",
     "description": "One review of a QA tool from the seats of the people who use it: a coverage ledger in which every job and result surface ends in exactly one state, and the findings the review made. Spec: docs/specs/canary-tool-review-contract.md. A standalone contract, not a canary.* layer, so it is validated by tool-review.mjs and not by validate.mjs (ADR 0045). Unknown fields are tolerated. Rules the subset cannot express (jobOrQuality, noCompositeScore, evidenceRequired) live in tool-review.mjs.",
     "type": "object",
     "required": [
       "contract",
       "tool",
       "reviewed_at",
       "catalog_version",
       "overlay_sha",
       "ledger",
       "findings",
       "not_assessed"
     ],
     "properties": {
       "contract": { "const": "canary.tool-review/1" },
       "tool": { "$ref": "#/$defs/tool" },
       "reviewed_at": { "$ref": "#/$defs/timestamp" },
       "catalog_version": { "$ref": "#/$defs/text" },
       "overlay_sha": {
         "$comment": "null when the review ran without an overlay.",
         "type": ["string", "null"],
         "minLength": 1
       },
       "ledger": { "type": "array", "items": { "$ref": "#/$defs/row" } },
       "findings": { "type": "array", "items": { "$ref": "#/$defs/finding" } },
       "not_assessed": {
         "$comment": "Run-level abstentions only: a phase or capability the run could not exercise at all. Required; [] means none. Per-row not-assessed states stay in ledger and are never repeated here.",
         "type": "array",
         "items": { "$ref": "#/$defs/text" }
       }
     },
     "$defs": {
       "text": { "type": "string", "minLength": 1 },
       "timestamp": {
         "$comment": "A hand copy of run.v1.schema.json#/$defs/timestamp, so this file loads alone; contracts-schemas.test.ts pins the two equal.",
         "type": "string",
         "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$"
       },
       "tool": {
         "type": "object",
         "required": ["name", "commit_sha", "url"],
         "properties": {
           "name": { "$ref": "#/$defs/text" },
           "commit_sha": { "$ref": "#/$defs/text" },
           "url": { "$ref": "#/$defs/text" }
         }
       },
       "evidence": {
         "type": "object",
         "required": ["kind", "ref"],
         "properties": {
           "kind": { "enum": ["screenshot", "snapshot", "file"] },
           "ref": { "$ref": "#/$defs/text" }
         }
       },
       "row": {
         "type": "object",
         "required": ["id", "kind", "state", "reason", "evidence"],
         "properties": {
           "id": { "$ref": "#/$defs/text" },
           "kind": { "enum": ["job", "surface"] },
           "state": {
             "$comment": "pending is a ledger-file state only; a report never carries it.",
             "enum": ["walked", "mapped", "not-assessed", "not-applicable"]
           },
           "reason": { "type": ["string", "null"], "minLength": 1 },
           "evidence": {
             "type": "array",
             "items": { "$ref": "#/$defs/evidence" }
           }
         }
       },
       "finding": {
         "type": "object",
         "required": [
           "id",
           "severity",
           "persona",
           "job",
           "quality",
           "surface",
           "what_happened",
           "cost",
           "evidence",
           "file_candidate"
         ],
         "properties": {
           "id": { "$ref": "#/$defs/text" },
           "severity": { "enum": ["blocker", "friction", "polish"] },
           "persona": {
             "enum": [
               "manual-tester",
               "sdet",
               "qa-lead",
               "developer",
               "pm-owner",
               "external-viewer"
             ]
           },
           "job": { "type": ["string", "null"], "minLength": 1 },
           "quality": { "enum": ["Q1", "Q2", "Q3", "Q4", null] },
           "surface": { "type": ["string", "null"], "minLength": 1 },
           "what_happened": { "$ref": "#/$defs/text" },
           "cost": { "$ref": "#/$defs/text" },
           "evidence": {
             "type": "array",
             "items": { "$ref": "#/$defs/evidence" }
           },
           "file_candidate": { "type": "boolean" }
         }
       }
     }
   }
   ```

4. Format, then **GREEN**:

   ```bash
   cd "$WT/agents/skills"
   npx prettier --write lib/contracts/tool-review.v1.schema.json test/contracts-schemas.test.ts
   npx vitest run test/contracts-schemas.test.ts test/contracts-validate.test.ts
   ```

   `uses only enforced keywords, and every $ref resolves` must stay green: that
   is the ADR 0035 subset audit over the new schema.

5. Run `harness validate`.
6. Commit: `feat(contracts): canary.tool-review/1 schema`, with body
   `Refs #1524`.

### Task 4: `tool-review.mjs`, the schema-driven entry point (criteria 11, 12)

**Depends on:** Task 3 · **Files:**
`agents/skills/lib/contracts/tool-review.mjs`,
`agents/skills/test/contracts-tool-review.test.ts`

1. **Test first.** Create `agents/skills/test/contracts-tool-review.test.ts`:

   ```ts
   /**
    * canary.tool-review/1 (ADR 0045): the report canary-blackalice writes.
    * Criteria 11, 12 and 15 of docs/changes/canary-blackalice/proposal.md. Each
    * named rule has its own invalid fixture whose ONLY error is that rule, so no
    * rule can pass vacuously, and every refusal asserts the error path.
    */
   import fs from 'node:fs';
   import path from 'node:path';
   import { fileURLToPath } from 'node:url';

   import { describe, it, expect } from 'vitest';

   import { validateToolReview } from '../lib/contracts/tool-review.mjs';

   const FIXTURES = path.join(
     path.dirname(fileURLToPath(import.meta.url)),
     'fixtures',
     'contracts',
   );

   type Doc = Record<string, any>;
   const load = (name: string): Doc =>
     JSON.parse(
       fs.readFileSync(path.join(FIXTURES, `tool-review.${name}.json`), 'utf8'),
     );
   const valid = () => load('valid');
   const paths = (doc: unknown) =>
     validateToolReview(doc).errors.map((e: { path: string }) => e.path);

   describe('tool-review contract: schema', () => {
     it('accepts the valid fixture and counts the report, its ledger rows and its findings', () => {
       expect(validateToolReview(valid())).toEqual({
         valid: true,
         checked: 1 + 5 + 2,
         errors: [],
       });
     });

     it.each(['evidence', 'cost', 'persona'])(
       'refuses a finding without %s (criterion 11)',
       (field) => {
         const doc = valid();
         delete doc.findings[0][field];
         expect(validateToolReview(doc).errors).toEqual([
           { path: `findings[0].${field}`, message: 'missing required field' },
         ]);
       },
     );

     it('refuses a blank cost: a plain-language cost is required, not just a key', () => {
       const doc = valid();
       doc.findings[0].cost = '   ';
       expect(validateToolReview(doc).errors).toEqual([
         { path: 'findings[0].cost', message: 'must not be blank' },
       ]);
     });

     it('refuses a persona outside the six', () => {
       const doc = valid();
       doc.findings[0].persona = 'tester';
       expect(paths(doc)).toEqual(['findings[0].persona']);
     });

     it('refuses a report without not_assessed (criterion 12)', () => {
       const doc = valid();
       delete doc.not_assessed;
       expect(validateToolReview(doc).errors).toEqual([
         { path: 'not_assessed', message: 'missing required field' },
       ]);
     });

     it('accepts not_assessed as [] (none) or as run-level reasons (criterion 12)', () => {
       expect(valid().not_assessed).toEqual([]);
       const doc = valid();
       doc.not_assessed = ['walk skipped: no browser driver'];
       expect(validateToolReview(doc).valid).toBe(true);
     });

     it('refuses not_assessed: null, because [] is how a report says "none"', () => {
       const doc = valid();
       doc.not_assessed = null;
       expect(paths(doc)).toEqual(['not_assessed']);
     });

     it('refuses a pending ledger row: a report row ends in one of four states', () => {
       const doc = valid();
       doc.ledger[0].state = 'pending';
       expect(paths(doc)).toEqual(['ledger[0].state']);
     });

     it('refuses another contract string, including another major', () => {
       const doc = valid();
       doc.contract = 'canary.tool-review/2';
       expect(validateToolReview(doc).errors).toEqual([
         { path: 'contract', message: 'must be "canary.tool-review/1"' },
       ]);
     });

     it('refuses a reviewed_at without a time and zone', () => {
       const doc = valid();
       doc.reviewed_at = '2026-10-28';
       expect(paths(doc)).toEqual(['reviewed_at']);
     });

     it('refuses a report that is not an object, and still counts it', () => {
       expect(paths([])).toEqual(['$']);
       expect(paths(null)).toEqual(['$']);
       expect(validateToolReview(null).checked).toBe(1);
     });

     it('names every missing top-level field of an empty object', () => {
       expect(paths({})).toEqual([
         'contract',
         'tool',
         'reviewed_at',
         'catalog_version',
         'overlay_sha',
         'ledger',
         'findings',
         'not_assessed',
       ]);
     });
   });
   ```

2. **RED.** `npx vitest run test/contracts-tool-review.test.ts` fails because
   `../lib/contracts/tool-review.mjs` does not exist.
3. Create `agents/skills/lib/contracts/tool-review.mjs` (schema only, with no
   rules yet):

   ```js
   // Validator for canary.tool-review/1 (ADR 0045): the report canary-blackalice
   // writes after reviewing a QA tool from the seats of the people who use it.
   //
   // Schema-driven like the canary.* layers: tool-review.v1.schema.json is the
   // contract, interpreted by the same audited subset checker. It is its own
   // entry point, following critical-areas.mjs, and is not routed through
   // document.mjs: that module's CONTRACT_RE admits no hyphen and its LAYERS are
   // fixed to run/assessment/site, so routing this contract there would widen a
   // validator three other contracts depend on. The rules the subset cannot
   // express live here, not in rules.mjs, for the reason critical-areas.mjs keeps
   // its own: they belong to this contract alone.
   //
   // Zero dependencies, and vendorable: nothing here touches a Node global.

   import { readFileSync } from 'node:fs';
   import { URL } from 'node:url';

   import { auditedValidator } from './schema-problems.mjs';

   const ID = 'tool-review.v1.schema.json';

   const checkSchema = auditedValidator({
     [ID]: JSON.parse(
       readFileSync(new URL(`./${ID}`, import.meta.url), 'utf8'),
     ),
   });

   const listOf = (doc, key) => (Array.isArray(doc?.[key]) ? doc[key] : []);

   /**
    * Validate a parsed canary.tool-review/1 report.
    * @param {unknown} doc
    * @returns {{valid: boolean, checked: number,
    *            errors: {path: string, message: string}[]}}
    *   `checked` counts the report, its ledger rows and its findings: the
    *   denominator a caller reports.
    */
   export function validateToolReview(doc) {
     const errors = checkSchema(ID, doc);
     const checked =
       1 + listOf(doc, 'ledger').length + listOf(doc, 'findings').length;
     return { valid: errors.length === 0, checked, errors };
   }
   ```

4. Format, then **GREEN**:

   ```bash
   cd "$WT/agents/skills"
   npx prettier --write lib/contracts/tool-review.mjs test/contracts-tool-review.test.ts
   npx vitest run test/contracts-tool-review.test.ts test/lib-portability.test.ts
   ```

   `lib-portability` must pass: `URL` is imported, not used as a global.

5. Run `harness validate`.
6. Commit: `feat(contracts): tool-review.mjs validator entry point`, with body
   `Refs #1524`.

### Task 5: rule `jobOrQuality` (criterion 11)

**Depends on:** Task 4 · **Files:**
`agents/skills/test/fixtures/contracts/tool-review.job-or-quality.invalid.json`,
`agents/skills/test/contracts-tool-review.test.ts`,
`agents/skills/lib/contracts/tool-review.mjs`

1. Generate the invalid fixture from the valid one (exactly one change:
   `findings[0].quality` becomes `null`, so `findings[0]` has neither a job nor
   a quality):

   ```bash
   cd "$WT/agents/skills/test/fixtures/contracts"
   node -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync('tool-review.valid.json','utf8'));d.findings[0].quality=null;fs.writeFileSync('tool-review.job-or-quality.invalid.json',JSON.stringify(d,null,2)+'\n')"
   ```

2. **Test first.** Append to `test/contracts-tool-review.test.ts`:

   ```ts
   describe('rule jobOrQuality (criterion 11)', () => {
     it('refuses the invalid fixture: a finding with both job and quality null', () => {
       expect(
         validateToolReview(load('job-or-quality.invalid')).errors,
       ).toEqual([
         {
           path: 'findings[0]',
           message:
             'names neither a job nor a quality; set job, quality or both (rule jobOrQuality)',
         },
       ]);
     });

     it('accepts job only, quality only, and both set', () => {
       const doc = valid();
       expect(doc.findings[0]).toMatchObject({ job: null, quality: 'Q2' });
       expect(doc.findings[1].job).not.toBeNull();
       expect(doc.findings[1].quality).not.toBeNull();
       doc.findings[0].job = 'report.read-release-status-at-a-glance';
       doc.findings[0].quality = null;
       expect(validateToolReview(doc).valid).toBe(true);
     });

     it('leaves an absent job to the schema: one error, not two', () => {
       const doc = load('job-or-quality.invalid');
       delete doc.findings[0].job;
       expect(paths(doc)).toEqual(['findings[0].job']);
     });

     it('skips a finding that is not an object, which the schema reports', () => {
       const doc = valid();
       doc.findings = [7];
       expect(paths(doc)).toEqual(['findings[0]']);
     });
   });
   ```

3. **RED.** `npx vitest run test/contracts-tool-review.test.ts`. The first test
   fails because the fixture is accepted.
4. Implement in `lib/contracts/tool-review.mjs`. After the `listOf` line, add:

   ```js
   const isObject = (v) =>
     v !== null && typeof v === 'object' && !Array.isArray(v);

   /**
    * Rule `jobOrQuality`: a finding names the job it failed, the quality it
    * failed, or both. Only an explicit null pair is refused: an absent or
    * wrong-typed field is the schema's error, not a second one here.
    */
   function jobOrQuality(finding, prefix) {
     if (finding.job !== null || finding.quality !== null) return [];
     return [
       {
         path: prefix,
         message:
           'names neither a job nor a quality; set job, quality or both (rule jobOrQuality)',
       },
     ];
   }

   const FINDING_RULES = [jobOrQuality];

   function ruleErrors(doc) {
     if (!isObject(doc)) return [];
     return listOf(doc, 'findings').flatMap((finding, i) =>
       isObject(finding)
         ? FINDING_RULES.flatMap((rule) => rule(finding, `findings[${i}]`))
         : [],
     );
   }
   ```

   In `validateToolReview`, replace `const errors = checkSchema(ID, doc);` with:

   ```js
   const errors = [...checkSchema(ID, doc), ...ruleErrors(doc)];
   ```

5. Format and **GREEN**:

   ```bash
   cd "$WT/agents/skills"
   npx prettier --write lib/contracts/tool-review.mjs test/contracts-tool-review.test.ts test/fixtures/contracts/tool-review.job-or-quality.invalid.json
   npx vitest run test/contracts-tool-review.test.ts
   ```

6. Run `harness validate`.
7. Commit: `feat(contracts): rule jobOrQuality for canary.tool-review/1`, with
   body `Refs #1524`.

### Task 6: rule `noCompositeScore` (criterion 15)

**Depends on:** Task 5 · **Files:**
`agents/skills/test/fixtures/contracts/tool-review.no-composite-score.invalid.json`,
`agents/skills/test/contracts-tool-review.test.ts`,
`agents/skills/lib/contracts/tool-review.mjs`

1. Generate the invalid fixture: a `score` on the report and a `rating` on
   `findings[1]`, and nothing else changed.

   ```bash
   cd "$WT/agents/skills/test/fixtures/contracts"
   node -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync('tool-review.valid.json','utf8'));d.score=7;d.findings[1].rating='B';fs.writeFileSync('tool-review.no-composite-score.invalid.json',JSON.stringify(d,null,2)+'\n')"
   ```

2. **Test first.** Append:

   ```ts
   describe('rule noCompositeScore (criterion 15)', () => {
     it('refuses the invalid fixture: a score on the report and a rating on a finding', () => {
       expect(paths(load('no-composite-score.invalid'))).toEqual([
         'score',
         'findings[1].rating',
       ]);
     });

     it.each(['score', 'overall', 'composite', 'rating'])(
       'refuses %s on the report and on a finding, even as null (key presence)',
       (key) => {
         const doc = valid();
         doc[key] = null;
         doc.findings[1][key] = 9;
         const { errors } = validateToolReview(doc);
         expect(errors.map((e: { path: string }) => e.path)).toEqual([
           key,
           `findings[1].${key}`,
         ]);
         for (const e of errors) expect(e.message).toMatch(/noCompositeScore/);
       },
     );

     it('still tolerates other unknown fields (ADR 0035 D3)', () => {
       const doc = valid();
       doc.notes = 'second pass after the redesign';
       doc.findings[0].notes = 'seen on two browsers';
       expect(validateToolReview(doc).valid).toBe(true);
     });
   });
   ```

3. **RED.** `npx vitest run test/contracts-tool-review.test.ts` fails because
   the scores are accepted.
4. Implement. In `tool-review.mjs`, after the `checkSchema` declaration, add:

   ```js
   /** The roll-up keys D8 refuses: a composite hides the persona that was failed. */
   const SCORE_KEYS = ['score', 'overall', 'composite', 'rating'];
   ```

   After the `isObject` declaration, add:

   ```js
   const at = (prefix, key) => (prefix ? `${prefix}.${key}` : key);
   ```

   After `jobOrQuality`, add:

   ```js
   /**
    * Rule `noCompositeScore` (D8, ADR 0036): no roll-up score on the report or on
    * any finding. Key presence counts, as with rules.mjs's authorExcluded: even
    * `null` is refused, because unknown fields are otherwise tolerated and that
    * tolerance must not become a way back in for a score.
    */
   function noCompositeScore(record, prefix) {
     return SCORE_KEYS.filter((key) => Object.hasOwn(record, key)).map(
       (key) => ({
         path: at(prefix, key),
         message:
           'must not be supplied: a tool review carries no composite score (rule noCompositeScore)',
       }),
     );
   }
   ```

   Change `const FINDING_RULES = [jobOrQuality];` to
   `const FINDING_RULES = [jobOrQuality, noCompositeScore];`, and replace the
   body of `ruleErrors` with:

   ```js
   if (!isObject(doc)) return [];
   return [
     ...noCompositeScore(doc, ''),
     ...listOf(doc, 'findings').flatMap((finding, i) =>
       isObject(finding)
         ? FINDING_RULES.flatMap((rule) => rule(finding, `findings[${i}]`))
         : [],
     ),
   ];
   ```

5. Format (all three files) and **GREEN**:
   `npx vitest run test/contracts-tool-review.test.ts`.
6. Run `harness validate`.
7. Commit: `feat(contracts): rule noCompositeScore for canary.tool-review/1`,
   with body `Refs #1524`.

### Task 7: rule `evidenceRequired` (criterion 11, fork P2)

**Depends on:** Task 6 · **Files:**
`agents/skills/test/fixtures/contracts/tool-review.evidence-required.invalid.json`,
`agents/skills/test/contracts-tool-review.test.ts`,
`agents/skills/lib/contracts/tool-review.mjs`

_Skip this task if P2 was decided (a). In that case also drop `evidenceRequired`
from the schema `description` in Task 3 and from the docs in Tasks 9-11._

1. Generate the invalid fixture: `findings[1].evidence` becomes `[]`.

   ```bash
   cd "$WT/agents/skills/test/fixtures/contracts"
   node -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync('tool-review.valid.json','utf8'));d.findings[1].evidence=[];fs.writeFileSync('tool-review.evidence-required.invalid.json',JSON.stringify(d,null,2)+'\n')"
   ```

2. **Test first.** Append:

   ```ts
   describe('rule evidenceRequired (criterion 11)', () => {
     it('refuses the invalid fixture: a finding with an empty evidence list', () => {
       expect(
         validateToolReview(load('evidence-required.invalid')).errors,
       ).toEqual([
         {
           path: 'findings[1].evidence',
           message:
             'is empty; a finding cites at least one screenshot, snapshot or file (rule evidenceRequired)',
         },
       ]);
     });

     it('leaves a non-array evidence to the schema: one error, not two', () => {
       const doc = valid();
       doc.findings[1].evidence = 'see the screenshot';
       expect(paths(doc)).toEqual(['findings[1].evidence']);
     });

     it('does not apply to ledger rows: not-assessed and not-applicable carry []', () => {
       const doc = valid();
       expect(doc.ledger[2]).toMatchObject({
         state: 'not-assessed',
         evidence: [],
       });
       expect(validateToolReview(doc).valid).toBe(true);
     });
   });
   ```

3. **RED.** `npx vitest run test/contracts-tool-review.test.ts`.
4. Implement. After `noCompositeScore`, add:

   ```js
   /**
    * Rule `evidenceRequired`: a finding cites at least one piece of evidence. The
    * subset has no `minItems`, so `evidence: []` passes the schema; a non-array is
    * the schema's error, not a second one here.
    */
   function evidenceRequired(finding, prefix) {
     const { evidence } = finding;
     if (!Array.isArray(evidence) || evidence.length > 0) return [];
     return [
       {
         path: at(prefix, 'evidence'),
         message:
           'is empty; a finding cites at least one screenshot, snapshot or file (rule evidenceRequired)',
       },
     ];
   }
   ```

   Change `FINDING_RULES` to
   `[jobOrQuality, noCompositeScore, evidenceRequired]`. The finished file must
   now match **Appendix A** exactly (108 lines after prettier).

5. Format and **GREEN**. Then check coverage of the new module:

   ```bash
   cd "$WT/agents/skills"
   npx vitest run test/contracts-tool-review.test.ts --coverage --coverage.include='lib/contracts/tool-review.mjs'
   ```

   Expect 100% lines, functions and branches. The thresholds apply to the whole
   tree in Task 12, but a branch missing here is a missing test.

6. Run `harness validate`.
7. Commit: `feat(contracts): rule evidenceRequired for canary.tool-review/1`,
   with body `Refs #1524`.

### Task 8: declare `tool-review.mjs` an entry point in both lists

**Depends on:** Task 7 (the file must be git-tracked) · **Files:**
`harness.config.json`

1. **Characterize (RED).** Before the edit:

   ```bash
   cd "$WT"
   harness cleanup --findings-json > "$M/entropy-pre-entry.txt" 2>&1 || true
   grep -n 'tool-review' "$M/entropy-pre-entry.txt"
   ```

   Record what it prints. The expectation is a dead-export or dead-file finding
   naming `tool-review.mjs`. If it prints nothing, note it: the entry is then
   belt and braces, and it is still required for phase 3's lockstep.

2. Edit `harness.config.json`: replace every occurrence (exactly two, at lines
   226 and 385) of

   ```json
         "agents/skills/lib/contracts/validate.mjs",
   ```

   with

   ```json
         "agents/skills/lib/contracts/validate.mjs",
         "agents/skills/lib/contracts/tool-review.mjs",
   ```

   (Edit with `replace_all: true`). Confirm with
   `grep -c 'lib/contracts/tool-review.mjs' harness.config.json`, which must
   print `2`.

3. **GREEN.**

   ```bash
   cd "$WT/ts" && npx vitest run test/entropy-entrypoints.test.ts test/harness-config-denominator.test.ts
   cd "$WT" && harness cleanup --findings-json > "$M/entropy-post-entry.txt" 2>&1 || true
   grep -n 'tool-review' "$M/entropy-post-entry.txt"   # must print nothing
   ```

4. Run `harness validate` and `harness check-deps` from `$WT`.
5. Commit: `chore(harness): declare tool-review.mjs in both entryPoints lists`,
   with body `Refs #1524`.

### Task 9: `docs/specs/canary-tool-review-contract.md`

**Depends on:** Task 7 · **Files:** `docs/specs/canary-tool-review-contract.md`
· **Skills:** `design-design-documentation` (reference)

1. **Check first.** `node "$WT/scripts/check_doc_links.mjs"` passes now. The new
   doc links to ADR 0045, which Task 10 creates, so the link check is re-run
   there.
2. Create the doc with exactly this content (`$FIXTURE` stands for the full
   content of `tool-review.valid.json`, pasted verbatim):

   ````markdown
   ---
   project: canary
   version: 1
   created: 2026-10-28
   ---

   # Tool Review Contract (canary.tool-review/1)

   > One review of a QA tool — a test tracker, a test-case manager, a results
   > dashboard — from the seats of the people who use it. The report says how
   > much of the tool it examined before it says anything about what the tool
   > got wrong: every job and every result surface ends in exactly one ledger
   > state. `canary-blackalice` produces it ([#1524]; [ADR 0045][adr-0045]).
   >
   > This is a **standalone contract**, not a layer of the canary QA data
   > contract. Validate a report with `validateToolReview` from
   > [`tool-review.mjs`](../../agents/skills/lib/contracts/tool-review.mjs), not
   > with `validate.mjs`.

   ## Shape

   ```json
   $FIXTURE
   ```

   The machine-readable contract is
   [tool-review.v1.schema.json](../../agents/skills/lib/contracts/tool-review.v1.schema.json);
   the document above is the executable fixture
   [tool-review.valid.json](../../agents/skills/test/fixtures/contracts/tool-review.valid.json).

   ## Fields

   Every field is **required**. "Nullable" means the key must be present and may
   be `null`; it never means the key may be omitted.

   | Field             | Type             | Nullable | Notes                                                                                    |
   | ----------------- | ---------------- | -------- | ---------------------------------------------------------------------------------------- |
   | `contract`        | string           | no       | Exactly `canary.tool-review/1`.                                                          |
   | `tool.name`       | string           | no       | Non-empty. The reviewed tool.                                                            |
   | `tool.commit_sha` | string           | no       | Non-empty. The revision reviewed; for a hosted tool, the deployed version.               |
   | `tool.url`        | string           | no       | Non-empty. Where the review reached the tool.                                            |
   | `reviewed_at`     | string           | no       | Timestamp with a zone, the run contract's pattern.                                       |
   | `catalog_version` | string           | no       | The generic job catalog the review used, e.g. `jobs.v1`.                                 |
   | `overlay_sha`     | string           | yes      | Content hash of the tool overlay; `null` when the review ran without one.                |
   | `ledger`          | array            | no       | One row per merged job and per result surface. See [Ledger](#ledger).                    |
   | `findings`        | array            | no       | `[]` = no findings. See [Findings](#findings).                                           |
   | `not_assessed`    | array of strings | no       | Run-level abstentions; `[]` = none. See [Run-level abstentions](#run-level-abstentions). |

   ## Ledger

   A row is `{id, kind, state, reason, evidence}`: `kind` is `job` or `surface`,
   `reason` is a non-blank string or `null`, and `evidence` is a list of
   `{kind, ref}` with `kind` one of `screenshot`, `snapshot`, `file`.

   | State            | Meaning                        | The producer must supply  |
   | ---------------- | ------------------------------ | ------------------------- |
   | `walked`         | Driven live in the browser     | ≥1 snapshot or screenshot |
   | `mapped`         | Judged from code and docs only | ≥1 `file:line`            |
   | `not-assessed`   | Not examined this run          | a reason                  |
   | `not-applicable` | Disabled by the tool overlay   | the overlay's reason      |

   `pending` is a state of the ledger file a review works in, never of a report:
   the schema refuses it.

   ## Findings

   | Field            | Type    | Nullable | Notes                                                                                |
   | ---------------- | ------- | -------- | ------------------------------------------------------------------------------------ |
   | `id`             | string  | no       | Non-empty, unique within the report, e.g. `f-003`.                                   |
   | `severity`       | enum    | no       | `blocker`, `friction` or `polish`.                                                   |
   | `persona`        | enum    | no       | `manual-tester`, `sdet`, `qa-lead`, `developer`, `pm-owner` or `external-viewer`.    |
   | `job`            | string  | yes      | The catalog job id the finding is about.                                             |
   | `quality`        | enum    | yes      | `Q1`-`Q4`. At least one of `job` and `quality` is set; both may be (`jobOrQuality`). |
   | `surface`        | string  | yes      | The result surface, e.g. `/dashboard`; `null` when the finding has none.             |
   | `what_happened`  | string  | no       | Non-blank.                                                                           |
   | `cost`           | string  | no       | Non-blank. In plain language: what this costs the persona.                           |
   | `evidence`       | array   | no       | `{kind, ref}` items; at least one (`evidenceRequired`).                              |
   | `file_candidate` | boolean | no       | The default selection when findings are turned into issues.                          |

   ## Run-level abstentions

   `not_assessed` lists what the run could not exercise at all, for example
   `"walk skipped: no browser driver"` or `"overlay auth env var unset"`. It is
   required: an absent list is refused, and `[]` means there were none. A row
   that was not examined stays a `not-assessed` row in `ledger`; the two never
   repeat each other.

   ## Named rules

   The schema stays inside ADR 0035's keyword subset (no `oneOf`, no
   `additionalProperties`, no `minItems`). These rules, in `tool-review.mjs`,
   state what the subset cannot:

   | Rule               | Refuses                                                                                        | Path                           |
   | ------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------ |
   | `jobOrQuality`     | A finding whose `job` and `quality` are both `null`                                            | `findings[i]`                  |
   | `noCompositeScore` | A `score`, `overall`, `composite` or `rating` key on the report or on any finding, even `null` | `<key>` or `findings[i].<key>` |
   | `evidenceRequired` | A finding with `evidence: []`                                                                  | `findings[i].evidence`         |

   Like every canary contract, a `minLength` of 1 also refuses a whitespace-only
   string (rule `non-blank`).

   ## Conventions (frozen)

   - **Version.** `contract` is `canary.<name>/<major>`. Layer contracts keep
     `canary.<layer>/<major>`; a standalone contract's `<name>` may contain
     hyphens (ADR 0045, extending ADR 0035 D3). Any other contract string or
     major version is refused. A minor version only adds optional fields.
   - **Unknown fields are tolerated**, except the four score keys.
   - **No composite score** (D8, ADR 0036). A roll-up hides the persona that was
     failed.
   - **Public boundary** (spec D11). The format is generic. Tool-specific
     overlays, internal routes and paths, screenshots, and the report of a
     review of a private tool belong in that tool's repository, never in canary.

   ## Validating

   ```js
   import { validateToolReview } from './agents/skills/lib/contracts/tool-review.mjs';

   const { valid, checked, errors } = validateToolReview(JSON.parse(text));
   ```

   Errors are `{path, message}`, and the document root is `$`. `checked` is the
   denominator: the report plus its ledger rows and findings. There is no
   command-line entry point in this release.

   ### Not checked by the validator

   The `canary-blackalice` CLI is to enforce these producer obligations when it
   ships (spec phase 3). They are **not shipped yet**:

   - A row's companion from the [Ledger](#ledger) table, enforced when the row
     is recorded.
   - **Zero `walked` rows is an abstention, not a review with no findings.**
     `report build` prints the abstention line first, writes no report, and
     exits 0, or 3 under `--strict`.
   - Exit codes: 0 ok, 1 refused, 2 usage error, 3 abstention (only under
     `--strict`).

   ## Consumers

   None yet. `canary-blackalice` (phases 2-4 of [#1524]) is the first producer.

   [#1524]: https://github.com/bop-clocktower/canary/issues/1524
   [adr-0045]: ../knowledge/decisions/0045-tool-review-ledger-first-contract.md
   ````

3. From `$WT`, format and lint (each command separately):

   ```bash
   ts/node_modules/.bin/prettier --write docs/specs/canary-tool-review-contract.md
   npx --yes markdownlint-cli docs/specs/canary-tool-review-contract.md
   node scripts/check_doc_fences.mjs
   ```

   Then confirm the `## Shape` block is still byte-identical to the fixture.
   This must print nothing:

   ````bash
   diff <(awk '/^```json$/{f=1;next} /^```$/{if(f){exit}} f' docs/specs/canary-tool-review-contract.md) \
     agents/skills/test/fixtures/contracts/tool-review.valid.json
   ````

4. Run `harness validate`.
5. Commit: `docs(contracts): canary.tool-review/1 contract spec`, with body
   `Refs #1524`.

### Task 10: ADR 0045, its index row, and ADR 0035's pointer

**Depends on:** Task 9 · **Files:**
`docs/knowledge/decisions/0045-tool-review-ledger-first-contract.md`,
`docs/knowledge/decisions/README.md`,
`docs/knowledge/decisions/0035-versioned-two-layer-qa-data-contract.md` ·
**[checkpoint:human-verify]** (the human accepts the ADR in PR review, the ADR
0035 precedent; do not stop execution)

1. **RED.** Create the ADR file first (step 2), then run
   `cd "$WT/ts" && npx vitest run test/adr-index.test.ts`. It fails: 0045 has no
   index row.
2. Create `docs/knowledge/decisions/0045-tool-review-ledger-first-contract.md`:

   ```markdown
   ---
   number: 0045
   title: canary.tool-review/1 is a ledger-first review contract
   date: 2026-10-28
   status: accepted
   tier: medium
   source: https://github.com/bop-clocktower/canary/issues/1524
   ---

   <!-- markdownlint-disable-file MD025 -->

   # ADR 0045 — `canary.tool-review/1` is a ledger-first review contract

   **Status:** accepted **Date:** 2026-10-28 **Deciders:** Bri Stevenski
   (maintainer) **Related:**
   [#1524](https://github.com/bop-clocktower/canary/issues/1524) (this
   decision); `docs/changes/canary-blackalice/proposal.md` (D8, D9, D11); ADR
   0035 (the contract family, its keyword subset, and D3's naming); ADR 0036 (no
   composite health score); ADR 0009 (exit 3 reserved for "abstained")

   ## Context

   `canary-blackalice` reviews a QA tool from the seats of the six personas who
   use it, and writes down what it found. A review has the failure mode it looks
   for in others. A report that lists findings without saying how much of the
   tool it examined reads as "everything else is fine", which is the false green
   STRATEGY.md says canary exists to prevent ("degrades loudly when the evidence
   tier drops rather than silently guessing").

   The report needs a versioned, validated shape so that two reviews of the same
   tool can be diffed. The existing family does not fit it as-is:

   - `document.mjs` dispatches on `CONTRACT_RE = /^canary\.([a-z]+)\/(\d+)$/`
     over a fixed `LAYERS = ['run', 'assessment', 'site']`. The regex admits no
     hyphen. Routing a fourth contract through it would widen a validator three
     contracts and their producers depend on.
   - The schemas must stay inside ADR 0035's audited keyword subset: no `oneOf`,
     no `additionalProperties`, no `minItems`. "A finding names a job, a quality
     or both", "no score key anywhere" and "at least one piece of evidence"
     cannot be stated there.

   ## Decision

   1. **A standalone contract, `canary.tool-review/1`.** Its schema is
      `agents/skills/lib/contracts/tool-review.v1.schema.json`. It is
      **validated by its own entry point**, `tool-review.mjs`
      (`validateToolReview`), following `critical-areas.mjs`. `document.mjs`,
      `validate.mjs` and `rules.mjs` are not changed. A test pins that the
      shared validator refuses this contract string.
   2. **Naming extends ADR 0035 D3.** Layer contracts stay
      `canary.<layer>/<major>`. Standalone contracts use
      `canary.<name>/<major>`, and `<name>` may contain hyphens. The schema's
      `const` is the whole check, so a different major is refused.
   3. **Ledger first.** Every merged job and every discovered result surface is
      a ledger row in exactly one of four states: `walked`, `mapped`,
      `not-assessed` or `not-applicable`. `pending` is a working-file state that
      a report never carries, and the schema refuses it. The Markdown render
      opens with the ledger counts, before any finding.
   4. **Run-level abstentions are a required list.** `not_assessed` holds what
      the run could not exercise at all. An absent list is refused and `[]`
      means none, so "nothing was skipped" is a statement, not a missing key.
      Per-row abstentions stay in the ledger.
   5. **Three named rules, in the entry point.** `jobOrQuality`,
      `noCompositeScore` (the keys `score`, `overall`, `composite` and `rating`,
      refused by key presence on the report and every finding) and
      `evidenceRequired`. They live in `tool-review.mjs`, as
      `critical-areas.mjs` keeps its own rules, because they belong to this
      contract alone and `rules.mjs` serves the layer family.
   6. **No composite score** (spec D8). This applies ADR 0036 to tool reviews.
      It needs no new principle, only the rule that enforces it.

   ## Consequences

   - A tool review can be validated and diffed run over run, and a report that
     hides a persona behind a score, or a finding with nothing to point at,
     cannot validate.
   - The four layer-family modules are untouched, so this decision cannot
     regress `canary.run/1`, `canary.assessment/1` or `canary.site/1`.
   - **The validator does not check per-row companions** (a walked row's
     screenshot, a not-assessed row's reason) or the zero-walked abstention.
     These are producer obligations of the `canary-blackalice` CLI, which
     enforces them when a row is recorded and when a report is built. A
     hand-assembled report could carry a `walked` row without evidence and still
     validate. Making those contract rules is additive (a minor version) if a
     second producer appears.
   - `reviewed_at` is checked against the timestamp pattern only. The
     `real-dates` rule is not applied, so a month 13 is accepted.
   - Two validator entry points now exist for contracts with a `contract` field.
     A reader picks one by contract string; `document.mjs` stays the entry point
     for the layer family only.

   ## Alternatives Considered

   - **Route through `document.mjs`** by widening `CONTRACT_RE` and `LAYERS`.
     Rejected: it changes a validator other teams' producers depend on, in order
     to add a contract none of them produce.
   - **`oneOf` / `additionalProperties` in the schema.** Rejected: outside ADR
     0035's audited subset, which refuses at load any keyword it does not
     enforce.
   - **The rules in `rules.mjs`**, as the spec's file layout first said.
     Rejected: that module is the layer family's, dispatched by layer, and at
     258 lines it sits under `check-perf`'s 300-line threshold. Three more rules
     would cross it.
   - **A score out of 10.** Rejected by spec D8 and ADR 0036.
   ```

   If fork P1 was (a), rewrite Decision 5 and the third Alternative to match. If
   P2 was (a), drop `evidenceRequired` and "a finding with nothing to point at".

3. Add the index row to `docs/knowledge/decisions/README.md`, directly after the
   `[0044]` row:

   ```markdown
   | [0045](0045-tool-review-ledger-first-contract.md) | `canary.tool-review/1`
   is a ledger-first review contract | accepted |
   ```

4. In `docs/knowledge/decisions/0035-versioned-two-layer-qa-data-contract.md`,
   replace

   ```text
   "abstained"); ADR 0029 (repo-relative `file` join key); ADR 0030 (additive
   schema versions)
   ```

   with

   ```text
   "abstained"); ADR 0029 (repo-relative `file` join key); ADR 0030 (additive
   schema versions); ADR 0045 (extends D3's naming to standalone contracts)
   ```

5. Format, lint, **GREEN**:

   ```bash
   cd "$WT"
   ts/node_modules/.bin/prettier --write docs/knowledge/decisions/0045-tool-review-ledger-first-contract.md docs/knowledge/decisions/README.md docs/knowledge/decisions/0035-versioned-two-layer-qa-data-contract.md
   npx --yes markdownlint-cli docs/knowledge/decisions/0045-tool-review-ledger-first-contract.md docs/knowledge/decisions/README.md docs/knowledge/decisions/0035-versioned-two-layer-qa-data-contract.md
   node scripts/check_doc_links.mjs
   node scripts/check_doc_fences.mjs
   cd ts && npx vitest run test/adr-index.test.ts
   ```

   Check that prettier did not re-pad the whole index table:
   `git -C "$WT" diff --stat docs/knowledge/decisions/README.md` should show
   `1 insertion`.

6. Run `harness validate`.
7. Commit: `docs(adr): 0045 canary.tool-review/1 is a ledger-first contract`,
   with body `Refs #1524`.

### Task 11: `AGENTS.md` and `CHANGELOG.md`

**Depends on:** Task 10 · **Files:** `AGENTS.md`, `CHANGELOG.md` · **Category:**
integration

1. **Check first.** `grep -n 'tool-review' "$WT/AGENTS.md" "$WT/CHANGELOG.md"`
   prints nothing. That is the drift this task closes.
2. In `AGENTS.md`, replace

   ```text
     carry `measure` for assessments. Specs in `docs/specs/canary-*-contract.md`;
     [ADR 0035][adr-0035].
   ```

   with

   ```text
     carry `measure` for assessments. Specs in `docs/specs/canary-*-contract.md`;
     [ADR 0035][adr-0035]. `canary.tool-review/1` (`canary-blackalice`'s report)
     is a standalone contract outside the layer family: its schema sits in the
     same directory, and it is validated by its own API-only entry point,
     `tool-review.mjs` (`validateToolReview`), never by `validate.mjs`
     ([ADR 0045][adr-0045]).
   ```

   and after the `[adr-0035]:` reference definition (two lines, at the end of
   the file), add:

   ```text
   [adr-0045]:
     docs/knowledge/decisions/0045-tool-review-ledger-first-contract.md
   ```

3. In `CHANGELOG.md`, directly after `## [Unreleased]` and its blank line,
   insert:

   ```markdown
   ### Added

   - **`canary.tool-review/1` contract (#1524, phase 1 of
     `canary-blackalice`).** A versioned report for reviewing a QA tool from its
     users' seats: a coverage ledger in which every job and result surface ends
     in exactly one state (walked, mapped, not-assessed, not-applicable),
     findings that carry a persona, a plain-language cost and evidence, and a
     required `not_assessed` list of run-level abstentions. It is validated by
     its own entry point, `agents/skills/lib/contracts/tool-review.mjs`, with
     three named rules: `jobOrQuality`, `noCompositeScore` and
     `evidenceRequired`. Spec: `docs/specs/canary-tool-review-contract.md`;
     ADR 0045.
   ```

   No closing keyword may sit next to `#1524` (phase 1 does not close it).

4. Format and lint:

   ```bash
   cd "$WT"
   ts/node_modules/.bin/prettier --write AGENTS.md CHANGELOG.md
   npx --yes markdownlint-cli AGENTS.md CHANGELOG.md
   node scripts/check_doc_links.mjs
   ```

5. Run `harness validate`.
6. Commit: `docs: describe canary.tool-review/1 in AGENTS.md and the changelog`,
   with body `Refs #1524`.

### Task 12: four gates, in both trees

**Depends on:** Tasks 2-11 · **Files:** none (fixes, if any, go in a separate
commit that names the gate)

Run each command on its own and read its count. Never trust `$?` after a pipe:
in zsh use `pipestatus`, or do not pipe.

```bash
cd "$WT/agents/skills"
npm run typecheck
npm run format:check
npm test          # thresholds 90/90/85/90; record the test-file and test counts

cd "$WT/ts"
npm run build
npm run typecheck
npm run format:check
npm test          # covers adr-index, entropy-entrypoints and harness-config tests
```

Expect the skills suite's test count to have grown by the
`contracts-tool-review.test.ts` file and the new cases in the two edited suites.
A count that did not grow is an abstention. There is no lint script; do not
invent one. If a gate fails on something this branch did not touch, file an
issue rather than narrowing "passing" (rule 5).

### Task 13: ratchets against the merge base

**Depends on:** Task 12 · **Files:** none, unless the checkpoint below chooses
an allowance · **[checkpoint:decision]** only if any delta is non-zero

```bash
cd "$WT"
harness check-deps > "$M/deps-head.txt" 2>&1; grep 'Analyzed' "$M/deps-head.txt"   # 530 = base 529 + tool-review.mjs
harness validate
harness cleanup --findings-json > "$M/entropy-head.txt" 2>&1 || true
harness check-perf > "$M/perf-head.txt" 2>&1 || true
harness check-arch --json > "$M/arch-head.json" 2>/dev/null || true
harness check-docs --json > "$M/docs-head.json" 2>/dev/null || true

node scripts/entropy-ratchet.mjs --report "$M/entropy-head.txt" --base-report "$M/entropy-base.txt" --base-baseline .harness/entropy-baseline.json --cli-version 13.0.0
node scripts/perf-ratchet.mjs --report "$M/perf-head.txt" --base-report "$M/perf-base.txt" --base-baseline .harness/perf-baseline.json --report-root "$WT" --base-report-root "$WT" --cli-version 13.0.0
node scripts/docs-ratchet.mjs --report "$M/docs-head.json" --base-report "$M/docs-base.json" --base-baseline .harness/docs-coverage-baseline.json --cli-version 13.0.0
node scripts/arch-verdict.mjs "$M/arch-head.json"
grep -n 'lib/contracts' "$M/perf-head.txt" "$M/entropy-head.txt"   # must print nothing
wc -l agents/skills/lib/contracts/rules.mjs                          # still 258 (P1 b)
node scripts/check_removed_symbols.mjs                               # leak gate
npx --yes markdownlint-cli "**/*.md" --ignore node_modules --ignore plugins --ignore agents/agents --ignore agents/commands
node scripts/check_doc_fences.mjs
node scripts/check_doc_links.mjs
```

Expect:

- entropy and perf exit 0 with a **+0 delta**;
- docs exits 0, and coverage did not fall, because the contract doc links both
  new source files;
- `arch-verdict` exits 0 with `0 new violation(s)`, and the module-size total
  stays under the effective ceiling. Compute the ceiling with the `node -e`
  snippet in `AGENTS.md` ("the bar your PR is actually measured against"). The
  1% tolerance over the 55480 floor is about 555, and this branch adds about 110
  measured lines;
- the leak gate exits 0. Report how many denylist terms it loaded: if
  `CANARY_PROPRIETARY_DENYLIST` is unset and no gitignored denylist file exists,
  the proprietary half did not run. Say so; do not report it as clean.

**[checkpoint:decision], only on a non-zero delta.** Never raise `maxFindings`,
`maxViolations` or any baseline. Options, in order of preference: (1) fix the
code, for example by splitting a function; (2) for a coupling-ratio finding on
`tool-review.mjs`, a `deltaAllowances` entry in `.harness/perf-baseline.json`
with a `why`, citing the `canary-test-cli/reporter` precedent; (3) for arch
growth beyond the tolerance, a
`.harness/arch/allowances/feat-blackalice-1-contract.json` with the measured
absolute value. Present the measured numbers with the options, and wait.

### Task 14: probes, rule-8 check, self-review, PR readiness

**Depends on:** Task 13 · **Files:** none (probes are reverted) ·
**[checkpoint:human-verify]**

1. **Probes: each must turn the suite red, then be reverted.** Each probe edits
   only files this branch created. Revert with `git -C "$WT" checkout -- <file>`
   after each one.
   - In `tool-review.mjs`, make `jobOrQuality` return `[]` unconditionally. The
     `jobOrQuality` fixture test must fail.
   - In `tool-review.mjs`, remove `'rating'` from `SCORE_KEYS`. The
     no-composite-score fixture test and the `rating` case must fail.
   - In `tool-review.mjs`, make `evidenceRequired` return `[]`. Its fixture test
     must fail.
   - In `tool-review.v1.schema.json`, remove `"not_assessed"` from the root
     `required`. The criterion-12 test must fail.
   - In `tool-review.v1.schema.json`, add `"minItems": 1` to the finding
     `evidence`. Importing `tool-review.mjs` must throw `unenforceable schema`,
     which proves the subset audit covers the new file.

   Then run `cd "$WT/agents/skills" && npx vitest run test/contracts-*.test.ts`
   green again, and `git -C "$WT" status --short` must be empty.

2. **The shared validator is untouched (T8).** This must print nothing:

   ```bash
   C=agents/skills/lib/contracts
   git -C "$WT" diff --stat 5cb10f0b -- "$C/document.mjs" "$C/validate.mjs" \
     "$C/rules.mjs" "$C/schema-check.mjs" "$C/schema-problems.mjs" "$C/field-checks.mjs"
   ```

3. **Rule 8, asked explicitly.** What does this change make wrong? Expected
   answer: nothing left, once `AGENTS.md`'s contract bullet was updated (Task
   11); the spec's phase-4 docs (`agents/skills/README.md`,
   `docs/wiki/Tool-Review.md`) describe a skill that does not exist yet and are
   correctly deferred. Spec drift remains: the spec's file layout says the rules
   go in `rules.mjs` and names two rules. Record that in the PR body as a
   deliberate deviation (forks P1 and P2), and leave the proposal edit to the
   human. What behavior does nothing test? Expected answer: the per-row
   companions and the zero-walked abstention, which are deliberately not
   contract rules (ADR 0045 Consequences).
4. **Self-review.** Read `git -C "$WT" diff 5cb10f0b` as a reviewer would, not
   as the author. Check for denylist or client terms in the fixtures, comments
   that claim more than the code does, and docs that describe the phase-3 CLI as
   shipped.
5. **Base freshness.** `git -C "$WT" fetch origin`. If `origin/main` is no
   longer `5cb10f0b`, rebase onto it, re-run Task 12, and re-measure Task 13's
   base in a fresh detached worktree of the new merge base (the main directory
   reads entropy high). Watch for `CHANGELOG.md` conflicts in particular.
6. **Hand off, without opening the PR.** Report the branch, the commit list, the
   criterion→test table (§5), the fork decisions, the ratchet lines and the
   rule-8 answers to the orchestrator, which opens the PR (`Refs #1524`; never
   `Closes`; no co-author trailer).

## 5. Criterion → test traceability

| Criterion   | Test file                       | Test name(s)                                                                                                                                                                                                                                                      |
| ----------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 11          | `contracts-tool-review.test.ts` | `refuses a finding without %s` (×3: evidence, cost, persona); `refuses a blank cost …`; `rule jobOrQuality` (4 tests, fixture `tool-review.job-or-quality.invalid.json`); `rule evidenceRequired` (3 tests, fixture `tool-review.evidence-required.invalid.json`) |
| 12          | `contracts-tool-review.test.ts` | `refuses a report without not_assessed`; `accepts not_assessed as [] … or as run-level reasons`; `refuses not_assessed: null …`                                                                                                                                   |
| 15          | `contracts-tool-review.test.ts` | `rule noCompositeScore` (fixture test, ×4 key-presence cases, the unknown-field control); fixture `tool-review.no-composite-score.invalid.json`                                                                                                                   |
| T8          | `contracts-validate.test.ts`    | `refuses canary.tool-review/1: a standalone contract has its own entry point`; Task 14 step 2 diff                                                                                                                                                                |
| T9          | `contracts-schemas.test.ts`     | registry test; `%s: $id is its file name, contract its const`; `%s: the valid fixture has zero schema errors`; `tool-review: reviewed_at uses the run timestamp pattern verbatim`; `uses only enforced keywords …`                                                |
| Non-vacuity | all three                       | the corpus test lists four `.valid.json` files; each named-rule fixture's only error is that rule; the Task 14 probes                                                                                                                                             |

## 6. Risks

- **The spec deviates (P1, P2).** Both are surfaced at Task 1, with the
  amendment path written down, rather than decided silently.
- **CI-only ratchets** (dead exports, perf coupling, arch module-size) are
  invisible to the four gates. Mitigations: one export, one local import, the
  entry-point declaration in Task 8, and the merge-base measurements in Tasks 1
  and 13, with a decision checkpoint rather than a silent allowance.
- **Contract permanence.** P3 and P4 fix field shapes that are costly to change
  after release (ADR 0035 D3).
- **Absolute ratchets do not compose.** Phases merge serially, and Task 14
  re-measures if `main` moved.

## Appendix A — `agents/skills/lib/contracts/tool-review.mjs` after Task 7

```js
// Validator for canary.tool-review/1 (ADR 0045): the report canary-blackalice
// writes after reviewing a QA tool from the seats of the people who use it.
//
// Schema-driven like the canary.* layers: tool-review.v1.schema.json is the
// contract, interpreted by the same audited subset checker. It is its own
// entry point, following critical-areas.mjs, and is not routed through
// document.mjs: that module's CONTRACT_RE admits no hyphen and its LAYERS are
// fixed to run/assessment/site, so routing this contract there would widen a
// validator three other contracts depend on. The rules the subset cannot
// express live here, not in rules.mjs, for the reason critical-areas.mjs keeps
// its own: they belong to this contract alone.
//
// Zero dependencies, and vendorable: nothing here touches a Node global.

import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

import { auditedValidator } from './schema-problems.mjs';

const ID = 'tool-review.v1.schema.json';

const checkSchema = auditedValidator({
  [ID]: JSON.parse(readFileSync(new URL(`./${ID}`, import.meta.url), 'utf8')),
});

/** The roll-up keys D8 refuses: a composite hides the persona that was failed. */
const SCORE_KEYS = ['score', 'overall', 'composite', 'rating'];

const listOf = (doc, key) => (Array.isArray(doc?.[key]) ? doc[key] : []);
const isObject = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const at = (prefix, key) => (prefix ? `${prefix}.${key}` : key);

/**
 * Rule `jobOrQuality`: a finding names the job it failed, the quality it
 * failed, or both. Only an explicit null pair is refused: an absent or
 * wrong-typed field is the schema's error, not a second one here.
 */
function jobOrQuality(finding, prefix) {
  if (finding.job !== null || finding.quality !== null) return [];
  return [
    {
      path: prefix,
      message:
        'names neither a job nor a quality; set job, quality or both (rule jobOrQuality)',
    },
  ];
}

/**
 * Rule `noCompositeScore` (D8, ADR 0036): no roll-up score on the report or on
 * any finding. Key presence counts, as with rules.mjs's authorExcluded: even
 * `null` is refused, because unknown fields are otherwise tolerated and that
 * tolerance must not become a way back in for a score.
 */
function noCompositeScore(record, prefix) {
  return SCORE_KEYS.filter((key) => Object.hasOwn(record, key)).map((key) => ({
    path: at(prefix, key),
    message:
      'must not be supplied: a tool review carries no composite score (rule noCompositeScore)',
  }));
}

/**
 * Rule `evidenceRequired`: a finding cites at least one piece of evidence. The
 * subset has no `minItems`, so `evidence: []` passes the schema; a non-array is
 * the schema's error, not a second one here.
 */
function evidenceRequired(finding, prefix) {
  const { evidence } = finding;
  if (!Array.isArray(evidence) || evidence.length > 0) return [];
  return [
    {
      path: at(prefix, 'evidence'),
      message:
        'is empty; a finding cites at least one screenshot, snapshot or file (rule evidenceRequired)',
    },
  ];
}

const FINDING_RULES = [jobOrQuality, noCompositeScore, evidenceRequired];

function ruleErrors(doc) {
  if (!isObject(doc)) return [];
  return [
    ...noCompositeScore(doc, ''),
    ...listOf(doc, 'findings').flatMap((finding, i) =>
      isObject(finding)
        ? FINDING_RULES.flatMap((rule) => rule(finding, `findings[${i}]`))
        : [],
    ),
  ];
}

/**
 * Validate a parsed canary.tool-review/1 report.
 * @param {unknown} doc
 * @returns {{valid: boolean, checked: number,
 *            errors: {path: string, message: string}[]}}
 *   `checked` counts the report, its ledger rows and its findings: the
 *   denominator a caller reports.
 */
export function validateToolReview(doc) {
  const errors = [...checkSchema(ID, doc), ...ruleErrors(doc)];
  const checked =
    1 + listOf(doc, 'ledger').length + listOf(doc, 'findings').length;
  return { valid: errors.length === 0, checked, errors };
}
```
