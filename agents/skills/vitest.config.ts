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
    // What is measured, and what is not:
    //
    // Measured here (2026-09-08, single idle run, 923 tests): the slowest test
    // is ~2.7-3.1s across runs and ZERO exceed 5000ms. So the budget is not
    // being blown by the work these tests do. Run-to-run spread on individual
    // tests is up to ~35%, so treat any single figure as one sample, not a
    // constant.
    //
    // NOT established: the mechanism. An earlier version of this comment
    // claimed the amplification "tracks spawn count, not workload", citing a
    // 215ms -> 9600ms (44x) case as proof. That case
    // (`canary-katana` hasOwnProperty) calls `main()` IN-PROCESS and spawns
    // nothing, so it cannot show that. The genuinely spawning cases all make
    // roughly ONE spawn each and their factors order strictly by idle duration
    // — the signature of a large constant penalty added under load, not of a
    // per-spawn cost. A trivial `node -e 0` spawn does go 36ms median idle ->
    // 3441ms p95 under 8 concurrent spawners (#760), so spawn contention is
    // real; it is just not what this table demonstrates. Filesystem contention
    // is equally consistent with the data and is NOT excluded.
    //
    // What this does and does not buy:
    //
    // 30s stops a contended test being reported as a failure. It does NOT
    // bound a hang. Every subprocess call in this suite is synchronous
    // (`spawnSync`/`execFileSync`, none passing a `timeout:` option), which
    // blocks the worker thread so vitest's timer cannot fire — a hung child
    // hangs the worker regardless of this value. #760's own 39-56s durations
    // recorded against a 5000ms limit are the proof: a real interrupt reports
    // ~5000ms. Only a child-level `timeout:` bounds a sync spawn.
    //
    // Cost accepted: nothing here runs over ~3.1s idle, so this is a ~10x
    // detection gap. A regression taking a 3s test to 18s now passes silently.
    // #760 stays open for that ratchet and for reducing spawns per test.
    //
    // Alternative measured, not adopted: `--no-file-parallelism` under 8-way
    // synthetic load cut the peak from 3973ms to 2833ms (-29%), but that load
    // did not reproduce the flake (0/923 over 5000ms either way), so it is not
    // evidence the flake is fixed. Left to #760 with a reproducing load.
    //
    // Same value as `ts/`, derived independently: `ts/`'s severe 39-56s cases
    // exceed this budget, nothing observed in this project does.
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
