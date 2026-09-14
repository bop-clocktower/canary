# Canary Screech Implementation Plan

<!-- markdownlint-disable-file MD013 MD032 -->
<!-- Generated implementation plan: the writing-plans format uses long
     command/prose lines and label-then-list blocks (**Files:** followed by a
     list). Line-length and blanks-around-lists are relaxed for this working
     doc, matching the roadmap's MD013 disable. -->

**Issue:** [#591](https://github.com/ahhrealmonster/canary/issues/591) —
`canary-screech`, a broken-main siren. Split out of the closed Skill Forge
umbrella (#339), Wave 1.

**Goal:** Ship `canary-screech`, a self-contained bundled executable skill that
detects the default branch going red **across runs**, and emits a one-page
blast: culprit commit range, failure cluster, owning area, a
quarantine-or-revert recommendation, and a chat-ready block.

**Architecture:** A skill directory at
`agents/skills/claude-code/canary-screech/` following the `canary-fail-fast`
pattern exactly — a `scripts/` package of small pure modules plus a thin
`cli.mjs` routed through the shared `lib/parse-args.mjs` parser. No dependency
on any other skill and no dependency on engine code under `ts/`.

**Tech Stack:** Node >= 20, ESM `.mjs`, vitest (the `agents/skills` project, not
`ts/`).

## Why it is distinct from the two neighbouring skills

| Skill                  | Scope                       | Knows the branch is red? |
| ---------------------- | --------------------------- | ------------------------ |
| `canary-fail-fast`     | in-run; aborts early        | no                       |
| `canary-test-reporter` | per-run summary             | no                       |
| **`canary-screech`**   | **cross-run, branch-level** | **yes**                  |

## Resolved design questions

The issue left two open questions. Both are resolved here, and both are recorded
in `docs/changes/canary-screech/provenance.json`.

1. **Where does the "default branch is red" signal come from?** The
   **run-history store** — `test-results/reports/history-v2.jsonl`, one
   `RunRecord` JSON object per line (`ts/src/history/record.ts`). Chosen over a
   GH Actions webhook or polling because it needs no network, no credentials and
   no service: the family contract for these skills is deterministic and
   self-contained, and the store already carries `branch`, `commit_sha`,
   `timestamp`, the pass/fail counts, and per-test `area` / `failure_category`.
   The skill reads the store; it never writes to it.

2. **Does it need write access to post the blast?** **No.** Per the answered
   fork, the siren emits a standalone markdown artifact plus a `::error` GitHub
   Actions annotation — the same output channel `canary-fail-fast` uses. No
   Slack, no Teams, no webhook, no `gh` call. The chat-ready block is emitted
   for a human to paste.

## Global Constraints

- **Self-contained:** no imports outside the skill's own `scripts/` dir and the
  shared `lib/parse-args.mjs` (the one family-wide exception, per #479).
- **CLI surface:** `--history PATH` (required), `--branch NAME` (default
  `main`), `--out PATH` (the markdown artifact), `--strict`.
- **Exit contract:** advisory by default (D3) — exit 0 unless `--strict`. Under
  `--strict`: 1 when the branch is red, 3 when the skill **abstained** (zero
  runs for the branch in the store), 0 when the branch is green.
- **Abstention is not a pass (rule 2 / #508):** a store with no rows for the
  requested branch is a zero denominator. It prints a loud `ABSTAINED` line,
  never the green copy, and registers a row in
  `agents/skills/test/gate-conformance.test.ts`.
- **No `process.exit(main(...))`** (#791) — `process.exitCode = main(...)`,
  enforced by the conformance suite.
- **Entropy/perf ratchet:** the new `cli.mjs` is declared in **both**
  `entropy.entryPoints` and `performance.entryPoints` in `harness.config.json`.
  `maxFindings` is never raised.
- **Coverage:** the new scripts glob is added to the `include` list in
  `agents/skills/vitest.config.ts` and to `format:check` in
  `agents/skills/package.json`, and must clear the 90/90/85/90 floor.

## Module breakdown

| Module                | Responsibility                                                                                                                           | Pure?                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `scripts/history.mjs` | read + validate the JSONL store; filter to one branch; order by timestamp                                                                | I/O at the edge only |
| `scripts/redness.mjs` | decide red/green; derive the culprit commit range (last green → first red)                                                               | pure                 |
| `scripts/cluster.mjs` | group the red run's failures into clusters by `failure_category`, derive the owning area, derive the quarantine-or-revert recommendation | pure                 |
| `scripts/blast.mjs`   | render the markdown one-pager, the `::error` annotation, and the chat-ready block                                                        | pure                 |
| `scripts/cli.mjs`     | flags, file I/O, exit contract                                                                                                           | thin                 |

## Recommendation heuristic (explicit, because it is a judgement call)

- **revert** — every failing test in the red run falls in a _single_ owning area
  **and** the culprit range is a single commit. A narrow, attributable break.
- **quarantine** — failures span more than one owning area, or the culprit range
  holds more than one commit. Nothing is cleanly attributable, so the cheaper
  move is to isolate the failures and keep the branch moving.
- **investigate** — the red run has failures but no `area` data at all. Refusing
  to recommend on absent data is the point; a confident recommendation derived
  from nothing is the false-green shape this repo keeps tripping over.

---

### Task 1: `history.mjs` — load and filter the store

**Files:**

- Create: `agents/skills/claude-code/canary-screech/scripts/history.mjs`
- Test: `agents/skills/test/canary-screech.test.ts`

**Interfaces:**

- `loadRuns(path) -> RunRecord[]` — one JSON object per line; blank lines
  skipped; a malformed line throws with the line number; a missing file throws.
- `runsForBranch(runs, branch) -> RunRecord[]` — filtered, sorted oldest-first
  by `timestamp`.

- [ ] **Step 1: failing tests** — malformed line names its line number; blank
      lines tolerated; branch filter excludes other branches; ordering is by
      timestamp, not file order.
- [ ] **Step 2: implement.**

### Task 2: `redness.mjs` — is the branch red, and which commits are implicated

**Files:**

- Create: `agents/skills/claude-code/canary-screech/scripts/redness.mjs`

**Interfaces:**

- `assessBranch(runs) -> { state: 'red'|'green'|'abstained', latest, firstRed, lastGreen, culpritRange }`
- `state` is `abstained` on an empty run list — **not** `green`.
- `culpritRange` is
  `{ from: <last green commit sha>, to: <first red commit sha> }`, or
  `{ from: null, to }` when the store holds no green run before the break (an
  honest "unknown lower bound" rather than a fabricated one).

- [ ] **Step 1: failing tests** — green latest run ⇒ green; failed>0 ⇒ red;
      consecutive red runs walk back to the _first_ red, not the latest; no
      green predecessor ⇒ `from: null`; empty ⇒ abstained.
- [ ] **Step 2: implement.**

### Task 3: `cluster.mjs` — failure cluster, owning area, recommendation

**Files:**

- Create: `agents/skills/claude-code/canary-screech/scripts/cluster.mjs`

**Interfaces:**

- `clusterFailures(run) -> { clusters: [{category, tests[]}], areas: [{area, count}], owningArea, recommendation }`

- [ ] **Step 1: failing tests** — one area + one commit ⇒ `revert`; two areas ⇒
      `quarantine`; missing area data ⇒ `investigate`; clusters are ordered by
      size descending for a stable one-pager.
- [ ] **Step 2: implement.**

### Task 4: `blast.mjs` — render the one-pager

**Files:**

- Create: `agents/skills/claude-code/canary-screech/scripts/blast.mjs`

**Interfaces:**

- `renderBlast(assessment, cluster, branch) -> { markdown, annotations: string[], chatBlock }`
- The markdown carries all five required sections; the annotation is a single
  `::error title=Broken main::…` line; the chat block is a fenced block inside
  the markdown.

- [ ] **Step 1: failing tests** — all five sections present; annotation is one
      line and starts `::error`; a green assessment renders the green one-liner
      with no annotation.
- [ ] **Step 2: implement.**

### Task 5: `cli.mjs` — flags, artifact write, exit contract

**Files:**

- Create: `agents/skills/claude-code/canary-screech/scripts/cli.mjs`
- Create: `agents/skills/claude-code/canary-screech/SKILL.md`

- [ ] **Step 1: failing tests** — `--help` exits 0 with `usage:`; unknown flag
      exits 2; missing `--history` exits 2; abstention prints `ABSTAINED` and
      exits 0 advisory / 3 strict; red exits 0 advisory / 1 strict; `--out`
      writes the markdown file.
- [ ] **Step 2: implement**, then `chmod +x`.

### Task 6: wire the gates

**Files:**

- Edit: `harness.config.json` (**both** `entropy.entryPoints` and
  `performance.entryPoints`)
- Edit: `agents/skills/vitest.config.ts` (coverage `include`)
- Edit: `agents/skills/package.json` (`format:check` glob)
- Edit: `agents/skills/test/gate-conformance.test.ts` (register the abstention
  row)

- [ ] **Step 1:** add the entry point to both arrays;
      `ts/test/entropy-entrypoints.test.ts` enforces they stay identical.
- [ ] **Step 2:** run the four gates from `ts/`, plus the `agents/skills` suite.
