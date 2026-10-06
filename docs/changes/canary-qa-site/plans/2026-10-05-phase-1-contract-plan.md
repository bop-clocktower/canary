# Plan: canary QA site, phase 1 — the versioned contract

Issue: [#1151](https://github.com/bop-clocktower/canary/issues/1151) · Spec:
[proposal.md](../proposal.md) (Implementation Order item 1) · Date: 2026-10-05 ·
Base: `0ba2dd68` (`docs/canary-qa-site-spec`) · Branch:
`feat/1151-qa-site-contract` · Rigor: standard · **Tasks:** 12 · **Time:** ~55
min · **Integration Tier:** medium

## Approval amendments (2026-10-05) — these override the tasks below

Approved by the human with these changes. Where a task below disagrees, this
section wins.

1. **Fork C:** `register[]` rows carry **no `who`/author field**. Required
   fields: `scope`, `title`, `file`, `kind`, `reason`, `recorded_at`, `commit`,
   `cause`, `issue`. A `who` or `author` key on a register row is refused by a
   named rule in `rules.mjs` (key presence). The site-feed contract doc states
   that author identity is deliberately excluded from a public feed.
2. **Fork D:** add tests that `healthy`, `degraded` and `critical` with a null
   `value` are each refused (path `value`), alongside the `observed` case.
3. **New commit before Task 12:**
   `docs(canary-qa-site): correct spec per phase-1 planning`, editing
   `docs/changes/canary-qa-site/proposal.md` only: criterion 4 scoped to
   list-valued `results` (fork A); `suites[]` and `flaky[]` carry full
   `scope {id, env}` (fork B); criterion 2 also covers healthy/degraded/critical
   (fork D); D3 states readers tolerate unknown fields but refuse `verified` and
   wrong-layer records (fork E); a run-status alignment note for `flaky` (fork
   L); `register` drops `who`; D3 line citations corrected to
   `ts/src/history/record.ts:18` and `ts/src/history/ndjson-store.ts:92-96`.
   De-identified.
4. **Task 11:** no checkpoint stop — write the ADR; the human reviews it in the
   PR.
5. **Task 12 PR step:** run `gh pr view 1152 --json state -q .state`. If
   `MERGED`: `git fetch origin && git rebase --onto origin/main 0ba2dd68`,
   re-run the four gates in `ts/` and `agents/skills/`, push, open the PR with
   `Refs #1151`. Otherwise push the branch but do **not** open a PR. Never
   merge.

## Goal

A producer can hand canary any `canary.run/1`, `canary.assessment/1` or
`canary.site/1` document and get a zero-dependency, schema-driven verdict that
refuses every malformed shape the spec names, and names the field that caused
the refusal.

**Skills:** `harness-data-validation` (reference) applies to Tasks 1-7. The
other `SKILLS.md` recommendations (`css-css-modules`, `svelte-stores-pattern`,
`design-design-documentation`) are for phase 3, not this phase.

## Observable truths (acceptance criteria, in scope)

| #   | EARS statement                                                                                                                                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | When a record has no `contract` field, or a `contract` naming an unknown major version, the validator shall refuse it with an error whose `path` is `contract`.                                           |
| 2   | If an assessment is `not-assessed`, then the validator shall refuse it when `value` is non-null (path `value`) or `reason` is null or blank (path `reason`); if `observed`, it shall refuse a null value. |
| 3   | If a producer supplies a `verified` key, with any value including `null`, then the validator shall refuse the record (path `verified`).                                                                   |
| 4   | When `results` is an array and `totals.total` differs from `results.length`, the validator shall refuse the run (path `totals.total`, or `runs[i].totals.total` inside a site feed).                      |
| 16  | When a record has no `scope`, or a `scope` missing `id` or `env`, the validator shall refuse it with the path `scope`, `scope.id` or `scope.env`.                                                         |
| 17  | If an assessment sets exactly one of `verified_by` and `verified_at`, then the validator shall refuse it, naming the half that is missing.                                                                |
| 18  | If the validator's input is not parseable JSON (including empty input), then it shall refuse it: `valid: false`, path `$`, CLI exit 1. A parse failure is never exit 0.                                   |
| 15  | Build, typecheck, format check and tests pass in `ts/` and `agents/skills/`; the entropy, perf and arch ratchets pass with no new finding identity and no change to `maxFindings` or any baseline.        |

Each criterion maps to named tests in the
[traceability table](#5-criterion--test-traceability).

---

## 1. EXPLORE — what is actually true

Every load-bearing claim from the spec and the orchestrator brief was re-derived
against `0ba2dd68` before tasks were written.

| Claim                                                                                  | Verdict                      | Evidence (re-measured 2026-10-05)                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `format:check` and coverage `include` use `lib/*.mjs`, which is not recursive          | Correct                      | `agents/skills/package.json` `format:check` starts `"lib/*.mjs"`; `agents/skills/vitest.config.ts` coverage `include` starts `'lib/*.mjs'`. A `lib/contracts/*.mjs` file sits outside both, so it would be silently unformatted and uncovered.                                                                                                                                                                                       |
| vitest only collects `test/*.test.ts`                                                  | Correct                      | `agents/skills/vitest.config.ts` `include: ['test/*.test.ts']`. Tests go flat in `agents/skills/test/`.                                                                                                                                                                                                                                                                                                                              |
| `agents/skills/tsconfig.json` does not cover `lib/`                                    | Correct                      | `include: ["test", "claude-code/**/scripts/**/*.mjs"]`, `checkJs: false`. `lib/parse-args.mjs` is not typechecked either. Tests that import the new modules are typechecked, and TS infers the JS signatures, so exported functions carry JSDoc param types (see Task 6). Not changed here.                                                                                                                                          |
| No JSON Schema library exists                                                          | **Mostly; one correction**   | No direct dependency anywhere, and `agents/skills/package-lock.json` has no `ajv`. But `ajv@8.20.0` is in `ts/package-lock.json` and `npm/package-lock.json` **transitively**, through `@modelcontextprotocol/sdk`. It is not usable here: the validator must run from the shipped skills tree with nothing installed, and a transitive dependency is not a contract. Zero-dep stands.                                               |
| The entropy analyzer does not follow relative imports                                  | **Contradicted**             | `agents/skills/lib/parse-args.mjs` is in neither `entryPoints` array, yet `harness cleanup --type dead-code` (141 findings) does not list it as a dead file or any of its exports as dead. It is imported by `cli.mjs` entry points. So reachability **does** follow relative imports from an entry point. Exports of a **non**-entry module that only tests use **are** flagged (`canary-katana/scripts/ledger.mjs` `CAUSES`, ...). |
| `entropy.entryPoints` and `performance.entryPoints` must both list the new entry point | Correct, with two more rules | `ts/test/entropy-entrypoints.test.ts`: both lists must be **identical and in the same order**, every entry must be a **git-tracked** file, and entries must be literal paths, not globs. So the entry is added only after `validate.mjs` is committed (Task 8).                                                                                                                                                                      |
| Perf thresholds                                                                        | Correct, and more of them    | `harness check-perf` at `0ba2dd68`: cyclomatic complexity warns above **10** (error 15); function length above **50** lines; nesting depth above **4**; file length above **300** lines; coupling ratio above **0.7**. Coupling fires on `cli.mjs` files with many local imports (`canary-question`, 7 local) and not on few (`canary-shadow` 1, `canary-blackhawk` 3, `canary-fail-fast` 4).                                        |
| Perf and entropy headroom                                                              | Measured                     | `check-perf`: **216** issues against `maxViolations` 220. `harness cleanup --findings-json`: **141** against `maxFindings` 145. Both baselines stamp `harnessCli` **12.10.1**, which is the local CLI. On a PR the merge-base delta rule is the binding one, so the target is **zero** new finding identities.                                                                                                                       |
| Arch ratchet scans `agents/skills/`                                                    | **No**                       | `harness check-arch` output contains zero `agents/skills` lines. Phase 1 cannot move it; it is still measured in Task 12.                                                                                                                                                                                                                                                                                                            |
| Harness layers need no entry for `lib/contracts/`                                      | Correct                      | `SOURCE_ROOT = 'ts/src'` in `ts/test/harness-config-denominator.test.ts:56`.                                                                                                                                                                                                                                                                                                                                                         |
| Next ADR number is 0035                                                                | Correct                      | Highest file is `0034-route-labels-...md`. `git log --all -- 'docs/knowledge/decisions/0035*'` is empty. `ts/test/adr-index.test.ts` requires an index row whose status matches the frontmatter. `ts/test/adr-ingestable.test.ts` requires `number` and `title` on single lines, because harness parses frontmatter line by line, so the title must stay short enough that prettier cannot wrap it.                                  |
| Exit-code vocabulary                                                                   | Correct                      | `EXIT_USAGE = 2` exported from `agents/skills/lib/parse-args.mjs`; exit 3 reserved CLI-wide for "abstained" (ADR 0009).                                                                                                                                                                                                                                                                                                              |
| Main-guard pattern                                                                     | **Two patterns in use**      | Skill CLIs use `` import.meta.url === `file://${process.argv[1]}` `` (14 sites), which breaks on paths with spaces. `scripts/*.mjs` use `pathToFileURL(process.argv[1]).href` (5 sites). This plan uses the second. The skills set `process.exitCode = main(...)` rather than `process.exit()`, because `process.exit` truncates a large piped `--json` payload (#791). This plan follows that.                                      |
| The reporter emits a run-level `flaky` status                                          | Correct                      | `npm/src/reporters/testtracker.ts:59` `status: "passed" \| "failed" \| "flaky" \| "cancelled"`; `runStatus` (`:149-154`) returns `flaky` when `totals.flaky > 0`. The spec's `run.status` drops `flaky`. See fork L.                                                                                                                                                                                                                 |
| D3 citations                                                                           | Correct (lines drifted ±1)   | `ts/src/history/record.ts:18` `SCHEMA_VERSION = 3`; `ts/src/history/ndjson-store.ts:92-96` refuses an unsupported `schema_version`.                                                                                                                                                                                                                                                                                                  |
| Contract doc precedent                                                                 | Correct                      | `docs/specs/coverage-json-contract.md`: frontmatter `project/version/created`. It ignores unknown fields and refuses an unknown version. Its validator exits **2** on non-JSON. See fork M.                                                                                                                                                                                                                                          |
| Node pin                                                                               | Correct                      | `.nvmrc` = `22.23.2`. `agents/skills` `engines` is `>=20`, so the validator must not use JSON import attributes (`with { type: 'json' }`), which arrived in 20.10. It reads schemas with `readFileSync`.                                                                                                                                                                                                                             |
| The spec commit is on `main`                                                           | **Not yet** (local refs)     | `git branch -r --contains 0ba2dd68` lists only `origin/docs/canary-qa-site-spec`. The phase-1 PR either waits for the spec PR or carries its commit. See Task 12.                                                                                                                                                                                                                                                                    |
| Knowledge baseline (Phase 1.5)                                                         | **Abstained**                | `harness knowledge-pipeline --domain contracts`: `PASS`, but `Coverage: N/A — no measurable domains (run harness graph scan)`. No graph exists in this worktree, so the pass measured nothing. `--fix` was not run because this was a plan-only session. Re-run with `--fix` after phase 1 merges, once the ADR exists to ingest.                                                                                                    |

## 2. EVALUATE — spec defects and forks, each with a recommended default

The spec is approved. These are the places where it contradicts itself or is
silent. Each one has a default that the plan implements. **Approving the plan
approves these defaults.** Any default you overturn changes only the task named
in its row.

| #   | Defect / fork                                                                                                                                                                                              | Recommended default                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Why                                                                                                                                                                                             | Tasks   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| A   | `site.json` `runs[]` carries per-test results only on each suite's latest run, but criterion 4 refuses any run where `totals.total != results.length`.                                                     | **`results` is `array \| null` in `canary.run/1`.** `null` means the per-test results are not carried in this record. That is distinct from `[]`, which means zero tests: the D4 vocabulary, applied. The totals rule applies only when `results` is an array.                                                                                                                                                                                                                                                                                                                                                                                                                               | One run shape everywhere, with no `run-summary` variant to drift. The cost is that a standalone run record may also omit results. That is visible (`null`), never silent.                       | 2, 5    |
| B   | `suites[]` and `flaky[]` carry `scope` as a bare id string (`flaky[]` has none at all), which conflicts with D2's `scope: {id, env}`.                                                                      | **D2 wins.** Every `scope` in `canary.site/1` is the full `{id, env}` object, including on `suites[]`, `flaky[]` and `register[]`. A bare string is refused with path `suites[i].scope`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | D2 exists because implicit scope resolved a handoff to the wrong tenant. The spec example is the defect.                                                                                        | 4, 6    |
| C   | `register[]` shape is unspecified ("reason, age, who").                                                                                                                                                    | **Define it now, mirroring the `canary-katana` ledger row:** required `scope`, `title`, `file`, `kind`, `reason`, `recorded_at` (from the ledger's `date`), `commit` (from the ledger's `commit`), `cause`, `issue`. `cause` and `issue` are `string \| null`. **AMENDED at approval (2026-10-05): there is NO `who`/author field at all** — author identity is deliberately excluded from a public feed; a `who` or `author` key on a register row is **refused** by a named rule in `rules.mjs` (key presence, like `verified`, fork G) so a producer cannot leak it through fork E's unknown-field tolerance; the contract doc says so. "Age" is derived by the panel from `recorded_at`. | D3 makes a later required field a breaking change, so deferring means v1 ships an unconstrained array. Dropping author identity entirely keeps names and emails out of a public feed (PII).     | 4       |
| D   | "value null iff not-assessed" means `healthy`/`degraded`/`critical` also need a non-null value, but criterion 2 tests only `observed`. "reason required iff not-assessed" also forbids a reason elsewhere. | **Enforce both "iff"s literally.** Every status other than `not-assessed` requires a non-null `value` and a null `reason`. `value` is typed `number \| boolean \| null`: finite numbers, plus booleans for pass/fail checks. No strings, so `"N/A"` cannot smuggle an abstention in.                                                                                                                                                                                                                                                                                                                                                                                                         | Widening `value`'s type later breaks v1 readers. Booleans are the minimum a ci-ready check needs.                                                                                               | 3, 5, 6 |
| E   | D3 (a minor version adds optional fields) needs readers that accept unknown fields. That conflicts with `additionalProperties: false`.                                                                     | **Unknown fields are tolerated.** `additionalProperties` is not in the supported keyword subset, so using it is refused at load. Two exceptions are refused: the reserved `verified` key (D5), and a wrong-layer `contract` (for example an assessment validated with `--layer run`).                                                                                                                                                                                                                                                                                                                                                                                                        | Same rule as `coverage-json-contract.md`. Strict closure would make every additive minor a breaking change.                                                                                     | 1, 6    |
| F   | Is `validate.mjs` schema-driven, or hand-coded with the schemas as documentation?                                                                                                                          | **Schema-driven.** `schema-check.mjs` interprets a declared keyword subset: `type required properties items enum const pattern minimum minLength $ref`, plus the annotations `$schema $id $comment title description $defs`. `schemaProblems()` **refuses at load** any unsupported keyword, unknown type name, invalid pattern or unresolvable `$ref`. Cross-field rules live in `rules.mjs` as named functions.                                                                                                                                                                                                                                                                            | The `.schema.json` files are what other teams read. A hand-coded validator drifts from them, and a schema keyword nobody implements reads as enforced while enforcing nothing.                  | 1, 5    |
| G   | `verified: null` supplied by a producer.                                                                                                                                                                   | **Refused.** The check is `Object.hasOwn(record, 'verified')`, so key presence counts, not truthiness.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | D5 says derived and never asserted. A `null` is still an assertion that a reader might trust.                                                                                                   | 5, 6    |
| H   | Errors must name the field (criteria 1, 16).                                                                                                                                                               | **Error shape `{ path, message }`.** `path` is dotted with bracketed indexes (`scope.env`, `runs[1].totals.total`). The document root is `$`. A parse failure is `{ path: '$', message: 'not parseable JSON: …' }`. Every test asserts `path`.                                                                                                                                                                                                                                                                                                                                                                                                                                               | A path is greppable by producers and stable across message rewording.                                                                                                                           | 1, 5, 6 |
| I   | `collected` item shape is undefined ("the full collected test list", #1150).                                                                                                                               | **`{ title, file }` objects**, the same join key as `results[]` (ADR 0029). `null` = not reported; `[]` = none collected.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Strings would lose the file half of the join key. [ASSUMPTION] The ingest API's own `collected[]` shape is not publicly documented, so phase 2 maps to it.                                      | 2       |
| J   | The spec lists two contract docs, but phase 1 also ships `site.v1.schema.json`.                                                                                                                            | **Add a third doc, `docs/specs/canary-site-feed-contract.md`.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Rule 8 (doc drift): a shipped schema with no doc is a gap. Folding the feed into the assessment doc would bury it.                                                                              | 10      |
| K   | Tightening a rule after v1 is published refuses documents that used to pass, which is effectively a breaking change under D3.                                                                              | **Ship one cheap extra invariant now:** the `totals` per-status counts must sum to `totals.total`. It is in the same family as criterion 4. Cross-record site invariants (every run's scope is listed in `scopes[]`, each suite's latest run carries results, `flaky_runs <= window_runs`) are **deferred to phase 2**, which must land them before any npm release carries `canary.site/1`.                                                                                                                                                                                                                                                                                                 | Phase 2 still lands before the first release, so tightening is free until then. The sum rule protects the totals the pass-rate panel will divide by.                                            | 5       |
| L   | The reporter emits run `status: flaky` today. The spec's `run.status` is `passed \| failed \| cancelled` (D1: align).                                                                                      | **Keep the spec's enum.** A run whose only non-passes are recovered flakes is `passed`, and its flakiness is carried in `totals.flaky`. A Playwright `interrupted` or `timedout` run maps to `cancelled`. The run contract doc records the mapping. The existing ingest payload is unchanged; phase 2 adds the new emission next to it.                                                                                                                                                                                                                                                                                                                                                      | Run-level `flaky` conflates "did the run pass" with "was it clean". The totals already carry the second.                                                                                        | 9       |
| M   | Exit code for input that cannot be parsed or read.                                                                                                                                                         | **Unparseable or empty input: exit 1** (a refusal, criterion 18). **Unreadable file, bad flag or bad `--layer`: exit 2** (usage/IO, `EXIT_USAGE`). No exit 3: a parsed document always has a denominator of at least 1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | This differs from `coverage-json-contract.md`, where non-JSON exits 2. Criterion 18 makes unparseable input a verdict about the input, and `site-deploy.yml` fails on any non-zero exit anyway. | 7       |
| N   | Is the validator a "gate" under the new-gate checklist (AGENTS.md, "No silent abstention")?                                                                                                                | **A gate with no abstention path.** It reports its denominator (`checked`: 1 per run or assessment document; `1 + runs + assessments` for a site feed) in both text and `--json` output. It gets **no row** in `agents/skills/test/gate-conformance.test.ts`, because nothing can collapse its denominator to zero. Refusing a feed with zero runs stays in `site-deploy.yml` (D14, phase 5).                                                                                                                                                                                                                                                                                                | Inventing an abstention is its own dishonesty (AGENTS.md: "Unknown is not zero"). The plan says so explicitly rather than silently omitting the registry row.                                   | 6, 7    |
| O   | ADR status.                                                                                                                                                                                                | **`accepted`**, Deciders: Bri Stevenski. The human verifies it at Task 11's checkpoint.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Matches every ADR from 0027 to 0034.                                                                                                                                                            | 11      |
| P   | Should AGENTS.md change in phase 1?                                                                                                                                                                        | **Yes, one bullet** under "Configuration & Data". The skills-section entry the spec lists waits for the phases that ship skills.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Rule 8: a new shipped library with a CLI must be findable from the canonical map now.                                                                                                           | 11      |
| Q   | Should prettier check the `.schema.json` files and the fixtures?                                                                                                                                           | **Yes.** Add `"lib/contracts/*.json"` and `"test/fixtures/contracts/*.json"` to `format:check`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | It costs nothing, and these files are reviewed as contracts.                                                                                                                                    | 8       |

### Uncertainties

- [ASSUMPTION] `run.branch`, `run.commit_sha` and `run.ci_url` are
  `string | null` (unknown, not missing). `run.id`, `suite`, `started_at`,
  `finished_at` and `status` are non-null. If a producer can lack a start time,
  Task 2's schema changes.
- [ASSUMPTION] Three local imports in `validate.mjs` (`parse-args`,
  `schema-check`, `rules`) stay under the coupling threshold
  (`canary-blackhawk/scripts/cli.mjs` has 3 and is not flagged). If Task 12
  measures a coupling finding, fold `rules.mjs` into `schema-check.mjs`, as long
  as that file stays at or under 300 lines.
- [ASSUMPTION] `schema-check.mjs` and `rules.mjs` are reachable through
  `validate.mjs`, so they need no `entryPoints` entry of their own (see the
  `parse-args.mjs` evidence in §1). If Task 12 shows either one as a dead file,
  add it to both `entryPoints` arrays at the same index, as `canary-misfit`
  does.
- [ASSUMPTION] `value` as `number | boolean` covers every phase-2 assessment
  (fork D). If `canary-starling` needs a categorical value, that becomes a v2
  question, not a v1 minor.
- [DEFERRABLE] Exact message wording. Tests pin `path` and a stable substring
  only.
- [DEFERRABLE] The cross-record site invariants from fork K belong to phase 2.
- [DEFERRABLE] A drift test between each doc's JSON example and its fixture. The
  fixtures are the executable examples, and the docs link to them.

## 3. File map

```text
CREATE agents/skills/lib/contracts/schema-check.mjs        # keyword-subset interpreter + schemaProblems
CREATE agents/skills/lib/contracts/rules.mjs               # named cross-field rules
CREATE agents/skills/lib/contracts/validate.mjs            # public API + CLI (the entry point)
CREATE agents/skills/lib/contracts/run.v1.schema.json
CREATE agents/skills/lib/contracts/assessment.v1.schema.json
CREATE agents/skills/lib/contracts/site.v1.schema.json
CREATE agents/skills/test/fixtures/contracts/run.valid.json
CREATE agents/skills/test/fixtures/contracts/assessment.valid.json
CREATE agents/skills/test/fixtures/contracts/site.valid.json
CREATE agents/skills/test/contracts-schema-check.test.ts
CREATE agents/skills/test/contracts-schemas.test.ts
CREATE agents/skills/test/contracts-rules.test.ts
CREATE agents/skills/test/contracts-validate.test.ts      # criteria 1-4, 16-18
CREATE agents/skills/test/contracts-validate-cli.test.ts  # CLI exit codes, criterion 18 end to end
MODIFY agents/skills/package.json                          # format:check globs (lib/**, contracts json)
MODIFY agents/skills/vitest.config.ts                      # coverage include lib/**/*.mjs
MODIFY harness.config.json                                 # validate.mjs in BOTH entryPoints, same index
CREATE docs/specs/canary-run-contract.md
CREATE docs/specs/canary-assessment-contract.md
CREATE docs/specs/canary-site-feed-contract.md             # fork J
CREATE docs/knowledge/decisions/0035-versioned-two-layer-qa-data-contract.md
MODIFY docs/knowledge/decisions/README.md                  # index row
MODIFY AGENTS.md                                           # one bullet (fork P)
```

`schema-check.mjs` exports only what `validate.mjs` or `rules.mjs` import
(`checkValue`, `schemaProblems`, `isPlainObject`, `SUPPORTED_KEYWORDS`).
`rules.mjs` exports only `crossFieldErrors`. That leaves nothing for the
dead-export rule to find. Every file stays at or under 300 lines, and every
function at or under 50 lines, cyclomatic complexity 10 and nesting depth 4. The
`parse-args.mjs` (#906) one-helper-per-decision split is the house pattern.

Skeleton: 1) interpreter (1 task) 2) three schemas + fixtures (3) 3) rules
(1) 4) validator API + CLI (2) 5) gate wiring (1) 6) docs + ADR + map (3) 7)
verify + PR (1). This is 12 tasks, ~55 min. _Skeleton approval is folded into
plan approval; the orchestrator gates this plan at APPROVE_PLAN._

## 4. Tasks (TDD: test first in every code task)

Setup, once before Task 1 (`node_modules` is absent in this worktree):

```bash
WT=/Users/bs/Github/canary/.claude/worktrees/agent-aa7a6968b9b59db96
cd "$WT" && nvm use            # .nvmrc = 22.23.2
cd "$WT/agents/skills" && npm ci
cd "$WT/ts" && npm ci
```

Every command below runs from `$WT/agents/skills` unless stated. Commits use
Conventional Commits with **no co-author trailer**. The body says `Refs #1151`.
Never put close/fix/resolve next to `#1151`, because phases 2-5 remain.

### Task 1: the keyword-subset interpreter

**Depends on:** none · **Files:**
`agents/skills/lib/contracts/schema-check.mjs`,
`agents/skills/test/contracts-schema-check.test.ts`

1. Write `test/contracts-schema-check.test.ts`:

   ```ts
   /**
    * Unit contract for the canary QA contract schema interpreter (#1151, ADR 0035).
    * The interpreter enforces a declared keyword SUBSET; anything outside it is
    * refused at load by schemaProblems(), so a schema edit can never read as
    * enforced while enforcing nothing.
    */
   import { describe, it, expect } from 'vitest';

   import {
     checkValue,
     schemaProblems,
   } from '../lib/contracts/schema-check.mjs';

   type Err = { path: string; message: string };

   function check(
     schema: object,
     value: unknown,
     others: Record<string, object> = {},
   ): Err[] {
     const ctx = {
       registry: { 'x.schema.json': schema, ...others },
       base: 'x.schema.json',
       errors: [] as Err[],
     };
     checkValue(schema, value, '$', ctx);
     return ctx.errors;
   }

   describe('checkValue — keywords', () => {
     it('type: accepts a union member and names the path on a miss', () => {
       expect(check({ type: ['string', 'null'] }, null)).toEqual([]);
       expect(
         check({ properties: { a: { type: 'integer' } } }, { a: 1.5 }),
       ).toEqual([{ path: 'a', message: 'expected integer, got number' }]);
     });

     it('type: names array and null distinctly from object', () => {
       expect(check({ type: 'object' }, [])).toEqual([
         { path: '$', message: 'expected object, got array' },
       ]);
       expect(check({ type: 'object' }, null)).toEqual([
         { path: '$', message: 'expected object, got null' },
       ]);
     });

     it('required: names the missing field by its full dotted path', () => {
       const schema = {
         properties: { scope: { type: 'object', required: ['id', 'env'] } },
       };
       expect(check(schema, { scope: { id: 'x' } })).toEqual([
         { path: 'scope.env', message: 'missing required field' },
       ]);
     });

     it('items: indexes array members in the path', () => {
       expect(check({ items: { type: 'string' } }, ['a', 2])).toEqual([
         { path: '$[1]', message: 'expected string, got number' },
       ]);
     });

     it('enum and const name the allowed values', () => {
       expect(check({ enum: ['a', null] }, 'b')[0].message).toBe(
         'must be one of: "a", null',
       );
       expect(check({ const: 'canary.run/1' }, 'x')[0].message).toBe(
         'must be "canary.run/1"',
       );
     });

     it('pattern, minimum and minLength apply only to their own types', () => {
       expect(check({ pattern: '^[^@]+$' }, 'a@b')).toHaveLength(1);
       expect(check({ pattern: '^[^@]+$' }, null)).toEqual([]);
       expect(check({ minimum: 0 }, -1)[0].message).toBe('must be >= 0');
       expect(check({ minLength: 1 }, '')).toHaveLength(1);
       expect(check({ minLength: 1 }, 7)).toEqual([]);
     });

     it('$ref resolves a local pointer and a pointer into another schema', () => {
       const local = {
         $defs: { s: { required: ['env'] } },
         properties: { a: { $ref: '#/$defs/s' } },
       };
       expect(check(local, { a: {} })).toEqual([
         { path: 'a.env', message: 'missing required field' },
       ]);
       const other = { $defs: { s: { required: ['id'] } } };
       const cross = {
         properties: { b: { $ref: 'other.schema.json#/$defs/s' } },
       };
       expect(check(cross, { b: {} }, { 'other.schema.json': other })).toEqual([
         { path: 'b.id', message: 'missing required field' },
       ]);
     });

     it('tolerates a field the schema does not declare (D3 additive minors)', () => {
       expect(check({ type: 'object', properties: {} }, { later: 1 })).toEqual(
         [],
       );
     });
   });

   describe('schemaProblems — an unenforced keyword is refused, not ignored', () => {
     it('reports an unsupported keyword with its location (planted)', () => {
       expect(
         schemaProblems({
           'p.schema.json': {
             properties: { a: { additionalProperties: false } },
           },
         }),
       ).toEqual([
         'p.schema.json#/properties/a/additionalProperties: unsupported keyword',
       ]);
     });

     it('reports an unknown type name, a bad pattern and an unresolvable $ref', () => {
       const problems = schemaProblems({
         'p.schema.json': {
           type: 'float',
           properties: { a: { pattern: '(' }, b: { $ref: '#/$defs/missing' } },
         },
       });
       expect(problems).toEqual([
         "p.schema.json#/type: unknown type 'float'",
         'p.schema.json#/properties/a/pattern: invalid pattern',
         "p.schema.json#/properties/b/$ref: unresolvable $ref '#/$defs/missing'",
       ]);
     });

     it('reports nothing for a schema using only supported keywords (control)', () => {
       expect(
         schemaProblems({
           'p.schema.json': {
             $id: 'p.schema.json',
             type: 'object',
             required: ['a'],
             properties: { a: { $ref: '#/$defs/t' } },
             $defs: { t: { type: 'string', minLength: 1 } },
           },
         }),
       ).toEqual([]);
     });
   });
   ```

2. Run `npx vitest run test/contracts-schema-check.test.ts` and observe it fail
   (module not found).
3. Create `lib/contracts/schema-check.mjs`:

   ```js
   // Zero-dependency interpreter for the JSON Schema subset the canary QA
   // contracts use (#1151, ADR 0035).
   //
   // Why a subset and not a library: the skills tree is dependency-free by
   // contract (see ../parse-args.mjs), so the validator runs wherever node runs
   // with nothing installed. Why interpret the schemas at all instead of
   // hand-coding checks: the .schema.json files are what other teams' producers
   // read, so the validator must enforce exactly those files. A keyword this
   // file does not implement is REFUSED at load by schemaProblems(); otherwise a
   // schema edit using it would read as enforced and enforce nothing.
   //
   // Unknown FIELDS in a document are tolerated (D3: a minor version adds
   // optional fields), which is why `additionalProperties` is not supported.

   /** Keywords that carry no assertion; allowed anywhere, never evaluated. */
   const ANNOTATIONS = [
     '$schema',
     '$id',
     '$comment',
     'title',
     'description',
     '$defs',
   ];

   export function isPlainObject(v) {
     return v !== null && typeof v === 'object' && !Array.isArray(v);
   }

   const TYPE_TESTS = {
     null: (v) => v === null,
     boolean: (v) => typeof v === 'boolean',
     integer: (v) => Number.isInteger(v),
     number: (v) => typeof v === 'number' && Number.isFinite(v),
     string: (v) => typeof v === 'string',
     array: (v) => Array.isArray(v),
     object: (v) => isPlainObject(v),
   };

   function describeType(v) {
     if (v === null) return 'null';
     if (Array.isArray(v)) return 'array';
     return typeof v;
   }

   /** `scope` + `env` -> `scope.env`; the document root is `$`. */
   function childPath(path, key) {
     return path === '$' ? key : `${path}.${key}`;
   }

   function report(ctx, path, message) {
     ctx.errors.push({ path, message });
   }

   function asList(arg) {
     return Array.isArray(arg) ? arg : [arg];
   }

   function checkType(expected, value, path, ctx) {
     const types = asList(expected);
     if (types.some((t) => TYPE_TESTS[t](value))) return;
     report(
       ctx,
       path,
       `expected ${types.join(' or ')}, got ${describeType(value)}`,
     );
   }

   function checkRequired(keys, value, path, ctx) {
     if (!isPlainObject(value)) return;
     for (const key of keys) {
       if (!Object.hasOwn(value, key)) {
         report(ctx, childPath(path, key), 'missing required field');
       }
     }
   }

   function checkProperties(props, value, path, ctx) {
     if (!isPlainObject(value)) return;
     for (const [key, sub] of Object.entries(props)) {
       if (Object.hasOwn(value, key)) {
         checkValue(sub, value[key], childPath(path, key), ctx);
       }
     }
   }

   function checkItems(sub, value, path, ctx) {
     if (!Array.isArray(value)) return;
     value.forEach((item, i) => checkValue(sub, item, `${path}[${i}]`, ctx));
   }

   function checkEnum(allowed, value, path, ctx) {
     if (allowed.includes(value)) return;
     const names = allowed.map((a) => JSON.stringify(a)).join(', ');
     report(ctx, path, `must be one of: ${names}`);
   }

   function checkConst(expected, value, path, ctx) {
     if (value === expected) return;
     report(ctx, path, `must be ${JSON.stringify(expected)}`);
   }

   function checkPattern(source, value, path, ctx) {
     if (typeof value !== 'string' || new RegExp(source, 'u').test(value))
       return;
     report(ctx, path, `does not match the pattern ${source}`);
   }

   function checkMinimum(min, value, path, ctx) {
     if (typeof value !== 'number' || value >= min) return;
     report(ctx, path, `must be >= ${min}`);
   }

   function checkMinLength(min, value, path, ctx) {
     if (typeof value !== 'string' || [...value].length >= min) return;
     report(ctx, path, `must be at least ${min} character(s)`);
   }

   /** `file#/pointer`, `#/pointer` or `file`; base is the schema we are in. */
   function resolveRef(ref, base, registry) {
     const hash = ref.indexOf('#');
     const file = hash === -1 ? ref : ref.slice(0, hash);
     const pointer = hash === -1 ? '' : ref.slice(hash + 1);
     const target = { base: file || base };
     target.schema = pointer
       .split('/')
       .filter(Boolean)
       .reduce(
         (node, seg) => (isPlainObject(node) ? node[seg] : undefined),
         registry[target.base],
       );
     return target;
   }

   function checkRef(ref, value, path, ctx) {
     const target = resolveRef(ref, ctx.base, ctx.registry);
     if (target.schema === undefined) {
       throw new Error(`schema-check: unresolvable $ref '${ref}'`);
     }
     checkValue(target.schema, value, path, { ...ctx, base: target.base });
   }

   const CHECKS = {
     type: checkType,
     required: checkRequired,
     properties: checkProperties,
     items: checkItems,
     enum: checkEnum,
     const: checkConst,
     pattern: checkPattern,
     minimum: checkMinimum,
     minLength: checkMinLength,
     $ref: checkRef,
   };

   export const SUPPORTED_KEYWORDS = Object.freeze([
     ...ANNOTATIONS,
     ...Object.keys(CHECKS),
   ]);

   /**
    * Validate `value` against `schema`, appending `{path, message}` to
    * `ctx.errors`. `ctx` = `{ registry, base, errors }`: registry maps a
    * schema `$id` to its parsed schema, base is the `$id` refs resolve against.
    */
   export function checkValue(schema, value, path, ctx) {
     for (const [keyword, arg] of Object.entries(schema)) {
       if (Object.hasOwn(CHECKS, keyword)) {
         CHECKS[keyword](arg, value, path, ctx);
       }
     }
   }

   function patternProblem(source) {
     try {
       new RegExp(source, 'u');
       return false;
     } catch {
       return true;
     }
   }

   function walkChildren(arg, where, ctx) {
     for (const [name, sub] of Object.entries(arg)) {
       walkSchema(sub, `${where}/${name}`, ctx);
     }
   }

   function walkKeyword(keyword, arg, where, ctx) {
     if (keyword === 'properties' || keyword === '$defs') {
       walkChildren(arg, where, ctx);
     } else if (keyword === 'items') {
       walkSchema(arg, where, ctx);
     } else if (keyword === 'type') {
       for (const t of asList(arg)) {
         if (!Object.hasOwn(TYPE_TESTS, t)) {
           ctx.problems.push(`${where}: unknown type '${t}'`);
         }
       }
     } else if (keyword === 'pattern' && patternProblem(arg)) {
       ctx.problems.push(`${where}: invalid pattern`);
     } else if (keyword === '$ref') {
       if (resolveRef(arg, ctx.base, ctx.registry).schema === undefined) {
         ctx.problems.push(`${where}: unresolvable $ref '${arg}'`);
       }
     }
   }

   function walkSchema(node, at, ctx) {
     if (!isPlainObject(node)) {
       ctx.problems.push(`${at}: a schema must be an object`);
       return;
     }
     for (const [keyword, arg] of Object.entries(node)) {
       const where = `${at}/${keyword}`;
       if (SUPPORTED_KEYWORDS.includes(keyword)) {
         walkKeyword(keyword, arg, where, ctx);
       } else {
         ctx.problems.push(`${where}: unsupported keyword`);
       }
     }
   }

   /**
    * Everything in a schema registry that would make a schema read as enforced
    * while enforcing less: unsupported keywords, unknown type names, invalid
    * patterns, unresolvable `$ref`s. Empty = every keyword is enforced.
    */
   export function schemaProblems(registry) {
     const problems = [];
     for (const [id, schema] of Object.entries(registry)) {
       walkSchema(schema, `${id}#`, { problems, registry, base: id });
     }
     return problems;
   }
   ```

   `walkKeyword` has the highest complexity in the file. Count it after writing,
   and if it measures above 10, split the `type` branch into a
   `typeProblems(arg, where, ctx)` helper.

4. Run `npx vitest run test/contracts-schema-check.test.ts` and observe it pass.
5. Run
   `npx prettier --write lib/contracts/schema-check.mjs test/contracts-schema-check.test.ts`.
6. Run `harness validate` from `$WT`.
7. Commit: `feat(contracts): zero-dependency JSON Schema subset interpreter`
   with body `Refs #1151`.

### Task 2: `canary.run/1` schema and its valid fixture

**Depends on:** Task 1 · **Files:**
`agents/skills/lib/contracts/run.v1.schema.json`,
`agents/skills/test/fixtures/contracts/run.valid.json`,
`agents/skills/test/contracts-schemas.test.ts`

1. Write `test/contracts-schemas.test.ts`:

   ```ts
   /**
    * The shipped contract schemas (#1151): one per layer, every keyword
    * enforced, every valid fixture accepted, and a planted defect refused so
    * the acceptance tests cannot pass vacuously.
    */
   import fs from 'node:fs';
   import path from 'node:path';
   import { fileURLToPath } from 'node:url';

   import { describe, it, expect } from 'vitest';

   import {
     checkValue,
     schemaProblems,
   } from '../lib/contracts/schema-check.mjs';

   const HERE = path.dirname(fileURLToPath(import.meta.url));
   const CONTRACTS = path.join(HERE, '..', 'lib', 'contracts');
   const FIXTURES = path.join(HERE, 'fixtures', 'contracts');
   // Grows by one layer in Tasks 3 and 4.
   const LAYERS = ['run'];

   type Doc = Record<string, any>;
   const readJson = (p: string): Doc => JSON.parse(fs.readFileSync(p, 'utf8'));

   function loadRegistry(): Record<string, Doc> {
     const registry: Record<string, Doc> = {};
     for (const f of fs.readdirSync(CONTRACTS)) {
       if (f.endsWith('.schema.json')) {
         registry[f] = readJson(path.join(CONTRACTS, f));
       }
     }
     return registry;
   }

   const REGISTRY = loadRegistry();
   const fixture = (layer: string) =>
     readJson(path.join(FIXTURES, `${layer}.valid.json`));

   function errorsFor(layer: string, doc: unknown) {
     const ctx = {
       registry: REGISTRY,
       base: `${layer}.v1.schema.json`,
       errors: [] as { path: string; message: string }[],
     };
     checkValue(REGISTRY[ctx.base], doc, '$', ctx);
     return ctx.errors;
   }

   describe('contract schemas', () => {
     it('ships exactly one schema per layer (a zero denominator is not a pass)', () => {
       expect(Object.keys(REGISTRY).sort()).toEqual(
         LAYERS.map((l) => `${l}.v1.schema.json`).sort(),
       );
     });

     it('uses only enforced keywords, and every $ref resolves', () => {
       expect(schemaProblems(REGISTRY)).toEqual([]);
     });

     it.each(LAYERS)(
       '%s: $id is its file name, contract its const',
       (layer) => {
         const schema = REGISTRY[`${layer}.v1.schema.json`];
         expect(schema.$id).toBe(`${layer}.v1.schema.json`);
         expect(schema.properties.contract.const).toBe(`canary.${layer}/1`);
       },
     );

     it.each(LAYERS)(
       '%s: the valid fixture has zero schema errors',
       (layer) => {
         expect(errorsFor(layer, fixture(layer))).toEqual([]);
       },
     );

     it('run: refuses the fixture once scope.env is removed (planted)', () => {
       const doc = fixture('run');
       delete doc.scope.env;
       expect(errorsFor('run', doc)).toEqual([
         { path: 'scope.env', message: 'missing required field' },
       ]);
     });

     it('run: refuses an absolute results[].file (ADR 0029 join key)', () => {
       const doc = fixture('run');
       doc.results[0].file = '/home/ci/tests/checkout.spec.ts';
       expect(errorsFor('run', doc).map((e) => e.path)).toEqual([
         'results[0].file',
       ]);
     });
   });
   ```

2. Run `npx vitest run test/contracts-schemas.test.ts` and observe it fail (no
   schema, no fixture).
3. Create `lib/contracts/run.v1.schema.json`:

   ```json
   {
     "$schema": "https://json-schema.org/draft/2020-12/schema",
     "$id": "run.v1.schema.json",
     "title": "canary.run/1",
     "description": "One test run, or one shard of one, with its per-test results. Spec: docs/specs/canary-run-contract.md. Unknown fields are tolerated (D3). Cross-field rules (totals vs results) live in rules.mjs.",
     "type": "object",
     "required": [
       "contract",
       "scope",
       "producer",
       "run",
       "totals",
       "results",
       "collected"
     ],
     "properties": {
       "contract": { "const": "canary.run/1" },
       "scope": { "$ref": "#/$defs/scope" },
       "producer": {
         "type": "object",
         "required": ["name", "version", "channel"],
         "properties": {
           "name": { "$ref": "#/$defs/text" },
           "version": { "$ref": "#/$defs/text" },
           "channel": { "$ref": "#/$defs/text" }
         }
       },
       "run": {
         "type": "object",
         "required": [
           "id",
           "suite",
           "branch",
           "commit_sha",
           "started_at",
           "finished_at",
           "ci_url",
           "status",
           "shard"
         ],
         "properties": {
           "id": { "$ref": "#/$defs/text" },
           "suite": { "$ref": "#/$defs/text" },
           "branch": { "type": ["string", "null"], "minLength": 1 },
           "commit_sha": {
             "type": ["string", "null"],
             "pattern": "^[0-9a-f]{7,64}$"
           },
           "started_at": { "$ref": "#/$defs/timestamp" },
           "finished_at": { "$ref": "#/$defs/timestamp" },
           "ci_url": { "type": ["string", "null"], "pattern": "^https?://" },
           "status": { "enum": ["passed", "failed", "cancelled"] },
           "shard": {
             "type": ["object", "null"],
             "required": ["index", "total"],
             "properties": {
               "index": { "type": "integer", "minimum": 1 },
               "total": { "type": "integer", "minimum": 1 }
             }
           }
         }
       },
       "totals": {
         "type": "object",
         "required": [
           "passed",
           "failed",
           "flaky",
           "skipped",
           "timed_out",
           "interrupted",
           "total"
         ],
         "properties": {
           "passed": { "$ref": "#/$defs/count" },
           "failed": { "$ref": "#/$defs/count" },
           "flaky": { "$ref": "#/$defs/count" },
           "skipped": { "$ref": "#/$defs/count" },
           "timed_out": { "$ref": "#/$defs/count" },
           "interrupted": { "$ref": "#/$defs/count" },
           "total": { "$ref": "#/$defs/count" }
         }
       },
       "results": {
         "$comment": "null = per-test results not carried in this record (fork A); [] = zero tests.",
         "type": ["array", "null"],
         "items": { "$ref": "#/$defs/result" }
       },
       "collected": {
         "$comment": "null = not reported; [] = none collected; a list = the full collected set (#1150, fork I).",
         "type": ["array", "null"],
         "items": { "$ref": "#/$defs/testRef" }
       }
     },
     "$defs": {
       "text": { "type": "string", "minLength": 1 },
       "count": { "type": "integer", "minimum": 0 },
       "timestamp": {
         "type": "string",
         "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$"
       },
       "repoPath": {
         "$comment": "Repo-relative (ADR 0029): never absolute, never a drive letter.",
         "type": "string",
         "minLength": 1,
         "pattern": "^(?!/|[A-Za-z]:[\\\\/])"
       },
       "scope": {
         "$comment": "D2: explicit, never inferred. env is opaque.",
         "type": "object",
         "required": ["id", "env"],
         "properties": {
           "id": { "$ref": "#/$defs/text" },
           "env": { "$ref": "#/$defs/text" }
         }
       },
       "testRef": {
         "type": "object",
         "required": ["title", "file"],
         "properties": {
           "title": { "$ref": "#/$defs/text" },
           "file": { "$ref": "#/$defs/repoPath" }
         }
       },
       "result": {
         "type": "object",
         "required": [
           "title",
           "file",
           "status",
           "duration_ms",
           "retries",
           "area",
           "tags",
           "error"
         ],
         "properties": {
           "title": { "$ref": "#/$defs/text" },
           "file": { "$ref": "#/$defs/repoPath" },
           "status": {
             "enum": [
               "passed",
               "failed",
               "flaky",
               "skipped",
               "timed_out",
               "interrupted"
             ]
           },
           "duration_ms": { "$ref": "#/$defs/count" },
           "retries": { "$ref": "#/$defs/count" },
           "area": { "type": ["string", "null"], "minLength": 1 },
           "tags": { "type": "array", "items": { "$ref": "#/$defs/text" } },
           "error": {
             "type": ["object", "null"],
             "required": ["message", "stack"],
             "properties": {
               "message": { "type": "string" },
               "stack": { "type": ["string", "null"] }
             }
           }
         }
       }
     }
   }
   ```

4. Create `test/fixtures/contracts/run.valid.json` (synthetic, de-identified;
   `acme-web` is the spec's generic placeholder):

   ```json
   {
     "contract": "canary.run/1",
     "scope": { "id": "acme-web", "env": "staging" },
     "producer": {
       "name": "canary-test-cli/reporter",
       "version": "8.1.0",
       "channel": "ci"
     },
     "run": {
       "id": "123456-1-s2of4",
       "suite": "web-e2e",
       "branch": "main",
       "commit_sha": "0ba2dd6818ee23df211f799ce714cb92983f65b1",
       "started_at": "2026-10-05T14:00:00Z",
       "finished_at": "2026-10-05T14:06:30Z",
       "ci_url": null,
       "status": "passed",
       "shard": { "index": 2, "total": 4 }
     },
     "totals": {
       "passed": 1,
       "failed": 0,
       "flaky": 1,
       "skipped": 0,
       "timed_out": 0,
       "interrupted": 0,
       "total": 2
     },
     "results": [
       {
         "title": "checkout > pays with a saved card",
         "file": "tests/checkout.spec.ts",
         "status": "passed",
         "duration_ms": 1840,
         "retries": 0,
         "area": "checkout",
         "tags": ["@smoke"],
         "error": null
       },
       {
         "title": "search > filters by price",
         "file": "tests/search.spec.ts",
         "status": "flaky",
         "duration_ms": 2210,
         "retries": 1,
         "area": null,
         "tags": [],
         "error": {
           "message": "expect(locator).toBeVisible() failed",
           "stack": null
         }
       }
     ],
     "collected": [
       {
         "title": "checkout > pays with a saved card",
         "file": "tests/checkout.spec.ts"
       },
       { "title": "search > filters by price", "file": "tests/search.spec.ts" }
     ]
   }
   ```

5. Run `npx prettier --write` over this task's three files.
6. Run `npx vitest run test/contracts-schemas.test.ts` and observe it pass.
7. Run `harness validate` from `$WT`.
8. Commit: `feat(contracts): canary.run/1 JSON Schema and valid fixture` with
   body `Refs #1151`.

### Task 3: `canary.assessment/1` schema and its valid fixture

**Depends on:** Task 2 · **Files:**
`agents/skills/lib/contracts/assessment.v1.schema.json`,
`agents/skills/test/fixtures/contracts/assessment.valid.json`,
`agents/skills/test/contracts-schemas.test.ts`

1. In `test/contracts-schemas.test.ts`, change `const LAYERS = ['run'];` to
   `const LAYERS = ['run', 'assessment'];` and append inside the `describe`:

   ```ts
   it('assessment: scope and text defs are identical to run (one D2 scope)', () => {
     const run = REGISTRY['run.v1.schema.json'].$defs;
     const assessment = REGISTRY['assessment.v1.schema.json'].$defs;
     expect(assessment.scope).toEqual(run.scope);
     expect(assessment.text).toEqual(run.text);
     expect(assessment.timestamp).toEqual(run.timestamp);
   });

   it('assessment: refuses a value of type string (fork D: no "N/A")', () => {
     const doc = fixture('assessment');
     doc.value = 'N/A';
     expect(errorsFor('assessment', doc).map((e) => e.path)).toEqual(['value']);
   });

   it('assessment: refuses an unknown status (planted)', () => {
     const doc = fixture('assessment');
     doc.status = 'green';
     expect(errorsFor('assessment', doc).map((e) => e.path)).toEqual([
       'status',
     ]);
   });
   ```

2. Run `npx vitest run test/contracts-schemas.test.ts` and observe it fail.
3. Create `lib/contracts/assessment.v1.schema.json`:

   ```json
   {
     "$schema": "https://json-schema.org/draft/2020-12/schema",
     "$id": "assessment.v1.schema.json",
     "title": "canary.assessment/1",
     "description": "One assessed metric. Append-only; identity key scope.id + scope.env + source + metric; readers take the latest per key. Spec: docs/specs/canary-assessment-contract.md. Status/value/reason and verification rules live in rules.mjs. `verified` is derived and refused if supplied (D5).",
     "type": "object",
     "required": [
       "contract",
       "scope",
       "source",
       "metric",
       "status",
       "value",
       "unit",
       "reason",
       "evidence",
       "observed_at",
       "sources",
       "verified_by",
       "verified_at"
     ],
     "properties": {
       "contract": { "const": "canary.assessment/1" },
       "scope": { "$ref": "#/$defs/scope" },
       "source": { "$ref": "#/$defs/text" },
       "metric": { "$ref": "#/$defs/text" },
       "status": {
         "enum": ["healthy", "degraded", "critical", "not-assessed", "observed"]
       },
       "value": {
         "$comment": "null iff not-assessed (D4, fork D).",
         "type": ["number", "boolean", "null"]
       },
       "unit": { "type": ["string", "null"], "minLength": 1 },
       "reason": {
         "$comment": "required iff not-assessed (D4).",
         "type": ["string", "null"],
         "minLength": 1
       },
       "evidence": {
         "type": "object",
         "required": ["tier", "denominator"],
         "properties": {
           "tier": {
             "enum": ["coverage-verified", "graph-verified", "heuristic", null]
           },
           "denominator": { "type": ["integer", "null"], "minimum": 0 }
         }
       },
       "observed_at": {
         "$comment": "When the check ran, not when it was stored.",
         "$ref": "#/$defs/timestamp"
       },
       "sources": { "type": "array", "items": { "$ref": "#/$defs/text" } },
       "verified_by": { "type": ["string", "null"], "minLength": 1 },
       "verified_at": {
         "type": ["string", "null"],
         "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$"
       }
     },
     "$defs": {
       "text": { "type": "string", "minLength": 1 },
       "timestamp": {
         "type": "string",
         "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$"
       },
       "scope": {
         "$comment": "D2: explicit, never inferred. env is opaque.",
         "type": "object",
         "required": ["id", "env"],
         "properties": {
           "id": { "$ref": "#/$defs/text" },
           "env": { "$ref": "#/$defs/text" }
         }
       }
     }
   }
   ```

4. Create `test/fixtures/contracts/assessment.valid.json`:

   ```json
   {
     "contract": "canary.assessment/1",
     "scope": { "id": "canary", "env": "ci" },
     "source": "canary.ci-ready",
     "metric": "flakiness",
     "status": "healthy",
     "value": 0.012,
     "unit": "ratio",
     "reason": null,
     "evidence": { "tier": "heuristic", "denominator": 412 },
     "observed_at": "2026-10-05T14:10:00Z",
     "sources": ["history-v2.jsonl@0ba2dd68"],
     "verified_by": null,
     "verified_at": null
   }
   ```

5. Run `npx prettier --write` over this task's three files, then
   `npx vitest run test/contracts-schemas.test.ts` and observe it pass.
6. Run `harness validate` from `$WT`.
7. Commit: `feat(contracts): canary.assessment/1 JSON Schema and valid fixture`
   with body `Refs #1151`.

### Task 4: `canary.site/1` schema and its valid fixture

**Depends on:** Task 3 · **Files:**
`agents/skills/lib/contracts/site.v1.schema.json`,
`agents/skills/test/fixtures/contracts/site.valid.json`,
`agents/skills/test/contracts-schemas.test.ts`

1. In `test/contracts-schemas.test.ts`, set
   `const LAYERS = ['run', 'assessment', 'site'];` and append:

   ```ts
   it('site: refuses a bare-string scope on suites[] (fork B, D2)', () => {
     const doc = fixture('site');
     doc.suites[0].scope = 'canary';
     expect(errorsFor('site', doc)).toEqual([
       { path: 'suites[0].scope', message: 'expected object, got string' },
     ]);
   });

   it('site: validates nested runs against canary.run/1 (cross-file $ref)', () => {
     const doc = fixture('site');
     delete doc.runs[1].scope.env;
     expect(errorsFor('site', doc).map((e) => e.path)).toEqual([
       'runs[1].scope.env',
     ]);
   });

   it('site: refuses a register row without its commit (fork C, amended)', () => {
     const doc = fixture('site');
     delete doc.register[0].commit;
     expect(errorsFor('site', doc).map((e) => e.path)).toEqual([
       'register[0].commit',
     ]);
   });

   it('site: suites may be null (no declaration, D12) but not absent', () => {
     const declaredNone = fixture('site');
     declaredNone.suites = null;
     expect(errorsFor('site', declaredNone)).toEqual([]);
     const absent = fixture('site');
     delete absent.suites;
     expect(errorsFor('site', absent).map((e) => e.path)).toEqual(['suites']);
   });
   ```

2. Run `npx vitest run test/contracts-schemas.test.ts` and observe it fail.
3. Create `lib/contracts/site.v1.schema.json`:

   ```json
   {
     "$schema": "https://json-schema.org/draft/2020-12/schema",
     "$id": "site.v1.schema.json",
     "title": "canary.site/1",
     "description": "The single static feed a QA site page loads. Spec: docs/specs/canary-site-feed-contract.md. Every scope is {id, env} (D2, fork B). runs[] are canary.run/1 records; per-test results are carried only on each suite's latest run (results: null elsewhere, fork A).",
     "type": "object",
     "required": [
       "contract",
       "generated_at",
       "scopes",
       "suites",
       "runs",
       "flaky",
       "assessments",
       "register"
     ],
     "properties": {
       "contract": { "const": "canary.site/1" },
       "generated_at": { "$ref": "run.v1.schema.json#/$defs/timestamp" },
       "scopes": {
         "type": "array",
         "items": { "$ref": "run.v1.schema.json#/$defs/scope" }
       },
       "suites": {
         "$comment": "Declared expected suites (D12). null = none declared, which is not the same as [].",
         "type": ["array", "null"],
         "items": { "$ref": "#/$defs/suite" }
       },
       "runs": { "type": "array", "items": { "$ref": "run.v1.schema.json" } },
       "flaky": { "type": "array", "items": { "$ref": "#/$defs/flaky" } },
       "assessments": {
         "type": "array",
         "items": { "$ref": "assessment.v1.schema.json" }
       },
       "register": {
         "type": "array",
         "items": { "$ref": "#/$defs/registerEntry" }
       }
     },
     "$defs": {
       "suite": {
         "type": "object",
         "required": ["scope", "suite"],
         "properties": {
           "scope": { "$ref": "run.v1.schema.json#/$defs/scope" },
           "suite": { "$ref": "run.v1.schema.json#/$defs/text" }
         }
       },
       "flaky": {
         "$comment": "One row per DISTINCT flaky test over the window (D13).",
         "type": "object",
         "required": [
           "scope",
           "suite",
           "title",
           "file",
           "flaky_runs",
           "window_runs"
         ],
         "properties": {
           "scope": { "$ref": "run.v1.schema.json#/$defs/scope" },
           "suite": { "$ref": "run.v1.schema.json#/$defs/text" },
           "title": { "$ref": "run.v1.schema.json#/$defs/text" },
           "file": { "$ref": "run.v1.schema.json#/$defs/repoPath" },
           "flaky_runs": { "type": "integer", "minimum": 1 },
           "window_runs": { "type": "integer", "minimum": 1 }
         }
       },
       "registerEntry": {
         "$comment": "A skipped or removed test as visible debt; mirrors the canary-katana ledger row (fork C). Age is derived from recorded_at. Author identity is deliberately excluded from a public feed.",
         "type": "object",
         "required": [
           "scope",
           "title",
           "file",
           "kind",
           "reason",
           "recorded_at",
           "commit",
           "cause",
           "issue"
         ],
         "properties": {
           "scope": { "$ref": "run.v1.schema.json#/$defs/scope" },
           "title": { "$ref": "run.v1.schema.json#/$defs/text" },
           "file": { "$ref": "run.v1.schema.json#/$defs/repoPath" },
           "kind": { "$ref": "run.v1.schema.json#/$defs/text" },
           "reason": { "$ref": "run.v1.schema.json#/$defs/text" },
           "recorded_at": { "$ref": "run.v1.schema.json#/$defs/timestamp" },
           "commit": { "$ref": "run.v1.schema.json#/$defs/text" },
           "cause": { "type": ["string", "null"], "minLength": 1 },
           "issue": { "type": ["string", "null"], "minLength": 1 }
         }
       }
     }
   }
   ```

4. Create `test/fixtures/contracts/site.valid.json`. It has two runs of one
   suite: the older one has `results: null` and the latest carries its results.
   It also has one flaky row, the assessment fixture's content, and one register
   row:

   ```json
   {
     "contract": "canary.site/1",
     "generated_at": "2026-10-05T15:00:00Z",
     "scopes": [{ "id": "canary", "env": "ci" }],
     "suites": [
       { "scope": { "id": "canary", "env": "ci" }, "suite": "ts-engine" }
     ],
     "runs": [
       {
         "contract": "canary.run/1",
         "scope": { "id": "canary", "env": "ci" },
         "producer": {
           "name": "canary-starling",
           "version": "0.1.0",
           "channel": "ci"
         },
         "run": {
           "id": "9001-1",
           "suite": "ts-engine",
           "branch": "main",
           "commit_sha": "a8be94e6",
           "started_at": "2026-10-04T10:00:00Z",
           "finished_at": "2026-10-04T10:04:00Z",
           "ci_url": null,
           "status": "passed",
           "shard": null
         },
         "totals": {
           "passed": 2,
           "failed": 0,
           "flaky": 0,
           "skipped": 0,
           "timed_out": 0,
           "interrupted": 0,
           "total": 2
         },
         "results": null,
         "collected": null
       },
       {
         "contract": "canary.run/1",
         "scope": { "id": "canary", "env": "ci" },
         "producer": {
           "name": "canary-starling",
           "version": "0.1.0",
           "channel": "ci"
         },
         "run": {
           "id": "9002-1",
           "suite": "ts-engine",
           "branch": "main",
           "commit_sha": "0ba2dd68",
           "started_at": "2026-10-05T10:00:00Z",
           "finished_at": "2026-10-05T10:04:00Z",
           "ci_url": null,
           "status": "passed",
           "shard": null
         },
         "totals": {
           "passed": 1,
           "failed": 0,
           "flaky": 0,
           "skipped": 0,
           "timed_out": 0,
           "interrupted": 0,
           "total": 1
         },
         "results": [
           {
             "title": "history > trims to the newest runs",
             "file": "ts/test/history-trim-windows.test.ts",
             "status": "passed",
             "duration_ms": 412,
             "retries": 0,
             "area": null,
             "tags": [],
             "error": null
           }
         ],
         "collected": null
       }
     ],
     "flaky": [
       {
         "scope": { "id": "canary", "env": "ci" },
         "suite": "ts-engine",
         "title": "history > trims to the newest runs",
         "file": "ts/test/history-trim-windows.test.ts",
         "flaky_runs": 3,
         "window_runs": 30
       }
     ],
     "assessments": [
       {
         "contract": "canary.assessment/1",
         "scope": { "id": "canary", "env": "ci" },
         "source": "canary.ci-ready",
         "metric": "flakiness",
         "status": "healthy",
         "value": 0.012,
         "unit": "ratio",
         "reason": null,
         "evidence": { "tier": "heuristic", "denominator": 412 },
         "observed_at": "2026-10-05T14:10:00Z",
         "sources": ["history-v2.jsonl@0ba2dd68"],
         "verified_by": null,
         "verified_at": null
       }
     ],
     "register": [
       {
         "scope": { "id": "canary", "env": "ci" },
         "title": "legacy > old login flow",
         "file": "tests/legacy.spec.ts",
         "kind": "skipped",
         "reason": "chore: quarantine the legacy login flow",
         "recorded_at": "2026-09-30T12:00:00Z",
         "commit": "0ba2dd68",
         "cause": "obsolete",
         "issue": null
       }
     ]
   }
   ```

5. Run `npx prettier --write` over this task's three files, then
   `npx vitest run test/contracts-schemas.test.ts` and observe it pass.
6. Run `harness validate` from `$WT`.
7. Commit: `feat(contracts): canary.site/1 feed schema and valid fixture` with
   body `Refs #1151`.

### Task 5: named cross-field rules

**Depends on:** Task 1 · **Files:** `agents/skills/lib/contracts/rules.mjs`,
`agents/skills/test/contracts-rules.test.ts`

1. Write `test/contracts-rules.test.ts`:

   ```ts
   /**
    * The cross-field rules the supported keyword subset cannot express
    * (#1151, ADR 0035). End-to-end criterion tests are in
    * contracts-validate.test.ts; these pin each rule's path and guards.
    */
   import { describe, it, expect } from 'vitest';

   import { crossFieldErrors } from '../lib/contracts/rules.mjs';

   type Doc = Record<string, any>;
   const totals = (over: Doc = {}) => ({
     passed: 1,
     failed: 0,
     flaky: 0,
     skipped: 0,
     timed_out: 0,
     interrupted: 0,
     total: 1,
     ...over,
   });
   const assessment = (over: Doc = {}): Doc => ({
     status: 'healthy',
     value: 1,
     reason: null,
     verified_by: null,
     verified_at: null,
     ...over,
   });
   const paths = (errs: { path: string }[]) => errs.map((e) => e.path);

   describe('run rules', () => {
     it('totals.total must equal results.length when results is an array', () => {
       const run = { totals: totals(), results: [] };
       expect(crossFieldErrors('run', run)).toEqual([
         { path: 'totals.total', message: 'is 1 but results has 0 entries' },
       ]);
     });

     it('skips the length rule when results is null (fork A: not carried)', () => {
       expect(
         crossFieldErrors('run', { totals: totals(), results: null }),
       ).toEqual([]);
     });

     it('per-status counts must sum to totals.total (fork K)', () => {
       const run = { totals: totals({ failed: 1 }), results: null };
       expect(crossFieldErrors('run', run)).toEqual([
         {
           path: 'totals.total',
           message: 'is 1 but the per-status counts sum to 2',
         },
       ]);
     });

     it('leaves a non-object totals to the schema', () => {
       expect(crossFieldErrors('run', { totals: 'x', results: [] })).toEqual(
         [],
       );
     });
   });

   describe('assessment rules', () => {
     it.each([true, false, null])(
       'refuses a supplied verified (%s): key presence',
       (v) => {
         expect(
           paths(crossFieldErrors('assessment', assessment({ verified: v }))),
         ).toEqual(['verified']);
       },
     );

     it('names the missing half of the verification pair', () => {
       expect(
         paths(
           crossFieldErrors(
             'assessment',
             assessment({ verified_by: 'qa-lead' }),
           ),
         ),
       ).toEqual(['verified_at']);
       expect(
         paths(
           crossFieldErrors(
             'assessment',
             assessment({ verified_at: '2026-10-05T00:00:00Z' }),
           ),
         ),
       ).toEqual(['verified_by']);
     });

     it('not-assessed: no value, and a non-blank reason', () => {
       expect(
         paths(
           crossFieldErrors(
             'assessment',
             assessment({ status: 'not-assessed', value: 0, reason: '  ' }),
           ),
         ),
       ).toEqual(['value', 'reason']);
     });

     it.each(['healthy', 'degraded', 'critical', 'observed'])(
       '%s: a value, and no reason',
       (status) => {
         expect(
           paths(
             crossFieldErrors(
               'assessment',
               assessment({ status, value: null, reason: 'x' }),
             ),
           ),
         ).toEqual(['value', 'reason']);
       },
     );

     it('leaves an unknown status to the schema enum', () => {
       expect(
         crossFieldErrors(
           'assessment',
           assessment({ status: 'green', value: null }),
         ),
       ).toEqual([]);
     });
   });

   describe('site rules', () => {
     it('prefixes nested paths with runs[i] and assessments[i]', () => {
       const site = {
         runs: [
           { totals: totals(), results: null },
           { totals: totals(), results: [] },
         ],
         assessments: [assessment({ verified: true })],
       };
       expect(paths(crossFieldErrors('site', site))).toEqual([
         'runs[1].totals.total',
         'assessments[0].verified',
       ]);
     });

     it('tolerates non-array runs/assessments and non-object members (the schema reports them)', () => {
       expect(
         crossFieldErrors('site', { runs: 'x', assessments: [null] }),
       ).toEqual([]);
     });
   });
   ```

2. Run `npx vitest run test/contracts-rules.test.ts` and observe it fail.
3. Create `lib/contracts/rules.mjs`:

   ```js
   // Cross-field rules of the canary QA contracts (#1151, ADR 0035).
   //
   // The JSON Schemas state shape. These are the relations BETWEEN fields that
   // the supported keyword subset cannot express without if/then/not, which
   // schema-check.mjs deliberately does not implement. Each rule is named in
   // docs/specs/ so a refused producer can find out why. Every rule is
   // defensive: a field of the wrong type is the schema's error to report, not
   // a second error here.

   import { isPlainObject } from './schema-check.mjs';

   const COUNT_KEYS = [
     'passed',
     'failed',
     'flaky',
     'skipped',
     'timed_out',
     'interrupted',
   ];
   const ASSESSED = ['healthy', 'degraded', 'critical', 'observed'];

   function at(prefix, field) {
     return prefix ? `${prefix}.${field}` : field;
   }

   function isAbsent(v) {
     return v === null || v === undefined;
   }

   /** Criterion 4: totals.total === results.length, when results are carried. */
   function totalsMatchResults(run, prefix) {
     const total = isPlainObject(run.totals) ? run.totals.total : undefined;
     if (!Array.isArray(run.results) || !Number.isInteger(total)) return [];
     if (total === run.results.length) return [];
     const n = run.results.length;
     return [
       {
         path: at(prefix, 'totals.total'),
         message: `is ${total} but results has ${n} entr${n === 1 ? 'y' : 'ies'}`,
       },
     ];
   }

   /** Fork K: the per-status counts add up to totals.total. */
   function totalsSum(run, prefix) {
     const t = run.totals;
     if (!isPlainObject(t) || !Number.isInteger(t.total)) return [];
     const counts = COUNT_KEYS.map((k) => t[k]);
     if (!counts.every(Number.isInteger)) return [];
     const sum = counts.reduce((a, b) => a + b, 0);
     if (sum === t.total) return [];
     return [
       {
         path: at(prefix, 'totals.total'),
         message: `is ${t.total} but the per-status counts sum to ${sum}`,
       },
     ];
   }

   /** Criterion 3 / D5: `verified` is derived; supplying it, even null, is refused. */
   function verifiedSupplied(a, prefix) {
     if (!Object.hasOwn(a, 'verified')) return [];
     return [
       {
         path: at(prefix, 'verified'),
         message:
           'is derived from verified_by + verified_at and must not be supplied (D5)',
       },
     ];
   }

   /** Criterion 17 / D5: verified_by and verified_at are both set or both null. */
   function verificationPair(a, prefix) {
     const byMissing = isAbsent(a.verified_by);
     if (byMissing === isAbsent(a.verified_at)) return [];
     const [missing, present] = byMissing
       ? ['verified_by', 'verified_at']
       : ['verified_at', 'verified_by'];
     return [
       {
         path: at(prefix, missing),
         message: `must be set when ${present} is set: both or neither (D5)`,
       },
     ];
   }

   /** Criterion 2 / D4: not-assessed has no value and a non-blank reason. */
   function abstainedShape(a, prefix) {
     const errors = [];
     if (!isAbsent(a.value)) {
       errors.push({
         path: at(prefix, 'value'),
         message: 'must be null when status is not-assessed (D4)',
       });
     }
     if (typeof a.reason !== 'string' || a.reason.trim() === '') {
       errors.push({
         path: at(prefix, 'reason'),
         message: 'is required when status is not-assessed (D4)',
       });
     }
     return errors;
   }

   /** Fork D: every other status has a value and no reason (both "iff"s). */
   function assessedShape(a, prefix) {
     const errors = [];
     if (a.value === null) {
       errors.push({
         path: at(prefix, 'value'),
         message: `must not be null when status is ${a.status}; abstain with not-assessed and a reason (D4)`,
       });
     }
     if (!isAbsent(a.reason)) {
       errors.push({
         path: at(prefix, 'reason'),
         message: `must be null when status is ${a.status}; a reason is required only for not-assessed (D4)`,
       });
     }
     return errors;
   }

   function statusShape(a, prefix) {
     if (a.status === 'not-assessed') return abstainedShape(a, prefix);
     if (ASSESSED.includes(a.status)) return assessedShape(a, prefix);
     return [];
   }

   const RUN_RULES = [totalsMatchResults, totalsSum];
   const ASSESSMENT_RULES = [verifiedSupplied, verificationPair, statusShape];

   function applyRules(rules, record, prefix) {
     if (!isPlainObject(record)) return [];
     return rules.flatMap((rule) => rule(record, prefix));
   }

   function nested(site, key, rules) {
     if (!Array.isArray(site[key])) return [];
     return site[key].flatMap((r, i) => applyRules(rules, r, `${key}[${i}]`));
   }

   /** Every cross-field violation in a document of the given layer. */
   export function crossFieldErrors(layer, doc) {
     if (layer === 'run') return applyRules(RUN_RULES, doc, '');
     if (layer === 'assessment') return applyRules(ASSESSMENT_RULES, doc, '');
     return [
       ...nested(doc, 'runs', RUN_RULES),
       ...nested(doc, 'assessments', ASSESSMENT_RULES),
     ];
   }
   ```

4. Run
   `npx prettier --write lib/contracts/rules.mjs test/contracts-rules.test.ts`,
   then `npx vitest run test/contracts-rules.test.ts` and observe it pass.
5. Run `harness validate` from `$WT`.
6. Commit: `feat(contracts): named cross-field rules for run and assessment`
   with body `Refs #1151`.

### Task 6: `validate.mjs` public API, the criterion tests

**Depends on:** Tasks 4, 5 · **Files:**
`agents/skills/lib/contracts/validate.mjs`,
`agents/skills/test/contracts-validate.test.ts`

1. Write `test/contracts-validate.test.ts`. Test names are the traceability keys
   in §5, so do not rename them.

   ```ts
   /**
    * Acceptance tests for the canary QA contract validator (#1151): spec
    * success criteria 1, 2, 3, 4, 16, 17, 18, one describe each. Every refusal
    * asserts the error PATH (fork H), and every refusal has a planted-valid
    * control so no test can pass vacuously.
    */
   import fs from 'node:fs';
   import path from 'node:path';
   import { fileURLToPath } from 'node:url';

   import { describe, it, expect } from 'vitest';

   import {
     validateDocument,
     validateText,
   } from '../lib/contracts/validate.mjs';

   const FIXTURES = path.join(
     path.dirname(fileURLToPath(import.meta.url)),
     'fixtures',
     'contracts',
   );
   const LAYERS = ['run', 'assessment', 'site'];
   type Doc = Record<string, any>;
   const valid = (layer: string): Doc =>
     JSON.parse(
       fs.readFileSync(path.join(FIXTURES, `${layer}.valid.json`), 'utf8'),
     );

   function refusedPaths(doc: unknown, opts = {}): string[] {
     const res = validateDocument(doc, opts);
     expect(res.valid).toBe(false);
     return res.errors.map((e: { path: string }) => e.path);
   }

   describe('valid corpus (planted positives)', () => {
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

     it.each(LAYERS)(
       'accepts the valid %s document with zero errors',
       (layer) => {
         const res = validateDocument(valid(layer));
         expect(res.errors).toEqual([]);
         expect(res).toMatchObject({
           valid: true,
           contract: `canary.${layer}/1`,
         });
       },
     );

     it('reports its denominator: a site feed counts its nested records', () => {
       expect(validateDocument(valid('run')).checked).toBe(1);
       expect(validateDocument(valid('site')).checked).toBe(1 + 2 + 1);
     });
   });

   describe('criterion 1: contract field and major version', () => {
     it.each(LAYERS)(
       'refuses a %s record with no contract field, naming contract',
       (layer) => {
         const doc = valid(layer);
         delete doc.contract;
         expect(refusedPaths(doc)).toEqual(['contract']);
       },
     );

     it('refuses an unknown major version, naming contract', () => {
       const res = validateDocument({
         ...valid('run'),
         contract: 'canary.run/2',
       });
       expect(res.errors).toEqual([
         {
           path: 'contract',
           message: expect.stringMatching(/unknown major version 2/),
         },
       ]);
     });

     it('refuses an unknown layer and a non-string contract, naming contract', () => {
       expect(
         refusedPaths({ ...valid('run'), contract: 'canary.signal/1' }),
       ).toEqual(['contract']);
       expect(refusedPaths({ ...valid('run'), contract: 1 })).toEqual([
         'contract',
       ]);
     });

     it('refuses an unknown major nested in a site feed, naming runs[0].contract', () => {
       const doc = valid('site');
       doc.runs[0].contract = 'canary.run/2';
       expect(refusedPaths(doc)).toEqual(['runs[0].contract']);
     });

     it('refuses a root that is not an object, naming $', () => {
       expect(refusedPaths([valid('run')])).toEqual(['$']);
       expect(refusedPaths(null)).toEqual(['$']);
     });
   });

   describe('criterion 2: not-assessed and observed (D4)', () => {
     const base = () => valid('assessment');

     it('refuses not-assessed carrying a value, naming value', () => {
       expect(
         refusedPaths({
           ...base(),
           status: 'not-assessed',
           value: 0,
           reason: 'no inventory',
         }),
       ).toEqual(['value']);
     });

     it('refuses not-assessed without a reason, naming reason', () => {
       expect(
         refusedPaths({
           ...base(),
           status: 'not-assessed',
           value: null,
           reason: null,
         }),
       ).toEqual(['reason']);
     });

     it('refuses observed with a null value, naming value', () => {
       expect(
         refusedPaths({ ...base(), status: 'observed', value: null }),
       ).toEqual(['value']);
     });

     it.each(['healthy', 'degraded', 'critical'])(
       'refuses %s with a null value (fork D: value null iff not-assessed)',
       (status) => {
         expect(refusedPaths({ ...base(), status, value: null })).toEqual([
           'value',
         ]);
       },
     );

     it('refuses a reason on an assessed status (fork D: reason iff not-assessed)', () => {
       expect(refusedPaths({ ...base(), reason: 'looks fine' })).toEqual([
         'reason',
       ]);
     });

     it('accepts a well-formed not-assessed and a valued observed (controls)', () => {
       expect(
         validateDocument({
           ...base(),
           status: 'not-assessed',
           value: null,
           reason: 'no inventory',
           evidence: { tier: null, denominator: null },
         }).errors,
       ).toEqual([]);
       expect(
         validateDocument({ ...base(), status: 'observed', value: 3 }).errors,
       ).toEqual([]);
     });
   });

   describe('criterion 3: producer-supplied verified (D5)', () => {
     it.each([true, false, null])(
       'refuses verified: %s (fork G: key presence, not truthiness)',
       (v) => {
         expect(refusedPaths({ ...valid('assessment'), verified: v })).toEqual([
           'verified',
         ]);
       },
     );

     it('refuses verified inside a site feed, naming assessments[0].verified', () => {
       const doc = valid('site');
       doc.assessments[0].verified = true;
       expect(refusedPaths(doc)).toEqual(['assessments[0].verified']);
     });
   });

   describe('criterion 4: totals.total equals results.length', () => {
     it('refuses a run whose totals.total differs from results.length, naming totals.total', () => {
       const doc = valid('run');
       doc.results.pop();
       expect(refusedPaths(doc)).toEqual(['totals.total']);
     });

     it('refuses results: [] against totals.total 1 (empty is not absent)', () => {
       const doc = valid('site').runs[1];
       doc.results = [];
       expect(refusedPaths(doc)).toEqual(['totals.total']);
     });

     it('accepts results: null whatever the totals (fork A: not carried)', () => {
       expect(
         validateDocument({ ...valid('run'), results: null }).errors,
       ).toEqual([]);
     });

     it('refuses a mismatched run nested in a site feed, naming runs[1].totals.total', () => {
       const doc = valid('site');
       doc.runs[1].results = [];
       expect(refusedPaths(doc)).toEqual(['runs[1].totals.total']);
     });
   });

   describe('criterion 16: scope (D2)', () => {
     const drops: [string, (d: Doc) => void][] = [
       ['scope', (d) => delete d.scope],
       ['scope.id', (d) => delete d.scope.id],
       ['scope.env', (d) => delete d.scope.env],
     ];
     for (const layer of ['run', 'assessment']) {
       it.each(drops)(
         `refuses a ${layer} record missing %s, naming it`,
         (field, drop) => {
           const doc = valid(layer);
           drop(doc);
           expect(refusedPaths(doc)).toEqual([field]);
         },
       );
     }

     it('refuses a blank env: opaque, but never empty', () => {
       const doc = valid('run');
       doc.scope.env = '';
       expect(refusedPaths(doc)).toEqual(['scope.env']);
     });

     it('refuses a bare-string scope in a site feed (fork B), naming suites[0].scope', () => {
       const doc = valid('site');
       doc.suites[0].scope = 'canary';
       expect(refusedPaths(doc)).toEqual(['suites[0].scope']);
     });
   });

   describe('criterion 17: verified_by / verified_at pairing (D5)', () => {
     it('refuses verified_by without verified_at, naming verified_at', () => {
       expect(
         refusedPaths({ ...valid('assessment'), verified_by: 'qa-lead' }),
       ).toEqual(['verified_at']);
     });

     it('refuses verified_at without verified_by, naming verified_by', () => {
       expect(
         refusedPaths({
           ...valid('assessment'),
           verified_at: '2026-10-05T16:00:00Z',
         }),
       ).toEqual(['verified_by']);
     });

     it('accepts both set (control)', () => {
       expect(
         validateDocument({
           ...valid('assessment'),
           verified_by: 'qa-lead',
           verified_at: '2026-10-05T16:00:00Z',
         }).errors,
       ).toEqual([]);
     });
   });

   describe('criterion 18: unparseable input is refused', () => {
     it.each(['{', '', 'undefined', "{'contract':'canary.run/1'}"])(
       'refuses %j, naming $',
       (text) => {
         const res = validateText(text);
         expect(res.valid).toBe(false);
         expect(res.checked).toBe(0);
         expect(res.errors).toEqual([
           { path: '$', message: expect.stringMatching(/^not parseable JSON/) },
         ]);
       },
     );

     it('accepts the same document once it parses (control)', () => {
       expect(validateText(JSON.stringify(valid('run'))).valid).toBe(true);
     });
   });

   describe('fork E: unknown fields tolerated, wrong layer refused', () => {
     it('tolerates an unknown field (a minor version adds optional fields, D3)', () => {
       expect(
         validateDocument({ ...valid('run'), later_minor_field: { x: 1 } })
           .errors,
       ).toEqual([]);
     });

     it('refuses an assessment validated as layer run, naming contract', () => {
       const res = validateDocument(valid('assessment'), { layer: 'run' });
       expect(res.errors).toEqual([
         {
           path: 'contract',
           message: expect.stringMatching(/expected canary\.run\/1/),
         },
       ]);
     });
   });
   ```

2. Run `npx vitest run test/contracts-validate.test.ts` and observe it fail.
3. Create `lib/contracts/validate.mjs` (API half; Task 7 adds the CLI):

   ```js
   #!/usr/bin/env node
   // Validator for the canary QA data contract (#1151, ADR 0035):
   // canary.run/1, canary.assessment/1, canary.site/1.
   //
   // Zero dependencies, so a producer's CI or site-deploy.yml can run it from
   // the shipped skills tree with nothing installed. Schema-driven: the three
   // *.v1.schema.json files beside this module ARE the contract, interpreted by
   // schema-check.mjs. Anything they cannot express is a named rule in
   // rules.mjs. Errors are {path, message}; the document root is `$`.
   //
   // Exit codes (CLI): 0 valid, 1 refused (invalid OR unparseable; a parse
   // failure is never a pass), 2 usage or unreadable file. There is no exit 3:
   // a parsed document always has a denominator of at least 1 (fork N).

   import { readFileSync } from 'node:fs';

   import {
     checkValue,
     isPlainObject,
     schemaProblems,
   } from './schema-check.mjs';
   import { crossFieldErrors } from './rules.mjs';

   const LAYERS = ['run', 'assessment', 'site'];
   const SUPPORTED_MAJOR = 1;
   const CONTRACT_RE = /^canary\.([a-z]+)\/(\d+)$/;

   const schemaId = (layer) => `${layer}.v1.schema.json`;

   function loadRegistry() {
     const registry = Object.create(null);
     for (const layer of LAYERS) {
       const url = new URL(`./${schemaId(layer)}`, import.meta.url);
       registry[schemaId(layer)] = JSON.parse(readFileSync(url, 'utf8'));
     }
     return registry;
   }

   const REGISTRY = loadRegistry();

   // Refuse to run at all over a schema that uses a keyword nothing enforces:
   // a validator that silently skips part of its contract is a false green.
   const PROBLEMS = schemaProblems(REGISTRY);
   if (PROBLEMS.length > 0) {
     throw new Error(
       `canary contracts: unenforceable schema: ${PROBLEMS.join('; ')}`,
     );
   }

   const contractError = (message) => ({
     error: { path: 'contract', message },
   });

   /** Which layer a document claims, or the error that refuses the claim. */
   function readContract(doc, expected) {
     if (!Object.hasOwn(doc, 'contract')) {
       return contractError('missing required field');
     }
     const m =
       typeof doc.contract === 'string' ? CONTRACT_RE.exec(doc.contract) : null;
     if (m === null) {
       return contractError(
         `not a canary contract string: ${JSON.stringify(doc.contract)}`,
       );
     }
     const [, layer, major] = m;
     if (!LAYERS.includes(layer))
       return contractError(`unknown layer '${layer}'`);
     if (Number(major) !== SUPPORTED_MAJOR) {
       return contractError(
         `unknown major version ${major} for canary.${layer}; this reader supports ${SUPPORTED_MAJOR}`,
       );
     }
     if (expected && layer !== expected) {
       return contractError(
         `expected canary.${expected}/1, got ${doc.contract}`,
       );
     }
     return { layer };
   }

   /** The denominator: documents plus the records nested in a site feed. */
   function countRecords(layer, doc) {
     if (layer !== 'site') return 1;
     const len = (key) => (Array.isArray(doc[key]) ? doc[key].length : 0);
     return 1 + len('runs') + len('assessments');
   }

   function verdict(layer, errors, checked) {
     return {
       valid: errors.length === 0,
       contract: layer ? `canary.${layer}/${SUPPORTED_MAJOR}` : null,
       checked,
       errors,
     };
   }

   /**
    * Validate one parsed document.
    * @param {unknown} doc
    * @param {{layer?: string|null}} [opts] refuse a document of any other layer
    * @returns {{valid: boolean, contract: string|null, checked: number, errors: {path: string, message: string}[]}}
    */
   export function validateDocument(doc, opts = {}) {
     if (!isPlainObject(doc)) {
       const got =
         doc === null ? 'null' : Array.isArray(doc) ? 'array' : typeof doc;
       return verdict(
         null,
         [{ path: '$', message: `expected a JSON object, got ${got}` }],
         1,
       );
     }
     const claim = readContract(doc, opts.layer ?? null);
     if (claim.error) return verdict(null, [claim.error], 1);
     const ctx = {
       registry: REGISTRY,
       base: schemaId(claim.layer),
       errors: [],
     };
     checkValue(REGISTRY[ctx.base], doc, '$', ctx);
     const errors = [...ctx.errors, ...crossFieldErrors(claim.layer, doc)];
     return verdict(claim.layer, errors, countRecords(claim.layer, doc));
   }

   /**
    * Validate raw text. Unparseable or empty input is a refusal (criterion 18).
    * @param {string} text
    * @param {{layer?: string|null}} [opts]
    */
   export function validateText(text, opts = {}) {
     let doc;
     try {
       doc = JSON.parse(text);
     } catch (err) {
       return verdict(
         null,
         [{ path: '$', message: `not parseable JSON: ${err.message}` }],
         0,
       );
     }
     return validateDocument(doc, opts);
   }
   ```

   The nested ternary in `validateDocument` adds complexity. If the function
   measures above 10, move it into a `describeRoot(doc)` helper.

4. Run
   `npx prettier --write lib/contracts/validate.mjs test/contracts-validate.test.ts`,
   then `npx vitest run test/contracts-validate.test.ts` and observe it pass.
5. Run `npm run typecheck`. This catches a JSDoc/TS mismatch on
   `{ layer: 'run' }`.
6. Run `harness validate` from `$WT`.
7. Commit:
   `feat(contracts): validator API refusing malformed run, assessment and site documents`
   with body `Refs #1151`.

### Task 7: the CLI (`node validate.mjs [file|-] [--layer L] [--json]`)

**Depends on:** Task 6 · **Files:** `agents/skills/lib/contracts/validate.mjs`,
`agents/skills/test/contracts-validate-cli.test.ts`

1. Write `test/contracts-validate-cli.test.ts`:

   ```ts
   /**
    * CLI contract for lib/contracts/validate.mjs (#1151). site-deploy.yml
    * (phase 5) refuses on any non-zero exit, so the exit codes ARE the
    * interface: 0 valid, 1 refused (incl. unparseable), 2 usage/unreadable.
    * In-process calls carry coverage; three spawnSync cases prove the real
    * entry point (main guard, stdin, exitCode) with a child-level timeout.
    */
   import { spawnSync } from 'node:child_process';
   import path from 'node:path';
   import { fileURLToPath } from 'node:url';

   import { afterEach, describe, it, expect, vi } from 'vitest';

   import { main } from '../lib/contracts/validate.mjs';

   const HERE = path.dirname(fileURLToPath(import.meta.url));
   const CLI = path.join(HERE, '..', 'lib', 'contracts', 'validate.mjs');
   const RUN = path.join(HERE, 'fixtures', 'contracts', 'run.valid.json');
   const ASSESSMENT = path.join(
     HERE,
     'fixtures',
     'contracts',
     'assessment.valid.json',
   );

   afterEach(() => vi.restoreAllMocks());

   function call(argv: string[], stdin = '') {
     const out: string[] = [];
     const err: string[] = [];
     vi.spyOn(console, 'log').mockImplementation(
       (...a: unknown[]) => void out.push(a.join(' ')),
     );
     vi.spyOn(console, 'error').mockImplementation(
       (...a: unknown[]) => void err.push(a.join(' ')),
     );
     const code = main(argv, { readStdin: () => stdin });
     vi.restoreAllMocks();
     return { code, stdout: out.join('\n'), stderr: err.join('\n') };
   }

   describe('validate.mjs CLI (in-process)', () => {
     it('exits 0 on a valid file and reports its denominator', () => {
       const r = call([RUN]);
       expect(r.code).toBe(0);
       expect(r.stdout).toBe('valid canary.run/1: 1 record checked, 0 errors');
     });

     it('exits 1 on a refused document and prints each path', () => {
       const r = call(['--layer', 'run', ASSESSMENT]);
       expect(r.code).toBe(1);
       expect(r.stderr).toMatch(/^contract: expected canary\.run\/1/m);
       expect(r.stderr).toMatch(/refused: 1 error/);
     });

     it('reads stdin for "-" and for no file argument', () => {
       expect(call(['-'], '{').code).toBe(1);
       expect(call([], '{').code).toBe(1);
     });

     it('criterion 18: unparseable and empty stdin exit 1, never 0', () => {
       for (const text of ['{', '', 'not json']) {
         const r = call(['-'], text);
         expect(r.code).toBe(1);
         expect(r.stderr).toMatch(/^\$: not parseable JSON/m);
       }
     });

     it('--json prints {valid, contract, checked, errors} on stdout', () => {
       const r = call(['--json', '-'], '{');
       expect(r.code).toBe(1);
       expect(JSON.parse(r.stdout)).toEqual({
         valid: false,
         contract: null,
         checked: 0,
         errors: [
           { path: '$', message: expect.stringMatching(/^not parseable JSON/) },
         ],
       });
     });

     it('exits 2 on an unknown --layer, an unknown flag, two files, or an unreadable file', () => {
       expect(call(['--layer', 'signal', RUN]).code).toBe(2);
       expect(call(['--strict', RUN]).code).toBe(2);
       expect(call([RUN, RUN]).code).toBe(2);
       const missing = call([path.join(HERE, 'no-such-file.json')]);
       expect(missing.code).toBe(2);
       expect(missing.stderr).toMatch(
         /^canary-contracts-validate: error: cannot read/,
       );
     });

     it('--help exits 0 and documents the exit codes', () => {
       const r = call(['--help']);
       expect(r.code).toBe(0);
       expect(r.stdout).toMatch(/^usage: canary-contracts-validate/);
       expect(r.stdout).toMatch(/0 valid/);
     });
   });

   describe('validate.mjs CLI (real process)', () => {
     const run = (args: string[], input?: string) =>
       spawnSync(process.execPath, [CLI, ...args], {
         encoding: 'utf8',
         input,
         timeout: 20_000,
       });

     it('exits 0 on a valid file', () => {
       expect(run([RUN]).status).toBe(0);
     });

     it('exits 1 on unparseable stdin (criterion 18, end to end)', () => {
       const r = run(['-'], '{');
       expect(r.status).toBe(1);
       expect(r.stderr).toMatch(/not parseable JSON/);
     });

     it('exits 2 on a usage error', () => {
       expect(run(['--layer']).status).toBe(2);
     });
   });
   ```

2. Run `npx vitest run test/contracts-validate-cli.test.ts` and observe it fail
   (`main` is not exported).
3. Append the CLI half to `lib/contracts/validate.mjs`. Add
   `import { pathToFileURL } from 'node:url';` and
   `import { createParser, EXIT_USAGE, formatUsageError } from '../parse-args.mjs';`
   to the imports, then add the following at the end of the file:

   ```js
   const PROG = 'canary-contracts-validate';

   const HELP = `usage: ${PROG} [-h] [--layer {run,assessment,site}] [--json] [file]
   
   Validate one canary QA contract document (canary.run/1, canary.assessment/1,
   canary.site/1). Reads stdin when file is omitted or '-'.
   
   exit codes: 0 valid · 1 refused (invalid or unparseable) · 2 usage or unreadable file`;

   const parse = createParser({
     prog: PROG,
     booleans: { '--json': 'json' },
     values: { '--layer': { key: 'layer' } },
     positionals: { key: 'files' },
   });

   function argsProblem(parsed) {
     if (parsed.error) return parsed.error;
     if (parsed.positionals.length > 1) {
       return `unrecognized arguments: ${parsed.positionals.slice(1).join(' ')}`;
     }
     const { layer } = parsed.opts;
     if (layer !== null && !LAYERS.includes(layer)) {
       return `argument --layer: invalid choice: '${layer}' (choose from ${LAYERS.join(', ')})`;
     }
     return null;
   }

   function readInput(file, readStdin) {
     if (file === undefined || file === '-') return { text: readStdin() };
     try {
       return { text: readFileSync(file, 'utf8') };
     } catch (err) {
       return { error: `cannot read ${file}: ${err.code ?? err.message}` };
     }
   }

   function printVerdict(res, json) {
     if (json) {
       console.log(JSON.stringify(res));
     } else if (res.valid) {
       const noun = res.checked === 1 ? 'record' : 'records';
       console.log(
         `valid ${res.contract}: ${res.checked} ${noun} checked, 0 errors`,
       );
     } else {
       for (const e of res.errors) console.error(`${e.path}: ${e.message}`);
       console.error(`refused: ${res.errors.length} error(s)`);
     }
   }

   /**
    * @param {string[]} [argv]
    * @param {{readStdin?: () => string}} [io] injectable for in-process tests
    * @returns {number} exit code
    */
   export function main(argv = process.argv.slice(2), io = {}) {
     const readStdin = io.readStdin ?? (() => readFileSync(0, 'utf8'));
     const parsed = parse(argv);
     if (parsed.help) {
       console.log(HELP);
       return 0;
     }
     const problem = argsProblem(parsed);
     const input = problem ? null : readInput(parsed.positionals[0], readStdin);
     const usage = problem ?? input.error;
     if (usage) {
       console.error(formatUsageError(PROG, usage));
       return EXIT_USAGE;
     }
     const res = validateText(input.text, { layer: parsed.opts.layer });
     printVerdict(res, parsed.opts.json);
     return res.valid ? 0 : 1;
   }

   // `process.exitCode`, not `process.exit()`: exit tears the process down
   // mid-write and truncates a large piped --json payload (#791).
   if (
     process.argv[1] &&
     import.meta.url === pathToFileURL(process.argv[1]).href
   ) {
     process.exitCode = main();
   }
   ```

   Keep the HELP template literal flush-left in the real file, because prettier
   does not reindent template contents. Check the length with
   `wc -l lib/contracts/validate.mjs`; it must stay at or under 300 lines.

4. Run
   `npx prettier --write lib/contracts/validate.mjs test/contracts-validate-cli.test.ts`,
   then
   `npx vitest run test/contracts-validate-cli.test.ts test/contracts-validate.test.ts`
   and observe it pass.
5. Run `npm run typecheck`, then `harness validate` from `$WT`.
6. Commit: `feat(contracts): validate.mjs CLI with refusal exit codes` with body
   `Refs #1151`.

### Task 8: put the contracts inside the gates (format, coverage, entry points)

**Depends on:** Task 7 (the entry point must be git-tracked) · **Files:**
`agents/skills/package.json`, `agents/skills/vitest.config.ts`,
`harness.config.json`

1. **Prove the gap first (RED).** Run `npm run format:check` and
   `npx vitest run --coverage 2>&1 | grep -c contracts`. Observe that the format
   check never mentions `lib/contracts`, and the coverage table count is `0`.
   That is the silent exclusion.
2. In `agents/skills/package.json` `format:check`, replace `\"lib/*.mjs\"` with
   `\"lib/**/*.mjs\" \"lib/contracts/*.json\" \"test/fixtures/contracts/*.json\"`.
3. In `agents/skills/vitest.config.ts` coverage `include`, replace
   `'lib/*.mjs',` with:

   ```ts
       // Recursive (#1151): lib/contracts/ is a subdirectory, and `lib/*.mjs`
       // silently left the contract validator outside the gate.
       'lib/**/*.mjs',
   ```

4. In `harness.config.json`, add the entry point to **both** `entryPoints`
   arrays at the same index. Use Edit with `replace_all: true` on the two
   identical lines below, so the two lists stay in lockstep
   (`ts/test/entropy-entrypoints.test.ts`):

   ```text
   old:   "agents/skills/claude-code/canary-test-reporter/scripts/voice.mjs",
          "agents/skills/vitest.config.ts",
   new:   "agents/skills/claude-code/canary-test-reporter/scripts/voice.mjs",
          "agents/skills/lib/contracts/validate.mjs",
          "agents/skills/vitest.config.ts",
   ```

5. **GREEN.** Run `npm run format:check` and `npm test`. The coverage table must
   now list `contracts/schema-check.mjs`, `contracts/rules.mjs` and
   `contracts/validate.mjs`, and the 90/90/85/90 thresholds must hold.
6. **Plant a positive.** Add two spaces of bad indentation to one line of
   `lib/contracts/rules.mjs`. Confirm `npm run format:check` fails naming that
   file, then revert with `git checkout -- lib/contracts/rules.mjs`. This file
   was written by this task, so reverting it is safe.
7. From `$WT/ts`, run
   `npx vitest run test/entropy-entrypoints.test.ts test/harness-config-denominator.test.ts`
   and observe it pass.
8. Run `harness validate` from `$WT`.
9. Commit with body `Refs #1151`:

   ```text
   chore(contracts): bring lib/contracts inside format, coverage and entry-point gates
   ```

### Task 9: `docs/specs/canary-run-contract.md`

**Depends on:** Task 7 · **Files:** `docs/specs/canary-run-contract.md`

1. **Check (RED).** From `$WT`, `node scripts/check_doc_links.mjs` passes now.
   The doc is written to be linked from the ADR (Task 11), so a wrong relative
   path shows up there.
2. Create the doc, modeled on `docs/specs/coverage-json-contract.md`, with these
   exact sections:
   - Frontmatter: `project: canary`, `version: 1`, `created: 2026-10-05`.
   - An H1 `Run Contract (canary.run/1)`, then a blockquote: one record per run
     or shard; the producer-side contract for the TestTracker ingest reporter
     (#603); and how to validate a file, which is `validate.mjs` with
     `--layer run`.
   - `## Shape`: the content of `run.valid.json` as a `json` block, followed by
     a link to the schema
     `[run.v1.schema.json](../../agents/skills/lib/contracts/run.v1.schema.json)`
     and the fixture.
   - `## Fields`: one table row per field in the schema (`contract`, `scope`,
     `scope.id`, `scope.env`, `producer.*`, every `run.*`, `totals.*`,
     `results`, every `results[].*`, `collected`, `collected[].*`), with type,
     nullability and notes.
   - `## Conventions (frozen)`, as bullets: the version rule (D3: unknown major
     refused, a minor only adds optional fields, unknown fields tolerated);
     scope (D2: explicit `{id, env}`, `env` opaque, never inferred); abstention
     (D4: `results: null` = not carried, `[]` = zero tests; `collected: null` =
     not reported, `[]` = none collected); **rule `totals-match-results`**
     (criterion 4: when `results` is an array its length equals `totals.total`);
     **rule `totals-sum`** (fork K); `file` is repo-relative (ADR 0029).
   - `## Status vocabulary`: run `passed | failed | cancelled` and the six
     result statuses.
   - `## Alignment with the TestTracker ingest payload` (D1, fork L): a mapping
     table from `npm/src/reporters/testtracker.ts` `IngestPayload` to
     `canary.run/1`. Rows: `canary_run_id` → `run.id` (shard-aware in phase 2,
     #1148); `status: flaky` → `run.status: passed` with `totals.flaky > 0`;
     Playwright `interrupted`/`timedout` run → `cancelled`; `mapStatus`
     `timedOut` → `failed` today, `timed_out` in phase 2 (#1149); `interrupted`
     → `skipped` today, `interrupted` in phase 2 (#1149); `full_title` →
     `title`; `test_file` → `file`; `error_message`/`error_stack` →
     `error.message`/`error.stack`; `collected[]` not sent today, emitted in
     phase 2 (#1150). State that the existing ingest payload is unchanged.
   - `## Validating`: the CLI, the three exit codes (fork M), the error shape
     `{path, message}` with `$` as the root (fork H), and the `--json` payload
     `{valid, contract, checked, errors}`.
   - `## Consumers`: none yet; phase 2 adds the reporter emission and
     `canary-starling`. State that the format is generic and carries no
     project-, employer- or client-specific content.
3. From `$WT`: `npx --yes prettier@3 --write docs/specs/canary-run-contract.md`,
   `npx --yes markdownlint-cli docs/specs/canary-run-contract.md`,
   `node scripts/check_doc_fences.mjs` and `node scripts/check_doc_links.mjs`.
   All four must pass.
4. Run `harness validate`.
5. Commit: `docs(contracts): canary.run/1 contract spec` with body `Refs #1151`.

### Task 10: assessment and site-feed contract docs

**Depends on:** Task 9 · **Files:** `docs/specs/canary-assessment-contract.md`,
`docs/specs/canary-site-feed-contract.md`

1. Create `docs/specs/canary-assessment-contract.md` with the same frontmatter
   and these sections. The shape is `assessment.valid.json` plus a link to the
   schema. The fields table covers every field. Conventions (frozen):
   - append-only, with identity key `scope.id + scope.env + source + metric` and
     readers taking the latest per key by `observed_at`;
   - `observed_at` is when the check ran, not when it was stored;
   - no composite (D6, pointing to phase 3's ADR);
   - **rule `status-shape`** (criterion 2, fork D): `not-assessed` ⇒ `value`
     null and `reason` non-blank; every other status ⇒ `value` non-null
     (`number | boolean`) and `reason` null;
   - **rule `verified-derived`** (criterion 3, fork G: a supplied `verified` key
     is refused even when null);
   - **rule `verification-pair`** (criterion 17). Include a status table
     defining the five statuses, with `observed` = a measured value with no
     threshold judgment. End with Validating and Consumers sections as in
     Task 9.
2. Create `docs/specs/canary-site-feed-contract.md` (fork J). Shape:
   `site.valid.json` plus a schema link. Sections:
   - fields: `scopes`, `suites` (D12: `null` = none declared ≠ `[]`), `runs`
     (`canary.run/1`, last 30 per suite (D15), results only on each suite's
     latest run, fork A), `flaky` (D13: distinct tests), `assessments` (latest
     per identity key), `register` (fork C mapping table from the
     `canary-katana` ledger: `test`→`title`, `date`→`recorded_at`, `commit`,
     `cause`, `issue`, `kind`, `reason`; the ledger's `author` is deliberately
     NOT carried — state that author identity is excluded from a public feed);
   - every `scope` is `{id, env}` (fork B);
   - a "Deferred to phase 2" list: the cross-record invariants from fork K,
     which must land before an npm release carries `canary.site/1`.
3. From `$WT`, run prettier, markdownlint, `check_doc_fences.mjs` and
   `check_doc_links.mjs` over both files, as in Task 9 step 3, then
   `harness validate`.
4. Commit:
   `docs(contracts): canary.assessment/1 and canary.site/1 contract specs` with
   body `Refs #1151`.

### Task 11: ADR 0035, its index row, and the AGENTS.md map line

**Depends on:** Task 10 · **Files:**
`docs/knowledge/decisions/0035-versioned-two-layer-qa-data-contract.md`,
`docs/knowledge/decisions/README.md`, `AGENTS.md` ·
**[checkpoint:human-verify]**

1. **RED.** Create the ADR file with frontmatter only: `number: 0035`,
   `title: QA results travel in a versioned two-layer contract`,
   `date: 2026-10-05`, `status: accepted`, `tier: medium`,
   `source: docs/changes/canary-qa-site/proposal.md`. Then from `$WT/ts`, run
   `npx vitest run test/adr-index.test.ts test/adr-ingestable.test.ts` and
   observe a failure, because the README has no row yet and the file has no
   directive or heading.
2. Write the body, following the ADR 0033 layout:

   ```markdown
   <!-- markdownlint-disable-file MD025 -->

   # ADR 0035 — QA results travel in a versioned two-layer contract

   **Status:** accepted **Date:** 2026-10-05 **Deciders:** Bri Stevenski
   **Related:** [#1151](https://github.com/bop-clocktower/canary/issues/1151);
   `docs/changes/canary-qa-site/proposal.md` (D1–D5); ADR 0009 (exit 3 reserved
   for "abstained"); ADR 0029 (repo-relative `file` join key); ADR 0030
   (additive schema versions)

   ## Context

   At least three envelopes carry QA results to people who do not open code —
   the TestTracker ingest run payload canary's reporter pushes, a private
   unified-reporting report, and a consumer's health-signal envelope — and none
   carries a version or names its scope. Each dashboard re-derives the metrics,
   and the copies drift: one audited pass-rate trend returns 0% when nothing ran
   where the canonical helper returns "—". canary's own outputs mix
   `schema_version` and `schemaVersion`, int and string. Scope inferred from
   "last active" state once resolved a handoff to the wrong tenant.

   ## Decision

   1. **Two layers, aligned not invented (D1).** `canary.run/1` (per run, per
      test) maps field-for-field onto the ingest payload the reporter already
      sends; `canary.assessment/1` holds one assessed metric per record. A
      static `canary.site/1` feed composes them.
   2. **Scope is explicit (D2).** Every record carries `scope: {id, env}`; `env`
      is opaque; nothing is inferred from a session or token.
   3. **One version convention (D3).** `"contract": "canary.<layer>/<major>"`.
      Readers refuse an unknown major; a minor only adds optional fields, so
      readers tolerate unknown fields.
   4. **Abstention is a value (D4).** `null` ≠ `0`; absent ≠ `[]` ≠ a list;
      `not-assessed` requires a `reason` and forbids a `value`, and every other
      status requires a value.
   5. **Verification is derived (D5).** `verified_by` + `verified_at` are both
      set or both null; a producer-supplied `verified` key is refused, even
      `null`.
   6. **Enforcement is schema-driven and zero-dependency.** The three
      `*.v1.schema.json` files in `agents/skills/lib/contracts/` are the
      contract; `validate.mjs` interprets a declared JSON Schema keyword subset
      and refuses, at load, any keyword it does not enforce. Relations between
      fields are named rules in `rules.mjs`. Exit 0 valid, 1 refused (including
      unparseable input), 2 usage.

   ## Consequences

   - Adopting the contract is a field mapping for the reporter (phase 2), not a
     redesign; the existing ingest payload is unchanged.
   - A stricter rule added after a release refuses documents that used to pass,
     so cross-record site invariants must land before the first npm release that
     carries `canary.site/1`.
   - `additionalProperties`, `if/then`, `oneOf` and `format` are unavailable in
     the schemas; a contributor who needs one extends the interpreter and its
     tests first, or the validator refuses to load.
   - Specs: `docs/specs/canary-run-contract.md`,
     `docs/specs/canary-assessment-contract.md`,
     `docs/specs/canary-site-feed-contract.md`.

   ## Alternatives Considered

   - **A JSON Schema library (ajv).** Present only transitively in `ts/` and
     `npm/` via the MCP SDK; the skills tree is dependency-free so a producer's
     CI can run the validator with nothing installed. Rejected.
   - **Hand-coded checks, schemas as documentation.** The schemas are what other
     teams read; a validator that does not interpret them drifts from them
     silently. Rejected.
   - **Strict closure (`additionalProperties: false`).** Makes every additive
     minor a breaking change, contradicting D3. Rejected.
   - **A fourth, superset envelope.** The drift problem itself. Rejected.
   ```

3. Add the index row at the end of the table in
   `docs/knowledge/decisions/README.md` (prettier re-pads the table):

   ```text
   | [0035](0035-versioned-two-layer-qa-data-contract.md) | QA results travel in a versioned two-layer contract | accepted |
   ```

4. In `AGENTS.md` under `### Configuration & Data`, after the
   `**Harness Config:**` bullet, add:

   ```markdown
   - **QA data contract:** `agents/skills/lib/contracts/` — `canary.run/1`,
     `canary.assessment/1` and `canary.site/1` as JSON Schemas plus a
     zero-dependency validator, `validate.mjs <file> [--layer L] [--json]` (exit
     0 valid, 1 refused, 2 usage). Specs in `docs/specs/canary-*-contract.md`;
     [ADR 0035][adr-0035].

   [adr-0035]:
     docs/knowledge/decisions/0035-versioned-two-layer-qa-data-contract.md
   ```

   The reference-style link keeps every prose line within markdownlint's 80
   columns. Put the `[adr-0035]:` definition at the bottom of `AGENTS.md`, next
   to the existing `[fw-json]` definition.

5. From `$WT`: run `npx --yes prettier@3 --write` on the three files;
   `npx --yes markdownlint-cli` on the three files;
   `node scripts/check_doc_links.mjs`; then from `ts/`
   `npx vitest run test/adr-index.test.ts test/adr-ingestable.test.ts test/agents-roadmap-counts.test.ts`.
   Observe it pass. Confirm `head -3` of the ADR still shows `title:` on a
   single line.
6. **[checkpoint:human-verify]** Show the human the ADR text and the AGENTS.md
   bullet. The ADR is the record other teams will cite, so its wording needs
   human sign-off before commit. Wait for confirmation.
7. Run `harness validate`.
8. Commit: `docs(adr): 0035 versioned two-layer QA data contract` with body
   `Refs #1151`.

### Task 12: four gates in both trees, ratchets, probes, PR

**Depends on:** Tasks 1-11 · **Files:** none (verification + PR)

1. **Gates.** Run each command separately and read its count. Silence means it
   did not run.
   - `agents/skills`: `npm test` (thresholds 90/90/85/90; the test count must
     have grown by the five new files), `npm run typecheck`,
     `npm run format:check`.
   - `ts/`: `npm run build`, `npm run typecheck`, `npm run format:check`,
     `npm test`.
   - repo root: markdownlint exactly as `docs-lint.yml` runs it (below), then
     `node scripts/check_doc_fences.mjs`, `node scripts/check_doc_links.mjs`,
     `harness validate` and `harness check-deps`.

     ```bash
     npx --yes markdownlint-cli "**/*.md" --ignore node_modules --ignore plugins \
       --ignore agents/agents --ignore agents/commands
     ```

2. **Ratchets, measured against the merge base.** Use a base worktree outside
   the checkout and the same CLI on both sides (`harness --version` = 12.10.1 =
   both baselines' `harnessCli`):

   ```bash
   S=$(mktemp -d)
   git -C "$WT" worktree add --detach "$S/base" 0ba2dd68
   (cd "$WT" && harness check-perf > "$S/perf-head.txt" 2>&1; harness cleanup --findings-json > "$S/ent-head.txt" 2>&1; harness check-arch > "$S/arch-head.txt" 2>&1)
   (cd "$S/base" && harness check-perf > "$S/perf-base.txt" 2>&1; harness cleanup --findings-json > "$S/ent-base.txt" 2>&1; harness check-arch > "$S/arch-base.txt" 2>&1)
   node "$WT/scripts/perf-ratchet.mjs" --report "$S/perf-head.txt" --base-report "$S/perf-base.txt" --cli-version 12.10.1
   node "$WT/scripts/entropy-ratchet.mjs" --report "$S/ent-head.txt" --base-report "$S/ent-base.txt" --cli-version 12.10.1
   diff <(grep -c '^  \*' "$S/arch-base.txt") <(grep -c '^  \*' "$S/arch-head.txt")
   grep -n 'lib/contracts' "$S/perf-head.txt" "$S/ent-head.txt"   # must print nothing
   git -C "$WT" worktree remove "$S/base"
   ```

   Expect perf and entropy to exit 0 with a **+0 delta**, the arch counts to be
   equal, and the `grep` to print nothing. If a `lib/contracts` finding appears,
   fix the code by splitting the function or file. Never add a `deltaAllowances`
   entry, and never edit `maxFindings`, `maxViolations` or any baseline. If
   `schema-check.mjs` or `rules.mjs` shows up as dead, apply the `entryPoints`
   fallback from §2 Uncertainties.

3. **Probes (each must go red, then be reverted).** Each probe edits only files
   this branch created.
   - In `rules.mjs`, make `totalsMatchResults` return `[]` unconditionally. The
     criterion-4 tests must fail.
   - In `run.v1.schema.json`, add `"additionalProperties": false` to `scope`.
     Importing `validate.mjs` must throw `unenforceable schema`, and
     `contracts-schemas.test.ts` must fail.
   - In `rules.mjs`, change `verifiedSupplied` to test truthiness
     (`if (!a.verified)`). The `verified: null` and `verified: false` cases must
     fail (fork G).

   Revert each probe with `git checkout -- <file>` and re-run `npm test` green.

4. **Doc-drift and testing-gap check (rule 8).** Ask two questions explicitly.
   What does this change make wrong? Expected answer: nothing; the `AGENTS.md`
   bullet, ADR and three specs are new. What behavior does nothing test?
   Expected answer: the HELP text body beyond the asserted lines. Record both
   answers in the PR body.
5. **Branch base.** Run `git -C "$WT" fetch origin`, then
   `git -C "$WT" merge-base --is-ancestor 0ba2dd68 origin/main && echo on-main`.
   **[checkpoint:decision] only if it is not on main.** Choose between: (a) wait
   for the spec PR to merge, then `git rebase origin/main`, which drops the
   duplicate spec commit; (b) open this PR now as a draft against `main`
   containing the spec commit, and say so in the body. Recommendation: (a).
6. Push, then open the PR:

   ```bash
   gh pr create --base main --body-file "$S/pr-body.md" \
     --title "feat(contracts): canary QA data contract, phase 1 (run, assessment, site + validator)"
   ```

   The body must include: `Refs #1151` and **not** `Closes`; the criterion→test
   table from §5; the EVALUATE defaults A–Q; the ratchet output lines
   (perf/entropy delta +0, arch equal); and the rule-8 answers. No co-author
   trailer.

7. Watch CI to green. Per standing preference, admin-merge a verified-green
   canary PR, then re-measure after merge, because phases merge serially.

## 5. Criterion → test traceability

| Criterion   | Test file                                                 | Test name(s)                                                                                                                                                                                                                                                                          |
| ----------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1           | `contracts-validate.test.ts`                              | `refuses a %s record with no contract field, naming contract` (×3 layers); `refuses an unknown major version, naming contract`; `refuses an unknown layer and a non-string contract, naming contract`; `refuses an unknown major nested in a site feed, naming runs[0].contract`      |
| 2           | `contracts-validate.test.ts`                              | `refuses not-assessed carrying a value, naming value`; `refuses not-assessed without a reason, naming reason`; `refuses observed with a null value, naming value`; `refuses %s with a null value (fork D …)` (×3); control `accepts a well-formed not-assessed and a valued observed` |
| 3           | `contracts-validate.test.ts`                              | `refuses verified: %s (fork G: key presence, not truthiness)` (×3); `refuses verified inside a site feed, naming assessments[0].verified`                                                                                                                                             |
| 4           | `contracts-validate.test.ts`                              | `refuses a run whose totals.total differs from results.length, naming totals.total`; `refuses results: [] against totals.total 1`; `refuses a mismatched run nested in a site feed …`; control `accepts results: null …`                                                              |
| 16          | `contracts-validate.test.ts`                              | `refuses a run/assessment record missing scope / scope.id / scope.env, naming it` (×6); `refuses a blank env …`; `refuses a bare-string scope in a site feed (fork B) …`                                                                                                              |
| 17          | `contracts-validate.test.ts`                              | `refuses verified_by without verified_at, naming verified_at`; `refuses verified_at without verified_by, naming verified_by`; control `accepts both set`                                                                                                                              |
| 18          | `contracts-validate.test.ts`, `-cli.test.ts`              | `refuses %j, naming $` (×4); `criterion 18: unparseable and empty stdin exit 1, never 0`; `exits 1 on unparseable stdin (criterion 18, end to end)`                                                                                                                                   |
| 15          | Task 12                                                   | four gates × two trees; perf/entropy `--base-report` +0; arch count equal; probes red-then-green                                                                                                                                                                                      |
| Non-vacuity | `contracts-validate.test.ts`, `contracts-schemas.test.ts` | `holds one valid document per layer (a zero denominator is not a pass)`; `ships exactly one schema per layer …`; `uses only enforced keywords, and every $ref resolves`; per-layer `accepts the valid %s document`                                                                    |

## 6. Risks

- **CI-only ratchets** (dead exports, perf complexity, coupling) are invisible
  to the local gates. Mitigations: minimal exports, per-function splits sized to
  the measured thresholds, the merge-base measurement in Task 12, and the
  explicit fallbacks in §2 Uncertainties.
- **Contract permanence.** Forks A, C, D and I fix shapes that D3 makes costly
  to change. They are surfaced as defaults for approval rather than decided
  silently.
- **Stacked base.** This branch carries the unmerged spec commit; see Task 12
  step 5.
- **canary-savant SV004** flagged an order-coupled name in a comment on #1024.
  Keep comments free of "before X / after Y" step names that a reordering would
  falsify.
