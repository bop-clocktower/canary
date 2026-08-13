/**
 * CLI-level tests for `canary migrate` -- ports of
 * `tests/unit/test_migrate_cli.py` (overlay resolution: --from name/path, the
 * single-overlay default, multi-overlay ambiguity, --overlay deprecation,
 * --from beats --overlay, the skills/docs-overlay refusal) and
 * `tests/unit/test_migrate_check_cli.py` (the --check freshness gate: in-sync 0,
 * drift 1, local-edit 2, and the --json summary).
 *
 * These drive the REAL ported `HarnessMigrator` + overlays; the Python tests
 * `patch(Path.home)`, which maps to injecting `deps.home()` here.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { HarnessMigrator } from '../src/core/migrator.js';
import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

function fakeHarnessProject(
  root: string,
  config = '{"framework": "vitest"}',
): void {
  writeFileSync(join(root, 'harness.config.json'), config, 'utf-8');
  mkdirSync(join(root, '.harness'));
}

function addOverlay(home: string, name: string): string {
  const skills = join(
    home,
    '.canary',
    'overlays',
    name,
    '.canary',
    'skills',
    'demo-skill',
  );
  mkdirSync(skills, { recursive: true });
  writeFileSync(
    join(skills, 'SKILL.md'),
    '---\nname: demo-skill\ndeploy_to: [all]\n---\n\n# demo-skill\n',
    'utf-8',
  );
  return join(home, '.canary', 'overlays', name);
}

function overlaySkill(
  base: string,
  dirName = 'demo',
  body = '# demo v1',
): string {
  const overlay = join(base, 'overlay');
  const skillDir = join(overlay, '.canary', 'skills', dirName);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${dirName}\ndeploy_to: [all]\n---\n\n${body}\n`,
    'utf-8',
  );
  return overlay;
}

/** `migrate` with an injected temp home (Python's `patch(Path.home)`). */
function run(project: string, home: string, ...args: string[]) {
  return invokeCanary(['migrate', '--path', project, ...args], {
    deps: { home: () => home },
  });
}

describe('canary migrate -- overlay resolution', () => {
  it('resolves --from by name and migrates', async () => {
    const base = mkTmp();
    try {
      const project = join(base, 'proj');
      const home = join(base, 'home');
      mkdirSync(project);
      fakeHarnessProject(project);
      addOverlay(home, 'example-org-example-overlay');
      const res = await run(
        project,
        home,
        '--from',
        'example-org-example-overlay',
      );
      expect(res.code).toBe(0);
    } finally {
      rmTmp(base);
    }
  });

  it('uses a --from path directly', async () => {
    const base = mkTmp();
    try {
      const project = join(base, 'proj');
      const home = join(base, 'home');
      mkdirSync(project);
      fakeHarnessProject(project);
      const overlay = join(base, 'sibling-overlay');
      mkdirSync(join(overlay, '.canary', 'skills'), { recursive: true });
      const res = await run(project, home, '--from', overlay);
      expect(res.code).toBe(0);
    } finally {
      rmTmp(base);
    }
  });

  it('defaults to the single tracked overlay', async () => {
    const base = mkTmp();
    try {
      const project = join(base, 'proj');
      const home = join(base, 'home');
      mkdirSync(project);
      fakeHarnessProject(project);
      addOverlay(home, 'solo-overlay');
      const res = await run(project, home);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('solo-overlay');
      expect(res.stdout).toContain('only one registered');
    } finally {
      rmTmp(base);
    }
  });

  it('is unchanged when no overlays are tracked', async () => {
    const base = mkTmp();
    try {
      const project = join(base, 'proj');
      const home = join(base, 'home');
      mkdirSync(project);
      fakeHarnessProject(project);
      mkdirSync(join(home, '.canary'), { recursive: true });
      const res = await run(project, home);
      expect(res.code).toBe(0);
      expect(res.stdout.toLowerCase()).not.toContain('tracked overlay');
    } finally {
      rmTmp(base);
    }
  });

  it('errors on multiple overlays without --from', async () => {
    const base = mkTmp();
    try {
      const project = join(base, 'proj');
      const home = join(base, 'home');
      mkdirSync(project);
      fakeHarnessProject(project);
      addOverlay(home, 'alpha-overlay');
      addOverlay(home, 'beta-overlay');
      const res = await run(project, home);
      expect(res.code).not.toBe(0);
      expect(res.stdout).toContain('alpha-overlay');
      expect(res.stdout).toContain('beta-overlay');
      expect(res.stdout).toContain('--from');
    } finally {
      rmTmp(base);
    }
  });

  it('prints a deprecation for --overlay', async () => {
    const base = mkTmp();
    try {
      const project = join(base, 'proj');
      const home = join(base, 'home');
      mkdirSync(project);
      fakeHarnessProject(project);
      const overlay = addOverlay(home, 'legacy-overlay');
      const res = await run(project, home, '--overlay', overlay);
      expect(res.code).toBe(0);
      expect(res.stdout.toLowerCase()).toContain('deprecated');
    } finally {
      rmTmp(base);
    }
  });

  it('lets --from beat --overlay', async () => {
    const base = mkTmp();
    try {
      const project = join(base, 'proj');
      const home = join(base, 'home');
      mkdirSync(project);
      fakeHarnessProject(project);
      addOverlay(home, 'chosen-overlay');
      const other = addOverlay(home, 'ignored-overlay');
      const res = await run(
        project,
        home,
        '--from',
        'chosen-overlay',
        '--overlay',
        other,
      );
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('ignoring --overlay');
    } finally {
      rmTmp(base);
    }
  });

  it('exits with the available list on an unresolvable --from', async () => {
    const base = mkTmp();
    try {
      const project = join(base, 'proj');
      const home = join(base, 'home');
      mkdirSync(project);
      fakeHarnessProject(project);
      addOverlay(home, 'real-overlay');
      const res = await run(project, home, '--from', 'typo-overlay');
      expect(res.code).not.toBe(0);
      expect(res.stdout).toContain('typo-overlay');
      expect(res.stdout).toContain('real-overlay');
    } finally {
      rmTmp(base);
    }
  });

  it('refuses a skills/docs overlay repo with a distinct message', async () => {
    const base = mkTmp();
    try {
      const project = join(base, 'proj');
      const home = join(base, 'home');
      mkdirSync(project);
      writeFileSync(
        join(project, 'harness.config.json'),
        '{"entryPoints": [], "layers": [{"name": "skills"}, {"name": "docs"}]}',
        'utf-8',
      );
      mkdirSync(join(project, '.harness'));
      const res = await run(project, home);
      expect(res.code).not.toBe(0);
      expect(res.stdout.toLowerCase()).toContain('overlay');
      expect(res.stdout).not.toContain('No harness project detected');
    } finally {
      rmTmp(base);
    }
  });
});

describe('canary migrate --check', () => {
  it('exits 0 when in sync', async () => {
    const base = mkTmp();
    try {
      const project = join(base, 'proj');
      const home = join(base, 'home');
      mkdirSync(project);
      mkdirSync(home);
      fakeHarnessProject(project, '{"language": "python"}');
      const overlay = overlaySkill(base);
      new HarnessMigrator().migrate(project, {
        dryRun: false,
        overlayPath: overlay,
      });
      const res = await run(project, home, '--from', overlay, '--check');
      expect(res.code).toBe(0);
    } finally {
      rmTmp(base);
    }
  });

  it('exits 1 on drift', async () => {
    const base = mkTmp();
    try {
      const project = join(base, 'proj');
      const home = join(base, 'home');
      mkdirSync(project);
      mkdirSync(home);
      fakeHarnessProject(project, '{"language": "python"}');
      const overlay = overlaySkill(base); // never deployed -> missing -> drift
      const res = await run(project, home, '--from', overlay, '--check');
      expect(res.code).toBe(1);
      expect(res.stdout).toContain('demo');
    } finally {
      rmTmp(base);
    }
  });

  it('exits 2 on a local edit', async () => {
    const base = mkTmp();
    try {
      const project = join(base, 'proj');
      const home = join(base, 'home');
      mkdirSync(project);
      mkdirSync(home);
      fakeHarnessProject(project, '{"language": "python"}');
      const overlay = overlaySkill(base);
      new HarnessMigrator().migrate(project, {
        dryRun: false,
        overlayPath: overlay,
      });
      writeFileSync(
        join(project, '.canary', 'skills', 'demo', 'SKILL.md'),
        '---\nname: demo\ndeploy_to: [all]\n---\n\n# demo -- edited\n',
        'utf-8',
      );
      const res = await run(project, home, '--from', overlay, '--check');
      expect(res.code).toBe(2);
      expect(res.stdout.toLowerCase()).toContain('local');
    } finally {
      rmTmp(base);
    }
  });

  it('emits a machine-readable --json summary', async () => {
    const base = mkTmp();
    try {
      const project = join(base, 'proj');
      const home = join(base, 'home');
      mkdirSync(project);
      mkdirSync(home);
      fakeHarnessProject(project, '{"language": "python"}');
      const overlay = overlaySkill(base);
      const res = await run(
        project,
        home,
        '--from',
        overlay,
        '--check',
        '--json',
      );
      expect(res.code).toBe(1);
      const payload = JSON.parse(
        res.stdout.slice(
          res.stdout.indexOf('{'),
          res.stdout.lastIndexOf('}') + 1,
        ),
      );
      expect(payload).toHaveProperty('has_drift');
      expect(payload.has_drift).toBe(true);
      expect(payload.skills[0].status).toBe('missing');
    } finally {
      rmTmp(base);
    }
  });
});

// --- workflow install (#459) -------------------------------------------------

const WORKFLOW_YML = 'name: guardian\non: pull_request\njobs: {}\n';

/** An overlay whose skill declares a workflow template to install. */
function overlayWithWorkflow(base: string): string {
  const overlay = join(base, 'overlay');
  const skillDir = join(overlay, '.canary', 'skills', 'guardian');
  mkdirSync(join(skillDir, 'templates'), { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    '---\nname: guardian\ndeploy_to: [all]\n' +
      'install_workflows: [templates/canary-guardian.yml]\n' +
      'workflow_template_version: 1\n---\n\n# guardian\n',
    'utf-8',
  );
  writeFileSync(
    join(skillDir, 'templates', 'canary-guardian.yml'),
    WORKFLOW_YML,
    'utf-8',
  );
  return overlay;
}

describe('canary migrate -- workflow install', () => {
  it('--apply installs the declared workflow', async () => {
    const base = mkTmp();
    try {
      const project = join(base, 'proj');
      const home = join(base, 'home');
      mkdirSync(project);
      mkdirSync(home);
      fakeHarnessProject(project, '{"language": "python"}');
      const overlay = overlayWithWorkflow(base);
      const res = await run(project, home, '--from', overlay, '--apply');
      expect(res.code).toBe(0);
      expect(
        readFileSync(
          join(project, '.github', 'workflows', 'canary-guardian.yml'),
          'utf-8',
        ),
      ).toBe(WORKFLOW_YML);
    } finally {
      rmTmp(base);
    }
  });

  // The CLI must not offer a path that silently replaces a consumer's CI: the
  // default run reports the difference and leaves the file byte-identical.
  it('leaves a differing workflow alone, and replaces it only with --force', async () => {
    const base = mkTmp();
    try {
      const project = join(base, 'proj');
      const home = join(base, 'home');
      mkdirSync(project);
      mkdirSync(home);
      fakeHarnessProject(project, '{"language": "python"}');
      const overlay = overlayWithWorkflow(base);
      const dest = join(project, '.github', 'workflows');
      mkdirSync(dest, { recursive: true });
      const mine = 'name: mine\non: [push]\njobs: {}\n';
      writeFileSync(join(dest, 'canary-guardian.yml'), mine, 'utf-8');

      const reported = await run(project, home, '--from', overlay, '--apply');
      expect(readFileSync(join(dest, 'canary-guardian.yml'), 'utf-8')).toBe(
        mine,
      );
      expect(reported.stdout).toContain('canary-guardian.yml');
      expect(reported.stdout).toContain('--force');

      const forced = await run(
        project,
        home,
        '--from',
        overlay,
        '--apply',
        '--force',
      );
      expect(forced.code).toBe(0);
      expect(readFileSync(join(dest, 'canary-guardian.yml'), 'utf-8')).toBe(
        WORKFLOW_YML,
      );
    } finally {
      rmTmp(base);
    }
  });

  it('--json lists installed workflows', async () => {
    const base = mkTmp();
    try {
      const project = join(base, 'proj');
      const home = join(base, 'home');
      mkdirSync(project);
      mkdirSync(home);
      fakeHarnessProject(project, '{"language": "python"}');
      const overlay = overlayWithWorkflow(base);
      const res = await run(
        project,
        home,
        '--from',
        overlay,
        '--apply',
        '--json',
      );
      const payload = JSON.parse(
        res.stdout.slice(
          res.stdout.indexOf('{'),
          res.stdout.lastIndexOf('}') + 1,
        ),
      );
      expect(payload.installed_workflows[0].workflow).toBe(
        'canary-guardian.yml',
      );
      expect(payload.installed_workflows[0].status).toBe('installed');
    } finally {
      rmTmp(base);
    }
  });

  // #667: the consumer deleted the workflow deliberately and expressed that by
  // editing the deployed skill. A second `--apply` must not put it back, and
  // `--json` has to carry the withheld verdict so a scheduled freshness check
  // reports it instead of discovering it by its side effects.
  it('withholds the workflow of a locally edited skill, and says so in --json', async () => {
    const base = mkTmp();
    try {
      const project = join(base, 'proj');
      const home = join(base, 'home');
      mkdirSync(project);
      mkdirSync(home);
      fakeHarnessProject(project, '{"language": "python"}');
      const overlay = overlayWithWorkflow(base);
      await run(project, home, '--from', overlay, '--apply');

      const installed = join(
        project,
        '.github',
        'workflows',
        'canary-guardian.yml',
      );
      rmSync(installed);
      writeFileSync(
        join(project, '.canary', 'skills', 'guardian', 'SKILL.md'),
        '---\nname: guardian\ndeploy_to: [all]\n---\n\n# runs inline here\n',
        'utf-8',
      );

      const res = await run(
        project,
        home,
        '--from',
        overlay,
        '--apply',
        '--json',
      );
      const payload = JSON.parse(
        res.stdout.slice(
          res.stdout.indexOf('{'),
          res.stdout.lastIndexOf('}') + 1,
        ),
      );
      expect(payload.installed_workflows[0].status).toBe('withheld');
      expect(payload.installed_workflows[0].detail).toContain('local edits');
      expect(existsSync(installed)).toBe(false);
    } finally {
      rmTmp(base);
    }
  });
});

// --- adoption report (#459, acceptance criterion 4) ---------------------------

/** `migrate --adoption-report` with an injected temp home. */
function adoptionRun(project: string, home: string, ...args: string[]) {
  return run(project, home, '--adoption-report', ...args);
}

function adoptionJson(stdout: string): Record<string, unknown> {
  return JSON.parse(
    stdout.slice(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1),
  );
}

function pieceStatus(
  payload: Record<string, unknown>,
  id: string,
): string | undefined {
  const pieces = payload['pieces'] as { id: string; status: string }[];
  return pieces.find((p) => p.id === id)?.status;
}

describe('canary migrate --adoption-report', () => {
  it('names the exact gap in a skills-deployed, workflow-less repo', async () => {
    const base = mkTmp();
    try {
      const project = join(base, 'proj');
      const home = join(base, 'home');
      mkdirSync(project);
      mkdirSync(home);
      fakeHarnessProject(project, '{"language": "python"}');
      const overlay = overlayWithWorkflow(base);
      // Deploy the skills, then delete the workflow: the #459 report -- a repo
      // that looks adopted while the guardian never runs.
      await run(project, home, '--from', overlay, '--apply');
      rmSync(join(project, '.github', 'workflows', 'canary-guardian.yml'));

      const res = await adoptionRun(project, home, '--from', overlay, '--json');
      const payload = adoptionJson(res.stdout);
      expect(pieceStatus(payload, 'skills')).toBe('present');
      expect(pieceStatus(payload, 'manifest')).toBe('present');
      expect(pieceStatus(payload, 'workflows')).toBe('missing');
      expect(payload['adopted']).toBe(false);
      expect(res.code).toBe(1);
    } finally {
      rmTmp(base);
    }
  });

  it('reports a fully adopted repo as adopted and exits 0', async () => {
    const base = mkTmp();
    try {
      const project = join(base, 'proj');
      const home = join(base, 'home');
      mkdirSync(project);
      mkdirSync(home);
      fakeHarnessProject(project, '{"language": "python"}');
      // The two pieces `migrate` does not create: the project-local pointer
      // file and its portable path pointers.
      mkdirSync(join(project, '.canary'), { recursive: true });
      writeFileSync(
        join(project, '.canary', 'company.json'),
        '{"coverage_report_path": "coverage/lcov.info"}',
        'utf-8',
      );
      const overlay = overlayWithWorkflow(base);
      await run(project, home, '--from', overlay, '--apply');

      const res = await adoptionRun(project, home, '--from', overlay, '--json');
      const payload = adoptionJson(res.stdout);
      expect(payload['adopted']).toBe(true);
      expect(payload['unverifiable']).toBe(0);
      expect(res.code).toBe(0);
    } finally {
      rmTmp(base);
    }
  });

  it('still reports with no overlay tracked -- that IS the common gap', async () => {
    const base = mkTmp();
    try {
      const project = join(base, 'proj');
      const home = join(base, 'home');
      mkdirSync(project);
      mkdirSync(home);
      fakeHarnessProject(project, '{"language": "python"}');

      const res = await adoptionRun(project, home, '--json');
      const payload = adoptionJson(res.stdout);
      expect(pieceStatus(payload, 'overlay')).toBe('missing');
      expect(pieceStatus(payload, 'skills')).toBe('unknown');
      expect(res.code).toBe(1);
    } finally {
      rmTmp(base);
    }
  });

  it('writes nothing -- no workflow, no manifest', async () => {
    const base = mkTmp();
    try {
      const project = join(base, 'proj');
      const home = join(base, 'home');
      mkdirSync(project);
      mkdirSync(home);
      fakeHarnessProject(project, '{"language": "python"}');
      const overlay = overlayWithWorkflow(base);

      await adoptionRun(project, home, '--from', overlay);
      expect(
        existsSync(
          join(project, '.github', 'workflows', 'canary-guardian.yml'),
        ),
      ).toBe(false);
      expect(existsSync(join(project, '.canary', 'skills'))).toBe(false);
    } finally {
      rmTmp(base);
    }
  });

  it('renders a human report with a fix line under each gap', async () => {
    const base = mkTmp();
    try {
      const project = join(base, 'proj');
      const home = join(base, 'home');
      mkdirSync(project);
      mkdirSync(home);
      fakeHarnessProject(project, '{"language": "python"}');

      const res = await adoptionRun(project, home);
      expect(res.stdout).toContain('# Canary Adoption');
      expect(res.stdout).toContain('fix: ');
      expect(res.stdout).toContain('canary overlay add');
    } finally {
      rmTmp(base);
    }
  });
});
