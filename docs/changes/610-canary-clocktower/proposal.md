# canary-clocktower — run-history gap analysis

**Issue:** #610 · **Ideation:**
`docs/ideation/bop-themed-canary-skills-2026-07-21.md` rank 5 · **Status:**
approved (autonomous roadmap-fleet lane — see Assumptions)

**Keywords:** run-history, gap-analysis, field-coverage, consumers, abstention,
history-v2.jsonl, denominator

## Overview

The ideation entry framed clocktower as a greenfield "persistent run-history
substrate". That premise is false and the issue body says so: the store exists
(`ts/src/history/ndjson-store.ts`, `ts/src/history/supabase-store.ts`) and has a
writer (`canary history record`, #538, closed). The rescoped question is a **gap
analysis**: what does the history store _not_ carry that a reader needs, and
which readers are therefore running dark.

Verified against the tree at `47745970` before designing:

| Claim in the issue                          | Verified state                                                                                                                                                                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "nothing currently writes the local store"  | **Closed.** `canary history record` (#538) reads Playwright / Vitest / JUnit reports and appends (`ts/src/history/record/cli.ts:221`).                                                                                                                 |
| "what does canary-test-reporter NOT push"   | The reporter pushes **nothing** — it renders Markdown/JSON only (`agents/skills/claude-code/canary-test-reporter/SKILL.md`, no history mention). The write path is `history record` over the same Playwright JSON, but the reporter doc never says so. |
| "which consumers are not wired to query it" | canary-signal (#609) is not on `main`. Every shipped consumer (`analyze`, `ci-ready`, `order`, `rewind`, canary-screech, `history flaky/timeline`) already reads the store. The real gap is **field-level**: consumers read fields no writer fills.    |

The gap nobody had measured: **three test-level fields are declared in the
schema, read by consumers, and written by no writer.**

- `area` — declared `ts/src/history/schema.ts:49`, read by `analyze area-health`
  (`ts/src/analysis/reports.ts:121`) and the flaky table's area column
  (`ts/src/history/flake/render.ts:69`). No format reader in
  `ts/src/history/formats/` sets it.
- `failure_category` — declared `ts/src/history/schema.ts:50`, read by `analyze`
  spikes/common-failures (`ts/src/analysis/engine.ts:57`,
  `ts/src/analysis/reports.ts:196`), which default it to `'other'`. No writer
  sets it, so every categorised report is one bucket.
- `tags` — declared and pushed (`ts/src/history/publish/cli.ts:68`), never
  written.

These are today's findings. They will not stay today's findings, which is why
the deliverable is a command that re-measures them, not only a document.

## Goals

1. A read-only command that answers, **for the store actually on disk**, which
   history consumers are fed, partially fed, or dark — per required field, with
   denominators.
2. Loud abstention: a missing or empty store is an abstention that names what
   was dark, never "no gaps".
3. A documented gap list (this file, _Documented gap list_) and the one piece of
   wiring the issue asks for that is pure documentation: canary-test-reporter's
   SKILL.md points at `canary history record`.
4. A `/canary-clocktower` skill so the capability is discoverable next to its
   siblings (screech, batwoman).

## Non-goals

- A second store, a new schema version, or any change to `ts/src/history/**`.
  That module sits exactly on its 1800-LOC arch ceiling and `history/cli.ts` on
  the 15-import perf threshold (#1074).
- **Filling** the gaps. Populating `area` / `failure_category` means changing
  the format readers inside `ts/src/history/formats/`; that is a follow-up issue
  filed from this change, not this change.
- Remote (Supabase) store analysis. The remote API exposes query methods, not
  raw records; the command reads the local NDJSON store and says so when a
  remote is configured.
- Wiring canary-signal or canary-manhunter. Neither is on `main`; they are
  sibling lanes. The consumer table is a data structure they can append to.

## Decisions made

| #   | Question (self-answered, autonomous lane) | Options                                                                                     | Chosen                                        | Why                                                                                                                                                                                                                                                           |
| --- | ----------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Where does the code live?                 | (A) `ts/src/history/**` (B) new module reading history's exports                            | **B** — `ts/src/analysis/clocktower/`         | **Human-answered fork.** History is at its ceilings (#1074). `analysis` may depend on `history` (`harness.config.json` layers).                                                                                                                               |
| D2  | Doc-only gap list vs. runtime command?    | (A) document only (B) command + document                                                    | **B**                                         | A document is correct once. The gaps are a property of each adopter's store and of future writers; only a re-runnable measure stays true.                                                                                                                     |
| D3  | CLI surface                               | (A) `canary history gaps` (B) `canary analyze clocktower` (C) top-level `canary clocktower` | **A** — mounted from the #988 engine registry | It answers a question _about the history store_, so it belongs in `history --help`. Mounting from `ts/src/commands/engine/cli.ts` (the `trim` precedent, #1073) adds zero lines to `history/cli.ts`. (C) would grow the top-level registry for a narrow read. |
| D4  | Exit-code contract                        | (A) advisory, exit 0 (B) gate: 0 fed / 1 gaps / 3 abstained                                 | **B**                                         | CLI-wide contract (`ts/src/core/gate-result.ts`, D4): 3 is reserved for abstention. `analyze gh-flaky` (#884) is the precedent for 1-on-candidates. A CI step wanting advisory output ignores the exit code.                                                  |
| D5  | Granularity of a finding                  | (A) per field (B) per consumer, with its fields                                             | **B**                                         | "area is 0% populated" is trivia; "`analyze area-health` is dark because no run carries `area`" is actionable. Fields render beneath each consumer.                                                                                                           |
| D6  | Denominator for a conditional field       | (A) all tests (B) only applicable tests                                                     | **B**                                         | `failure_category` only means something on a failed test. A store with no failures has no denominator for it: that consumer is **unmeasured**, not fed.                                                                                                       |
| D7  | Missing vs. empty store                   | (A) same abstention (B) distinct reasons                                                    | **B**                                         | `NdjsonHistoryStore.readAll()` returns `[]` for ENOENT, byte-identical to an empty file. A typo'd path must read as "not found", so the command checks existence first (the canary-screech rule, `canary-screech/scripts/history.mjs:8`).                     |
| D8  | Remote store configured                   | (A) refuse (B) analyse local, name remote as skipped                                        | **B**                                         | Unlike `trim`, reading is harmless; but a remote the command did not look at must be visible, so it renders as a `SkipEntry` in the summary line.                                                                                                             |

## Approaches considered

**Approach 1 — static gap document only.** Write the table above into docs. _Low
complexity; zero ratchet cost._ Goes stale the first time a writer changes, and
says nothing about an adopter's own store (an adopter using only the JUnit
reader has a different gap set). Rejected by D2.

**Approach 2 — consumer-requirement table + field-coverage analysis (chosen).**
A declarative table of consumers → required fields → predicate, a pure analyser
that computes per-requirement coverage over the records, a renderer, and a thin
CLI. _Medium complexity_ (4 small modules). Risk: the table drifts from the
consumers it describes — mitigated by a test per consumer row naming the source
line it mirrors, and by the table being the one place to update.

**Approach 3 — instrument each consumer to self-report missing fields.** Every
consumer emits "I read field X and it was absent". Most precise, but touches
`ts/src/history/**` (forbidden), `analysis/cli.ts`, `ci-ready-cli.ts` and a
skill script — a wide blast radius, and still silent for consumers not run.
Rejected.

## Technical design

### Module layout — `ts/src/analysis/clocktower/`

| File           | Layer (first-match) | Role                                                                                            |
| -------------- | ------------------- | ----------------------------------------------------------------------------------------------- |
| `consumers.ts` | analysis            | The consumer table: `Consumer { id, surface, requirements: Requirement[] }`.                    |
| `gaps.ts`      | analysis            | `analyzeGaps(records: RunRecord[]): GapReport` — pure.                                          |
| `render.ts`    | analysis            | `renderGapReport(report, meta): string` (text) — pure.                                          |
| `cli.ts`       | cli                 | `registerGapsCommand(history, deps)` — reads the store, applies `gateOutcome`, maps exit codes. |

Imports from history are type/`NdjsonHistoryStore` only, through existing
exports: `ts/src/history/ndjson-store.ts` (`NdjsonHistoryStore.readAll`) and
`ts/src/history/record.ts` (`RunRecord`, `TestResultRecord`).

### Data shapes

```ts
type Scope = 'run' | 'test' | 'failed-test';
interface Requirement {
  field: string; // display name, e.g. 'area'
  scope: Scope; // what the denominator counts
  carried(run: RunRecord, test?: TestResultRecord): boolean;
}
interface Consumer {
  id: string;
  surface: string;
  requirements: Requirement[];
  optIn?: string;
}

interface RequirementCoverage {
  field: string;
  scope: Scope;
  carried: number;
  applicable: number;
}
type ConsumerStatus = 'fed' | 'partial' | 'dark' | 'unmeasured';
interface ConsumerGap {
  id: string;
  surface: string;
  status: ConsumerStatus;
  optIn?: string;
  coverage: RequirementCoverage[];
}
interface GapReport {
  runs: number;
  tests: number;
  consumers: ConsumerGap[];
}
```

Status rule, per consumer: if any requirement has `applicable === 0` →
`unmeasured`; else if every requirement has `carried === applicable` → `fed`;
else if any requirement has `carried === 0` → `dark`; else `partial`.

### Consumer table (initial rows)

| id                   | surface                               | requirements (scope)                          |
| -------------------- | ------------------------------------- | --------------------------------------------- |
| `screech`            | canary-screech, `history timeline`    | `branch`, `commit_sha`, `timestamp` (run)     |
| `ci-ready-runtime`   | `canary ci-ready` suite runtime       | `duration_ms` (run)                           |
| `flaky-retry`        | `history flaky`, `analyze flaky`      | `reporter_format` ∈ {playwright, junit} (run) |
| `area-health`        | `analyze area-health`, flaky area col | `area` (test)                                 |
| `failure-categories` | `analyze spikes / common-failures`    | `failure_category` (failed-test)              |
| `order`              | `canary order`                        | `test_file`, `duration_ms` (test)             |
| `rewind`             | `canary rewind`                       | `replay` (run), `start_index` (test)          |
| `order-ttff`         | `canary order --report` (TTFF)        | `order` (run) — `optIn: '--order-plan'`       |

`optIn` rows render their status with the flag that feeds them, so a dark opt-in
consumer reads "dark (fed only by `history record --order-plan`)" rather than as
a defect.

### CLI — `canary history gaps [--path <store>] [--json]`

1. Resolve the path (default `test-results/reports/history-v2.jsonl`).
2. Missing file → abstain: `store not found: <path>`. Empty file → abstain:
   `store is empty: <path> (0 runs)`. Both name every consumer as
   dark-by-abstention.
3. Otherwise `analyzeGaps(store.readAll())`.
4. Pass `{ checked, findings, skipped }` to `gateOutcome(..., 'gate')`, where
   checked = consumers measured and findings = dark + partial. Skipped: each
   `unmeasured` consumer (reason: "no applicable rows"), plus the remote store
   when `CANARY_HISTORY_DB_URL` is set (reason: "local NDJSON only").
5. Exit: 0 all measured consumers fed · 1 any dark/partial · 3 abstained.
   Malformed or unsupported-version store → the reader's error, exit 1 (it is
   already loud; not an abstention).

`--json` emits `{ path, abstained, reason?, runs, tests, consumers, exitCode }`.

## Documented gap list

| ID  | Gap                                                                                                 | Where                                     | Disposition                           |
| --- | --------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------- |
| G1  | `area` declared + read, never written                                                               | all readers in `ts/src/history/formats/`  | follow-up issue (writer change)       |
| G2  | `failure_category` declared + read, never written; every categorised report is `'other'`            | same                                      | follow-up issue (writer change)       |
| G3  | `tags` declared + pushed, never written                                                             | same                                      | follow-up issue (writer change)       |
| G4  | canary-test-reporter never mentions that `history record` persists the same report                  | `canary-test-reporter/SKILL.md`           | **fixed here** (doc wiring)           |
| G5  | canary-signal (#609) is not on `main`; it cannot be wired yet                                       | sibling lane                              | out of scope; table accepts a new row |
| G6  | The Vitest reader cannot emit `flaky`, so `flaky-retry` is structurally dark for Vitest-only stores | `ts/src/history/formats/vitest-report.ts` | known (#604); surfaced by the command |

## Integration points

### Entry Points

- New subcommand `canary history gaps`, mounted in
  `ts/src/commands/engine/cli.ts` beside `trim`.
- New skill `agents/skills/claude-code/canary-clocktower/SKILL.md`
  (`cli: canary history gaps`, `requires: [node>=20]`).

### Registrations Required

- `harness.config.json`: the three non-CLI modules in both `entropy.entryPoints`
  and `performance.entryPoints` (the batwoman precedent).
- Engine gate-conformance row in `ts/test/gate-conformance.test.ts` (a new gate
  is not done until it has one).
- `docs/naming-registry.md`: `canary-clocktower` reserved → shipped.
- `agents/skills/README.md` skill list; any roster test that enumerates skills.

### Documentation Updates

- `docs/guides/history-gaps.md` (new): the command, its exit codes, the consumer
  table, and links to every new source file (docs-coverage floor).
- `canary-test-reporter/SKILL.md`: a "Persisting runs" note (G4).
- AGENTS.md only if a test enforces a skill count there.

### Architectural Decisions

None rise to an ADR: D1 is the recorded #1074 rule applied, D3 is the #988
registry pattern applied, D4 is the existing CLI-wide contract.

### Knowledge Impact

A new concept, **consumer field coverage**: a history consumer is only as live
as the least-populated field it reads. Worth a knowledge entry beside the
denominator doctrine of #508.

## Success criteria

1. When the store path does not exist, `canary history gaps` shall exit 3 and
   print `not found` with the path; it shall never print a pass line.
2. When the store exists with zero runs, the command shall exit 3 and say the
   store is empty.
3. When every run carries every field a consumer needs, that consumer shall be
   `fed`; when none does, `dark`; when some do, `partial` with
   `carried/applicable`.
4. If a store has no failed tests, then `failure-categories` shall be
   `unmeasured` and rendered as skipped, never `fed`.
5. Against a store written by today's `history record` from a Playwright report,
   `area-health` and `failure-categories` shall be reported `dark` (G1, G2
   reproduced end-to-end) and the command shall exit 1.
6. When `CANARY_HISTORY_DB_URL` is set, the summary line shall name the remote
   store as skipped.
7. `ts/src/history/**` has a zero-line diff.
8. Four gates green; entropy, perf, arch and docs ratchets equal to or better
   than the merge base.

## Implementation order

1. Pure core: `consumers.ts` + `gaps.ts` with unit tests (TDD).
2. `render.ts` + tests.
3. `cli.ts` + registry mount + gate-conformance row + CLI tests.
4. Skill, docs, config registrations, naming registry, reporter doc wiring.
5. Ratchets vs merge base, provenance, PR.

## Assumptions (autonomous lane)

- A1: Rescope accepted as stated in the issue; the greenfield framing is not
  revived.
- A2: D2–D8 above are recommended defaults taken without a human round.
- A3: `Closes #610` — the issue's acceptance is "a documented gap list plus
  wiring"; filling G1–G3 changes writers inside `ts/src/history/**` and is filed
  as a separate follow-up.
- A5: The store flag is `--path <store>` (planner finding): every engine command
  that reads or writes the store (`history trim`, `history record`, `order`,
  `rewind`) already uses it; only the canary-screech script says `--history`.
- A4: The companion skill is warranted by the issue's `canary-clocktower` name
  and the naming registry's reservation, following batwoman's thin-skill shape
  (SKILL.md over a CLI, no bundled scripts).
