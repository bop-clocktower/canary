---
name: canary-cassandra
description: >
  Vacuous-test detection — finds tests that PASS WITHOUT PROVING ANYTHING: an
  assertion that compares a value with itself, a test that never invokes the
  target it claims to cover, and a test whose every assertion is an absence
  observed on a bystander rather than on the code under test. Use when the user
  says "why did this pass against the bug", "are these tests actually testing
  anything", "audit my suite for vacuous tests", "green but worthless", or after
  a bug shipped through a green suite. Advisory and deterministic — no LLM, no
  execution. NOT for tests with zero assertions (that is `canary review-test`'s
  LINT-006), NOT for flaky tests (canary-flake-hunter), and NOT a coverage tool
  — a vacuous test has coverage, which is exactly why coverage never caught it.
requires: [node>=20]
---

# Canary Cassandra

> Cassandra Cain reads the fake. So does this skill.

A test with no assertions is easy to find and everybody already looks for it.
The dangerous test is the one with assertions that **cannot fail** — it has
coverage, it goes green, and it goes green identically against the bug it was
written to catch. Three of those shipped in this project in a single cycle
(recorded in [#486]) and every gate the repo owned read all three as healthy.

Cassandra is Tier-0: deterministic, no LLM, no network, no execution.

## What it finds

| Rule      | Severity | Fires on                                                                                                          |
| --------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `VAC-001` | critical | An assertion whose expectation is identical to the value it checks — `expect(true).toBe(true)`, `assert x == x`   |
| `VAC-002` | warning  | The test never references the target it claims to cover                                                           |
| `VAC-003` | warning  | Every assertion in the test asserts an _absence_, and none of them observes the target — so nothing proves it ran |

`VAC-001` is deterministic, hence `critical`: no implementation can fail it.
`VAC-002` and `VAC-003` depend on resolving a target, which is inference, so
they are `warning` and carry a fidelity tier.

## Run it

```bash
canary vacuity-check tests/            # human-readable
canary vacuity-check tests/ --json     # verdict + denominator + skips
canary vacuity-check tests/a.test.ts   # one file
```

**Advisory by design.** Findings exit **0**. This is the repo's established
shape for a new detector — advisory first, ratchet to strict only after triage
(see the dogfooding jobs, [#485]). Do not wire it as a required check on the day
you adopt it; run it, triage the count, then decide.

A collapsed denominator is **not** advisory and exits **3**. See below.

## The fidelity ladder (the part that decides whether to trust a finding)

A test's "declared target" is declared nowhere, so `VAC-002`/`VAC-003` have to
resolve one. Three rungs, and the finding says which one it used:

| Tier              | How the target was resolved                                                                   | Trust                                 |
| ----------------- | --------------------------------------------------------------------------------------------- | ------------------------------------- |
| `annotated`       | The author wrote `// @covers <symbol>`. That exact symbol is checked.                         | High — the author stated the contract |
| `import-inferred` | The symbols imported from first-party (relative) modules, closed over local helpers           | Medium — read the test before acting  |
| _(skipped)_       | Neither available. Reported as a skip with its reason; the test is **not** reported as clean. | None — the check did not run          |

To upgrade a finding from inferred to annotated, add the annotation above the
test:

```ts
// @covers resolveOverlay
it('falls back to the tracked overlay', () => {
  /* ... */
});
```

That is also the fix for a false positive: if the target is reached several
frames deep and the inference cannot see it, `@covers` tells the check what to
look for instead of arguing with the heuristic.

## Why a zero denominator exits 3

The whole point of this skill is that **green can mean nothing**. A vacuity
detector that reported its own silence as success would be the joke telling
itself, so:

- **No test file matched** → exit 3, `Abstained — verified zero items`.
- **Files matched but held zero tests** → also exit 3. This is the subtler zero:
  the file-level count looks healthy, and a scanner that only guarded that one
  prints a clean tick.
- **A test whose target could not be resolved** → a `skipped` entry naming the
  test and the reason, rendered in every summary line.

`checked` in the JSON payload is the number of **tests** read, not files. Always
read it before believing a zero.

## Reading the output

```text
[CRITICAL] tests/cli.test.ts:41 (VAC-001)
  --help does not write the ledger: Assertion compares a value with itself; no implementation can fail it.
  → Assert the value the code under test should have produced, not the input.

3 finding(s) across 214 checked (11 skipped: VAC-002/VAC-003 (adds two numbers) [target unresolvable: ...])
```

The summary line always carries the denominator and the skips. A finding count
with no denominator is not a result.

## Rationalizations to reject

| Rationalization                                          | Why it is wrong                                                                                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| "It's covered, so it's tested"                           | A vacuous test executes the line and asserts nothing about it. Coverage is the reason this class survives — it satisfies the metric perfectly.    |
| "VAC-002 flagged a test I know is correct, so it's junk" | Add `// @covers <symbol>`. That converts a guess into a checked claim, permanently, for every future run.                                         |
| "0 findings, we're clean"                                | Only if `checked` is greater than zero. Read the denominator; exit 3 means the check never ran.                                                   |
| "We'll make it a required check right away"              | A new detector lands advisory. Triage the existing count first, then ratchet — otherwise the first red build teaches the team to bypass the gate. |
| "The absence assertion is fine, the test passes"         | That is the `VAC-003` defect exactly: it also passed when the code exited before doing anything. One positive assertion makes it load-bearing.    |

## Escalation

- **A VAC-001 finding is never a false positive.** It is a comparison of a value
  with itself. Fix the test.
- **A large VAC-002 count on first run usually means dynamic imports.** Tests
  that `await import(...)` their target have no static import for the inference
  to read. Annotate them, or accept the tier and move on — do not rewrite the
  suite to satisfy a heuristic.
- **A finding you disagree with is a doc gap, not an argument.** Write the
  `@covers` annotation; the next reader gets the answer for free.

## Related

- `canary review-test` — `LINT-006` (zero assertions) and `SOUND-001/002/003` (a
  test that pins a value no correct implementation must produce). Cassandra
  deliberately does not duplicate either.
- `canary-promote-test` — consumes these findings as a structured verdict and
  blocks promotion on the deterministic ones.
- `canary-katana`, `canary-savant`, `canary-blackhawk` — the other Tier-0
  deterministic scanners.

[#485]: https://github.com/bop-clocktower/canary/issues/485
[#486]: https://github.com/bop-clocktower/canary/issues/486
