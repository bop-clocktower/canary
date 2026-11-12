/**
 * The write half of `refresh-arch-baseline.yml`, run for real (#1463).
 *
 * The workflow only fires on the `refresh-baseline` label, so nothing else
 * exercises these scripts before a maintainer needs them. `workflow-hygiene`
 * pins the job's shape. This file runs its `run:` scripts under bash in a temp
 * clone whose `origin` is a local bare repo, so each behaviour the single job
 * had (#634, #749, the mid-run race guard) is proved against git, not against
 * the text of the YAML.
 *
 * Offline: js-yaml for the steps, a local bare repo for the remote, and a stub
 * `gh` for the label job.
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REPO_ROOT } from './required-checks-testkit.js';

interface Step {
  uses?: string;
  env?: Record<string, string>;
  run?: string;
}
interface Workflow {
  jobs: Record<string, { steps?: Step[] }>;
}

const wf = loadYaml(
  readFileSync(
    join(REPO_ROOT, '.github', 'workflows', 'refresh-arch-baseline.yml'),
    'utf8',
  ),
) as Workflow;

const BRANCH = 'feat/some-pr';
const BASELINE = '.harness/arch/baselines.json';
const AUDIT = '.harness/audit.log';

/** The bytes the refresh script writes: `JSON.stringify(doc, null, 2)` + LF. */
const serialize = (doc: unknown): string => `${JSON.stringify(doc, null, 2)}\n`;

const OLD_AT = '2026-01-01T00:00:00.000Z';
const NEW_AT = '2026-11-12T08:30:00.123Z';

/**
 * A baseline with one metric at `value`, stamped as the refresh script stamps
 * it: `updatedAt` from `toISOString()`, `updatedFrom` the measured commit.
 * `from` defaults to `headSha`, so call it after `beforeEach` has set that.
 * `OLD_BASELINE` carries valid stamps too, so an artifact equal to it reaches
 * the #634 no-change guard instead of being refused by the content checks.
 */
const baselineDoc = (
  value: unknown,
  { at = NEW_AT as unknown, from = undefined as unknown, ids = ['v1'] } = {},
): Record<string, unknown> => ({
  version: 1,
  updatedAt: at,
  updatedFrom: from === undefined ? headSha : from,
  metrics: { complexity: { value, violationIds: ids } },
});
const baseline = (...args: Parameters<typeof baselineDoc>): string =>
  serialize(baselineDoc(...args));
const OLD_BASELINE = serialize({
  version: 1,
  updatedAt: OLD_AT,
  updatedFrom: 'a'.repeat(40),
  metrics: { complexity: { value: 1, violationIds: ['v1'] } },
});
/** The default artifact: the refresh raised the one metric from 1 to 2. */
let NEW_BASELINE: string;

let dir: string;
let origin: string;
let work: string;
let src: string;
let headSha: string;

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args],
    { cwd, encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** `${{ }}` as the runner would expand it for this job. */
function expand(value: string): string {
  return value
    .replace(/\$\{\{\s*runner\.temp\s*\}\}/, join(dir, 'runner-temp'))
    .replace(/\$\{\{\s*github\.event\.pull_request\.head\.ref\s*\}\}/, BRANCH)
    .replace(/\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\}\}/, headSha)
    .replace(/\$\{\{\s*github\.event\.pull_request\.number\s*\}\}/, '7')
    .replace(/\$\{\{\s*github\.token\s*\}\}/, 'not-a-token');
}

function stepEnv(step: Step, path: string, summary: string) {
  const env: Record<string, string> = {
    PATH: path,
    HOME: dir,
    GIT_CONFIG_NOSYSTEM: '1',
    GITHUB_STEP_SUMMARY: summary,
    GITHUB_REPOSITORY: 'o/r',
  };
  for (const [k, v] of Object.entries(step.env ?? {})) env[k] = expand(v);
  return env;
}

function runSteps(jobId: string, cwd: string, path = process.env.PATH ?? '') {
  const summary = join(dir, 'summary.md');
  let last = { status: 0 as number | null, log: '' };
  const scripts = (wf.jobs[jobId]?.steps ?? []).filter((s) => s.run);
  expect(scripts.length, `${jobId} has no run steps`).toBeGreaterThan(0);
  for (const step of scripts) {
    const r = spawnSync('bash', ['-e', '-c', step.run!], {
      cwd,
      encoding: 'utf8',
      env: stepEnv(step, path, summary),
    });
    last = { status: r.status, log: `${r.stdout}${r.stderr}` };
    if (r.status !== 0) break;
  }
  const text = existsSync(summary) ? readFileSync(summary, 'utf8') : '';
  return { ...last, summary: text };
}

const tip = () =>
  git(origin, 'rev-parse', `refs/heads/${BRANCH}`).split('\n')[0]!;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'refresh-push-'));
  origin = join(dir, 'origin.git');
  work = join(dir, 'work');
  src = join(dir, 'runner-temp', 'refreshed-arch-baseline');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  git(dir, 'clone', '-q', origin, work);
  git(work, 'checkout', '-q', '-b', BRANCH);
  write(join(work, BASELINE), OLD_BASELINE);
  write(join(work, AUDIT), 'log\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'seed');
  git(work, 'push', '-q', 'origin', BRANCH);
  headSha = git(work, 'rev-parse', 'HEAD');
  // actions/checkout with `ref: <sha>` leaves a detached HEAD.
  git(work, 'checkout', '-q', '--detach', headSha);
  // The default artifact: the refresh moved the baseline, the CLI left the log.
  NEW_BASELINE = baseline(2);
  write(join(src, 'arch/baselines.json'), NEW_BASELINE);
  write(join(src, 'audit.log'), 'log\n');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('refresh-arch-baseline.yml push job', () => {
  it('commits the refreshed baseline on top of the measured commit', () => {
    const r = runSteps('push', work);
    expect(r.status, r.log).toBe(0);
    expect(git(origin, 'show', `${BRANCH}:${BASELINE}`)).toBe(
      NEW_BASELINE.trim(),
    );
    expect(git(origin, 'rev-parse', `${BRANCH}~1`)).toBe(headSha);
    expect(git(origin, 'log', '-1', '--format=%s', BRANCH)).toMatch(
      /refresh arch baseline/,
    );
    expect(r.summary).toContain(BRANCH);
  });

  it('commits only the baseline when the CLI left audit.log alone', () => {
    const r = runSteps('push', work);
    expect(r.status, r.log).toBe(0);
    expect(git(origin, 'show', '--format=', '--name-only', BRANCH)).toBe(
      BASELINE,
    );
  });

  it('stages audit.log when the CLI touched it', () => {
    write(join(src, 'audit.log'), 'log\nappended\n');
    const r = runSteps('push', work);
    expect(r.status, r.log).toBe(0);
    expect(git(origin, 'show', `${BRANCH}:${AUDIT}`)).toBe('log\nappended');
  });

  it('fails when the baseline did not change (#634), and pushes nothing', () => {
    write(join(src, 'arch/baselines.json'), OLD_BASELINE);
    const r = runSteps('push', work);
    expect(r.status).toBe(1);
    expect(r.log).toMatch(/baselines\.json is unchanged/);
    expect(tip()).toBe(headSha);
  });

  // #749: the guard names the intended artifact, so a change to anything else
  // cannot satisfy it.
  it('fails when only audit.log changed (#749)', () => {
    write(join(src, 'arch/baselines.json'), OLD_BASELINE);
    write(join(src, 'audit.log'), 'log\nappended\n');
    const r = runSteps('push', work);
    expect(r.status).toBe(1);
    expect(tip()).toBe(headSha);
  });

  it('pushes nothing when the branch moved after it was measured', () => {
    const other = join(dir, 'other');
    git(dir, 'clone', '-q', '-b', BRANCH, origin, other);
    write(join(other, 'later.txt'), 'later\n');
    git(other, 'add', '.');
    git(other, 'commit', '-q', '-m', 'later');
    git(other, 'push', '-q', 'origin', BRANCH);
    const moved = tip();

    const r = runSteps('push', work);
    expect(r.status).toBe(1);
    expect(r.log).toMatch(/moved/);
    expect(tip()).toBe(moved);
  });

  // A fast-forward check alone would pass this one: the measured commit is a
  // descendant of the rewound tip, so the push would resurrect dropped commits.
  it('pushes nothing when the branch was rewound after it was measured', () => {
    git(work, 'commit', '-q', '--allow-empty', '-m', 'second');
    git(work, 'push', '-q', 'origin', `HEAD:refs/heads/${BRANCH}`);
    const rewound = headSha;
    headSha = git(work, 'rev-parse', 'HEAD');
    git(work, 'push', '-q', '-f', 'origin', `${rewound}:refs/heads/${BRANCH}`);

    const r = runSteps('push', work);
    expect(r.status).toBe(1);
    expect(tip()).toBe(rewound);
  });

  // ls-remote matches by path suffix, so another ref ending in the same path
  // must not answer for the branch.
  it('reads the exact branch ref, not a ref that ends in the same path', () => {
    git(work, 'commit', '-q', '--allow-empty', '-m', 'second');
    git(work, 'push', '-q', 'origin', `HEAD:refs/heads/${BRANCH}`);
    const rewound = headSha;
    headSha = git(work, 'rev-parse', 'HEAD');
    git(work, 'push', '-q', 'origin', `HEAD:refs/a/refs/heads/${BRANCH}`);
    git(work, 'push', '-q', '-f', 'origin', `${rewound}:refs/heads/${BRANCH}`);

    const r = runSteps('push', work);
    expect(r.status).toBe(1);
    expect(tip()).toBe(rewound);
  });

  it('stages only the two named files', () => {
    write(join(work, 'stray.txt'), 'stray\n');
    const r = runSteps('push', work);
    expect(r.status, r.log).toBe(0);
    expect(git(origin, 'show', '--format=', '--name-only', BRANCH)).toBe(
      BASELINE,
    );
  });

  it('skips with a warning when the branch was deleted mid-run', () => {
    git(work, 'push', '-q', 'origin', '--delete', BRANCH);
    const r = runSteps('push', work);
    expect(r.status, r.log).toBe(0);
    expect(r.log).toMatch(/::warning::.*no longer exists/);
    expect(git(origin, 'branch', '--list', BRANCH)).toBe('');
  });

  // Before #1463 any ls-remote failure read as "branch deleted" and went green.
  it('fails, rather than skipping, when the remote cannot be read', () => {
    git(work, 'remote', 'set-url', 'origin', join(dir, 'missing.git'));
    const r = runSteps('push', work);
    expect(r.status).not.toBe(0);
    expect(r.log).not.toMatch(/no longer exists/);
  });

  it('fails when the push is rejected (#548)', () => {
    const hook = join(origin, 'hooks', 'pre-receive');
    write(hook, '#!/bin/sh\nexit 1\n');
    chmodSync(hook, 0o755);
    const r = runSteps('push', work);
    expect(r.status).not.toBe(0);
    expect(tip()).toBe(headSha);
  });
});

describe('refresh-arch-baseline.yml push job distrusts its input', () => {
  /** Nothing reached the remote, and the job failed. */
  function expectRefused(pattern: RegExp): void {
    const r = runSteps('push', work);
    expect(r.status, r.log).not.toBe(0);
    expect(r.log).toMatch(pattern);
    expect(tip()).toBe(headSha);
  }

  it('refuses a symlink in the artifact rather than copying its target', () => {
    const secret = join(dir, 'secret');
    writeFileSync(secret, 'token\n');
    rmSync(join(src, 'arch/baselines.json'));
    symlinkSync(secret, join(src, 'arch/baselines.json'));
    expectRefused(/unexpected|not a regular file/);
  });

  it('refuses a symlinked directory in the artifact', () => {
    const elsewhere = join(dir, 'elsewhere');
    write(join(elsewhere, 'baselines.json'), 'new\n');
    rmSync(join(src, 'arch'), { recursive: true });
    symlinkSync(elsewhere, join(src, 'arch'));
    expectRefused(/unexpected/);
  });

  it('refuses a file the artifact should not hold', () => {
    write(join(src, 'arch/allowances/planted.json'), '{}\n');
    expectRefused(/unexpected/);
    expect(existsSync(join(work, '.harness/arch/allowances'))).toBe(false);
  });

  it('refuses an artifact with no baseline', () => {
    rmSync(join(src, 'arch/baselines.json'));
    expectRefused(/missing/);
  });

  it('refuses an artifact with no audit.log', () => {
    rmSync(join(src, 'audit.log'));
    expectRefused(/missing/);
  });

  // The checkout is the PR's tree, so its paths are as untrusted as the
  // artifact. `cp` writes through a symlink at the destination.
  it('refuses a baseline that is a symlink in the checkout', () => {
    const config = join(work, '.git', 'config');
    const before = readFileSync(config, 'utf8');
    rmSync(join(work, BASELINE));
    symlinkSync(config, join(work, BASELINE));
    expectRefused(/symlink/);
    expect(readFileSync(config, 'utf8')).toBe(before);
  });

  it('refuses a .harness directory that is a symlink in the checkout', () => {
    const real = join(dir, 'real-harness');
    mkdirSync(real);
    write(join(real, 'arch/baselines.json'), OLD_BASELINE);
    write(join(real, 'audit.log'), 'log\n');
    rmSync(join(work, '.harness'), { recursive: true });
    symlinkSync(real, join(work, '.harness'));
    expectRefused(/symlink/);
  });

  it('refuses a parent directory that is a symlink in the checkout', () => {
    const target = join(work, '.git');
    rmSync(join(work, '.harness/arch'), { recursive: true });
    symlinkSync(target, join(work, '.harness/arch'));
    expectRefused(/symlink/);
    expect(existsSync(join(target, 'baselines.json'))).toBe(false);
  });

  // The artifact comes from a job that ran registry code, so its content has
  // to be checked here, not only in the script that wrote it.
  //
  // Each row builds its text lazily, because the stamps name `headSha`.
  const SINGLE = /not a single JSON document/;
  const FINITE = /not a finite number/;
  const STAMP = /updatedAt is not|updatedFrom is not/;
  const CANON = /not byte-for-byte/;
  const SHAPE = /more than metric values/;
  it.each<[string, () => string, RegExp]>([
    ['banks a violation', () => baseline(2, { ids: ['v1', 'v2'] }), SHAPE],
    ['drops a violation', () => baseline(2, { ids: [] }), SHAPE],
    [
      'adds a metric',
      () => {
        const doc = baselineDoc(2) as { metrics: Record<string, unknown> };
        doc.metrics.coupling = { value: 9, violationIds: [] };
        return serialize(doc);
      },
      SHAPE,
    ],
    ['sets a non-numeric value', () => baseline('2'), FINITE],
    // jq 1.7 reads a bare `nan` as a number, and `isfinite` is true for it.
    [
      'sets a nan value',
      () => baseline(2).replace('"value": 2', '"value": nan'),
      FINITE,
    ],
    // JSON.parse reads this as Infinity.
    [
      'sets an overflowing value',
      () => baseline(2).replace('"value": 2', '"value": 1e1000'),
      FINITE,
    ],
    // jq answers `-e` from the LAST document only, and `cp` copies them all.
    ['leads with a number', () => `5\n${baseline(2)}`, SINGLE],
    [
      'leads with a string',
      () => `"arbitrary payload"\n${baseline(2)}`,
      SINGLE,
    ],
    ['leads with an array', () => `[1,2,3]\n${baseline(2)}`, SINGLE],
    ['leads with an object', () => `{"a":1}\n${baseline(2)}`, SINGLE],
    ['trails a second baseline', () => `${baseline(2)}${baseline(2)}`, SINGLE],
    ['is not JSON', () => 'not json\n', SINGLE],
    ['is empty', () => '', SINGLE],
    ['is not an object', () => serialize([baselineDoc(2)]), SINGLE],
    // `updatedAt: "not-a-date"` would put main into `mode=threshold-only`.
    [
      'stamps updatedAt with a non-date',
      () => baseline(2, { at: 'not-a-date' }),
      STAMP,
    ],
    [
      'stamps updatedAt with an impossible date',
      () => baseline(2, { at: '2026-02-31T00:00:00.000Z' }),
      STAMP,
    ],
    ['stamps updatedAt with a number', () => baseline(2, { at: 1 }), STAMP],
    [
      'drops updatedAt',
      () => {
        const doc = baselineDoc(2);
        delete doc.updatedAt;
        return serialize(doc);
      },
      STAMP,
    ],
    [
      'stamps updatedFrom with a non-hash',
      () => baseline(2, { from: 'main' }),
      STAMP,
    ],
    [
      'stamps updatedFrom with a non-string',
      () => baseline(2, { from: 7 }),
      STAMP,
    ],
    // jq skips a UTF-8 BOM, but JSON.parse fails on it.
    ['leads with a byte-order mark', () => `﻿${baseline(2)}`, CANON],
    [
      'is not formatted as the refresh script writes it',
      () => `${JSON.stringify(baselineDoc(2))}\n`,
      CANON,
    ],
  ])('refuses a baseline that %s', (_name, text, pattern) => {
    write(join(src, 'arch/baselines.json'), text());
    expectRefused(pattern);
    expect(readFileSync(join(work, BASELINE), 'utf8')).toBe(OLD_BASELINE);
  });

  // The positive control for every row above: the repo's own baseline, raised
  // the way the refresh script raises it, is accepted byte-for-byte.
  it('accepts a refresh of the real baseline', () => {
    const real = JSON.parse(
      readFileSync(join(REPO_ROOT, BASELINE), 'utf8'),
    ) as {
      updatedAt: string;
      updatedFrom: string;
      metrics: Record<string, { value: number }>;
    };
    write(join(work, BASELINE), serialize(real));
    git(work, 'commit', '-q', '-am', 'real baseline');
    git(work, 'push', '-q', 'origin', `HEAD:refs/heads/${BRANCH}`);
    headSha = git(work, 'rev-parse', 'HEAD');
    real.metrics.complexity!.value += 1;
    real.updatedAt = new Date().toISOString();
    real.updatedFrom = headSha;
    write(join(src, 'arch/baselines.json'), serialize(real));
    const r = runSteps('push', work);
    expect(r.status, r.log).toBe(0);
    expect(git(origin, 'show', `${BRANCH}:${BASELINE}`)).toBe(
      serialize(real).trim(),
    );
  });

  it.each([
    ['rewrites existing lines', 'forged\nlog\n'],
    ['truncates the log', ''],
  ])('refuses an audit.log that %s', (_name, text) => {
    write(join(src, 'audit.log'), text);
    expectRefused(/not an append/);
  });

  it('refuses a baseline the PR deleted from its tree', () => {
    rmSync(join(work, BASELINE));
    expectRefused(/not a regular file/);
  });

  it('refuses a destination that is a directory in the checkout', () => {
    rmSync(join(work, AUDIT));
    mkdirSync(join(work, AUDIT));
    expectRefused(/not a regular file/);
  });
});

describe('refresh-arch-baseline.yml consume-label job', () => {
  /** A PATH whose `gh` records its argv and exits with `code`. */
  function stubGh(code: number): { path: string; calls: string } {
    const bin = join(dir, 'bin');
    const calls = join(dir, 'gh-calls');
    write(
      join(bin, 'gh'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${calls}"\nexit ${code}\n`,
    );
    chmodSync(join(bin, 'gh'), 0o755);
    return { path: `${bin}:${process.env.PATH ?? ''}`, calls };
  }

  it('removes the label from the PR that asked for the refresh', () => {
    const { path, calls } = stubGh(0);
    const r = runSteps('consume-label', dir, path);
    expect(r.status, r.log).toBe(0);
    expect(readFileSync(calls, 'utf8')).toBe(
      'pr edit 7 --repo o/r --remove-label refresh-baseline\n',
    );
  });

  // The baseline is already pushed, so red would misreport the run. But the
  // label would still be on the PR, so the run has to say so.
  it('warns, and stays green, when the label cannot be removed', () => {
    const { path } = stubGh(1);
    const r = runSteps('consume-label', dir, path);
    expect(r.status, r.log).toBe(0);
    expect(r.log).toMatch(/::warning::.*label/);
  });
});
