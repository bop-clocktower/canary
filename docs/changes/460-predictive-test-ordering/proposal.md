# Predictive test ordering from run history and the PR diff (#460)

**Keywords:** test-ordering, run-history, time-to-first-failure, cold-start,
diff-proximity, sequencer, shiva, abstention

> **Status: signed off 2026-09-16.** A human reviewed this proposal and accepted
> it as written, including the recommended default on every fork (F1-F8), so the
> forks are answered and a build round may proceed. The document itself is still
> spec only: it contains no code. The blocking spike findings are in
> [`spike.md`](spike.md).

## Overview

On a long suite, a regression often surfaces only when the runner happens to
reach the failing test, which can be hours in. #460 (split from #339) proposes
`canary-shiva`: use past run history plus the PR diff to run the tests most
likely to fail first, so the likely failure shows up in the first minutes.

The spike changed the shape of this work. The history schema already records
per-test results against a commit. But canary's own CI keeps **one run** of
history (the store is rebuilt from empty on every job), and `test_file` is
written with three different path bases, one of them absolute. A ranking model
built today would learn from nothing and join on nothing. So this spec delivers,
in order: history that survives between runs, a diff-joinable `test_file`, and
only then the ordering.

### Goals

1. Make history accumulate across CI runs and make `test_file` joinable to a
   diff path.
2. Produce a deterministic ranking of test files (and tests, where the runner
   allows it) from failure history and diff proximity.
3. Ordering only, never filtering: every test that would have run still runs.
4. Measure whether it helped: time-to-first-failure (TTFF) against the unordered
   baseline, with the denominator shown.

### Out of scope

- Test selection or skipping ("only run affected tests"). This is a different
  feature with different correctness risk; see the design note in #460.
- ML models or any LLM in the ranking path. The ranking must be explainable per
  test.
- Replaying a past run (#461, `canary-rewind`).
- Playwright per-test ordering. Playwright has no supported hook (spike Q4).
- Backfilling history from old CI logs.

## Decisions made

| #   | Decision              | Choice                                                                                                                                                                            | Rationale                                                                                                                         |
| --- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| D1  | First deliverable     | History-store change before any ranking code: persist history between CI runs, normalize `test_file`                                                                              | The spike's Q2 and Q3 are "no". #460 says that in that case the honest first deliverable is a store change.                       |
| D2  | Path normalization    | `record` stores `test_file` relative to the git top-level, with `/` separators; paths outside the repo keep their original value and are counted as unjoinable                    | One base for all three readers, and it matches `git diff --name-only`. Counting the unjoinable ones keeps the denominator honest. |
| D3  | Persistence (canary)  | The `fleet-health` job restores and saves the NDJSON store with the Actions cache, keyed per branch with `main` as the fallback                                                   | No new service or secret. The store is append-only, so a cache round-trip is lossless. _Assumption_; see F2.                      |
| D4  | Granularity           | Rank **files** by default; rank individual tests only for pytest                                                                                                                  | Spike Q4: vitest sequences files, Playwright can only group shards, pytest can reorder items.                                     |
| D5  | Score                 | Additive and explainable: recent failure rate (last N runs, decayed) + diff proximity (test file changed, or imports a changed file) + a small duration tiebreaker (faster first) | Each term is printable next to the test. No trained weights to go stale. Weights are _assumptions_ to tune against the D7 metric. |
| D6  | Cold start            | Fewer than 5 runs for the suite: skip the history term and rank by diff proximity only; no diff either: declaration order. Always exit 0 with the mode stated                     | #460 requires "never fail". Stating the mode stops a cold-start order from passing itself off as a learned one.                   |
| D7  | "Did it help?" metric | TTFF, both ordered and baseline, recorded per run on runs that had at least one failure; runs with no failure are counted as "not measurable", never as a win                     | #460 asks for this. A green run has no first failure, so counting it would inflate the result (the zero-denominator trap).        |
| D8  | Surface               | A `canary order` CLI subcommand that emits a ranked JSON list, plus thin runner adapters (vitest sequencer, pytest plugin). A `canary-shiva` skill wraps the CLI                  | Keeps the ranking testable without a runner, and lets a CI step use it without an agent. _Assumption_; see F1.                    |

### Approaches considered

1. **Store fix first, then an explainable file-level ranker with runner adapters
   (chosen).** Works with the data canary can actually collect. Every placement
   can be explained. The cost is two phases before any visible speed-up.
   Complexity is medium.
2. **Ranker only, reading whatever history exists.** Fastest to demo, but the
   spike shows it would run in cold-start mode for every canary run and for most
   consumers, so it could never show a benefit. Complexity is low; the value is
   near zero until history exists.
3. **Learned model (for example logistic regression on file co-change and
   failure features).** Potentially more accurate on large histories, but it
   needs far more history than anyone has, cannot explain a placement in one
   line, and adds a model artifact to version. Complexity is high.

## Technical design

Design only; nothing is built in this change.

### Phase 1: history-store changes

- **Normalization.** `record` resolves the git top-level once and rewrites each
  reader's `test_file` to a repo-relative POSIX path. Vitest's absolute path is
  made relative. Playwright's `testDir`-relative path is prefixed with the
  `testDir` taken from the report config when present. An empty or
  outside-the-repo path is kept and counted. The success line and `--json` gain
  `unjoinableTestFiles: n of m`.
- **Commit honesty.** `record` refuses to write `commit_sha: 'local'` when it is
  inside a git repo and `HEAD` resolves. It records `HEAD` instead.
- **Persistence (canary's own CI).** `fleet-health` restores
  `test-results/reports/history-v2.jsonl` from the Actions cache before `record`
  and saves it after. Local store retention stays unbounded on write; windows
  stay read-side.
- **Schema.** No new fields. Changed files are derived at query time with git
  from `commit_sha`, so `SCHEMA_VERSION` does not change.

### Phase 2: ranking core

```ts
type OrderMode = 'history+diff' | 'diff-only' | 'declaration';
interface RankedEntry {
  test_file: string;
  test_name?: string; // present only at test granularity (pytest)
  score: number;
  reasons: string[]; // e.g. "failed 3 of last 20 runs", "imports ts/src/x.ts (changed)"
}
interface OrderPlan {
  mode: OrderMode;
  modeReason: string; // e.g. "2 of 5 runs needed for history"
  historyRuns: number; // denominator for the history term
  changedFiles: number;
  entries: RankedEntry[]; // a permutation: every known test file appears exactly once
  unranked: string[]; // files in the suite with no history and no diff link, kept in declaration order after ranked ones
}
```

- **Input.** The suite name, the history store, a base ref for the diff, and the
  list of test files the runner would run (from the runner, not from history, so
  a new test file is never dropped).
- **Permutation invariant.** The output contains exactly the input file set.
  This is checked before emitting. A mismatch is a bug and exits 2.
- **Determinism.** Ties are broken by path, so the same inputs always give the
  same order.
- **Import proximity.** For JS/TS, a one-hop static import scan of each test
  file (reuse an existing canary import analysis if one fits; not verified in
  this spec). For other languages, v1 uses only "the test file itself changed".

### Phase 3: runner adapters and the metric

- **vitest:** a `Sequencer` subclass that reads the `OrderPlan` JSON and sorts
  files by it. Files missing from the plan go last in their original order.
- **pytest:** a plugin that reorders collected items with
  `pytest_collection_modifyitems`.
- **Playwright:** no adapter in v1 (F5).
- **TTFF.** `record` gains an optional `--order-plan <file>`. When set, it
  stores `order_mode` and the ordered and baseline TTFF on the run (local-only
  fields, like `reporter_format`). Baseline TTFF is estimated from declaration
  order and per-test `duration_ms`. It is an estimate, and the output says so.

### Exit codes (`canary order`)

0 plan emitted (any mode), 2 invariant violation or unreadable input, 3 no test
files given (abstained: an empty plan is not an order).

## Integration points

### Entry points

- New CLI subcommand `canary order` (`ts/src/cli/`).
- New skill `agents/skills/canary-shiva/` wrapping it.
- `canary history record` gains path normalization and `--order-plan`.
- `.github/workflows/dogfood.yml` `fleet-health` job gains a cache restore and
  save.

### Registrations required (ratchet cost)

A new CLI surface trips three CI ratchets that local gates do not catch. Budget
them in the same PR as the code, not as a follow-up:

- **Perf delta.** New modules and CLI surface add complexity identities, and the
  perf ratchet's delta rule cannot be waived with `--admin`. Expect to pay it
  down in the same PR (the #850 precedent).
- **Entropy entryPoints.** Every new `ts/src` module, and any new
  `scripts/lib/*.mjs`, must be declared in **both** `entropy.entryPoints`
  arrays. Never raise `maxFindings` instead.
- **Arch allowance.** Placing the ranker under `history/` or `analysis/` and the
  CLI under `cli/` needs the layer model checked, and likely a per-PR allowance
  plus a floor bump.
- **Dead exports.** Adapters exported only for runner config will read as dead
  exports unless declared as entry points.

### Documentation updates

- AGENTS.md history section: `test_file` is now repo-relative; the store is
  cached in `fleet-health`.
- `agents/skills/canary-shiva/SKILL.md` and the skills README.
- The BoP naming roster: `shiva` moves from reserved to used.

### Architectural decisions

- **D1 + D2** (repo-relative `test_file` as the history join key) deserve an
  ADR, because every later history consumer (#461 rewind included) will depend
  on that key.
- **D7** (TTFF counts only runs with a failure) can live in the skill doc unless
  it is promoted to a gate.

### Knowledge impact

New concepts: _order plan_, _order mode_, _time-to-first-failure_, _unjoinable
test file_. New relationship: `history record` output feeds `canary order`
input.

## Success criteria

1. **Normalization.** Recording a vitest report produced in a subdirectory of
   the repo stores `test_file` values that equal the paths `git ls-files` prints
   for those files. A JUnit report with no `file` attributes records
   `unjoinableTestFiles` equal to its test count, not 0.
2. **Persistence.** After phase 1 merges, the `fleet-health` job on `main` logs
   `read N runs` with N increasing by one per run over 3 consecutive `main`
   runs.
3. **Permutation.** For any input, `canary order` output contains each input
   test file exactly once. A property test over random file sets and histories
   passes, and a mutated ranker that drops one file fails that test.
4. **Cold start.** With an empty store and no diff, the plan's `mode` is
   `declaration`, the order equals the input order, and the exit code is 0. With
   1-4 runs, `mode` is `diff-only` and `modeReason` names the run count.
5. **Planted failure.** On a fixture suite of at least 50 files where one file
   failed in 3 of the last 10 recorded runs and is untouched by the diff, that
   file ranks in the top 5. A file changed in the diff with no failure history
   ranks above files with neither signal.
6. **Explainability.** Every ranked entry has at least one reason string, and
   entries in `unranked` have none.
7. **Did it help.** Over the first 20 recorded runs of canary's own suite that
   contain at least one failure, the median ordered TTFF is lower than the
   median baseline TTFF, and the report also prints how many runs were not
   measurable. If it is not lower, the ranker stays advisory and the finding
   goes on #460.
8. **No test lost.** On canary's own vitest suite, the ordered run reports the
   same total test count as an unordered run of the same commit.

## Implementation order

1. **Phase 1a, TDD:** repo-relative `test_file` in `record`, with
   `unjoinableTestFiles` in the output.
2. **Phase 1b:** refuse `'local'` commit inside a git repo.
3. **Phase 1c:** cache the store in `fleet-health`, then check criterion 2 on
   three `main` runs.
4. **Phase 2, TDD:** the ranking core as a pure function over records, diff and
   file list, with the permutation property test first.
5. **Phase 2b:** `canary order` CLI, paying the perf, entropy, arch and
   dead-export ratchets in the same PR.
6. **Phase 3:** the vitest sequencer adapter, dogfooded on canary's own suite;
   then the pytest plugin; then `--order-plan` TTFF recording.
7. **Phase 3b:** the `canary-shiva` skill and docs, and the ADR for D1 + D2.
8. **Evaluation:** collect criterion 7 evidence before claiming a benefit.

## Assumptions

- **A1:** vitest's `sequence.sequencer` works with canary's
  `ts/vitest.config.ts` without other config changes. Verified in phase 3's
  first task.
- **A2:** Actions cache retention (evicted after 7 days unused) is enough,
  because `fleet-health` runs on every push to `main`.
- **A3:** The 5-run cold-start threshold and the score weights are starting
  values, to be tuned against criterion 7.
- **A4:** `commit_sha` values in CI are reachable in a clone with
  `fetch-depth: 0`. Runs whose sha is not reachable contribute to the history
  term but not the diff term.
- **A5:** Consumers who want persistence set up their own (cache, artifact or
  the remote store). Canary documents the recipe but does not provision it.

## Open forks (need a human decision)

| Fork | Question                                  | Options                                                                                          | Recommended                                                                                                                                          |
| ---- | ----------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1   | Surface: CLI, skill, or both?             | (a) `canary order` CLI plus a thin skill; (b) skill with its own `cli: *.js` only; (c) CLI only  | **(a)**. A CI step must not need an agent, and the skill gives discoverability. Pays the ratchet cost once, in the CLI.                              |
| F2   | How does canary's own CI persist history? | (a) Actions cache; (b) artifact from the previous `main` run; (c) the remote Supabase store      | **(a)**. No secret, no service. (b) needs cross-run artifact lookup. (c) lacks `readAll` (spike Q3) and adds a secret dependency to a dogfood job.   |
| F3   | Split phase 1 into its own issue?         | (a) new issue for the store change, #460 keeps the ranker; (b) keep all phases under #460        | **(a)**. Phase 1 is useful without the ranker (flake reports also get real history) and should not wait on ranker sign-off.                          |
| F4   | Rank granularity for vitest               | (a) files only; (b) files, and reorder tests within a file with `sequence.shuffle`-style hooks   | **(a)**. vitest has no supported within-file order hook; hacking one risks order-dependent breakage (see `canary-savant`).                           |
| F5   | Playwright in v1?                         | (a) out; (b) shard grouping (likeliest files in shard 1)                                         | **(a)**. Shard grouping only helps parallel CI setups and needs its own TTFF definition. Revisit after criterion 7 has evidence.                     |
| F6   | Score model                               | (a) additive explainable score (D5); (b) failure history only; (c) learned model                 | **(a)**. (b) is useless at cold start, which is the common case; (c) needs history nobody has.                                                       |
| F7   | Cold-start threshold                      | (a) 5 runs; (b) 10 runs, matching `analyze flaky`; (c) no threshold, always blend                | **(a)**. Ordering is cheap to get wrong (it never drops a test), so it can use history earlier than a flake verdict can. The mode is always printed. |
| F8   | Does "did it help" ever become a gate?    | (a) advisory metric only; (b) auto-disable ordering if criterion 7 fails over 20 measurable runs | **(a)** for v1. Auto-disabling needs the same exit-criterion discipline as #485; decide after the first 20-run window exists.                        |
