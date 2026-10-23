/**
 * Workflow-file hygiene guards (#1236, #1237, #1238).
 *
 * Each of these defects was found in a workflow by hand, after it had already
 * shipped. These tests pin the fix so that the next edit cannot silently undo
 * it:
 *
 * - #1236: `harness-architecture.yml` ran with the repository's default token
 *   scope, because it declared no `permissions:` block.
 * - #1237: `batwoman.yml` drifted out of prettier format, because no check
 *   covered workflow YAML.
 * - #1238: shellcheck findings piled up in `run:` scripts, because nothing ran
 *   actionlint. The `$*_BASE_FLAG` expansions are deliberately unquoted, so
 *   this file also guards them against a well-meant "fix" that quotes them.
 * - #1427: `harness-security.yml` force-pushed its ledger branch with no
 *   `concurrency:` group, so overlapping runs silently lost a write.
 *   `release-advance-latest.test.ts` covers the `latest` tag's ordering.
 *
 * Offline: every assertion reads the YAML or JSON as data.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { advisoryEntries, REPO_ROOT } from './required-checks-testkit.js';

const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');

interface Step {
  run?: string;
  env?: Record<string, string>;
}
interface Concurrency {
  group?: string;
  'cancel-in-progress'?: unknown;
}
interface Job {
  permissions?: unknown;
  concurrency?: string | Concurrency;
  steps?: Step[];
}
interface Workflow {
  permissions?: unknown;
  concurrency?: string | Concurrency;
  jobs?: Record<string, Job>;
}

function workflow(file: string): Workflow {
  return loadYaml(readFileSync(join(WORKFLOW_DIR, file), 'utf-8')) as Workflow;
}

describe('#1236 harness-architecture.yml is least-privilege', () => {
  const wf = workflow('harness-architecture.yml');

  it('declares top-level permissions of exactly contents: read', () => {
    expect(wf.permissions).toEqual({ contents: 'read' });
  });

  it('has no job that widens the token', () => {
    const widened = Object.entries(wf.jobs ?? {})
      .filter(([, job]) => job.permissions !== undefined)
      .map(([id]) => id);
    expect(widened).toEqual([]);
  });
});

/**
 * The `contents` scope a permissions block grants, or undefined when the block
 * is absent. An object form grants `none` for every scope it does not name.
 */
function contentsScope(perms: unknown): string | undefined {
  if (perms === undefined) return undefined;
  if (perms === 'write-all') return 'write';
  if (perms === 'read-all') return 'read';
  if (perms && typeof perms === 'object')
    return (perms as Record<string, string>).contents ?? 'none';
  return 'none';
}

/**
 * The `contents` scope a job actually runs with. A job with no block inherits
 * the workflow's; a workflow with none gets the repository default, which may
 * be write, so an undeclared scope counts as write.
 */
function effectiveContents(wf: Workflow, job: Job): string {
  return (
    contentsScope(job.permissions) ?? contentsScope(wf.permissions) ?? 'write'
  );
}

/**
 * Launchers that resolve and run package code, or run repo scripts that may
 * import it: `npx`, `npm exec|ci|i|install|run`, `pnpm|yarn dlx`, `bunx`,
 * and `node <script>`. A blocklist, so it is paired with the action allowlist
 * in `ledger-push-jobs.test.ts`.
 */
const REGISTRY_CODE =
  /(?:^|[\s;&|(])(?:(?:npx|bunx|npm\s+(?:exec|ci|i|install|run)|(?:pnpm|yarn)\s+dlx)\b|node\s+\S)/m;

/** Whether a job runs registry code. */
function runsRegistryCode(job: Job): boolean {
  return (job.steps ?? []).some((s) => REGISTRY_CODE.test(s.run ?? ''));
}

describe('#1426 the registry-code detector', () => {
  it.each([
    'npx --yes -p x harness validate',
    'npm exec x',
    'npm ci',
    'npm run build',
    'pnpm dlx x',
    'yarn dlx x',
    'bunx x',
    'node scripts/security_ledger.mjs',
    'set -e; npx x',
  ])('flags %s', (run) => {
    expect(runsRegistryCode({ steps: [{ run }] })).toBe(true);
  });

  it.each(['git push --force origin "HEAD:$BRANCH"', 'cp -- "$SRC/$f" "$f"'])(
    'does not flag %s',
    (run) => {
      expect(runsRegistryCode({ steps: [{ run }] })).toBe(false);
    },
  );
});

/**
 * #1426 (CWE-250 / CWE-272). `harness-security.yml` and `arch-snapshot.yml`
 * granted `contents: write` to the whole workflow, so `npx` resolved a
 * floating `@harness-engineering/cli@13` and ran it while `actions/checkout`
 * held a write token in `.git/config`. Only the final push needed write.
 *
 * A top-level `contents: write` hands that scope to every job, including ones
 * added later. It is allowed only where the workflow's whole purpose is a
 * write, and each such exception carries its reason here.
 *
 * `release.yml` was on this list until #1439 split bin verification into its
 * own job and moved `contents: write` down to the jobs that publish. Keeping
 * it off the list is what proves the narrowing holds.
 */
const TOP_LEVEL_WRITE_ALLOWLIST: Record<string, string> = {
  'wiki-sync.yml':
    'Its one job exists to push docs/wiki to the GitHub Wiki on push to main, ' +
    'and it runs no registry code (no npx / npm exec).',
};

describe('#1426 a top-level contents: write is an explicit exception', () => {
  const all = readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith('.yml'))
    .sort()
    .map((f): [string, Workflow] => [f, workflow(f)]);
  const topLevelWriters = all
    .filter(([, wf]) => contentsScope(wf.permissions) === 'write')
    .map(([f]) => f);

  it('finds workflows to check (zero denominator is an abstention)', () => {
    expect(all.length).toBeGreaterThan(0);
  });

  it('grants top-level contents: write only to allowlisted workflows', () => {
    expect(
      topLevelWriters.filter((f) => !(f in TOP_LEVEL_WRITE_ALLOWLIST)),
      'move contents: write onto the one job that pushes, or allowlist it with a reason',
    ).toEqual([]);
  });

  it.each(Object.keys(TOP_LEVEL_WRITE_ALLOWLIST))(
    'allowlist entry %s still needs it and states why',
    (file) => {
      expect(topLevelWriters).toContain(file);
      expect(TOP_LEVEL_WRITE_ALLOWLIST[file]!.length).toBeGreaterThan(40);
    },
  );
});

describe.each(['harness-security.yml', 'arch-snapshot.yml'])(
  '#1426 %s runs no registry code under a write token',
  (file) => {
    const wf = workflow(file);
    const jobs = Object.entries(wf.jobs ?? {});
    const writers = jobs.filter(
      ([, job]) => effectiveContents(wf, job) === 'write',
    );

    it('declares top-level permissions of exactly contents: read', () => {
      expect(wf.permissions).toEqual({ contents: 'read' });
    });

    // Denominators for the assertion below: the npx still runs somewhere,
    // and the push still happens somewhere.
    it('still runs npx in some job, and still pushes from some job', () => {
      expect(jobs.some(([, job]) => runsRegistryCode(job))).toBe(true);
      expect(
        writers.some(([, job]) =>
          (job.steps ?? []).some((s) => /\bgit push\b/.test(s.run ?? '')),
        ),
      ).toBe(true);
    });

    it('runs npx in no job that holds contents: write', () => {
      expect(
        writers.filter(([, job]) => runsRegistryCode(job)).map(([id]) => id),
      ).toEqual([]);
    });

    it('limits each write job to contents: write and nothing else', () => {
      for (const [, job] of writers)
        expect(job.permissions).toEqual({ contents: 'write' });
    });
  },
);

describe('#1237 workflow YAML is under the prettier gate', () => {
  const pkg = JSON.parse(
    readFileSync(join(REPO_ROOT, 'ts', 'package.json'), 'utf-8'),
  ) as { scripts: Record<string, string> };

  it('format:check covers .github/workflows/*.yml', () => {
    expect(pkg.scripts['format:check']).toContain(
      '"../.github/workflows/*.yml"',
    );
  });

  // The glob names `.yml` only. A `.yaml` workflow would sit outside the gate
  // with nothing reporting the gap. (Prettier itself errors on a glob that
  // matches nothing, so the zero-file case is already loud.)
  it('workflows use the .yml extension the glob covers', () => {
    const files = readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith('.yml'));
    expect(files.length).toBeGreaterThan(0);
    expect(readdirSync(WORKFLOW_DIR).some((f) => f.endsWith('.yaml'))).toBe(
      false,
    );
  });
});

describe('#1238 actionlint runs in CI', () => {
  const wf = workflow('workflow-lint.yml');
  const job = wf.jobs?.actionlint;
  const install = (job?.steps ?? []).find(
    (s) => s.env?.ACTIONLINT_VERSION !== undefined,
  );

  // An unpinned version turns the job red whenever upstream adds a rule. An
  // unverified tarball trusts a git tag that can be moved.
  it('pins an exact actionlint version and verifies its SHA-256', () => {
    expect(job).toBeDefined();
    expect(install?.env?.ACTIONLINT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(install?.env?.ACTIONLINT_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(install?.run).toContain('sha256sum -c');
    expect(install?.run).toMatch(
      /releases\/download\/v\$\{ACTIONLINT_VERSION\}/,
    );
  });

  it('runs read-only', () => {
    expect(wf.permissions).toEqual({ contents: 'read' });
  });

  it('is declared advisory in required-checks.json, with a reason', () => {
    const entry = advisoryEntries().find((e) => e.check === 'actionlint');
    expect(entry?.workflow).toBe('workflow-lint.yml');
    expect(entry?.reason.length ?? 0).toBeGreaterThan(20);
  });
});

describe('#1238 the *_BASE_FLAG expansions stay unquoted', () => {
  // Each flag holds zero or four arguments. Quoting it would fuse four
  // arguments into one on a PR, and pass an empty "" argument on push.
  const steps = Object.values(workflow('harness-quality.yml').jobs ?? {})
    .flatMap((j) => j.steps ?? [])
    .filter((s) => s.run);

  it.each(['DOCS_BASE_FLAG', 'BASE_FLAG', 'PERF_BASE_FLAG'])(
    '%s is expanded bare, with a scoped SC2086 directive',
    (name) => {
      const step = steps.find((s) => s.env?.[name] !== undefined);
      expect(step, `no step sets ${name}`).toBeDefined();
      expect(step!.run).toMatch(new RegExp(`\\s\\$${name}\\b`));
      expect(step!.run).not.toContain(`"$${name}"`);
      expect(step!.run).toMatch(/# shellcheck disable=SC2086/);
    },
  );
});

describe('#1427 a workflow that force-pushes declares a concurrency group', () => {
  // A force push is last-writer-wins. Two overlapping runs that force-update
  // the same ref lose one run's write, and nothing goes red. A `concurrency:`
  // group (workflow-level, or on the pushing job) makes them queue instead.
  // `cancel-in-progress: true` would not help: it kills the earlier run,
  // which drops the same write by a different route.
  const FORCE_PUSH =
    /\bgit\s+push\b[^\n]*?(?:\s--force(?:-with-lease)?\b|\s-f\b|\s\+[^\s]+)/;

  it.each([
    ['git push --force origin "HEAD:$BRANCH"', true],
    ['git push origin latest --force', true],
    ['git push --force-with-lease origin HEAD:x', true],
    ['git push -f origin HEAD:x', true],
    ['git push origin +HEAD:x', true],
    ['git push origin "HEAD:$BRANCH"', false],
    ['git push origin HEAD:master', false],
    ['git push --follow-tags origin main', false],
  ])('the detector classifies %s as force=%s', (line, force) => {
    expect(FORCE_PUSH.test(line)).toBe(force);
  });

  const forcePushers = readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith('.yml'))
    .flatMap((file) => {
      const wf = workflow(file);
      return Object.entries(wf.jobs ?? {})
        .filter(([, job]) =>
          (job.steps ?? []).some((s) => s.run && FORCE_PUSH.test(s.run)),
        )
        .map(([id, job]) => ({
          where: `${file} job ${id}`,
          concurrency: job.concurrency ?? wf.concurrency,
        }));
    });

  // A zero denominator would make the next test pass vacuously, e.g. after a
  // detector regression. These three are known force-pushers. Since #1426 the
  // push lives in a write job apart from the scan.
  it('finds the known force-pushing workflows', () => {
    const wheres = forcePushers.map((p) => p.where);
    expect(wheres).toContain('arch-snapshot.yml job push');
    expect(wheres).toContain('harness-security.yml job ledger');
    expect(wheres).toContain('release.yml job advance-latest');
  });

  // `security` is a required check. It no longer pushes (#1426 moved that to
  // `ledger`, which holds the ledger group), so a group on it only queues or
  // supersedes required-check runs. A static group there would make PR runs
  // wait behind `main` or be cancelled as superseded pending runs.
  it('the required security job carries no concurrency group', () => {
    const wf = workflow('harness-security.yml');
    expect(wf.concurrency).toBeUndefined();
    expect(wf.jobs?.security?.concurrency).toBeUndefined();
  });

  it('every force-pushing job is under a non-cancelling concurrency group', () => {
    const bad = forcePushers
      .filter(({ concurrency }) => {
        if (concurrency === undefined) return true;
        if (typeof concurrency === 'string') return concurrency.length === 0;
        return !concurrency.group || concurrency['cancel-in-progress'] === true;
      })
      .map((p) => p.where);
    expect(bad).toEqual([]);
  });
});
