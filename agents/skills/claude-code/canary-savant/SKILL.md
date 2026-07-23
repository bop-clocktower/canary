---
name: canary-savant
description:
  Order-dependence and isolation detector for test suites. Phase 1 (this
  release) is a Tier-1 static scanner that flags the shared-state smells which
  predict order-dependent tests - a module-level mutable a test writes to, a
  setup with no matching teardown, a mutated process singleton, an order-coupled
  name - with no test execution, so it runs anywhere python3 does and on every
  PR. Advisory by default, framework-conditioned for pytest and vitest idioms.
cli: scripts/cli.py
requires: [python3>=3.10]
---

# Canary Savant

A test that only passes because of the tests that ran before it is a lie that
passes CI. Savant finds shared-state leakage and names the culprit. This release
ships **Tier 1** — the cheap, static half that runs on every PR and points at
the _suspects_. The dynamic confirmer that proves a leak by shuffling the suite
and bisecting the polluter is **Tier 2**, opt-in, and lands in a later phase.

Tier-0 in the real sense: no LLM, no network, no secrets, no dependency on any
other skill.

## Rules (Tier 1 — static suspects)

| Rule                              | Severity | Fires on                                                                                                                                                                                                                                                     |
| --------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SV001-module-mutable-global`     | medium   | A module-scope mutable (`= {}`, `= []`, `set()`, `dict()`, `list()`, or a top-level JS `let`/`var`/`const` object/array) that some line later mutates in place (`.append`/`.add`/`[...] =`/`+=`/`.attr =`). Fires on the **declaration**, the leak's source. |
| `SV002-missing-teardown`          | medium   | A setup marker whose matching teardown is absent from the file: pytest `setup_method`/`setup_class`/`setUp`/`setUpClass`, or vitest/jest `beforeEach`/`beforeAll`.                                                                                           |
| `SV003-shared-singleton-mutation` | low      | A process-global singleton assigned without restore: `os.environ[...] =`, `sys.modules[...] =`, `process.env.X =`. Reads and `==` comparisons never fire.                                                                                                    |
| `SV004-order-coupled-name`        | low      | A test name or comment that encodes ordering: `test_1_…`, `test_first`, `must run before …`, `it('… run first')`.                                                                                                                                            |

A finding is a **suspect, not a verdict.** A module dict that is only ever read
is a legitimate constant and does not fire; only a _mutated_ one does.

## Framework conditioning

The setup/teardown idioms (`SV002`) differ by ecosystem, so the rule is
conditioned on the file: Python files are read with pytest/unittest markers, JS
and TS with vitest/jest markers. The idioms do not collide across languages, so
each file is judged by its own ecosystem's conventions.

## Fidelity limits (AST-lite, on purpose)

Savant Tier 1 is a scanner with no parser dependency, so it ships anywhere
`python3` does. The cost, stated plainly:

- **`SV001` mutation is file-scoped, not flow-scoped.** Any in-place mutation of
  a module-level name anywhere in the file indicts the declaration, even if the
  mutation sits in a helper rather than a test body. A shared-state leak is a
  shared-state leak regardless of which function does the writing.
- **`SV002` is presence-based, not pairing-based.** A file with one `setUp` and
  one `tearDown` is considered balanced even if a _second_ class lacks teardown.
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

## Roadmap

- **Tier 2 (next):** opt-in dynamic confirmer — baseline in declared order,
  re-run shuffled under a pinned seed, run suspects alone, and bisect the prefix
  to name the polluter (not just the victim), with a copy-pasteable reproduce
  command. pytest first, then vitest. See
  `docs/changes/canary-savant/proposal.md`.
