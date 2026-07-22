import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json'],
      include: ['src/**'],
      exclude: ['src/**/*.test.ts'],
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
