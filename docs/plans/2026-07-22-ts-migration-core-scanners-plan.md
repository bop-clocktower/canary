# Plan: TS migration — subsystem 4, core/ slice (scanners)

**Date:** 2026-07-22 | **Approach:** strangler | **Toolchain:** established
(`ts/`)

Fourth subsystem of the Python→TS migration, following the analysis, history,
and framework-recommendation ports. Second **`core/` slice**: the repo-analysis
scanners — a cohesive, self-contained ~807-LOC group. Rest of `core/` (16
modules) follows in later slices.

## Scope

Port 4 modules, `agent/core/` → `ts/src/core/` (all self-contained, no
intra-`agent` deps, no store/async/CLI):

| Python                                                                 | TS                    |
| ---------------------------------------------------------------------- | --------------------- |
| `domain_scanner.py` (`DomainScanner.scan` → `DomainContext`)           | `domain-scanner.ts`   |
| `fixture_scanner.py` (`FixtureScanner.scan` → `FixtureSymbols`)        | `fixture-scanner.ts`  |
| `metadata_scanner.py` (`MetadataScanner.scan` → `ProjectMetadata`)     | `metadata-scanner.ts` |
| `static_linter.py` (`StaticLinter.lint` / `flake_check` → `Finding[]`) | `static-linter.ts`    |

- **Out:** CLI, store, the other 16 `core/` modules, user-facing cutover.
- ADR (async/sync) does not apply — synchronous pure logic.

## Observable truths

1. Each scanner's public API is ported with matching behavior.
2. **Parity:** golden outputs captured from Python over a fixture project tree
   match the TS output (scans + lint findings).
3. TS gate green (typecheck + prettier + vitest 90/85); `harness ci check` arch
   clean of `ts/` complexity (module-size baseline refreshed once, size-only).
4. Python `core/` unchanged; still ships.

## File map

```text
CREATE ts/src/core/domain-scanner.ts (+test)
CREATE ts/src/core/fixture-scanner.ts (+test)
CREATE ts/src/core/metadata-scanner.ts (+test)
CREATE ts/src/core/static-linter.ts (+test)
CREATE ts/test/fixtures/scanner-project/**   (shared fixture tree)
CREATE ts/test/scanner-parity.test.ts
CREATE scripts/capture_scanner_golden.py
```

## Task groups

1. **metadata-scanner** (leaf) — TDD. (~2 tasks)
2. **domain-scanner** — TDD. (~2)
3. **fixture-scanner** — TDD. (~2)
4. **static-linter** (`lint` + `flake_check` + `Finding`) — TDD. (~2)
5. **parity harness** — `capture_scanner_golden.py` + `scanner-parity.test.ts`
   over a shared fixture project tree. (~2)
6. **gate + baseline + PR** (me).

## Risks

- **Arch complexity:** apply the pilot discipline (`def()` helper, small
  functions, run `harness ci check` before finishing).
- **Filesystem walking parity:** match Python's traversal order and skip-dirs;
  sort results deterministically so golden comparison is stable.
- **Fixture glob collision:** keep the fixture tree out of the Vitest test glob
  (the glob is already narrowed to `test/*.test.ts`).
