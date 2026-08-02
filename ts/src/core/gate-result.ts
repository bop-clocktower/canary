/**
 * Shared gate-abstention helper (issue #508, no-silent-abstention spec).
 *
 * Doctrine: a check that verified zero items has ABSTAINED, not passed.
 * Every gate reports its denominator (`checked`); zero is a distinct loud
 * outcome. "Skipped" renders in every summary line and never aggregates
 * into "passed" (D7).
 *
 * `gateOutcome` is the only path to a summary line for swept commands, so
 * the refusal to print bare success on a zero denominator is structural.
 * Surfaces append their own remediation text (why the denominator
 * collapsed, first fix step) after the summary line.
 *
 * Output glyphs are written as `\u{...}` escapes so this source stays
 * ASCII while the emitted bytes match the rest of the CLI (warning sign
 * U+26A0, em dash U+2014).
 */

/** A check that was not run, and why. Always visible, never "passed". */
export interface SkipEntry {
  name: string;
  reason: string;
}

/** What a gate actually verified: its denominator and what it found. */
export interface GateResult<F> {
  /** How many items were actually verified. Skipped items do NOT count. */
  checked: number;
  findings: F[];
  skipped?: SkipEntry[];
}

/**
 * Reserved CLI-wide (D4): exit 3 always means "abstained -- verified zero
 * items", distinct from 0 (clean), 1 (findings), 2 (surface-specific).
 */
export const EXIT_ABSTAINED = 3;

/**
 * D3: a "gate" has an exit-code contract and fails loud (exit 3) on a zero
 * denominator; an "advisory" command warns unmissably but exits 0 -- an
 * empty answer honestly labeled is not an error.
 */
export type GateKind = 'gate' | 'advisory';

export interface GateOutcome {
  exitCode: number;
  abstained: boolean;
  summaryLine: string;
}

/** Copy hooks: surfaces adapt wording without re-owning the decision. */
export interface GateOutcomeOptions {
  /** Unit noun for the clean-pass line. Default: `'check(s)'`. */
  noun?: string;
}

const WARN = '\u{26A0}'; // warning sign
const EMDASH = '\u{2014}'; // em dash

// C0 controls (incl. \n, ESC) and DEL: a skip name must never be able to
// forge output lines or smuggle ANSI sequences into the summary.
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

/** D7: skipped entries render in EVERY summary line. */
function skippedSuffix(skipped?: SkipEntry[]): string {
  if (!skipped || skipped.length === 0) return '';
  const names = skipped
    .map((s) => s.name.replace(CONTROL_CHARS, ''))
    .join(', ');
  return ` (${skipped.length} skipped: ${names})`;
}

/**
 * The single summary-line/exit-code path for swept commands.
 *
 * Non-abstained exit codes are helper defaults (findings -> 1 for gates);
 * surfaces with richer contracts (e.g. freshness 2 = local edits) apply
 * their own mapping AFTER checking `abstained`.
 */
export function gateOutcome<F>(
  result: GateResult<F>,
  kind: GateKind,
  opts: GateOutcomeOptions = {},
): GateOutcome {
  const noun = opts.noun ?? 'check(s)';
  const suffix = skippedSuffix(result.skipped);
  // Findings outrank abstention: a finding proves something was checked,
  // so it must never be masked by a collapsed/invalid denominator.
  if (result.findings.length > 0) {
    return {
      exitCode: kind === 'gate' ? 1 : 0,
      abstained: false,
      summaryLine:
        `${result.findings.length} finding(s) across ` +
        `${result.checked} checked${suffix}`,
    };
  }
  // Negated comparison so 0, negatives, and NaN all abstain: an invalid
  // denominator must never render as success.
  if (!(result.checked > 0)) {
    return {
      exitCode: kind === 'gate' ? EXIT_ABSTAINED : 0,
      abstained: true,
      summaryLine:
        `${WARN} Abstained ${EMDASH} verified zero items; ` +
        `this is not a pass.${suffix}`,
    };
  }
  return {
    exitCode: 0,
    abstained: false,
    summaryLine: `All ${result.checked} run ${noun} passed${suffix}`,
  };
}
