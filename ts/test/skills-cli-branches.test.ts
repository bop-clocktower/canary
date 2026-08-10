/**
 * Branch coverage for the `canary skills` sub-app (#481).
 *
 * `skills list` groups discovered skills into four source tiers and inserts a
 * blank separator only when an earlier tier printed — a grouping ladder that a
 * real on-disk discovery run never exercises fully. `skills run` has a five-rung
 * refusal ladder (missing / errored / markdown-only / not-opted-in / bad target)
 * whose exit codes are the contract. Both are driven here through an injected
 * fake registry, asserting on the rendered grouping and the exit codes.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SkillInfo, type SkillRegistry } from '../src/core/skill-registry.js';
import type { SubprocessResult } from '../src/main-deps.js';
import { invokeCanary } from './canary-cli-testkit.js';

function skill(over: Partial<ConstructorParameters<typeof SkillInfo>[0]> = {}) {
  return new SkillInfo({
    name: 'demo',
    path: '/tmp/skills/demo/SKILL.md',
    source: 'bundled',
    ...over,
  });
}

/** A registry stub honouring only the two methods the sub-app calls. */
function fakeRegistry(skills: SkillInfo[]): SkillRegistry {
  return {
    discover: () => skills,
    find: (name: string) => skills.find((s) => s.name === name) ?? null,
  } as unknown as SkillRegistry;
}

interface RunOpts {
  subprocess?: SubprocessResult;
  spawned?: { cmd: string; args: string[] }[];
}

async function runSkills(
  args: string[],
  skills: SkillInfo[],
  opts: RunOpts = {},
) {
  return invokeCanary(['skills', ...args], {
    deps: {
      makeSkillRegistry: () => fakeRegistry(skills),
      pythonExe: () => 'python3.99',
      runSubprocess: (cmd, subArgs) => {
        opts.spawned?.push({ cmd, args: subArgs });
        return opts.subprocess ?? { status: 0, stdout: '', stderr: '' };
      },
    },
  });
}

describe('skills list grouping', () => {
  it('reports an empty discovery honestly instead of printing headers', async () => {
    const res = await runSkills(['list'], []);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('No skills found.');
    expect(res.stdout).not.toContain('Bundled skills:');
  });

  it('prints each source tier under its own header, in precedence order', async () => {
    const res = await runSkills(
      ['list'],
      [
        skill({ name: 'b', source: 'bundled' }),
        skill({
          name: 'o',
          source: 'overlay',
          path: '/h/.canary/overlays/acme/.canary/skills/o/SKILL.md',
        }),
        skill({ name: 'g', source: 'global' }),
        skill({ name: 'l', source: 'local' }),
      ],
    );
    const idx = (s: string) => res.stdout.indexOf(s);
    expect(idx('Bundled skills:')).toBeGreaterThanOrEqual(0);
    expect(idx('Overlay skills')).toBeGreaterThan(idx('Bundled skills:'));
    expect(idx('Global skills')).toBeGreaterThan(idx('Overlay skills'));
    expect(idx('Local overlay skills')).toBeGreaterThan(idx('Global skills'));
  });

  it('names each overlay group and sorts the groups by overlay name', async () => {
    const res = await runSkills(
      ['list'],
      [
        skill({
          name: 'z',
          source: 'overlay',
          path: '/h/.canary/overlays/zeta/.canary/skills/z/SKILL.md',
        }),
        skill({
          name: 'a',
          source: 'overlay',
          path: '/h/.canary/overlays/alpha/.canary/skills/a/SKILL.md',
        }),
      ],
    );
    expect(res.stdout).toContain('(alpha ');
    expect(res.stdout).toContain('(zeta ');
    expect(res.stdout.indexOf('(alpha ')).toBeLessThan(
      res.stdout.indexOf('(zeta '),
    );
  });

  it('falls back to ? for an overlay skill outside the clone layout', async () => {
    const res = await runSkills(
      ['list'],
      [
        skill({
          name: 'stray',
          source: 'overlay',
          path: '/elsewhere/SKILL.md',
        }),
      ],
    );
    expect(res.stdout).toContain('(? ');
  });

  it('marks each skill by kind: error beats cli beats entry', async () => {
    const res = await runSkills(
      ['list'],
      [
        skill({ name: 'md' }),
        skill({ name: 'c', cli: 'run.js' }),
        skill({ name: 'e', entry: 'mod:fn' }),
        skill({ name: 'x', cli: 'run.js', error: 'bad frontmatter' }),
      ],
    );
    expect(res.stdout).toContain('/md');
    expect(res.stdout).not.toContain('/md [');
    expect(res.stdout).toContain('/c [cli]');
    expect(res.stdout).toContain('/e [entry]');
    // An errored skill is flagged as such even though it declares a cli:.
    expect(res.stdout).toContain('/x [error]');
  });

  it('appends the description when one is declared', async () => {
    const res = await runSkills(
      ['list'],
      [skill({ name: 'd', description: 'does a thing' })],
    );
    expect(res.stdout).toContain('/d  does a thing');
  });

  it('--verbose adds the SKILL.md path on its own line', async () => {
    const plain = await runSkills(['list'], [skill()]);
    expect(plain.stdout).not.toContain('/tmp/skills/demo/SKILL.md');
    const verbose = await runSkills(['list', '--verbose'], [skill()]);
    expect(verbose.stdout).toContain('/tmp/skills/demo/SKILL.md');
  });
});

describe('skills run refusal ladder', () => {
  it('exits 1 for an unknown skill', async () => {
    const res = await runSkills(['run', 'ghost'], []);
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('No skill named ghost found.');
  });

  it('exits 2 for a skill that failed validation at discovery', async () => {
    const res = await runSkills(
      ['run', 'demo'],
      [skill({ cli: 'run.js', error: 'requires: unparseable' })],
    );
    expect(res.code).toBe(2);
    expect(res.stdout).toContain('requires: unparseable');
  });

  it('exits 2 for a markdown-only skill', async () => {
    const res = await runSkills(['run', 'demo'], [skill()]);
    expect(res.code).toBe(2);
    expect(res.stdout).toContain('markdown-only');
  });

  it('exits 3 without --allow-executable-skills under CI', async () => {
    const res = await invokeCanary(['skills', 'run', 'demo'], {
      env: { CI: 'true' },
      deps: {
        makeSkillRegistry: () => fakeRegistry([skill({ cli: 'run.js' })]),
      },
    });
    expect(res.code).toBe(3);
    expect(res.stdout).toContain('Refusing to invoke executable skill');
  });

  it('exits 4 when the declared cli target is missing from the skill dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'canary-skill-'));
    try {
      writeFileSync(join(dir, 'SKILL.md'), '# skill\n', 'utf-8');
      const res = await runSkills(
        ['run', 'demo', '--allow-executable-skills'],
        [skill({ path: join(dir, 'SKILL.md'), cli: 'missing.js' })],
      );
      expect(res.code).toBe(4);
      expect(res.stdout).toContain('cli target does not exist');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 4 when the cli path escapes the skill directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'canary-skill-'));
    try {
      mkdirSync(join(dir, 'demo'), { recursive: true });
      writeFileSync(join(dir, 'demo', 'SKILL.md'), '# skill\n', 'utf-8');
      writeFileSync(join(dir, 'outside.js'), '// nope\n', 'utf-8');
      const res = await runSkills(
        ['run', 'demo', '--allow-executable-skills'],
        [skill({ path: join(dir, 'demo', 'SKILL.md'), cli: '../outside.js' })],
      );
      expect(res.code).toBe(4);
      expect(res.stdout).toContain('escapes the skill directory');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('skills run cli invocation', () => {
  function withCliSkill(target: string): { dir: string; info: SkillInfo } {
    const dir = mkdtempSync(join(tmpdir(), 'canary-skill-'));
    mkdirSync(join(dir, 'demo'), { recursive: true });
    writeFileSync(join(dir, 'demo', target), '# target\n', 'utf-8');
    writeFileSync(join(dir, 'demo', 'SKILL.md'), '# skill\n', 'utf-8');
    return {
      dir,
      info: skill({ path: join(dir, 'demo', 'SKILL.md'), cli: target }),
    };
  }

  it('forwards trailing args and passes the exit code through', async () => {
    const { dir, info } = withCliSkill('run.js');
    try {
      const spawned: { cmd: string; args: string[] }[] = [];
      const res = await runSkills(
        ['run', 'demo', '--allow-executable-skills', '--', '--flag', 'value'],
        [info],
        { spawned, subprocess: { status: 7, stdout: '', stderr: '' } },
      );
      expect(res.code).toBe(7);
      expect(spawned).toHaveLength(1);
      expect(spawned[0]!.cmd).toContain('run.js');
      expect(spawned[0]!.args).toEqual(['--flag', 'value']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs a .py target through the configured interpreter', async () => {
    const { dir, info } = withCliSkill('run.py');
    try {
      const spawned: { cmd: string; args: string[] }[] = [];
      await runSkills(['run', 'demo', '--allow-executable-skills'], [info], {
        spawned,
      });
      expect(spawned[0]!.cmd).toBe('python3.99');
      expect(spawned[0]!.args[0]).toContain('run.py');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('maps a spawn failure (status null) to exit 1, never a silent 0', async () => {
    const { dir, info } = withCliSkill('run.js');
    try {
      const res = await runSkills(
        ['run', 'demo', '--allow-executable-skills'],
        [info],
        { subprocess: { status: null, stdout: '', stderr: '' } },
      );
      expect(res.code).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('skills run entry ladder', () => {
  it('exits 5 when entry: is not module:callable', async () => {
    for (const entry of ['nocolon', ':fn', 'mod:']) {
      const res = await runSkills(
        ['run', 'demo', '--allow-executable-skills'],
        [skill({ entry })],
      );
      expect(res.code).toBe(5);
      expect(res.stdout).toContain("entry must be 'module:callable'");
    }
  });

  it('exits 6 when the entry module cannot be loaded', async () => {
    const res = await runSkills(
      ['run', 'demo', '--allow-executable-skills'],
      [skill({ entry: 'canary_no_such_module:main' })],
    );
    expect(res.code).toBe(6);
    expect(res.stdout).toContain("entry 'canary_no_such_module:main'");
  });

  it('exits 6 when the named attribute is not callable', async () => {
    // An absolute POSIX path carries no colon, so partition() splits cleanly on
    // the module/attr separator and the module genuinely resolves — isolating
    // the not-callable rung from the load-failure one above.
    const dir = mkdtempSync(join(tmpdir(), 'canary-entry-'));
    try {
      const mod = join(dir, 'mod.mjs');
      writeFileSync(mod, 'export const notAFunction = 42;\n', 'utf-8');
      const res = await runSkills(
        ['run', 'demo', '--allow-executable-skills'],
        [skill({ entry: `${mod}:notAFunction` })],
      );
      expect(res.code).toBe(6);
      expect(res.stdout).toContain('not callable');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits with the callable return code when the entry resolves', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'canary-entry-'));
    try {
      const mod = join(dir, 'mod.mjs');
      writeFileSync(mod, 'export const main = () => 9;\n', 'utf-8');
      const res = await runSkills(
        ['run', 'demo', '--allow-executable-skills'],
        [skill({ entry: `${mod}:main` })],
      );
      expect(res.code).toBe(9);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 0 when the callable returns a non-number', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'canary-entry-'));
    try {
      const mod = join(dir, 'mod.mjs');
      writeFileSync(mod, "export const main = () => 'done';\n", 'utf-8');
      const res = await runSkills(
        ['run', 'demo', '--allow-executable-skills'],
        [skill({ entry: `${mod}:main` })],
      );
      expect(res.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
