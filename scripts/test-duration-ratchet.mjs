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
// The design, its validation table, the two rejected alternatives, and why the
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
/**
 * Below this the run is a different CLASS of machine, not merely an idle one,
 * and the baseline does not describe it. Found by CI: a macOS-recorded
 * baseline against an ubuntu runner gave a load factor of 0.08, because Linux
 * spawns a process about an order of magnitude faster and these tests are
 * spawn-bound. Comparing across that is meaningless in either direction.
 */
export const MIN_LOAD_FACTOR = 0.5;

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

/**
 * The load factor to judge against, or an abstention when the run is not
 * comparable to the baseline at all.
 *
 * Clamped at 1, because contention may only ever LOOSEN the ceiling. Letting a
 * factor below 1 tighten it inverts the gate into one that fails tests for
 * running FASTER than recorded — which is exactly what CI caught on this
 * gate's first run.
 */
function usableLoad(measured) {
  if (measured > MAX_LOAD_FACTOR) {
    throw new Abstention(
      `every tracked test is ${measured.toFixed(1)}x its recorded duration — the machine is far too contended for a comparison to mean anything, so this run verified nothing`,
    );
  }
  if (measured < MIN_LOAD_FACTOR) {
    throw new Abstention(
      `every tracked test is ${measured.toFixed(2)}x its recorded duration — a different class of machine from the one the baseline was recorded on, not a fast run, so the comparison would be meaningless. Re-record the baseline where the gate runs.`,
    );
  }
  return Math.max(1, measured);
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

/** Slowest per test across reports; a minimum would hide a regression. */
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

  const load = usableLoad(loadFactor(present.map((t) => t.ratio)));

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
