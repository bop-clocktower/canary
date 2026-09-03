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
 * much as the verdict. A gate like this has five ways to report a green it did
 * not earn. Stated exactly, because the previous version of this header
 * claimed two and there were more — a file whose subject is under-counted
 * false greens should not under-count its own:
 *
 *   1. the range cannot be resolved (shallow checkout)   exit 1   covered
 *   2. no range determined from the event at all         exit 1   see below
 *   3. the range resolves but holds zero commits         exit 1   covered
 *   4. the denylist is empty, so nothing can match       exit 1   covered (CI)
 *   5. a commit class is silently exempt from the scan   exit 1   covered by
 *      the merge-commit and trailer tests
 *
 * (2) has no direct test. It returns the same `unresolved` shape as (1), so
 * its *reporting* is covered; what is untested is the decision itself, which
 * needs a non-overridden scan root and would therefore scan this repository.
 * The fixture-root case is pinned instead, by the ambient-GITHUB_BASE_REF
 * test at the bottom.
 *
 * The four that exit 1 all print an abstention rather than the word "clean".
 * Only a local run with no denylist exits 0, and it says "skipped".
 *
 * NOTE FOR EDITORS: this file is itself scanned by the gate it tests, and the
 * gate publishes its findings to a PUBLIC Actions log. The fixture identity
 * must be synthetic — never a real company name, domain, or address.
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
const COMPANY_EMAIL = 'dev@zorbatron.example';
const COMPANY_IDENT = `Test Author <${COMPANY_EMAIL}>`;
/** The other realistic shape: the term in the NAME, with a clean address. */
const COMPANY_NAME_IDENT = 'Zorbatron Release Bot <bot@example.com>';
const CLEAN_IDENT = 'Test Author <dev@example.com>';

const tempRoots: string[] = [];

// NOTE: module-level and spliced wholesale in afterEach. Safe under vitest's
// default per-file sequencing; adding `it.concurrent` here would delete a
// still-running test's fixture and present as an unreproducible flake.
afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Fixture {
  root: string;
  base: string;
  range: string;
  shas: string[];
  git: (...args: string[]) => string;
}

function identParts(ident: string): { name: string; email: string } {
  return {
    name: ident.slice(0, ident.indexOf('<')).trim(),
    email: ident.slice(ident.indexOf('<') + 1, ident.indexOf('>')),
  };
}

function commitAs(
  git: Fixture['git'],
  ident: string,
  message: string,
  ...extra: string[]
) {
  const { name, email } = identParts(ident);
  git(
    '-c',
    `user.name=${name}`,
    '-c',
    `user.email=${email}`,
    'commit',
    '-qm',
    message,
    ...extra,
  );
}

/**
 * Build a throwaway repo with a base commit plus one commit per identity.
 *
 * The git environment is pinned rather than inherited: an ambient
 * GIT_AUTHOR_EMAIL / GIT_COMMITTER_EMAIL outranks `-c user.email` and would
 * silently rewrite every fixture identity, and an ambient `core.hooksPath`
 * would run the developer's own hooks inside the fixture.
 */
function fixtureHistory(idents: string[]): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'leak-authorship-'));
  tempRoots.push(root);

  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-C', root, '-c', 'core.hooksPath=/dev/null', ...args],
      {
        encoding: 'utf-8',
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
          GIT_AUTHOR_NAME: undefined,
          GIT_AUTHOR_EMAIL: undefined,
          GIT_COMMITTER_NAME: undefined,
          GIT_COMMITTER_EMAIL: undefined,
        } as NodeJS.ProcessEnv,
      },
    ).trim();

  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'base@example.com');
  git('config', 'user.name', 'base');
  writeFileSync(join(root, 'README.md'), 'base\n', 'utf-8');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');

  const shas: string[] = [];
  idents.forEach((ident, i) => {
    writeFileSync(join(root, `f${i}.txt`), `${i}\n`, 'utf-8');
    git('add', '-A');
    commitAs(git, ident, `change ${i}`);
    shas.push(git('rev-parse', 'HEAD'));
  });

  return { root, base, range: `${base}..HEAD`, shas, git };
}

interface GateRun {
  status: number;
  stdout: string;
}

interface GateOpts {
  denylist?: string;
  /** Extra env, e.g. the production GITHUB_* range-resolution inputs. */
  env?: Record<string, string>;
}

function runGate(
  root: string,
  range: string,
  { denylist = FIXTURE_TERM, env = {} }: GateOpts = {},
): GateRun {
  const res = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      CANARY_LEAK_SCAN_ROOT: root,
      CANARY_PROPRIETARY_DENYLIST: denylist,
      CANARY_AUTHOR_SCAN_RANGE: range,
      // Point the file half of the denylist at nothing. Without this the
      // no-denylist cases pass only on machines lacking the private overlay:
      // green in CI, red on the maintainer's laptop — and the natural repair
      // under time pressure is to loosen the assertion that is the dark-gate
      // disclosure's only guard. The seam is honoured only for an overridden
      // scan root, so it cannot neuter the real gate.
      CANARY_DENYLIST_FILE: join(root, '.no-such-denylist'),
      // The ambient GITHUB_* vars are deliberately NOT blanked. Blanking them
      // once hid a real defect: the suite passed locally while every fixture
      // run failed under CI, where GITHUB_BASE_REF is set.
      ...env,
    },
  });
  return { status: res.status ?? -1, stdout: `${res.stdout}${res.stderr}` };
}

/** SHAs the gate named as offenders, short form. */
function namedOffenders(stdout: string): Set<string> {
  return new Set(
    [...stdout.matchAll(/^([0-9a-f]{9}) [a-z/]+ matched the denylist/gm)].map(
      (m) => m[1] as string,
    ),
  );
}

describe('leak gate: commit authorship', () => {
  it('fails on a commit authored with a denylisted identity', () => {
    const { root, range } = fixtureHistory([COMPANY_IDENT]);

    const { status, stdout } = runGate(root, range);

    expect(stdout).toContain('Company identifiers found in commit authorship');
    expect(stdout).toContain('company identity on a public commit');
    expect(status).toBe(1);
  });

  it('fails when the term is in the name rather than the address', () => {
    const { root, range } = fixtureHistory([COMPANY_NAME_IDENT]);

    expect(runGate(root, range).status).toBe(1);
  });

  it('names exactly the offending commits, and no others', () => {
    // A count of matches would also pass if the same commit were printed
    // twice and a distinct offender dropped, so assert on identity.
    const { root, range, shas } = fixtureHistory([
      COMPANY_IDENT,
      CLEAN_IDENT,
      COMPANY_IDENT,
    ]);

    const { status, stdout } = runGate(root, range);

    expect(namedOffenders(stdout)).toEqual(
      new Set([shas[0]!.slice(0, 9), shas[2]!.slice(0, 9)]),
    );
    expect(status).toBe(1);
  });

  it('never echoes the matched identity into the log', () => {
    // The gate's findings go to a PUBLIC Actions log. Printing the address it
    // just caught would publish exactly what it exists to keep off the public
    // record, on precisely the commits that trip it.
    const { root, range } = fixtureHistory([COMPANY_IDENT]);

    const { stdout } = runGate(root, range);

    expect(stdout).not.toContain(COMPANY_EMAIL);
    expect(stdout.toLowerCase()).not.toContain('zorbatron');
    expect(stdout).toContain('inspect locally');
  });

  it('passes commits authored with a clean identity, and states the count', () => {
    const { root, range } = fixtureHistory([CLEAN_IDENT, CLEAN_IDENT]);

    const { status, stdout } = runGate(root, range);

    expect(stdout).toContain('2 commit(s) checked for authorship');
    expect(status).toBe(0);
  });

  describe('commit classes that must not be exempt', () => {
    it('sees a company identity on a merge commit', () => {
      // `git merge origin/main` from a clone with an inherited global
      // user.email — the gate's own header scenario. Scanning with
      // --no-merges would skip this commit while still reporting a
      // confident count over the rest.
      const { root, base, git } = fixtureHistory([CLEAN_IDENT]);
      git('checkout', '-q', '-b', 'side', base);
      writeFileSync(join(root, 'side.txt'), 'side\n', 'utf-8');
      git('add', '-A');
      commitAs(git, CLEAN_IDENT, 'side');
      git('checkout', '-q', 'main');
      const { name, email } = identParts(COMPANY_IDENT);
      git(
        '-c',
        `user.name=${name}`,
        '-c',
        `user.email=${email}`,
        'merge',
        '--no-ff',
        '--no-edit',
        '-q',
        'side',
      );

      const { status, stdout } = runGate(root, `${base}..HEAD`);

      expect(stdout).toContain('company identity on a public commit');
      expect(status).toBe(1);
    });

    it('sees a company identity in a Co-authored-by trailer', () => {
      // GitHub renders Co-authored-by as a linked contributor on the public
      // commit page, so it is a more visible identity surface than %ae.
      const { root, base, git } = fixtureHistory([]);
      writeFileSync(join(root, 'x.txt'), 'x\n', 'utf-8');
      git('add', '-A');
      commitAs(
        git,
        CLEAN_IDENT,
        `feat: something\n\nCo-authored-by: ${COMPANY_IDENT}`,
      );

      const { status, stdout } = runGate(root, `${base}..HEAD`);

      expect(stdout).toContain('trailer');
      expect(status).toBe(1);
    });

    it('checks the committer identity, not only the author', () => {
      const { root, base, git } = fixtureHistory([]);
      writeFileSync(join(root, 'x.txt'), 'x\n', 'utf-8');
      git('add', '-A');
      commitAs(git, CLEAN_IDENT, 'clean author, dirty committer');
      const { name, email } = identParts(COMPANY_IDENT);
      execFileSync('git', ['-C', root, 'commit', '--amend', '--no-edit'], {
        encoding: 'utf-8',
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_COMMITTER_NAME: name,
          GIT_COMMITTER_EMAIL: email,
        },
      });

      const { status, stdout } = runGate(root, `${base}..HEAD`);

      // Must be the committer field specifically — 'committer' alone would
      // also match the 'author/committer' string the common case produces.
      expect(stdout).toMatch(/^[0-9a-f]{9} committer matched/m);
      expect(stdout).not.toMatch(/^[0-9a-f]{9} author\/committer/m);
      expect(status).toBe(1);
    });
  });

  describe('denylist term shapes', () => {
    it('matches any term in a comma-separated denylist', () => {
      const { root, range } = fixtureHistory([COMPANY_IDENT]);

      const { status } = runGate(root, range, {
        denylist: ` Quuxcorp , ${FIXTURE_TERM} `,
      });

      expect(status).toBe(1);
    });

    it('does not match a term that is only a substring of the identity', () => {
      // Boundaries still hold: 'Zorb' must not fire on 'zorbatron'.
      const { root, range } = fixtureHistory([COMPANY_IDENT]);

      expect(runGate(root, range, { denylist: 'Zorb' }).status).toBe(0);
    });

    it('matches a multi-word term against a concatenated domain', () => {
      // Terms are authored for the FILE scan and read like prose. An email
      // domain drops or changes the separator, and `\b<term>\b` would miss
      // every one of these — failing open, the worst direction for a gate.
      const { root, base, git } = fixtureHistory([]);
      const emails = [
        'dev@zorbatronhealth.example',
        'dev@zorbatron-health.example',
      ];
      emails.forEach((email, i) => {
        writeFileSync(join(root, `m${i}.txt`), `${i}\n`, 'utf-8');
        git('add', '-A');
        commitAs(git, `Dev <${email}>`, `m${i}`);
      });

      const { status, stdout } = runGate(root, `${base}..HEAD`, {
        denylist: 'Zorbatron Health',
      });

      expect(namedOffenders(stdout).size).toBe(2);
      expect(status).toBe(1);
    });

    it('matches a term carrying trailing punctuation', () => {
      // `Zorbatron Inc.` compiled to `\bZorbatron Inc\.\b`, whose trailing
      // \b requires a word character after the dot — a pattern that could
      // never match anything, silently.
      const { root, base, git } = fixtureHistory([]);
      writeFileSync(join(root, 'p.txt'), 'p\n', 'utf-8');
      git('add', '-A');
      commitAs(git, 'Zorbatron Inc. <a@example.com>', 'punctuated');

      expect(
        runGate(root, `${base}..HEAD`, { denylist: 'Zorbatron Inc.' }).status,
      ).toBe(1);
    });
  });

  describe('production range resolution', () => {
    // runGate always supplies an explicit range, which is a test seam. These
    // exercise the branches CI actually uses, against a real remote ref.
    function withOrigin(f: Fixture): Fixture {
      f.git('remote', 'add', 'origin', f.root);
      f.git('update-ref', 'refs/remotes/origin/main', f.base);
      return f;
    }

    it('resolves origin/<base>..HEAD from GITHUB_BASE_REF', () => {
      const f = withOrigin(fixtureHistory([COMPANY_IDENT]));

      const { status, stdout } = runGate(f.root, '', {
        env: { GITHUB_BASE_REF: 'main', GITHUB_EVENT_BEFORE: '' },
      });

      expect(stdout).toContain('company identity on a public commit');
      expect(status).toBe(1);
    });

    it('ends the range at the PR head, not the ephemeral merge commit', () => {
      // On `pull_request`, actions/checkout checks out `refs/pull/N/merge` —
      // a commit GitHub synthesises per event, authored with the PR author's
      // ACCOUNT email, and discarded at merge. Scanning it reports a leak
      // that can never reach public history. Simulated here by putting the
      // offender on a merge commit *above* the PR head.
      const f = withOrigin(fixtureHistory([CLEAN_IDENT]));
      const head = f.git('rev-parse', 'HEAD');
      f.git('checkout', '-q', '-b', 'ephemeral');
      commitAs(f.git, COMPANY_IDENT, 'Merge into base', '--allow-empty');

      const { status, stdout } = runGate(f.root, '', {
        env: { GITHUB_BASE_REF: 'main', GITHUB_PR_HEAD_SHA: head },
      });

      expect(stdout).toContain('1 commit(s) checked for authorship');
      expect(status).toBe(0);
    });

    it('resolves <before>..HEAD from GITHUB_EVENT_BEFORE', () => {
      const f = fixtureHistory([COMPANY_IDENT]);

      const { status } = runGate(f.root, '', {
        env: { GITHUB_BASE_REF: '', GITHUB_EVENT_BEFORE: f.base },
      });

      expect(status).toBe(1);
    });

    it('prefers GITHUB_BASE_REF over GITHUB_EVENT_BEFORE', () => {
      const f = withOrigin(fixtureHistory([CLEAN_IDENT]));

      const { status, stdout } = runGate(f.root, '', {
        env: {
          GITHUB_BASE_REF: 'main',
          GITHUB_EVENT_BEFORE: '0'.repeat(40),
        },
      });

      // The all-zeroes `before` would abstain; base ref wins and measures 1.
      expect(stdout).toContain('1 commit(s) checked for authorship');
      expect(status).toBe(0);
    });
  });

  describe('the false greens', () => {
    it('abstains when the range cannot be resolved', () => {
      const { root } = fixtureHistory([COMPANY_IDENT]);

      const { status, stdout } = runGate(root, 'deadbeefdeadbeef..HEAD');

      expect(stdout).toContain('abstention, not a clean result');
      expect(stdout).not.toContain('commit(s) checked for authorship');
      expect(status).toBe(1);
    });

    it('abstains when the range resolves but holds no commits', () => {
      // "0 commit(s) checked" beside a clean verdict is the canonical shape.
      const { root, base } = fixtureHistory([]);

      const { status, stdout } = runGate(root, `${base}..${base}`);

      expect(stdout).not.toContain('0 commit(s) checked');
      expect(stdout).toContain('abstention, not a clean result');
      expect(status).toBe(1);
    });

    it('abstains on CI when the denylist is empty', () => {
      // The fork case: GitHub does not pass secrets to fork-triggered
      // workflows, so the gate matches zero patterns on every fork PR.
      const { root, range } = fixtureHistory([COMPANY_IDENT]);

      const { status, stdout } = runGate(root, range, {
        denylist: '',
        env: { GITHUB_ACTIONS: 'true' },
      });

      expect(stdout).toContain('no denylist available');
      expect(stdout).toContain('fork');
      expect(status).toBe(1);
    });

    it('says the scan was skipped, not clean, on a local run with no denylist', () => {
      // Exit 0 is right off CI — a contributor legitimately has no secret —
      // but the output must not read as though commits were checked.
      const { root, range } = fixtureHistory([COMPANY_IDENT]);

      const { status, stdout } = runGate(root, range, {
        denylist: '',
        env: { GITHUB_ACTIONS: '' },
      });

      expect(stdout).toContain('authorship scan skipped');
      expect(stdout).not.toContain('commit(s) checked for authorship');
      expect(status).toBe(0);
    });
  });

  it('ignores an ambient GITHUB_BASE_REF when scanning a fixture root', () => {
    // The regression that reached CI: with CANARY_LEAK_SCAN_ROOT pointing at
    // a fixture, the scan resolved the *ambient* `origin/main..HEAD` and ran
    // it inside the fixture, which has no `origin/main`. Every otherwise-
    // clean fixture run became an abstention, including the sibling suite's
    // clean-control case.
    const { root } = fixtureHistory([CLEAN_IDENT]);

    const { status, stdout } = runGate(root, '', {
      env: { GITHUB_BASE_REF: 'main' },
    });

    expect(stdout).toContain('scan root overridden with no explicit range');
    expect(status).toBe(0);
  });

  it('rejects a range that git would read as a flag', () => {
    const { root } = fixtureHistory([CLEAN_IDENT]);

    const { status, stdout } = runGate(root, '--output=/tmp/pwned..HEAD');

    expect(stdout).toContain('not a well-formed commit range');
    expect(status).toBe(1);
  });

  it('reports git’s own error rather than always blaming fetch-depth', () => {
    const { root } = fixtureHistory([CLEAN_IDENT]);

    const { stdout } = runGate(root, 'nosuchref..HEAD');

    expect(stdout).toMatch(/unknown revision|ambiguous argument/);
  });
});
