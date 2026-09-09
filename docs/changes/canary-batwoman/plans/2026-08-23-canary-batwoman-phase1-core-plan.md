# Plan: canary-batwoman — Phase 1, Core (no network)

**Date:** 2026-08-23 | **Spec:** `docs/changes/canary-batwoman/proposal.md`
(Implementation Order, Phase 1) | **Tasks:** 14 | **Time:** ~58 min |
**Integration Tier:** medium

> **[SUPERSEDED IN PART — 2026-08-24]** This plan was executed, then reviewed,
> and the review produced two approved spec amendments. **The code snippets
> below are the pre-amendment shapes and no longer compile.** Read `proposal.md`
> for the current verdict model, not this file:
>
> - **BW-C1** — `explanation` is `Explanation`, a branded non-empty type whose
>   only constructor is `explain()`. `readonly explanation: string` (line 244)
>   and every `explanation: '...'` literal below are stale.
> - **BW-I4** — `ExerciseVerdict` is a discriminated union. `evidence` is
>   **required** for `exercised` and `not-exercised`;
>   `readonly evidence?: string` (line 246) is stale for those two statuses.
>
> The plan is kept unedited as the record of what was executed. Amending 1600
> lines of executed task text would make the record of what actually happened
> less accurate, not more.

**Branch:** `feat/canary-batwoman`, worktree `scratchpad/canary-manhunter` (the
directory basename is a cosmetic leftover of a rename; the branch, spec and
feature are all `canary-batwoman`). Based on `main` at `1e0c05b` plus two spec
commits. `harness validate` and `harness check-deps` both pass on this worktree
at plan time (108 modules, 9 layers).

**Scope: Phase 1 only.** The verdict model, the `ExerciseProbe` interface, the
probe registry (matching, dispatch, no-probe fallback), and the persona-aware
renderer. The probes themselves (Phase 2), the `gh` adapter (Phase 3), the CLI
(Phase 4) and `SKILL.md` / the generated workflow (Phase 5) are **out of scope**
and no task here may create them.

**Step numbering.** Task steps are written as `**1.**` bold labels rather than
Markdown ordered lists. Fenced code inside a list item breaks `MD029` under this
repo's gated `docs-lint` workflow, and indenting every fence to keep the list
alive was tried and mangled the code. The steps are still strictly ordered.

## Goal

Batwoman's judgement — how a file's exercise status is decided among five
mutually exclusive values, and how that judgement is spoken to three different
readers — exists as unit-tested TypeScript that never touches the network or the
disk.

## Observable Truths (Acceptance Criteria)

Traced to the spec's numbered success criteria in brackets.

1. **[Ubiquitous]** The system shall define exactly five exercise statuses, of
   which `abstain` and `no-probe` are distinct values that no code path merges.
   _(spec 3)_
2. **[Event-driven]** When a changed file matches no registered probe, the
   system shall return a verdict with status `no-probe` whose explanation names
   the artifact type it could not classify, and shall never return `exercised`
   for it. _(spec 2)_
3. **[Ubiquitous]** The tally shall expose one count per status plus the
   changed-file total and **no derived aggregate** — no `assessed`, `decided`,
   or `covered` figure into which `abstain` or `no-probe` could be folded.
   _(spec 3)_
4. **[Ubiquitous]** For any verdict list, the five status counts shall sum to
   the changed-file total, asserted against the rendered summary line, not only
   against the tally object. _(spec 7)_
5. **[Event-driven]** When a probe throws or rejects, the registry shall return
   an `abstain` verdict naming the probe and the failure, and shall never return
   `exercised` or `not-exercised`. _(spec 4, the core half; the `gh` half is
   Phase 3)_
6. **[Ubiquitous]** Every render shall end with the summary line, in every
   persona register, including a run whose verdicts are all `exercised`. _(spec
   3, 8)_
7. **[Unwanted]** If any of the three registers is rendered, then no output
   shall contain a success token (check glyphs, `OK`, `clean`, `passed`,
   `success`, `all clear`) — asserted **separately per register**, over both a
   findings run and an all-`exercised` run. _(spec 3, 8)_
8. **[Ubiquitous]** Every `not-exercised` and `abstain` row shall render, in
   every register, a complete sentence naming both the observation and its
   cause, asserted against the renderer's output string. _(spec 11)_
9. **[Event-driven]** When no persona is explicitly chosen, the system shall
   render the registry's declared fallback (`junior`) and shall print the
   persona id, its `source`, and its `reason`. _(spec 9)_
10. **[Ubiquitous]** Every test in this phase shall pass with an injected
    `PersonaRegistry` and a fixture `RunHistoryPort`; no test shall read
    `ts/src/data/personas/registry.json` from disk and none shall touch the
    network. _(spec 5)_
11. **[Ubiquitous]** The four gates shall pass from `ts/` (`build`, `typecheck`,
    `format:check`, `test`), and `harness check-deps` and `harness validate`
    shall pass from the repo root.

## Uncertainties

- **[RESOLVED — decision D1a, needs sign-off]** _Who names the artifact type on
  a `no-probe` row?_ The spec puts the noun phrase on `ExerciseProbe.artifact`,
  but by construction no probe matched a `no-probe` file, so no probe can supply
  it. Resolution: a path-driven `describeArtifact(file)` in the registry module
  supplies the noun phrase for unmatched files; `ExerciseProbe.artifact` stays
  in the interface exactly as specified and is used by matched-probe messaging
  in Phase 2. Nothing in the spec is contradicted, but a reviewer should agree
  before Task 3.
- **[RESOLVED — decision D1b, needs sign-off]** _D7 says the `sdet` register
  gets "no explanation clauses", while criterion 11 requires every
  `not-exercised` and `abstain` row to carry a complete observation-and-cause
  sentence._ Taken literally these contradict. Resolution:
  `ExerciseVerdict.explanation` is itself the observation-and-cause sentence and
  is rendered in **every** register — dropping it would turn a status back into
  a code, which D4 forbids. What `sdet` drops is the material gated by the
  persona's `reasoning: false` flag: the evidence line and the next-step
  guidance. "Terse" therefore means "summary line plus one-line rows", not "rows
  without sentences".
- **[ASSUMPTION]** New modules live under `ts/src/analysis/batwoman/` (layer
  `analysis`, whose `allowedDependencies` include `core`, so the renderer may
  import `core/persona.js`). `core/` was rejected: batwoman is a feature built
  on the engine, and `forbiddenImports` bars `core` from ever reaching back to
  features, which would trap Phase 3's `gh` adapter.
- **[ASSUMPTION]** Tests live flat in `ts/test/` as `batwoman-*.test.ts`, with
  shared fixtures in `ts/test/batwoman-testkit.ts`. `ts/vitest.config.ts`
  collects `test/*.test.ts` (shallow) and `src/**/*.test.ts`. Colocating under
  `src/` was rejected because the invariant suite has to share the persona
  registry fixture with the render suite, and importing one `*.test.ts` from
  another registers its `describe` blocks twice. The testkit convention already
  exists here (`canary-cli-testkit.ts`, `abstention-testkit.ts`,
  `doc-links-testkit.ts`).
- **[DEFERRABLE]** The `--json` output path is Phase 4. Criterion 3's "every
  output path" is therefore only provable for the three human registers in this
  phase; the JSON path inherits the assertion in Phase 4.
- **[DEFERRABLE]** The exact wording of every explanation and next-step string.
  Phase 2's probes supply real explanations; Phase 1's are fixture-driven.

## Known Failure Modes This Plan Must Not Repeat

Read from `AGENTS.md` before Task 1:

- **Entropy ratchet.** The analyzer cannot follow `./x.js` specifiers, so each
  new `ts/src` module is unreachable from `ts/src/cli.ts` and reads as dead
  code. Every new module — and `ts/test/batwoman-testkit.ts`, which is not a
  `*.test.ts` file and so is not excluded — is declared in **both**
  `entryPoints` arrays in `harness.config.json` (`entropy.entryPoints` ~line 153
  and `performance.entryPoints` ~line 204), in the same commit that creates it,
  kept byte-identical and alphabetically sorted. `ts/src/analysis/batwoman/*.ts`
  sorts after `ts/scripts/copy-data.mjs` and before `ts/src/cli.ts`;
  `ts/test/batwoman-testkit.ts` sorts before `ts/test/doc-links-testkit.ts`.
  `ts/test/entropy-entrypoints.test.ts` enforces git-tracked, non-skipped,
  literal, and identical. **`entropy.maxFindings` is never raised.**
- **Arch ratchet.** `module-size` is a repo-wide line count; the printed
  regression arrow's left operand is the baseline **floor**, not `main`, so it
  overstates this branch's contribution by the whole accumulated total.
  Splitting a module cannot reduce it. Measure inside this worktree only.
- **Gates run from `ts/`, not the repo root**, and there is **no `lint`
  script**. The four gates are `build`, `typecheck`, `format:check`, `test`.
- **`docs-lint` is gated.** Markdown must be both prettier-clean and
  markdownlint-clean; the two are not the same check.
- **Never `--no-verify`.** Fix the hook's complaint instead.

## File Map

```text
CREATE ts/src/analysis/batwoman/verdict.ts
CREATE ts/src/analysis/batwoman/registry.ts
CREATE ts/src/analysis/batwoman/render.ts
CREATE ts/test/batwoman-testkit.ts
CREATE ts/test/batwoman-verdict.test.ts
CREATE ts/test/batwoman-registry.test.ts
CREATE ts/test/batwoman-render.test.ts
CREATE ts/test/batwoman-render-invariants.test.ts
MODIFY harness.config.json  (both entryPoints arrays, 4 paths each)
```

No other file is touched in Phase 1. In particular: no `ts/src/cli.ts`, no
`agents/skills/**`, no `.github/workflows/**`, and no
`ts/src/data/personas/registry.json` — the spec is explicit that batwoman adds
no register.

## Skeleton

1. Verdict model — statuses, the shared interfaces, the tally (~2 tasks, ~8 min)
2. Probe registry — artifact naming, matching, dispatch, no-probe fallback,
   throw-to-abstain (~4 tasks, ~16 min)
3. Renderer — wrap and summary line, header and persona provenance, then one
   task per register (~5 tasks, ~24 min)
4. Cross-register invariants — no success token, complete sentences, no disk (~2
   tasks, ~8 min)
5. Gate sweep and ratchet measurement (~1 task, ~5 min)

**Estimated total:** 14 tasks, ~58 minutes. _Skeleton approval is folded into
the plan sign-off (see the report accompanying this plan)._

## Tasks

### Task 1: The verdict model — five statuses and the shared interfaces

**Depends on:** none | **Files:** `ts/test/batwoman-verdict.test.ts`,
`ts/src/analysis/batwoman/verdict.ts`, `harness.config.json`

**1.** Create `ts/test/batwoman-verdict.test.ts`:

```ts
/**
 * The verdict model's one structural invariant: `abstain` and `no-probe` are
 * separate values. Collapsing them would hide whether a file suffers a probe
 * that could not decide or a registry with no probe at all (spec D3).
 */
import { describe, expect, it } from 'vitest';

import { EXERCISE_STATUSES } from '../src/analysis/batwoman/verdict.js';

describe('exercise statuses', () => {
  it('names exactly the five statuses the spec defines', () => {
    expect([...EXERCISE_STATUSES]).toEqual([
      'exercised',
      'not-exercised',
      'abstain',
      'no-probe',
      'not-applicable',
    ]);
  });

  it('keeps abstain and no-probe as distinct values', () => {
    expect(new Set(EXERCISE_STATUSES).size).toBe(EXERCISE_STATUSES.length);
    expect(EXERCISE_STATUSES).toContain('abstain');
    expect(EXERCISE_STATUSES).toContain('no-probe');
  });
});
```

**2.** Run `cd ts && npx vitest run test/batwoman-verdict.test.ts` — observe
failure (module not found).

**3.** Create `ts/src/analysis/batwoman/verdict.ts`:

```ts
/**
 * canary-batwoman's verdict model (spec `docs/changes/canary-batwoman/`).
 *
 * Batwoman answers one question per changed file -- has this artifact executed
 * since the fix merged -- and answers with one of five values, never with a
 * confidence score. A score attached to a guess reads as evidence; "I have no
 * probe for this" does not (spec D4).
 *
 * `abstain` and `no-probe` are deliberately separate. The first means a probe
 * looked and could not tell: report it, investigate it. The second means
 * nothing looked: a registry gap, fixable by adding a probe. Collapsing them
 * would hide which of the two a given file suffers from (spec D3).
 */

/** The five statuses, in report order. */
export const EXERCISE_STATUSES = [
  'exercised',
  'not-exercised',
  'abstain',
  'no-probe',
  'not-applicable',
] as const;

export type ExerciseStatus = (typeof EXERCISE_STATUSES)[number];

/** One file's answer. */
export interface ExerciseVerdict {
  readonly file: string;
  readonly status: ExerciseStatus;
  /** Human sentence for the report. Never a code. */
  readonly explanation: string;
  /** What was read to decide. Absent for no-probe. */
  readonly evidence?: string;
}

/** Header data for the report. Probes never read this. */
export interface ClosureHeader {
  readonly issue: number;
  readonly mergeSha: string;
  readonly mergeSubject: string;
  readonly mergedAt: Date;
}

/** One GitHub Actions run, reduced to the two fields a probe decides on. */
export interface WorkflowRun {
  readonly createdAt: Date;
  readonly conclusion: string | null;
}

/**
 * The single network seam (spec D6). The real implementation shells out to
 * `gh` in Phase 3; every test in Phases 1 and 2 injects a fixture.
 */
export interface RunHistoryPort {
  runsForWorkflow(workflowPath: string): Promise<WorkflowRun[]>;
}

/** Everything a probe is allowed to read. */
export interface ExerciseContext {
  readonly mergedAt: Date;
  readonly repo: string;
  readonly runs: RunHistoryPort;
  /** Repo root, for static resolution (e.g. which workflow calls a script). */
  readonly root: string;
}

/** One artifact type's detector. Shipped probes arrive in Phase 2. */
export interface ExerciseProbe {
  readonly id: string;
  /** Human noun phrase: "workflow", "workflow script". */
  readonly artifact: string;
  matches(file: string): boolean;
  probe(file: string, ctx: ExerciseContext): Promise<ExerciseVerdict>;
}
```

**4.** Run `cd ts && npx vitest run test/batwoman-verdict.test.ts` — observe
pass.

**5.** Add `"ts/src/analysis/batwoman/verdict.ts"` to **both** `entryPoints`
arrays in `harness.config.json`, immediately after `"ts/scripts/copy-data.mjs"`
in each. The two arrays must stay byte-identical.

**6.** Run `cd ts && npx vitest run test/entropy-entrypoints.test.ts` — observe
pass.

**7.** Run
`cd ts && npx prettier --write src/analysis/batwoman test/batwoman-*.ts` and,
from the repo root, `npx prettier --write harness.config.json`.

**8.** Run `harness validate` from the repo root.

**9.** Commit: `feat(batwoman): define the five-status verdict model`

### Task 2: Tally the verdicts, with no derived aggregate

**Depends on:** Task 1 | **Files:** `ts/test/batwoman-verdict.test.ts`,
`ts/src/analysis/batwoman/verdict.ts`

**1.** Append to `ts/test/batwoman-verdict.test.ts`, extending the existing
import to pull in `tallyVerdicts` and `type ExerciseVerdict`:

```ts
function v(file: string, status: ExerciseVerdict['status']): ExerciseVerdict {
  return { file, status, explanation: `${file} is ${status}.` };
}

describe('tallyVerdicts', () => {
  const mixed = [
    v('a.yml', 'not-exercised'),
    v('b.mjs', 'not-exercised'),
    v('c.ts', 'no-probe'),
    v('d.ts', 'abstain'),
    v('e.md', 'not-applicable'),
    v('f.yml', 'exercised'),
  ];

  it('counts every status and the changed-file total', () => {
    const tally = tallyVerdicts(mixed);
    expect(tally.changed).toBe(6);
    expect(tally.byStatus).toEqual({
      exercised: 1,
      'not-exercised': 2,
      abstain: 1,
      'no-probe': 1,
      'not-applicable': 1,
    });
  });

  it('sums the five counts to the changed-file total', () => {
    const tally = tallyVerdicts(mixed);
    const sum = Object.values(tally.byStatus).reduce((a, b) => a + b, 0);
    expect(sum).toBe(tally.changed);
  });

  it('exposes no derived "assessed" figure to fold abstentions into', () => {
    // spec criterion 3: a file batwoman could not decide about must not be
    // countable among those it decided. The guard is structural -- there is no
    // field an aggregate could arrive in.
    const tally = tallyVerdicts(mixed) as Record<string, unknown>;
    expect(Object.keys(tally).sort()).toEqual(['byStatus', 'changed']);
    for (const forbidden of ['assessed', 'decided', 'covered', 'clean']) {
      expect(tally[forbidden]).toBeUndefined();
    }
  });

  it('tallies an empty run without inventing a denominator', () => {
    const tally = tallyVerdicts([]);
    expect(tally.changed).toBe(0);
    expect(tally.byStatus.exercised).toBe(0);
  });
});
```

**2.** Run `cd ts && npx vitest run test/batwoman-verdict.test.ts` — observe
failure.

**3.** Append to `ts/src/analysis/batwoman/verdict.ts`:

```ts
/** One count per status. No aggregate: see {@link tallyVerdicts}. */
export type StatusTally = Readonly<Record<ExerciseStatus, number>>;

/** The report's denominator, plus its parts. */
export interface Tally {
  readonly changed: number;
  readonly byStatus: StatusTally;
}

/**
 * Count verdicts by status.
 *
 * There is deliberately no `assessed` field. A derived "files batwoman could
 * decide about" figure is exactly the shape spec criterion 3 forbids: it makes
 * `abstain` and `no-probe` disappear into a denominator that looks like
 * coverage. A caller wanting a subtotal has to write the addition itself, in
 * the open, where a reviewer can see which statuses it folded.
 */
export function tallyVerdicts(verdicts: readonly ExerciseVerdict[]): Tally {
  const byStatus: Record<ExerciseStatus, number> = {
    exercised: 0,
    'not-exercised': 0,
    abstain: 0,
    'no-probe': 0,
    'not-applicable': 0,
  };
  for (const verdict of verdicts) byStatus[verdict.status] += 1;
  return { changed: verdicts.length, byStatus };
}
```

**4.** Run `cd ts && npx vitest run test/batwoman-verdict.test.ts` — observe
pass.

**5.** Run
`cd ts && npx prettier --write src/analysis/batwoman test/batwoman-*.ts`, then
`harness validate` from the repo root.

**6.** Commit:
`feat(batwoman): tally verdicts without a derived assessed figure`

### Task 3: Name the artifact type on a file no probe claimed

**Depends on:** Task 1 | **Files:** `ts/test/batwoman-registry.test.ts`,
`ts/src/analysis/batwoman/registry.ts`, `harness.config.json`

**1.** Create `ts/test/batwoman-registry.test.ts`:

```ts
/**
 * The registry's job is dispatch plus the two honest non-answers: a file no
 * probe claimed, and a probe that blew up.
 */
import { describe, expect, it } from 'vitest';

import { describeArtifact } from '../src/analysis/batwoman/registry.js';

describe('describeArtifact', () => {
  it.each([
    ['ts/test/refresh-arch-baseline.test.ts', 'test file'],
    ['ts/src/analysis/engine.spec.ts', 'test file'],
    ['agents/skills/claude-code/canary-katana/SKILL.md', 'skill document'],
    ['harness.config.json', 'config'],
    ['mise.toml', 'config'],
    ['ts/src/core/persona.ts', 'source module'],
    ['scripts/roadmap-groom.mjs', 'source module'],
    ['AGENTS.md', 'document'],
    ['docs/assets/logo.png', 'unrecognised artifact'],
  ])('describes %s as a %s', (file, noun) => {
    expect(describeArtifact(file)).toBe(noun);
  });

  it('never returns an empty phrase, so a row always names something', () => {
    for (const file of ['', 'x', 'a/b/c']) {
      expect(describeArtifact(file).length).toBeGreaterThan(0);
    }
  });
});
```

**2.** Run `cd ts && npx vitest run test/batwoman-registry.test.ts` — observe
failure.

**3.** Create `ts/src/analysis/batwoman/registry.ts`:

```ts
/**
 * The probe registry: matching, dispatch, and the two named non-answers.
 *
 * Per spec D3 the gaps have to be countable, so an unmatched file produces a
 * `no-probe` verdict that names what it could not classify rather than
 * silence. The noun phrase comes from the path, not from a probe -- by
 * construction no probe matched, so no probe can supply it.
 * `ExerciseProbe.artifact` is the matched-probe counterpart, used by the probes
 * themselves in Phase 2.
 */

import type {
  ExerciseContext,
  ExerciseProbe,
  ExerciseVerdict,
} from './verdict.js';

/**
 * Path patterns to the noun phrase a NO PROBE row prints.
 *
 * Order is load-bearing: `*.test.ts` must be read as a test file before the
 * generic source-module rule claims it, and a skill's `SKILL.md` before the
 * generic document rule. The final fallback is a phrase rather than an empty
 * string, because a row that names nothing is the silence D3 exists to remove.
 */
const ARTIFACT_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\.(test|spec)\.[cm]?[jt]sx?$/, 'test file'],
  [/^agents\/skills\/.+\.md$/, 'skill document'],
  [/\.(json|ya?ml|toml|ini|lock)$/, 'config'],
  [/\.[cm]?[jt]sx?$/, 'source module'],
  [/\.md$/, 'document'],
];

/** The noun phrase for a file, for use in a `no-probe` row. */
export function describeArtifact(file: string): string {
  for (const [pattern, noun] of ARTIFACT_RULES) {
    if (pattern.test(file)) return noun;
  }
  return 'unrecognised artifact';
}
```

**4.** Run `cd ts && npx vitest run test/batwoman-registry.test.ts` — observe
pass.

**5.** Add `"ts/src/analysis/batwoman/registry.ts"` to **both** `entryPoints`
arrays, alphabetically, keeping the two arrays identical. Run
`cd ts && npx vitest run test/entropy-entrypoints.test.ts`.

**6.** Run
`cd ts && npx prettier --write src/analysis/batwoman test/batwoman-*.ts` and,
from the repo root, `npx prettier --write harness.config.json`; then
`harness validate`.

**7.** Commit:
`feat(batwoman): name the artifact type behind every no-probe row`

### Task 4: Match a file to a probe, and dispatch to it

**Depends on:** Task 3 | **Files:** `ts/test/batwoman-registry.test.ts`,
`ts/src/analysis/batwoman/registry.ts`

**1.** Append to `ts/test/batwoman-registry.test.ts`:

```ts
import {
  matchProbe,
  probeAll,
  probeFile,
} from '../src/analysis/batwoman/registry.js';
import type {
  ExerciseContext,
  ExerciseProbe,
} from '../src/analysis/batwoman/verdict.js';

/** A context whose port throws if anything reaches for the network. */
const OFFLINE_CTX: ExerciseContext = {
  mergedAt: new Date('2026-08-22T17:34:00Z'),
  repo: 'canary',
  root: '/repo',
  runs: {
    runsForWorkflow: () => {
      throw new Error('no test may reach the network');
    },
  },
};

function fakeProbe(id: string, pattern: RegExp): ExerciseProbe {
  return {
    id,
    artifact: id,
    matches: (file) => pattern.test(file),
    probe: async (file) => ({
      file,
      status: 'exercised',
      explanation: `${file} ran after the merge, per the ${id} probe.`,
    }),
  };
}

describe('matchProbe', () => {
  const probes = [
    fakeProbe('workflow', /^\.github\/workflows\/.+\.ya?ml$/),
    fakeProbe('script', /^scripts\/.+\.mjs$/),
  ];

  it('returns the first probe that claims the file', () => {
    expect(matchProbe(probes, '.github/workflows/ci.yml')?.id).toBe('workflow');
    expect(matchProbe(probes, 'scripts/a.mjs')?.id).toBe('script');
  });

  it('returns null when nothing claims it', () => {
    expect(matchProbe(probes, 'ts/src/core/persona.ts')).toBeNull();
  });

  it('returns null for an empty registry rather than inventing a probe', () => {
    expect(matchProbe([], 'anything.yml')).toBeNull();
  });
});

describe('probeFile / probeAll dispatch', () => {
  const probes = [fakeProbe('workflow', /\.ya?ml$/)];

  it('returns the matched probe verdict verbatim', async () => {
    const verdict = await probeFile(probes, 'ci.yml', OFFLINE_CTX);
    expect(verdict.status).toBe('exercised');
    expect(verdict.file).toBe('ci.yml');
  });

  it('preserves input order across a whole changed-file set', async () => {
    const files = ['a.yml', 'b.ts', 'c.yml'];
    const verdicts = await probeAll(probes, files, OFFLINE_CTX);
    expect(verdicts.map((verdict) => verdict.file)).toEqual(files);
  });

  it('returns one verdict per file, so the denominator is the input', async () => {
    const files = ['a.yml', 'b.ts', 'c.yml', 'd.md'];
    expect(await probeAll(probes, files, OFFLINE_CTX)).toHaveLength(4);
  });
});
```

**2.** Run `cd ts && npx vitest run test/batwoman-registry.test.ts` — observe
failure.

**3.** Append to `ts/src/analysis/batwoman/registry.ts`:

```ts
/** The first probe claiming this file, or null. */
export function matchProbe(
  probes: readonly ExerciseProbe[],
  file: string,
): ExerciseProbe | null {
  return probes.find((probe) => probe.matches(file)) ?? null;
}

/** One file's verdict, via the probe that claims it. */
export async function probeFile(
  probes: readonly ExerciseProbe[],
  file: string,
  ctx: ExerciseContext,
): Promise<ExerciseVerdict> {
  const probe = matchProbe(probes, file);
  if (probe === null) throw new Error('unmatched file: filled in by Task 5');
  return probe.probe(file, ctx);
}

/**
 * Probe every changed file, in input order, one at a time.
 *
 * Sequential rather than `Promise.all`: the real port shells out to `gh`, and a
 * fan-out over a whole changed-file set would turn one audit into a burst of
 * API calls. Order is preserved so the report is reproducible.
 */
export async function probeAll(
  probes: readonly ExerciseProbe[],
  files: readonly string[],
  ctx: ExerciseContext,
): Promise<ExerciseVerdict[]> {
  const verdicts: ExerciseVerdict[] = [];
  for (const file of files) verdicts.push(await probeFile(probes, file, ctx));
  return verdicts;
}
```

**4.** Run `cd ts && npx vitest run test/batwoman-registry.test.ts` — observe
pass.

**5.** Run
`cd ts && npx prettier --write src/analysis/batwoman test/batwoman-*.ts`, then
`harness validate`.

**6.** Commit: `feat(batwoman): match and dispatch changed files to probes`

### Task 5: The no-probe fallback — nothing looked, and it says so

**Depends on:** Task 4 | **Files:** `ts/test/batwoman-registry.test.ts`,
`ts/src/analysis/batwoman/registry.ts`

**1.** Append to `ts/test/batwoman-registry.test.ts`:

```ts
describe('the no-probe fallback', () => {
  const probes = [fakeProbe('workflow', /\.ya?ml$/)];

  it('returns no-probe, never exercised, for an unmatched file', async () => {
    const verdict = await probeFile(probes, 'ts/src/core/x.ts', OFFLINE_CTX);
    expect(verdict.status).toBe('no-probe');
    expect(verdict.status).not.toBe('exercised');
  });

  it('names the artifact type it could not classify', async () => {
    const verdict = await probeFile(probes, 'ts/test/a.test.ts', OFFLINE_CTX);
    expect(verdict.explanation).toContain('test file');
  });

  it('carries no evidence field, because nothing was read', async () => {
    const verdict = await probeFile(probes, 'AGENTS.md', OFFLINE_CTX);
    expect(verdict.evidence).toBeUndefined();
  });

  it('keeps no-probe distinct from abstain', async () => {
    const verdict = await probeFile(probes, 'AGENTS.md', OFFLINE_CTX);
    expect(verdict.status).not.toBe('abstain');
  });

  it('gives every file in an empty registry a named no-probe row', async () => {
    const verdicts = await probeAll([], ['a.ts', 'b.yml'], OFFLINE_CTX);
    expect(verdicts.map((verdict) => verdict.status)).toEqual([
      'no-probe',
      'no-probe',
    ]);
  });
});
```

**2.** Run `cd ts && npx vitest run test/batwoman-registry.test.ts` — observe
failure.

**3.** In `ts/src/analysis/batwoman/registry.ts`, replace the `throw`
placeholder in `probeFile` with the block below. Note the **absent** `evidence`
key rather than `evidence: undefined`: `exactOptionalPropertyTypes` is on, and
"nothing was read" is the point.

```ts
if (probe === null) {
  return {
    file,
    status: 'no-probe',
    explanation:
      `batwoman has no probe for this ${describeArtifact(file)}, so ` +
      'nothing looked at whether it has run since the fix merged.',
  };
}
```

**4.** Run `cd ts && npx vitest run test/batwoman-registry.test.ts` — observe
pass.

**5.** Run
`cd ts && npx prettier --write src/analysis/batwoman test/batwoman-*.ts`, then
`harness validate`.

**6.** Commit:
`feat(batwoman): report an unmatched file as a named no-probe row`

### Task 6: A probe that throws abstains — it never reports clean

**Depends on:** Task 5 | **Files:** `ts/test/batwoman-registry.test.ts`,
`ts/src/analysis/batwoman/registry.ts`

**1.** Append to `ts/test/batwoman-registry.test.ts`:

```ts
describe('a probe that throws', () => {
  const exploding: ExerciseProbe = {
    id: 'workflow',
    artifact: 'workflow',
    matches: () => true,
    probe: async () => {
      throw new Error('gh: could not authenticate');
    },
  };

  it('abstains rather than reporting the file clean', async () => {
    const verdict = await probeFile([exploding], 'ci.yml', OFFLINE_CTX);
    expect(verdict.status).toBe('abstain');
    expect(verdict.status).not.toBe('exercised');
    expect(verdict.status).not.toBe('not-exercised');
  });

  it('keeps abstain distinct from no-probe: a probe did look', async () => {
    const verdict = await probeFile([exploding], 'ci.yml', OFFLINE_CTX);
    expect(verdict.status).not.toBe('no-probe');
  });

  it('names the probe and the failure in a full sentence', async () => {
    const verdict = await probeFile([exploding], 'ci.yml', OFFLINE_CTX);
    expect(verdict.explanation).toContain('workflow');
    expect(verdict.explanation).toContain('could not authenticate');
    expect(verdict.explanation.trimEnd().endsWith('.')).toBe(true);
  });

  it('does not abort the rest of the changed-file set', async () => {
    const files = ['a.yml', 'b.yml'];
    const verdicts = await probeAll([exploding], files, OFFLINE_CTX);
    expect(verdicts).toHaveLength(2);
    expect(verdicts.every((verdict) => verdict.status === 'abstain')).toBe(
      true,
    );
  });

  it('abstains when the probe rejects rather than throws', async () => {
    const rejecting: ExerciseProbe = {
      ...exploding,
      probe: () => Promise.reject(new Error('network unreachable')),
    };
    const verdict = await probeFile([rejecting], 'ci.yml', OFFLINE_CTX);
    expect(verdict.status).toBe('abstain');
  });
});
```

**2.** Run `cd ts && npx vitest run test/batwoman-registry.test.ts` — observe
failure.

**3.** In `ts/src/analysis/batwoman/registry.ts`, replace
`return probe.probe(file, ctx);` with:

```ts
try {
  return await probe.probe(file, ctx);
} catch (err) {
  // Cannot-verify is a finding, not a pass (spec criterion 4). A probe whose
  // evidence source failed knows strictly less than one that never ran, so
  // the only honest answer is abstain -- and the `await` inside the `try` is
  // load-bearing: without it a rejected promise escapes the catch.
  return {
    file,
    status: 'abstain',
    explanation:
      `the ${probe.id} probe looked at this file but could not decide ` +
      'whether it ran, because reading its evidence failed: ' +
      `${err instanceof Error ? err.message : String(err)}.`,
    evidence: `${probe.id} probe error`,
  };
}
```

**4.** Run `cd ts && npx vitest run test/batwoman-registry.test.ts` — observe
pass.

**5.** Run
`cd ts && npx prettier --write src/analysis/batwoman test/batwoman-*.ts`, then
`harness validate`.

**6.** Commit: `fix(batwoman): abstain when a probe cannot read its evidence`

### Task 7: The testkit, the summary line, and the wrapper

**Depends on:** Task 2 | **Files:** `ts/test/batwoman-testkit.ts`,
`ts/test/batwoman-render.test.ts`, `ts/src/analysis/batwoman/render.ts`,
`harness.config.json`

**1.** Create `ts/test/batwoman-testkit.ts` — the fixtures both render suites
share. It is not a `*.test.ts` file, so vitest does not collect it and nothing
it holds can be registered twice:

```ts
/**
 * Shared fixtures for the batwoman render suites.
 *
 * The persona registry here is a verbatim copy of the three shipped registers,
 * injected through `resolvePersona({ registry })` so that no test reads
 * `ts/src/data/personas/registry.json` off disk (spec D7).
 *
 * It lives in a testkit rather than beside one of the suites because the
 * invariant suite and the render suite both need it, and importing one
 * `*.test.ts` from another would register its `describe` blocks twice.
 */
import type { PersonaRegistry } from '../src/core/persona.js';
import type {
  ClosureHeader,
  ExerciseVerdict,
} from '../src/analysis/batwoman/verdict.js';

export const FIXTURE_REGISTRY: PersonaRegistry = {
  version: 1,
  fallback: 'junior',
  minDetectionConfidence: 0.5,
  minDetectionSignals: 2,
  detectionMap: { sdet: 'sdet', manual: 'manual' },
  personas: [
    {
      id: 'sdet',
      label: 'Senior SDET',
      audience: 'Writes and owns automated tests daily.',
      depth: 'terse',
      formats: ['bullets', 'code'],
      reasoning: false,
    },
    {
      id: 'junior',
      label: 'Junior SDET',
      audience: 'Writes automated tests but is still building judgement.',
      depth: 'brief',
      formats: ['bullets', 'code', 'rationale'],
      reasoning: true,
    },
    {
      id: 'manual',
      label: 'Manual tester',
      audience: 'Tests by hand and reads test output.',
      depth: 'guided',
      formats: ['numbered-steps', 'rationale'],
      reasoning: true,
    },
  ],
};

export const HEADER: ClosureHeader = {
  issue: 749,
  mergeSha: '1e0c05b',
  mergeSubject: 'fix(ci): make the refresh-baseline label refresh the baseline',
  mergedAt: new Date('2026-08-22T17:34:00Z'),
};

export function v(
  file: string,
  status: ExerciseVerdict['status'],
  explanation = `${file} is ${status} because the fixture says so.`,
): ExerciseVerdict {
  return { file, status, explanation };
}

/** #749's real changed-file shape: 2 / 3 / 2 across three statuses. */
export const MIXED: ExerciseVerdict[] = [
  v(
    '.github/workflows/refresh-arch-baseline.yml',
    'not-exercised',
    'It last ran on 2026-08-10, twelve days before this fix merged, because ' +
      'it is triggered only by the `refresh-baseline` label.',
  ),
  v(
    'scripts/refresh-arch-baseline.mjs',
    'not-exercised',
    'It runs only from refresh-arch-baseline.yml, which has not run since ' +
      'the fix merged, so it has not run either.',
  ),
  v('ts/test/a.test.ts', 'no-probe', 'batwoman has no probe for a test file.'),
  v('ts/test/b.test.ts', 'no-probe', 'batwoman has no probe for a test file.'),
  v('harness.config.json', 'no-probe', 'batwoman has no probe for a config.'),
  v('AGENTS.md', 'not-applicable', 'A document has nothing to execute.'),
  v('CHANGELOG.md', 'not-applicable', 'A document has nothing to execute.'),
];
```

**2.** Create `ts/test/batwoman-render.test.ts`:

```ts
/**
 * The renderer, register by register. Every test injects a persona registry;
 * none reads the shipped registry from disk.
 */
import { describe, expect, it } from 'vitest';

import { summaryLine, wrap } from '../src/analysis/batwoman/render.js';
import { MIXED, v } from './batwoman-testkit.js';

describe('summaryLine', () => {
  it('prints one column per status plus the changed-file total', () => {
    expect(summaryLine(MIXED)).toBe(
      '7 changed · 0 exercised · 2 not exercised · 0 abstained · ' +
        '3 no probe · 2 n/a',
    );
  });

  it('sums its columns to the changed-file total', () => {
    const numbers = [...summaryLine(MIXED).matchAll(/(\d+) /g)].map((m) =>
      Number(m[1]),
    );
    const [total, ...columns] = numbers;
    expect(columns.reduce((a, b) => a + b, 0)).toBe(total);
  });

  it('prints every column on an all-exercised run, with no all-clear', () => {
    expect(summaryLine([v('a.yml', 'exercised')])).toBe(
      '1 changed · 1 exercised · 0 not exercised · 0 abstained · ' +
        '0 no probe · 0 n/a',
    );
  });

  it('prints every column on an empty run', () => {
    expect(summaryLine([])).toContain('0 changed');
    expect(summaryLine([])).toContain('0 abstained');
  });
});

describe('wrap', () => {
  it('breaks on word boundaries under the width', () => {
    const lines = wrap('one two three four five', 9, '');
    expect(lines.every((line) => line.length <= 9)).toBe(true);
    expect(lines.join(' ')).toBe('one two three four five');
  });

  it('keeps a word longer than the width on its own line', () => {
    expect(wrap('supercalifragilistic ok', 5, '')).toEqual([
      'supercalifragilistic',
      'ok',
    ]);
  });

  it('applies the indent to every line', () => {
    const lines = wrap('one two', 6, '..');
    expect(lines.every((line) => line.startsWith('..'))).toBe(true);
  });
});
```

**3.** Run `cd ts && npx vitest run test/batwoman-render.test.ts` — observe
failure.

**4.** Create `ts/src/analysis/batwoman/render.ts`:

```ts
/**
 * batwoman's report, rendered through canary's persona registry (spec D7).
 *
 * Two rules bind harder than anything else here, and both are asserted in
 * `ts/test/batwoman-render-invariants.test.ts` across all three registers
 * rather than once against the default:
 *
 * **There is no success-only path.** Every run ends with one column per status,
 * including the two that mean batwoman could not decide. A detector that
 * covered two of seven changed files and printed a clean token would be a pass
 * over a denominator of two presented as a pass over seven -- the exact defect
 * batwoman exists to catch, committed by batwoman (spec D5).
 *
 * **Every row keeps its sentence.** `ExerciseVerdict.explanation` renders in
 * every register, terse included. What the terse register drops is the material
 * gated by the persona's `reasoning` flag -- the evidence line and the
 * next-step guidance -- not the observation-and-cause sentence itself, which is
 * the difference between a verdict and a status code.
 */

import type { ResolvedPersona } from '../../core/persona.js';
import {
  EXERCISE_STATUSES,
  tallyVerdicts,
  type ClosureHeader,
  type ExerciseStatus,
  type ExerciseVerdict,
} from './verdict.js';

/** Column labels, in `EXERCISE_STATUSES` order. */
const SUMMARY_LABELS: Readonly<Record<ExerciseStatus, string>> = {
  exercised: 'exercised',
  'not-exercised': 'not exercised',
  abstain: 'abstained',
  'no-probe': 'no probe',
  'not-applicable': 'n/a',
};

/**
 * The one line every run prints.
 *
 * The changed-file total leads so the denominator is read before any count;
 * the render suite asserts the columns sum to it.
 */
export function summaryLine(verdicts: readonly ExerciseVerdict[]): string {
  const { changed, byStatus } = tallyVerdicts(verdicts);
  const columns = EXERCISE_STATUSES.map(
    (status) => `${byStatus[status]} ${SUMMARY_LABELS[status]}`,
  );
  return [`${changed} changed`, ...columns].join(' · ');
}

/** Greedy word wrap with a fixed indent. A too-long word gets its own line. */
export function wrap(text: string, width: number, indent: string): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/).filter((w) => w !== '')) {
    const candidate = current === '' ? word : `${current} ${word}`;
    if (indent.length + candidate.length <= width || current === '') {
      current = candidate;
    } else {
      lines.push(indent + current);
      current = word;
    }
  }
  if (current !== '') lines.push(indent + current);
  return lines;
}
```

**5.** Run `cd ts && npx vitest run test/batwoman-render.test.ts` — observe
pass.

**6.** Add **both** `"ts/src/analysis/batwoman/render.ts"` and
`"ts/test/batwoman-testkit.ts"` to **both** `entryPoints` arrays, alphabetically
(the testkit sorts before `ts/test/doc-links-testkit.ts`), keeping the arrays
identical. Run `cd ts && npx vitest run test/entropy-entrypoints.test.ts`.

**7.** Run
`cd ts && npx prettier --write src/analysis/batwoman test/batwoman-*.ts` and,
from the repo root, `npx prettier --write harness.config.json`; then
`harness validate`.

**8.** Commit:
`feat(batwoman): render the summary line with every status column`

### Task 8: The header, and which register spoke

**Depends on:** Task 7 | **Files:** `ts/test/batwoman-testkit.ts`,
`ts/test/batwoman-render.test.ts`, `ts/src/analysis/batwoman/render.ts`

**1.** Append the shared `render()` helper to `ts/test/batwoman-testkit.ts`,
moving its two new imports up to the import block:

```ts
import { resolvePersona } from '../src/core/persona.js';
import { renderReport } from '../src/analysis/batwoman/render.js';

/** Render one register over one verdict set, from the injected registry. */
export function render(
  explicit: string | null,
  verdicts: readonly ExerciseVerdict[] = MIXED,
): string {
  return renderReport({
    header: HEADER,
    repo: 'canary',
    verdicts,
    persona: resolvePersona({ explicit, registry: FIXTURE_REGISTRY }),
  });
}
```

**2.** Append to `ts/test/batwoman-render.test.ts`, importing `render` from the
testkit:

```ts
describe('the report header', () => {
  it('names the repo and issue, the closing sha and its subject', () => {
    const out = render('junior');
    expect(out).toContain('canary batwoman — canary#749');
    expect(out).toContain('1e0c05b');
    expect(out).toContain('make the refresh-baseline label refresh');
  });

  it('prints the merge timestamp', () => {
    expect(render('junior')).toContain('2026-08-22 17:34 UTC');
  });

  it('always ends with the summary line', () => {
    for (const id of ['sdet', 'junior', 'manual']) {
      expect(render(id).trimEnd().endsWith(summaryLine(MIXED))).toBe(true);
    }
  });
});

describe('persona provenance', () => {
  it('prints the register, its label and its source when chosen', () => {
    const out = render('sdet');
    expect(out).toContain('sdet');
    expect(out).toContain('explicit');
  });

  it('renders the registry fallback and says so when nothing is chosen', () => {
    const out = render(null);
    expect(out).toContain('junior');
    expect(out).toContain('fallback');
    expect(out).toContain("fell back to 'junior'");
  });

  it('reports an unknown register as the mistake it is, not as silence', () => {
    const out = render('architect');
    expect(out).toContain('junior');
    expect(out).toContain('architect');
  });
});
```

**3.** Run `cd ts && npx vitest run test/batwoman-render.test.ts` — observe
failure.

**4.** Append to `ts/src/analysis/batwoman/render.ts`:

```ts
/** Everything the renderer needs. Probes never see this. */
export interface RenderOptions {
  readonly header: ClosureHeader;
  readonly repo: string;
  readonly verdicts: readonly ExerciseVerdict[];
  readonly persona: ResolvedPersona;
}

/** `2026-08-22 17:34 UTC`, stable across the runner's timezone. */
function stamp(when: Date): string {
  return `${when.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function headerLines(options: RenderOptions): string[] {
  const { header, repo, persona } = options;
  return [
    `canary batwoman — ${repo}#${header.issue}`,
    '',
    `  Closed by  ${header.mergeSha}  ${header.mergeSubject}`,
    `  Merged     ${stamp(header.mergedAt)}`,
    // Printed so a reader who got terse output when they wanted guided output
    // can tell a short report from a truncated one (spec criterion 9).
    `  Register   ${persona.persona.id} (${persona.persona.label}) — ` +
      `${persona.source}: ${persona.reason}`,
    '',
  ];
}

/** Filled in by Tasks 9-11, one register at a time. */
function bodyLines(_options: RenderOptions): string[] {
  return [];
}

/** The whole report, as one string whose last content line is the summary. */
export function renderReport(options: RenderOptions): string {
  return [
    ...headerLines(options),
    ...bodyLines(options),
    '  ' + '─'.repeat(62),
    '  ' + summaryLine(options.verdicts),
    '',
  ].join('\n');
}
```

**5.** Run `cd ts && npx vitest run test/batwoman-render.test.ts` — observe
pass.

**6.** Run
`cd ts && npx prettier --write src/analysis/batwoman test/batwoman-*.ts`, then
`harness validate`.

**7.** Commit: `feat(batwoman): print the header and which register spoke`

### Task 9: The `junior` register — brief, with the evidence clause

**Depends on:** Task 8 | **Files:** `ts/test/batwoman-render.test.ts`,
`ts/src/analysis/batwoman/render.ts`

**1.** Append to `ts/test/batwoman-render.test.ts`:

```ts
describe('the junior register (brief, the declared fallback)', () => {
  it('groups rows under a heading naming the status and its count', () => {
    const out = render('junior');
    expect(out).toContain('NOT EXERCISED — 2 of 7 changed files');
    expect(out).toContain('NO PROBE — 3 files');
    expect(out).toContain('NOT APPLICABLE — 2 files');
  });

  it('omits a section with no rows rather than printing an empty one', () => {
    const out = render('junior');
    expect(out).not.toContain('ABSTAINED');
    expect(out).not.toContain('EXERCISED — 0');
  });

  it('carries each not-exercised row with its full sentence', () => {
    const out = render('junior');
    expect(out).toContain('.github/workflows/refresh-arch-baseline.yml');
    expect(out).toContain('twelve days before this fix merged');
    expect(out).toContain('`refresh-baseline` label');
  });

  it('names the artifact type on every no-probe row', () => {
    expect(render('junior')).toContain('test file');
  });

  it('adds the evidence clause, because the register wants reasoning', () => {
    const out = render('junior', [
      {
        file: 'ci.yml',
        status: 'abstain',
        explanation: 'The workflow probe could not decide, because gh failed.',
        evidence: 'gh run list --limit 100',
      },
    ]);
    expect(out).toContain('Read: gh run list --limit 100');
  });

  it('wraps prose rather than emitting one very long line', () => {
    const longest = Math.max(
      ...render('junior')
        .split('\n')
        .map((line) => line.length),
    );
    expect(longest).toBeLessThanOrEqual(78);
  });
});
```

**2.** Run `cd ts && npx vitest run test/batwoman-render.test.ts` — observe
failure.

**3.** Replace the `bodyLines` placeholder in
`ts/src/analysis/batwoman/render.ts`:

```ts
/** Section headings, in report order: the findings first. */
const SECTIONS: ReadonlyArray<readonly [ExerciseStatus, string]> = [
  ['not-exercised', 'NOT EXERCISED'],
  ['abstain', 'ABSTAINED'],
  ['no-probe', 'NO PROBE'],
  ['exercised', 'EXERCISED'],
  ['not-applicable', 'NOT APPLICABLE'],
];

/**
 * A section heading.
 *
 * The first finding section states its denominator inline; the rest are counted
 * against the same total one line below, in the summary that always prints.
 */
function heading(
  label: string,
  status: ExerciseStatus,
  rows: number,
  total: number,
): string {
  return status === 'not-exercised'
    ? `  ${label} — ${rows} of ${total} changed files`
    : `  ${label} — ${rows} files`;
}

function briefRows(
  verdicts: readonly ExerciseVerdict[],
  reasoning: boolean,
): string[] {
  const lines: string[] = [];
  for (const verdict of verdicts) {
    lines.push(`    ${verdict.file}`);
    lines.push(...wrap(verdict.explanation, 78, '      '));
    if (reasoning && verdict.evidence !== undefined) {
      lines.push(`      Read: ${verdict.evidence}`);
    }
    lines.push('');
  }
  return lines;
}

function bodyLines(options: RenderOptions): string[] {
  const { verdicts, persona } = options;
  const lines: string[] = [];
  for (const [status, label] of SECTIONS) {
    const rows = verdicts.filter((verdict) => verdict.status === status);
    // An empty section is omitted, not printed as a zero: the counts that
    // matter are in the summary line, which prints all five unconditionally.
    if (rows.length === 0) continue;
    lines.push(heading(label, status, rows.length, verdicts.length));
    lines.push(...briefRows(rows, persona.persona.reasoning));
  }
  return lines;
}
```

**4.** Run `cd ts && npx vitest run test/batwoman-render.test.ts` — observe
pass.

**5.** Run
`cd ts && npx prettier --write src/analysis/batwoman test/batwoman-*.ts`, then
`harness validate`.

**6.** Commit: `feat(batwoman): render the junior register`

### Task 10: The `sdet` register — terse, and still a sentence

**Depends on:** Task 9 | **Files:** `ts/test/batwoman-render.test.ts`,
`ts/src/analysis/batwoman/render.ts`

**1.** Append to `ts/test/batwoman-render.test.ts`:

```ts
describe('the sdet register (terse)', () => {
  it('is shorter than the junior register over the same verdicts', () => {
    expect(render('sdet').split('\n').length).toBeLessThan(
      render('junior').split('\n').length,
    );
  });

  it('renders findings as one bullet per row', () => {
    expect(render('sdet')).toContain(
      '  - .github/workflows/refresh-arch-baseline.yml  not-exercised',
    );
  });

  it('keeps the observation-and-cause sentence on every finding row', () => {
    // Terse drops the reasoning extras, never the sentence: a row without one
    // is a status code, which spec D4 rejects.
    expect(render('sdet')).toContain('twelve days before this fix merged');
  });

  it('drops the evidence clause, because it wants no reasoning', () => {
    const out = render('sdet', [
      {
        file: 'ci.yml',
        status: 'abstain',
        explanation: 'The workflow probe could not decide, because gh failed.',
        evidence: 'gh run list --limit 100',
      },
    ]);
    expect(out).not.toContain('Read:');
  });

  it('still prints the whole summary line', () => {
    expect(render('sdet')).toContain(
      '7 changed · 0 exercised · 2 not exercised',
    );
  });
});
```

**2.** Run `cd ts && npx vitest run test/batwoman-render.test.ts` — observe
failure.

**3.** In `ts/src/analysis/batwoman/render.ts`, add the terse row shape:

```ts
function terseRows(verdicts: readonly ExerciseVerdict[]): string[] {
  return verdicts.flatMap((verdict) => [
    `  - ${verdict.file}  ${verdict.status}`,
    ...wrap(verdict.explanation, 78, '    '),
  ]);
}
```

**4.** Inside the `bodyLines` loop, branch on depth before the brief path:

```ts
if (persona.persona.depth === 'terse') {
  lines.push(...terseRows(rows));
  continue;
}
```

**5.** Run `cd ts && npx vitest run test/batwoman-render.test.ts` — observe
pass.

**6.** Run
`cd ts && npx prettier --write src/analysis/batwoman test/batwoman-*.ts`, then
`harness validate`.

**7.** Commit: `feat(batwoman): render the sdet register`

### Task 11: The `manual` register — guided, with numbered next steps

**Depends on:** Task 10 | **Files:** `ts/test/batwoman-render.test.ts`,
`ts/src/analysis/batwoman/render.ts`

`[checkpoint:human-verify]` — after step 5, print all three registers over
`MIXED` side by side and show them. The spec's fourth goal is that the report
"read like a sentence a human wrote", which no assertion can settle. Pause for
confirmation before committing.

**1.** Append to `ts/test/batwoman-render.test.ts`:

```ts
describe('the manual register (guided)', () => {
  it('numbers the rows within each section', () => {
    const out = render('manual');
    expect(out).toContain('    1. .github/workflows/refresh-arch-baseline.yml');
    expect(out).toContain('    2. scripts/refresh-arch-baseline.mjs');
  });

  it('gives every not-exercised row an actionable next step', () => {
    const out = render('manual');
    expect(out).toContain('Next:');
    expect(out).toMatch(/Next: [A-Z][^\n]*/);
  });

  it('gives an abstain row a different next step from a no-probe row', () => {
    const stepOf = (out: string) =>
      out.split('Next: ')[1]?.split('\n')[0] ?? '';
    const abstained = stepOf(render('manual', [v('ci.yml', 'abstain')]));
    const unprobed = stepOf(render('manual', [v('x.ts', 'no-probe')]));
    expect(abstained).not.toBe('');
    expect(abstained).not.toBe(unprobed);
  });

  it('gives an exercised row no next step, having nothing to ask for', () => {
    expect(render('manual', [v('a.yml', 'exercised')])).not.toContain('Next:');
  });

  it('keeps the evidence clause, because the register wants reasoning', () => {
    const out = render('manual', [
      {
        file: 'ci.yml',
        status: 'abstain',
        explanation: 'The workflow probe could not decide, because gh failed.',
        evidence: 'gh run list --limit 100',
      },
    ]);
    expect(out).toContain('Read: gh run list --limit 100');
  });
});
```

**2.** Run `cd ts && npx vitest run test/batwoman-render.test.ts` — observe
failure.

**3.** In `ts/src/analysis/batwoman/render.ts`, add the guided shape:

```ts
/**
 * What a reader can actually do about each status.
 *
 * `exercised` and `not-applicable` are absent on purpose: there is nothing to
 * ask for, and inventing a step for them would be the guided register's version
 * of a success token.
 */
const NEXT_STEPS: Partial<Record<ExerciseStatus, string>> = {
  'not-exercised':
    'Run the path this file belongs to, then re-run canary batwoman to ' +
    'confirm it moved.',
  abstain:
    'Check the evidence source named above, then re-run canary batwoman so ' +
    'this file gets a verdict instead of a gap.',
  'no-probe':
    'Add an ExerciseProbe for this artifact type so the gap stops being ' +
    'uncountable, or confirm by hand that the file ran.',
};

function guidedRows(
  verdicts: readonly ExerciseVerdict[],
  status: ExerciseStatus,
): string[] {
  const lines: string[] = [];
  verdicts.forEach((verdict, index) => {
    lines.push(`    ${index + 1}. ${verdict.file}`);
    lines.push(...wrap(verdict.explanation, 78, '       '));
    if (verdict.evidence !== undefined) {
      lines.push(`       Read: ${verdict.evidence}`);
    }
    const step = NEXT_STEPS[status];
    if (step !== undefined) lines.push(...wrap(`Next: ${step}`, 78, '       '));
    lines.push('');
  });
  return lines;
}
```

**4.** Extend the depth branch in `bodyLines`:

```ts
if (persona.persona.depth === 'guided') {
  lines.push(heading(label, status, rows.length, verdicts.length));
  lines.push(...guidedRows(rows, status));
  continue;
}
```

**5.** Run `cd ts && npx vitest run test/batwoman-render.test.ts` — observe
pass. Then print all three registers for review, e.g. by adding a temporary
`console.log(render(id))` to a scratch run and removing it after.
`[checkpoint:human-verify]` — show all three, wait for confirmation.

**6.** Run
`cd ts && npx prettier --write src/analysis/batwoman test/batwoman-*.ts`, then
`harness validate`.

**7.** Commit: `feat(batwoman): render the manual register with numbered steps`

### Task 12: No success token, asserted separately per register

**Depends on:** Task 11 | **Files:**
`ts/test/batwoman-render-invariants.test.ts`

**1.** Create `ts/test/batwoman-render-invariants.test.ts`:

```ts
/**
 * The invariants that bind across every register (spec criteria 3, 8, 11).
 *
 * Kept in their own file and driven by `describe.each` over the three register
 * ids, so that adding a fourth register makes these fail rather than quietly
 * leaving it unasserted. Asserting once against the default is the failure this
 * file exists to prevent: terse output is where a bare check mark is most
 * tempting.
 */
import { describe, expect, it } from 'vitest';

import { summaryLine } from '../src/analysis/batwoman/render.js';
import type { ExerciseVerdict } from '../src/analysis/batwoman/verdict.js';
import { FIXTURE_REGISTRY, MIXED, render, v } from './batwoman-testkit.js';

const REGISTERS = ['sdet', 'junior', 'manual'] as const;

/** Glyphs match literally; words need boundaries so `look` is not `OK`. */
const GLYPHS = ['✓', '✔', '✅', '☑'];
const WORDS = [
  /\bOK\b/,
  /\bclean\b/i,
  /\bpassed\b/i,
  /\bsuccess(ful)?\b/i,
  /\ball clear\b/i,
  /\bno issues\b/i,
];

const CASES: ReadonlyArray<readonly [string, ExerciseVerdict[]]> = [
  ['a run with findings', MIXED],
  ['an all-exercised run', [v('a.yml', 'exercised'), v('b.yml', 'exercised')]],
  ['an all-not-applicable run', [v('AGENTS.md', 'not-applicable')]],
  ['an empty run', []],
];

describe.each(REGISTERS)('the %s register', (register) => {
  it.each(CASES)('prints no success glyph over %s', (_name, verdicts) => {
    const out = render(register, verdicts);
    for (const glyph of GLYPHS) expect(out).not.toContain(glyph);
  });

  it.each(CASES)('prints no success word over %s', (_name, verdicts) => {
    const out = render(register, verdicts);
    for (const word of WORDS) expect(out).not.toMatch(word);
  });

  it.each(CASES)('ends with the full summary line over %s', (_n, verdicts) => {
    const out = render(register, verdicts).trimEnd();
    expect(out.endsWith(summaryLine(verdicts))).toBe(true);
  });

  it.each(CASES)('sums its summary columns to the total over %s', (_n, vs) => {
    const numbers = [...summaryLine(vs).matchAll(/(\d+) /g)].map((m) =>
      Number(m[1]),
    );
    const [total, ...columns] = numbers;
    expect(columns.reduce((a, b) => a + b, 0)).toBe(total);
    expect(total).toBe(vs.length);
  });

  it('never folds abstain or no-probe into a decided figure', () => {
    const out = render(register, MIXED);
    expect(out).not.toMatch(/\bassessed\b/i);
    expect(out).not.toMatch(/\bdecided\b/i);
    expect(out).toContain('0 abstained');
    expect(out).toContain('3 no probe');
  });
});

it('asserts every register the fixture registry declares', () => {
  // A fourth register added to the registry without being added here would
  // leave the no-success-token rule unasserted for it -- the exact "asserted
  // once against the default" failure spec criterion 8 names.
  expect(FIXTURE_REGISTRY.personas.map((p) => p.id).sort()).toEqual(
    [...REGISTERS].sort(),
  );
});
```

**2.** Run `cd ts && npx vitest run batwoman` — observe pass, or, if a register
leaks a token, fix the **renderer** (never the assertion) and re-run.

**3.** Run
`cd ts && npx prettier --write src/analysis/batwoman test/batwoman-*.ts`, then
`harness validate`.

**4.** Commit:
`test(batwoman): forbid a success token in every persona register`

### Task 13: Complete sentences, and no disk access

**Depends on:** Task 12 | **Files:**
`ts/test/batwoman-render-invariants.test.ts`

**1.** Append to `ts/test/batwoman-render-invariants.test.ts`, adding
`import * as fs from 'node:fs';` and `vi` to the imports at the top:

```ts
describe.each(REGISTERS)('%s renders sentences, not codes', (register) => {
  it('gives every not-exercised row an observation and a cause', () => {
    // Asserted against the rendered string, not the verdict object: the goal is
    // what a human reads (spec criterion 11).
    const out = render(register, MIXED);
    expect(out).toContain('twelve days before this fix merged');
    expect(out).toContain('`refresh-baseline` label');
    expect(out).toContain('which has not run since');
  });

  it('gives every abstain row an observation and a cause', () => {
    const out = render(register, [
      {
        file: 'ci.yml',
        status: 'abstain',
        explanation:
          'The workflow probe could not decide whether ci.yml ran, because ' +
          'the run history it fetched did not reach back past the merge.',
      },
    ]);
    expect(out).toContain('could not decide');
    expect(out).toContain('because');
  });

  it('never renders a bare status with no file or count beside it', () => {
    // An empty explanation is a defect upstream, but the renderer must not turn
    // it into a tidy-looking row: the file still appears, and the summary still
    // counts it.
    const out = render(register, [v('x.yml', 'not-exercised', '')]);
    expect(out).toContain('x.yml');
    expect(out).toContain('1 not exercised');
  });
});

describe('offline guarantee', () => {
  it('renders every register from the injected registry, reading no disk', () => {
    const spy = vi.spyOn(fs, 'readFileSync');
    try {
      for (const register of REGISTERS) render(register, MIXED);
      const reads = spy.mock.calls.map((call) => String(call[0]));
      expect(reads.filter((path) => path.includes('personas'))).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});
```

**2.** Run `cd ts && npx vitest run batwoman` — observe failure first if a
register drops a sentence, then pass.

**3.** Run
`cd ts && npx prettier --write src/analysis/batwoman test/batwoman-*.ts`, then
`harness validate`.

**4.** Commit: `test(batwoman): assert full sentences and no registry disk read`

### Task 14: The gate sweep and the ratchet measurement

**Depends on:** Task 13 | **Files:** `harness.config.json` (verify only),
`.harness/arch/allowances/*.json` (only if a regression is measured) |
**Category:** integration

`[checkpoint:human-verify]` — the arch measurement below is a decision point,
not a formality. Show the numbers and stop.

**1.** From the worktree, run the four gates in order and record each result.
There is no `lint` script; do not invent one. Do not use `--no-verify` anywhere.

```bash
cd ts && npm run build && npm run typecheck && npm run format:check && npm run test
```

**2.** Confirm the coverage floors still hold (`lines 95`, `functions 96`,
`branches 87`, `statements 94`). New renderer branches are the likely pressure
point; if branches dip, add the missing register/status case as a test — never
lower a floor.

**3.** From the repo root (this worktree only, never the shared checkout):

```bash
harness check-deps
harness validate
harness check-arch --json > /tmp/batwoman-arch.json 2>&1 || true
```

**4.** Read `currentValue` for `module-size` out of the JSON rather than
grepping for the absence of a string — pass/fail cannot measure a magnitude.
Compare against the **effective ceiling**, which is the highest allowance, not
the floor `check-arch` prints as its left operand:

```bash
node -e "const fs=require('fs'),p='.harness/arch/allowances/';
  console.log(Math.max(...fs.readdirSync(p)
    .map(f=>JSON.parse(fs.readFileSync(p+f,'utf8')).categories?.['module-size'])
    .filter(Boolean)))"
```

**5.** Confirm the four new entry points are reachable roots, not dead code. If
entropy reports the new modules as unreachable, the fix is a missing or
misspelled `entryPoints` line — in **both** arrays — never a higher
`maxFindings`.

```bash
cd ts && npx vitest run test/entropy-entrypoints.test.ts
harness ci check
```

**6.** `[checkpoint:human-verify]` — report the four gate results, coverage
deltas, `module-size` current value vs. effective ceiling and the real
contribution (`current − ceiling`), and the entropy finding count. If an arch
allowance is needed, propose it with the **real** delta in its `reason`, not the
printed arrow, and wait for approval before writing it.

**7.** Commit only if step 6 produced a file:
`chore(arch): allow batwoman phase 1's module-size contribution`

## Traceability

| Observable truth | Delivered by        |
| ---------------- | ------------------- |
| 1                | Task 1              |
| 2                | Tasks 3, 5, 9       |
| 3                | Task 2              |
| 4                | Tasks 2, 7, 12      |
| 5                | Task 6              |
| 6                | Tasks 7, 8, 12      |
| 7                | Task 12             |
| 8                | Tasks 9, 10, 11, 13 |
| 9                | Task 8              |
| 10               | Tasks 7, 13         |
| 11               | Task 14             |

## Deferred to Later Phases (do not do here)

- The `workflow`, `workflow-script` and `no-execution` probes, and `on:`-block
  parsing — Phase 2.
- The `gh`-backed `RunHistoryPort`, the truncated-history abstention, and the
  deleted-file `not-applicable` case — Phase 3.
- `canary batwoman --issue N [--json]`, its CLI registration, and criterion 3's
  application to the JSON output path — Phase 4.
- `SKILL.md`, the harness persona declaration, the generated workflow and its
  drift assertion, the `unexercised` label, `AGENTS.md` / `README.md` /
  `CHANGELOG.md` updates, and the three ADRs — Phase 5.
