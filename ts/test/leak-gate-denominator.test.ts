/**
 * Denominator tests for the proprietary/removed-symbol gate (#578).
 *
 * `scripts/check_removed_symbols.mjs` prints "clean — no removed-symbol or
 * proprietary leaks" and exits 0. Before this suite existed, nothing could
 * distinguish that from "structurally unable to read the files it was pointed
 * at": PR #577 leaked a consumer identifier into two `ts/test/*.ts` files and
 * the gate reported clean, because neither suffix set covered TypeScript — the
 * language essentially all of this repo's code is written in since the v6
 * cutover retired the Python engine.
 *
 * So these tests assert on the DENOMINATOR, not just the verdict. Each one
 * plants a known offender in a file of a given suffix and requires the gate to
 * fail on it. A clean-control case sits alongside them, because a gate that
 * fails on everything is no more useful than one that passes on everything.
 *
 * The gate scans a real git working tree (`git ls-files`), so each case builds
 * a throwaway repo and points the script at it via `CANARY_LEAK_SCAN_ROOT`.
 *
 * NOTE FOR EDITORS: this file is itself scanned by the gate it tests. Fixture
 * offenders must be synthetic — a made-up denylist term supplied through
 * `CANARY_PROPRIETARY_DENYLIST`, never a real identifier, and never a literal
 * that matches the built-in generic patterns.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'check_removed_symbols.mjs');

/** Synthetic company identifier — resembles a denylist term, belongs to nobody. */
const FIXTURE_TERM = 'Zorbatron';

const tempRoots: string[] = [];

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Build a throwaway git repo whose tracked files are exactly `files`. */
function fixtureRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'leak-gate-'));
  tempRoots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body, 'utf-8');
  }
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf-8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('add', '-A');
  return root;
}

interface GateRun {
  status: number;
  stdout: string;
}

/** Run the gate against `root`, with `FIXTURE_TERM` on the runtime denylist. */
function runGate(root: string): GateRun {
  const res = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      CANARY_LEAK_SCAN_ROOT: root,
      CANARY_PROPRIETARY_DENYLIST: FIXTURE_TERM,
    },
  });
  return { status: res.status ?? -1, stdout: `${res.stdout}${res.stderr}` };
}

describe('proprietary leak gate: which suffixes it can actually read', () => {
  // The TS/JS family is the gap #578 reports. `.ts` is listed first because
  // that is the exact suffix PR #577's leak lived in and the gate passed over.
  const codeSuffixes = ['.ts', '.tsx', '.js', '.mjs', '.cjs'];

  it.each(codeSuffixes)('fails on a denylisted term in a %s file', (suffix) => {
    const rel = `src/widget${suffix}`;
    const root = fixtureRepo({
      [rel]: `// integration for ${FIXTURE_TERM}\nexport const x = 1;\n`,
    });

    const { status, stdout } = runGate(root);

    expect(stdout).toContain(rel);
    expect(status).toBe(1);
  });

  it('still fails on the suffixes it already covered', () => {
    const root = fixtureRepo({
      'docs/notes.md': `Deployed for ${FIXTURE_TERM}.\n`,
    });

    const { status, stdout } = runGate(root);

    expect(stdout).toContain('docs/notes.md');
    expect(status).toBe(1);
  });

  it('passes a tree whose code files carry no leak', () => {
    const root = fixtureRepo({
      'src/widget.ts': 'export const x = 1;\n',
      'src/helper.mjs': 'export const y = 2;\n',
      'docs/notes.md': 'Nothing to see here.\n',
    });

    const { status, stdout } = runGate(root);

    expect(stdout).toContain('clean');
    expect(status).toBe(0);
  });
});

describe('removed-symbol gate: which suffixes it can actually read', () => {
  // The real hit this fix surfaced: a canary-shadow example told users to run
  // `python3 -m agent.cli`, an engine deleted in the v6 cutover. It sat in a
  // .json file under an INCLUDE_PATH the gate was already walking.
  it('fails on a retired engine reference in a .json example', () => {
    const root = fixtureRepo({
      'docs/guides/cases.example.json':
        '{\n  "baseline": ["python3", "-m", "agent.cli"]\n}\n',
    });

    const { status, stdout } = runGate(root);

    expect(stdout).toContain('docs/guides/cases.example.json');
    expect(status).toBe(1);
  });

  it('fails on a retired engine reference in a .ts example', () => {
    const root = fixtureRepo({
      'examples/run.ts': "export const cmd = 'agent/core/executor';\n",
    });

    const { status, stdout } = runGate(root);

    expect(stdout).toContain('examples/run.ts');
    expect(status).toBe(1);
  });
});

describe('scan-root override', () => {
  // The override exists so this suite can point the gate at a fixture. That
  // same knob could silently neuter the gate in CI — an empty directory scans
  // clean and exits 0 — so an overridden run must say so loudly enough that
  // nobody reads its green as a statement about the repository.
  it('announces that an overridden run does not gate the repo', () => {
    const root = fixtureRepo({ 'src/widget.ts': 'export const x = 1;\n' });

    const { stdout } = runGate(root);

    expect(stdout).toContain(root);
    expect(stdout.toLowerCase()).toContain('does not gate the repository');
  });

  it('scans the repo itself when no override is set', () => {
    const res = spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf-8',
      env: { ...process.env, CANARY_LEAK_SCAN_ROOT: '' },
    });
    const stdout = `${res.stdout}${res.stderr}`;

    expect(stdout.toLowerCase()).not.toContain('does not gate the repository');
  });
});

describe('where the denylist comes from', () => {
  /**
   * The file is gitignored by design, so `git worktree add` never copies it.
   * Every worktree therefore ran the proprietary half with an empty denylist
   * and still printed the clean line — a gate that fails open, silently, in
   * the trees where essentially all work on this repo happens.
   */
  function fixtureRepoWithCommit(files: Record<string, string>): string {
    const root = fixtureRepo(files);
    execFileSync('git', ['-C', root, 'commit', '-qm', 'fixture'], {
      encoding: 'utf-8',
    });
    // Written AFTER the commit, and never tracked -- the whole reason a
    // worktree lacks one. A committed fixture denylist would be copied into
    // the worktree by git itself and the fallback would never be exercised.
    writeFileSync(
      join(root, '.proprietary-denylist'),
      `${FIXTURE_TERM}\n`,
      'utf-8',
    );
    return root;
  }

  /** Counter, not a clock: canary-blackhawk flags wall-clock reads (BH001). */
  let worktreeSeq = 0;

  /** A worktree of `root`, carrying its own copy of the gate to run. */
  function worktreeOf(root: string): string {
    const wt = join(root, '..', `wt-${(worktreeSeq += 1)}`);
    execFileSync('git', ['-C', root, 'worktree', 'add', '-q', wt, 'HEAD'], {
      encoding: 'utf-8',
    });
    tempRoots.push(wt);
    cpSync(join(REPO_ROOT, 'scripts'), join(wt, 'scripts'), {
      recursive: true,
    });
    return wt;
  }

  /** Run a worktree's own copy of the gate, with no env denylist at all. */
  function runInTree(tree: string): GateRun {
    const env = { ...process.env };
    delete env.CANARY_PROPRIETARY_DENYLIST;
    delete env.CANARY_DENYLIST_FILE;
    const res = spawnSync(
      process.execPath,
      [join(tree, 'scripts', 'check_removed_symbols.mjs')],
      { encoding: 'utf-8', env: { ...env, CANARY_LEAK_SCAN_ROOT: '' } },
    );
    return { status: res.status ?? -1, stdout: `${res.stdout}${res.stderr}` };
  }

  it('falls back to the main checkout when the worktree has no denylist', () => {
    const root = fixtureRepoWithCommit({
      'docs/note.md': `Nothing to see here.\n`,
    });
    const wt = worktreeOf(root);

    const { stdout } = runInTree(wt);

    expect(stdout).toContain('resolved from the main checkout');
    expect(stdout).toContain(join(root, '.proprietary-denylist'));
  });

  it('and the denylist it fell back to actually bites', () => {
    // Resolution without enforcement would be the same false green wearing a
    // more reassuring message, so the fallback is asserted by a planted
    // offender, not by the disclosure line alone.
    const root = fixtureRepoWithCommit({
      'docs/note.md': `Built for ${FIXTURE_TERM} internally.\n`,
    });
    const wt = worktreeOf(root);

    const { status, stdout } = runInTree(wt);

    expect(stdout).toContain('docs/note.md');
    expect(status).toBe(1);
  });

  it('prefers the tree it is run in over the main checkout', () => {
    const root = fixtureRepoWithCommit({
      'docs/note.md': 'Nothing to see here.\n',
    });
    const wt = worktreeOf(root);
    writeFileSync(
      join(wt, '.proprietary-denylist'),
      'Somethingelse\n',
      'utf-8',
    );

    const { stdout } = runInTree(wt);

    expect(stdout).not.toContain('resolved from the main checkout');
  });

  /** Run with no denylist reachable at all, on or off CI. */
  function runWithNoDenylist(onCi: boolean): GateRun {
    const root = fixtureRepo({ 'src/widget.ts': 'export const x = 1;\n' });
    const res = spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        CANARY_LEAK_SCAN_ROOT: root,
        CANARY_PROPRIETARY_DENYLIST: '',
        CANARY_DENYLIST_FILE: join(root, '.no-such-denylist'),
        // Pinned, never inherited. Left ambient, this pair passes at the desk
        // and fails in CI — the same environment-dependent shape the
        // authorship suite documents, just pointing the other way.
        GITHUB_ACTIONS: onCi ? 'true' : '',
      },
    });
    return { status: res.status ?? -1, stdout: `${res.stdout}${res.stderr}` };
  }

  it('says DEGRADED, never clean, at the desk with no denylist', () => {
    // The whole point: structural patterns still run and still find nothing,
    // so the exit code cannot tell this apart from a real clean scan. Only
    // the wording can. Exit 0 is right here — a contributor legitimately has
    // no secret, and must still be able to commit.
    const { status, stdout } = runWithNoDenylist(false);

    expect(stdout).toContain('DEGRADED');
    expect(stdout).not.toContain('clean — no removed-symbol');
    expect(status).toBe(0);
  });

  it('abstains outright on CI with no denylist, rather than degrading', () => {
    // On CI the denylist arrives as a secret, so its absence means the secret
    // did not reach the job. The authorship half already treats that as an
    // abstention and exits 1; this pins that the softer desk-side disclosure
    // never downgrades it on the path that gates merges.
    const { status, stdout } = runWithNoDenylist(true);

    expect(stdout).not.toContain('clean — no removed-symbol');
    expect(status).toBe(1);
  });

  it('does not cry DEGRADED when a denylist is present', () => {
    const root = fixtureRepo({ 'src/widget.ts': 'export const x = 1;\n' });

    const { stdout } = runGate(root);

    expect(stdout).not.toContain('DEGRADED');
    expect(stdout).toContain('clean — no removed-symbol');
  });
});
