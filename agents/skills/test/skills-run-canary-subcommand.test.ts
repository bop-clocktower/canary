// #1766 end to end: `canary skills run` on the skills whose `cli:` is a canary
// subcommand, through the real built bin.
//
// `skills verify` has accepted `cli: canary <subcmd>` since #1753, but `skills
// run` read the target as a file and refused every one of them ("cli target
// does not exist"). This drives the shipped `ts/bin/canary.js`, which this
// job's globalSetup guarantees is built (test/engine-precondition.ts), so the
// spawn is real: no fake subprocess, no stub registry.
//
// The skill list comes from the tree, and every skill verify accepts must run,
// so verify and run cannot drift apart again.

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const BIN = path.join(ROOT, 'ts', 'bin', 'canary.js');
const SKILLS = path.join(ROOT, 'agents', 'skills', 'claude-code');

function canary(args: string[]) {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

/** Every bundled skill whose frontmatter says `cli: canary ...`. */
function canarySubcommandSkills(): { name: string; cli: string }[] {
  const found = [];
  for (const dir of fs.readdirSync(SKILLS)) {
    const md = path.join(SKILLS, dir, 'SKILL.md');
    if (!fs.existsSync(md)) continue;
    const m = /^cli:\s*(canary\s+.+?)\s*$/m.exec(fs.readFileSync(md, 'utf8'));
    if (m) found.push({ name: dir, cli: m[1]! });
  }
  return found;
}

const skills = canarySubcommandSkills();

describe('skills run: cli: canary <subcmd> through the real bin (#1766)', () => {
  it('finds the seven skills it is about, not zero', () => {
    expect(skills.length).toBeGreaterThanOrEqual(7);
  });

  it('skills verify accepts every one of them', () => {
    const res = canary([
      'skills',
      'verify',
      '--root',
      ROOT,
      '--json',
      '--no-run-examples',
    ]);
    const report = JSON.parse(res.stdout);
    const missing = report.surfaces.findings
      .filter((f: { kind: string }) => f.kind === 'cli-missing')
      .map((f: { name: string }) => f.name);
    for (const s of skills) expect(missing).not.toContain(s.name);
  });

  it.each(skills.map((s) => [s.name, s.cli]))(
    '%s (%s) runs its subcommand',
    (name, cli) => {
      const res = canary([
        'skills',
        'run',
        name,
        '--allow-executable-skills',
        '--',
        '--help',
      ]);
      expect(res.stdout + res.stderr).not.toContain('does not exist');
      expect(res.code).toBe(0);
      expect(res.stdout).toContain(`Usage: ${cli}`);
    },
  );

  it("passes the subcommand's own exit code through", () => {
    // `canary rewind` requires --test: commander's usage exit, 2.
    const res = canary([
      'skills',
      'run',
      'canary-rewind',
      '--allow-executable-skills',
    ]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("required option '--test");
  });
});
