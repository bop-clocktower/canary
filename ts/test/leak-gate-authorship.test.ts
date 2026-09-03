/**
 * Authorship tests for the proprietary leak gate.
 *
 * The file scan cannot see this leak surface. A company email never appears
 * *in* a tracked file — it lives in the metadata of the commit carrying it —
 * so a tree can scan perfectly clean while every commit in it is stamped with
 * a company identity. 190 commits reached this repo's public history that way
 * before the gate learned to look, each one from a clone that inherited a
 * global `user.email` instead of the repo's pin.
 *
 * As in `leak-gate-denominator.test.ts`, these assert on the DENOMINATOR as
 * much as the verdict: the two ways this check can report a green it did not
 * earn are an unresolvable commit range (a shallow checkout — nothing was
 * read) and an unset denylist (no patterns — nothing was matched). Both must
 * be distinguishable from a real pass, and the first must not exit 0 at all.
 *
 * NOTE FOR EDITORS: this file is itself scanned by the gate it tests. The
 * fixture identity must be synthetic — never a real company address.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'check_removed_symbols.mjs');

/** Synthetic company identifier — resembles a denylist term, belongs to nobody. */
const FIXTURE_TERM = 'Zorbatron';
const COMPANY_IDENT = ['Test Author', '<dev@zorbatron.example>'].join(' ');
const CLEAN_IDENT = ['Test Author', '<dev@example.com>'].join(' ');

const tempRoots: string[] = [];

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Build a throwaway repo with a base commit plus one commit per identity in
 * `idents`, and return the root and the range covering only those commits.
 */
function fixtureHistory(idents: string[]): { root: string; range: string } {
  const root = mkdtempSync(join(tmpdir(), 'leak-authorship-'));
  tempRoots.push(root);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf-8' }).trim();

  git('init', '-q');
  git('config', 'user.email', 'base@example.com');
  git('config', 'user.name', 'base');
  writeFileSync(join(root, 'README.md'), 'base\n', 'utf-8');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');

  idents.forEach((ident, i) => {
    const email = ident.slice(ident.indexOf('<') + 1, ident.indexOf('>'));
    const name = ident.slice(0, ident.indexOf('<')).trim();
    writeFileSync(join(root, `f${i}.txt`), `${i}\n`, 'utf-8');
    git('add', '-A');
    git(
      '-c',
      `user.name=${name}`,
      '-c',
      `user.email=${email}`,
      'commit',
      '-qm',
      `change ${i}`,
    );
  });

  return { root, range: `${base}..HEAD` };
}

interface GateRun {
  status: number;
  stdout: string;
}

function runGate(
  root: string,
  range: string,
  { denylist = FIXTURE_TERM }: { denylist?: string } = {},
): GateRun {
  const res = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      CANARY_LEAK_SCAN_ROOT: root,
      CANARY_PROPRIETARY_DENYLIST: denylist,
      CANARY_AUTHOR_SCAN_RANGE: range,
      // The ambient GITHUB_* vars are deliberately NOT cleared. An explicit
      // range outranks them anyway, and blanking them once hid a real defect:
      // the suite passed locally while every fixture run failed under CI,
      // where GITHUB_BASE_REF is set. See the ambient-env test below.
    },
  });
  return { status: res.status ?? -1, stdout: `${res.stdout}${res.stderr}` };
}

describe('leak gate: commit authorship', () => {
  it('fails on a commit authored with a denylisted identity', () => {
    const { root, range } = fixtureHistory([COMPANY_IDENT]);

    const { status, stdout } = runGate(root, range);

    expect(stdout).toContain('Company identifiers found in commit authorship');
    expect(stdout).toContain('company identity on a public commit');
    expect(status).toBe(1);
  });

  it('names every offending commit, not just the first', () => {
    const { root, range } = fixtureHistory([
      COMPANY_IDENT,
      CLEAN_IDENT,
      COMPANY_IDENT,
    ]);

    const { status, stdout } = runGate(root, range);

    const offenders = stdout.match(/company identity on a public commit/g);
    expect(offenders).toHaveLength(2);
    expect(status).toBe(1);
  });

  it('passes commits authored with a clean identity, and states the count', () => {
    const { root, range } = fixtureHistory([CLEAN_IDENT, CLEAN_IDENT]);

    const { status, stdout } = runGate(root, range);

    expect(stdout).toContain('2 commit(s) checked for authorship');
    expect(status).toBe(0);
  });

  // The two false-green shapes. Both would otherwise print the same
  // "clean" line as a real pass.

  it('treats an unresolvable range as an abstention and still fails', () => {
    // The shallow-checkout shape: the base commit is simply not present.
    const { root } = fixtureHistory([COMPANY_IDENT]);

    const { status, stdout } = runGate(root, 'deadbeefdeadbeef..HEAD');

    expect(stdout).toContain('abstention, not a clean result');
    expect(stdout).toContain('fetch-depth: 0');
    expect(stdout).not.toContain('commit(s) checked for authorship');
    expect(status).toBe(1);
  });

  it('says the scan was skipped when no denylist is configured', () => {
    // Exit 0 is correct here — there is genuinely nothing to match — but the
    // output must not read as though commits were checked and found clean.
    const { root, range } = fixtureHistory([COMPANY_IDENT]);

    const { status, stdout } = runGate(root, range, { denylist: '' });

    expect(stdout).toContain(
      'authorship scan skipped (no denylist configured)',
    );
    expect(stdout).not.toContain('commit(s) checked for authorship');
    expect(status).toBe(0);
  });

  it('ignores an ambient GITHUB_BASE_REF when scanning a fixture root', () => {
    // The regression that reached CI: with CANARY_LEAK_SCAN_ROOT pointing at a
    // fixture, the scan still resolved the *ambient* `origin/main..HEAD` and
    // ran it inside the fixture, which has no `origin/main`. It threw, became
    // an abstention, and failed every otherwise-clean fixture run — including
    // the sibling suite's clean-control case. A fixture is not this repo, so
    // the ambient environment describes the wrong tree.
    const { root } = fixtureHistory([CLEAN_IDENT]);

    const res = spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        CANARY_LEAK_SCAN_ROOT: root,
        CANARY_PROPRIETARY_DENYLIST: FIXTURE_TERM,
        // No explicit range — exactly how the sibling suite invokes the gate.
        CANARY_AUTHOR_SCAN_RANGE: '',
        GITHUB_BASE_REF: 'main',
      },
    });

    expect(res.stdout).toContain('no commit range resolved');
    expect(res.stdout).not.toContain('abstention');
    expect(res.status).toBe(0);
  });

  it('checks the committer identity, not only the author', () => {
    const { root, range } = fixtureHistory([]);
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', root, ...args], { encoding: 'utf-8' }).trim();
    writeFileSync(join(root, 'x.txt'), 'x\n', 'utf-8');
    git('add', '-A');
    git(
      '-c',
      'user.name=Test Author',
      '-c',
      'user.email=dev@example.com',
      'commit',
      '-qm',
      'committed by the company identity',
      '--author',
      CLEAN_IDENT,
    );
    // Re-stamp only the committer, leaving the author clean.
    execFileSync('git', ['-C', root, 'commit', '--amend', '--no-edit'], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        GIT_COMMITTER_NAME: 'Test Author',
        GIT_COMMITTER_EMAIL: 'dev@zorbatron.example',
      },
    });

    const { status, stdout } = runGate(root, `${range.split('..')[0]}..HEAD`);

    expect(stdout).toContain('committer:');
    expect(status).toBe(1);
  });
});
