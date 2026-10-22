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
interface Job {
  permissions?: unknown;
  steps?: Step[];
}
interface Workflow {
  permissions?: unknown;
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

/** Whether a job runs registry code: `npx` / `npm exec` resolve and execute it. */
function runsRegistryCode(job: Job): boolean {
  return (job.steps ?? []).some((s) =>
    /(?:^|[\s;&|(])(?:npx|npm\s+exec)\b/m.test(s.run ?? ''),
  );
}

/**
 * #1426 (CWE-250 / CWE-272). `harness-security.yml` and `arch-snapshot.yml`
 * granted `contents: write` to the whole workflow, so `npx` resolved a
 * floating `@harness-engineering/cli@13` and ran it while `actions/checkout`
 * held a write token in `.git/config`. Only the final push needed write.
 *
 * A top-level `contents: write` hands that scope to every job, including ones
 * added later. It is allowed only where the workflow's whole purpose is a
 * write, and each such exception carries its reason here.
 */
const TOP_LEVEL_WRITE_ALLOWLIST: Record<string, string> = {
  'release.yml':
    'Tag-triggered publish: creates the GitHub Release and uploads its assets. ' +
    'Runs only on a v* tag a maintainer pushes, never on a PR. Narrowing it ' +
    'to job level is worth doing but is not part of #1426.',
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
