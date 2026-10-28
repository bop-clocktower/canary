/**
 * #1416: `migrate --framework <name>` must reject a name it does not know.
 *
 * Before the fix a typo such as `--framework locsut` was accepted on both
 * `--check` and `--apply`, and the run quietly fell back to the detected shape
 * set -- answering a question the user did not ask. An unknown name is a usage
 * error: exit 1 (the code migrate uses for an unknown `--from`; on `--check`, 2
 * already means "local edits"), list the known names, and do it before
 * anything is written.
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

/** A harness project with no framework signal, plus a `load`-scoped overlay. */
function fixture(base: string): {
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

function expectUnknownFrameworkError(res: {
  code: number;
  stdout: string;
  stderr: string;
}): void {
  expect(res.code).toBe(1);
  expect(res.stderr).toContain("Unknown --framework 'locsut'");
  // The message names the known frameworks, sourced from the registry.
  for (const known of ['playwright', 'vitest', 'locust', 'phpunit']) {
    expect(res.stderr).toContain(known);
  }
  // Nothing reported as if the run had happened.
  expect(res.stdout).not.toContain('Canary Migrate');
}

describe('#1416 migrate rejects an unknown --framework', () => {
  it('fails fast on --check and lists the known frameworks', async () => {
    const base = mkTmp();
    try {
      const { project, home, overlay } = fixture(base);
      const res = await run(
        project,
        home,
        '--from',
        overlay,
        '--framework',
        'locsut',
        '--check',
      );
      expectUnknownFrameworkError(res);
    } finally {
      rmTmp(base);
    }
  });

  it('fails fast on --apply and writes nothing', async () => {
    const base = mkTmp();
    try {
      const { project, home, overlay } = fixture(base);
      // A skill every shape receives, so a pre-validation deploy is visible.
      const anySkill = join(overlay, '.canary', 'skills', 'any-skill');
      mkdirSync(anySkill);
      writeFileSync(
        join(anySkill, 'SKILL.md'),
        '---\nname: any-skill\ndeploy_to: [all]\n---\n\n# any\n',
      );
      const before = readdirSync(project).sort();
      const res = await run(
        project,
        home,
        '--from',
        overlay,
        '--framework',
        'locsut',
        '--apply',
      );
      // Writes first: before the fix the overlay skills deployed and only then
      // did the scaffolder reject the name, so the run exited 1 having written.
      expect(existsSync(join(project, '.canary'))).toBe(false);
      expect(readdirSync(project).sort()).toEqual(before);
      expectUnknownFrameworkError(res);
    } finally {
      rmTmp(base);
    }
  });

  it('control: a known framework name still applies as before', async () => {
    const base = mkTmp();
    try {
      const { project, home, overlay } = fixture(base);
      const res = await run(
        project,
        home,
        '--from',
        overlay,
        '--framework',
        'locust',
        '--apply',
        '--json',
      );
      expect(res.code).toBe(0);
      expect(jsonOf(res.stdout)['framework']).toBe('locust');
      expect(existsSync(join(project, '.canary', 'skills'))).toBe(true);
    } finally {
      rmTmp(base);
    }
  });

  it('control: omitting --framework still uses detection', async () => {
    const base = mkTmp();
    try {
      const { project, home, overlay } = fixture(base);
      writeFileSync(join(project, 'vitest.config.ts'), 'export default {};\n');
      const res = await run(project, home, '--from', overlay, '--json');
      expect(res.code).toBe(0);
      const payload = jsonOf(res.stdout);
      expect(payload['framework']).toBe('vitest');
      expect(payload['detection_source']).not.toBe('CLI override');
    } finally {
      rmTmp(base);
    }
  });
});
