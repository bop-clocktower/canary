import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/*.test.ts'],
    // #760, second half. `ts/vitest.config.ts` raised this to 30s for the same
    // reason; this project was left on the 5s default even though the issue's
    // own follow-up comment recorded seven failures here, not in `ts/`
    // (`canary-strix`, `canary-katana` — every one `Test timed out in 5000ms`,
    // not an assertion failure).
    //
    // Measured on this suite, idle, 923 tests: the slowest test is 3056ms and
    // exactly ZERO exceed 5000ms. So the budget is not being blown by the work
    // a test does — it is blown by waiting to spawn. Pairing today's idle
    // numbers against the durations recorded in #760 under load:
    //
    //     idle    loaded   factor  test
    //      215ms   9600ms   44.7x  katana  hasOwnProperty unrecognized arg
    //      606ms  10600ms   17.5x  strix   newline-separated terms
    //      687ms   7000ms   10.2x  strix   multi-word term vs concatenated domain
    //      628ms   6100ms    9.7x  strix   term that is only a substring
    //      806ms   6700ms    8.3x  strix   term carrying trailing punctuation
    //      778ms   5400ms    6.9x  strix   unions the sources
    //     3056ms   6600ms    2.2x  katana  commitForFile carries the ticket
    //
    // A 215ms test taking 9.6s is 44x, and it is the smallest test in the
    // table — the factor tracks the number of spawns, not the amount of work.
    // That is the signature of contention on process spawn, and it is why the
    // per-test budget has to cover queueing rather than computation.
    //
    // 30s, matching `ts/`: ~10x headroom over the slowest test here, ~2.8x over
    // the worst value #760 ever observed in this project. Not unbounded — a
    // genuinely hung test must still fail. This stops a contended spawn being
    // reported as a failure; it does NOT explain the contention, which is
    // tracked in #760 and is a real cost worth chasing rather than absorbing.
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json'],
      // Only the skill runtimes this harness actually tests count toward
      // coverage. As each skill migrates to JS with its own suite, add its
      // scripts glob here — do NOT broaden to all skills, or an untested JS
      // file from an unrelated skill (e.g. canary-instrument's otel bootstrap)
      // silently drags the gate down.
      include: [
        // The shared skill-CLI parser every `cli:` skill now routes through
        // (#479) -- the one file whose bugs are family-wide.
        'lib/*.mjs',
        'claude-code/canary-savant/scripts/**/*.mjs',
        'claude-code/canary-blackhawk/scripts/**/*.mjs',
        'claude-code/canary-cassandra/scripts/**/*.mjs',
        'claude-code/canary-katana/scripts/**/*.mjs',
        // Top-level only (`*.mjs`, not `**`): the ported cli/run_types/
        // span_reader are tested, but otel_bootstrap/instrument.mjs needs a
        // live OTel SDK and stays out of the coverage gate (see the note
        // above about not dragging the gate down with untested JS).
        'claude-code/canary-instrument/scripts/*.mjs',
        'claude-code/canary-fail-fast/scripts/**/*.mjs',
        'claude-code/canary-test-reporter/scripts/**/*.mjs',
        'claude-code/canary-shadow/scripts/*.mjs',
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
