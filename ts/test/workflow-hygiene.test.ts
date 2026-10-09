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

describe('#1237 workflow YAML is under the prettier gate', () => {
  const pkg = JSON.parse(
    readFileSync(join(REPO_ROOT, 'ts', 'package.json'), 'utf-8'),
  ) as { scripts: Record<string, string> };

  it('format:check covers .github/workflows/*.yml', () => {
    expect(pkg.scripts['format:check']).toContain(
      '"../.github/workflows/*.yml"',
    );
  });

  // The script runs from ts/, so the glob is relative to it. A glob that
  // matches nothing checks nothing, and that would be a zero denominator.
  it('the glob matches the workflow files', () => {
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
  const script = (job?.steps ?? []).map((s) => s.run ?? '').join('\n');

  it('has an actionlint job that pins an exact actionlint version', () => {
    expect(job).toBeDefined();
    expect(script).toMatch(/download-actionlint\.bash\)\s+1\.\d+\.\d+/);
    expect(script).toMatch(/actionlint\/v1\.\d+\.\d+\/scripts\//);
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
