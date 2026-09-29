// diff -- `git diff --name-only` over the culprit range, as evidence.
//
// Culprit range = last passing observation's commit -> target failure's commit.
// Any reason the range cannot be read (no prior pass, a sha that is not an
// object id, pass and failure at one commit, a last pass that is not an
// ancestor of the target, git missing or timed out, commits unreachable) is a
// "Not checked" entry, never
// a silent gap and never an error: the diff is optional evidence (D9).
//
// Shas come from the store, so they are validated as hex before they reach git:
// a value like `--output=x` would otherwise be parsed as a git option.

import { execFileSync } from 'node:child_process';

import { isTestPath, row, samePath } from './signals.mjs';

const HEX = /^[0-9a-f]{4,64}$/i;
const SOURCE = 'git diff';

function firstLine(text) {
  return String(text ?? '')
    .trim()
    .split('\n')[0];
}

// A hung git (credential prompt, network filesystem) must not hang the brief,
// and a large range must not overflow the 1 MiB default buffer into a false
// "could not diff" (S5).
const GIT_OPTIONS = {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: 10_000,
  maxBuffer: 16 * 1024 * 1024,
};

/** `--end-of-options` (git >= 2.24) is a second guard behind the hex check. */
function git(repo, args, revs) {
  return execFileSync(
    'git',
    ['-C', repo, ...args, '--end-of-options', ...revs],
    GIT_OPTIONS,
  );
}

const gitError = (exc) => firstLine(exc.stderr) || exc.message;

/** @returns {{files: string[]|null, error: string|null}} */
export function readCulpritDiff(repo, from, to) {
  try {
    const out = git(repo, ['diff', '--name-only'], [from, to]);
    const files = out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    return { files, error: null };
  } catch (exc) {
    return { files: null, error: gitError(exc) };
  }
}

/**
 * A last pass on another branch makes `from..to` a diff across branches, not
 * the changes that arrived before the failure (I3). Exit 1 = not an ancestor;
 * any other failure is git being unable to answer.
 *
 * @returns {string|null} why the range is not a culprit range, or null
 */
function ancestryProblem(repo, from, to) {
  try {
    git(repo, ['merge-base', '--is-ancestor'], [from, to]);
    return null;
  } catch (exc) {
    if (exc.status === 1) {
      return 'last pass is not an ancestor of the target; the range spans branches';
    }
    return `git could not diff ${from}..${to}: ${gitError(exc)}`;
  }
}

/**
 * [supports, weighsAgainst, caveat] per diff signal. A one-sided range is not
 * evidence AGAINST the other side: a changed test can expose a defect the
 * product already had, and an intended product change can leave a test's
 * expectation stale (amended after review).
 */
const WEIGHTS = {
  'diff-none': [['environment'], [], ''],
  'diff-test-only': [
    ['test-defect'],
    [],
    '; a changed test may also be exposing an existing product defect',
  ],
  'diff-sut-only': [
    ['product-defect'],
    [],
    "; an intentional product change can leave the test's expectation stale",
  ],
  'diff-both': [['test-defect', 'product-defect'], [], ''],
};

function diffKind(testCount, sutCount) {
  if (testCount + sutCount === 0) return 'diff-none';
  if (sutCount === 0) return 'diff-test-only';
  if (testCount === 0) return 'diff-sut-only';
  return 'diff-both';
}

function scopeNote(files, testFile) {
  if (!testFile) {
    return 'test_file not recorded; compared test-like paths with the rest';
  }
  const changed = files.some((f) => samePath(f, testFile));
  return `test file ${testFile} ${changed ? 'changed' : 'unchanged'}`;
}

/** Classify a changed-file list into exactly one diff row. */
export function diffRows(files, testFile) {
  const onTestSide = (f) =>
    (testFile !== null && samePath(f, testFile)) || isTestPath(f);
  const testCount = files.filter(onTestSide).length;
  const sutCount = files.length - testCount;
  const kind = diffKind(testCount, sutCount);
  const [supports, against, caveat] = WEIGHTS[kind];
  const detail = `${testCount} test path(s), ${sutCount} non-test path(s) changed; ${scopeNote(files, testFile)}${caveat}`;
  return [row(kind, SOURCE, detail, supports, against)];
}

function notChecked(reason) {
  return { read: false, rows: [], notChecked: [{ source: SOURCE, reason }] };
}

function rangeProblem(target, lastPass) {
  if (!lastPass) {
    return 'no passing observation before the target, so there is no culprit range';
  }
  if (
    !HEX.test(lastPass.commit_sha ?? '') ||
    !HEX.test(target.commit_sha ?? '')
  ) {
    return 'a commit sha in the culprit range is missing or not a hex object id';
  }
  if (lastPass.commit_sha === target.commit_sha) {
    return 'pass and failure at the same commit; no culprit range';
  }
  return null;
}

/** @returns {{read: boolean, rows: Array<Record<string, any>>, notChecked: Array<Record<string, any>>}} */
export function diffEvidence({ repo, target, lastPass }) {
  const problem = rangeProblem(target, lastPass);
  if (problem) return notChecked(problem);
  const from = lastPass.commit_sha;
  const to = target.commit_sha;
  const unrelated = ancestryProblem(repo, from, to);
  if (unrelated) return notChecked(unrelated);
  const { files, error } = readCulpritDiff(repo, from, to);
  if (error) return notChecked(`git could not diff ${from}..${to}: ${error}`);
  return {
    read: true,
    rows: diffRows(files, target.test_file),
    notChecked: [],
  };
}
