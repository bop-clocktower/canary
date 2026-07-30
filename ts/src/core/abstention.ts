/**
 * No silent abstention (#508) -- the shared denominator/abstention helper.
 *
 * Doctrine: a check that verified zero items has ABSTAINED, not passed. Every
 * gate, doctor check, and analysis command must (a) report its denominator --
 * how many items it actually verified -- and (b) treat denominator-zero as a
 * distinct loud outcome: gates exit {@link EXIT_ABSTAINED}; advisory commands
 * print an explicit `⚠ abstained: <reason>` line. "Skipped" never
 * aggregates into "passed".
 *
 * The pattern was established by `migrate --check` (#503, PR #510), where a
 * freshness gate that matched zero overlay skills exited 0 and rendered a
 * shape-detection regression permanently green. This module generalizes that
 * fix into one convention so every command speaks the same language and no new
 * command invents its own zero-denominator green path.
 */

/**
 * Distinct exit code for a gate that verified zero items. Sits after the
 * common gate ladder (0 = clean, 1 = findings, 2 = refusal/usage) so CI can
 * tell "verified and clean" from "verified nothing".
 */
export const EXIT_ABSTAINED = 3;

const WARN = '\u{26a0}'; // warning sign
const EMDASH = '\u{2014}'; // em dash

/**
 * What every gate/check returns: the findings AND the denominator behind
 * them. A `findings: []` with `checked: 0` is an abstention, not a pass.
 */
export interface GateOutcome<F = unknown> {
  /** How many items the check actually verified. 0 means abstained. */
  checked: number;
  findings: F[];
}

/** A check that verified zero items has abstained, not passed. */
export function isAbstention(outcome: Pick<GateOutcome, 'checked'>): boolean {
  return outcome.checked === 0;
}

/**
 * The loud one-liner for a zero-denominator outcome. One fixed shape so both
 * humans and log-grep alerts can key on `abstained:`.
 */
export function abstentionNotice(reason: string): string {
  return `${WARN} abstained: ${reason} ${EMDASH} 0 items were checked, so this is not a pass.`;
}

/**
 * CLI-layer guard: refuse to render a success line when the denominator is
 * zero. Returns the success line only when something was actually verified,
 * otherwise the abstention notice (and flags it so gates can exit
 * {@link EXIT_ABSTAINED}).
 */
export function successOrAbstain(
  outcome: Pick<GateOutcome, 'checked'>,
  successLine: string,
  reason: string,
): { line: string; abstained: boolean } {
  return isAbstention(outcome)
    ? { line: abstentionNotice(reason), abstained: true }
    : { line: successLine, abstained: false };
}
