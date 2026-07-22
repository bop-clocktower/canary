# Plan: TS migration — subsystem 3, core/ slice (framework recommendation)

**Date:** 2026-07-22 | **Approach:** strangler | **Toolchain:** established
(`ts/`)

Third subsystem of the Python→TS migration, following the `analysis` and
`history` ports (PRs 388 and 389). This is the first **`core/` slice**: the
framework-recommendation cluster — a cohesive, self-contained ~1.2k-LOC
vertical. The rest of `core/` (22 modules) follows in later slices.

## Scope

Port 5 modules, `agent/core/` → `ts/src/core/`:

| Python                                                                                           | TS                      | Notes                                                                 |
| ------------------------------------------------------------------------------------------------ | ----------------------- | --------------------------------------------------------------------- |
| `classifier.py` (`TestClassifier`, `classify`, `extract_framework_hint`, `ClassificationResult`) | `classifier.ts`         | pure logic; keep the `TestClassifier` class name (domain, not a test) |
| `pattern_matcher.py` (`PatternMatcher.scan`, `PatternProfile`)                                   | `pattern-matcher.ts`    | pure logic                                                            |
| `framework_registry.py` (`FrameworkRegistry` + queries)                                          | `framework-registry.ts` | reads `agent/frameworks/registry.json` (shared-data seam)             |
| `quality_scorer.py` (`QualityScorer.score`, `QualityScore`)                                      | `quality-scorer.ts`     | reads a source file → score                                           |
| `recommender.py` (`FrameworkRecommender.recommend`)                                              | `recommender.ts`        | depends on classifier + framework_registry (both in-slice)            |

- **In:** the 5 modules + their logic. **Out:** CLI, any store, the other 20
  `core/` modules, user-facing cutover.
- **ADR #390 (async/sync) does not block this** — none of these touch the
  history store; all synchronous pure logic.

## Observable truths

1. Each module's public API is ported with matching behavior.
2. **Parity:** golden outputs captured from Python for representative inputs
   (classifier prompts, recommender requests, quality-scorer sources, registry
   queries, pattern scans) match the TS output.
3. `framework-registry.ts` reads the same `agent/frameworks/registry.json` and
   returns equivalent query results (the shared-data seam).
4. TS gate green (typecheck + prettier + vitest 90/85); `harness ci check` arch
   clean of `ts/` complexity (module-size baseline refreshed once, size-only).
5. Python `core/` unchanged; still ships.

## File map

```text
CREATE ts/src/core/classifier.ts (+test)
CREATE ts/src/core/pattern-matcher.ts (+test)
CREATE ts/src/core/framework-registry.ts (+test)
CREATE ts/src/core/quality-scorer.ts (+test)
CREATE ts/src/core/recommender.ts (+test)
CREATE ts/test/fixtures/core-golden/*.json   (Python-captured)
CREATE ts/test/core-parity.test.ts
CREATE scripts/capture_core_golden.py
```

## Task groups

1. **framework-registry** (leaf; reads registry.json) — TDD. (~2 tasks)
2. **classifier** (`classify`, `extract_framework_hint`, `ClassificationResult`)
   — TDD. (~2)
3. **pattern-matcher** (`scan`, `PatternProfile`) — TDD. (~2)
4. **quality-scorer** (`score`, `QualityScore`) — TDD, source-file fixtures.
   (~2)
5. **recommender** (`recommend`, wiring classifier + registry) — TDD. (~2)
6. **parity harness** — `capture_core_golden.py` + `core-parity.test.ts`. (~2)
7. **gate + baseline + PR** (me).

## Risks

- **Arch complexity:** apply the pilot discipline (`def()` helper, small
  functions, run `harness ci check` before finishing).
- **`registry.json` path:** resolve relative to repo root; the TS reader points
  at `agent/frameworks/registry.json` (document the resolution).
- **Parity of scoring/rounding:** reuse `round1`/`num1`/`def` from the shared
  util; golden test is the arbiter.
- **`TestClassifier` name:** keep it; ensure no vitest/collection confusion
  (it's a class, not a `*.test.ts` export).
