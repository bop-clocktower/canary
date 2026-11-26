/**
 * Release and supply-chain invariants for every workflow (#1750, #1267).
 *
 * A harness-audit of `main` found five gaps. None had been exploited. Nothing
 * enforced any of them, so each one could come back in the next edit:
 *
 * - **Any `v*` tag published.** `release.yml` ran `npm publish --provenance`
 *   for a tag on any commit, merged or not. `publish` now refuses a commit that
 *   is not an ancestor of `origin/main`. The real step runs below against
 *   local git repos, including the shallow-clone case, which must fail and
 *   not skip.
 * - **Tag-pinned actions.** About 85 `uses:` lines named a movable tag. One of
 *   them ran in the job that can mint the npm trusted-publishing OIDC token,
 *   which is the tj-actions attack shape. Every remote action is now pinned to
 *   a full commit SHA with a `# vX.Y.Z` comment. Dependabot's github-actions
 *   entry reads that comment and keeps the pin current.
 * - **Unpinned `npx` tool.** `docs-lint.yml` ran `npx --yes markdownlint-cli`
 *   at whatever version the registry served that day.
 * - **No job timeouts.** 34 of 36 jobs fell back to GitHub's 360-minute
 *   default, so a hung registry fetch held a runner for six hours.
 * - **No `permissions:` block (#1267).** Four workflows ran with the
 *   repository's default token scope.
 *
 * Offline: the assertions read workflow YAML as data, plus the raw text where
 * YAML drops the comments. The ancestry block runs the step under bash
 * against temp repos.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { afterAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from './required-checks-testkit.js';

const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  shell?: string;
  'continue-on-error'?: unknown;
  if?: unknown;
  with?: Record<string, unknown>;
}
interface Job {
  uses?: string;
  'timeout-minutes'?: unknown;
  steps?: Step[];
}
interface Workflow {
  permissions?: unknown;
  jobs?: Record<string, Job>;
}

const FILES = readdirSync(WORKFLOW_DIR)
  .filter((f) => f.endsWith('.yml'))
  .sort();
const raw = (f: string) => readFileSync(join(WORKFLOW_DIR, f), 'utf-8');
const parsed = (f: string) => loadYaml(raw(f)) as Workflow;

describe('the workflow set (zero denominator is an abstention)', () => {
  it('finds the workflows', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(18);
  });
});

describe('#1267 every workflow declares top-level permissions', () => {
  it.each(FILES)('%s has a top-level permissions block', (f) => {
    expect(parsed(f).permissions, `${f}: add \`permissions:\``).toBeDefined();
  });

  // These four had no block. None of their steps writes to the repo, comments,
  // or calls the API: upload-artifact authenticates with the runtime token,
  // not GITHUB_TOKEN. So read is the whole grant, with no job widening it.
  it.each([
    'docs-lint.yml',
    'harness-quality.yml',
    'harness.yml',
    'validate-plugin.yml',
  ])('%s is read-only, and no job widens it', (f) => {
    const wf = parsed(f);
    expect(wf.permissions).toEqual({ contents: 'read' });
    const widened = Object.entries(wf.jobs ?? {})
      .filter(([, j]) => (j as { permissions?: unknown }).permissions)
      .map(([id]) => id);
    expect(widened).toEqual([]);
  });
});

/** Every `uses:` line in a file, with its trailing comment (YAML drops it). */
function usesLines(
  f: string,
): { line: number; ref: string; comment: string }[] {
  return raw(f)
    .split('\n')
    .flatMap((text, i) => {
      const m =
        /^\s*(?:-\s+)?uses:\s*['"]?([^\s'"#]+)['"]?\s*(?:#\s*(.*))?$/.exec(
          text,
        );
      return m
        ? [{ line: i + 1, ref: m[1]!, comment: (m[2] ?? '').trim() }]
        : [];
    });
}

const SHA_PINNED = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/;
const VERSION_COMMENT = /^v\d+\.\d+\.\d+$/;

describe('#1750 every remote action is pinned to a commit SHA', () => {
  const all = FILES.flatMap((f) =>
    usesLines(f).map((u) => ({ ...u, where: `${f}:${u.line}` })),
  );
  const remote = all.filter(
    (u) => !u.ref.startsWith('./') && !u.ref.startsWith('docker://'),
  );

  it.each([
    ['actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', true],
    ['actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9', true],
    ['actions/checkout@v7', false],
    ['actions/checkout@v7.0.1', false],
    ['actions/checkout@3d3c42e', false],
    ['actions/checkout@main', false],
  ])('the pin detector classifies %s as pinned=%s', (ref, pinned) => {
    expect(SHA_PINNED.test(ref)).toBe(pinned);
  });

  // The raw-line scan must agree with the YAML parse, or a `uses:` written in a
  // shape the regex misses would sit outside every assertion below.
  it('the line scan sees every uses: the YAML parser sees', () => {
    const fromYaml = FILES.flatMap((f) =>
      Object.values(parsed(f).jobs ?? {}).flatMap((j) => [
        ...(j.uses ? [j.uses] : []),
        ...(j.steps ?? []).flatMap((s) => (s.uses ? [s.uses] : [])),
      ]),
    );
    expect(remote.length).toBeGreaterThanOrEqual(80);
    expect(all.map((u) => u.ref).sort()).toEqual(fromYaml.sort());
  });

  it('pins every remote action to a full 40-hex commit SHA', () => {
    expect(
      remote.filter((u) => !SHA_PINNED.test(u.ref)).map((u) => u.where),
      'pin to the tag commit: `uses: owner/repo@<40-hex> # vX.Y.Z`',
    ).toEqual([]);
  });

  // Dependabot rewrites the comment along with the SHA only when the comment
  // names the version. Without it, the pin is unreadable and drifts.
  it('names the pinned release in a # vX.Y.Z comment', () => {
    expect(
      remote
        .filter((u) => !VERSION_COMMENT.test(u.comment))
        .map((u) => `${u.where} (${u.comment || 'no comment'})`),
    ).toEqual([]);
  });

  it('pins each action repo to one SHA and one version everywhere', () => {
    const seen = new Map<string, Set<string>>();
    for (const u of remote) {
      const [path, sha] = u.ref.split('@') as [string, string];
      const repo = path.split('/').slice(0, 2).join('/');
      const pins = seen.get(repo) ?? new Set<string>();
      pins.add(`${sha} ${u.comment}`);
      seen.set(repo, pins);
    }
    const split = [...seen].filter(([, s]) => s.size > 1).map(([r]) => r);
    expect(split).toEqual([]);
  });

  it('dependabot keeps the pins current', () => {
    const cfg = loadYaml(
      readFileSync(join(REPO_ROOT, '.github', 'dependabot.yml'), 'utf-8'),
    ) as { updates: { 'package-ecosystem': string; directory: string }[] };
    expect(
      cfg.updates.some(
        (u) =>
          u['package-ecosystem'] === 'github-actions' && u.directory === '/',
      ),
    ).toBe(true);
  });
});

describe('#1750 every job has a timeout', () => {
  const jobs = FILES.flatMap((f) =>
    Object.entries(parsed(f).jobs ?? {}).map(([id, j]) => ({
      where: `${f} job ${id}`,
      job: j,
    })),
  );

  it('finds the jobs', () => {
    expect(jobs.length).toBeGreaterThanOrEqual(36);
  });

  // A reusable-workflow call (`jobs.<id>.uses`) cannot take timeout-minutes;
  // the called workflow's own jobs carry it. There are none today.
  // 360 is GitHub's default, so a value at or above it bounds nothing.
  it('sets timeout-minutes to a whole number of minutes below 360', () => {
    const bad = jobs
      .filter(({ job }) => job.uses === undefined)
      .filter(({ job }) => {
        const t = job['timeout-minutes'];
        return !(
          Number.isInteger(t) &&
          (t as number) > 0 &&
          (t as number) < 360
        );
      })
      .map(({ where, job }) => `${where}: ${String(job['timeout-minutes'])}`);
    expect(bad).toEqual([]);
  });
});

describe('#1750 docs-lint runs an exact markdownlint-cli version', () => {
  const runs = Object.values(parsed('docs-lint.yml').jobs ?? {})
    .flatMap((j) => j.steps ?? [])
    .map((s) => s.run ?? '')
    .filter((r) => /markdownlint-cli/.test(r));

  it('invokes markdownlint-cli, pinned to x.y.z', () => {
    expect(runs.length).toBe(1);
    expect(runs[0]).toMatch(/\bmarkdownlint-cli@\d+\.\d+\.\d+\s/);
  });
});

describe('#1750 release.yml publishes only commits that are on main', () => {
  const wf = parsed('release.yml');
  const steps = wf.jobs?.publish?.steps ?? [];
  const gateAt = steps.findIndex((s) =>
    /git merge-base --is-ancestor\b/.test(s.run ?? ''),
  );
  const gate = steps[gateAt];

  it('runs the ancestry check as the step right after checkout', () => {
    expect(gateAt).toBe(1);
    expect(steps[0]?.uses).toMatch(/^actions\/checkout@/);
  });

  // A shallow checkout cannot prove ancestry. The step refuses one, and full
  // history is what keeps that refusal from firing on every release.
  it('checks out full history', () => {
    expect(steps[0]?.with?.['fetch-depth']).toBe(0);
  });

  it('cannot fail soft or be skipped', () => {
    expect(gate?.['continue-on-error']).toBeUndefined();
    expect(gate?.if).toBeUndefined();
    expect(gate?.shell).toBe('bash');
  });

  it('sits ahead of every install, build, and publish step', () => {
    const first = steps.findIndex(
      (s, i) => i > 0 && (s.uses !== undefined || /\bnpm\b/.test(s.run ?? '')),
    );
    expect(first).toBeGreaterThan(gateAt);
  });

  describe('the real step body', () => {
    const root = mkdtempSync(join(tmpdir(), 'release-ancestry-'));
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    const git = (cwd: string, ...args: string[]) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
      return r.stdout.trim();
    };
    const ident = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid'];

    // origin: main has two commits; `side` forks off the first and is never
    // merged. That is the "tag an unmerged commit" case the issue describes.
    const origin = join(root, 'origin');
    git(root, 'init', '-q', '-b', 'main', origin);
    git(origin, ...ident, 'commit', '-q', '--allow-empty', '-m', 'base');
    const base = git(origin, 'rev-parse', 'HEAD');
    git(origin, ...ident, 'commit', '-q', '--allow-empty', '-m', 'tip');
    const tip = git(origin, 'rev-parse', 'HEAD');
    git(origin, 'checkout', '-q', '-b', 'side', base);
    git(origin, ...ident, 'commit', '-q', '--allow-empty', '-m', 'unmerged');
    const unmerged = git(origin, 'rev-parse', 'HEAD');
    git(origin, 'checkout', '-q', 'main');

    const full = join(root, 'full');
    git(root, 'clone', '-q', `file://${origin}`, full);
    const shallow = join(root, 'shallow');
    git(root, 'clone', '-q', '--depth', '1', `file://${origin}`, shallow);

    // `shell: bash` runs `bash --noprofile --norc -eo pipefail {0}`.
    const run = (cwd: string, sha: string) => {
      const r = spawnSync(
        'bash',
        [
          '--noprofile',
          '--norc',
          '-eo',
          'pipefail',
          '-c',
          gate?.run ?? 'exit 99',
        ],
        {
          cwd,
          encoding: 'utf-8',
          env: {
            PATH: process.env.PATH ?? '',
            HOME: root,
            GITHUB_SHA: sha,
            GITHUB_REF_NAME: 'v0.0.1',
          },
        },
      );
      return { status: r.status, out: `${r.stdout}${r.stderr}` };
    };

    it('passes a tag on main, at the tip or behind it', () => {
      expect(run(full, tip).status).toBe(0);
      expect(run(full, base).status).toBe(0);
    });

    it('fails a tag on a commit that never reached main', () => {
      const r = run(full, unmerged);
      expect(r.status).not.toBe(0);
      expect(r.out).toMatch(/::error::.*not on main/);
    });

    it('fails, never skips, in a shallow checkout', () => {
      const r = run(shallow, tip);
      expect(r.status).not.toBe(0);
      expect(r.out).toMatch(/::error::.*shallow/);
    });

    it('fails when GITHUB_SHA is empty or not a commit', () => {
      expect(run(full, '').status).not.toBe(0);
      expect(run(full, 'f'.repeat(40)).status).not.toBe(0);
    });
  });
});

// verify-bins polls the registry ATTEMPTS x 30 s before it abstains (#1331).
// A timeout inside that window would kill the job before it could report
// "NOT verified", which turns a readable exit 3 into a bare cancellation.
describe('#1750 verify-bins outlasts its own registry poll', () => {
  const job = parsed('release.yml').jobs?.['verify-bins'];
  const script = (job?.steps ?? []).map((s) => s.run ?? '').join('\n');
  const attempts = Number(/\bATTEMPTS=(\d+)/.exec(script)?.[1]);
  const gap = Number(/\bsleep (\d+)/.exec(script)?.[1]);

  it('has a timeout above the poll window plus a few minutes of setup', () => {
    expect(attempts).toBeGreaterThan(0);
    expect(gap).toBeGreaterThan(0);
    const windowMinutes = ((attempts - 1) * gap) / 60;
    expect(Number(job?.['timeout-minutes'])).toBeGreaterThanOrEqual(
      Math.ceil(windowMinutes) + 5,
    );
  });
});
