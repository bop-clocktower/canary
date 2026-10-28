/**
 * `defaultDeps()` -- the production wiring behind `createGuardianCommand`.
 *
 * Every other guardian suite injects fakes, so the process-backed defaults
 * (real `git`/`gh` spawns, the stdout/stderr sinks, the GitHub client
 * builders, `sleep`) had no test at all. These cases characterize what that
 * wiring DOES, through the one exported surface, rather than its shape:
 *
 * - `runGit` really spawns git, forces a parseable diff even against a
 *   hostile user config, and answers `null` (not a throw) when git is absent.
 * - `runGh` reports a missing binary as `failed`, never as an exit status.
 * - each client builder authenticates with the token it was handed (the
 *   comment client reads `GITHUB_TOKEN` from `process.env`, not `deps.env`).
 *
 * Fixtures live under `os.tmpdir()`; `afterEach` removes them and restores
 * every env/global mutation, so a failure cannot leak PATH or `fetch`.
 * Deliberately uncovered: `readStdin` reads fd 0 -- the vitest runner's own
 * stdin (a TTY locally, it would block) -- so it would test the harness.
 */

import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultDeps } from '../src/guardian/cli.js';

const IS_WINDOWS = process.platform === 'win32';

const tmpDirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function mkTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** Set an env key for this test only; `afterEach` writes the prior value back. */
function setEnv(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  for (const k of Object.keys(savedEnv)) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
    delete savedEnv[k];
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Identity + signing overrides so a commit works under any global config. */
const GIT_ID = [
  '-c',
  'user.name=canary-test',
  '-c',
  'user.email=canary-test@example.invalid',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.hooksPath=/dev/null',
];

/**
 * A one-commit repo whose LOCAL config asks for exactly the diff shapes the
 * guardian cannot parse: no `a/`/`b/` prefixes and forced ANSI colour.
 */
function hostileRepo(): string {
  // Inside a git hook (pre-commit, pre-push, rebase exec) these are exported
  // and point at the canary checkout; left set, `git config` below would write
  // the hostile settings into the real repo instead of the temp one.
  for (const k of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_CONFIG_PARAMETERS',
  ]) {
    setEnv(k, undefined);
  }
  const dir = mkTmp('guardian-default-deps-git-');
  const git = defaultDeps().runGit;
  expect(git(['init', '-q'], dir)?.code).toBe(0);
  expect(git(['config', 'diff.noprefix', 'true'], dir)?.code).toBe(0);
  expect(git(['config', 'color.ui', 'always'], dir)?.code).toBe(0);
  writeFileSync(join(dir, 'f.txt'), 'one\n');
  expect(git(['add', 'f.txt'], dir)?.code).toBe(0);
  expect(git([...GIT_ID, 'commit', '-q', '-m', 'init'], dir)?.code).toBe(0);
  writeFileSync(join(dir, 'f.txt'), 'two\n');
  return dir;
}

describe('defaultDeps().runGit', () => {
  it('runs git in the given cwd and returns its exit code and stdout', () => {
    const dir = hostileRepo();
    const res = defaultDeps().runGit(['rev-parse', '--show-toplevel'], dir);
    expect(res).toEqual({ code: 0, stdout: `${realpathSync(dir)}\n` });
  });

  it('runs in the process cwd when no cwd is given', () => {
    // `--version` needs no repo, so the omitted-cwd default is observable
    // without chdir (unavailable in a worker thread).
    const res = defaultDeps().runGit(['--version']);
    expect(res?.code).toBe(0);
    expect(res?.stdout).toMatch(/^git version /);
  });

  it('reports a failing git command by its non-zero code, not null', () => {
    const dir = hostileRepo();
    const res = defaultDeps().runGit(
      ['rev-parse', '--verify', '--quiet', 'no-such-ref'],
      dir,
    );
    expect(res).toEqual({ code: 1, stdout: '' });
  });

  /** stdout of a SUCCESSFUL `runGit`; a spawn failure or non-zero exit fails loudly here, not as a confusing substring miss. */
  function gitStdout(args: string[], dir: string): string {
    const res = defaultDeps().runGit(args, dir);
    expect(res, `git ${args.join(' ')} could not be spawned`).not.toBeNull();
    expect(res!.code, `git ${args.join(' ')} exited non-zero`).toBe(0);
    return res!.stdout;
  }

  it('forces a/ b/ prefixes on `git diff` despite diff.noprefix', () => {
    const stdout = gitStdout(['diff'], hostileRepo());
    expect(stdout).toContain('--- a/f.txt\n+++ b/f.txt\n');
  });

  it('strips colour from `git diff` despite color.ui=always', () => {
    const stdout = gitStdout(['diff'], hostileRepo());
    expect(stdout, 'ANSI escape leaked into the parsed diff').not.toContain(
      '\u001b[',
    );
  });

  it('leaves non-diff commands unflagged, so repo colour config still applies', () => {
    // The parseable-diff flags are inserted ONLY for `diff`: a `show` under
    // the same hostile config keeps the user's coloured output. (One
    // contract -- "non-diff argv is passed through" -- seen via colour.)
    const stdout = gitStdout(['show', '--format=', 'HEAD'], hostileRepo());
    expect(stdout, 'parseable-diff flags leaked into `git show`').toContain(
      '\u001b[',
    );
  });

  it('returns null when the git binary cannot be spawned', () => {
    setEnv('PATH', mkTmp('guardian-default-deps-nopath-'));
    expect(defaultDeps().runGit(['--version'])).toBeNull();
  });
});

describe('defaultDeps().runGh', () => {
  it('reports an unspawnable gh as failed, with no status', () => {
    setEnv('PATH', mkTmp('guardian-default-deps-nopath-'));
    expect(defaultDeps().runGh(['api', 'user'])).toEqual({
      status: null,
      stdout: '',
      stderr: '',
      failed: true,
    });
  });

  it.skipIf(IS_WINDOWS)(
    'returns the exit status and both streams of a gh that ran',
    () => {
      const bin = mkTmp('guardian-default-deps-gh-');
      const gh = join(bin, 'gh');
      writeFileSync(
        gh,
        '#!/bin/sh\necho "out:$1 $2"\necho "err:$1" >&2\nexit 4\n',
      );
      chmodSync(gh, 0o755);
      setEnv('PATH', bin);
      expect(defaultDeps().runGh(['api', 'user'])).toEqual({
        status: 4,
        stdout: 'out:api user\n',
        stderr: 'err:api\n',
        failed: false,
      });
    },
  );
});

describe('defaultDeps() process sinks', () => {
  it('out writes one newline-terminated line to stdout', () => {
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    defaultDeps().out('hello');
    expect(write).toHaveBeenCalledWith('hello\n');
  });

  it('err writes one newline-terminated line to stderr', () => {
    const write = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    defaultDeps().err('oops');
    expect(write).toHaveBeenCalledWith('oops\n');
  });

  it('env is the live process.env and cwd() is the process cwd', () => {
    const deps = defaultDeps();
    setEnv('CANARY_DEFAULT_DEPS_PROBE', 'live');
    expect(deps.env['CANARY_DEFAULT_DEPS_PROBE']).toBe('live');
    expect(deps.cwd()).toBe(process.cwd());
  });
});

describe('defaultDeps().sleep', () => {
  it('resolves after the given number of SECONDS, not milliseconds', async () => {
    vi.useFakeTimers();
    let done = false;
    const pending = defaultDeps()
      .sleep(2)
      .then(() => {
        done = true;
      });
    await vi.advanceTimersByTimeAsync(1999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(done).toBe(true);
  });
});

describe('defaultDeps().makeAgentTier', () => {
  it('builds the in-session tier, which reports no findings on its own', () => {
    // Production runs no LLM from the CLI (Option A): the SKILL drives the
    // reviewer, so the default tier must never fabricate a weak-test finding.
    const tier = defaultDeps().makeAgentTier();
    expect(tier.audit_test_quality(['test/a.test.ts'])).toEqual([]);
  });
});

/** Stub `fetch` with one canned JSON response; returns the spy. */
function stubFetch(body: unknown): ReturnType<typeof vi.fn> {
  const fetchSpy = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

/** The [url, Authorization header] of the first `fetch` call. */
function firstRequest(fetchSpy: ReturnType<typeof vi.fn>): [string, string] {
  const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
  const headers = init.headers as Record<string, string>;
  return [url, headers['Authorization'] ?? ''];
}

describe('defaultDeps() GitHub client builders', () => {
  it('buildCommentClient posts to the PR issue thread with GITHUB_TOKEN', async () => {
    setEnv('GITHUB_TOKEN', 'tok-from-env');
    const fetchSpy = stubFetch({ id: 1, body: 'hi' });
    await defaultDeps().buildCommentClient('o/r', 7).createComment('hi');
    expect(firstRequest(fetchSpy)).toEqual([
      'https://api.github.com/repos/o/r/issues/7/comments',
      'Bearer tok-from-env',
    ]);
  });

  it('buildCommentClient sends an empty bearer when GITHUB_TOKEN is unset', async () => {
    // Rule 1 (omit the default): no token is not an error at build time --
    // the request goes out unauthenticated and GitHub's 401 decides.
    setEnv('GITHUB_TOKEN', undefined);
    const fetchSpy = stubFetch({ id: 1, body: 'hi' });
    await defaultDeps().buildCommentClient('o/r', 7).createComment('hi');
    expect(firstRequest(fetchSpy)[1]).toBe('Bearer ');
  });

  it('buildAdjudicationSource reads PR files with the token it was given', async () => {
    const fetchSpy = stubFetch([]);
    const files = await defaultDeps()
      .buildAdjudicationSource('o/r', 'adj-tok')
      .prFiles(5);
    expect(files).toEqual([]);
    expect(firstRequest(fetchSpy)).toEqual([
      'https://api.github.com/repos/o/r/pulls/5/files?per_page=100',
      'Bearer adj-tok',
    ]);
  });

  it('buildBranchProtectionClient reads required checks with the token it was given', async () => {
    const fetchSpy = stubFetch({ checks: [{ context: 'ci' }] });
    const contexts = await defaultDeps()
      .buildBranchProtectionClient('o/r', 'bp-tok')
      .requiredCheckContexts('main');
    expect(contexts).toEqual(['ci']);
    expect(firstRequest(fetchSpy)).toEqual([
      'https://api.github.com/repos/o/r/branches/main/protection/required_status_checks',
      'Bearer bp-tok',
    ]);
  });
});
