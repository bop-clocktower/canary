---
name: canary-savant
description:
  Order-dependence and isolation detector for test suites. A Tier-1 static
  scanner flags the shared-state smells which predict order-dependent tests - a
  module-level mutable a test writes to, a setup with no matching teardown, a
  mutated process singleton, an order-coupled name - with no test execution, so
  it runs anywhere node does and on every PR. An opt-in Tier-2 confirmer
  (--confirm) shuffles the suite under a pinned seed and bisects the prefix to
  name the polluting test. Advisory by default; pytest and vitest idioms.
cli: scripts/cli.mjs
requires: [node>=20]
---

# Canary Savant

A test that only passes because of the tests that ran before it is a lie that
passes CI. Savant finds shared-state leakage and names the culprit. **Tier 1**
is the cheap, static half that runs on every PR and points at the _suspects_.
**Tier 2** (`--confirm`, opt-in) proves a leak by shuffling the suite under a
pinned seed and bisecting the prefix to name the polluter — not just the victim.

Tier-0 in the real sense: no LLM, no network, no secrets, no dependency on any
other skill.

## Rules (Tier 1 — static suspects)

| Rule                              | Severity | Fires on                                                                                                                                                                                                                                                     |
| --------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SV001-module-mutable-global`     | medium   | A module-scope mutable (`= {}`, `= []`, `set()`, `dict()`, `list()`, or a top-level JS `let`/`var`/`const` object/array) that some line later mutates in place (`.append`/`.add`/`[...] =`/`+=`/`.attr =`). Fires on the **declaration**, the leak's source. |
| `SV002-missing-teardown`          | medium   | A **class/all-scoped** setup whose matching teardown is absent: pytest `setup_class`/`setUpClass`, or vitest/jest `beforeAll`. Per-test setup (`setUp`/`setup_method`/`beforeEach`) is excluded - it rebuilds state each test, so it does not leak.          |
| `SV003-shared-singleton-mutation` | low      | A process-global singleton assigned without restore: `os.environ[...] =`, `sys.modules[...] =`, `process.env.X =`. Reads and `==` comparisons never fire.                                                                                                    |
| `SV004-order-coupled-name`        | low      | A test name or comment that encodes ordering: `test_1_…`, a **terminal** ordinal (`test_first()`, `test_last()` - not `test_first_match_wins`), `must run before …`, `it('… run first')`.                                                                    |

A finding is a **suspect, not a verdict.** A module dict that is only ever read
is a legitimate constant and does not fire; only a _mutated_ one does.

## Framework conditioning

The setup/teardown idioms (`SV002`) differ by ecosystem, so the rule is
conditioned on the file: Python files are read with pytest/unittest markers, JS
and TS with vitest/jest markers. The idioms do not collide across languages, so
each file is judged by its own ecosystem's conventions.

## Fidelity limits (AST-lite, on purpose)

Savant Tier 1 is a scanner with no parser dependency, so it ships anywhere
`node` does. The cost, stated plainly:

- **`SV001` mutation is file-scoped, not flow-scoped.** Any in-place mutation of
  a module-level name anywhere in the file indicts the declaration, even if the
  mutation sits in a helper rather than a test body. A shared-state leak is a
  shared-state leak regardless of which function does the writing.
- **`SV002` is presence-based, not pairing-based.** A file with one `setUpClass`
  and one `tearDownClass` is considered balanced even if a _second_ class lacks
  teardown. It also only judges class/all-scoped setup, so a genuinely leaky
  per-test setup (rare) is missed - the deliberate false-positive/false-negative
  trade from dogfooding.
- **Comment-blind for code rules.** `SV003` skips commented-out lines; `SV004`
  deliberately does not, because an ordering note in a comment is exactly the
  self-reported dependence it looks for.
- **Line-scoped.** A declaration or call split across lines can be missed.
- **A missed suspect costs less than a false one** — the same bias as
  canary-blackhawk.

## Which files get scanned

A directory walk only visits **test** files — `*.test.*`, `*.spec.*`,
`test_*.py`, `*_test.py`, or any supported source under `tests/`, `test/`,
`__tests__/`, `e2e/`, `spec/`. A file named explicitly on the command line is
always scanned. Supported suffixes: `.py`, `.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`,
`.cjs`. Dependency directories (`node_modules`, `.venv`, …) are never walked.

## Invocation

```bash
# Scan the repo's test files (advisory - always exits 0):
canary skills run canary-savant

# Scan a specific suite:
canary skills run canary-savant -- tests/unit

# Machine-readable findings:
canary skills run canary-savant -- tests --json

# Fail the step on any suspect:
canary skills run canary-savant -- tests --strict
```

### Tier 2 — dynamic confirmation (`--confirm`, opt-in)

`--confirm` runs the suite in declared order, re-runs it shuffled under a pinned
seed, and for each order-dependent victim runs it alone and **bisects the prefix
to name the polluter** — the earlier test whose state leaked. Opt-in because a
shuffled re-run at least doubles wall-clock; always prints the seed and a
copy-pasteable reproduce command.

```bash
# Confirm order-dependence, pinning the seed for reproducibility:
canary skills run canary-savant -- tests --confirm --seed 424242
```

**pytest and vitest** are both supported; savant auto-detects from the target
(extensions, then a directory scan, then config files). pytest needs a shuffle
plugin (`pytest-randomly` or `pytest-random-order`) and declines loudly if none
is installed; vitest's shuffle is built in (`--sequence.shuffle`), so no plugin
is required. Node drives the project's _own_ runner — savant orchestrates it, it
does not run in the target's language.

**Polluter bisect is pytest-only.** vitest has no CLI-driven ordered per-test
execution, so a vitest target gets victim _detection_ (which tests break under
shuffle) but not culprit _naming_. For pytest, node ids are captured via
`--collect-only`, so class-based layouts (`file.py::Class::test`) re-run
correctly.

`--json` shape:

```json
{
  "schema_version": 1,
  "findings": [
    {
      "file": "tests/test_cache.py",
      "line": 3,
      "rule_id": "SV001-module-mutable-global",
      "severity": "medium",
      "snippet": "_CACHE = {}",
      "why": "a module-level mutable is written by a test, so state leaks into whatever test runs next"
    }
  ],
  "summary": {
    "files_scanned": 8,
    "findings": 1,
    "by_severity": { "medium": 1 }
  }
}
```

## Fixing what it finds

| Finding | Fix                                                                                                                                             |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `SV001` | Move the mutable into a fixture that rebuilds it per test, or reset it in teardown. Module-level mutable state shared across tests is the leak. |
| `SV002` | Add the matching teardown (`teardown_method`, `afterEach`, a `yield` fixture) so acquired state is released.                                    |
| `SV003` | Use a restoring helper — pytest `monkeypatch.setenv`, or save/restore around the test — instead of assigning the global directly.               |
| `SV004` | Make the test self-contained so order stops mattering, then drop the ordering hint from the name/comment.                                       |

## Dogfooding and the `--strict` promotion path

canary runs savant's Tier-1 scan over its **own** test suite on every PR
(`.github/workflows/harness-quality.yml`, the `Skills (JS)` job), **advisory**:
it prints suspects to the log and always exits 0. Tuning the rules against that
real suite dropped the backlog from 37 findings to a handful of genuine
suspects. Promote to blocking by appending `--strict` to that step once the
remaining suspects are triaged (fixed or confirmed benign) - the same
advisory-first path every canary gate takes.

## Roadmap

- **Shipped:** Tier 1 static scan; Tier 2 dynamic confirmer (baseline → shuffle
  → classify) with isolation + polluter bisect (pytest); vitest as a Tier-2
  classify target; pytest node-id capture for class-based layouts; advisory CI
  gate dogfooded on canary's own suite (rules tuned to kill the dominant false
  positives).
- **Remaining:** flip the advisory gate to `--strict` once the suspect backlog
  is triaged; vitest polluter naming is out of scope until vitest gains ordered
  per-test execution. See `docs/changes/canary-savant/proposal.md`.
