// canary-strix -- the scanner. Deterministic: no LLM, no network, no execution.
//
// Two surfaces, because a company identifier reaches a public repo two ways and
// only one of them is in a file:
//
//   FILES       tracked file contents (the obvious half)
//   AUTHORSHIP  the author, committer and `Co-authored-by:` trailers of the
//               commits a change adds -- metadata, so a tree can scan perfectly
//               clean while every commit in it is stamped with a company email
//
// Ported from canary's own repo-internal gate, which had no way to reach a
// consumer: `scripts/` is not in the published package's `files`, so the only
// callers were canary's CI and its pre-commit hook.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/** Findings carry a stable id so a consumer can filter or waive by rule. */
export const RULES = {
  FILE: 'STRIX-001',
  AUTHOR: 'STRIX-002',
};

/** Identities that appear in a `Name <email>` trailer. */
const TRAILER =
  /^(?:co-authored|signed-off|reviewed|acked|tested|reported|suggested|helped|mentored)-by:\s*(.+)$/gim;

/** A range `git log` will read as a range rather than as a flag. */
const RANGE_SHAPE = /^[\w./^~-]+\.{2,3}[\w./^~-]+$/;

/** Suffixes worth reading. Prose and config leak names as readily as code. */
export const SCANNED_SUFFIXES = new Set([
  '.md',
  '.txt',
  '.py',
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.yml',
  '.yaml',
  '.html',
  '.svg',
]);

function reEscape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile a term into a matcher.
 *
 * Terms are authored as prose ("Acme Health", "Acme Inc."), and an identity or
 * a domain has a different grammar. A naive `\b<term>\b` silently never matches
 * three common shapes, and it fails OPEN, which is the worst direction:
 *
 *   term          subject                     \b-anchored
 *   Acme Health   dev@acmehealth.example      MISS  (separator dropped)
 *   Acme Health   dev@acme-health.example     MISS  (separator changed)
 *   Acme Inc.     Acme Inc. <a@b>             MISS  (\b after `.` wants \w)
 *   Café         Café <a@b>                 MISS  (\b is ASCII-only)
 *
 * So: split into alphanumeric tokens, allow any run of separators between them,
 * and bound with unicode-aware lookarounds. Boundaries still hold, so `Acme`
 * does not match `acmecorp`.
 */
export function compileTerms(terms) {
  return terms
    .map((t) => String(t).trim())
    .filter(Boolean)
    .map((term) => ({
      term,
      tokens: term.split(/[^\p{L}\p{N}]+/u).filter(Boolean),
    }))
    .filter(({ tokens }) => tokens.length)
    .map(({ term, tokens }) => {
      const body = tokens.map(reEscape).join('[^\\p{L}\\p{N}]*');
      return {
        term,
        re: new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'iu'),
      };
    });
}

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Tracked files, so an untracked scratch file is never a finding. */
export function trackedFiles(root) {
  try {
    return git(['ls-files'], root).split('\n').filter(Boolean);
  } catch {
    return null;
  }
}

function suffixOf(rel) {
  const dot = rel.lastIndexOf('.');
  return dot === -1 ? '' : rel.slice(dot);
}

/**
 * Scan tracked file CONTENTS.
 *
 * Returns the denominator alongside the findings. A caller that reports
 * findings without the count cannot tell "clean" from "read nothing".
 */
export function scanFiles(root, matchers, { exclude = [] } = {}) {
  const files = trackedFiles(root);
  if (files === null)
    return { unavailable: 'not a git repository', findings: [] };

  const findings = [];
  let scanned = 0;
  for (const rel of files.sort()) {
    if (!SCANNED_SUFFIXES.has(suffixOf(rel))) continue;
    if (exclude.some((rx) => rx.test(rel))) continue;
    const abs = resolve(root, rel);
    if (!existsSync(abs) || !statSync(abs).isFile()) continue;
    scanned += 1;
    const lines = readFileSync(abs, 'utf-8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const { term, re } of matchers) {
        if (re.test(lines[i])) {
          findings.push({
            rule: RULES.FILE,
            file: rel,
            line: i + 1,
            term,
            // Deliberately NOT the matched line. On a public repo the CI log is
            // world-readable, so echoing it publishes the identifier this scan
            // exists to keep off the record -- on exactly the lines that trip.
            detail: 'company identifier in a tracked file',
          });
          break;
        }
      }
    }
  }
  return { scanned, findings };
}

/**
 * pull_request. The range ends at the PR HEAD, not `HEAD`: actions/checkout
 * has `refs/pull/N/merge` checked out, an ephemeral commit GitHub synthesises
 * per event and authors with the PR author's ACCOUNT email. It is discarded at
 * merge, so scanning it reports a leak that cannot reach the branch.
 */
function prRange(env) {
  const base = (env.GITHUB_BASE_REF ?? '').trim();
  if (!base) return null;
  const head = (env.GITHUB_PR_HEAD_SHA ?? '').trim();
  return `origin/${base}..${head || 'HEAD'}`;
}

/** push. `before` is all-zeroes on a branch's first push: no usable range. */
function pushRange(env) {
  const before = (env.GITHUB_EVENT_BEFORE ?? '').trim();
  return before && !/^0+$/.test(before) ? `${before}..HEAD` : null;
}

function rangeFromEvent(env) {
  return prRange(env) ?? pushRange(env);
}

export function resolveRange(env, explicit) {
  const given = String(explicit ?? '').trim();
  return given || rangeFromEvent(env);
}

/**
 * Scan the AUTHORSHIP of the commits a range adds.
 *
 * Not `--no-merges`: "Merge branch 'main' into <feature>" made in a clone that
 * inherited a global `user.email` is one of the likeliest ways an identity
 * reaches a shared branch, and skipping merges would leave exactly that commit
 * unread while still reporting a confident count.
 */
/** Read the commits in `range`, or say why not. */
function readCommits(root, range) {
  if (!RANGE_SHAPE.test(range) || range.startsWith('-')) {
    return { unavailable: `${range} (not a well-formed commit range)` };
  }
  let records;
  try {
    records = git(
      ['log', '--format=%H%x00%an <%ae>%x00%cn <%ce>%x00%B%x1e', range],
      root,
    )
      .split('\x1e')
      .map((r) => r.replace(/^\n/, ''))
      .filter((r) => r.trim());
  } catch (err) {
    const detail = String(err?.stderr ?? '')
      .trim()
      .split('\n')[0];
    return { unavailable: detail || `cannot read ${range}` };
  }
  // Zero commits is not a clean scan, it is no scan.
  if (!records.length) {
    return { unavailable: `${range} (resolved, but held no commits)` };
  }
  return { records };
}

/** The identities one commit puts on the record, and which ones matched. */
function commitFinding(record, matchers) {
  const [sha, author, committer, body = ''] = record.split('\0');
  const roles = [
    ['author', author],
    ['committer', committer],
    ...[...body.matchAll(TRAILER)].map((m) => ['trailer', m[1].trim()]),
  ];
  const hit = roles.filter(([, id]) => matchers.some(({ re }) => re.test(id)));
  if (!hit.length) return null;
  // One row per commit, not per field: `user.email` sets author and committer
  // together, so the common case matches twice.
  const short = sha.slice(0, 9);
  return {
    rule: RULES.AUTHOR,
    commit: short,
    fields: hit.map(([who]) => who),
    // Not the identity itself -- see scanFiles.
    detail: `company identity on a commit (inspect: git log -1 --format='%an <%ae> %cn <%ce>' ${short})`,
  };
}

/**
 * Scan the AUTHORSHIP of the commits a range adds.
 *
 * Not `--no-merges`: "Merge branch 'main' into <feature>" made in a clone that
 * inherited a global `user.email` is one of the likeliest ways an identity
 * reaches a shared branch, and skipping merges would leave exactly that commit
 * unread while still reporting a confident count.
 */
export function scanAuthorship(root, matchers, range) {
  if (!range) return { skipped: 'no commit range' };
  const { records, unavailable } = readCommits(root, range);
  if (unavailable) return { unavailable, findings: [] };
  const findings = records
    .map((r) => commitFinding(r, matchers))
    .filter(Boolean);
  return { scanned: records.length, findings };
}
