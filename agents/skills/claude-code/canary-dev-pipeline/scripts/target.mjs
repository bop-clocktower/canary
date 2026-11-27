// target -- what the dev pipeline looks at (#666, spec Q3 / D1 / D5).
//
// With no paths: the working diff. That is tracked changes (committed on the
// branch, staged, or unstaged) against the merge base of HEAD with the default
// branch, plus untracked files that are not ignored. Explicit paths replace the
// diff. An empty result is an abstention, never an all-clear (ADR 0009).
//
// Git is run through execFileSync with an argv array, never a shell string.
// GIT_DIR and its relatives are dropped from the child environment so --repo
// decides the repository even inside a git hook, and file lists are read with
// -z so a newline in a file name cannot split one entry into two.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { isTestFile } from '../../canary-katana/scripts/diffscan.mjs';

/** At most this many files are analysed; the rest are counted as clamped. */
export const MAX_TARGETS = 200;

const SOURCE_EXT = new Set(
  ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'].concat([
    '.py',
    '.php',
  ]),
);

// Never worth walking for an explicit directory target.
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  'vendor',
]);

const DEFAULT_CANDIDATES = ['origin/main', 'main', 'origin/master', 'master'];

const SCRUBBED_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'];

const GIT_OPTIONS = {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: 10_000,
  maxBuffer: 16 * 1024 * 1024,
};

const HEX_SHA = /^[0-9a-f]{40,64}$/;

/** `test`, `source` or `other` for a repo-relative path. */
export function classify(rel) {
  if (isTestFile(rel)) return 'test';
  if (rel.endsWith('.d.ts')) return 'other';
  return SOURCE_EXT.has(path.extname(rel)) ? 'source' : 'other';
}

function gitEnv() {
  const env = { ...process.env };
  for (const key of SCRUBBED_ENV) delete env[key];
  return env;
}

/** Run git in `cwd`; stdout, or null when git fails or is absent. */
function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      ...GIT_OPTIONS,
      env: gitEnv(),
    });
  } catch {
    return null;
  }
}

const nulList = (out) => (out ?? '').split('\0').filter(Boolean);

/** The ref to diff against: origin/HEAD's target, else a conventional name. */
function defaultRef(root) {
  const head = git(root, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'refs/remotes/origin/HEAD',
  ]);
  const candidates = [head?.trim(), ...DEFAULT_CANDIDATES].filter(Boolean);
  return candidates.find(
    (ref) =>
      git(root, [
        'rev-parse',
        '--verify',
        '--quiet',
        '--end-of-options',
        `${ref}^{commit}`,
      ]) !== null,
  );
}

/** {base, baseRef, notes}: the commit the working diff is measured from. */
function diffBase(root) {
  if (git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']) === null)
    return { base: null, baseRef: null, notes: ['no commit yet'] };
  const ref = defaultRef(root);
  if (!ref) {
    return {
      base: 'HEAD',
      baseRef: 'HEAD',
      notes: ['no default branch found; target is uncommitted changes only'],
    };
  }
  const base = (git(root, ['merge-base', 'HEAD', ref]) ?? '').trim();
  return HEX_SHA.test(base)
    ? { base, baseRef: ref, notes: [] }
    : { base: 'HEAD', baseRef: ref, notes: [`no merge base with ${ref}`] };
}

/** Repo-relative paths the working diff touches (existing or deleted). */
function diffPaths(root, base) {
  const untracked = ['ls-files', '--others', '--exclude-standard', '-z'];
  if (base === null) {
    return nulList(git(root, [...untracked, '--cached']));
  }
  const tracked = git(root, [
    'diff',
    '--name-only',
    '--no-renames',
    '-z',
    '--end-of-options',
    base,
    '--',
  ]);
  return [...nulList(tracked), ...nulList(git(root, untracked))];
}

function finish(root, all, extra) {
  const unique = [...new Set(all)].sort();
  const existing = unique.filter((rel) => fs.existsSync(path.join(root, rel)));
  const kept = existing.slice(0, MAX_TARGETS);
  return {
    root,
    files: kept.map((rel) => ({ path: rel, kind: classify(rel) })),
    deleted: unique.length - existing.length,
    clamped: existing.length - kept.length,
    abstain: null,
    ...extra,
  };
}

function fromDiff(repo) {
  const root = git(repo, ['rev-parse', '--show-toplevel'])?.trim();
  if (!root) {
    return {
      ...finish(path.resolve(repo), [], { mode: 'diff' }),
      base: null,
      baseRef: null,
      notes: [],
      abstain: `not a git repository: ${repo}`,
    };
  }
  const { base, baseRef, notes } = diffBase(root);
  const target = finish(root, diffPaths(root, base), {
    mode: 'diff',
    base,
    baseRef,
    notes,
  });
  if (target.files.length === 0 && target.deleted === 0) {
    target.abstain = `the working diff is empty (no change against ${baseRef ?? 'an empty repository'})`;
  }
  return target;
}

const relPosix = (root, abs) =>
  path.relative(root, abs).split(path.sep).join('/');

/** Every regular file under `abs`, as root-relative posix paths. */
function walk(root, abs, out) {
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const child = path.join(abs, entry.name);
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
      walk(root, child, out);
    } else if (entry.isFile()) {
      out.push(relPosix(root, child));
    }
  }
}

function insideRoot(root, abs) {
  const rel = path.relative(root, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function collectPath(root, cwd, given, acc) {
  const abs = path.resolve(cwd, given);
  if (!fs.existsSync(abs)) acc.notes.push(`path not found: ${given}`);
  else if (!insideRoot(root, fs.realpathSync(abs)))
    acc.notes.push(`outside the repository: ${given}`);
  else if (fs.statSync(abs).isDirectory())
    walk(root, fs.realpathSync(abs), acc.files);
  else acc.files.push(relPosix(root, fs.realpathSync(abs)));
}

function fromPaths(repo, given, cwd) {
  const top = git(repo, ['rev-parse', '--show-toplevel'])?.trim();
  const root = fs.realpathSync(top || path.resolve(repo));
  const acc = { files: [], notes: [] };
  for (const p of given) collectPath(root, cwd, p, acc);
  const target = finish(root, acc.files, {
    mode: 'paths',
    base: null,
    baseRef: null,
    notes: acc.notes,
  });
  if (target.files.length === 0) {
    target.abstain = 'the given paths select no file';
  }
  return target;
}

/**
 * Resolve the pipeline's target.
 *
 * @param {{repo: string, paths: string[], cwd?: string}} opts
 */
export function resolveTarget({ repo, paths: given, cwd = process.cwd() }) {
  return given.length ? fromPaths(repo, given, cwd) : fromDiff(repo);
}
