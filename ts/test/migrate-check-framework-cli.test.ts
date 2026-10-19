/**
 * #1353: `migrate --check` must forward `--framework` to `checkFreshness`, and
 * the adoption report must say its freshness check covers detected shapes only.
 *
 * locust has no scaffold template, so `migrate --framework locust --apply`
 * writes nothing detection can find later. Its `deploy_to: [load]` skills are
 * deployed under the override's shape. A `--check --framework locust` that
 * drops the flag checks the empty detected shape set, verifies zero skills, and
 * abstains about skills that are present and current. See #1347 for the core
 * half (`checkFreshness` honoring the option).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

/** A harness project with no framework signal, plus a `load`-scoped overlay. */
function locustFixture(base: string): {
  project: string;
  home: string;
  overlay: string;
} {
  const project = join(base, 'proj');
  const home = join(base, 'home');
  const overlay = join(base, 'overlay');
  mkdirSync(join(project, '.harness'), { recursive: true });
  mkdirSync(home);
  writeFileSync(join(project, 'harness.config.json'), '{"layers": []}');
  const skillDir = join(overlay, '.canary', 'skills', 'sample-skill');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    '---\nname: sample-skill\ndeploy_to: [load]\n---\n\n# sample\n',
  );
  return { project, home, overlay };
}

function run(project: string, home: string, ...args: string[]) {
  return invokeCanary(['migrate', '--path', project, ...args], {
    deps: { home: () => home },
  });
}

function jsonOf(stdout: string): Record<string, unknown> {
  return JSON.parse(
    stdout.slice(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1),
  );
}

describe('#1353 migrate --check honors --framework', () => {
  it('reports a scaffold-less framework’s deployed skills current, not abstained', async () => {
    const base = mkTmp();
    try {
      const { project, home, overlay } = locustFixture(base);
      const applied = await run(
        project,
        home,
        '--from',
        overlay,
        '--framework',
        'locust',
        '--apply',
      );
      expect(applied.code).toBe(0);

      const res = await run(
        project,
        home,
        '--from',
        overlay,
        '--framework',
        'locust',
        '--check',
        '--json',
      );
      const payload = jsonOf(res.stdout) as {
        skills: { skill_name: string; status: string }[];
      };
      expect(payload.skills.map((s) => [s.skill_name, s.status])).toEqual([
        ['sample-skill', 'current'],
      ]);
      expect(res.code).toBe(0);
    } finally {
      rmTmp(base);
    }
  });
});

describe('#1353 adoption report discloses detected-shapes-only scope', () => {
  it('explains a zero-skill abstention as a detected-shapes-only check', async () => {
    const base = mkTmp();
    try {
      const { project, home, overlay } = locustFixture(base);
      await run(
        project,
        home,
        '--from',
        overlay,
        '--framework',
        'locust',
        '--apply',
      );

      const res = await run(
        project,
        home,
        '--from',
        overlay,
        '--adoption-report',
        '--json',
      );
      const pieces = jsonOf(res.stdout)['pieces'] as {
        id: string;
        status: string;
        detail: string;
      }[];
      const skills = pieces.find((p) => p.id === 'skills');
      expect(skills?.status).toBe('unknown');
      expect(skills?.detail).toContain('detected shapes only');
      expect(skills?.detail).toContain('--framework');
    } finally {
      rmTmp(base);
    }
  });
});
