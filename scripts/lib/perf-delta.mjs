/**
 * The merge-base delta rule, and the allowance list that makes it fair (#850).
 *
 * The ceiling in `.harness/perf-baseline.json` is an ABSOLUTE total, so its
 * headroom is a shared budget no branch can see; it reached zero on
 * 2026-09-09. The delta rule judges a branch on what IT introduced against the
 * commit it branched from, which is order-independent and visible to the
 * author.
 *
 * Split out of `perf-ratchet.mjs` because that script tripped its own
 * file-length and complexity thresholds once identity comparison landed there.
 * The gate caught its own change — the outcome #850 argued for — and the
 * honest response was to split the file rather than to allowance it.
 */

import {
  KNOWN_RULES,
  allowanceFor,
  diffFindings,
  reportUnusedAllowances,
} from './perf-findings.mjs';
import { fail, readReportText, readViolations } from './perf-report.mjs';

/**
 * Validate the allowance list, and refuse one that cannot be reviewed.
 *
 * A list that can grow by one unexplained line is how a gate rots, so `why` is
 * mandatory. An unknown `rule` is a config ERROR rather than an entry that
 * silently matches nothing — a typo'd rule name would otherwise look exactly
 * like a working allowance until the day it was needed.
 */
export function readAllowances(raw, baseline) {
  if (!Array.isArray(raw)) {
    fail(2, `perf-ratchet: ${baseline} has a non-array "deltaAllowances".`);
  }
  return raw.map((entry, i) => {
    const where = `deltaAllowances[${i}]`;
    if (typeof entry?.rule !== 'string' || typeof entry?.path !== 'string') {
      fail(2, `perf-ratchet: ${where} needs a string "rule" and "path".`);
    }
    if (typeof entry.why !== 'string' || entry.why.trim() === '') {
      fail(
        2,
        `perf-ratchet: ${where} has no "why". Every allowance must state why ` +
          'the finding is structural and not a regression, so the list stays ' +
          'reviewable instead of accumulating unexplained entries.',
      );
    }
    if (!KNOWN_RULES.includes(entry.rule)) {
      fail(
        2,
        `perf-ratchet: ${where} names unknown rule "${entry.rule}". ` +
          `Known rules: ${KNOWN_RULES.join(', ')}.`,
      );
    }
    return entry;
  });
}

/** The two scans described different trees; any number here would be invented. */
function abstainUnaligned() {
  fail(
    3,
    'perf-ratchet: ABSTAINED — the head and merge-base reports share no ' +
      'file, so their paths could not be aligned. The two scans run under ' +
      'different roots by design (the base worktree lives outside the ' +
      'checkout), so pass --report-root and --base-report-root. Reporting a ' +
      'delta from unaligned sets would be a made-up number in either ' +
      'direction.',
  );
}

/**
 * The original rule, kept for when per-finding detail is unavailable.
 *
 * Allowances cannot apply here: a partial set cannot be reasoned about
 * honestly. The downgrade is ANNOUNCED rather than assumed, so a run that
 * quietly lost its allowances is visible in the log.
 */
function compareByCount(violations, base) {
  const delta = violations - base;
  if (delta > 0) {
    fail(
      1,
      `perf-ratchet: FAILED — this branch introduces ${delta} performance ` +
        `violation(s): ${base} at the merge base, ${violations} here.\n` +
        'Compared by COUNT: a report did not parse into per-finding detail, ' +
        'so structural allowances did not apply. Fix the new violations or ' +
        'split the file that grew.',
    );
  }
  console.log(
    `perf-ratchet: delta OK by count — ${violations} here against ${base} ` +
      `at the merge base (${delta >= 0 ? '+' : ''}${delta}). Per-finding ` +
      'detail was unavailable, so no allowance was applied.',
  );
}

/**
 * Partition the new findings into allowed and blocking, naming each allowance
 * as it applies. An applied allowance is never silent: a suppressed finding
 * nobody can see is the false green the list is meant to prevent.
 */
function partition(added, allowances) {
  const blocking = [];
  for (const f of added) {
    const allowance = allowanceFor(f, allowances);
    if (!allowance) {
      blocking.push(f);
      continue;
    }
    console.log(
      `perf-ratchet: allowed — ${f.path}: ${f.message}\n` +
        `  by allowance ${allowance.rule} ${allowance.path}: ${allowance.why}`,
    );
  }
  return blocking;
}

/** Name every blocking finding, so the author fixes rather than guesses. */
function failWithBlocking(blocking) {
  const listed = blocking
    .map((f) => `  * ${f.path}\n    ${f.message}`)
    .join('\n');
  fail(
    1,
    `perf-ratchet: FAILED — this branch introduces ${blocking.length} ` +
      `performance violation(s) its merge base did not have:\n${listed}\n\n` +
      'This is the delta YOUR diff added, measured against the commit you ' +
      'branched from, so it is not affected by what else merged in the ' +
      'meantime. Fix them, or split the file that grew. If a finding is ' +
      'structural — a CLI wiring module trips the coupling rule by ' +
      'definition — add a reviewed "deltaAllowances" entry with a "why".',
  );
}

/**
 * Annotate already-flagged findings that grew (#854). ADVISORY by decision:
 * over the 40 merges before this landed, 11 grew one, mostly `cli.ts` by a
 * line or two per subcommand, so blocking would have failed over a quarter
 * of all merges. A `::warning` reaches the PR's Checks summary, which a log
 * line does not (#718). Promote to blocking only on evidence from these
 * annotations; ADR 0014 records the decision.
 */
function annotateGrowth(grown) {
  for (const { finding: f, from, to } of grown) {
    const subject = f.subject ? ` ${f.subject}` : '';
    console.log(
      `::warning title=perf growth (advisory)::${f.path} ${f.rule}${subject} ` +
        `grew ${from} -> ${to}. Already over threshold at the merge base; ` +
        'this branch made it bigger.',
    );
  }
  if (grown.length > 0) {
    console.log(
      `perf-ratchet: ${grown.length} already-flagged finding(s) grew ` +
        '(advisory, does not affect the verdict).',
    );
  }
}

/**
 * Fail when this branch introduced findings its merge base did not have.
 *
 * Prefers an IDENTITY diff, which is what lets a reviewed allowance exempt a
 * structural finding. Falls back to the COUNT comparison when either report
 * cannot be parsed completely, and abstains when the two cannot be aligned.
 */
export function requireNoDelta(baseReport, violations, maxViolations, opts) {
  const base = readViolations(baseReport, maxViolations, 'merge-base');
  const diff = diffFindings(
    readReportText(opts.report, 'head'),
    readReportText(baseReport, 'merge-base'),
    violations,
    base,
    opts.roots,
  );

  if (diff === 'unaligned') return abstainUnaligned();
  if (diff === null) return compareByCount(violations, base);

  const { head, added, grown } = diff;
  annotateGrowth(grown);
  const blocking = partition(added, opts.allowances);
  reportUnusedAllowances(opts.allowances, head);
  if (blocking.length > 0) failWithBlocking(blocking);

  console.log(
    `perf-ratchet: delta OK — ${added.length} new finding(s) against the ` +
      `merge base, ${added.length - blocking.length} allowed, 0 blocking ` +
      `(${violations} here, ${base} at the base).`,
  );
}
