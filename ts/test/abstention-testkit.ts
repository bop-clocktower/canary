/**
 * One way to report that a test abstained (#650).
 *
 * Some invariants in this suite can only be checked where data exists that is
 * untracked by design — `.claude/skills/` install receipts, the `.remember` and
 * `.kiro` agent-state directories behind `knowledge.domainBlocklist`. On a
 * fresh clone and in CI those are simply absent, so the honest outcome is
 * "nothing was checked", which must never render as a green tick.
 *
 * The catch, and the reason this file exists: **`console.warn` does not work
 * for this.** Vitest intercepts console output, and the DEFAULT reporter — the
 * one `npm test` and every CI job use — discards it for passing tests. It also
 * does not name which test was skipped; the whole record of an abstention is
 * the digit in `1 skipped`. Measured on vitest 4.1.10:
 *
 *     console.warn(...)          default reporter: not printed
 *     process.stderr.write(...)  default reporter: printed
 *
 * So an abstention notice written the obvious way is itself silent, which is
 * the failure mode it was added to prevent. Route them through here instead.
 */

/**
 * Announce that a check could not run, and why, on a channel the default
 * reporter actually prints.
 *
 * @param scope  Short bracketed subject, e.g. `domainBlocklist`.
 * @param reason What was not proven, and why it could not be — enough that a
 *               reader does not have to guess whether the run was healthy.
 */
export function reportAbstention(scope: string, reason: string): void {
  process.stderr.write(`[${scope}] SKIPPED — ${reason}\n`);
}

/** Counterpart for the run that did have a denominator, for symmetry in logs. */
export function reportVerified(scope: string, detail: string): void {
  process.stderr.write(`[${scope}] verified — ${detail}\n`);
}
