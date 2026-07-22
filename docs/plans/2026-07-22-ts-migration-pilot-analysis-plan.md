# Plan: TypeScript migration — pilot (agent/analysis → TS)

**Date:** 2026-07-22 | **Spec:** none (strategic pivot; no upstream spec) |
**Tasks:** 15 | **Time:** ~70 min | **Integration Tier:** medium

## Summary

First pilot of an **incremental (strangler)** migration of the Canary Python
engine to TypeScript. Port `agent/analysis/` (609 LOC) to TS+Vitest, verified
byte-for-byte against the Python outputs, to prove the toolchain and the
TS↔Python seam **before** committing to migrating the larger subsystems.

**Non-goals for this phase:** cutting over the user-facing `canary analyze` CLI,
porting `core/`/`guardian/`/`history/`, porting the skills' Python scripts, or
changing the release pipeline. Python keeps building and shipping throughout.

## Decisions (locked)

- **Approach:** incremental strangler — Python releasable at every step.
- **Pilot subsystem:** `agent/analysis/` — smallest real-logic subsystem, best
  test coverage, single dependency (reads run history) that exercises the seam.
- **Toolchain:** TypeScript + Vitest (Canary's recommended JS unit framework).
- **TS location:** new top-level `ts/` sandbox (option A) — isolated from the
  publish-critical npm shim; permanent home decided at the gate.
- **The seam:** `test-results/reports/history-v2.jsonl` (NDJSON, one run-record
  per line). Python `HistoryStore.push_run` writes it; the TS analysis module
  reads it. No process/FFI coupling.

## Observable truths (acceptance criteria)

1. **Ubiquitous:** `npm --prefix ts run build` (tsc) compiles the analysis
   module with zero type errors.
2. **Ubiquitous:** `npm --prefix ts run test` (`vitest run --coverage`) passes
   with a coverage floor enforced (`lines >= 90`).
3. **Event-driven:** When the TS reporter is given a fixed `history-v2.jsonl`
   fixture, it shall produce `flaky`/`spikes`/`regression`/`digest` report text
   identical (after ANSI/trailing-whitespace normalization) to the Python output
   captured from the same fixture.
4. **Event-driven:** When the TS engine reads a `history-v2.jsonl` written by
   the Python `HistoryStore`, it shall produce a correct flaky report (live seam
   proof).
5. **Ubiquitous:** A CI job runs TS build+typecheck+lint+test+coverage on every
   PR; the Python `validate` job and its `fail_under=81` gate remain unchanged
   and green.
6. **Unwanted:** If the TS pilot is present, then the `canary` (Python) build,
   test, and publish paths shall not change behavior.

## Assumptions

- TS coverage floor = **90%** for the fresh port (new code, tests alongside).
- Parity asserted on **normalized** text (strip ANSI, trim trailing ws); Rich
  styling is not reproduced 1:1, but all numeric/structural content matches.
- `history-v2.jsonl` record schema is stable; the TS reader targets the v2 shape
  and fails loudly on unknown versions.

## File map

```text
CREATE ts/package.json                     (deps: typescript, vitest, @vitest/coverage-v8, eslint)
CREATE ts/tsconfig.json                    (strict)
CREATE ts/vitest.config.ts                 (coverage: v8, thresholds lines=90)
CREATE ts/.eslintrc.cjs                    (or eslint.config.js)
CREATE ts/src/history/record.ts            (RunRecord/TestResult TS types for the v2 schema)
CREATE ts/src/history/ndjson-store.ts      (read history-v2.jsonl; query_flaky/timeline/summary)
CREATE ts/src/history/ndjson-store.test.ts
CREATE ts/src/analysis/reports.ts          (port of reports.py pure functions)
CREATE ts/src/analysis/reports.test.ts
CREATE ts/src/analysis/engine.ts           (port of engine.py AnalysisEngine/AnalysisResult)
CREATE ts/src/analysis/engine.test.ts
CREATE ts/test/fixtures/history-v2.jsonl   (shared golden input)
CREATE ts/test/fixtures/golden/*.txt       (Python-captured expected outputs)
CREATE ts/test/parity.test.ts              (asserts TS output == golden)
CREATE scripts/capture_analysis_golden.py  (dumps Python reports for the fixture → golden/*.txt)
MODIFY .github/workflows/harness-quality.yml (add ts-validate job)
CREATE docs/plans/ts-migration-pilot-DECISION.md (written at the gate, Task 15)
```

## Tasks

### Group 1 — TS toolchain scaffold

#### Task 1: Scaffold `ts/` package + tsconfig (strict)

**Depends on:** none | **Files:** `ts/package.json`, `ts/tsconfig.json`

- `ts/package.json`: `"type": "module"`, scripts `build: "tsc -p ."`,
  `typecheck: "tsc -p . --noEmit"`, `lint: "eslint src"`,
  `test: "vitest run --coverage"`; devDeps `typescript@^5.6`, `vitest@^2`,
  `@vitest/coverage-v8@^2`, `eslint@^9`, `@types/node@^22`.
- `ts/tsconfig.json`: `strict: true`, `module: "NodeNext"`,
  `moduleResolution: "NodeNext"`, `target: "ES2022"`, `outDir: "dist"`,
  `rootDir: "src"`, `include: ["src"]`.
- Run: `npm --prefix ts install` then `npm --prefix ts run typecheck` (passes
  trivially with no sources yet).
- Commit: `chore(ts): scaffold ts/ pilot package (tsconfig strict + vitest)`
- Final step: `harness validate`

#### Task 2: Vitest + coverage config with 90% floor

**Depends on:** Task 1 | **Files:** `ts/vitest.config.ts`

- Configure `test.coverage`: `provider: "v8"`, `reporter: ["text","json"]`,
  `thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 }`,
  `include: ["src/**"]`.
- Add a trivial `ts/src/_smoke.test.ts` asserting `true`, run
  `npm --prefix ts run test` — confirm coverage runs (thresholds vacuously
  pass), then delete the smoke test.
- Commit: `chore(ts): vitest coverage gate (lines>=90)`
- Final step: `harness validate`

#### Task 3: ESLint config + `.gitignore` for `ts/`

**Depends on:** Task 1 | **Files:** `ts/eslint.config.js`, `ts/.gitignore`,
`.gitignore`

- Flat ESLint config for TS (typescript-eslint recommended).
- `ts/.gitignore`: `node_modules/`, `dist/`, `coverage/`.
- Ensure root `.gitignore` ignores `ts/node_modules`, `ts/dist`, `ts/coverage`.
- Run `npm --prefix ts run lint` (no sources → passes).
- Commit: `chore(ts): eslint flat config + ignore build artifacts`
- Final step: `harness validate`

### Group 2 — Port `reports.ts` (pure functions, TDD)

#### Task 4: Port `build_flaky_report` + `build_spikes_report` (TDD)

**Depends on:** Task 2 | **Files:** `ts/src/analysis/reports.ts`,
`ts/src/analysis/reports.test.ts` **Skills:** `canary-write-test` (apply)

- Write `reports.test.ts` first: table-driven cases mirroring the Python
  `test_analysis_reports.py` cases for flaky + spikes (same input `rows`, same
  expected substrings/numbers). Run — fails (no impl).
- Implement `buildFlakyReport(rows, opts)` and `buildSpikesReport(rows, delta)`
  as pure functions over `rows: RunRow[]`, preserving Python formatting
  (thresholds, ordering, rounding).
- Run `npm --prefix ts run test` — passes.
- Commit: `feat(ts): port flaky + spikes report builders`
- Final step: `harness validate`

#### Task 5: Port `build_area_health_report` + `build_common_failures_report` (TDD)

**Depends on:** Task 4 | **Files:** `ts/src/analysis/reports.ts`,
`ts/src/analysis/reports.test.ts`

- Tests first (mirror Python cases), then implement, matching min-suites/weeks
  filtering and sort order exactly.
- Commit: `feat(ts): port area-health + common-failures report builders`
- Final step: `harness validate`

#### Task 6: Port `build_regression_candidates_report` + `build_digest` (TDD)

**Depends on:** Task 5 | **Files:** `ts/src/analysis/reports.ts`,
`ts/src/analysis/reports.test.ts`

- Tests first, then implement. `buildDigest` composes the other builders —
  assert the composed section order matches Python.
- Commit: `feat(ts): port regression-candidates + digest builders`
- Final step: `harness validate`

### Group 3 — Port `engine.ts` + NDJSON reader (the seam, TDD)

#### Task 7: TS types for the v2 run-record schema

**Depends on:** Task 1 | **Files:** `ts/src/history/record.ts`

- Define `RunRecord`, `TestResult`, `RunRow` interfaces matching the fields the
  Python `agent/history/schema.py` writes into `history-v2.jsonl`. Include a
  `schemaVersion` discriminator.
- No runtime code → covered indirectly; add a type-only test asserting a sample
  record parses (`ts/src/history/record.test.ts`) in Task 8.
- Commit: `feat(ts): v2 run-record types`
- Final step: `harness validate`

#### Task 8: NDJSON history reader (TDD)

**Depends on:** Task 7 | **Files:** `ts/src/history/ndjson-store.ts`,
`ts/src/history/ndjson-store.test.ts`

- Test first: write a temp `.jsonl` fixture, assert `readHistory(path)` returns
  parsed rows, skips blank lines, and **throws on an unknown `schemaVersion`**.
- Implement `NdjsonHistoryStore` with `queryFlaky()`, `queryTimeline(name)`,
  `querySummary(suite, runs)` — same method contract as the Python
  `HistoryStore` ABC, computed over the in-memory rows.
- Commit: `feat(ts): ndjson history reader (the TS↔Python seam)`
- Final step: `harness validate`

#### Task 9: Port `AnalysisEngine` + `AnalysisResult` (TDD)

**Depends on:** Task 6, Task 8 | **Files:** `ts/src/analysis/engine.ts`,
`ts/src/analysis/engine.test.ts`

- Test first: construct engine with a `NdjsonHistoryStore` over a fixture,
  assert `flaky()`/`spikes()`/`regressionCandidates()`/`digest()` return the
  expected report strings (reuse Group-2 expectations).
- Implement `AnalysisEngine` taking a store, wiring queries → report builders,
  returning `AnalysisResult { artifacts: Record<string,string> }`.
- Commit: `feat(ts): port AnalysisEngine over the ndjson store`
- Final step: `harness validate`

### Group 4 — Parity harness

#### Task 10: Python golden-capture script + shared fixture

**Depends on:** none | **Files:** `scripts/capture_analysis_golden.py`,
`ts/test/fixtures/history-v2.jsonl`, `ts/test/fixtures/golden/*.txt`

- Author a representative `history-v2.jsonl` fixture (flaky test, a spike, a
  regression candidate, multiple suites/areas).
- `capture_analysis_golden.py`: builds each Python report from that fixture via
  `agent.analysis` and writes normalized text to `ts/test/fixtures/golden/`.
- Run it; commit the fixture + golden outputs.
- Commit: `test(ts): capture Python analysis golden outputs for parity`
- Final step: `harness validate`

#### Task 11: TS parity test against golden outputs (TDD)

**Depends on:** Task 9, Task 10 | **Files:** `ts/test/parity.test.ts`

- For each report, run the TS engine over the shared fixture, normalize (strip
  ANSI, trim trailing ws per line), and `expect(tsOut).toEqual(golden)`.
- Run `npm --prefix ts run test` — passes (this is truth #3).
- Commit: `test(ts): assert TS↔Python analysis output parity`
- Final step: `harness validate`

### Group 5 — CI wiring (integration)

#### Task 12: Add `ts-validate` CI job

**Depends on:** Task 11 | **Files:** `.github/workflows/harness-quality.yml` |
**Category:** integration

- Add a job `ts-validate` (runs-on ubuntu, setup-node 20): `npm --prefix ts ci`
  (or `install`), `npm --prefix ts run typecheck`, `run lint`, `run test`
  (coverage gate). Independent of the Python `validate` job.
- Commit: `ci(ts): add ts-validate job (build/typecheck/lint/vitest)`
- Final step: `harness validate`
- `[checkpoint:human-verify]` — confirm the new check appears and passes on the
  PR, and that Python `validate` is unchanged and green.

#### Task 13: Add committed `ts/package-lock.json` + `npm ci` in CI

**Depends on:** Task 12 | **Files:** `ts/package-lock.json` | **Category:**
integration

- `npm --prefix ts install` to generate the lockfile; commit it so CI uses
  `npm ci` deterministically.
- Commit: `chore(ts): commit lockfile for deterministic CI installs`
- Final step: `harness validate`

### Group 6 — Decision gate

#### Task 14: Update AGENTS.md with the `ts/` pilot + seam

**Depends on:** Task 13 | **Files:** `AGENTS.md` | **Category:** integration

- Document the `ts/` sandbox, the strangler approach, and the `history-v2.jsonl`
  seam so the next contributor understands the layout.
- Commit: `docs(agents): document ts/ pilot and history-v2 seam`
- Final step: `harness validate`

#### Task 15: Write decision-gate report + recommendation

**Depends on:** Task 14 | **Files:** `docs/plans/ts-migration-pilot-DECISION.md`

- Summarize: parity result, coverage achieved, toolchain friction, seam
  ergonomics, and effort/LOC ratio extrapolated to `core`/`guardian`.
- Recommend: proceed (next subsystem + which) / adjust toolchain / stop.
- `[checkpoint:decision]` — present to the human; do not start the next
  subsystem without a decision.
- Commit: `docs(ts): pilot decision-gate report`
- Final step: `harness validate`

## Sequencing / parallelism

- **Wave 1 (parallel):** Task 1; Task 10 (golden capture is Python-only,
  independent of TS scaffold).
- **Wave 2:** Task 2, Task 3, Task 7 (after Task 1).
- **Wave 3:** Task 4 → 5 → 6 (reports, serial — same file); Task 8 (after 7).
- **Wave 4:** Task 9 (after 6 + 8).
- **Wave 5:** Task 11 (after 9 + 10).
- **Wave 6:** Task 12 → 13 → 14 → 15 (serial; CI + docs + gate).

## Risks / known-failure check

- **npm shim breakage:** mitigated by option A isolation — `ts/` is not in the
  npm publish path; Task 12 keeps the Python `validate` job untouched.
- **Coverage gate we just shipped (#386):** the Python gate is unchanged; the TS
  gate is a separate job. Verified by truth #5 + Task 12 checkpoint.
- **Parity flakiness from Rich styling:** mitigated by normalization (assumption
  #2); we recently fixed an ANSI-substring test (see the guardian pr-check fix),
  so the normalization approach is proven.
- **Schema drift in `history-v2.jsonl`:** the reader fails loudly on unknown
  `schemaVersion` (Task 8) rather than silently mis-parsing.
