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

import { mkdirSync, writeFileSync } from 'node:fs';
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
