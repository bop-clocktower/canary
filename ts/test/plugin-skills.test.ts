/**
 * The plugin registers its adopter-facing skills, keeps its repo-internal
 * ones private, and its descriptions say what it ships (issue #1210).
 *
 * Every canary skill lives at `agents/skills/claude-code/<name>/SKILL.md`.
 * Claude Code's default skill scan only reads a top-level `skills/` directory,
 * so with no `skills` key in plugin.json a plugin-only install got no canary
 * skills at all. Before #1204 the recursive `agents/` scan hid that: each
 * SKILL.md appeared as a fake agent type, which looked like a listing but
 * could not be invoked as a skill.
 *
 * The `skills` key lists one folder per skill rather than the parent
 * directory, because some skills there only make sense inside this repo
 * (shipping canary, configuring its harness gates, editing its framework
 * registry). Those must never reach plugin users. Registering the parent
 * directory would publish them, so this test fails if anyone does that, and
 * it fails when a new skill is added without being classified either way.
 *
 * The descriptions had drifted the other way: marketplace.json claimed "four
 * MVP personas" and plugin.json listed only generate/init/migrate. They must
 * name the agents (with the real count), the skills, and the MCP server.
 */

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKILLS_ROOT = 'agents/skills/claude-code';

/**
 * Skills that encode this repo's own maintenance and must not ship in the
 * plugin. Each one is only meaningful inside the canary repository.
 */
const INTERNAL_SKILLS = [
  'canary-add-framework', // edits canary's own framework registry + classifier
  'canary-setup-harness', // wires canary's harness config and CI into a fork
  'canary-ship', // canary's own review/PR/merge conventions
];

const readJson = (rel: string) =>
  JSON.parse(readFileSync(join(REPO_ROOT, rel), 'utf-8'));

const manifest = readJson('.claude-plugin/plugin.json');
const marketplace = readJson('.claude-plugin/marketplace.json');
const marketplaceEntry = marketplace.plugins.find(
  (p: { name: string }) => p.name === manifest.name,
);
const registered: string[] = manifest.skills ?? [];

/**
 * Problems that would stop the skill folder `dir` from loading: no SKILL.md,
 * no frontmatter, a `name` that is not the folder name, or no `description`.
 */
function auditSkill(dir: string): string[] {
  const entry = basename(dir);
  let text: string;
  try {
    text = readFileSync(join(dir, 'SKILL.md'), 'utf-8');
  } catch {
    return [`${entry}: no SKILL.md`];
  }
  const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1];
  if (front === undefined) return [`${entry}: no frontmatter`];
  const problems: string[] = [];
  const name = /^name:\s*(\S+)\s*$/m.exec(front)?.[1];
  if (name !== entry) problems.push(`${entry}: name is ${name}`);
  if (!/^description:\s*\S/m.test(front))
    problems.push(`${entry}: no description`);
  return problems;
}

const skillDirs = readdirSync(join(REPO_ROOT, SKILLS_ROOT))
  .filter((n) => statSync(join(REPO_ROOT, SKILLS_ROOT, n)).isDirectory())
  .sort();
const publicSkills = skillDirs.filter((n) => !INTERNAL_SKILLS.includes(n));
const pathFor = (name: string) => `./${SKILLS_ROOT}/${name}`;

const NUMBER_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
];

describe('auditSkill', () => {
  it('flags a skill that would not load and passes one that would', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plugin-skills-'));
    const skill = (name: string, body?: string) => {
      mkdirSync(join(dir, name));
      if (body !== undefined) writeFileSync(join(dir, name, 'SKILL.md'), body);
      return auditSkill(join(dir, name));
    };
    expect(
      skill('good', '---\nname: good\ndescription: >\n  does a thing\n---\n'),
    ).toEqual([]);
    expect(skill('renamed', '---\nname: other\ndescription: x\n---\n')).toEqual(
      ['renamed: name is other'],
    );
    expect(skill('mute', '---\nname: mute\n---\n')).toEqual([
      'mute: no description',
    ]);
    expect(skill('bare', '# no frontmatter\n')).toEqual([
      'bare: no frontmatter',
    ]);
    expect(skill('empty')).toEqual(['empty: no SKILL.md']);
  });
});

describe('plugin.json skills (#1210)', () => {
  it('finds the skills it is checking (a zero denominator is an abstention)', () => {
    expect(publicSkills.length).toBeGreaterThanOrEqual(30);
  });

  it('every internal skill named here still exists (no stale exclusions)', () => {
    for (const name of INTERNAL_SKILLS) expect(skillDirs, name).toContain(name);
  });

  it('registers exactly the adopter-facing skills, one folder each', () => {
    expect([...registered].sort()).toEqual(publicSkills.map(pathFor));
  });

  it('never registers an internal skill or the whole skills directory', () => {
    const norm = (p: string) => p.replace(/\/+$/, '');
    for (const p of registered) {
      expect(norm(p), p).not.toBe(`./${SKILLS_ROOT}`);
      expect(INTERNAL_SKILLS, p).not.toContain(basename(norm(p)));
    }
  });

  it('every registered skill loads', () => {
    const problems = registered.flatMap((p) => auditSkill(join(REPO_ROOT, p)));
    expect(problems).toEqual([]);
  });
});

describe('plugin descriptions do not undercount (#1210)', () => {
  const agentCount = NUMBER_WORDS[manifest.agents.length];
  const descriptions: Array<[string, string]> = [
    ['plugin.json description', manifest.description],
    ['marketplace.json plugin description', marketplaceEntry.description],
    ['marketplace.json description', marketplace.description],
  ];

  it('has a word for the declared agent count', () => {
    expect(agentCount).toBeDefined();
  });

  it.each(descriptions)(
    '%s names the agents (by real count), skills, and MCP server',
    (_label, text) => {
      expect(text).toMatch(new RegExp(`\\b${agentCount} agents\\b`));
      expect(text).toMatch(/\bskills\b/);
      expect(text).toMatch(/\bMCP\b/);
      expect(text).not.toMatch(/\bpersonas\b/);
    },
  );
});
