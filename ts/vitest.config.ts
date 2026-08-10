import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Fixture files under test/fixtures/** are inputs, not suites — keep the
    // test/ glob shallow so a fixture named *.test.ts is never collected.
    include: ['src/**/*.test.ts', 'test/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json'],
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
