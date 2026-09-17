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

export function resolveMergeState(
  refs: string[],
  branch: string,
  run: GitRunner,
): Map<string, MergeState> {
  const result = new Map<string, MergeState>();
  const res = run(['log', '--first-parent', '--format=%s', branch]);
  const merged =
    res.status === 0 ? mergedNumbers(res.stdout) : new Set<string>();
  for (const ref of refs) {
    const n = PR_REF.exec(ref)?.[1];
    result.set(ref, n !== undefined && merged.has(n) ? 'merged' : 'unresolved');
  }
  return result;
}
