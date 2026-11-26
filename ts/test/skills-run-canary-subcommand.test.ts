/**
 * `skills run` on a `cli: canary <subcmd>` skill (#1766).
 *
 * Seven bundled skills (batwoman, clocktower, judomaster, manhunter,
 * mission-briefing, rewind, shiva) point their `cli:` at a canary subcommand.
 * Since #1753, `skills verify` resolves that target against the live command
 * tree and accepts it; `skills run` still read it as a file path and refused
 * with "cli target does not exist". `run` now re-enters canary's own command
 * tree for these, through the same resolver `verify` uses, so the two cannot
 * disagree about which skills are runnable.
 *
 * The spawn is faked here (the TS engine CI job does not build `ts/dist`, which
 * the bin needs). The real end-to-end run lives in the skills suite, whose CI
 * job builds the engine first: agents/skills/test/skills-run-canary-subcommand.test.ts.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  SurfaceFindingKind,
  SurfaceKind,
  collectSurfaces,
} from '../src/core/skill-surfaces.js';
import { SkillInfo, type SkillRegistry } from '../src/core/skill-registry.js';
import type { SubprocessResult } from '../src/main-deps.js';
import { invokeCanary } from './canary-cli-testkit.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = join(REPO_ROOT, 'ts', 'bin', 'canary.js');

interface Spawned {
  cmd: string;
  args: string[];
}

function skillAt(dir: string, name: string, cli: string): SkillInfo {
  mkdirSync(join(dir, name), { recursive: true });
  return new SkillInfo({
    name,
    path: join(dir, name, 'SKILL.md'),
    source: 'bundled',
    cli,
  });
}

function fakeRegistry(skills: SkillInfo[]): SkillRegistry {
  return {
    discover: () => skills,
    find: (name: string) => skills.find((s) => s.name === name) ?? null,
    searchRoots: () => [],
  } as unknown as SkillRegistry;
}

async function run(
  args: string[],
  skills: SkillInfo[],
  opts: { env?: Record<string, string>; status?: number | null } = {},
) {
  const spawned: Spawned[] = [];
  const res = await invokeCanary(['skills', 'run', ...args], {
    env: opts.env ?? {},
    deps: {
      makeSkillRegistry: () => fakeRegistry(skills),
      runSubprocess: (cmd, subArgs): SubprocessResult => {
        spawned.push({ cmd, args: subArgs });
        return {
          status: opts.status === undefined ? 0 : opts.status,
          stdout: '',
          stderr: '',
        };
      },
    },
  });
  return { ...res, spawned };
}

function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'canary-run-sub-'));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe('skills run: cli: canary <subcmd> (#1766)', () => {
  it('spawns the canary bin with the subcommand, forwards args, and passes the exit code through', () =>
    withDir(async (dir) => {
      const res = await run(
        ['canary-batwoman', '--allow-executable-skills', '--', '--json', 'x'],
        [skillAt(dir, 'canary-batwoman', 'canary batwoman')],
        { status: 7 },
      );
      expect(res.code).toBe(7);
      expect(res.stdout).not.toContain('does not exist');
      expect(res.spawned).toEqual([
        { cmd: process.execPath, args: [BIN, 'batwoman', '--json', 'x'] },
      ]);
    }));

  it('the bin it spawns is the one this package ships', () => {
    // A path computed from the module location that pointed anywhere else
    // would spawn nothing and exit 1 for every one of the seven skills.
    expect(existsSync(BIN)).toBe(true);
  });

  it('dispatches a nested subcommand as its full path', () =>
    withDir(async (dir) => {
      const res = await run(
        ['canary-clocktower', '--allow-executable-skills'],
        [skillAt(dir, 'canary-clocktower', 'canary history gaps')],
      );
      expect(res.code).toBe(0);
      expect(res.spawned[0]!.args).toEqual([BIN, 'history', 'gaps']);
    }));

  it('a spawn that could not start is a failure, not a silent 0', () =>
    withDir(async (dir) => {
      const res = await run(
        ['canary-batwoman', '--allow-executable-skills'],
        [skillAt(dir, 'canary-batwoman', 'canary batwoman')],
        { status: null },
      );
      expect(res.code).toBe(1);
    }));

  it('refuses an unregistered subcommand with exit 4 and spawns nothing', () =>
    withDir(async (dir) => {
      const res = await run(
        ['canary-ghost', '--allow-executable-skills'],
        [skillAt(dir, 'canary-ghost', 'canary nosuchthing')],
      );
      expect(res.code).toBe(4);
      expect(res.stdout).toContain(
        '`canary nosuchthing` is not a registered canary command',
      );
      expect(res.spawned).toEqual([]);
    }));

  it('still honours the --allow-executable-skills gate in CI', () =>
    withDir(async (dir) => {
      const res = await run(
        ['canary-batwoman'],
        [skillAt(dir, 'canary-batwoman', 'canary batwoman')],
        { env: { CI: 'true' } },
      );
      expect(res.code).toBe(3);
      expect(res.stdout).toContain('Refusing to invoke executable skill');
      expect(res.spawned).toEqual([]);
    }));
});

/**
 * The contract: every skill in this repo that `verify` accepts with a
 * `cli: canary ...` target is one `run` dispatches. The skill list is read from
 * the tree, never kept by hand, so an eighth such skill is covered on arrival.
 */
describe('verify accepts => run dispatches, for every repo skill (#1766)', () => {
  const canarySkills = collectSurfaces(REPO_ROOT).filter(
    (d) =>
      d.kind === SurfaceKind.Skill && d.cli !== null && /^canary\s/.test(d.cli),
  );
  let verifyMissing: string[] = [];

  beforeAll(async () => {
    const verify = await invokeCanary([
      'skills',
      'verify',
      '--root',
      REPO_ROOT,
      '--json',
      '--no-run-examples',
    ]);
    const report = JSON.parse(verify.stdout) as {
      surfaces: { findings: Array<{ kind: string; name: string }> };
    };
    verifyMissing = report.surfaces.findings
      .filter((f) => f.kind === SurfaceFindingKind.CliMissing)
      .map((f) => f.name);
  });

  it('the denominator is the seven known skills, not zero', () => {
    expect(canarySkills.length).toBeGreaterThanOrEqual(7);
  });

  it.each(canarySkills.map((d) => [d.name, d.cli!, d.path] as const))(
    '%s (%s): verify accepts it, and run dispatches it',
    async (name, cli, skillMd) => {
      expect(verifyMissing).not.toContain(name);
      const info = new SkillInfo({
        name,
        path: skillMd,
        source: 'bundled',
        cli,
      });
      const res = await run([name, '--allow-executable-skills'], [info]);
      expect(res.code).toBe(0);
      expect(res.spawned).toEqual([
        {
          cmd: process.execPath,
          args: [BIN, ...cli.replace(/^canary\s+/, '').split(/\s+/)],
        },
      ]);
    },
  );
});
