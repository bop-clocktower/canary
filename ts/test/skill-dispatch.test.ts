/**
 * Unit coverage for the tier-2 dispatcher (#756).
 *
 * `skills-cli-branches.test.ts` drives this through the CLI; this file pins the
 * two decisions that are the module's whole contract and that a rendering test
 * would let drift:
 *
 * - the frontmatter/body split, including the shapes that have no body at all;
 * - the determinism label, which is what stops an agent-applied result from
 *   being merged with a deterministic detector's findings.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  SkillDispatchError,
  dispatchProseSkill,
  skillBody,
} from '../src/core/skill-dispatch.js';
import { SkillInfo } from '../src/core/skill-registry.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function onDisk(text: string): SkillInfo {
  const dir = mkdtempSync(join(tmpdir(), 'canary-dispatch-'));
  dirs.push(dir);
  const path = join(dir, 'SKILL.md');
  writeFileSync(path, text, 'utf-8');
  return new SkillInfo({
    name: 'demo',
    path,
    source: 'bundled',
    description: 'a demo',
    requires: ['node>=20'],
  });
}

describe('skillBody', () => {
  it('drops a terminated frontmatter block and keeps the prose', () => {
    expect(skillBody('---\nname: x\n---\n\n# Title\n\nBody.\n')).toBe(
      '# Title\n\nBody.',
    );
  });

  it('returns a file with no frontmatter unchanged, trimmed', () => {
    expect(skillBody('\n# Title\n')).toBe('# Title');
  });

  it('returns nothing for an UNTERMINATED block -- it was all frontmatter', () => {
    // Matches SkillRegistry.parseFrontmatter: no closing `---` means the whole
    // file is the block, so there is no workflow to hand an agent.
    expect(skillBody('---\nname: x\nstill: frontmatter\n')).toBe('');
  });

  it('keeps a `---` that appears inside the body', () => {
    const body = skillBody('---\nname: x\n---\n\nStep.\n\n---\n\nMore.\n');
    expect(body).toContain('Step.');
    expect(body).toContain('More.');
  });
});

describe('dispatchProseSkill', () => {
  it('labels every dispatch agent-applied and flags the runtime it needs', () => {
    const d = dispatchProseSkill(onDisk('---\nname: x\n---\n\nStep.\n'), []);
    expect(d.determinism).toBe('agent-applied');
    expect(d.requires_agent_runtime).toBe(true);
    expect(d.tier).toBe('dispatcher');
  });

  it('carries identity, requirements and the caller args verbatim', () => {
    const args = ['--scope', 'tests/', '--', 'literal'];
    const d = dispatchProseSkill(onDisk('---\nname: x\n---\n\nStep.\n'), args);
    expect(d.skill).toBe('demo');
    expect(d.description).toBe('a demo');
    expect(d.requires).toEqual(['node>=20']);
    expect(d.args).toEqual(args);
    expect(d.instructions).toBe('Step.');
  });

  it('fails on an unreadable SKILL.md rather than dispatching nothing', () => {
    const missing = new SkillInfo({
      name: 'ghost',
      path: join(tmpdir(), 'canary-no-such-skill', 'SKILL.md'),
      source: 'bundled',
    });
    expect(() => dispatchProseSkill(missing, [])).toThrow(SkillDispatchError);
    expect(() => dispatchProseSkill(missing, [])).toThrow(/ENOENT/);
  });

  it('fails on a body-less skill rather than reporting an empty run', () => {
    // The #756 failure-mode requirement: "a skill that cannot be run must
    // report that it could not, never return empty as though it had run".
    const empty = onDisk('---\nname: x\n---\n');
    expect(() => dispatchProseSkill(empty, [])).toThrow(/no workflow body/);
  });

  it('rethrows a non-errno failure instead of tidying it into a dispatch error', () => {
    // A programmer error inside the reader must not be absorbed: that is how a
    // broken dispatcher learns to look like a skill with nothing in it.
    const bogus = new SkillInfo({
      name: 'bogus',
      path: undefined as unknown as string,
      source: 'bundled',
    });
    expect(() => dispatchProseSkill(bogus, [])).toThrow();
    expect(() => dispatchProseSkill(bogus, [])).not.toThrow(SkillDispatchError);
  });
});
