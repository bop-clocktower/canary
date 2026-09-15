# Plan: test inventory producer (#957)

Spec: `docs/changes/test-inventory-producer/proposal.md`. Integration tier:
small. Complexity: medium. The plan was approved automatically because no
approval signal fired: 6 tasks, no concerns, no complexity override.

## Tasks

### Task 1: assertion depth and inventory builder (TDD)

**Files:** `ts/src/core/test-inventory.ts`, `ts/test/test-inventory.test.ts`,
`ts/src/core/vacuity-scanner.ts` (export the weak-assertion vocabulary)

- Write the tests first. Depth is 0 when a test has no assertion, 1 when every
  assertion is an absence or trivial-presence check, and 2 when any assertion is
  shaped. This holds for both JS and Python.
- Also test first: `buildInventory` lists files, framework, targets (relative
  imports resolved and extension-stripped; Python dotted and relative imports)
  and tests; it records unparseable files as skipped; and it returns an empty
  `files` list when no test files exist.

### Task 2: `canary inventory` CLI (TDD)

**Files:** `ts/src/inventory-cli.ts`, `ts/src/cli.ts`,
`ts/test/inventory-cli.test.ts`

- On success it writes `.canary/test-inventory.json` and exits 0. `--json`
  prints the inventory.
- When zero tests are found it does not write the file, exits 3, and names what
  it looked for.

### Task 3: inventory checks scorer (TDD)

**Files:** `ts/src/core/inventory-checks.ts`, `ts/test/inventory-checks.test.ts`

- `parseInventory`: returns an abstain reason when the input is missing, invalid
  JSON, or has an unsupported `schema_version`.
- `parseCriticalAreas`: covers the same three cases.
- The coverage-depth, assertion-quality and critical-paths rules follow the spec
  table. Each check abstains when its scope is empty.

### Task 4: wire into ci-ready

**Files:** `ts/src/core/ci-ready.ts` (inventory checks only),
`ts/src/ci-ready-cli.ts`, `ts/test/ci-ready-cli.test.ts`

- Replace the `hasInventory`/`hasCriticalAreas` booleans with parsed inputs. The
  skip reason names `canary inventory`.
- Tests: an end-to-end run where `canary inventory` then `ci-ready` scores 3
  checks, and a case where an empty inventory abstains.

### Task 5: docs

**Files:** `docs/guides/test-inventory.md`, `README.md`, `AGENTS.md`,
`agents/skills/claude-code/canary-ci-ready/SKILL.md`,
`agents/commands/gemini-cli/harness/canary-ci-ready.toml`, `STRATEGY.md`,
`CHANGELOG.md`

### Task 6: ratchets and gates

- From `ts/`, run build, typecheck, format:check and test.
- Run `harness check-deps` from the repo root. Check the entropy entry points
  and dead exports, and the perf baseline.
- Write provenance, then open the PR.
