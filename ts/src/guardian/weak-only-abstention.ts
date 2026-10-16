/**
 * The weak-only abstention rule (#1305), kept apart from `weak-test.ts` so that
 * module stays a pure finding producer under the 300-line perf ceiling.
 */

import type { GuardianFinding } from './pr-check.js';

/**
 * True when a run checked NO source unit and every finding is a weak-test one
 * (#1305). That run judged only the tests the diff adds, never the code under
 * them, so it abstains (exit 3) exactly as the same diff with an asserting test
 * does. The findings stay on every surface; they just cannot stand in for a
 * checked unit. A worse test must never turn an abstention into a pass. The
 * empty case belongs to the findings-eligible abstention, which exits earlier.
 */
export function isWeakOnlyAbstention(
  checked: number,
  findings: GuardianFinding[],
): boolean {
  return (
    checked === 0 &&
    findings.length > 0 &&
    findings.every((f) => f.kind === 'weak-test')
  );
}
