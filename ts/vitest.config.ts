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
      // Fresh-port floor: higher than the Python engine's 81 ratchet because
      // this is new code with tests written alongside. Ratchets up over time.
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
  },
});
