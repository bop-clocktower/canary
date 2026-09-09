#!/usr/bin/env node
// Fails when a tracked test gets materially slower (#760).
//
// #760 raised testTimeout to 30s in both vitest projects so contended tests
// stop being reported as failures. Nothing in either suite runs over ~3.1s
// idle, so that is also a ~10x window in which a real slowdown is invisible.
// This is the recorded expected duration the issue asked to be paired with it.
//
// A fixed ceiling is flaky for exactly the reason the timeouts were: under
// load these tests take a large, roughly CONSTANT penalty (a 215ms test was
// recorded at 9600ms). So the comparison gets a CONTROL GROUP -- load raises
// every slow test together, a regression raises one -- and each run derives
// its own load factor from the tracked tests themselves.
//
// The load factor is not the whole story. On the runner, contention is not
// uniform: in one contended run half the tracked tests ran FASTER than
// recorded while a handful each took a 200-755ms hit, and those landed on
// tests whose entire recorded duration is one 80ms spawn. A median sees
// nothing; a multiplicative ceiling over 80ms is 200ms, which the runner
// cannot promise. So a firing ALSO has to clear SPAWN_SLACK_MS of absolute
// slowdown: a slowdown smaller than that is below the resolution of this
// instrument, and reporting it is the false red that teaches
// re-run-until-green. It is a conjunction, never a wider ceiling -- it can
// only suppress a firing near the floor, never license one above it.
//
// The design, its validation table, the three rejected alternatives, and why the
// baseline is machine-class-specific are in
// docs/knowledge/gates/test-duration-ratchet.md. Read it before changing a
// constant here; every number in it cost a measurement.
//
// Exit codes follow the repo's gate convention (#508): 0 within tolerance,
// 1 REGRESSION, 2 usage, 3 ABSTENTION -- no reports, no tests, a missing
// baseline, a different node, too small a control group, or a run not
// comparable to the baseline at all. "0 regressions" out of nothing checked is
// an abstention wearing a pass.
//
//   node scripts/test-duration-ratchet.mjs --report <vitest.json> [...]
//   node scripts/test-duration-ratchet.mjs --report <vitest.json> --update
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  Abstention,
  MAX_LOAD_FACTOR,
  collectDurations,
  loadFactor,
  median,
  testKey,
  usableLoad,
} from './test-duration-collect.mjs';

// Re-exported so this module stays the single public surface of the gate:
// the workflow and ts/test/test-duration-ratchet.test.ts import from here.
export {
  MAX_LOAD_FACTOR,
  MIN_LOAD_FACTOR,
  collectDurations,
  loadFactor,
  median,
  testKey,
} from './test-duration-collect.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const BASELINE = join(
  REPO_ROOT,
  '.harness',
  'test-duration-baseline.json',
);

/** Below this, timings are mostly noise. Set from the RUNNER; see the doc. */
export const FLOOR_MS = 75;
/** A tracked test may take this multiple of its recorded duration. */
export const TOLERANCE = 2.5;
/**
 * A firing must ALSO clear this much absolute slowdown. One contended spawn.
 *
 * Set from the runner, not the laptop. CI run 34327672926 (attempt 1, the
 * same tree that passed on attempt 2) put a penalty of up to 755ms on single
 * tests recorded at 80-87ms — 5-10x, against a load-scaled ceiling of 4.29x.
 * 2000ms covers that sample with margin against a tail one sample cannot
 * bound (#760 measured a 3.4s p95 spawn on a laptop under 8 concurrent
 * spawners) while staying an order of magnitude inside the 30s window the
 * gate exists to watch: nothing in the suite runs over ~3.1s idle, so a
 * regression of seconds still clears both terms. Raising the FLOOR instead
 * does not work here — see the doc; it was measured.
 */
export const SPAWN_SLACK_MS = 2000;
/** Fewer tracked tests than this cannot yield a trustworthy load factor. */
export const MIN_CONTROL_GROUP = 10;
function readBaseline() {
  if (!existsSync(BASELINE)) {
    throw new Abstention(
      `no baseline at ${BASELINE} — run with --update on an idle machine first`,
    );
  }
  return JSON.parse(readFileSync(BASELINE, 'utf-8'));
}

/**
 * Refuses to compare across runtimes. Mirrors `requireMatchingInstrument` in
 * the perf ratchet: a stale stamp abstains rather than quietly comparing two
 * numbers produced by different instruments.
 */
function requireComparable(baseline) {
  if (baseline.nodeVersion !== process.version) {
    throw new Abstention(
      `baseline was taken on node ${baseline.nodeVersion}, this is ${process.version} — durations are not comparable across runtimes`,
    );
  }
}

/**
 * Splits the tracked set into what this run can judge and what it cannot.
 *
 * `missing` is every tracked test the run did not produce a usable timing for
 * — absent from the report, or recorded at a non-positive duration there is no
 * meaningful ratio against. It is returned rather than dropped because a
 * tracked test that vanished is a finding: the gate covered less than it
 * claims and nobody would otherwise notice.
 */
function partitionTracked(tracked, observed) {
  const rows = tracked.map(([key, recorded]) => ({
    key,
    recorded,
    actual: observed.get(key),
  }));
  return {
    missing: rows
      .filter((r) => r.actual === undefined || r.recorded <= 0)
      .map((r) => r.key),
    present: rows
      .filter((r) => r.actual !== undefined && r.recorded > 0)
      .map((r) => ({ ...r, ratio: r.actual / r.recorded })),
  };
}

/**
 * Compares observed durations to the baseline.
 *
 * A tracked test missing from the run is a finding, not a skip: it means the
 * gate covered less than it claims and nobody would otherwise notice.
 */
export function compare(baseline, observed) {
  const tracked = Object.entries(baseline.tests ?? {});
  if (tracked.length === 0) {
    throw new Abstention(
      'the baseline tracks zero tests, so every comparison would pass vacuously',
    );
  }

  const { missing, present } = partitionTracked(tracked, observed);

  // The control group has to be big enough for its median to mean anything.
  // Comparing against a load factor derived from three tests is the
  // zero-denominator shape in a smaller package.
  if (present.length < MIN_CONTROL_GROUP) {
    throw new Abstention(
      `only ${present.length} of ${tracked.length} tracked test(s) ran (need ${MIN_CONTROL_GROUP}); the load factor would be derived from too small a control group to trust`,
    );
  }

  const load = usableLoad(loadFactor(present.map((t) => t.ratio)));

  // Two independent conditions, BOTH required. The multiplicative ceiling is
  // the rule and stays exactly what it was; SPAWN_SLACK_MS is a resolution
  // limit layered under it, not added to it.
  //
  // Additive was the obvious shape and it is wrong: `ceiling * load + slack`
  // spends the slack on every test, so a test recorded at 1000ms could reach
  // 4500ms unreported. That trades this run's false red for a permanent false
  // green, and three of this file's own no-false-green tests catch it.
  //
  // As a conjunction the slack can only ever SUPPRESS a firing near the
  // floor, where the multiplicative ceiling asks the runner to spawn a
  // process within 200ms and it cannot. A test recorded in seconds clears
  // 2000ms of absolute delta the moment it clears 2.5x, so for everything
  // above the floor this is precisely the old instrument.
  const regressions = present
    .map((t) => ({ ...t, ceiling: t.recorded * load * TOLERANCE }))
    .filter(
      (t) =>
        t.actual > t.ceiling && t.actual - t.recorded * load > SPAWN_SLACK_MS,
    );

  return { regressions, missing, checked: present.length, load };
}

/** Baseline body for the current run. Only tests above the floor are tracked. */
export function buildBaseline(observed) {
  const tests = {};
  for (const [key, ms] of [...observed].sort()) {
    if (ms >= FLOOR_MS) tests[key] = Math.round(ms);
  }
  return {
    $comment: `Recorded test durations for #760. A tracked test must exceed BOTH ${TOLERANCE}x its recorded value and ${SPAWN_SLACK_MS}ms of absolute slowdown before this gate fails. Refresh with --update from a CI artifact; never widen TOLERANCE or SPAWN_SLACK_MS to make CI pass.`,
    $why: '#760 raised testTimeout to 30s in both vitest projects. Nothing here runs over ~3.1s idle, so that is a ~10x detection gap in which a real slowdown is invisible. This is the recorded expected duration the issue asked to be paired with the raise.',
    $instrument: `Each run computes its own load factor — the MEDIAN ratio of observed to recorded across every tracked test that ran — and each test is judged against a ceiling scaled by it. A firing must also clear ${SPAWN_SLACK_MS}ms of absolute slowdown -- the one contended spawn that lands on a single test and that no group statistic can see. The two are a conjunction, so the slack can only suppress a firing near the floor, never widen the ceiling above it. Contention raises all of them together so the ceiling rises with it; a regression raises one, which a median over dozens barely moves. Validated on this suite: idle median ratio 1.00 / worst 1.73, loaded median 1.38 / worst 2.60; on the runner a contended run put 755ms on an 80ms test while the median moved to 1.71. A run with fewer than ${MIN_CONTROL_GROUP} tracked tests present, or a load factor over ${MAX_LOAD_FACTOR}, ABSTAINS (exit 3) rather than compare.`,
    nodeVersion: process.version,
    measuredAt: new Date().toISOString().slice(0, 10),
    floorMs: FLOOR_MS,
    toleranceFactor: TOLERANCE,
    spawnSlackMs: SPAWN_SLACK_MS,
    tests,
  };
}

function parseArgs(argv) {
  const args = { reports: [], update: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--update') args.update = true;
    else if (argv[i] === '--report') {
      const p = argv[++i];
      if (p === undefined) return { usage: '--report needs a path' };
      args.reports.push(p);
    } else return { usage: `unknown option ${argv[i]}` };
  }
  if (args.reports.length === 0) return { usage: 'at least one --report' };
  return args;
}

function loadReports(paths) {
  return paths.map((p) => {
    if (!existsSync(p)) throw new Abstention(`no report at ${p}`);
    try {
      return JSON.parse(readFileSync(p, 'utf-8'));
    } catch (error) {
      throw new Abstention(`${p} is not readable JSON: ${String(error)}`);
    }
  });
}

function reportRegressions(result, observed) {
  for (const r of result.regressions) {
    console.log(
      `  ${r.key}\n    recorded ${r.recorded}ms, ceiling ${Math.round(r.ceiling)}ms, measured ${Math.round(r.actual)}ms (${r.ratio.toFixed(1)}x)`,
    );
  }
  for (const key of result.missing) {
    console.log(`  ${key} — tracked but absent from this run; not verified`);
  }
  console.log(
    `test-duration-ratchet: ${result.regressions.length} regression(s) over ${result.checked} tracked test(s) actually checked ` +
      `(${observed.size} collected, load factor ${result.load.toFixed(2)}x, ceiling ${(result.load * TOLERANCE).toFixed(2)}x recorded, and at least ${SPAWN_SLACK_MS}ms slower).`,
  );
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.usage !== undefined) {
    console.error(
      `test-duration-ratchet: ${args.usage}\nusage: --report <vitest.json> [--report ...] [--update]`,
    );
    process.exit(2);
  }

  try {
    const observed = collectDurations(loadReports(args.reports));
    if (observed.size === 0) {
      throw new Abstention(
        'the reports contain zero tests — nothing was measured, which is not a pass',
      );
    }

    if (args.update) {
      const next = buildBaseline(observed);
      writeFileSync(BASELINE, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
      console.log(
        `test-duration-ratchet: recorded ${Object.keys(next.tests).length} test(s) over ${FLOOR_MS}ms on node ${next.nodeVersion}.`,
      );
      process.exit(0);
    }

    const baseline = readBaseline();
    requireComparable(baseline);
    const result = compare(baseline, observed);
    reportRegressions(result, observed);
    if (result.regressions.length > 0) {
      console.log(
        `::error title=test duration::${result.regressions.length} test(s) exceeded ${TOLERANCE}x their recorded duration by more than ${SPAWN_SLACK_MS}ms`,
      );
      process.exit(1);
    }
    process.exit(0);
  } catch (error) {
    if (!(error instanceof Abstention)) throw error;
    console.log(`::error title=Test durations unverified::${error.message}`);
    console.error(`ABSTAINED: ${error.message}`);
    process.exit(3);
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2));
}
