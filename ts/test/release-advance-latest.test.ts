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
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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

function moveStep(): Step {
  const step = (advanceLatest().steps ?? []).find((s) =>
    /git push origin latest/.test(s.run ?? ''),
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
      run.indexOf('git push origin latest'),
    );
  });

  it('keeps the job serialised and never cancels a running tag move', () => {
    expect(advanceLatest().concurrency).toEqual({
      group: 'latest-tag',
      'cancel-in-progress': false,
    });
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

  function runStep(work: string, tag: string, sha: string) {
    return spawnSync('bash', ['-e', '-o', 'pipefail', '-c', moveStep().run!], {
      cwd: work,
      encoding: 'utf8',
      env: {
        ...process.env,
        RELEASE_TAG: tag,
        RELEASE_SHA: sha,
        GITHUB_STEP_SUMMARY: join(dir!, 'summary.md'),
      },
    });
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
});
