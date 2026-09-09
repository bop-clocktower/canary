// Duration collection and load normalisation for the test-duration ratchet
// (#760). Split out of test-duration-ratchet.mjs when the spawn-slack work
// pushed that file past the 300-line perf threshold.
//
// The seam is deliberate rather than arbitrary: everything here answers "how
// long did these tests take, and how contended was this run?" — pure functions
// over report JSON, with no knowledge of a baseline, a ceiling, or a verdict.
// The comparison logic that does own those stays in the ratchet.
//
// Read docs/knowledge/gates/test-duration-ratchet.md before changing a
// constant; every number in it cost a measurement.

/** A run that verified nothing. Exit code 3; see the ratchet's header. */
export class Abstention extends Error {}

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
export function usableLoad(measured) {
  if (measured > MAX_LOAD_FACTOR) {
    throw new Abstention(
      `every tracked test is ${measured.toFixed(1)}x its recorded duration — either far too contended, or a slower class of machine than the baseline was recorded on. Either way not comparable, so this run verified nothing.`,
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
