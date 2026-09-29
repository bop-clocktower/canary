<!-- markdownlint-disable MD029 MD013 -->

# Plan: canary-question — evidence brief for one failing test (MVP)

**Date:** 2026-09-29 | **Spec:** docs/changes/613-canary-question/proposal.md |
**Tasks:** 12 | **Time:** ~55 min | **Integration Tier:** medium

## Goal

`canary skills run canary-question -- --test NAME` reads the run-history store
(plus an optional git diff and one optional Tier-0 detector envelope) and prints
an evidence brief for one failing test. The brief has three hypotheses in a
fixed order, each with evidence for and against, a derived fidelity label and
denominator, a Not checked list and a What would disambiguate list. It never
prints a verdict, a lean or a ranking.

## Observable Truths (Acceptance Criteria)

Each truth maps to spec success criteria SC1–SC11.

1. **SC1:** When the store has no observation of `--test`, the system shall
   print `ABSTAINED` and `observations: 0`, and exit 0.
2. **SC2:** When the test has observations but none is `failed`/`flaky`, the
   system shall abstain with `no failing observation in N observation(s)`.
3. **SC3:** While the test has fewer than 3 observations (and is not abstained),
   the system shall report fidelity `thin` and print a `THIN EVIDENCE` banner.
4. **SC4:** When one `commit_sha` shows both a pass and a failure of the test,
   the system shall list `same-commit-mixed` under all three hypotheses.
5. **SC5:** When the culprit range touched only test paths, the system shall
   list `diff-test-only` as for test-defect and against product-defect.
   `diff-sut-only` is the mirror case. Fidelity is `history+diff` once there are
   at least 3 observations.
6. **SC6:** If git cannot resolve the range, then the system shall not claim a
   diff was read. It lists `git diff` under Not checked with the reason, and
   fidelity stays `history`/`thin`.
7. **SC7:** When a Tier-0 finding's `file` matches the target's `test_file`, the
   system shall list `detector-finding` (quoting `rule_id` and line) as
   test-defect evidence. Findings on other files are ignored.
8. **SC8:** The system shall emit `hypotheses` in the order `test-defect`,
   `product-defect`, `environment`. This holds for fixtures favouring each side.
9. **SC9:** If any fixture is rendered, then neither the markdown nor the JSON
   shall contain `verdict`, `root cause`, `is flaky`, `test bug`, `product bug`,
   `likely`, `probably` or `most likely`. The JSON shall have no key `verdict`,
   `disposition` or `score` at any depth.
10. **SC10:** The system shall exit 0 for every produced brief (including
    abstention), 1 for a named-but-missing or malformed `--history`/`--findings`
    or an unwritable `--out`, and 2 for usage errors. `--help` exits 0.
11. **SC11:** `skill-cli-conformance.test.ts`, `ts/test/skill-examples.test.ts`,
    `ts/test/bop-name-registry.test.ts` and
    `ts/test/entropy-entrypoints.test.ts` pass. The four gates from `ts/` and
    the three from `agents/skills/` stay green, and the entropy and perf
    ratchets do not regress.

## Uncertainties

- [RESOLVED] **Banner vs D11.** The spec's original banner contained the
  forbidden word `verdict`; the orchestrator reworded it (spec + plan) to
  `Evidence brief — hypotheses and evidence, no call made`, so the guard scans
  every byte with no exemption.
- [ASSUMPTION] **`--history` default.** It defaults to
  `test-results/reports/history-v2.jsonl`. A _default_ path that is missing is a
  dark source: the brief abstains and lists `run history` under Not checked. A
  _named_ path that is missing exits 1. This follows the canary-signal ledger
  precedent (`canary-signal/scripts/sources.mjs` `loadLedger`), and it is why
  `--history` has no CLI_SPEC default.
- [ASSUMPTION] **Schema guard.** Rows are refused unless `schema_version` is 2
  or 3, or absent (read as 2). This mirrors `ts/src/history/record.ts:22` and
  `canary-signal/scripts/sources.mjs:27`. It goes beyond "same strictness as
  screech", in the refusing direction only.
- [ASSUMPTION] **Skipped observations.** Status `skipped` (or any status other
  than passed/failed/flaky) is not an observation. The count goes under Not
  checked (`skipped observations`) so nothing is dropped silently.
- [ASSUMPTION] **Neutral rows.** A row with empty `supports` and `weighsAgainst`
  (`category-neutral`) would render nowhere under "place a row under every
  hypothesis it names". It goes in an additive `neutral` JSON array and a
  markdown section `Recorded, does not discriminate`.
- [ASSUMPTION] **Diff partition.** A changed path is on the test side when it
  matches the target's `test_file` or is test-like (`isTestPath`). Every other
  path is on the SUT side. `detail` says whether the target's own test file
  changed, or that `test_file` was not recorded.
- [ASSUMPTION] **Co-failure.** Two failures are related only if they share a
  non-null `area` or the same resolved category other than `other` (an
  uncategorised pair is not a shared cause). Other failures that share neither
  produce no row, because the spec defines none.
- [ASSUMPTION] **Findings rule label.** The label is `rule_id`, falling back to
  `kind` (the katana `findings` rows carry `kind`, per
  `canary-katana/SKILL.md:204-213`), then `unnamed rule`. The detector's
  `snippet`/`why` text is never echoed, because it is free text the guard cannot
  vouch for.
- [ASSUMPTION] **Commit shas.** They are validated as hex object ids
  (`/^[0-9a-f]{4,64}$/i`) before they reach `git`. A store value such as
  `--output=x` would otherwise be read as a git option (argument injection). An
  invalid sha goes under Not checked.
- [ASSUMPTION] **`--out` / `--json`.** `--out` writes exactly what was printed
  (markdown, or JSON under `--json`). An unwritable `--out` exits 1, as in
  screech and signal.
- [ASSUMPTION] **No gate-conformance row.**
  `agents/skills/test/gate-conformance.test.ts` rows require a `--strict` mode
  that exits 3. D10 forbids `--strict`, so canary-question is not added there.
  Loud abstention is asserted in `canary-question.test.ts` (SC1/SC2) instead.
  See concerns.
- [DEFERRABLE] The exact prose of `detail` strings and disambiguation steps (the
  SC9 guard constrains it).
- [DEFERRABLE] F1–F6 in the spec (lean, LLM step, diagnostics input, running
  detectors, flip rate, multi-test triage).

## Skill recommendations

No `docs/changes/613-canary-question/SKILLS.md` exists. Run
`harness advise-skills --spec-path docs/changes/613-canary-question/proposal.md`
if you want skill annotations. None are applied below.

## Evidence (patterns this plan copies)

- CLI shape, `writeArtifact`, `process.exitCode`:
  `agents/skills/claude-code/canary-screech/scripts/cli.mjs:56-128`
- Strict JSONL loader + schema guard:
  `agents/skills/claude-code/canary-signal/scripts/sources.mjs:20-73`
- Dark-default vs explicit-missing optional input:
  `agents/skills/claude-code/canary-signal/scripts/sources.mjs:100-117`
- Categorisation rules to copy verbatim (no cross-skill import):
  `agents/skills/claude-code/canary-fail-fast/scripts/failures.mjs:30-60`
- Record shape: `ts/src/history/record.ts:51-95`
- Shared parser: `agents/skills/lib/parse-args.mjs:249` (`createParser`), `:28`
  (`EXIT_USAGE`), `:40` (`formatUsageError`)
- Tier-0 envelope `{schema_version, findings:[{file,line,rule_id,...}]}`:
  `agents/skills/claude-code/canary-savant/SKILL.md:211-233`
- `bop-name-registry.test.ts:220-240`: a skill directory on disk must be
  `shipped` in `docs/naming-registry.md`. **The registry flip lands in Task 1**,
  the same commit that creates the directory.
- `entropy-entrypoints.test.ts:133,164`: every entry point must be git-tracked
  and the two arrays must stay in lockstep. **The registration lands in Task 10,
  after `cli.mjs` is committed in Task 8.**
- Example classifier `ts/src/core/skill-examples.ts:62,249-272`: only
  help-shaped commands run, and a block containing `\`/`<`/`|` is unverifiable
  on its own.

## File Map

```text
CREATE agents/skills/claude-code/canary-question/scripts/history.mjs
CREATE agents/skills/claude-code/canary-question/scripts/signals.mjs
CREATE agents/skills/claude-code/canary-question/scripts/diff.mjs
CREATE agents/skills/claude-code/canary-question/scripts/findings.mjs
CREATE agents/skills/claude-code/canary-question/scripts/brief.mjs
CREATE agents/skills/claude-code/canary-question/scripts/cli.mjs   (mode 0755)
CREATE agents/skills/claude-code/canary-question/SKILL.md
CREATE agents/skills/test/canary-question.test.ts
CREATE docs/knowledge/gates/evidence-brief.md
MODIFY docs/naming-registry.md            (canary-question reserved -> shipped)
MODIFY harness.config.json                (entropy.entryPoints + performance.entryPoints)
MODIFY agents/skills/package.json         (format:check glob)
MODIFY agents/skills/vitest.config.ts     (coverage include)
MODIFY agents/skills/README.md            (tree, bundled list, Programmatic list)
MODIFY docs/roadmap.md                    (canary-question row: status + plan)
MODIFY CHANGELOG.md                       (Unreleased / Added)
```

## Skeleton

1. Timeline reader + abstention inputs (~1 task, ~5 min)
2. Pure signals: history, category, co-failure, paths (~2 tasks, ~10 min)
3. Optional evidence readers: git diff, detector findings (~2 tasks, ~9 min)
4. Brief assembly, renderers, forbidden-language guard (~2 tasks, ~10 min)
5. CLI entry point + SKILL.md (~2 tasks, ~9 min)
6. Registrations, docs, knowledge, gates (~3 tasks, ~12 min)

**Estimated total:** 12 tasks, ~55 minutes. _Skeleton approved: not presented
for interactive approval. This is an autonomous fleet lane and the caller
directed a direct write. Flagged in the handoff concerns._

## Conventions for every task

- Work only in `/Users/bs/Github/canary-fleet-613-canary-question` on branch
  `feat/613-canary-question`.
- Run test commands from `agents/skills/`:
  `cd /Users/bs/Github/canary-fleet-613-canary-question/agents/skills && npx vitest run test/canary-question.test.ts`.
- Before each commit, run `npx prettier --write <changed files>` (from the
  worktree root, using `agents/skills/node_modules/.bin/prettier`, or
  `npx prettier` from `agents/skills/`).
- Keep every function small. The perf ratchet has no delta escape: a new
  complexity violation turns CI red (memory: perf-ratchet-delta-has-no-escape).
  Put decisions in helpers or lookup tables, as the code below does.
- The test file grows task by task. Each task **appends** its `import` lines to
  the import block at the top of the file and appends its `describe` blocks to
  the end.
- Never use `--no-verify`. Commit messages use Conventional Commits with no
  co-author trailer.

---

## Tasks

### Task 1: Timeline reader (history.mjs) + registry flip

**Depends on:** none | **Files:**
`agents/skills/claude-code/canary-question/scripts/history.mjs`,
`agents/skills/test/canary-question.test.ts`, `docs/naming-registry.md`

1. Create `agents/skills/test/canary-question.test.ts`:

```ts
/**
 * canary-question (#613) -- an evidence brief for one failing test. Cases are
 * tagged with the spec's success criteria (SC1-SC11,
 * docs/changes/613-canary-question/proposal.md). Fixtures are synthetic and
 * de-identified; nothing here is copied from a real store.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_HISTORY,
  buildTimeline,
  loadRuns,
  readStore,
  selectTarget,
} from '../claude-code/canary-question/scripts/history.mjs';

const tmps: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-question-'));
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

/** The test under question in every fixture. */
const T = 'checkout adds the item';
const TEST_FILE = 'test/cart.test.js';

function entry(status: string, over: Run = {}): Run {
  return { test_name: T, status, test_file: TEST_FILE, area: 'cart', ...over };
}

/**
 * One RunRecord (ts/src/history/record.ts) per status, oldest first. Each run
 * has its own hex commit sha and a strictly increasing timestamp; `over(i)`
 * overrides fields of run i.
 */
function series(statuses: string[], over: (i: number) => Run = () => ({})) {
  return statuses.map((status, i) => ({
    schema_version: 3,
    run_id: `r${i + 1}`,
    suite: 'unit',
    branch: 'main',
    commit_sha: `abc${i + 1}0`,
    timestamp: `2026-09-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    tests: [entry(status)],
    ...over(i),
  }));
}

function writeStore(dir: string, runs: Run[]): string {
  const file = path.join(dir, 'history-v2.jsonl');
  const body = runs.map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(file, body ? `${body}\n` : '', 'utf8');
  return file;
}

const timelineOf = (runs: Run[], suite: string | null = null) =>
  buildTimeline(runs, { test: T, suite });

describe('history: reading the store (D9)', () => {
  it('refuses a missing store rather than reading it as empty', () => {
    const file = path.join(tmp(), 'absent.jsonl');
    expect(() => loadRuns(file)).toThrow(/history store not found/);
  });

  it('names the malformed line', () => {
    const file = path.join(tmp(), 'h.jsonl');
    fs.writeFileSync(file, `${JSON.stringify(series(['passed'])[0])}\n{no\n`);
    expect(() => loadRuns(file)).toThrow(/line 2/);
  });

  it('refuses a schema_version it does not understand', () => {
    const file = writeStore(tmp(), [
      { ...series(['passed'])[0], schema_version: 9 },
    ]);
    expect(() => loadRuns(file)).toThrow(/unsupported schema_version 9/);
  });

  it('refuses a non-object row and a non-array tests field', () => {
    const a = path.join(tmp(), 'a.jsonl');
    fs.writeFileSync(a, '[1]\n');
    expect(() => loadRuns(a)).toThrow(/not an object/);
    const b = writeStore(tmp(), [{ run_id: 'x', suite: 'u', tests: 'no' }]);
    expect(() => loadRuns(b)).toThrow(/tests is not an array/);
  });

  it('reads a legacy unstamped row as v2 and skips blank lines', () => {
    const file = path.join(tmp(), 'h.jsonl');
    const row = { ...series(['passed'])[0] } as Run;
    delete row.schema_version;
    fs.writeFileSync(file, `\n${JSON.stringify(row)}\n\n`);
    expect(loadRuns(file)).toHaveLength(1);
  });

  it('treats a missing DEFAULT store as a dark source, not an error', () => {
    const res = readStore(path.join(tmp(), 'absent.jsonl'), false);
    expect(res.runs).toEqual([]);
    expect(res.dark).toMatch(/no history store at/);
  });

  it('treats a missing NAMED store as an error', () => {
    const file = path.join(tmp(), 'absent.jsonl');
    expect(() => readStore(file, true)).toThrow(/history store not found/);
  });

  it('reads a present store with no dark reason', () => {
    const file = writeStore(tmp(), series(['passed']));
    expect(readStore(file, true)).toEqual({
      runs: series(['passed']),
      dark: null,
    });
  });

  it('defaults to the store the engine writes', () => {
    expect(DEFAULT_HISTORY).toBe('test-results/reports/history-v2.jsonl');
  });
});

describe('history: one test timeline', () => {
  it('orders by timestamp, not file order', () => {
    const tl = timelineOf(series(['passed', 'failed']).reverse());
    expect(tl.observations.map((o: Run) => o.status)).toEqual([
      'passed',
      'failed',
    ]);
    expect(tl.runsInStore).toBe(2);
  });

  it('ignores runs without the test and count-only runs', () => {
    const runs = [
      ...series(['passed']),
      { run_id: 'x', suite: 'unit', timestamp: '2026-09-20T00:00:00Z' },
      {
        ...series(['failed'])[0],
        tests: [{ test_name: 'other', status: 'failed' }],
      },
    ];
    const tl = timelineOf(runs);
    expect(tl.observations).toHaveLength(1);
    expect(tl.runsInStore).toBe(3);
  });

  it('counts skipped observations instead of dropping them silently', () => {
    const tl = timelineOf(series(['passed', 'skipped', 'failed']));
    expect(tl.observations).toHaveLength(2);
    expect(tl.skipped).toBe(1);
  });

  it('lists every suite the name occurs in, and narrows with a suite', () => {
    const runs = series(['passed', 'failed'], (i) =>
      i === 0 ? { suite: 'e2e' } : {},
    );
    expect(timelineOf(runs).suites).toEqual(['e2e', 'unit']);
    const narrowed = timelineOf(runs, 'unit');
    expect(narrowed.observations).toHaveLength(1);
    expect(narrowed.suites).toEqual(['unit']);
  });

  it('prefers the per-test suite over the run suite', () => {
    const runs = series(['failed'], () => ({
      tests: [entry('failed', { suite: 'api' })],
    }));
    expect(timelineOf(runs).observations[0].suite).toBe('api');
  });

  it('carries the other failing tests of the run as co-failures', () => {
    const runs = series(['failed'], () => ({
      tests: [
        entry('failed'),
        { test_name: 'b', status: 'failed', area: 'cart' },
        { test_name: 'c', status: 'passed' },
      ],
    }));
    const [obs] = timelineOf(runs).observations;
    expect(obs.coFailures.map((c: Run) => c.test_name)).toEqual(['b']);
    expect(obs.retry_count).toBe(0);
    expect(obs.test_file).toBe(TEST_FILE);
  });
});

describe('history: target failure and last pass', () => {
  it('picks the most recent failing observation and the pass before it', () => {
    const tl = timelineOf(series(['passed', 'failed', 'passed', 'flaky']));
    const { target, lastPass } = selectTarget(tl.observations);
    expect(target.run_id).toBe('r4');
    expect(lastPass.run_id).toBe('r3');
  });

  it('returns no target when nothing failed', () => {
    const tl = timelineOf(series(['passed', 'passed']));
    expect(selectTarget(tl.observations)).toEqual({
      target: null,
      lastPass: null,
    });
  });

  it('returns no last pass when the test never passed before the target', () => {
    const tl = timelineOf(series(['failed', 'failed']));
    const { target, lastPass } = selectTarget(tl.observations);
    expect(target.run_id).toBe('r2');
    expect(lastPass).toBeNull();
  });
});
```

2. Run
   `cd /Users/bs/Github/canary-fleet-613-canary-question/agents/skills && npx vitest run test/canary-question.test.ts`.
   Expect a failure on the import (module not found).
3. Create `agents/skills/claude-code/canary-question/scripts/history.mjs`:

```js
// history -- read the run-history store and build one test's timeline.
//
// The store is `test-results/reports/history-v2.jsonl`: one RunRecord per line
// (ts/src/history/record.ts). This module and the two optional readers
// (diff.mjs, findings.mjs) are the only parts of canary-question that do I/O.
//
// A NAMED store that is missing is an error: returning [] would be
// byte-identical to an empty store, and a typo would print a plausible
// abstention. The DEFAULT path being absent is different -- nobody asked for
// it, so it is a dark source the brief names under "Not checked" (spec D9).

import fs from 'node:fs';

/** Where `canary history record` writes, relative to the working directory. */
export const DEFAULT_HISTORY = 'test-results/reports/history-v2.jsonl';

/** Mirrors SUPPORTED_SCHEMA_VERSIONS in ts/src/history/record.ts. */
const SUPPORTED_SCHEMA_VERSIONS = [2, 3];

/** Statuses that count as a failing observation (a flaky pass failed first). */
export const FAILING = new Set(['failed', 'flaky']);

/** Statuses that are evidence at all; anything else (skipped) is counted. */
const OBSERVED = new Set(['passed', 'failed', 'flaky']);

const isPlainObject = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

function recordProblem(record) {
  if (!isPlainObject(record)) return 'not an object';
  const version = record.schema_version ?? 2;
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(version)) {
    return `unsupported schema_version ${JSON.stringify(version)}`;
  }
  if (record.tests !== undefined && !Array.isArray(record.tests)) {
    return 'tests is not an array';
  }
  return null;
}

function parseRecord(line, lineNo) {
  let record;
  try {
    record = JSON.parse(line);
  } catch (exc) {
    throw new Error(
      `malformed history record at line ${lineNo}: ${exc.message}`,
    );
  }
  const problem = recordProblem(record);
  if (problem) {
    throw new Error(`malformed history record at line ${lineNo}: ${problem}`);
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

/**
 * @param {string} file store path
 * @param {boolean} explicit true when the caller passed --history
 * @returns {{runs: object[], dark: string|null}}
 */
export function readStore(file, explicit) {
  if (fs.existsSync(file) || explicit) {
    return { runs: loadRuns(file), dark: null };
  }
  return { runs: [], dark: `no history store at ${file}` };
}

const testsOf = (run) => (Array.isArray(run.tests) ? run.tests : []);

function entryFor(run, test, suite) {
  return (
    testsOf(run).find(
      (t) =>
        isPlainObject(t) &&
        t.test_name === test &&
        (suite === null || (t.suite ?? run.suite) === suite),
    ) ?? null
  );
}

function coFailuresOf(run, entry) {
  return testsOf(run)
    .filter((t) => isPlainObject(t) && t !== entry && FAILING.has(t.status))
    .map((t) => ({
      test_name: t.test_name,
      area: t.area ?? null,
      failure_category: t.failure_category ?? null,
      error_text: t.error_text ?? null,
    }));
}

function toObservation(run, entry) {
  return {
    run_id: run.run_id ?? null,
    suite: entry.suite ?? run.suite ?? null,
    commit_sha: run.commit_sha ?? null,
    timestamp: run.timestamp ?? null,
    branch: run.branch ?? null,
    status: entry.status,
    failure_category: entry.failure_category ?? null,
    error_text: entry.error_text ?? null,
    retry_count: entry.retry_count ?? 0,
    test_file: entry.test_file ?? null,
    area: entry.area ?? null,
    coFailures: coFailuresOf(run, entry),
  };
}

// Timestamp order, not file order: several suites append concurrently, so
// file order is not chronology (same rule as canary-screech/history.mjs).
const byTimestamp = (a, b) =>
  String(a.timestamp ?? '').localeCompare(String(b.timestamp ?? ''));

/**
 * One observation per run containing the test, oldest first.
 *
 * @param {object[]} runs
 * @param {{test: string, suite: string|null}} query
 * @returns {{observations: object[], skipped: number, suites: string[], runsInStore: number}}
 */
export function buildTimeline(runs, { test, suite = null }) {
  const observations = [];
  let skipped = 0;
  for (const run of runs) {
    const entry = entryFor(run, test, suite);
    if (!entry) continue;
    const obs = toObservation(run, entry);
    if (OBSERVED.has(obs.status)) observations.push(obs);
    else skipped += 1;
  }
  observations.sort(byTimestamp);
  const suites = [...new Set(observations.map((o) => String(o.suite)))];
  return {
    observations,
    skipped,
    suites: suites.sort(),
    runsInStore: runs.length,
  };
}

/**
 * The target failure is the most recent failing observation; the last pass is
 * the most recent `passed` observation before it (the culprit range start).
 */
export function selectTarget(observations) {
  const at = observations.findLastIndex((o) => FAILING.has(o.status));
  if (at === -1) return { target: null, lastPass: null };
  const lastPass =
    observations.slice(0, at).findLast((o) => o.status === 'passed') ?? null;
  return { target: observations[at], lastPass };
}
```

4. Edit `docs/naming-registry.md`. Replace

   `| \`canary-question\` | reserved | 613 | Test-bug vs product-bug triage |`

   with

   `| \`canary-question\` | shipped | 613 | Test-defect vs product-defect
   evidence brief (never a verdict) |`

   The test flips here because `ts/test/bop-name-registry.test.ts` requires any
   skill directory on disk to be `shipped`. Keep the column widths aligned;
   `prettier --write` re-pads the table.

5. Run the test command again. Expect every case to pass.
6. `npx prettier --write` the three files, then run `harness validate`.
7. Commit:
   `feat(question): run-history timeline reader for canary-question (#613)`

### Task 2: History-derived signals (same-commit-mixed, retry-pass, regression-shape)

**Depends on:** Task 1 | **Files:**
`agents/skills/claude-code/canary-question/scripts/signals.mjs`,
`agents/skills/test/canary-question.test.ts`

1. Append to the test file's imports:

```ts
import {
  HYPOTHESES,
  historySignals,
} from '../claude-code/canary-question/scripts/signals.mjs';
```

Append to the end of the test file:

```ts
function signalsFor(statuses: string[], over?: (i: number) => Run) {
  const obs = timelineOf(series(statuses, over)).observations;
  const { target } = selectTarget(obs);
  return historySignals(obs, target);
}
const bySignal = (rows: Run[], name: string) =>
  rows.find((r) => r.signal === name) as Run | undefined;

describe('signals: history (D7, D8)', () => {
  it('keeps the three hypotheses in one fixed order (D1)', () => {
    expect(HYPOTHESES).toEqual([
      'test-defect',
      'product-defect',
      'environment',
    ]);
  });

  it('SC4: a pass and a failure at one commit support all three', () => {
    const rows = signalsFor(['passed', 'failed'], () => ({
      commit_sha: 'abc1230',
    }));
    const row = bySignal(rows, 'same-commit-mixed')!;
    expect(row.supports).toEqual(HYPOTHESES);
    expect(row.weighsAgainst).toEqual([]);
    expect(row.detail).toContain('abc1230');
    expect(row.source).toBe('run history');
  });

  it('no same-commit-mixed across distinct or missing commits', () => {
    expect(
      bySignal(signalsFor(['passed', 'failed']), 'same-commit-mixed'),
    ).toBeUndefined();
    const noSha = signalsFor(['passed', 'failed'], () => ({
      commit_sha: null,
    }));
    expect(bySignal(noSha, 'same-commit-mixed')).toBeUndefined();
  });

  it('D8: a flaky target is listed under all three, not as a test defect', () => {
    const row = bySignal(signalsFor(['passed', 'flaky']), 'retry-pass')!;
    expect(row.supports).toEqual(HYPOTHESES);
    expect(row.detail).toMatch(/1 observation\(s\) with status flaky/);
  });

  it('retry-pass fires for a pass that needed a retry', () => {
    const rows = signalsFor(['passed', 'failed'], (i) =>
      i === 0 ? { tests: [entry('passed', { retry_count: 2 })] } : {},
    );
    expect(bySignal(rows, 'retry-pass')!.detail).toMatch(
      /1 pass\(es\) after a retry/,
    );
  });

  it('no retry-pass without a flaky status or a retried pass', () => {
    expect(
      bySignal(signalsFor(['passed', 'failed']), 'retry-pass'),
    ).toBeUndefined();
  });

  it('regression-shape: a pass, then >=2 failures on distinct commits', () => {
    const row = bySignal(
      signalsFor(['passed', 'failed', 'failed']),
      'regression-shape',
    )!;
    expect(row.supports).toEqual(['test-defect', 'product-defect']);
    expect(row.weighsAgainst).toEqual(['environment']);
    expect(row.detail).toContain('abc10');
  });

  it.each([
    ['one failure', ['passed', 'failed'], undefined],
    ['no prior pass', ['failed', 'failed'], undefined],
    ['a pass since', ['passed', 'failed', 'failed', 'passed'], undefined],
    [
      'one commit only',
      ['passed', 'failed', 'failed'],
      (i: number) => (i > 0 ? { commit_sha: 'abc9990' } : {}),
    ],
  ])('no regression-shape with %s', (_n, statuses, over) => {
    expect(
      bySignal(signalsFor(statuses as string[], over), 'regression-shape'),
    ).toBeUndefined();
  });
});
```

Note: "a pass since" has no failing observation after the last pass, so
`selectTarget` returns the r3 failure. `historySignals` must still return no
regression-shape, because the last observation is not the target.

2. Run the test command and expect a failure on the import.
3. Create `agents/skills/claude-code/canary-question/scripts/signals.mjs`:

```js
// signals -- pure: a timeline (plus run context) in, evidence rows out.
//
// Every row names its source and the hypotheses it bears on. A signal that
// cannot tell the hypotheses apart says so by supporting ALL of them (D8):
// nondeterminism is what a product race looks like too, so it is never
// evidence for the test alone. Nothing here ranks, scores, or counts rows per
// hypothesis -- the brief's layout is fixed (D1).

/** Fixed order. Never sort this by evidence. */
export const HYPOTHESES = ['test-defect', 'product-defect', 'environment'];

const FAILING = new Set(['failed', 'flaky']);
const isFailing = (o) => FAILING.has(o.status);

/** One evidence row. */
export function row(signal, source, detail, supports = [], weighsAgainst = []) {
  return {
    signal,
    source,
    detail,
    supports: [...supports],
    weighsAgainst: [...weighsAgainst],
  };
}

const HISTORY = 'run history';

function mixedCommits(observations) {
  const outcomes = new Map();
  for (const o of observations) {
    if (!o.commit_sha) continue;
    const seen = outcomes.get(o.commit_sha) ?? new Set();
    seen.add(isFailing(o));
    outcomes.set(o.commit_sha, seen);
  }
  return [...outcomes].filter(([, s]) => s.size === 2).map(([sha]) => sha);
}

function sameCommitMixed(observations) {
  const mixed = mixedCommits(observations);
  if (!mixed.length) return [];
  const detail =
    `passed and failed at the same commit (${mixed.join(', ')}); a ` +
    'nondeterministic outcome is consistent with every hypothesis, ' +
    'including a race in the system under test';
  return [row('same-commit-mixed', HISTORY, detail, HYPOTHESES)];
}

function retryPass(observations) {
  const flaky = observations.filter((o) => o.status === 'flaky').length;
  const retried = observations.filter(
    (o) => o.status === 'passed' && o.retry_count > 0,
  ).length;
  if (flaky + retried === 0) return [];
  const detail =
    `${flaky} observation(s) with status flaky, ${retried} pass(es) after a ` +
    'retry; a pass on retry does not say which side is nondeterministic';
  return [row('retry-pass', HISTORY, detail, HYPOTHESES)];
}

function regressionShape(observations, target) {
  if (observations.at(-1) !== target) return [];
  const passAt = observations.findLastIndex((o) => o.status === 'passed');
  if (passAt === -1) return [];
  const streak = observations.slice(passAt + 1);
  const commits = new Set(streak.map((o) => o.commit_sha).filter(Boolean));
  if (streak.length < 2 || commits.size < 2) return [];
  const since = observations[passAt].commit_sha ?? 'an unrecorded commit';
  const detail =
    `passed at ${since}, then failed on ${streak.length} consecutive ` +
    `observations across ${commits.size} commits with no pass since`;
  return [
    row(
      'regression-shape',
      HISTORY,
      detail,
      ['test-defect', 'product-defect'],
      ['environment'],
    ),
  ];
}

/** Rows derived from the timeline alone. */
export function historySignals(observations, target) {
  return [
    ...sameCommitMixed(observations),
    ...retryPass(observations),
    ...regressionShape(observations, target),
  ];
}
```

4. Run the test command and expect every case to pass.
5. `npx prettier --write` both files, then run `harness validate`.
6. Commit: `feat(question): history-derived evidence signals (#613)`

### Task 3: Category, co-failure and path signals

**Depends on:** Task 2 | **Files:**
`agents/skills/claude-code/canary-question/scripts/signals.mjs`,
`agents/skills/test/canary-question.test.ts`

1. Extend the Task 2 import from `signals.mjs` to also import
   `categorizeFailure, categoryRows, coFailureRows, isTestPath, resolveCategory, samePath`.
   Append:

```ts
describe('signals: failure category (D2, D7)', () => {
  it('categorises exactly like canary-fail-fast', () => {
    expect(categorizeFailure('connect ECONNREFUSED 127.0.0.1')).toBe('network');
    expect(categorizeFailure('Timed out after 5000ms')).toBe('timeout');
    expect(categorizeFailure('503 Service Unavailable')).toBe('server');
    expect(categorizeFailure('ZodError: invalid_type')).toBe('schema');
    expect(categorizeFailure('401 Unauthorized')).toBe('auth');
    expect(categorizeFailure('404 not found')).toBe('client');
    expect(categorizeFailure('expected 2 to equal 3')).toBe('other');
    expect(categorizeFailure(null)).toBe('other');
  });

  it('prefers the stored category and names where it came from', () => {
    expect(
      resolveCategory({ failure_category: 'server', error_text: 'timeout' }),
    ).toEqual({ category: 'server', source: 'stored failure_category' });
    expect(
      resolveCategory({ failure_category: null, error_text: 'ETIMEDOUT' }),
    ).toEqual({ category: 'timeout', source: 'categorised from error_text' });
    expect(
      resolveCategory({ failure_category: null, error_text: null }),
    ).toBeNull();
  });

  it.each(['timeout', 'network', 'auth'])('%s is environment evidence', (c) => {
    const [r] = categoryRows({ failure_category: c });
    expect(r.signal).toBe('category-env');
    expect(r.supports).toEqual(['environment']);
  });

  it('server (5xx) is product-defect evidence', () => {
    const [r] = categoryRows({ failure_category: 'server' });
    expect(r.signal).toBe('category-server');
    expect(r.supports).toEqual(['product-defect']);
  });

  it('any other category is recorded as not discriminating', () => {
    const [r] = categoryRows({ failure_category: 'client' });
    expect(r.signal).toBe('category-neutral');
    expect(r.supports).toEqual([]);
    expect(r.weighsAgainst).toEqual([]);
  });

  it('no category row when there is nothing to categorise', () => {
    expect(categoryRows({ failure_category: null, error_text: null })).toEqual(
      [],
    );
  });
});

describe('signals: co-failures in the target run', () => {
  const target = (coFailures: Run[], over: Run = {}) => ({
    run_id: 'r9',
    area: 'cart',
    failure_category: 'timeout',
    error_text: null,
    coFailures,
    ...over,
  });

  it('isolated: the only failure supports test-defect, weighs against env', () => {
    const [r] = coFailureRows(target([]));
    expect(r.signal).toBe('isolated');
    expect(r.supports).toEqual(['test-defect']);
    expect(r.weighsAgainst).toEqual(['environment']);
  });

  it('co-failure when another failure shares the area', () => {
    const [r] = coFailureRows(
      target([{ test_name: 'b', area: 'cart', failure_category: 'schema' }]),
    );
    expect(r.signal).toBe('co-failure');
    expect(r.supports).toEqual(['product-defect', 'environment']);
    expect(r.weighsAgainst).toEqual(['test-defect']);
    expect(r.detail).toContain('b');
  });

  it('co-failure when another failure shares the category', () => {
    const rows = coFailureRows(
      target([{ test_name: 'c', area: 'billing', error_text: 'ETIMEDOUT' }]),
    );
    expect(rows[0].signal).toBe('co-failure');
  });

  it('an uncategorised pair is not a shared cause', () => {
    const rows = coFailureRows(
      target([{ test_name: 'd', area: null, failure_category: 'other' }], {
        area: null,
        failure_category: 'other',
      }),
    );
    expect(rows).toEqual([]);
  });

  it('no row when other failures share neither area nor category', () => {
    const rows = coFailureRows(
      target([{ test_name: 'e', area: 'billing', failure_category: 'schema' }]),
    );
    expect(rows).toEqual([]);
  });
});

describe('signals: test paths', () => {
  it.each([
    ['src/cart.test.ts', true],
    ['web/cart.spec.js', true],
    ['pkg/test_cart.py', true],
    ['pkg/cart_test.py', true],
    ['svc/cart_test.go', true],
    ['test/helpers.js', true],
    ['a/tests/fixture.json', true],
    ['a/__tests__/x.js', true],
    ['src/cart.ts', false],
    ['src/testing/cart.ts', false],
  ])('isTestPath(%s) is %s', (p, want) => {
    expect(isTestPath(p)).toBe(want);
  });

  it('matches paths on a segment boundary, ignoring ./ and backslashes', () => {
    expect(samePath('./test/a.test.js', 'repo/test/a.test.js')).toBe(true);
    expect(samePath('test\\a.test.js', 'test/a.test.js')).toBe(true);
    expect(samePath('test/a.test.js', 'test/ba.test.js')).toBe(false);
  });
});
```

2. Run the test command and expect a failure (the new exports are missing).
3. Append to `signals.mjs`. The `RULES` table and `categorizeFailure` are copied
   verbatim from `canary-fail-fast/scripts/failures.mjs:30-60`:

```js
// ---------------------------------------------------------------------------
// Failure category. RULES + categorizeFailure are COPIED from
// canary-fail-fast/scripts/failures.mjs (behaviour-for-behaviour): skills are
// self-contained and never import each other. Keep the two in sync by hand.
const RULES = [
  [
    'schema',
    /ZodError|invalid[_ ]type|unrecognized key|expected .+ received|at path "|\bzod\b/i,
  ],
  [
    'auth',
    /\b401\b|unauthorized|\b403\b|forbidden|invalid(?: auth)? token|token expired/i,
  ],
  ['timeout', /timeout|timed out|etimedout|deadline exceeded/i],
  [
    'network',
    /econnrefused|enotfound|econnreset|socket hang up|getaddrinfo|network request failed/i,
  ],
  [
    'server',
    /\b5\d{2}\b|internal server error|bad gateway|service unavailable|gateway timeout/i,
  ],
  [
    'client',
    /\b4(?:0[045-9]|1\d|2\d)\b|bad request|not found|unprocessable|conflict/i,
  ],
];

/** Return the category of a failure error message ('other' when unknown). */
export function categorizeFailure(error) {
  if (!error) return 'other';
  for (const [category, pattern] of RULES) {
    if (pattern.test(error)) return category;
  }
  return 'other';
}

/** The stored category, else one derived from error_text, else null. */
export function resolveCategory(obs) {
  if (obs.failure_category) {
    return {
      category: obs.failure_category,
      source: 'stored failure_category',
    };
  }
  if (obs.error_text) {
    return {
      category: categorizeFailure(obs.error_text),
      source: 'categorised from error_text',
    };
  }
  return null;
}

const ENV_CATEGORIES = new Set(['timeout', 'network', 'auth']);

export function categoryRows(target) {
  const resolved = resolveCategory(target);
  if (!resolved) return [];
  const { category, source } = resolved;
  if (ENV_CATEGORIES.has(category)) {
    return [
      row('category-env', source, `failure category ${category}`, [
        'environment',
      ]),
    ];
  }
  if (category === 'server') {
    return [
      row('category-server', source, 'failure category server (5xx)', [
        'product-defect',
      ]),
    ];
  }
  const detail = `failure category ${category} does not discriminate between the hypotheses`;
  return [row('category-neutral', source, detail)];
}

// ---------------------------------------------------------------------------
// Co-failures: other tests that failed in the target run.

/** A category shared only as "other" is not a shared cause. */
function sharesCategory(a, b) {
  const ca = resolveCategory(a)?.category ?? null;
  const cb = resolveCategory(b)?.category ?? null;
  return ca !== null && ca !== 'other' && ca === cb;
}

const sharesArea = (a, b) => a.area != null && a.area === b.area;

export function coFailureRows(target) {
  const others = target.coFailures ?? [];
  if (!others.length) {
    return [
      row(
        'isolated',
        HISTORY,
        `the only failing test in run ${target.run_id}`,
        ['test-defect'],
        ['environment'],
      ),
    ];
  }
  const related = others.filter(
    (o) => sharesArea(target, o) || sharesCategory(target, o),
  );
  if (!related.length) return [];
  const names = related
    .slice(0, 5)
    .map((o) => o.test_name)
    .join(', ');
  const detail = `${related.length} other failing test(s) in run ${target.run_id} share its category or area: ${names}`;
  return [
    row(
      'co-failure',
      HISTORY,
      detail,
      ['product-defect', 'environment'],
      ['test-defect'],
    ),
  ];
}

// ---------------------------------------------------------------------------
// Paths: shared by diff.mjs and findings.mjs.

export function normalizePath(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Equal, or one is the other with a leading directory prefix. */
export function samePath(a, b) {
  const x = normalizePath(a);
  const y = normalizePath(b);
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}

const TEST_NAME = /\.(test|spec)\.|(^|\/)test_[^/]*\.py$|_test\.(py|go)$/;
const TEST_DIR = /(^|\/)(test|tests|__tests__)\//;

export function isTestPath(p) {
  const n = normalizePath(p);
  return TEST_NAME.test(n) || TEST_DIR.test(n);
}
```

4. Run the test command and expect every case to pass.
5. `npx prettier --write` both files, then run `harness validate`.
6. Commit: `feat(question): category, co-failure and test-path signals (#613)`

### Task 4: Git diff reader (diff.mjs)

**Depends on:** Task 3 | **Files:**
`agents/skills/claude-code/canary-question/scripts/diff.mjs`,
`agents/skills/test/canary-question.test.ts`

1. Add `import { execFileSync } from 'node:child_process';` as the **first**
   import line of the test file. Add:

```ts
import {
  diffEvidence,
  diffRows,
  readCulpritDiff,
} from '../claude-code/canary-question/scripts/diff.mjs';
```

Append:

```ts
/** Run git in `repo` with an identity and no signing, whatever the host has. */
function git(repo: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-C',
      repo,
      '-c',
      'user.email=question@example.invalid',
      '-c',
      'user.name=question',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { encoding: 'utf8' },
  ).trim();
}

function touch(repo: string, file: string): void {
  const full = path.join(repo, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.appendFileSync(full, `// ${Math.random()}\n`);
}

/** A repo with a SUT file and a test file; returns the base sha. */
function repoWithBase(): { repo: string; base: string } {
  const repo = tmp();
  git(repo, 'init', '-q');
  touch(repo, 'src/cart.js');
  touch(repo, TEST_FILE);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');
  return { repo, base: git(repo, 'rev-parse', 'HEAD') };
}

function commitTouching(repo: string, files: string[]): string {
  for (const f of files) touch(repo, f);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'change');
  return git(repo, 'rev-parse', 'HEAD');
}

describe('diff: reading the culprit range', () => {
  it('lists the files changed between two commits', () => {
    const { repo, base } = repoWithBase();
    const head = commitTouching(repo, [TEST_FILE]);
    expect(readCulpritDiff(repo, base, head)).toEqual({
      files: [TEST_FILE],
      error: null,
    });
  });

  it('reports, never throws, when a commit is unreachable', () => {
    const { repo, base } = repoWithBase();
    const res = readCulpritDiff(repo, base, 'deadbeefdeadbeef');
    expect(res.files).toBeNull();
    expect(res.error).toBeTruthy();
  });

  it('reports, never throws, outside a git repository', () => {
    const res = readCulpritDiff(tmp(), 'abc1', 'abc2');
    expect(res.files).toBeNull();
    expect(res.error).toBeTruthy();
  });
});

describe('diff: classifying the range (SC5)', () => {
  it('diff-test-only is for test-defect and against product-defect', () => {
    const [r] = diffRows([TEST_FILE], TEST_FILE);
    expect(r.signal).toBe('diff-test-only');
    expect(r.supports).toEqual(['test-defect']);
    expect(r.weighsAgainst).toEqual(['product-defect']);
    expect(r.detail).toContain(`test file ${TEST_FILE} changed`);
  });

  it('diff-sut-only is the mirror image', () => {
    const [r] = diffRows(['src/cart.js'], TEST_FILE);
    expect(r.signal).toBe('diff-sut-only');
    expect(r.supports).toEqual(['product-defect']);
    expect(r.weighsAgainst).toEqual(['test-defect']);
    expect(r.detail).toContain(`test file ${TEST_FILE} unchanged`);
  });

  it('diff-both supports both code hypotheses', () => {
    const [r] = diffRows(['src/cart.js', TEST_FILE], TEST_FILE);
    expect(r.signal).toBe('diff-both');
    expect(r.supports).toEqual(['test-defect', 'product-defect']);
  });

  it('diff-none (same tree) supports environment', () => {
    const [r] = diffRows([], TEST_FILE);
    expect(r.signal).toBe('diff-none');
    expect(r.supports).toEqual(['environment']);
  });

  it('says so when test_file was not recorded', () => {
    const [r] = diffRows(['tests/x.py'], null);
    expect(r.signal).toBe('diff-test-only');
    expect(r.detail).toMatch(/test_file not recorded/);
  });
});

describe('diff: evidence or Not checked (SC6)', () => {
  const obs = (sha: string | null, testFile: string | null = TEST_FILE) => ({
    commit_sha: sha,
    test_file: testFile,
  });

  it('no culprit range without a prior pass', () => {
    const res = diffEvidence({
      repo: '.',
      target: obs('abc1'),
      lastPass: null,
    });
    expect(res.read).toBe(false);
    expect(res.notChecked[0].source).toBe('git diff');
    expect(res.notChecked[0].reason).toMatch(/no passing observation/);
  });

  it('refuses a sha that is not a hex object id (never reaches git)', () => {
    const res = diffEvidence({
      repo: '.',
      target: obs('--output=/tmp/x'),
      lastPass: obs('abc1'),
    });
    expect(res.read).toBe(false);
    expect(res.notChecked[0].reason).toMatch(/not a hex object id/);
  });

  it('names the git error when the range cannot be read', () => {
    const res = diffEvidence({
      repo: tmp(),
      target: obs('abc2'),
      lastPass: obs('abc1'),
    });
    expect(res.read).toBe(false);
    expect(res.notChecked[0].reason).toMatch(/git could not diff abc1\.\.abc2/);
  });

  it('reads the range and classifies it', () => {
    const { repo, base } = repoWithBase();
    const head = commitTouching(repo, ['src/cart.js']);
    const res = diffEvidence({
      repo,
      target: obs(head),
      lastPass: obs(base),
    });
    expect(res.read).toBe(true);
    expect(res.notChecked).toEqual([]);
    expect(res.rows[0].signal).toBe('diff-sut-only');
  });
});
```

2. Run the test command and expect a failure on the import.
3. Create `agents/skills/claude-code/canary-question/scripts/diff.mjs`:

```js
// diff -- `git diff --name-only` over the culprit range, as evidence.
//
// Culprit range = last passing observation's commit -> target failure's commit.
// Any reason the range cannot be read (no prior pass, a sha that is not an
// object id, git missing, commits unreachable) is a "Not checked" entry, never
// a silent gap and never an error: the diff is optional evidence (D9).
//
// Shas come from the store, so they are validated as hex before they reach git:
// a value like `--output=x` would otherwise be parsed as a git option.

import { execFileSync } from 'node:child_process';

import { isTestPath, row, samePath } from './signals.mjs';

const HEX = /^[0-9a-f]{4,64}$/i;
const SOURCE = 'git diff';

function firstLine(text) {
  return String(text ?? '')
    .trim()
    .split('\n')[0];
}

/** @returns {{files: string[]|null, error: string|null}} */
export function readCulpritDiff(repo, from, to) {
  try {
    const out = execFileSync(
      'git',
      ['-C', repo, 'diff', '--name-only', from, to],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const files = out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    return { files, error: null };
  } catch (exc) {
    return { files: null, error: firstLine(exc.stderr) || exc.message };
  }
}

/** [supports, weighsAgainst] per diff signal. */
const WEIGHTS = {
  'diff-none': [['environment'], []],
  'diff-test-only': [['test-defect'], ['product-defect']],
  'diff-sut-only': [['product-defect'], ['test-defect']],
  'diff-both': [['test-defect', 'product-defect'], []],
};

function diffKind(testCount, sutCount) {
  if (testCount + sutCount === 0) return 'diff-none';
  if (sutCount === 0) return 'diff-test-only';
  if (testCount === 0) return 'diff-sut-only';
  return 'diff-both';
}

function scopeNote(files, testFile) {
  if (!testFile) {
    return 'test_file not recorded; compared test-like paths with the rest';
  }
  const changed = files.some((f) => samePath(f, testFile));
  return `test file ${testFile} ${changed ? 'changed' : 'unchanged'}`;
}

/** Classify a changed-file list into exactly one diff row. */
export function diffRows(files, testFile) {
  const onTestSide = (f) =>
    (testFile !== null && samePath(f, testFile)) || isTestPath(f);
  const testCount = files.filter(onTestSide).length;
  const sutCount = files.length - testCount;
  const kind = diffKind(testCount, sutCount);
  const detail = `${testCount} test path(s), ${sutCount} non-test path(s) changed; ${scopeNote(files, testFile)}`;
  const [supports, against] = WEIGHTS[kind];
  return [row(kind, SOURCE, detail, supports, against)];
}

function notChecked(reason) {
  return { read: false, rows: [], notChecked: [{ source: SOURCE, reason }] };
}

function rangeProblem(target, lastPass) {
  if (!lastPass) {
    return 'no passing observation before the target, so there is no culprit range';
  }
  if (
    !HEX.test(lastPass.commit_sha ?? '') ||
    !HEX.test(target.commit_sha ?? '')
  ) {
    return 'a commit sha in the culprit range is missing or not a hex object id';
  }
  return null;
}

/** @returns {{read: boolean, rows: object[], notChecked: object[]}} */
export function diffEvidence({ repo, target, lastPass }) {
  const problem = rangeProblem(target, lastPass);
  if (problem) return notChecked(problem);
  const from = lastPass.commit_sha;
  const to = target.commit_sha;
  const { files, error } = readCulpritDiff(repo, from, to);
  if (error) return notChecked(`git could not diff ${from}..${to}: ${error}`);
  return {
    read: true,
    rows: diffRows(files, target.test_file),
    notChecked: [],
  };
}
```

4. Run the test command and expect every case to pass.
5. `npx prettier --write` both files, then run `harness validate` and
   `harness check-deps` (this task adds a `node:child_process` import).
6. Commit: `feat(question): culprit-range git diff evidence (#613)`

### Task 5: Detector findings reader (findings.mjs)

**Depends on:** Task 3 | **Files:**
`agents/skills/claude-code/canary-question/scripts/findings.mjs`,
`agents/skills/test/canary-question.test.ts`

This task runs after Task 4 because both append to the same test file. It does
not use Task 4's code.

1. Add:

```ts
import {
  findingsEvidence,
  loadFindings,
} from '../claude-code/canary-question/scripts/findings.mjs';
```

Append:

```ts
/** A Tier-0 detector `--json` envelope (canary-savant/SKILL.md shape). */
function writeFindings(dir: string, findings: unknown): string {
  const file = path.join(dir, 'findings.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ schema_version: 1, findings, summary: {} }),
    'utf8',
  );
  return file;
}

describe('findings: reading the envelope (D9)', () => {
  it('refuses a named file that does not exist', () => {
    expect(() => loadFindings(path.join(tmp(), 'nope.json'))).toThrow(
      /findings file not found/,
    );
  });

  it('refuses malformed JSON and an envelope with no findings array', () => {
    const a = path.join(tmp(), 'a.json');
    fs.writeFileSync(a, '{no');
    expect(() => loadFindings(a)).toThrow(/malformed findings file/);
    const b = path.join(tmp(), 'b.json');
    fs.writeFileSync(b, '{"schema_version":1}');
    expect(() => loadFindings(b)).toThrow(/no findings array/);
  });

  it('reads the findings, ignoring non-object entries', () => {
    const file = writeFindings(tmp(), [{ file: 'x', line: 1 }, 7, null]);
    expect(loadFindings(file)).toEqual([{ file: 'x', line: 1 }]);
  });
});

describe('findings: evidence on the test file (SC7)', () => {
  const findings = [
    { file: `./${TEST_FILE}`, line: 3, rule_id: 'SV001-module-mutable-global' },
    { file: 'test/other.test.js', line: 9, rule_id: 'BH001-wall-clock' },
    { file: TEST_FILE, kind: 'last-coverage-removed' },
    { line: 4, rule_id: 'no-file' },
  ];

  it('quotes rule id and line for findings on the test file only', () => {
    const res = findingsEvidence(findings, TEST_FILE);
    expect(res.notChecked).toEqual([]);
    expect(res.rows.map((r: Run) => r.detail)).toEqual([
      `SV001-module-mutable-global at ./${TEST_FILE}:3`,
      `last-coverage-removed at ${TEST_FILE}`,
    ]);
    expect(res.rows[0].signal).toBe('detector-finding');
    expect(res.rows[0].supports).toEqual(['test-defect']);
    expect(res.rows[0].weighsAgainst).toEqual([]);
  });

  it('falls back to "unnamed rule" when a finding names none', () => {
    const res = findingsEvidence([{ file: TEST_FILE, line: 1 }], TEST_FILE);
    expect(res.rows[0].detail).toBe(`unnamed rule at ${TEST_FILE}:1`);
  });

  it('lists findings as Not checked when no file was given', () => {
    const res = findingsEvidence(null, TEST_FILE);
    expect(res.rows).toEqual([]);
    expect(res.notChecked).toEqual([
      { source: 'detector findings', reason: 'no --findings file given' },
    ]);
  });

  it('lists findings as Not checked when the test file is unknown', () => {
    const res = findingsEvidence(findings, null);
    expect(res.rows).toEqual([]);
    expect(res.notChecked[0].reason).toMatch(/no test_file/);
  });
});
```

2. Run the test command and expect a failure on the import.
3. Create `agents/skills/claude-code/canary-question/scripts/findings.mjs`:

```js
// findings -- one Tier-0 detector `--json` envelope, as test-defect evidence.
//
// savant, blackhawk, cassandra and katana share the envelope
// `{schema_version, findings: [{file, line, rule_id, ...}], summary}`, so one
// optional file covers every detector. This skill never RUNS a detector (F4).
//
// Only findings on the target's own test file count. The detector's free-text
// `snippet`/`why` is never echoed: the brief quotes rule id and location only,
// so its no-verdict guard holds for text it did not write.

import fs from 'node:fs';

import { row, samePath } from './signals.mjs';

const SOURCE = 'detector findings';

const isPlainObject = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** A named file that is missing or malformed is an error (D9). */
export function loadFindings(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`findings file not found: ${file}`);
  }
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (exc) {
    throw new Error(`malformed findings file ${file}: ${exc.message}`);
  }
  if (!isPlainObject(doc) || !Array.isArray(doc.findings)) {
    throw new Error(`malformed findings file ${file}: no findings array`);
  }
  return doc.findings.filter(isPlainObject);
}

function toRow(finding) {
  const rule = finding.rule_id ?? finding.kind ?? 'unnamed rule';
  const where =
    finding.line == null ? finding.file : `${finding.file}:${finding.line}`;
  return row('detector-finding', SOURCE, `${rule} at ${where}`, [
    'test-defect',
  ]);
}

function skipped(reason) {
  return { rows: [], notChecked: [{ source: SOURCE, reason }] };
}

/**
 * @param {object[]|null} findings null when no --findings was given
 * @param {string|null} testFile the target observation's test_file
 */
export function findingsEvidence(findings, testFile) {
  if (findings === null) return skipped('no --findings file given');
  if (!testFile) {
    return skipped(
      'the target observation records no test_file to match findings against',
    );
  }
  const onFile = findings.filter(
    (f) => typeof f.file === 'string' && samePath(f.file, testFile),
  );
  return { rows: onFile.map(toRow), notChecked: [] };
}
```

4. Run the test command and expect every case to pass.
5. `npx prettier --write` both files, then run `harness validate`.
6. Commit: `feat(question): Tier-0 detector findings as evidence (#613)`

### Task 6: Brief assembly — abstention, fidelity, fixed order, Not checked, disambiguation

**Depends on:** Task 5 | **Files:**
`agents/skills/claude-code/canary-question/scripts/brief.mjs`,
`agents/skills/test/canary-question.test.ts`

1. Add:

```ts
import {
  THIN_OBSERVATIONS,
  abstentionFor,
  assembleBrief,
} from '../claude-code/canary-question/scripts/brief.mjs';
```

Append:

```ts
const NOT_READ = {
  read: false,
  rows: [],
  notChecked: [{ source: 'git diff', reason: 'not exercised in this case' }],
};

/** Build the pure assembleBrief input the CLI would, from runs. */
function inputFor(
  runs: Run[],
  opts: {
    suite?: string | null;
    diff?: unknown;
    findings?: Run[] | null;
    historyDark?: string | null;
  } = {},
) {
  const suite = opts.suite ?? null;
  const timeline = timelineOf(runs, suite);
  const { target, lastPass } = selectTarget(timeline.observations);
  const abstained = abstentionFor(timeline, target, suite);
  return {
    test: T,
    suite,
    historyDark: opts.historyDark ?? null,
    timeline,
    target,
    lastPass,
    abstained,
    diff: abstained ? null : (opts.diff ?? NOT_READ),
    findings: opts.findings ?? null,
  };
}
const briefFor = (runs: Run[], opts?: Parameters<typeof inputFor>[1]) =>
  assembleBrief(inputFor(runs, opts));
const forOf = (brief: Run, id: string) =>
  (brief.hypotheses as Run[]).find((h) => h.id === id)!.for as Run[];
const againstOf = (brief: Run, id: string) =>
  (brief.hypotheses as Run[]).find((h) => h.id === id)!.against as Run[];
const signals = (rows: Run[]) => rows.map((r) => r.signal);

describe('brief: abstention is loud (D5, D6)', () => {
  it('SC1: no observation of the test abstains with observations: 0', () => {
    const brief = briefFor(series(['passed'], () => ({ tests: [] })));
    expect(brief.fidelity).toBe('abstained');
    expect(brief.denominator).toEqual({
      observations: 0,
      failures: 0,
      runs_in_store: 1,
    });
    expect(brief.abstained.reason).toMatch(/no observation of this test in 1/);
    expect(brief.hypotheses.map((h: Run) => [h.for, h.against])).toEqual([
      [[], []],
      [[], []],
      [[], []],
    ]);
    expect(brief.target).toEqual({});
    expect(brief.disambiguate).toHaveLength(1);
  });

  it('SC2: observations but no failure abstains with the count', () => {
    const brief = briefFor(series(['passed', 'passed', 'passed']));
    expect(brief.fidelity).toBe('abstained');
    expect(brief.abstained.reason).toBe(
      'no failing observation in 3 observation(s)',
    );
    expect(brief.denominator.observations).toBe(3);
  });

  it('a name in several suites abstains and lists them until --suite', () => {
    const runs = series(['failed', 'failed'], (i) =>
      i === 0 ? { suite: 'e2e' } : {},
    );
    const brief = briefFor(runs);
    expect(brief.abstained.suites).toEqual(['e2e', 'unit']);
    expect(brief.disambiguate[0]).toContain('--suite');
    expect(briefFor(runs, { suite: 'unit' }).abstained).toBeNull();
  });

  it('names a dark default store under Not checked', () => {
    const brief = briefFor([], { historyDark: 'no history store at x' });
    expect(brief.not_checked).toContainEqual({
      source: 'run history',
      reason: 'no history store at x',
    });
  });
});

describe('brief: fidelity is derived, never asserted (D5)', () => {
  it('SC3: fewer than 3 observations is thin', () => {
    expect(THIN_OBSERVATIONS).toBe(3);
    const brief = briefFor(series(['passed', 'failed']));
    expect(brief.fidelity).toBe('thin');
    expect(brief.disambiguate.join('\n')).toMatch(/Record more runs/);
  });

  it('3+ observations without a diff is history', () => {
    expect(briefFor(series(['passed', 'passed', 'failed'])).fidelity).toBe(
      'history',
    );
  });

  it('SC6: an unread diff is Not checked and fidelity stays history', () => {
    const brief = briefFor(series(['passed', 'passed', 'failed']));
    expect(brief.fidelity).toBe('history');
    expect(brief.not_checked.map((n: Run) => n.source)).toContain('git diff');
  });

  it('SC5: a read diff is history+diff and places test-only evidence', () => {
    const diff = {
      read: true,
      rows: diffRows([TEST_FILE], TEST_FILE),
      notChecked: [],
    };
    const brief = briefFor(series(['passed', 'passed', 'failed']), { diff });
    expect(brief.fidelity).toBe('history+diff');
    expect(signals(forOf(brief, 'test-defect'))).toContain('diff-test-only');
    expect(signals(againstOf(brief, 'product-defect'))).toContain(
      'diff-test-only',
    );
  });

  it('SC5: sut-only is symmetric', () => {
    const diff = {
      read: true,
      rows: diffRows(['src/cart.js'], TEST_FILE),
      notChecked: [],
    };
    const brief = briefFor(series(['passed', 'passed', 'failed']), { diff });
    expect(signals(forOf(brief, 'product-defect'))).toContain('diff-sut-only');
    expect(signals(againstOf(brief, 'test-defect'))).toContain('diff-sut-only');
  });

  it('a read diff on a thin timeline stays thin', () => {
    const diff = { read: true, rows: diffRows([], TEST_FILE), notChecked: [] };
    expect(briefFor(series(['passed', 'failed']), { diff }).fidelity).toBe(
      'thin',
    );
  });
});

describe('brief: evidence placement', () => {
  it('SC4: same-commit-mixed appears under all three hypotheses', () => {
    const brief = briefFor(
      series(['passed', 'failed'], () => ({ commit_sha: 'abc1230' })),
    );
    for (const id of HYPOTHESES) {
      expect(signals(forOf(brief, id))).toContain('same-commit-mixed');
    }
  });

  it('SC7: a finding on the test file is test-defect evidence', () => {
    const brief = briefFor(series(['passed', 'failed']), {
      findings: [
        { file: TEST_FILE, line: 3, rule_id: 'SV001-module-mutable-global' },
        { file: 'test/other.test.js', line: 1, rule_id: 'BH001-wall-clock' },
      ],
    });
    const rows = forOf(brief, 'test-defect').filter(
      (r) => r.signal === 'detector-finding',
    );
    expect(rows.map((r) => r.detail)).toEqual([
      `SV001-module-mutable-global at ${TEST_FILE}:3`,
    ]);
  });

  it('a non-discriminating category lands in neutral, not a hypothesis', () => {
    const brief = briefFor(
      series(['passed', 'failed'], () => ({
        tests: [entry('failed', { failure_category: 'client' })],
      })),
    );
    expect(signals(brief.neutral)).toEqual(['category-neutral']);
    for (const h of brief.hypotheses) {
      expect(signals([...h.for, ...h.against])).not.toContain(
        'category-neutral',
      );
    }
  });

  it('rows carry signal, source and detail only', () => {
    const brief = briefFor(series(['passed', 'failed']));
    expect(Object.keys(forOf(brief, 'test-defect')[0]).sort()).toEqual([
      'detail',
      'signal',
      'source',
    ]);
  });

  it('names a missing category, skipped observations and unread findings', () => {
    const brief = briefFor(series(['skipped', 'passed', 'failed']));
    const sources = brief.not_checked.map((n: Run) => n.source);
    expect(sources).toEqual([
      'skipped observations',
      'failure category',
      'git diff',
      'detector findings',
    ]);
  });

  it('records the target and the last pass', () => {
    const brief = briefFor(series(['passed', 'failed']));
    expect(brief.target).toMatchObject({
      run_id: 'r2',
      commit_sha: 'abc20',
      status: 'failed',
      last_pass_commit_sha: 'abc10',
    });
    expect(brief.schema_version).toBe(1);
    expect(brief.advisory).toBe(true);
    expect(brief.suite).toBe('unit');
  });
});

describe('brief: fixed order (SC8, D1)', () => {
  it('orders hypotheses identically whichever side the evidence favours', () => {
    const favourTest = briefFor(series(['passed', 'passed', 'failed']), {
      diff: {
        read: true,
        rows: diffRows([TEST_FILE], TEST_FILE),
        notChecked: [],
      },
    });
    const favourProduct = briefFor(
      series(['passed', 'passed', 'failed'], () => ({
        tests: [entry('failed', { failure_category: 'server' })],
      })),
      {
        diff: {
          read: true,
          rows: diffRows(['src/cart.js'], TEST_FILE),
          notChecked: [],
        },
      },
    );
    const favourEnv = briefFor(
      series(['passed', 'passed', 'failed'], () => ({
        tests: [
          entry('failed', { error_text: 'connect ECONNREFUSED' }),
          { test_name: 'b', status: 'failed', area: 'cart' },
        ],
      })),
    );
    for (const brief of [favourTest, favourProduct, favourEnv]) {
      expect(brief.hypotheses.map((h: Run) => h.id)).toEqual(HYPOTHESES);
    }
  });
});

describe('brief: disambiguation is always offered', () => {
  it('names the commits that would isolate a test or product change', () => {
    const steps = briefFor(series(['passed', 'passed', 'failed'])).disambiguate;
    expect(steps[0]).toMatch(/^Re-run .* several times at abc30/);
    expect(steps.join('\n')).toMatch(/canary-savant --confirm on test\/cart/);
    expect(steps.join('\n')).toMatch(/Check out abc20/);
    expect(steps.join('\n')).toMatch(/system under test at abc20/);
  });

  it('omits the range steps when there is no prior pass', () => {
    const steps = briefFor(series(['failed', 'failed', 'failed'])).disambiguate;
    expect(steps.join('\n')).not.toMatch(/Check out/);
    expect(steps.length).toBeGreaterThanOrEqual(1);
  });
});
```

2. Run the test command and expect a failure on the import.
3. Create `agents/skills/claude-code/canary-question/scripts/brief.mjs` (the
   assembly half; Task 7 adds rendering):

```js
// brief -- pure: gathered evidence in, the evidence brief out.
//
// The brief is never a verdict (D1). Three hypotheses, always in HYPOTHESES
// order, each with the rows that bear for and against it. Nothing counts rows
// per hypothesis, sorts by evidence, or picks a side. Fidelity is derived from
// what was actually read (D5), and abstention prints no evidence at all (D6).

import {
  HYPOTHESES,
  categoryRows,
  coFailureRows,
  historySignals,
  resolveCategory,
} from './signals.mjs';
import { findingsEvidence } from './findings.mjs';

/** The smallest sample where one run is not the whole story (signal D5). */
export const THIN_OBSERVATIONS = 3;

const FAILING = new Set(['failed', 'flaky']);

/** Why the brief abstains, or null. Checked before any evidence is read. */
export function abstentionFor(timeline, target, suite) {
  const n = timeline.observations.length;
  if (n === 0) {
    return {
      reason: `no observation of this test in ${timeline.runsInStore} run(s) in the store`,
    };
  }
  if (!suite && timeline.suites.length > 1) {
    return {
      reason: `the test name occurs in ${timeline.suites.length} suites; pass --suite to pick one`,
      suites: timeline.suites,
    };
  }
  if (!target)
    return { reason: `no failing observation in ${n} observation(s)` };
  return null;
}

function fidelityOf(abstained, observations, diffRead) {
  if (abstained) return 'abstained';
  if (observations < THIN_OBSERVATIONS) return 'thin';
  return diffRead ? 'history+diff' : 'history';
}

const strip = ({ signal, source, detail }) => ({ signal, source, detail });

function placeRows(rows) {
  return HYPOTHESES.map((id) => ({
    id,
    for: rows.filter((r) => r.supports.includes(id)).map(strip),
    against: rows.filter((r) => r.weighsAgainst.includes(id)).map(strip),
  }));
}

const isNeutral = (r) => !r.supports.length && !r.weighsAgainst.length;

function evidenceRows(input, findingsEv) {
  const { timeline, target, diff } = input;
  return [
    ...historySignals(timeline.observations, target),
    ...categoryRows(target),
    ...coFailureRows(target),
    ...diff.rows,
    ...findingsEv.rows,
  ];
}

function notCheckedFor(input, findingsEv) {
  const out = [];
  if (input.historyDark) {
    out.push({ source: 'run history', reason: input.historyDark });
  }
  if (input.timeline.skipped) {
    out.push({
      source: 'skipped observations',
      reason: `${input.timeline.skipped} skipped observation(s) carry no pass/fail evidence`,
    });
  }
  if (input.abstained) return out;
  if (!resolveCategory(input.target)) {
    out.push({
      source: 'failure category',
      reason:
        'the target observation records neither failure_category nor error_text',
    });
  }
  return [...out, ...input.diff.notChecked, ...findingsEv.notChecked];
}

const shaOf = (o) => o.commit_sha ?? 'an unrecorded commit';

function abstainedStep(input) {
  if (input.abstained.suites) {
    return `Re-run with --suite set to one of: ${input.abstained.suites.join(', ')}.`;
  }
  return `Record runs of ${input.test} into the history store (canary history record) until a failing observation exists to examine.`;
}

function rangeSteps(target, lastPass) {
  if (!lastPass) return [];
  return [
    `Check out ${shaOf(lastPass)} with only the test file taken from ${shaOf(target)} and run it (isolates a test change).`,
    `Run the test from ${shaOf(target)} against the system under test at ${shaOf(lastPass)} (isolates a product change).`,
  ];
}

function disambiguation(input, fidelity) {
  if (input.abstained) return [abstainedStep(input)];
  const { test, target, lastPass, timeline } = input;
  const steps = [
    `Re-run ${test} several times at ${shaOf(target)} and compare outcomes (nondeterminism check).`,
  ];
  if (target.test_file) {
    steps.push(
      `Run canary-savant --confirm on ${target.test_file} (order dependence).`,
    );
  }
  steps.push(...rangeSteps(target, lastPass));
  if (fidelity === 'thin') {
    steps.push(
      `Record more runs: ${timeline.observations.length} of ${THIN_OBSERVATIONS} observations so far.`,
    );
  }
  return steps;
}

function targetSummary(target, lastPass) {
  if (!target) return {};
  const { coFailures, error_text, ...rest } = target;
  return {
    ...rest,
    co_failures: coFailures.length,
    last_pass_commit_sha: lastPass?.commit_sha ?? null,
  };
}

/**
 * @param {object} input {test, suite, historyDark, timeline, target, lastPass,
 *   abstained, diff, findings} -- diff is null when abstained
 */
export function assembleBrief(input) {
  const { timeline, target, abstained } = input;
  const observations = timeline.observations.length;
  const fidelity = fidelityOf(
    abstained,
    observations,
    Boolean(input.diff?.read),
  );
  const findingsEv = abstained
    ? { rows: [], notChecked: [] }
    : findingsEvidence(input.findings, target.test_file);
  const rows = abstained ? [] : evidenceRows(input, findingsEv);
  return {
    schema_version: 1,
    advisory: true,
    test: input.test,
    suite: input.suite ?? target?.suite ?? null,
    fidelity,
    denominator: {
      observations,
      failures: timeline.observations.filter((o) => FAILING.has(o.status))
        .length,
      runs_in_store: timeline.runsInStore,
    },
    // Abstained => no target shown, even when one exists (ambiguous suite, D6).
    target: targetSummary(abstained ? null : target, input.lastPass),
    hypotheses: placeRows(rows),
    neutral: rows.filter(isNeutral).map(strip),
    not_checked: notCheckedFor(input, findingsEv),
    disambiguate: disambiguation(input, fidelity),
    abstained: abstained ?? null,
  };
}
```

`targetSummary` drops `error_text` on purpose. It is free text, so it could
carry forbidden words the guard cannot vouch for, and it could carry PII. When
the brief abstains, `input.target` may still be set (the ambiguous-suite case),
so it is passed as `null` to keep D6's "no evidence at all" promise.

4. Run the test command and expect every case to pass.
5. `npx prettier --write` both files, then run `harness validate`.
6. Commit:
   `feat(question): assemble the evidence brief with derived fidelity (#613)`

### Task 7: Renderers + the forbidden-language guard (SC9)

**Depends on:** Task 6 | **Files:**
`agents/skills/claude-code/canary-question/scripts/brief.mjs`,
`agents/skills/test/canary-question.test.ts`

1. Extend the `brief.mjs` import with `BANNER, renderJson, renderMarkdown`.
   Append:

```ts
type Brief = ReturnType<typeof assembleBrief>;

/** Every fixture the guard runs over: one per shape the brief can take. */
const SCENARIOS: Record<string, () => Brief> = {
  'no observation': () => briefFor([]),
  'no failure': () => briefFor(series(['passed', 'passed', 'passed'])),
  'ambiguous suite': () =>
    briefFor(
      series(['failed', 'failed'], (i) => (i === 0 ? { suite: 'e2e' } : {})),
    ),
  'dark default store': () =>
    briefFor([], { historyDark: 'no history store at x' }),
  thin: () => briefFor(series(['passed', 'failed'])),
  'same commit mixed': () =>
    briefFor(series(['passed', 'flaky'], () => ({ commit_sha: 'abc1230' }))),
  'regression, test-only diff': () =>
    briefFor(series(['passed', 'failed', 'failed']), {
      diff: {
        read: true,
        rows: diffRows([TEST_FILE], TEST_FILE),
        notChecked: [],
      },
    }),
  'server error, sut-only diff': () =>
    briefFor(
      series(['passed', 'passed', 'failed'], () => ({
        tests: [entry('failed', { failure_category: 'server' })],
      })),
      {
        diff: {
          read: true,
          rows: diffRows(['src/cart.js'], TEST_FILE),
          notChecked: [],
        },
      },
    ),
  'environment, co-failures, no diff': () =>
    briefFor(
      series(['passed', 'passed', 'failed'], () => ({
        tests: [
          entry('failed', { error_text: 'connect ECONNREFUSED' }),
          { test_name: 'b', status: 'failed', area: 'cart' },
        ],
      })),
      { diff: { read: true, rows: diffRows([], null), notChecked: [] } },
    ),
  'neutral category, findings': () =>
    briefFor(
      series(['passed', 'passed', 'failed'], () => ({
        tests: [
          entry('failed', { failure_category: 'client', test_file: null }),
        ],
      })),
      { findings: [{ file: TEST_FILE, line: 1, rule_id: 'SV001' }] },
    ),
  'finding on the test file': () =>
    briefFor(series(['skipped', 'passed', 'failed']), {
      findings: [{ file: TEST_FILE, line: 2, rule_id: 'BH001-wall-clock' }],
    }),
};

const FORBIDDEN_PHRASES = [
  'verdict',
  'root cause',
  'is flaky',
  'test bug',
  'product bug',
  'likely',
  'probably',
  'most likely',
];
const FORBIDDEN_KEYS = ['verdict', 'disposition', 'score'];

/** Phrases present in `text` once the one sanctioned disclaimer is removed. */
function forbiddenIn(text: string): string[] {
  const scanned = text.toLowerCase();
  return FORBIDDEN_PHRASES.filter((p) => scanned.includes(p));
}

function keysOf(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      keysOf(v, out);
    }
  }
  return out;
}

describe('render: markdown', () => {
  it('prints the banner, fidelity, denominator and every section in order', () => {
    const md = renderMarkdown(briefFor(series(['passed', 'passed', 'failed'])));
    expect(md).toContain(`# canary-question: ${T}`);
    expect(md).toContain(BANNER);
    expect(md).toContain('**Fidelity:** history');
    expect(md).toContain('observations: 3 · failures: 1 · runs in store: 3');
    const order = [
      '## Defect in the test',
      '## Defect in the system under test',
      '## Environment or infrastructure',
      '## Not checked',
      '## What would disambiguate',
    ].map((h) => md.indexOf(h));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('SC1: an abstained brief says ABSTAINED and shows no hypothesis evidence', () => {
    const md = renderMarkdown(briefFor([]));
    expect(md).toContain('ABSTAINED');
    expect(md).toContain('observations: 0');
    expect(md).not.toContain('## Defect in the test');
    expect(md).toContain('## What would disambiguate');
  });

  it('SC3: a thin brief carries a THIN EVIDENCE banner', () => {
    expect(renderMarkdown(briefFor(series(['passed', 'failed'])))).toMatch(
      /THIN EVIDENCE.*2 of 3 observations/,
    );
  });

  it('says "none recorded" for an empty side, and renders neutral rows', () => {
    const md = renderMarkdown(SCENARIOS['neutral category, findings']());
    expect(md).toContain('- none recorded');
    expect(md).toContain('## Recorded, does not discriminate');
    expect(md).toContain('`category-neutral`');
  });

  it('says so when every source was read', () => {
    const brief = SCENARIOS['regression, test-only diff']();
    brief.not_checked = [];
    expect(renderMarkdown(brief)).toContain('- nothing; every source was read');
  });
});

describe('render: json', () => {
  it('round-trips the brief object', () => {
    const brief = briefFor(series(['passed', 'failed']));
    expect(JSON.parse(renderJson(brief))).toEqual(brief);
  });
});

describe('no verdict language, ever (SC9, D11)', () => {
  it('the guard catches a planted phrase (so it is not vacuous)', () => {
    expect(forbiddenIn('this probably breaks')).toEqual(['probably']);
    expect(forbiddenIn(BANNER)).toEqual([]);
    expect(keysOf({ a: [{ score: 1 }] })).toContain('score');
  });

  for (const [name, build] of Object.entries(SCENARIOS)) {
    it(`${name}: markdown and JSON are clean`, () => {
      const brief = build();
      expect(forbiddenIn(renderMarkdown(brief))).toEqual([]);
      expect(forbiddenIn(renderJson(brief))).toEqual([]);
      const keys = keysOf(brief);
      expect(keys.filter((k) => FORBIDDEN_KEYS.includes(k))).toEqual([]);
      expect(brief.hypotheses.map((h: Run) => h.id)).toEqual(HYPOTHESES);
    });
  }

  it('covers at least 10 fixtures (a shrunken list would pass vacuously)', () => {
    expect(Object.keys(SCENARIOS).length).toBeGreaterThanOrEqual(10);
  });
});
```

2. Run the test command and expect a failure (`BANNER`/`renderMarkdown` not
   exported).
3. Append to `brief.mjs`:

```js
// ---------------------------------------------------------------------------
// Rendering. Copy is guarded by the SC9 test: no verdict language anywhere in
// the output except this one disclaimer, which the spec mandates verbatim.

export const BANNER = 'Evidence brief — hypotheses and evidence, no call made';

const LABELS = {
  'test-defect': 'Defect in the test',
  'product-defect': 'Defect in the system under test',
  environment: 'Environment or infrastructure',
};

const bullet = (r) => `- \`${r.signal}\` (${r.source}): ${r.detail}`;
const bullets = (rows) =>
  rows.length ? rows.map(bullet) : ['- none recorded'];

function denominatorLine({ observations, failures, runs_in_store }) {
  return `observations: ${observations} · failures: ${failures} · runs in store: ${runs_in_store}`;
}

function headerLines(brief) {
  const lines = [
    `# canary-question: ${brief.test}`,
    '',
    `> **${BANNER}.** Each hypothesis lists what the stored evidence says for and against it, in a fixed order. Advisory only.`,
    '',
    `**Fidelity:** ${brief.fidelity} · **Denominator:** ${denominatorLine(brief.denominator)}`,
  ];
  if (brief.fidelity === 'thin') {
    lines.push(
      '',
      `> **THIN EVIDENCE:** ${brief.denominator.observations} of ${THIN_OBSERVATIONS} observations. One run is not the whole story.`,
    );
  }
  if (brief.abstained) {
    lines.push('', `> **ABSTAINED:** ${brief.abstained.reason}.`);
  }
  return lines;
}

function targetLines({ target }) {
  if (!target.run_id) return [];
  const pass = target.last_pass_commit_sha ?? 'none recorded';
  return [
    '',
    `**Target failure:** run ${target.run_id} at ${target.commit_sha ?? 'an unrecorded commit'} (${target.timestamp ?? 'no timestamp'}), status ${target.status}; last pass: ${pass}`,
  ];
}

function hypothesisLines(brief) {
  if (brief.abstained) return [];
  return brief.hypotheses.flatMap((h) => [
    '',
    `## ${LABELS[h.id]}`,
    '',
    '**For**',
    '',
    ...bullets(h.for),
    '',
    '**Against**',
    '',
    ...bullets(h.against),
  ]);
}

function neutralLines({ neutral }) {
  if (!neutral.length) return [];
  return ['', '## Recorded, does not discriminate', '', ...neutral.map(bullet)];
}

function notCheckedLines({ not_checked: rows }) {
  const body = rows.length
    ? rows.map((n) => `- ${n.source}: ${n.reason}`)
    : ['- nothing; every source was read'];
  return ['', '## Not checked', '', ...body];
}

function disambiguateLines({ disambiguate }) {
  return [
    '',
    '## What would disambiguate',
    '',
    ...disambiguate.map((s, i) => `${i + 1}. ${s}`),
  ];
}

export function renderMarkdown(brief) {
  return [
    ...headerLines(brief),
    ...targetLines(brief),
    ...hypothesisLines(brief),
    ...neutralLines(brief),
    ...notCheckedLines(brief),
    ...disambiguateLines(brief),
  ].join('\n');
}

export function renderJson(brief) {
  return JSON.stringify(brief, null, 2);
}
```

4. Run the test command and expect every case to pass. If a scenario trips the
   guard, fix the **copy in the scripts**. There is no exemption list: the
   banner itself is scanned.
5. `npx prettier --write` both files, then run `harness validate`.
6. Commit: `feat(question): markdown/JSON brief with a no-verdict guard (#613)`

### Task 8: CLI entry point (cli.mjs) + exit codes (SC10)

**Depends on:** Task 7 | **Files:**
`agents/skills/claude-code/canary-question/scripts/cli.mjs`,
`agents/skills/test/canary-question.test.ts`

1. Add `spawnSync` to the existing `node:child_process` import
   (`import { execFileSync, spawnSync } from 'node:child_process';`). Also add
   `import { fileURLToPath } from 'node:url';` and:

```ts
import { CLI_SPEC, main } from '../claude-code/canary-question/scripts/cli.mjs';
```

Append:

```ts
const CLI = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'claude-code',
  'canary-question',
  'scripts',
  'cli.mjs',
);

function runMain(argv: string[]) {
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

describe('cli: exit codes (SC10, D10)', () => {
  it('declares its flags through the shared parser, with no --strict', () => {
    expect(CLI_SPEC.prog).toBe('canary-question');
    expect(CLI_SPEC.required).toEqual(['--test']);
    expect(Object.keys(CLI_SPEC.booleans)).toEqual(['--json']);
    expect(CLI_SPEC.values['--history']).toEqual({ key: 'history' });
  });

  it('--help exits 0 with usage on stdout', () => {
    const r = runMain(['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^usage: canary-question/);
  });

  it('a missing --test is a usage error (2)', () => {
    const r = runMain([]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^canary-question: error: .*--test/);
  });

  it('a named --history that does not exist exits 1', () => {
    const r = runMain(['--test', T, '--history', path.join(tmp(), 'nope')]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^canary-question: history store not found/);
  });

  it('a named --findings that does not exist or is malformed exits 1', () => {
    const history = writeStore(tmp(), series(['passed', 'failed']));
    const missing = runMain([
      '--test',
      T,
      '--history',
      history,
      '--findings',
      path.join(tmp(), 'nope'),
    ]);
    expect(missing.code).toBe(1);
    const bad = path.join(tmp(), 'bad.json');
    fs.writeFileSync(bad, '{');
    expect(
      runMain(['--test', T, '--history', history, '--findings', bad]).code,
    ).toBe(1);
  });

  it('SC1: an abstained brief still exits 0', () => {
    const history = writeStore(tmp(), []);
    const r = runMain(['--test', T, '--history', history]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('ABSTAINED');
    expect(r.stdout).toContain('observations: 0');
  });

  it('--json prints the brief object and --out writes the same text', () => {
    const dir = tmp();
    const history = writeStore(dir, series(['passed', 'failed']));
    const out = path.join(dir, 'nested', 'brief.json');
    const r = runMain([
      '--test',
      T,
      '--history',
      history,
      '--repo',
      dir,
      '--json',
      '--out',
      out,
    ]);
    expect(r.code).toBe(0);
    const brief = JSON.parse(r.stdout);
    expect(brief.fidelity).toBe('thin');
    expect(fs.readFileSync(out, 'utf8')).toBe(r.stdout);
  });

  it('an unwritable --out exits 1', () => {
    const dir = tmp();
    const history = writeStore(dir, series(['passed', 'failed']));
    const blocker = path.join(dir, 'file');
    fs.writeFileSync(blocker, '');
    const r = runMain([
      '--test',
      T,
      '--history',
      history,
      '--out',
      path.join(blocker, 'x.md'),
    ]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/cannot write artifact/);
  });

  it('SC6: --repo that is not a git repo leaves the diff Not checked', () => {
    const dir = tmp();
    const history = writeStore(dir, series(['passed', 'passed', 'failed']));
    const r = runMain([
      '--test',
      T,
      '--history',
      history,
      '--repo',
      dir,
      '--json',
    ]);
    const brief = JSON.parse(r.stdout);
    expect(brief.fidelity).toBe('history');
    expect(
      brief.not_checked.find((n: Run) => n.source === 'git diff').reason,
    ).toMatch(/git could not diff/);
  });

  it('SC5 end to end: a real test-only range reads as history+diff', () => {
    const { repo, base } = repoWithBase();
    const head = commitTouching(repo, [TEST_FILE]);
    const shas = [base, base, head];
    const history = writeStore(
      tmp(),
      series(['passed', 'passed', 'failed'], (i) => ({ commit_sha: shas[i] })),
    );
    const r = runMain([
      '--test',
      T,
      '--history',
      history,
      '--repo',
      repo,
      '--json',
    ]);
    const brief = JSON.parse(r.stdout);
    expect(r.code).toBe(0);
    expect(brief.fidelity).toBe('history+diff');
    expect(brief.hypotheses[0].for.map((x: Run) => x.signal)).toContain(
      'diff-test-only',
    );
  });

  it('a missing DEFAULT store is a dark source, exit 0 (spawned in an empty dir)', () => {
    const res = spawnSync(process.execPath, [CLI, '--test', T], {
      cwd: tmp(),
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('ABSTAINED');
    expect(res.stdout).toMatch(/run history: no history store at test-results/);
  });

  it('ships executable (the skill runner execs it via its shebang)', () => {
    expect(fs.statSync(CLI).mode & 0o111).toBeTruthy();
  });
});
```

2. Run the test command and expect a failure on the import.
3. Create `agents/skills/claude-code/canary-question/scripts/cli.mjs`:

```js
#!/usr/bin/env node
// canary-question -- test defect, product defect, or environment? (#613)
//
// For ONE failing test, assemble the evidence canary already persists (the
// run-history store, optionally a git diff of the culprit range and one Tier-0
// detector envelope) into a brief: three hypotheses in a fixed order, the
// evidence for and against each, what could not be read, and what would tell
// them apart. It never picks one. A wrong triage is worse than none: calling a
// real product defect a flaky test is how defects escape.
//
// Advisory only (D10): exit 0 for every brief, abstention included. 1 = a
// named input could not be read or --out could not be written. 2 = usage.
// There is no --strict: this tool must never fail a job on its own reading.
//
// Invoked via `canary skills run canary-question -- --test NAME [...]`.

import fs from 'node:fs';
import path from 'node:path';

import {
  createParser,
  formatUsageError,
  EXIT_USAGE,
} from '../../../lib/parse-args.mjs';
import {
  DEFAULT_HISTORY,
  buildTimeline,
  readStore,
  selectTarget,
} from './history.mjs';
import { diffEvidence } from './diff.mjs';
import { loadFindings } from './findings.mjs';
import {
  abstentionFor,
  assembleBrief,
  renderJson,
  renderMarkdown,
} from './brief.mjs';

const PREFIX = 'canary-question:';

const USAGE =
  'usage: canary-question [-h] --test NAME [--suite NAME] [--history PATH]\n' +
  '                       [--findings PATH] [--repo DIR] [--json] [--out PATH]\n' +
  '\n' +
  'Evidence brief for one failing test: test defect, product defect, or\n' +
  'environment -- the evidence for and against each. It does not choose.';

// `--history` has no default ON PURPOSE: null is how main tells a dark default
// store from a typo'd path (spec D9; same device as canary-signal --ledger).
export const CLI_SPEC = {
  prog: 'canary-question',
  booleans: { '--json': 'json' },
  values: {
    '--test': { key: 'test' },
    '--suite': { key: 'suite' },
    '--history': { key: 'history' },
    '--findings': { key: 'findings' },
    '--repo': { key: 'repo' },
    '--out': { key: 'out' },
  },
  defaults: { repo: '.' },
  required: ['--test'],
};

const parseArgs = createParser(CLI_SPEC);

/** @returns {string|null} null on success */
function writeArtifact(out, text) {
  try {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, text, 'utf8');
    return null;
  } catch (exc) {
    return `cannot write artifact: ${exc.message}`;
  }
}

function loadInputs(args) {
  try {
    return {
      store: readStore(args.history ?? DEFAULT_HISTORY, args.history !== null),
      findings: args.findings === null ? null : loadFindings(args.findings),
    };
  } catch (exc) {
    return { error: exc.message };
  }
}

/** Everything assembleBrief needs; the git diff is read only when not abstaining. */
function gather(args, { store, findings }) {
  const timeline = buildTimeline(store.runs, {
    test: args.test,
    suite: args.suite,
  });
  const { target, lastPass } = selectTarget(timeline.observations);
  const abstained = abstentionFor(timeline, target, args.suite);
  const diff = abstained
    ? null
    : diffEvidence({ repo: args.repo, target, lastPass });
  return {
    test: args.test,
    suite: args.suite,
    historyDark: store.dark,
    timeline,
    target,
    lastPass,
    abstained,
    diff,
    findings,
  };
}

function emit(args, brief) {
  const text = args.json ? renderJson(brief) : renderMarkdown(brief);
  console.log(text);
  const failure = args.out ? writeArtifact(args.out, text) : null;
  if (failure) {
    console.error(`${PREFIX} ${failure}`);
    return 1;
  }
  return 0;
}

export function main(argv = []) {
  const { opts: args, help, error } = parseArgs(argv);
  if (help) {
    console.log(USAGE);
    return 0;
  }
  if (error) {
    console.error(formatUsageError(CLI_SPEC.prog, error));
    return EXIT_USAGE;
  }
  const inputs = loadInputs(args);
  if (inputs.error) {
    console.error(`${PREFIX} ${inputs.error}`);
    return 1;
  }
  return emit(args, assembleBrief(gather(args, inputs)));
}

// `process.exitCode`, not `process.exit()`: a large payload exceeds the pipe
// buffer and `process.exit` truncates it while still exiting 0 (#791).
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2));
}
```

4. `chmod +x /Users/bs/Github/canary-fleet-613-canary-question/agents/skills/claude-code/canary-question/scripts/cli.mjs`
5. Run the test command and expect every case to pass. Then run
   `npx vitest run test/skill-cli-conformance.test.ts`. It is still green,
   because canary-question has no SKILL.md yet and so is not discovered. It
   becomes a row in Task 9.
6. `npx prettier --write` both files, then run `harness validate` and
   `harness check-deps`.
7. Commit: `feat(question): canary-question CLI entry point (#613)`. After
   committing, confirm the mode was recorded with
   `git ls-files -s agents/skills/claude-code/canary-question/scripts/cli.mjs`,
   which should start with `100755`.

### Task 9: SKILL.md

**Depends on:** Task 8 | **Files:**
`agents/skills/claude-code/canary-question/SKILL.md`

1. The failing checks come first: run
   `npx vitest run test/skill-cli-conformance.test.ts` from `agents/skills/`. It
   passes now but does not yet include canary-question; note the discovered row
   count. The "failing test" for this task is the discovery suite plus
   `ts/test/skill-examples.test.ts`, which require a runnable example once the
   file exists.
2. Create `agents/skills/claude-code/canary-question/SKILL.md`:

````markdown
---
name: canary-question
description:
  Evidence brief for one failing test. Reads the run-history store (and,
  optionally, a git diff of the culprit range and one Tier-0 detector --json
  envelope) and lists, for three hypotheses in a fixed order -- defect in the
  test, defect in the system under test, environment -- the evidence for and
  against each, how much evidence there was, what could not be read, and what
  would tell them apart. It never picks one. Advisory; exit 0 for every brief.
cli: scripts/cli.mjs
requires: [node>=20]
---

# Canary Question

Every red build asks: is this a defect in the test or in the product? A wrong
answer is worse than none. "Just a flaky test" stamped on a real product defect
is how defects escape. So `canary-question` does not answer. It lays out the
evidence canary already has, labels how much there was, and says what
observation would settle it.

## What this is not

- **Not a classifier.** No verdict, disposition, score, ranking or lean appears
  in the markdown or the JSON, and a test asserts that over every fixture. The
  three hypotheses always appear in the same order, whatever the evidence says.
- **Not a gate.** There is no `--strict`. It exits 0 for every brief it
  produces, abstentions included.
- **Not a detector runner.** It reads one detector's `--json` output if you give
  it one (`canary-savant`, `canary-blackhawk`, `canary-cassandra`,
  `canary-katana`). It never runs them, re-runs the test, or calls a model.

## Invocation

```bash
# Usage and the full flag list (exits 0):
canary skills run canary-question -- --help
```

<!-- canary:illustrative -->

```bash
# Brief for one test, from the default store, diffed in this repo:
canary skills run canary-question -- --test "checkout adds the item"

# With a detector envelope and machine-readable output written to disk:
canary skills run canary-savant -- tests --json > savant.json
canary skills run canary-question -- --test "checkout adds the item" \
  --suite unit --findings savant.json --json --out reports/question.json
```

| Flag         | Default                                 | Meaning                                                     |
| ------------ | --------------------------------------- | ----------------------------------------------------------- |
| `--test`     | required                                | exact `test_name` in the store                              |
| `--suite`    | —                                       | pick one suite when the name occurs in several              |
| `--history`  | `test-results/reports/history-v2.jsonl` | run-history store; default missing = Not checked, named = 1 |
| `--findings` | —                                       | one Tier-0 detector `--json` envelope; named missing = 1    |
| `--repo`     | `.`                                     | git working tree for the culprit-range diff                 |
| `--json`     | off                                     | print the brief as JSON instead of markdown                 |
| `--out`      | —                                       | also write what was printed to this file                    |

## What it reads

The **target failure** is the test's most recent `failed` or `flaky`
observation. The **culprit range** runs from the last passing observation before
it to the target's commit.

| Signal              | Fires when                                                  | For                  | Against     |
| ------------------- | ----------------------------------------------------------- | -------------------- | ----------- |
| `same-commit-mixed` | one commit has both a pass and a failure of the test        | all three            | —           |
| `retry-pass`        | a `flaky` observation, or a pass that needed a retry        | all three            | —           |
| `regression-shape`  | a pass, then ≥2 failures on distinct commits, no pass since | test, product        | environment |
| `diff-test-only`    | the culprit range changed only test paths                   | test                 | product     |
| `diff-sut-only`     | the culprit range changed only non-test paths               | product              | test        |
| `diff-both`         | both changed                                                | test, product        | —           |
| `diff-none`         | the culprit range changed nothing                           | environment          | —           |
| `category-env`      | failure category `timeout`, `network` or `auth`             | environment          | —           |
| `category-server`   | failure category `server` (5xx)                             | product              | —           |
| `category-neutral`  | any other category -- recorded as not discriminating        | —                    | —           |
| `co-failure`        | other failures in the target run share its area or category | product, environment | test        |
| `isolated`          | the test was the only failure in its run                    | test                 | environment |
| `detector-finding`  | a detector finding sits on the test's own file              | test                 | —           |

Nondeterminism supports **all three** on purpose. A race in the product looks
exactly like a flaky test from the outside.

## Honest degradation

- **Fidelity** is derived, never asserted: `abstained`, `thin` (fewer than 3
  observations; a `THIN EVIDENCE` banner is printed), `history`, or
  `history+diff` (a git diff of the culprit range was actually read). The
  denominator (observations, failures, runs in store) is always printed.
- **ABSTAINED** when the store has no observation of the test, when none of its
  observations failed, or when the name occurs in several suites and no
  `--suite` was given. An abstained brief prints no evidence at all, only what
  would help.
- **Not checked** lists every source that could not be read, with the reason: a
  missing default store, skipped observations, a target with no failure
  category, a culprit range git could not diff, no findings file.

## Exit codes

`0` every produced brief, abstentions included · `1` a named `--history` or
`--findings` is missing or malformed, or `--out` could not be written · `2`
usage.
````

3. Run from `agents/skills/`:
   `npx vitest run test/skill-cli-conformance.test.ts test/canary-question.test.ts`.
   Expect every case to pass, with canary-question now a discovered row. Then
   run from `ts/`:
   `npm run build && npx vitest run test/skill-examples.test.ts test/discovery-tree-integrity.test.ts test/skill-cli-executable.test.ts test/bop-name-registry.test.ts`.
   Expect every case to pass. The `--help` example executes; the illustrative
   block is declared.
4. `npx prettier --write agents/skills/claude-code/canary-question/SKILL.md`,
   then run `harness validate`.
5. Commit: `docs(question): canary-question SKILL.md (#613)`

### Task 10: Registrations (entry points, format glob, coverage)

**Depends on:** Task 9 | **Files:** `harness.config.json`,
`agents/skills/package.json`, `agents/skills/vitest.config.ts` | **Category:**
integration

1. The failing check comes first. From the root, run the entropy ratchet the way
   CI does (`.github/workflows/harness-quality.yml:153,199`), with the same two
   commands as the Task 12 entropy block. The count should be above the
   baseline, because the new `canary-question/scripts/*.mjs` are unreachable
   modules until the entry is declared. Record the number. From `ts/`, also run
   `npx vitest run test/entropy-entrypoints.test.ts`: the lockstep and
   git-tracked assertions must stay green after the edit.
2. `harness.config.json`: in **both** `entropy.entryPoints` and
   `performance.entryPoints`, insert the new line directly after the katana
   line, so both arrays keep the same order. Use Edit with `replace_all: true`
   on:

   ```text
         "agents/skills/claude-code/canary-katana/scripts/cli.mjs",
         "agents/skills/claude-code/canary-savant/scripts/cli.mjs",
   ```

   replacing it with:

   ```text
         "agents/skills/claude-code/canary-katana/scripts/cli.mjs",
         "agents/skills/claude-code/canary-question/scripts/cli.mjs",
         "agents/skills/claude-code/canary-savant/scripts/cli.mjs",
   ```

   There must be exactly 2 replacements
   (`grep -c canary-question/scripts/cli.mjs harness.config.json` should return
   `2`). **Never touch `maxFindings`.**

3. `agents/skills/package.json`: in `format:check`, insert
   `\"claude-code/canary-question/scripts/**/*.mjs\"` (plus one space)
   immediately before `\"claude-code/canary-sweep/scripts/**/*.mjs\"`.
4. `agents/skills/vitest.config.ts`: after
   `'claude-code/canary-signal/scripts/**/*.mjs',` add
   `'claude-code/canary-question/scripts/**/*.mjs',`.
5. Re-run the step-1 entropy ratchet and confirm the count is back at or below
   the baseline. Verify from `ts/`:
   `npx vitest run test/entropy-entrypoints.test.ts`. From `agents/skills/`:
   `npm run format:check && npm test`. The coverage thresholds (90/90/85/90)
   must hold with the new files included. If a branch is uncovered, add a test
   in `canary-question.test.ts`. Never lower a threshold.
6. `npx prettier --write` the three files (json/ts), then run
   `harness validate`.
7. Commit:
   `chore(question): register canary-question entry point, format and coverage (#613)`

### Task 11: README + roadmap

**Depends on:** Task 10 | **Files:** `agents/skills/README.md`,
`docs/roadmap.md` | **Category:** integration

1. The failing check comes first. From `ts/`, run
   `npx vitest run test/doc-links.test.ts`. It stays green; the new links must
   resolve.
2. `agents/skills/README.md`:
   - Tree: after `│   ├── canary-promote-test/` add `│   ├── canary-question/`.
   - Bundled list: directly after the `canary-screech` entry (before
     `canary-signal`), add:

     ```markdown
     - [`canary-question`](./claude-code/canary-question/SKILL.md) — Bundled
       executable skill (`scripts/cli.mjs`). Evidence brief for one failing
       test: reads the run-history store, optionally a git diff of the culprit
       range and one Tier-0 detector envelope, and lists the evidence for and
       against three hypotheses (test defect, product defect, environment) in a
       fixed order. It never picks one. Fidelity and denominator are always
       printed, thin samples are bannered, and unreadable evidence is listed
       under Not checked.
     ```

   - Programmatic list: change
     `` `canary-katana`, `canary-misfit`, `canary-savant`, `canary-screech`, ``
     to the same list with `` `canary-question`, `` inserted after
     `` `canary-misfit`, ``.
3. `docs/roadmap.md`, `### canary-question — test-bug vs product-bug triage`
   block: change `- **Status:** planned` to `- **Status:** done`, and change
   `- **Plan:** —` to
   `- **Plan:** docs/changes/613-canary-question/plans/2026-09-29-canary-question-plan.md`.
   Do **not** rename the heading. Do **not** run `harness roadmap sync --apply`
   (it files duplicates of shipped work).
4. `npx prettier --write agents/skills/README.md docs/roadmap.md`. From `ts/`,
   run `npx vitest run test/doc-links.test.ts test/bop-name-registry.test.ts`,
   then `harness validate`.
5. Commit:
   `docs(question): list canary-question in the skills README and roadmap (#613)`

### Task 12: CHANGELOG + knowledge doc + full gates

[checkpoint:human-verify]

**Depends on:** Task 11 | **Files:** `CHANGELOG.md`,
`docs/knowledge/gates/evidence-brief.md` | **Category:** integration

1. `CHANGELOG.md`: under `## [Unreleased]` / `### Added`, insert as the
   **first** bullet:

   ```markdown
   - **canary-question: evidence brief for one failing test** (#613).
     `canary skills run canary-question -- --test NAME` reads the run-history
     store, and optionally a git diff of the culprit range (`--repo`) and one
     Tier-0 detector `--json` envelope (`--findings`). It lists the evidence for
     and against three hypotheses in a fixed order: defect in the test, defect
     in the system under test, environment. It never prints a verdict, ranking
     or lean, and a test asserts that over every fixture. Fidelity (`abstained`
     / `thin` / `history` / `history+diff`) and the denominator are always
     printed, and unreadable evidence is listed under Not checked. Advisory:
     exit 0 for every brief, 1 for a named input that cannot be read, 2 for
     usage. No `--strict`.
   ```

2. Create `docs/knowledge/gates/evidence-brief.md`:

   ```markdown
   ---
   type: business_rule
   domain: gates
   source: authored
   related:
     - docs/knowledge/gates/denominator-carrying-metric.md
     - docs/changes/613-canary-question/proposal.md
   ---

   # Evidence brief, not a classifier

   Where a wrong answer is worse than no answer, canary prints an **evidence
   brief** instead of a classification: named hypotheses in a fixed order, the
   evidence for and against each, a derived fidelity label with its denominator,
   what could not be read, and what observation would tell the hypotheses apart.
   It never chooses.

   ## Why

   "It's just a flaky test" stamped on a real product defect is how defects
   escape, and it degrades the escaped-defect metric while appearing to help
   (#613). A classifier's confident wrong answer is indistinguishable from its
   confident right one. A brief's evidence can be checked.

   ## The rule

   - The hypothesis order is fixed and never depends on the evidence. The layout
     itself must not read as a ranking.
   - A signal that does not discriminate supports every hypothesis. It is never
     quietly assigned to one: nondeterminism is what a product race looks like
     too.
   - Fidelity is derived from what was read (`abstained` / `thin` / `history` /
     `history+diff`), never asserted. Abstention prints no evidence at all.
   - Unreadable optional evidence is listed as Not checked, with the reason.
   - The absence of verdict language is a property of the output, so it is
     asserted on the output, over every fixture.

   ## Where it is implemented

   - [`brief.mjs`](../../../agents/skills/claude-code/canary-question/scripts/brief.mjs)
     — assembly, fidelity, fixed order, renderers.
   - [`signals.mjs`](../../../agents/skills/claude-code/canary-question/scripts/signals.mjs)
     — every signal and which hypotheses it bears on.
   - [`canary-question.test.ts`](../../../agents/skills/test/canary-question.test.ts)
     — the no-verdict guard (SC9).
   ```

3. `npx prettier --write CHANGELOG.md docs/knowledge/gates/evidence-brief.md`.
4. **Full gates in this worktree** (a fresh worktree, so the entropy number
   means something). Check every exit code, and **read every denominator**:
   - From `ts/`: `npm run build`, `npm run typecheck`, `npm run format:check`,
     `npm test`.
   - From `agents/skills/`: `npm test`, `npm run typecheck`,
     `npm run format:check`.
   - From the root: `harness validate`, `harness check-deps` (it must report a
     non-zero module count).
   - Entropy and perf ratchets, as CI runs them
     (`.github/workflows/harness-quality.yml:153-265`):

     ```bash
     npx --yes -p @harness-engineering/cli harness cleanup --findings-json \
       > /tmp/claude-entropy.txt || true
     node scripts/entropy-ratchet.mjs --report /tmp/claude-entropy.txt
     npx --yes -p @harness-engineering/cli harness check-perf \
       > /tmp/claude-perf.txt 2>&1 || true
     node scripts/perf-ratchet.mjs --report /tmp/claude-perf.txt \
       --report-root "$PWD"
     ```

     Pass a merge-base worktree via `--base-report-root` if the script requires
     one (see `ts/test/perf-ratchet.test.ts`). Confirm that neither count rose
     against the merge base. If the perf count rose, split the offending
     function; do not touch any baseline. If the entropy duplicate detector
     flags the `RULES` copy in `signals.mjs`, stop and escalate. Copying it is a
     spec decision (a self-contained skill); do not "fix" it with a cross-skill
     import.
5. `harness validate`
6. Commit: `docs(question): changelog and evidence-brief knowledge note (#613)`
7. **[checkpoint:human-verify]** Show the markdown brief for the
   `regression, test-only diff` fixture, and the gate results with their
   denominators, before the PR is opened.

---

## Traceability

| Observable truth                  | Delivered by                                            |
| --------------------------------- | ------------------------------------------------------- |
| 1 (SC1 no observation)            | Task 6 (assembly), Task 7 (render), Task 8 (CLI exit 0) |
| 2 (SC2 no failure)                | Task 6                                                  |
| 3 (SC3 thin)                      | Task 6, Task 7                                          |
| 4 (SC4 same-commit-mixed)         | Task 2, Task 6                                          |
| 5 (SC5 diff test/sut only)        | Task 4, Task 6, Task 8 (real git end to end)            |
| 6 (SC6 git unreadable)            | Task 4, Task 6, Task 8                                  |
| 7 (SC7 detector finding)          | Task 5, Task 6                                          |
| 8 (SC8 fixed order)               | Task 2 (`HYPOTHESES`), Task 6, Task 7                   |
| 9 (SC9 no verdict language)       | Task 7 (guard over 11 fixtures, planted positive)       |
| 10 (SC10 exit codes)              | Task 8                                                  |
| 11 (SC11 suites, gates, ratchets) | Task 1 (registry), Tasks 9–12                           |

## Dependency graph

```text
T1 -> T2 -> T3 -> T4 -> T5 -> T6 -> T7 -> T8 -> T9 -> T10 -> T11 -> T12
```

The graph is strictly sequential. T4 and T5 are logically independent (both
depend only on T3's `row`/`samePath`), but they append to the same test file, so
they are serialised to avoid merge conflicts. There is no parallel wave.
