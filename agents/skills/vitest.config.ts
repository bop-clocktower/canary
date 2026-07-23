import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json'],
      // Only the skill runtimes this harness actually tests count toward
      // coverage. As each skill migrates to JS with its own suite, add its
      // scripts glob here — do NOT broaden to all skills, or an untested JS
      // file from an unrelated skill (e.g. canary-instrument's otel bootstrap)
      // silently drags the gate down.
      include: [
        'claude-code/canary-savant/scripts/**/*.mjs',
        'claude-code/canary-blackhawk/scripts/**/*.mjs',
      ],
      exclude: ['**/*.test.*'],
      // Fresh-code floor, matching the ts/ engine port. Ratchets up over time.
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
  },
});
