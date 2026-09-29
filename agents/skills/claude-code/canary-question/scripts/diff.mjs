// diff -- `git diff --name-only` over the culprit range, as evidence.
//
// Culprit range = last passing observation's commit -> target failure's commit.
// Any reason the range cannot be read (no prior pass, a sha that is not an
// object id, git missing, commits unreachable) is a "Not checked" entry, never
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

/** @returns {{files: string[]|null, error: string|null}} */
export function readCulpritDiff(repo, from, to) {
  try {
    const out = execFileSync(
      'git',
      ['-C', repo, 'diff', '--name-only', from, to],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const files = out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    return { files, error: null };
  } catch (exc) {
    return { files: null, error: firstLine(exc.stderr) || exc.message };
  }
}

/** [supports, weighsAgainst] per diff signal. */
const WEIGHTS = {
  'diff-none': [['environment'], []],
  'diff-test-only': [['test-defect'], ['product-defect']],
  'diff-sut-only': [['product-defect'], ['test-defect']],
  'diff-both': [['test-defect', 'product-defect'], []],
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
  const detail = `${testCount} test path(s), ${sutCount} non-test path(s) changed; ${scopeNote(files, testFile)}`;
  const [supports, against] = WEIGHTS[kind];
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
  return null;
}

/** @returns {{read: boolean, rows: Array<Record<string, any>>, notChecked: Array<Record<string, any>>}} */
export function diffEvidence({ repo, target, lastPass }) {
  const problem = rangeProblem(target, lastPass);
  if (problem) return notChecked(problem);
  const from = lastPass.commit_sha;
  const to = target.commit_sha;
  const { files, error } = readCulpritDiff(repo, from, to);
  if (error) return notChecked(`git could not diff ${from}..${to}: ${error}`);
  return {
    read: true,
    rows: diffRows(files, target.test_file),
    notChecked: [],
  };
}
