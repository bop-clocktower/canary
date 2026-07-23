# canary-savant — order-dependence and isolation detector

- **Status:** shipped — all 5 phases delivered (static scan, dynamic confirmer,
  isolation + polluter bisect, vitest classify + pytest node-id fidelity,
  advisory CI gate). Only the advisory→`--strict` flip remains, gated on
  triaging the small suspect backlog.
- **Roadmap:** BoP-themed skills batch, ideation rank 2 (score 6.75),
  `docs/ideation/bop-themed-canary-skills-2026-07-21.md`
- **Siblings for pattern reference:**
  `agents/skills/claude-code/canary-blackhawk/`,
  `agents/skills/claude-code/canary-katana/`

## Implementation language (JS/Node)

canary-savant is implemented in **ESM JavaScript** (`cli: scripts/cli.mjs`,
`requires: [node>=20]`), per the project decision that new work is JS/TS —
canary is meant to mirror harness, and harness is a Node/TS package. The skill
scripts are directly-runnable `.mjs` (the skill runner execs `cli:` via its
shebang), and the vitest suite lives in the `agents/skills/` project. This is
the first JS skill; its test harness is the template future JS skills adopt. The
blackhawk/katana siblings are still Python (pre-decision) and are tracked
separately for migration. Savant still shells out to the _project's own_ pytest
or vitest for Tier 2 — it orchestrates the target's runner, it does not run in
the target's language.

## Problem

A test that only passes because of the tests that ran before it is a lie that
passes CI. It leaks: a module-level global, an un-torn-down fixture, a shared
singleton, a row left in a table. The suite is green today because the runner
happens to visit the polluter before the victim. Reorder the suite — a new test
file, a parallel shard, a different machine — and the victim fails for reasons
that have nothing to do with the victim's own code. This is one of the most
expensive classes of flake because the failing test is never the guilty test.

Savant finds order-dependence and shared-state leakage, and — the part that
makes it worth building over a stock shuffle plugin — **names the polluter, not
just the victim.**

## Why this is not a rename of the v5.11.0 isolation work

Verified and cleared during ideation (2026-07-21): the v5.11.0 concern was
commit `8c5835f`, which isolated one test class in canary's _own_ suite
(`tests/unit/test_skill_registry.py`, +39 lines). That was suite hygiene, not a
user-facing capability. No shuffle or order-dependence code exists anywhere in
`agent/`. Savant is a genuinely new capability.

## Why this is not a rename of `pytest-randomly`

A stock shuffle plugin tells you _that_ a run failed under seed N. It does not
tell you _which earlier test_ poisoned the state, and it does not run anywhere
the plugin is not installed. Savant's differentiators:

1. **Polluter identification** — once a victim is found, savant minimizes the
   prefix of tests-run-before it to name the specific culprit (see Tier 2).
2. **A cheap static tier** that flags likely offenders with no test execution at
   all, so there is signal even before (and without) a dynamic run.
3. **Framework-conditioned** orchestration via `agent/frameworks/registry.json`,
   consistent with blackhawk.

## Determinism: what "Tier-0" means for a skill that runs tests

blackhawk and katana are static scanners; they never execute the system under
test, so they are deterministic in the ordinary sense. Savant executes the
suite, and the entire point is to surface non-deterministic outcomes. So for
savant, **"deterministic" means the _tool_ is reproducible, not that outcomes
are**: given a seed, savant produces the same shuffle order and therefore the
same finding. Every dynamic finding ships with the seed and an exact reproduce
command. Tier-0 still holds in its real sense — **no LLM, no network, no
secrets** — savant only ever shells out to the project's own test runner.

## Architecture — two tiers

### Tier 1 — static suspect scan (always-on, per-PR, runs anywhere)

A line/AST-lite scanner in the blackhawk mold: no test execution, ships wherever
`node` does, cheap enough to run on every PR. It flags shared-state smells that
_predict_ order-dependence.

| Rule                              | Severity | Fires on                                                                                                                                                                             |
| --------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SV001-module-mutable-global`     | medium   | A module-scope mutable (`list`/`dict`/`set` literal, or a bare `=` reassign to a module global) that a test body mutates.                                                            |
| `SV002-missing-teardown`          | medium   | A fixture / `beforeAll` / `setUpClass` that acquires state (opens, connects, writes, `.append`, monkeypatch) with no matching teardown (`yield`+after, `afterAll`, `tearDownClass`). |
| `SV003-shared-singleton-mutation` | low      | Mutation of a known process-global singleton (env via `os.environ[...] =`, `sys.modules`, a cached module-level client) inside a test without restore.                               |
| `SV004-order-coupled-name`        | low      | A test name or comment that encodes ordering intent (`test_1_`, `test_first`, `# must run before`).                                                                                  |

Tier 1 is advisory-only and framework-conditioned for its markers (pytest vs
vitest teardown idioms differ). It shares blackhawk's stated fidelity limits
(line-scoped, comment-blind one level deep, string-blind, substring suppression)
and inherits the same "a missed finding costs less than a false one" bias.

### Tier 2 — dynamic confirmer (opt-in / scheduled)

Because a shuffled re-run at least doubles suite wall-clock, Tier 2 never runs
by default. It is invoked explicitly (`--confirm`) or on a schedule. Algorithm:

1. **Baseline.** Run the suite in declared order, record the pass/fail set `B`.
   If a test already fails in-order, it is not an order problem — report and
   exclude it.
2. **Shuffle.** Run the suite under a pinned seed using the framework's _own_
   shuffle (never reimplemented):
   - pytest → `-p randomly --randomly-seed=<N>` (fallback: `pytest-random-order`
     `--random-order-seed=<N>`).
   - vitest → `--sequence.shuffle --sequence.seed=<N>`. Record pass/fail set
     `S`.
3. **Classify** each test:
   - passed in `B`, failed in `S` → **order-dependent victim** (candidate).
   - failed in both same-seed reruns → **nondeterministic flake**, not order;
     labeled and handed off (out of savant's fix scope).
4. **Isolate.** Re-run each victim _alone_ (repeated `--isolate-repeats`,
   default 3×). Passes alone → confirms shared-state leakage from another test.
5. **Bisect the polluter.** For a confirmed victim, take the ordered list of
   tests that ran before it under seed `N` and bisect: run
   `[prefix-half] + [victim]`, halve toward the minimal prefix that still
   reproduces the failure. The last test whose presence flips the victim from
   pass to fail is reported as the **polluter**. Bounded by `--bisect-max-steps`
   (default `log2(n)+2`); on exhaustion, report the smallest reproducing prefix
   instead of a single culprit, stated honestly.

Every Tier-2 finding carries: seed, victim, polluter (or minimal prefix), and a
copy-pasteable reproduce command.

## Honest degradation (prerequisites)

Tier 2 needs the project's real test environment (deps installed, DB/fixtures
available) and the framework's shuffle capability. Savant must **detect and
decline loudly**, never guess:

- Framework detected but shuffle plugin absent (e.g. neither `pytest-randomly`
  nor `pytest-random-order` importable — the current state of this very repo) →
  exit with a clear "install one of X to enable Tier 2" message, Tier 1 still
  runs.
- Framework detected but unsupported in v1 (playwright, wdio, jest, …) → "Tier 2
  supports pytest and vitest in v1; detected `<other>`" message, non-zero only
  under `--strict`.
- Baseline itself red → "suite is not green in declared order; fix that first",
  since order-dependence is undefined over an already-failing suite.

## Framework support matrix (v1)

| Framework         | Tier 1 static       | Tier 2 dynamic      | Mechanism                                             |
| ----------------- | ------------------- | ------------------- | ----------------------------------------------------- |
| pytest            | yes                 | yes                 | `-p randomly --randomly-seed` / `--random-order-seed` |
| vitest            | yes                 | yes                 | `--sequence.shuffle --sequence.seed`                  |
| others (detected) | best-effort markers | declined w/ message | —                                                     |

## Invocation

```bash
# Tier 1 only — static suspect scan (advisory, exits 0):
canary skills run canary-savant -- tests

# Tier 1 + Tier 2 confirm on a pinned seed:
canary skills run canary-savant -- tests --confirm --seed 424242

# Machine-readable:
canary skills run canary-savant -- tests --confirm --json

# Fail the step on any confirmed order-dependence:
canary skills run canary-savant -- tests --confirm --strict
```

Flags: `--confirm` (enable Tier 2), `--seed N` (pin; default derived and always
printed), `--isolate-repeats K` (default 3), `--bisect-max-steps M`, `--strict`
(non-zero exit on findings), `--json`.

## `--json` shape

```json
{
  "schema_version": 1,
  "seed": 424242,
  "static_findings": [
    {
      "file": "tests/test_cache.py",
      "line": 8,
      "rule_id": "SV001-module-mutable-global",
      "severity": "medium",
      "snippet": "_CACHE = {}",
      "why": "module-level mutable mutated by a test; leaks into later tests"
    }
  ],
  "dynamic_findings": [
    {
      "victim": "tests/test_user.py::test_default_role",
      "polluter": "tests/test_admin.py::test_grants_admin",
      "classification": "order-dependent",
      "passes_alone": true,
      "reproduce": "pytest -p randomly --randomly-seed=424242 tests/test_admin.py::test_grants_admin tests/test_user.py::test_default_role"
    }
  ],
  "summary": {
    "framework": "pytest",
    "tier2_ran": true,
    "static": { "medium": 1 },
    "victims": 1,
    "polluters_named": 1,
    "nondeterministic": 0
  }
}
```

## Non-goals (scope cuts)

- **No auto-fix.** Savant reports the victim/polluter and a reproduce command;
  fixing shared state is the engineer's call.
- **No persistent history / flake DB.** That is `canary-clocktower` /
  `canary-signal` territory; savant is stateless per run.
- **No suite parallelization or speed work.** Savant characterizes ordering, it
  does not optimize the run.
- **No general flake hunting.** Nondeterministic-but-order-independent flakes
  are labeled and handed off, not diagnosed.

## Soundness risks

1. **Bisect cost blow-up** on large suites → bounded by `--bisect-max-steps`;
   degrade to "smallest reproducing prefix" rather than an unbounded search.
2. **False polluter under multi-test collusion** (state accreted across several
   tests) → bisect reports the minimal _set_/prefix, and the report states
   explicitly when a single culprit could not be isolated.
3. **Tier-1 false positives** (a global that is actually reset) → advisory-only,
   low/medium severity, blackhawk-style substring suppression when a teardown
   marker is present in the file.
4. **Seed non-portability** — a pytest-randomly seed and a random-order seed are
   not interchangeable → the reproduce command always embeds the exact plugin
   and flag used, never a bare seed number.
5. **Doubles wall-clock** — accepted; the entire reason Tier 2 is opt-in.

## Proposed phasing (TDD)

1. ✅ **Skill scaffold + Tier-1 static scanner** (`SV001`–`SV004`, framework
   detection, `--json`, tests). Ships value with zero execution risk. _(shipped
   in JS — #406.)_
2. ✅ **Tier-2 baseline+shuffle runner** (pytest first: invoke, parse pass/fail,
   classify; honest degradation when plugin absent). _(shipped — #406.)_
3. ✅ **Isolation re-run + polluter bisect** (the differentiator). Pure
   `bisectPolluter`/`isolationConfirms` + injectable `locatePolluters`; real
   subprocess seams in `realPolluterSeams`. Known gap: class-based classname →
   node-id mapping (see Phase 4).
4. ✅ **vitest as a Tier-2 classify target** (built-in `--sequence.shuffle`, no
   plugin) + **pytest node-id capture** via `--collect-only` (fixes class-based
   re-runs). _(shipped.)_ Polluter bisect stays pytest-only: vitest has no
   CLI-driven ordered per-test execution.
5. ✅ **Docs + CI wiring.** Advisory Tier-1 gate dogfooded on canary's own suite
   in the `Skills (JS)` CI job; tuning against that real suite cut the backlog
   37 → 6 (SV002 narrowed to class/all-scoped, SV004 ordinals must be terminal).
   `--strict` promotion is a one-line follow-up once the 6 remaining suspects
   are triaged. _(shipped.)_
