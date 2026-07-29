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
      // Measured 2026-07-29 (78 files, 1553 tests): lines 95.44, statements
      // 93.98, functions 95.28, branches 85.48. The three with real headroom
      // are ratcheted with a ~1–1.5pt working buffer, locking in what the v6
      // port earned (the engine went 81.67% → 95.44%) so it cannot erode.
      //
      // BRANCHES STAYS AT 85 DELIBERATELY — it measures 85.48, so there is
      // half a point of slack and tightening it would trip the gate on the
      // next PR that adds an error path. The fix for branch coverage is more
      // tests, not a different number; lowering it would be worse still, since
      // a gate lowered to stop it failing is not a gate. Tracked in #481.
      thresholds: {
        lines: 94,
        functions: 94,
        branches: 85,
        statements: 93,
      },
    },
  },
});
