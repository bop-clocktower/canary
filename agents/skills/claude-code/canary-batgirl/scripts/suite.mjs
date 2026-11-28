// suite -- the three count dimensions read from what canary records about the
// suite itself: tests switched off with no usable reason (katana ledger),
// tests that pass without proving anything (cassandra report), and mainline
// commits with a failing run (run-history store).
//
// All three are ABSOLUTE COUNTS on purpose (spec D4). A share over ledger rows
// is diluted by padding the ledger with caused rows; a share over tests
// checked is diluted by adding assertion-free tests, which cassandra does not
// flag (a zero-assertion test is review-test LINT-006, not a VAC finding); a
// share over commits is diluted by a stream of small green commits. A count is
// moved by none of them.
//
// The ledger's `author` field is never read (spec D1): only `cause` and
// `issue` are. From history only `branch`, `commit_sha` and `failed` are read;
// commit messages and test names never leave this module.

import { isRecord, plural } from './dimension.mjs';
import { LIMITS, overEntries, parseJson } from './read.mjs';

/** Mirrors CAUSES in canary-katana/scripts/ledger.mjs. */
const CAUSES = [
  'flaky',
  'product-defect',
  'blocked-data',
  'pending-feature',
  'obsolete',
  'env-gated',
];

/** Mirrors CAUSES_REQUIRING_ISSUE in canary-katana/scripts/ledger.mjs. */
const CAUSES_REQUIRING_ISSUE = [
  'product-defect',
  'blocked-data',
  'pending-feature',
];

const text = (v) => (typeof v === 'string' ? v.trim() : '');

function emptyLedgerTally() {
  const causes = {};
  for (const c of CAUSES) causes[c] = 0;
  return { no_cause: 0, unrecognised_cause: 0, missing_issue: 0, causes };
}

function tallyRow(t, row) {
  const cause = isRecord(row) ? text(row.cause) : '';
  if (!cause) {
    t.no_cause += 1;
    return;
  }
  if (!CAUSES.includes(cause)) {
    t.unrecognised_cause += 1;
    return;
  }
  t.causes[cause] += 1;
  if (CAUSES_REQUIRING_ISSUE.includes(cause) && !text(row.issue)) {
    t.missing_issue += 1;
  }
}

/**
 * unexplained-switch-offs: `.canary/quarantine.json`.
 *
 * @param {any} ledger
 * @param {{limits: import('./read.mjs').Limits}} opts
 * @returns {import('./dimension.mjs').Evaluation}
 */
export function unexplainedSwitchOffs(ledger, { limits }) {
  if (!isRecord(ledger)) return { reason: 'the ledger is not an object' };
  if (!Array.isArray(ledger.entries)) {
    return { reason: 'the ledger has no entries array' };
  }
  const rows = ledger.entries.length;
  const over = overEntries(rows, limits);
  if (over) return { reason: over };
  if (rows === 0) {
    return { reason: 'the ledger holds 0 rows: nothing switched off to judge' };
  }
  const t = emptyLedgerTally();
  for (const row of ledger.entries) tallyRow(t, row);
  const value = t.no_cause + t.unrecognised_cause + t.missing_issue;
  return {
    value,
    basis:
      `${value} of ${rows} switched-off tests have no usable cause: ` +
      `${t.no_cause} no cause, ${t.unrecognised_cause} unrecognised cause, ` +
      `${t.missing_issue} without the issue its cause requires`,
    detail: { rows, ...t },
  };
}

function cassandraProblem(report) {
  const recognised =
    isRecord(report) &&
    report.schema_version === 1 &&
    Array.isArray(report.findings) &&
    isRecord(report.summary) &&
    Number.isInteger(report.summary.tests_checked);
  if (!recognised) return 'not a canary-cassandra --json report';
  if (report.summary.abstained === true) {
    return 'canary-cassandra abstained: it read no test';
  }
  if (report.summary.tests_checked <= 0) {
    return 'canary-cassandra checked 0 tests';
  }
  return null;
}

/** A test is identified by its file and its name (cassandra's `snippet`). */
const testKey = (f) =>
  isRecord(f) ? `${text(f.file)}\u0000${text(f.snippet)}` : '\u0000';

/**
 * vacuous-tests: a `canary-cassandra --json` report.
 *
 * @param {any} report
 * @param {{limits: import('./read.mjs').Limits}} opts
 * @returns {import('./dimension.mjs').Evaluation}
 */
export function vacuousTests(report, { limits }) {
  const problem = cassandraProblem(report);
  if (problem) return { reason: problem };
  const over = overEntries(report.findings.length, limits);
  if (over) return { reason: over };
  const checked = report.summary.tests_checked;
  const value = new Set(report.findings.map(testKey)).size;
  return {
    value,
    basis: `${plural(value, 'vacuous test')} among ${checked} tests checked`,
    detail: {
      tests_checked: checked,
      findings: report.findings.length,
      vacuous_tests: value,
    },
  };
}

/** Mirrors SUPPORTED_SCHEMA_VERSIONS in ts/src/history/record.ts. */
const SUPPORTED_SCHEMA_VERSIONS = [2, 3];

function recordProblem(record) {
  if (!isRecord(record)) return 'not an object';
  const version = record.schema_version ?? 2;
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(version)) {
    return `unsupported schema_version ${JSON.stringify(version)}`;
  }
  return null;
}

/** Parse each non-blank line, or say which line failed and why. */
function parseRuns(lines) {
  const runs = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    const parsed = parseJson(line);
    if (parsed.kind !== 'ok') {
      return { reason: `history line ${i + 1} is ${parsed.reason}` };
    }
    const problem = recordProblem(parsed.value);
    if (problem) return { reason: `history line ${i + 1}: ${problem}` };
    runs.push(parsed.value);
  }
  return { runs };
}

/** Any red run marks its commit: re-running a red commit green does not help. */
function tallyCommits(runs, branch) {
  const red = new Map();
  let onBranch = 0;
  for (const run of runs) {
    if (run.branch !== branch) continue;
    onBranch += 1;
    const sha = typeof run.commit_sha === 'string' ? run.commit_sha : '';
    if (!sha || !Number.isInteger(run.failed)) continue;
    red.set(sha, red.get(sha) === true || run.failed > 0);
  }
  const redCommits = [...red.values()].filter(Boolean).length;
  return { onBranch, commits: red.size, redCommits };
}

/**
 * red-mainline-commits: the run-history NDJSON store's text.
 *
 * @param {string} text
 * @param {{limits?: import('./read.mjs').Limits, branch: string}} opts
 * @returns {import('./dimension.mjs').Evaluation}
 */
export function redMainlineCommits(text, { limits = LIMITS, branch }) {
  const lines = text.split(/\r\n|\r|\n/);
  const count = lines.filter((l) => l.trim()).length;
  if (count > limits.lines) {
    return {
      reason: `not read: ${count} lines is over the ${limits.lines}-line limit`,
    };
  }
  const { runs, reason } = parseRuns(lines);
  if (reason) return { reason };
  const t = tallyCommits(runs, branch);
  if (t.commits === 0) {
    return {
      reason: `${plural(runs.length, 'run')} read, none on branch ${branch}`,
    };
  }
  return {
    value: t.redCommits,
    basis:
      `${t.redCommits} of ${plural(t.commits, 'commit')} on ${branch} had ` +
      'a run with a failing test',
    detail: {
      runs_read: runs.length,
      runs_on_branch: t.onBranch,
      commits: t.commits,
      red_commits: t.redCommits,
    },
  };
}
