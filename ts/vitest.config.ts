import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Fixture files under test/fixtures/** are inputs, not suites — keep the
    // test/ glob shallow so a fixture named *.test.ts is never collected.
    include: ['src/**/*.test.ts', 'test/*.test.ts'],
    // #760. A large share of this suite shells out -- `git` in a fixture repo,
    // a skill CLI as a node subprocess -- and vitest's 5s default is a budget
    // for an in-process unit test, not for a case that spawns half a dozen
    // processes while the rest of the suite competes for the same cores. The
    // symptom is unmistakable and was hit repeatedly: passes in isolation,
    // times out under `npm test`, on a different file each run.
    //
    // Raised once, here, rather than per file. A per-file budget fixes the
    // file someone happened to notice and leaves the next one to be discovered
    // as a flake in CI -- which is exactly how this was found three times.
    //
    // 30s, not unbounded: a genuinely hung test must still fail. The severe
    // cases in #760 (39-56s) are NOT fixed by this and are still real
    // slowness worth chasing -- this only stops a marginal case being
    // reported as a failure.
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      // `lcov` is what the PR guardian consumes (#655). Its `.json` reader
      // expects canary's own coverage-json contract (`{"files": {...}}`), NOT
      // istanbul's `coverage-final.json`, so handing over the json report would
      // parse to null and degrade to the heuristic tier while looking wired.
      reporter: ['text', 'json', 'lcov'],
      include: ['src/**'],
      // Exclude non-code: test files and bundled data (the framework registry
      // JSON, which v8 otherwise reports as a 0%-covered "source file").
      exclude: ['src/**/*.test.ts', 'src/data/**'],
      // Ratcheted floors. The principle (from the original Python-engine gate)
      // is to sit just under the measured value so the gate stays green while
      // blocking regressions — never to set an aspirational target that fails
      // on day one.
      //
      // Measured 2026-08-10 on `main` + #481 (117 files, 2384 tests): lines
      // 96.45, statements 95.29, functions 97.10, branches 88.51. Every floor
      // sits ~1–1.5pt under its measured value.
      //
      // #481 closed the branch problem the honest way. Branch coverage had
      // 0.48pt of slack at floor 85, which meant an unrelated PR adding a
      // couple of error paths tripped a gate its author never touched. The fix
      // was tests for the reachable-but-untested branches (the history/analyze
      // report renderers, the company-knowledge show/init ladders, the skills
      // run refusal ladder, the overlay registry's malformed-shape
      // degradations), which moved branches 85.48 → 88.51. Only then was the
      // floor ratcheted, to 87.
      //
      // The rule that produced these numbers, in both directions: NEVER lower a
      // floor to stop it failing — a gate lowered to pass is not a gate — and
      // never set one at the measured value with zero slack, which converts
      // every honest refactor into a red build.
      thresholds: {
        lines: 95,
        functions: 96,
        branches: 87,
        statements: 94,
      },
    },
  },
});
