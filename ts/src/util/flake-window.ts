/**
 * Flake-window honesty: the shared sample-size and measurability rules every
 * flake surface reads from (#604 Phase 1, decisions D5-D8).
 *
 * Three false greens lived in the flake surfaces before this module:
 *
 *  1. A THIN WINDOW read as healthy. `canary ci-ready` returned `pass` with
 *     `0 flaky tests across 2 run(s)`, and `history flaky` / `analyze flaky`
 *     printed a green `No tests above 10.0% flake rate...`. Zero findings out
 *     of two runs is an abstention, not a clean suite (ADR 0009), so below
 *     {@link MIN_WINDOW_RUNS} no surface may report a pass.
 *  2. A STRUCTURAL ZERO read as a measured one. `flake_count` only ever
 *     increments on the `flaky` status, which the vitest reader never writes
 *     (`history/formats/vitest-report.ts`). So a vitest-only window reports 0
 *     retry flakes by construction, whatever the suite actually did. That
 *     cause is now named rather than rendered as a number.
 *  3. An UNKNOWN window read as a clean one. A backend that cannot hand back
 *     raw run records (the remote Supabase store) cannot say which runs a
 *     flake query read, so its denominator is UNKNOWN -- which is not zero and
 *     is not "fine" either. It renders UNKNOWN and forfeits the clean verdict.
 *
 * Doctrine note: UNKNOWN and ZERO are kept apart throughout, the same
 * distinction `countRuns` draws in `history/async-store.ts` (#508 Wave 4a) and
 * `precision: null` draws in the guardian (#527). An invented abstention is as
 * dishonest as an invented pass, so an unstamped legacy run leaves the window
 * `unknown`, never `no`.
 *
 * WHY `util/`: the two consumers sit in different layers -- `core/ci-ready.ts`
 * scores the check and `history/` + `analysis/` render the reports -- and
 * `core -> history` is a layer violation `harness check-deps` rejects. Both
 * layers may depend on this leaf, which is also what keeps the wording from
 * drifting between the check and the commands. Pure: no I/O, no store.
 */

/**
 * Runs a window needs before a clean flake result may be reported as a pass
 * (Decision D5/H2, signed off 2026-09-15). An assumption, not a derivation:
 * it trades earlier detection for fewer confident reports over noise.
 */
export const MIN_WINDOW_RUNS = 10;

/**
 * Readers that CAN emit the `flaky` status, so a zero from them is measured.
 * vitest cannot; an unrecognized or absent stamp is UNKNOWN rather than either.
 */
const FLAKY_CAPABLE_FORMATS: readonly string[] = ['playwright', 'junit'];
const FLAKY_INCAPABLE_FORMATS: readonly string[] = ['vitest'];

/** Whether retry flakes could have been observed in a window at all. */
export type FlakyMeasurable = 'yes' | 'no' | 'unknown';

/** The one run-level field this module reads (added to `RunInput` by #604). */
interface ReporterStamped {
  reporter_format?: string | null;
}

/** What a backend can say about the runs a flake query actually read. */
export interface FlakyWindow {
  /** Runs READ in the requested window -- never the store's total. */
  runs_read: number;
  flaky_measurable: FlakyMeasurable;
}

/**
 * The `--json` payload for `history flaky` and `analyze flaky`.
 *
 * BREAKING (Decision H3): these commands used to emit a bare row array. A
 * disclosure a machine cannot read is dropped by every JSON consumer, so the
 * denominator now rides in the payload itself. `runs_read` and `sufficient`
 * are `null` when the backend cannot report its window -- UNKNOWN, not zero
 * and not false.
 *
 * Generic in the row type so this leaf never has to know the store's row
 * shape; callers bind it to `FlakyQueryRow`.
 */
export interface FlakyEnvelope<R = unknown> {
  window_requested: number;
  runs_read: number | null;
  sufficient: boolean | null;
  flaky_measurable: FlakyMeasurable;
  rows: R[];
  disclosures: string[];
}

/** A window's human header line, plus whether a clean verdict is earned. */
interface FlakyAssessment {
  /** True only when the window is both known and at the minimum size. */
  clean: boolean;
  /** Always printed: `read N runs (window W)`. SC3. */
  header: string;
  /** Everything the window cannot answer for, in report order. */
  disclosures: string[];
}

export function insufficientHistoryNote(runsRead: number): string {
  return `insufficient history: ${runsRead} of ${MIN_WINDOW_RUNS} runs`;
}

export const NOT_MEASURABLE_NOTE =
  'retry flakes not measurable (vitest has no flaky status) \u{2014} ' +
  'a zero here is structural, not measured';

export const MEASURABILITY_UNKNOWN_NOTE =
  'retry-flake measurability unknown: no run in this window records the ' +
  'reporter format it came from';

const WINDOW_UNKNOWN_NOTE =
  'cannot verify: runs_read is UNKNOWN for this backend (it does not expose ' +
  'raw run records), so no clean verdict over these rows is a pass';

/**
 * Could a retry flake have been OBSERVED in this window?
 *
 * Precedence is deliberate and asymmetric: one flaky-capable run makes the
 * window measurable (the status was reachable), while a single unstamped run
 * drops it to `unknown` (we cannot rule the status out OR in). Only an
 * all-vitest window earns the honest `no`. An empty window is `unknown`.
 */
export function measurabilityOf(
  runs: readonly ReporterStamped[],
): FlakyMeasurable {
  if (runs.length === 0) return 'unknown';
  let allIncapable = true;
  for (const run of runs) {
    const format = run.reporter_format;
    if (typeof format === 'string' && FLAKY_CAPABLE_FORMATS.includes(format)) {
      return 'yes';
    }
    if (typeof format !== 'string' || !FLAKY_INCAPABLE_FORMATS.includes(format))
      allIncapable = false;
  }
  return allIncapable ? 'no' : 'unknown';
}

/** Header + disclosures + whether a green all-clear may be printed. */
export function assessFlakyWindow(
  windowRequested: number,
  win: FlakyWindow | null,
): FlakyAssessment {
  if (win === null) {
    return {
      clean: false,
      header: `read UNKNOWN runs (window ${windowRequested})`,
      disclosures: [WINDOW_UNKNOWN_NOTE],
    };
  }
  return {
    clean: win.runs_read >= MIN_WINDOW_RUNS,
    header: `read ${win.runs_read} runs (window ${windowRequested})`,
    disclosures: knownWindowDisclosures(win),
  };
}

function knownWindowDisclosures(win: FlakyWindow): string[] {
  const notes: string[] = [];
  if (win.runs_read < MIN_WINDOW_RUNS) {
    notes.push(
      `${insufficientHistoryNote(win.runs_read)} \u{2014} no flake verdict`,
    );
  }
  if (win.flaky_measurable === 'no') notes.push(NOT_MEASURABLE_NOTE);
  if (win.flaky_measurable === 'unknown')
    notes.push(MEASURABILITY_UNKNOWN_NOTE);
  return notes;
}

/** The `--json` envelope (H3) for a completed flake query. */
export function buildFlakyEnvelope<R>(
  rows: R[],
  windowRequested: number,
  win: FlakyWindow | null,
): FlakyEnvelope<R> {
  const assessment = assessFlakyWindow(windowRequested, win);
  return {
    window_requested: windowRequested,
    runs_read: win === null ? null : win.runs_read,
    sufficient: win === null ? null : assessment.clean,
    flaky_measurable: win === null ? 'unknown' : win.flaky_measurable,
    rows,
    disclosures: assessment.disclosures,
  };
}

/**
 * The envelope for a store with ZERO runs -- the existing empty-history
 * abstention, now expressed inside the H3 payload so a JSON consumer reads the
 * abstention as a field rather than losing it to a stderr line.
 */
export function emptyStoreEnvelope(
  windowRequested: number,
): FlakyEnvelope<never> {
  return buildFlakyEnvelope<never>([], windowRequested, {
    runs_read: 0,
    flaky_measurable: 'unknown',
  });
}
