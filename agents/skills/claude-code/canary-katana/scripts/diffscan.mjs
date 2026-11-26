// diffscan -- find deleted and newly-skipped tests in a unified diff.
//
// Line-oriented and parser-free so it ships anywhere node does. Classifies each
// event as a REMOVED test (a declaration that left on a `-` line) or a SKIPPED
// test (a skip/xfail/only/fixme marker that arrived on a `+` line), and -- when
// pointed at a git repo -- attaches the commit provenance.
//
// A test flipped in place from `it('x')` to `it.skip('x')` is one event, not
// two: the skip supersedes the removal so the ledger never double-counts it.
//
// The general form of that rule is that a `-` declaration is only a REMOVAL if
// the same (file, title) does not come back on the `+` side. Anything that
// rewrites a declaration line -- a prettier reflow, a `.skip` lifted in place --
// otherwise records a deletion of a test that is still in the tree (#783).

import { spawnSync } from 'node:child_process';

export const Kind = { REMOVED: 'removed', SKIPPED: 'skipped' };

/**
 * @typedef {{name: string, file: string, kind: string, line: number,
 *            marker: string}} Deletion
 */

/** Build a Deletion with defaults. */
function deletion({ name, file, kind, line = 0, marker = '' }) {
  return { name, file, kind, line, marker };
}

/** JSON-contract shape of a Deletion. */
export function deletionToDict(d) {
  return {
    name: d.name,
    file: d.file,
    kind: d.kind,
    line: d.line,
    marker: d.marker,
  };
}

// --- test-file classification ---------------------------------------------

export const TEST_DIR_SEGMENTS = new Set([
  'tests',
  'test',
  '__tests__',
  'e2e',
  'spec',
]);
const TEST_BASENAME_RE =
  /(^test_.*\.py$)|(.*_test\.py$)|(.*\.spec\..+$)|(.*\.test\..+$)/;

/** Does `path` look like a test file? Matches on path segments, not substrings. */
export function isTestFile(p) {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  if (!parts.length) return false;
  if (parts.slice(0, -1).some((seg) => TEST_DIR_SEGMENTS.has(seg))) return true;
  return TEST_BASENAME_RE.test(parts[parts.length - 1]);
}

// --- diff parsing ----------------------------------------------------------

const PY_DEF_TEST = /^(?:async\s+)?def\s+(test\w*)\s*\(/;
export const PY_DEF_ANY = /^(?:async\s+)?def\s+(\w+)\s*\(/;
export const PY_SKIP_DEC = /^@(pytest\.mark\.(?:skip|skipif|xfail)\b.*)$/;
export const JS_DECL =
  /\b(?:describe|context|it|test)(?:\.\w+)?\s*\(\s*(['"`])(.*?)\1/;
export const JS_SKIP =
  /\b(xit|xdescribe|fit|fdescribe|(?:it|test|describe|context)\.(?:skip|only|fixme))\s*\(\s*(['"`])(.*?)\2/g;
const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

const stripAb = (p) =>
  p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
const mapKey = (file, name) => `${file}\u0000${name}`;

/** Parse a unified diff and return the deletions/skips it introduces. */
export function findDeletions(diff) {
  const removed = new Map();
  const skipped = new Map();
  // Every (file, title) that a `+` line DECLARES. A test whose declaration line
  // merely changed leaves on the `-` side and arrives on the `+` side, so
  // without this the ledger records a deletion for a test that is still there
  // (#783): a prettier reflow of a long signature is enough, and so is lifting a
  // `.skip` in place. The ledger is append-only, so such a row cannot be
  // corrected without the hand-edit the ledger exists to prevent.
  const redeclared = new Set();

  let currentFile = null;
  let minusFile = null;
  let inTestFile = false;
  let inHunk = false;
  let oldLn = 0;
  let newLn = 0;
  let pendingPyMarker = null;

  const notePyDef = (content, file) => {
    if (pendingPyMarker === null) return;
    const m = PY_DEF_ANY.exec(content);
    if (m) {
      const name = m[1];
      skipped.set(
        mapKey(file, name),
        deletion({ name, file, kind: Kind.SKIPPED, marker: pendingPyMarker }),
      );
      pendingPyMarker = null;
    }
  };

  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git')) {
      inHunk = false;
      currentFile = null;
      minusFile = null;
      inTestFile = false;
      pendingPyMarker = null;
      continue;
    }
    if (raw.startsWith('--- ')) {
      const target = stripAb(raw.slice(4).trim());
      minusFile = target === '/dev/null' ? null : target;
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const target = stripAb(raw.slice(4).trim());
      // A wholesale file deletion shows `+++ /dev/null`; the path lives on the
      // `--- a/...` side. Fall back so deleting an entire test file is captured.
      const resolved = target === '/dev/null' ? minusFile : target;
      if (resolved === null) {
        currentFile = null;
        inTestFile = false;
      } else {
        currentFile = resolved;
        inTestFile = isTestFile(resolved);
      }
      inHunk = false;
      pendingPyMarker = null;
      continue;
    }
    const hm = HUNK_RE.exec(raw);
    if (hm) {
      oldLn = Number.parseInt(hm[1], 10);
      newLn = Number.parseInt(hm[2], 10);
      inHunk = true;
      pendingPyMarker = null;
      continue;
    }
    if (!inHunk || currentFile === null) continue;
    if (raw.startsWith('\\')) continue; // "\ No newline at end of file"

    if (raw.startsWith('+')) {
      const content = raw.slice(1).replace(/^\s+/, '');
      if (inTestFile) {
        const dec = PY_SKIP_DEC.exec(content);
        if (dec) {
          pendingPyMarker = dec[1];
        } else {
          notePyDef(content, currentFile);
          const pyAdd = PY_DEF_TEST.exec(content);
          if (pyAdd) redeclared.add(mapKey(currentFile, pyAdd[1]));
          const jsAdd = JS_DECL.exec(content);
          if (jsAdd) redeclared.add(mapKey(currentFile, jsAdd[2]));
          for (const mm of content.matchAll(JS_SKIP)) {
            const marker = mm[1];
            const title = mm[3];
            skipped.set(
              mapKey(currentFile, title),
              deletion({
                name: title,
                file: currentFile,
                kind: Kind.SKIPPED,
                line: newLn,
                marker,
              }),
            );
          }
        }
      }
      newLn += 1;
    } else if (raw.startsWith('-')) {
      const content = raw.slice(1).replace(/^\s+/, '');
      if (inTestFile) {
        const py = PY_DEF_TEST.exec(content);
        if (py) {
          const name = py[1];
          removed.set(
            mapKey(currentFile, name),
            deletion({
              name,
              file: currentFile,
              kind: Kind.REMOVED,
              line: oldLn,
            }),
          );
        } else {
          const jm = JS_DECL.exec(content);
          if (jm) {
            const title = jm[2];
            removed.set(
              mapKey(currentFile, title),
              deletion({
                name: title,
                file: currentFile,
                kind: Kind.REMOVED,
                line: oldLn,
              }),
            );
          }
        }
      }
      oldLn += 1;
    } else {
      const content = raw.startsWith(' ') ? raw.slice(1) : raw;
      if (inTestFile) notePyDef(content.replace(/^\s+/, ''), currentFile);
      oldLn += 1;
      newLn += 1;
    }
  }

  // A re-declared test was MODIFIED, not removed -- drop the phantom deletion.
  // This subsumes the skip-lifted-in-place case as well as the pure reformat,
  // and it is deliberately applied before the supersede step below so that a
  // skip ADDED in place (whose `+` line is both a declaration and a marker) is
  // still reported, as a skip.
  for (const k of redeclared) removed.delete(k);

  // A skip supersedes a removal of the same test: report it once, as a skip.
  const result = new Map();
  for (const [k, d] of removed) result.set(k, d);
  for (const [k, d] of skipped) result.set(k, d);

  return [...result.values()].sort(
    (a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name),
  );
}

// --- git plumbing (only ever run against the caller's repo path) -----------

/**
 * @typedef {{sha: string, author: string, date: string, subject: string}} Commit
 */

/** Run git in `repo` and return stdout. Throws on non-zero exit. */
export function runGit(repo, ...args) {
  const proc = spawnSync('git', args, { cwd: String(repo), encoding: 'utf8' });
  if (proc.status !== 0) {
    const err = (proc.stderr || '').trim();
    throw new Error(
      `git ${args.join(' ')} failed: ${err || proc.error?.message || 'nonzero exit'}`,
    );
  }
  return proc.stdout;
}

const BASE_CANDIDATES = [
  'origin/main',
  'origin/master',
  'main',
  'master',
  'develop',
];

/**
 * Resolve the comparison base. An explicit `ref` is returned verbatim;
 * otherwise the merge-base of HEAD with the first available mainline branch,
 * falling back to HEAD's parent.
 */
export function resolveBase(repo, ref) {
  if (ref) return ref;
  for (const candidate of BASE_CANDIDATES) {
    try {
      runGit(repo, 'rev-parse', '--verify', '--quiet', candidate);
    } catch {
      continue;
    }
    return runGit(repo, 'merge-base', 'HEAD', candidate).trim();
  }
  return runGit(repo, 'rev-parse', 'HEAD~1').trim();
}

/** Unified diff from `base` to HEAD. */
export function diffText(repo, base) {
  return runGit(repo, 'diff', base, 'HEAD');
}

/**
 * Provenance of the most recent commit in base..HEAD touching `path`.
 * @returns {Commit|null} null when no commit in the range changed the path.
 */
/**
 * The bug a quarantine is waiting on, read from the commit's `Ticket:` trailer.
 *
 * A trailer rather than a scan of the message for anything issue-shaped, because
 * a WRONG ticket link is worse than none: it points a reader confidently at the
 * wrong bug, and the patterns that would catch `PROJ-1234` also catch `UTF-8` and
 * `SHA-1`. Guessing is the one thing this skill does not do -- an absent trailer
 * is recorded as empty, which is honest and visible, rather than as a plausible
 * match that nobody re-checks.
 *
 * `Bug:` and `Tracked:` are accepted as aliases because both already appear in
 * practice. The LAST match wins, following git's own trailer convention that the
 * final block is the authoritative one -- so an amended commit corrects rather
 * than duplicates.
 *
 * The value is recorded verbatim, whatever it is: a key (`PROJ-4471`), a URL,
 * or several. Katana cannot know one org's issue tracker from another's, and
 * turning a key into a link is the consuming tool's job.
 */
export function ticketFromMessage(message) {
  if (!message) return '';
  let found = '';
  for (const line of String(message).split(/\r?\n/)) {
    const m = /^\s*(?:ticket|bug|tracked)\s*:\s*(\S.*?)\s*$/i.exec(line);
    if (m) found = m[1];
  }
  return found;
}

export function commitForFile(repo, base, filePath) {
  // `%b` (the body) follows the subject so a `Ticket:` trailer is readable. It
  // is multi-line, so everything from index 3 onward is the message and only
  // index 3 is the subject -- the four-field parse below is unchanged for the
  // fields that were already here.
  const fmt = '%H%n%an%n%aI%n%s%n%b';
  const out = runGit(
    repo,
    'log',
    '-1',
    `--format=${fmt}`,
    `${base}..HEAD`,
    '--',
    filePath,
  );
  // Emulate Python splitlines(): drop a single trailing empty line.
  const raw = out.split(/\r?\n/);
  const parts =
    raw.length && raw[raw.length - 1] === '' ? raw.slice(0, -1) : raw;
  if (parts.length < 4) return null;
  const message = parts.slice(3).join('\n');
  return {
    sha: parts[0],
    author: parts[1],
    date: parts[2],
    subject: parts[3],
    ticket: ticketFromMessage(message),
  };
}
