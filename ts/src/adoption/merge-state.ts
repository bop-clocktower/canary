/**
 * Merge state from LOCAL git history (#491, decision D3). No GitHub API call.
 *
 * A record ref `pr-<n>` counts as merged when a first-parent subject on the
 * branch ends in `(#<n>)` (squash merge) or starts `Merge pull request #<n> `
 * (merge commit). Only the TRAILING `(#n)` counts: squash subjects routinely
 * cite other issues mid-line (`feat: x (#883) (#952)`), and matching those
 * would mark an unmerged PR as merged. A rebase-merged PR leaves no marker and
 * stays `unresolved`, which the report counts rather than guesses.
 */

import type { MergeState } from './signals.js';

type GitRunner = (args: string[]) => {
  status: number | null;
  stdout: string;
  stderr: string;
};

const PR_REF = /^pr-(\d+)$/;

/** Collect PR numbers the branch's subjects mark as merged. */
function mergedNumbers(log: string): Set<string> {
  const out = new Set<string>();
  for (const line of log.split('\n')) {
    const squash = /\(#(\d+)\)\s*$/.exec(line);
    if (squash?.[1] !== undefined) out.add(squash[1]);
    const merge = /^Merge pull request #(\d+)\b/.exec(line);
    if (merge?.[1] !== undefined) out.add(merge[1]);
  }
  return out;
}

export interface MergeResolution {
  states: Map<string, MergeState>;
  /**
   * Why git could not be consulted, when it could not. A failed `git log` is
   * NOT "nothing merged": a bad branch name or an unfetched remote would
   * otherwise render as a confident zero, which is the false green this
   * report exists to avoid.
   */
  problem: string | null;
}

export function resolveMergeState(
  refs: string[],
  branch: string,
  run: GitRunner,
): MergeResolution {
  const states = new Map<string, MergeState>();
  // `--` disambiguates a branch name that also matches a path.
  const res = run(['log', '--first-parent', '--format=%s', branch, '--']);
  const failed = res.status !== 0;
  const merged = failed ? new Set<string>() : mergedNumbers(res.stdout);
  for (const ref of refs) {
    const n = PR_REF.exec(ref)?.[1];
    if (n === undefined) {
      states.set(ref, 'not-a-pr');
    } else if (failed) {
      states.set(ref, 'unknown');
    } else {
      states.set(ref, merged.has(n) ? 'merged' : 'unresolved');
    }
  }
  return {
    states,
    problem: failed
      ? `git log ${branch} failed (${res.stderr.trim() || `exit ${String(res.status)}`})`
      : null,
  };
}
