# Test inventory producer (#957)

**Keywords:** ci-ready, test-inventory, assertion-depth, coverage-depth,
critical-paths, abstention, static-linter, vacuity-scanner

## Overview

`canary ci-ready` has five checks. Three of them (coverage-depth,
assertion-quality, critical-paths) read `.canary/test-inventory.json`, but
nothing writes that file and no schema for it is documented. So for every
consumer those three checks skip (`ts/src/core/ci-ready.ts:47-128`). The skip
message also points at a `canary coverage` command that does not exist.

Goals:

1. Ship `canary inventory`, a deterministic producer. It walks the test tree and
   writes `.canary/test-inventory.json` in a documented, versioned schema.
2. Make `ci-ready` actually score the three checks against that schema. When an
   input is missing, invalid or empty, the check abstains and names the reason.
3. Fix every piece of text that claims nothing produces the file: the ci-ready
   message, the canary-ci-ready SKILL.md and its gemini toml, and the
   STRATEGY.md disclosure.

Out of scope: suite-runtime and flakiness, which belong to the concurrent #956
lane, and any runtime or line-coverage instrumentation.

## Decisions made

Brainstorming ran autonomously inside a roadmap-fleet lane. The fleet
confirmation had already settled the main fork: build the producer. The
remaining EVALUATE questions were answered with the recommended defaults below.

| #   | Question                              | Options                                                                                           | Chosen                                                                                                                        | Why                                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Command name                          | A) `canary coverage` B) `canary inventory`                                                        | **B**                                                                                                                         | It emits an inventory, not coverage. `coverage` would imply line coverage canary does not measure. The ci-ready message is changed to name `canary inventory`.                                                                                                                               |
| D2  | What "depth" means statically         | A) runtime endpoint hits B) per-test assertion tier from source                                   | **B**: 0 = no recognised assertion, 1 = only weak assertions (absence or trivial presence), 2 = at least one shaped assertion | Canary cannot observe endpoint hits without running anything. The tiers reuse vocabulary the linter and vacuity scanner already trust (`ASSERT_JS`/`ASSERT_PY`, `ABSENCE_ASSERTION`, `TRIVIAL_PRESENCE_*`), and they match the skill's scale (depth 1 = "hit but unasserted / status-only"). |
| D3  | How a test maps to source             | A) `@covers` symbol B) relative import specifiers resolved to root-relative paths                 | **B** (file-level `targets`)                                                                                                  | critical-areas.json is keyed by `path`, so path matching is what the cross-reference needs. `@covers` names symbols, not files.                                                                                                                                                              |
| D4  | Traversal                             | A) new walker B) `collectTestFiles` + `enumerateTests` + `blankStringContent`                     | **B**                                                                                                                         | This is the issue's ask. It shares one denominator with `review-test` and `vacuity-check` (`ts/src/core/test-files.ts:1-15`).                                                                                                                                                                |
| D5  | Empty inventory                       | A) write it and let checks pass B) do not write; exit 3; ci-ready treats 0 tests as an abstention | **B**, plus ci-ready's own guard                                                                                              | Checking zero items is an abstention, not a pass (#508 doctrine).                                                                                                                                                                                                                            |
| D6  | coverage-depth without critical areas | A) skip B) score over every target the inventory references                                       | **B**                                                                                                                         | The check stays useful on its own. The reason text says which scope was scored.                                                                                                                                                                                                              |
| D7  | Where scoring lives                   | A) inline in `ci-ready.ts` B) new `core/inventory-checks.ts`, which `ci-ready.ts` calls           | **B**                                                                                                                         | Keeps `ci-ready.ts` edits small so the concurrent #956 lane can rebase cleanly, and keeps each function small for the perf ratchet.                                                                                                                                                          |

Approaches considered (PRIORITIZE):

- **Approach 1 (chosen): static producer plus pure scorer.** The trade-off is
  honest: depth is a heuristic tier. The schema records the rule for each
  number, so a reader can see what a depth means.
- **Approach 2: document the schema only.** It is cheap, but the three checks
  would stay dead for every consumer who does not hand-write the file. The fleet
  already rejected this.
- **Approach 3: runtime-coverage-backed depth.** It would be accurate, but it
  needs a coverage run for each framework. That is high effort, and YAGNI for
  this issue.

## Technical design

### Schema v1 (`.canary/test-inventory.json`)

```json
{
  "schema_version": 1,
  "generated": "2026-09-15T00:00:00.000Z",
  "files": [
    {
      "path": "tests/cart.test.ts",
      "framework": "vitest",
      "targets": ["src/cart"],
      "tests": [{ "name": "adds an item", "line": 4, "depth": 2 }]
    }
  ],
  "skipped": [{ "name": "tests/x.test.foo", "reason": "..." }]
}
```

- Every path is POSIX and relative to the root it was generated from. `targets`
  have their extension stripped, so `./cart.js` and `cart.ts` match.
- Python `from pkg.mod import x` becomes the target `pkg/mod`. A relative
  `from .mod import x` resolves against the test's directory.

### Modules

- `ts/src/core/test-inventory.ts`: `buildInventory(root, testDir)` and
  `assertionDepth(body, python)`. It reuses `collectTestFiles`,
  `enumerateTests`, `frameworkForPath` and `blankStringContent`. The weak
  vocabulary is exported from `vacuity-scanner.ts` rather than copied.
- `ts/src/core/inventory-checks.ts`: `parseInventory(text)` returns either an
  inventory or an abstain reason, and `scoreInventoryChecks(inventory, areas)`
  returns the three `CiCheck`s. The functions are pure.
- `ts/src/inventory-cli.ts`: `canary inventory [testDir] --root <dir> --json`.
  It writes `<root>/.canary/test-inventory.json`. Exit codes: 0 when the file
  was written, 3 when zero tests were found and nothing was written.
- `ts/src/ci-ready-cli.ts`: reads and parses both JSON files and passes them to
  `scoreCiReady`.

### Scoring rules

"Area depth" is the maximum test depth across files whose `targets` match the
area path, compared with extensions stripped and on a path-suffix match. It is 0
when no test targets the area.

| Check             | Scope                                       | pass               | warn                     | fail                  |
| ----------------- | ------------------------------------------- | ------------------ | ------------------------ | --------------------- |
| coverage-depth    | critical areas, or every inventory target   | all ≥ 2            | some at 1, none at 0     | any at 0              |
| assertion-quality | tests touching critical areas, or all tests | all tests ≥ 2      | some ≤ 1, not a majority | majority ≤ 1          |
| critical-paths    | top 5 areas by `risk_score`                 | all have depth ≥ 1 | exactly one uncovered    | two or more uncovered |

A check reports `skip` with a named reason in each of these cases: the inventory
is missing (reason: "run `canary inventory`"), unreadable, or has an unsupported
`schema_version`; it lists zero tests; a scope is empty (for example, critical
areas that no test touches, under assertion-quality); or, for critical-paths
only, `critical-areas.json` is absent or has no areas.

## Integration points

- **Entry points:** a new CLI command, `canary inventory`, registered in
  `ts/src/cli.ts`.
- **Registrations required:** `program.addCommand(buildInventoryCommand(deps))`.
  New ts/src modules are reachable from `cli.ts`. Check the entropy, perf and
  arch ratchets. Do not raise `maxFindings`.
- **Documentation updates:** a new `docs/guides/test-inventory.md` with the
  schema reference; the README command tables; the AGENTS.md command list; the
  canary-ci-ready SKILL.md and its gemini toml; the STRATEGY.md disclosure; and
  a CHANGELOG Unreleased entry.
- **Architectural decisions:** none standalone. The disclosure change follows
  ADR 0026's stated removal condition.
- **Knowledge impact:** add the concept "assertion depth tier (0/1/2)" to the
  test-inventory schema doc.

## Success criteria

1. When `canary inventory` runs on a tree with tests, the system shall write
   `.canary/test-inventory.json` with `schema_version: 1` and one entry per
   test, each with a depth in {0,1,2}.
2. If no tests are found, then the system shall not write the file and shall
   exit 3.
3. When the inventory is present and non-empty, `ci-ready` shall score
   coverage-depth and assertion-quality (not skip) and shall exit according to
   the verdict.
4. When `critical-areas.json` is also present, critical-paths shall score pass,
   warn or fail per the rules table.
5. If the inventory lists zero tests or has an unknown `schema_version`, then
   those checks shall skip with the reason named.
6. The ci-ready skip text shall name `canary inventory`, and no doc shall still
   claim nothing produces the file.
7. All four gates shall pass: build, typecheck, format:check, test.

## Implementation order

1. Core `assertionDepth` and `buildInventory`, test-first.
2. `inventory-cli.ts` and its registration, test-first.
3. `inventory-checks.ts` and its wiring into `ci-ready`, test-first; update the
   existing ci-ready tests.
4. Docs, SKILL/toml, STRATEGY.md, CHANGELOG.
5. Ratchets and gates, provenance, PR.
