// Commit authorship is a leak surface the file scan cannot see: the company
// email never appears *in* a tracked file, only in the metadata of the commit
// that carries it. 190 commits reached the public history that way, every one
// of them from a clone that inherited a global `user.email` instead of this
// repo's pin.
//
// Only the commits a change ADDS are scanned. Existing history is deliberately
// left alone — rewriting it would rebase every SHA this repo cites in issues,
// ADRs, and `.github/required-checks.json`'s own comments — so the gate stops
// the bleed rather than relitigating the past.
//
// Split out of check_removed_symbols.mjs to keep both under the performance
// ratchet's complexity and length thresholds.
import { execFileSync } from 'node:child_process';

export const AUTHOR_RANGE_ENV = 'CANARY_AUTHOR_SCAN_RANGE';

/** Identities that appear in a `Name <email>` trailer. */
const TRAILER =
  /^(?:co-authored|signed-off|reviewed|acked|tested|reported|suggested|helped|mentored)-by:\s*(.+)$/gim;

/** A range `git log` will read as a range rather than as a flag. */
const RANGE_SHAPE = /^[\w./^~-]+\.{2,3}[\w./^~-]+$/;

function reEscape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Denylist terms are authored for the FILE scan, where they read like prose
 * ("Acme Health", "Acme Inc."). An identity string has a different grammar,
 * and `\b<term>\b` silently never matches three common shapes against it:
 *
 *   term          identity                      \b-anchored
 *   Acme Health   dev@acmehealth.example        MISS  (separator dropped)
 *   Acme Health   dev@acme-health.example       MISS  (separator changed)
 *   Acme Inc.     Acme Inc. <a@b>               MISS  (\b after `.` needs a
 *                                                      word char next)
 *   Café          Café <a@b>                    MISS  (\b is ASCII-only)
 *
 * A term that cannot match its own source string is a dud pattern, and it
 * fails open — the worst direction for a gate. So the authorship scan compiles
 * its own: split the term into alphanumeric tokens, allow any run of
 * separators between them, and bound it with unicode-aware lookarounds rather
 * than `\b`. Boundaries are still enforced, so `Acme` must not match
 * `acmecorp`.
 */
export function authorshipPatterns(denylist) {
  return denylist
    .map(([rx]) => rx.source.replace(/^\\b|\\b$/g, '').replace(/\\(.)/g, '$1'))
    .map((term) => term.split(/[^\p{L}\p{N}]+/u).filter(Boolean))
    .filter((tokens) => tokens.length)
    .map((tokens) => {
      const body = tokens.map(reEscape).join('[^\\p{L}\\p{N}]*');
      return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'iu');
    });
}

function revExists(rev, scanRoot) {
  try {
    execFileSync(
      'git',
      ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`],
      {
        cwd: scanRoot,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return true;
  } catch {
    return false;
  }
}

function envStr(env, key) {
  return (env[key] ?? '').trim();
}

/**
 * pull_request: everything this PR adds on top of its base.
 *
 * The range ends at the PR HEAD, not at `HEAD`. On a `pull_request` event
 * `actions/checkout` checks out `refs/pull/N/merge` — an ephemeral commit
 * GitHub synthesises by merging the branch into the base, authored with the
 * PR author's ACCOUNT email. It is discarded at merge and never reaches the
 * public history, so scanning it reports a leak that cannot happen: a false
 * positive on every PR opened from an account whose commit email is not the
 * one it should be. (Which is the very situation this gate exists to detect
 * elsewhere, so it made for a confusing red.)
 */
function pullRequestRange(env) {
  const base = envStr(env, 'GITHUB_BASE_REF');
  if (!base) return null;
  const head = envStr(env, 'GITHUB_PR_HEAD_SHA');
  return `origin/${base}..${head || 'HEAD'}`;
}

/**
 * push: the commits this push introduced. `before` is all-zeroes on the first
 * push to a new branch, which is no usable range.
 */
function pushRange(env) {
  const before = envStr(env, 'GITHUB_EVENT_BEFORE');
  if (!before || /^0+$/.test(before)) return null;
  return `${before}..HEAD`;
}

function rangeFromEvent(env) {
  return pullRequestRange(env) ?? pushRange(env);
}

export function resolveRange(env, { scanRoot, scanRootOverridden }) {
  const override = envStr(env, AUTHOR_RANGE_ENV);
  if (override) return override;

  const candidate = rangeFromEvent(env);
  if (!candidate) return null;

  // A fixture root is not this repository, so the ambient GitHub environment
  // describes the wrong tree — `origin/<base>` does not resolve inside it,
  // and trying turned every fixture run into an abstention. Rather than
  // ignoring the event wholesale for an overridden root (which would also
  // make the real resolution path untestable), check whether the left side
  // actually exists in the tree being scanned.
  if (scanRootOverridden && !revExists(candidate.split('..')[0], scanRoot)) {
    return null;
  }
  return candidate;
}

function readCommits(range, scanRoot) {
  try {
    // NOT --no-merges. "Merge branch 'main' into <feature>" made in a fresh
    // clone is one of the likeliest ways a company identity reaches a public
    // branch, and skipping merges would leave exactly that commit unread
    // while the denominator still reported a confident count.
    //
    // %B carries the trailers. `Co-authored-by:` is not a comment — GitHub
    // renders it as a linked contributor on the public commit page, so it is
    // a MORE visible identity surface than the author field. Records are
    // RS-separated because %B is multi-line.
    const out = execFileSync(
      'git',
      ['log', '--format=%H%x00%an <%ae>%x00%cn <%ce>%x00%B%x1e', range],
      { cwd: scanRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return {
      records: out
        .split('\x1e')
        .map((r) => r.replace(/^\n/, ''))
        .filter((r) => r.trim()),
    };
  } catch (err) {
    // A shallow clone cannot resolve the base commit — the common cause, but
    // not the only one ("not a git repository", a bad revision, git missing).
    // Carry git's own stderr so the abstention is diagnosable instead of
    // always blaming fetch-depth.
    const detail = String(err?.stderr ?? '')
      .trim()
      .split('\n')[0];
    return { unresolved: detail ? `${range} — ${detail}` : range };
  }
}

/** Every identity a single commit puts on the public record. */
function identitiesOf(record) {
  const [sha, author, committer, body = ''] = record.split('\0');
  return {
    sha,
    roles: [
      ['author', author],
      ['committer', committer],
      ...[...body.matchAll(TRAILER)].map((m) => ['trailer', m[1].trim()]),
    ],
  };
}

function violationLine(sha, roles) {
  const short = sha.slice(0, 9);
  // Deliberately NOT the matched identity. Actions logs on a public repo are
  // world-readable, so echoing it would publish the address this gate exists
  // to keep off the public record — and it would do so on exactly the commits
  // that trip it. The SHA and field are enough to act on.
  //
  // One row per commit, not per field: `user.email` sets author and committer
  // together, so the common case matches twice.
  return (
    `${short} ${roles.join('/')} matched the denylist\n` +
    '    → company identity on a public commit ' +
    `(inspect locally: git log -1 --format='%an <%ae> %cn <%ce>' ${short})`
  );
}

function noDenylist(env) {
  // Zero patterns over any number of commits matches nothing, so this is an
  // abstention in every environment. It is only *tolerable* off CI, where a
  // contributor legitimately has no secret and the pre-commit hook already
  // warns. Inside Actions it means the gate is dark, and the two ways that
  // happens are both invisible: a rotated or renamed secret, and a PR from a
  // fork (GitHub does not pass secrets to fork-triggered workflows).
  return env.GITHUB_ACTIONS
    ? {
        unresolved: 'no denylist available — the gate cannot match anything',
        advice:
          'Either the denylist secret is unset or rotated, or this is a ' +
          'pull request from a fork (GitHub does not pass secrets to ' +
          'fork-triggered workflows). Both leave the gate matching zero ' +
          'patterns, which is not something that can be reported as a pass.',
      }
    : { skipped: 'no denylist configured (local run)' };
}

export function checkAuthorship({
  denylist,
  scanRoot,
  scanRootOverridden,
  env = process.env,
}) {
  const patterns = authorshipPatterns(denylist);
  if (!patterns.length) return noDenylist(env);

  const range = resolveRange(env, { scanRoot, scanRootOverridden });
  // Nothing to resolve a range *against* — a fixture root is not this repo, so
  // skipping is correct there. In the real tree it is an abstention: the gate
  // did not decline to run, it failed to work out what to read.
  if (!range) {
    return scanRootOverridden
      ? { skipped: 'scan root overridden with no explicit range' }
      : { unresolved: 'no commit range could be determined from the event' };
  }
  // execFileSync uses no shell, so this is not injection — but `git log` still
  // reads a leading `-` as a flag (`--output=…` writes a file).
  if (!RANGE_SHAPE.test(range) || range.startsWith('-')) {
    return { unresolved: `${range} (not a well-formed commit range)` };
  }

  const { records, unresolved } = readCommits(range, scanRoot);
  if (unresolved) return { unresolved };
  // Zero commits is not a clean scan, it is no scan. Reporting "0 commit(s)
  // checked" beside a clean verdict is the zero-denominator false green this
  // repo keeps re-learning (#554, #761) — a real PR always adds a commit, so
  // an empty range means the range was wrong.
  if (!records.length) {
    return { unresolved: `${range} (resolved, but contained no commits)` };
  }

  const violations = [];
  for (const record of records) {
    const { sha, roles } = identitiesOf(record);
    const hits = roles
      .filter(([, ident]) => patterns.some((rx) => rx.test(ident)))
      .map(([who]) => who);
    if (hits.length) violations.push(violationLine(sha, hits));
  }
  return { violations, scanned: records.length, range };
}

/** The findings block, or '' when there is nothing to report. */
export function renderViolations(authorship) {
  if (!authorship.violations?.length) return '';
  return (
    '\nCompany identifiers found in commit authorship:\n\n' +
    authorship.violations.join('\n') +
    '\n\nThis repo is public. Fix the commits on this branch before merging:\n' +
    "  git config user.email '<your public address>'\n" +
    '  git rebase -r --exec "git commit --amend --no-edit --reset-author" ' +
    `${authorship.range?.split('..')[0] ?? 'origin/main'}\n` +
    'Then force-push the branch. Set the address once per clone — a fresh ' +
    'clone inherits the global identity, which is how these get in.\n'
  );
}

/** The abstention notice, or '' when the scan actually ran. */
export function renderAbstention(authorship) {
  if (!authorship.unresolved) return '';
  return (
    `\nAuthorship scan abstained: ${authorship.unresolved}\n` +
    'This is an abstention, not a clean result — no commit was checked.\n' +
    (authorship.advice ??
      'The usual cause is a checkout without full history; the job needs ' +
        'actions/checkout with `fetch-depth: 0`. A force-pushed ' +
        '`github.event.before` that is no longer reachable looks the same.') +
    '\n'
  );
}

/** The clause appended to the clean line, naming the denominator. */
export function renderDenominator(authorship) {
  return authorship.skipped
    ? `authorship scan skipped (${authorship.skipped})`
    : `${authorship.scanned} commit(s) checked for authorship`;
}
