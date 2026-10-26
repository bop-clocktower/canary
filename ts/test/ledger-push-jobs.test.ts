/**
 * The ledger/timeline push lives in its own job, apart from the scan (#1426).
 *
 * `harness-security.yml` and `arch-snapshot.yml` each ran a floating
 * `@harness-engineering/cli` through `npx` and then pushed a side branch, all in
 * one job under `contents: write` (CWE-250 / CWE-272). They are now split: a
 * read-only job runs the CLI and uploads what it wrote, and a write job that
 * runs no registry code downloads it and does the push. `workflow-hygiene` pins
 * the permission side of that. This file pins the hand-off between the two
 * jobs, and runs the write job's own scripts against a real git remote. The
 * push must still land, and a rejected push must still fail the job (#548).
 *
 * Offline: js-yaml for shape. The behaviour tests run the workflow's `run:`
 * scripts under bash in a temp repo whose `origin` is a local bare repo.
 */

import { spawnSync } from 'node:child_process';
import {
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
import { afterEach, describe, expect, it } from 'vitest';
import { REPO_ROOT } from './required-checks-testkit.js';

interface Step {
  name?: string;
  uses?: string;
  if?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  run?: string;
}
interface Job {
  needs?: string | string[];
  if?: string;
  permissions?: unknown;
  concurrency?: unknown;
  steps?: Step[];
}
interface Workflow {
  jobs: Record<string, Job>;
}

interface Case {
  file: string;
  scanJob: string;
  writeJob: string;
  artifact: string;
  paths: string[];
  /**
   * Where each of `paths` sits inside the artifact, in the same order.
   * upload-artifact roots the artifact at the paths' least common ancestor
   * (#1490), so a lone path loses its directories. `workflow-hygiene.test.ts`
   * derives these from the upload list.
   */
  entries: string[];
  branch: string;
}

const CASES: Case[] = [
  {
    file: 'harness-security.yml',
    scanJob: 'security',
    writeJob: 'ledger',
    artifact: 'security-ledger',
    paths: ['.harness/security/timeline.json', 'docs/SECURITY_LEDGER.md'],
    entries: ['.harness/security/timeline.json', 'docs/SECURITY_LEDGER.md'],
    branch: 'chore/security-ledger',
  },
  {
    file: 'arch-snapshot.yml',
    scanJob: 'snapshot',
    writeJob: 'push',
    artifact: 'arch-timeline',
    paths: ['.harness/arch/timeline.json'],
    entries: ['timeline.json'],
    branch: 'chore/arch-timeline',
  },
];

function load(file: string): Workflow {
  return loadYaml(
    readFileSync(join(REPO_ROOT, '.github', 'workflows', file), 'utf8'),
  ) as Workflow;
}

function job(c: Case, id: string): Job {
  const j = load(c.file).jobs[id];
  expect(j, `${c.file} has no job ${id}`).toBeDefined();
  return j!;
}

function needs(j: Job): string[] {
  return j.needs === undefined ? [] : ([] as string[]).concat(j.needs);
}

/** Path lines of a multi-line `with.path` input. */
function pathLines(step: Step): string[] {
  return String(step.with?.path ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

describe.each(CASES)('$file hands its output to a separate push job', (c) => {
  it('the write job waits for the scan job', () => {
    expect(needs(job(c, c.writeJob))).toContain(c.scanJob);
  });

  it('the scan job uploads every pushed path, hidden ones included', () => {
    const uploads = (job(c, c.scanJob).steps ?? []).filter(
      (s) =>
        s.uses?.startsWith('actions/upload-artifact@') &&
        s.with?.name === c.artifact,
    );
    expect(uploads).toHaveLength(1);
    // upload-artifact v4+ skips dot-paths by default, and `.harness/` is one:
    // without this the artifact would silently lack the timeline.
    expect(uploads[0]!.with?.['include-hidden-files']).toBe(true);
    expect(uploads[0]!.with?.['if-no-files-found']).toBe('error');
    expect(pathLines(uploads[0]!).sort()).toEqual([...c.paths].sort());
  });

  it('the write job downloads outside the workspace', () => {
    const downloads = (job(c, c.writeJob).steps ?? []).filter((s) =>
      s.uses?.startsWith('actions/download-artifact@'),
    );
    expect(downloads).toHaveLength(1);
    expect(downloads[0]!.with?.name).toBe(c.artifact);
    // The artifact was written by the job that ran registry code. Extracting
    // it over the checkout would let it plant any file there, `.git/config`
    // included. It goes to runner.temp and only the named files are copied.
    expect(String(downloads[0]!.with?.path)).toMatch(/^\$\{\{\s*runner\.temp/);
  });

  it('the write job uses only checkout and download-artifact', () => {
    const actions = (job(c, c.writeJob).steps ?? [])
      .map((s) => s.uses)
      .filter((u): u is string => u !== undefined)
      .map((u) => u.split('@')[0]);
    expect(actions.sort()).toEqual([
      'actions/checkout',
      'actions/download-artifact',
    ]);
  });
});

describe('harness-security.yml ledger job', () => {
  const c = CASES[0]!;

  it('runs only on push to main, like the step it replaced', () => {
    expect(job(c, c.writeJob).if).toBe(
      "github.event_name == 'push' && github.ref == 'refs/heads/main'",
    );
    const upload = (job(c, c.scanJob).steps ?? []).find(
      (s) => s.with?.name === c.artifact,
    );
    expect(upload?.if).toBe(job(c, c.writeJob).if);
  });

  it('serialises the force-push to the standing branch', () => {
    expect(job(c, c.writeJob).concurrency).toEqual({
      group: 'ledger-chore/security-ledger',
      'cancel-in-progress': false,
    });
  });
});

describe.each(CASES)('$file push job, run against a real remote', (c) => {
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

  /** A clone of a bare origin with the pushed paths committed on main. */
  function setup(): { work: string; origin: string; src: string } {
    dir = mkdtempSync(join(tmpdir(), 'ledger-push-'));
    const origin = join(dir, 'origin.git');
    const work = join(dir, 'work');
    const src = join(dir, 'runner-temp', c.artifact);
    git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
    git(dir, 'clone', '-q', origin, work);
    git(work, 'checkout', '-q', '-b', 'main');
    for (const p of c.paths) {
      mkdirSync(dirname(join(work, p)), { recursive: true });
      writeFileSync(join(work, p), 'old\n');
    }
    for (const e of c.entries) {
      mkdirSync(dirname(join(src, e)), { recursive: true });
      writeFileSync(join(src, e), 'old\n');
    }
    git(work, 'add', '.');
    git(
      work,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.invalid',
      'commit',
      '-q',
      '-m',
      'seed',
    );
    git(work, 'push', '-q', 'origin', 'main');
    return { work, origin, src };
  }

  /** The runner env for one step, with `${{ runner.temp }}` substituted. */
  function stepEnv(step: Step, summary: string): Record<string, string> {
    const runnerTemp = join(dir!, 'runner-temp');
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      HOME: dir!,
      GIT_CONFIG_NOSYSTEM: '1',
      RUNNER_TEMP: runnerTemp,
      GITHUB_STEP_SUMMARY: summary,
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'o/r',
    };
    for (const [k, v] of Object.entries(step.env ?? {}))
      env[k] = v.replace(/\$\{\{\s*runner\.temp\s*\}\}/, runnerTemp);
    return env;
  }

  /** Run every `run:` step of the write job in order, as Actions would. */
  function runJob(work: string) {
    const summary = join(dir!, 'summary.md');
    const scripts = (job(c, c.writeJob).steps ?? []).filter(
      (s) => s.run !== undefined,
    );
    let last = { status: 0 as number | null, log: '' };
    for (const step of scripts) {
      const r = spawnSync('bash', ['-e', '-c', step.run!], {
        cwd: work,
        encoding: 'utf8',
        env: stepEnv(step, summary),
      });
      last = { status: r.status, log: `${r.stdout}${r.stderr}` };
      if (r.status !== 0) break;
    }
    const text = existsSync(summary) ? readFileSync(summary, 'utf8') : '';
    return { ...last, summary: text };
  }

  it('pushes the downloaded output to the standing branch', () => {
    const { work, origin, src } = setup();
    for (const e of c.entries) writeFileSync(join(src, e), 'new\n');
    const r = runJob(work);
    expect(r.status, r.log).toBe(0);
    for (const p of c.paths)
      expect(git(origin, 'show', `${c.branch}:${p}`)).toBe('new');
    expect(r.summary).toContain(`compare/main...${c.branch}`);
  });

  it('pushes nothing when the output is unchanged', () => {
    const { work, origin, src } = setup();
    const r = runJob(work);
    expect(r.status, r.log).toBe(0);
    expect(git(origin, 'branch', '--list', c.branch)).toBe('');
  });

  it('fails when the push is rejected (#548: no swallowed push)', () => {
    const { work, src } = setup();
    for (const e of c.entries) writeFileSync(join(src, e), 'new\n');
    git(work, 'remote', 'set-url', 'origin', join(dir!, 'missing.git'));
    const r = runJob(work);
    expect(r.status).not.toBe(0);
  });

  it('refuses a symlink in the artifact rather than copying its target', () => {
    const { work, origin, src } = setup();
    const secret = join(dir!, 'secret');
    writeFileSync(secret, 'token\n');
    rmSync(join(src, c.entries[0]!));
    symlinkSync(secret, join(src, c.entries[0]!));
    const r = runJob(work);
    expect(r.status).not.toBe(0);
    expect(r.log).toMatch(/not a regular file/);
    expect(git(origin, 'branch', '--list', c.branch)).toBe('');
  });

  it('fails when the artifact is missing a pushed path', () => {
    const { work, src } = setup();
    rmSync(join(src, c.entries[0]!));
    const r = runJob(work);
    expect(r.status).not.toBe(0);
  });
});
