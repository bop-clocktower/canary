#!/usr/bin/env node
// Fails when a tracked test gets materially slower (#760).
//
// #760 raised testTimeout to 30s in both vitest projects to stop contended
// tests being reported as failures. Nothing there runs over ~3.1s idle, so
// that is a ~10x detection gap: a regression taking a 3s test to 18s now
// passes silently. The issue asks for the raise to be PAIRED with a recorded
// expected duration so a genuine slowdown stays visible. This is that.
//
// The hard part is that the thing being measured is exactly the thing #760 is
// about. Under load these tests take a large, roughly CONSTANT additional
// penalty — a 215ms test was recorded at 9600ms — so a naive duration
// assertion is flaky for precisely the reason the timeouts were, and a gate
// that fails intermittently teaches people to re-run until green, which is how
// a real failure gets waved through.
//
// The fix is to give the comparison a CONTROL GROUP. Load raises every slow
// test together; a regression raises one. So each run measures its own load
// factor — the MEDIAN ratio of observed to recorded across all tracked tests —
// and every test is judged against a ceiling scaled by it. Validated on real
// runs of this suite:
//
//     idle    53 tracked   median ratio 1.00   worst 1.73   ceiling 2.50  ok
//     loaded  53 tracked   median ratio 1.38   worst 2.60   ceiling 3.45  ok
//
// The worst case under load (2.60) would have tripped a fixed 2.5x ceiling.
// Normalised, the ceiling moves to 3.45 and it does not. A genuinely 4x test
// sits at ratio 4.0 against a median near 1 and fires in both conditions.
//
// Two designs were measured and REJECTED first, so they are not retried.
// (1) Normalising against the WHOLE suite's median duration: that median is
// 0.4ms because hundreds of tests are pure in-process work which never takes
// the spawn penalty, so ratios drifted 0.98-1.52x where raw durations drifted
// 0.87-1.34x — the wrong control group made it worse. (2) A `node -e 0` spawn
// probe as an instrument, the shape `.harness/perf-baseline.json` uses for a
// floating CLI: rejected because it could not be VALIDATED here — under 8
// concurrent spawn loops it reported p90 42.5ms against 44.1ms idle, no signal
// at all. Shipping an instrument that cannot be shown to measure what it
// claims is the failure this repo keeps finding in its own gates.
//
// Exit codes follow the repo's gate convention (#508):
//   0 = every tracked test is within tolerance
//   1 = REGRESSION — a test exceeded its recorded duration
//   2 = usage error
//   3 = ABSTENTION — no reports, no tracked tests, a missing baseline, a
//       different node, or a machine too contended to compare on. Each makes
//       the comparison meaningless, and "0 regressions" out of nothing checked
//       is an abstention wearing a pass.
//
//   node scripts/test-duration-ratchet.mjs --report <vitest.json> [...]
//   node scripts/test-duration-ratchet.mjs --report <vitest.json> --update
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const BASELINE = join(
  REPO_ROOT,
  '.harness',
  'test-duration-baseline.json',
);

/** Tests faster than this are not tracked — their timings are mostly noise. */
export const FLOOR_MS = 250;
/** A tracked test may take this multiple of its recorded duration. */
export const TOLERANCE = 2.5;
/** Fewer tracked tests than this cannot yield a trustworthy load factor. */
export const MIN_CONTROL_GROUP = 10;
/** A load factor above this means even the normalised comparison is guesswork. */
export const MAX_LOAD_FACTOR = 5;

/** Middle value of a numeric list. */
export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/**
 * How much slower this run is than the baseline, across the whole tracked set.
 *
 * The control group. Contention adds a large, roughly uniform penalty to every
 * test that spawns, so the median of the per-test ratios IS this run's load
 * level — taken from the same population being judged, on the same machine, in
 * the same run. One regressed test barely moves a median over dozens, which is
 * the asymmetry that separates the two.
 */
export function loadFactor(ratios) {
  return ratios.length === 0 ? 1 : median(ratios);
}

/** `file::test title` — stable across runs and readable in a diff. */
export function testKey(file, title) {
  return `${file.split('/').slice(-2).join('/')}::${title}`;
}

/** One `{key, ms}` per assertion in a single report file. */
function fileRows(file) {
  const name = file.name ?? '';
  return (file.assertionResults ?? []).map((a) => ({
    key: testKey(name, a.title ?? ''),
    ms: a.duration ?? 0,
  }));
}

/** Slowest per test across all reports — the minimum would let a regression
 * hide behind one lucky run in a batch. */
export function collectDurations(reports) {
  const worst = new Map();
  const files = reports.flatMap((report) => report.testResults ?? []);
  for (const row of files.flatMap(fileRows)) {
    const seen = worst.get(row.key) ?? 0;
    if (row.ms > seen) worst.set(row.key, row.ms);
  }
  return worst;
}

class Abstention extends Error {}

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

  const rows = tracked.map(([key, recorded]) => ({
    key,
    recorded,
    actual: observed.get(key),
  }));
  const missing = rows
    .filter((r) => r.actual === undefined || r.recorded <= 0)
    .map((r) => r.key);
  const present = rows
    .filter((r) => r.actual !== undefined && r.recorded > 0)
    .map((r) => ({ ...r, ratio: r.actual / r.recorded }));

  // The control group has to be big enough for its median to mean anything.
  // Comparing against a load factor derived from three tests is the
  // zero-denominator shape in a smaller package.
  if (present.length < MIN_CONTROL_GROUP) {
    throw new Abstention(
      `only ${present.length} of ${tracked.length} tracked test(s) ran (need ${MIN_CONTROL_GROUP}); the load factor would be derived from too small a control group to trust`,
    );
  }

  const load = loadFactor(present.map((t) => t.ratio));
  if (load > MAX_LOAD_FACTOR) {
    throw new Abstention(
      `every tracked test is ${load.toFixed(1)}x its recorded duration — the machine is far too contended for a comparison to mean anything, so this run verified nothing`,
    );
  }

  const regressions = present
    .filter((t) => t.ratio > load * TOLERANCE)
    .map((t) => ({ ...t, ceiling: t.recorded * load * TOLERANCE }));

  return { regressions, missing, checked: present.length, load };
}

/** Baseline body for the current run. Only tests above the floor are tracked. */
export function buildBaseline(observed) {
  const tests = {};
  for (const [key, ms] of [...observed].sort()) {
    if (ms >= FLOOR_MS) tests[key] = Math.round(ms);
  }
  return {
    $comment: `Recorded test durations for #760. A tracked test may take ${TOLERANCE}x its recorded value before this gate fails. Refresh with --update on an idle machine; never widen TOLERANCE to make CI pass.`,
    $why: '#760 raised testTimeout to 30s in both vitest projects. Nothing here runs over ~3.1s idle, so that is a ~10x detection gap in which a real slowdown is invisible. This is the recorded expected duration the issue asked to be paired with the raise.',
    $instrument: `Each run computes its own load factor — the MEDIAN ratio of observed to recorded across every tracked test that ran — and each test is judged against a ceiling scaled by it. Contention raises all of them together so the ceiling rises with it; a regression raises one, which a median over dozens barely moves. Validated on this suite: idle median ratio 1.00 / worst 1.73, loaded median 1.38 / worst 2.60. A run with fewer than ${MIN_CONTROL_GROUP} tracked tests present, or a load factor over ${MAX_LOAD_FACTOR}, ABSTAINS (exit 3) rather than compare.`,
    nodeVersion: process.version,
    measuredAt: new Date().toISOString().slice(0, 10),
    floorMs: FLOOR_MS,
    toleranceFactor: TOLERANCE,
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
      `(${observed.size} collected, load factor ${result.load.toFixed(2)}x, ceiling ${(result.load * TOLERANCE).toFixed(2)}x recorded).`,
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
        `::error title=test duration::${result.regressions.length} test(s) exceeded ${TOLERANCE}x their recorded duration`,
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
