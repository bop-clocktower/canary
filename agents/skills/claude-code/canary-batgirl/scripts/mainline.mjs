// mainline -- red-mainline-commits, read from the run-history store
// (`test-results/reports/history-v2.jsonl`, one RunRecord per line,
// ts/src/history/schema.ts).
//
// The value is the COUNT of distinct commits on the branch with any recorded
// run where a test failed (spec D4). Not a share: a stream of small green
// commits would dilute a share without making main any less red. Any red run
// marks its commit, so re-running a red commit until it goes green does not
// help either. Only `branch`, `commit_sha` and `failed` are read; commit
// messages and test names never leave this module.

import { isRecord, plural } from './dimension.mjs';
import { parseJson } from './read.mjs';

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
 * @param {{limits: import('./read.mjs').Limits, branch: string}} opts
 * @returns {import('./dimension.mjs').Evaluation}
 */
export function redMainlineCommits(text, { limits, branch }) {
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
