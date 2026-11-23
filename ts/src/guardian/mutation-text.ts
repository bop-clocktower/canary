/**
 * The mutation report's wording and Markdown escaping (#1568).
 *
 * Split from `mutation-report.ts` to keep it inside the 300-line perf budget.
 * Everything a Stryker report supplies (paths, mutator names, replacements,
 * test names) and every suppression reason is untrusted text on its way into a
 * PR comment, so it is rendered through {@link mdCode} or {@link mdText}.
 */

import type { MutationReport } from './mutation.js';

/**
 * Text as an inert Markdown code span. The fence is one backtick longer than
 * the longest run inside it, padded when the text starts or ends with one: a
 * StringLiteral mutant's replacement is often exactly two backticks.
 */
export function mdCode(raw: string): string {
  // One line: a newline inside a list item could end it (#1568 review).
  const text = raw.replace(/\s*[\r\n]+\s*/g, ' ');
  if (text.trim() === '') return '(empty)';
  const runs = text.match(/`+/g) ?? [];
  const fence = '`'.repeat(Math.max(0, ...runs.map((r) => r.length)) + 1);
  const pad = /^`|`$/.test(text) ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** Text as plain Markdown that cannot open a code span, emphasis or a tag. */
export const mdText = (text: string): string =>
  text.replace(/\s*[\r\n]+\s*/g, ' ').replace(/[\\`*_[\]<>|]/g, '\\$&');

/**
 * Why a run that killed nothing, and had nothing survive or time out, is an
 * abstention. A suppressed survivor DID run a test, so once survivors were
 * suppressed only the no-coverage mutants may be called uncovered.
 */
export function noKillReason(report: Omit<MutationReport, 'verdict'>): string {
  const suppressed = report.suppressed.length;
  if (suppressed === 0) {
    return 'no mutant was covered by any test, so nothing could be killed';
  }
  const gaps =
    report.noCoverage > 0
      ? ` and ${report.noCoverage} had no covering test`
      : '';
  return (
    `no mutant was killed: ${suppressed} survivor(s) were suppressed with ` +
    `canary:allow-mutant${gaps}, so the run verified nothing`
  );
}

/** The disclosure line every report carries, abstentions included. */
export function excludedLine(report: MutationReport): string {
  if (report.excludedTests.length === 0) {
    return 'No test files were excluded from the mutation run.';
  }
  return (
    `${report.excludedTests.length} test file(s) excluded from the mutation ` +
    `run (they cannot run in Stryker's worker-thread pool), so a mutant only ` +
    `these would kill reads as survived: ${report.excludedTests.map(mdCode).join(', ')}`
  );
}
