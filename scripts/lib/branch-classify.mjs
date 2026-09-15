/**
 * Pure branch classification for scripts/branch-prune.mjs (#836, ADR 0022).
 *
 * Takes facts gathered from git (cherry, ls-remote, worktree list) and PR
 * state, and returns keep/delete with a reason. No I/O here, so the order of
 * the safety rules is the whole contract and reads top to bottom:
 *
 *   1. protected names are never candidates, whatever their merge state
 *   2. a branch checked out in a worktree (or named worktree-agent-*) is kept
 *   3. unverifiable facts keep the branch
 *   4. zero commits absent from origin/main (git cherry) is a candidate
 *   5. otherwise only a MERGED PR whose head equals the tip is a candidate
 */

/** Permanent protect-list. Never deleted, pruned, or force-pushed. */
export const PROTECTED_BRANCHES = Object.freeze([
  'main',
  'fix/mcp-tool-path-containment',
  'fix/migrator-workflow-symlink-escape',
]);

export function isProtected(branch) {
  return PROTECTED_BRANCHES.includes(branch) || branch.startsWith('release/');
}

function keep(branch, reason) {
  return { branch, action: 'keep', reason };
}

function candidate(branch, reason) {
  return { branch, action: 'delete', reason };
}

function isWorktreeBranch(facts) {
  return (
    facts.inWorktree === true || facts.branch.startsWith('worktree-agent-')
  );
}

function mergedPrAtTip(facts) {
  const prs = facts.prs ?? [];
  return prs.find((pr) => pr.state === 'MERGED' && pr.headRefOid === facts.tip);
}

function describeUnmerged(facts) {
  const states = (facts.prs ?? []).map((pr) => pr.state);
  const pr = states.length > 0 ? `PR ${states.join('/')}` : 'no PR';
  const pushed =
    facts.kind === 'local' && facts.remoteTip !== facts.tip
      ? '; local tip not on remote (unpushed)'
      : '';
  return `${facts.unique} commit(s) not on origin/main; ${pr}${pushed}`;
}

/**
 * @param {{branch: string, kind: 'local'|'remote', tip: string,
 *   remoteTip?: string|null, unique: number|null, inWorktree?: boolean,
 *   prs?: Array<{state: string, headRefOid: string}>}} facts
 */
export function classifyBranch(facts) {
  const { branch } = facts;
  if (isProtected(branch)) return keep(branch, 'protected (permanent list)');
  if (isWorktreeBranch(facts)) return keep(branch, 'checked out in a worktree');
  if (facts.unique === null) {
    return keep(branch, 'cannot verify: git cherry failed (tip not fetched?)');
  }
  if (facts.unique === 0) {
    return candidate(branch, 'no commits absent from origin/main (git cherry)');
  }
  const merged = mergedPrAtTip(facts);
  if (merged) {
    return candidate(
      branch,
      `PR MERGED at head ${facts.tip.slice(0, 8)}; ${facts.unique} commit(s) squashed`,
    );
  }
  return keep(branch, describeUnmerged(facts));
}
