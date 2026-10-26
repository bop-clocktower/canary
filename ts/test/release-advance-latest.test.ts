/**
 * `release.yml`'s advance-latest job never moves `latest` backwards (#1427).
 *
 * The job force-pushes the floating `latest` tag. A `concurrency:` group only
 * serialises the runs, and they queue in the order their `publish` and
 * `verify-bins` finish, not in tag order. Serialised force pushes are still
 * last-writer-wins, so an older release whose publish finished later used to
 * move `latest` back to itself. The step now advances only when the release
 * tag is the highest stable semver tag in the repo; every other run is a
 * logged no-op.
 *
 * Offline: the selection script runs under node on stdin, and the step's own
 * `run:` script runs under bash in a temp clone whose `origin` is a local bare
 * repo, the same shape as `ledger-push-jobs.test.ts`.
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { REPO_ROOT } from './required-checks-testkit.js';

const SCRIPT = join(REPO_ROOT, 'scripts', 'highest-stable-tag.mjs');

interface Step {
  name?: string;
  env?: Record<string, string>;
  run?: string;
}
interface Job {
  concurrency?: unknown;
  steps?: Step[];
}

function advanceLatest(): Job {
  const wf = loadYaml(
    readFileSync(
      join(REPO_ROOT, '.github', 'workflows', 'release.yml'),
      'utf8',
    ),
  ) as { jobs: Record<string, Job> };
  const job = wf.jobs['advance-latest'];
  expect(job, 'release.yml has no advance-latest job').toBeDefined();
  return job!;
}

// The push of the floating tag, however it is spelled.
const PUSH_LATEST = /git push\b[^\n]*\blatest\b/;

function moveStep(): Step {
  const step = (advanceLatest().steps ?? []).find((s) =>
    PUSH_LATEST.test(s.run ?? ''),
  );
  expect(step, 'advance-latest has no step that pushes latest').toBeDefined();
  return step!;
}

function pick(stdin: string, args: string[] = []) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    input: stdin,
    encoding: 'utf8',
  });
}

describe('scripts/highest-stable-tag.mjs', () => {
  it.each([
    // Numeric, not lexical: v1.10.0 outranks v1.9.0, and v10 outranks v9.
    [['v1.9.0', 'v1.10.0', 'v1.2.0'], 'v1.10.0'],
    [['v9.5.0', 'v10.0.0', 'v9.10.3'], 'v10.0.0'],
    [['v2.0.1', 'v2.0.10', 'v2.0.9'], 'v2.0.10'],
    // A pre-release is never stable, even when it sorts above every stable.
    [['v1.0.0', 'v2.0.0-rc.1', 'v1.5.0-beta'], 'v1.0.0'],
    // `latest` and anything else that is not vX.Y.Z is ignored.
    [
      ['latest', 'v1.0.0', 'v1.1', 'v1.2.0+build.5', 'vfoo', 'v1.0.0.1'],
      'v1.0.0',
    ],
    [['  v3.0.0  ', '', 'v3.0.1\r'], 'v3.0.1'],
  ])('picks the highest stable tag of %j', (tags, want) => {
    const r = pick(tags.join('\n'));
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${want}\n`);
  });

  it('abstains (exit 3) when there is no stable tag to rank', () => {
    const r = pick('latest\nv1.0.0-rc.1\n');
    expect(r.status).toBe(3);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/no stable/i);
  });

  it('rejects arguments (exit 2): it reads tags from stdin only', () => {
    const r = pick('v1.0.0\n', ['v1.0.0']);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
  });
});

describe('release.yml advance-latest guards on the highest stable tag', () => {
  it('passes the release tag to the step through env, never inline', () => {
    const step = moveStep();
    expect(step.env?.RELEASE_TAG).toBe('${{ github.ref_name }}');
    expect(step.run).not.toMatch(/\$\{\{/);
  });

  it('ranks the repo tags with the selection script before pushing', () => {
    const run = moveStep().run!;
    expect(run).toMatch(/git fetch[^\n]*--tags/);
    expect(run).toContain('node scripts/highest-stable-tag.mjs');
    expect(run.indexOf('highest-stable-tag.mjs')).toBeLessThan(
      run.search(PUSH_LATEST),
    );
  });
});

describe('#1481 release.yml advance-latest: per-tag group, compare-and-swap push', () => {
  // One shared group let a third close release cancel the second's pending
  // advance (GitHub keeps one pending run per group). Keyed per tag, runs for
  // different tags no longer queue behind each other, so two of them can both
  // pass the highest-tag guard. The push is therefore a compare-and-swap on
  // the `latest` SHA read before the guard: whoever pushes second is rejected.
  it('keys the concurrency group per tag and never cancels a running move', () => {
    expect(advanceLatest().concurrency).toEqual({
      group: 'latest-tag-${{ github.ref_name }}',
      'cancel-in-progress': false,
    });
  });

  /** The variable the push leases against, e.g. `LEASE` in `...latest:${LEASE}`. */
  function leaseVar(run: string): string {
    const m =
      /--force-with-lease=["']?refs\/tags\/latest:\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/.exec(
        run,
      );
    expect(
      m,
      'push does not lease refs/tags/latest on a variable',
    ).not.toBeNull();
    return m![1]!;
  }

  it('pushes latest with --force-with-lease on refs/tags/latest', () => {
    const run = moveStep().run!;
    const push = run.split('\n').find((l) => PUSH_LATEST.test(l))!;
    expect(push).toMatch(/--force-with-lease=["']?refs\/tags\/latest:/);
    // The full ref, so `latest` cannot resolve to a branch of the same name.
    expect(push).toMatch(/\sorigin\s+refs\/tags\/latest\b/);
  });

  it('reads the lease from origin before fetching and ranking the tags', () => {
    const run = moveStep().run!;
    const name = leaseVar(run);
    const read = run.search(
      new RegExp(`\\b${name}="\\$\\(git ls-remote origin refs/tags/latest\\b`),
    );
    expect(read, `${name} is not read with git ls-remote`).toBeGreaterThan(-1);
    // Read before the fetch: a newer release tagged after the fetch could
    // otherwise move latest before the read, and the lease would bless a
    // stale guard.
    expect(read).toBeLessThan(run.search(/git fetch[^\n]*--tags/));
    expect(read).toBeLessThan(run.indexOf('highest-stable-tag.mjs'));
    expect(read).toBeLessThan(run.search(PUSH_LATEST));
  });

  it('has no bare force push of latest', () => {
    const pushes = moveStep()
      .run!.split('\n')
      .filter((l) => /\bgit\s+push\b/.test(l));
    expect(pushes.length).toBeGreaterThan(0);
    for (const l of pushes) {
      expect(l).not.toMatch(/\s--force(?!-with-lease=)/);
      expect(l).not.toMatch(/\s-f\b/);
      expect(l).not.toMatch(/\s\+\S/);
      // A bare --force-with-lease leases on an implicit remote-tracking
      // value, not on the SHA this run read before its guard.
      expect(l).not.toMatch(/--force-with-lease(?!=["']?refs\/tags\/latest:)/);
    }
  });
});

describe('release.yml advance-latest, run against a real remote', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };

  /**
   * A bare origin with one commit per tag, plus a clone of it laid out like
   * the job's checkout (the selection script at its repo path). Returns each
   * tag's commit SHA.
   */
  function setup(tags: string[]) {
    dir = mkdtempSync(join(tmpdir(), 'advance-latest-'));
    const origin = join(dir, 'origin.git');
    const seed = join(dir, 'seed');
    const work = join(dir, 'work');
    git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
    git(dir, 'init', '-q', '-b', 'main', seed);
    const sha: Record<string, string> = {};
    for (const t of tags) {
      git(
        seed,
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        t,
      );
      git(seed, 'tag', t);
      sha[t] = git(seed, 'rev-parse', 'HEAD');
    }
    git(seed, 'push', '-q', origin, 'main', '--tags');
    git(dir, 'clone', '-q', origin, work);
    mkdirSync(join(work, 'scripts'));
    copyFileSync(SCRIPT, join(work, 'scripts', 'highest-stable-tag.mjs'));
    return { origin, work, sha };
  }

  function runStep(
    work: string,
    tag: string,
    sha: string,
    env: NodeJS.ProcessEnv = {},
  ) {
    return spawnSync('bash', ['-e', '-o', 'pipefail', '-c', moveStep().run!], {
      cwd: work,
      encoding: 'utf8',
      env: {
        ...process.env,
        RELEASE_TAG: tag,
        RELEASE_SHA: sha,
        GITHUB_STEP_SUMMARY: join(dir!, 'summary.md'),
        ...env,
      },
    });
  }

  /**
   * #1481: a `git` on PATH that runs `race` (a bash snippet, with `$GIT` as
   * the real git) just before each of the step's first `times` pushes. That is
   * a second advance-latest run moving origin's `latest` between this run's
   * guard and its push, which a per-tag concurrency group no longer prevents.
   */
  function racingGit(race: string, times: number): NodeJS.ProcessEnv {
    const bin = join(dir!, 'bin');
    mkdirSync(bin);
    const real = spawnSync('bash', ['-c', 'command -v git'], {
      encoding: 'utf8',
    }).stdout.trim();
    const count = join(dir!, 'race-count');
    writeFileSync(
      join(bin, 'git'),
      [
        '#!/usr/bin/env bash',
        'if [ "$1" = push ]; then',
        `  n=$(cat '${count}' 2>/dev/null || echo 0)`,
        `  if [ "$n" -lt ${times} ]; then`,
        `    echo $((n + 1)) > '${count}'`,
        `    GIT='${real}' RACE_N=$((n + 1)) bash -e -c "$RACE"`,
        '  fi',
        'fi',
        `exec '${real}' "$@"`,
        '',
      ].join('\n'),
    );
    chmodSync(join(bin, 'git'), 0o755);
    return { PATH: `${bin}:${process.env.PATH ?? ''}`, RACE: race };
  }

  /** Commit and tag `tag` in the seed repo without pushing it. */
  function seedTag(tag: string): string {
    const seed = join(dir!, 'seed');
    git(
      seed,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      tag,
    );
    git(seed, 'tag', tag);
    return git(seed, 'rev-parse', 'HEAD');
  }

  const latestAt = (origin: string) =>
    spawnSync('git', ['rev-parse', '--verify', '-q', 'latest^{commit}'], {
      cwd: origin,
      encoding: 'utf8',
    }).stdout.trim();

  it('advances latest when the release is the highest stable tag', () => {
    const { origin, work, sha } = setup(['v1.9.0', 'v1.10.0', 'v2.0.0-rc.1']);
    const r = runStep(work, 'v1.10.0', sha['v1.10.0']!);
    expect(r.stderr).not.toMatch(/::error::/);
    expect(r.status).toBe(0);
    expect(latestAt(origin)).toBe(sha['v1.10.0']);
  });

  it('an older release that finishes later leaves latest where it is', () => {
    const { origin, work, sha } = setup(['v1.9.0', 'v1.10.0']);
    expect(runStep(work, 'v1.10.0', sha['v1.10.0']!).status).toBe(0);

    // v1.9.0's publish finished last, so its advance runs second. Before the
    // guard this force-pushed latest back to v1.9.0.
    const late = runStep(work, 'v1.9.0', sha['v1.9.0']!);
    expect(late.status).toBe(0);
    expect(late.stdout).toMatch(/::notice::.*v1\.9\.0.*v1\.10\.0/);
    expect(latestAt(origin)).toBe(sha['v1.10.0']);
  });

  it('sees a newer tag pushed to origin after the checkout', () => {
    const { origin, work, sha } = setup(['v1.0.0']);
    // A newer release tag lands on origin after this job checked out.
    const seed = join(dir!, 'seed');
    git(
      seed,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'v1.0.1',
    );
    git(seed, 'tag', 'v1.0.1');
    git(seed, 'push', '-q', origin, 'main', '--tags');

    const r = runStep(work, 'v1.0.0', sha['v1.0.0']!);
    expect(r.status).toBe(0);
    expect(latestAt(origin)).toBe('');
  });

  // #1481: the git semantics the step relies on, rehearsed directly.
  it('git rejects a lease push whose expected latest SHA is stale', () => {
    const { origin, work, sha } = setup(['v1.0.0', 'v1.1.0']);
    const push = (lease: string) =>
      spawnSync(
        'git',
        [
          'push',
          `--force-with-lease=refs/tags/latest:${lease}`,
          'origin',
          'refs/tags/latest',
        ],
        { cwd: work, encoding: 'utf8' },
      );
    git(work, 'tag', '-f', 'latest', sha['v1.0.0']!);
    // An empty expected value means "must not exist yet".
    expect(push('').status).toBe(0);
    git(work, 'tag', '-f', 'latest', sha['v1.1.0']!);
    expect(push('').status).not.toBe(0);
    expect(push(sha['v1.1.0']!).status).not.toBe(0);
    expect(latestAt(origin)).toBe(sha['v1.0.0']);
    expect(push(sha['v1.0.0']!).status).toBe(0);
    expect(latestAt(origin)).toBe(sha['v1.1.0']);
  });

  it('a newer release that moves latest between the guard and the push wins', () => {
    // origin has no `latest` yet, so this run leases on "must not exist".
    const { origin, work, sha } = setup(['v1.0.0']);
    const seed = join(dir!, 'seed');
    const newer = seedTag('v1.1.0');
    // The v1.1.0 release is tagged and its advance lands after this run
    // ranked the tags but before it pushed.
    const env = racingGit(
      `"$GIT" -C '${seed}' push -q --force '${origin}' refs/tags/v1.1.0 refs/tags/v1.1.0:refs/tags/latest`,
      1,
    );
    const r = runStep(work, 'v1.0.0', sha['v1.0.0']!, env);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    // Before #1481 the unconditional force push moved latest back to v1.0.0.
    expect(latestAt(origin)).toBe(newer);
    // The retry re-ranked against the fresh tags and stood down.
    expect(r.stdout).toMatch(/::notice::.*v1\.0\.0.*v1\.1\.0/);
  });

  it('fails loudly, never silently, when latest keeps moving under it', () => {
    const { origin, work, sha } = setup(['v0.9.0', 'v1.0.0']);
    const seed = join(dir!, 'seed');
    // Every push attempt finds latest moved again by someone else.
    const env = racingGit(
      `"$GIT" -C '${seed}' -c user.name=t -c user.email=t@t tag -f -a latest v0.9.0 -m "race $RACE_N" >/dev/null && "$GIT" -C '${seed}' push -q --force '${origin}' refs/tags/latest`,
      10,
    );
    const r = runStep(work, 'v1.0.0', sha['v1.0.0']!, env);
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/::error::.*latest/);
    expect(latestAt(origin)).toBe(sha['v0.9.0']);
  });
});
