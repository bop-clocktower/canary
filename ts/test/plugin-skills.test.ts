/**
 * The plugin registers its skills, and its descriptions say what it ships
 * (issue #1210).
 *
 * Every canary skill lives at `agents/skills/claude-code/<name>/SKILL.md`.
 * Claude Code's default skill scan only reads a top-level `skills/` directory,
 * so with no `skills` key in plugin.json a plugin-only install got no canary
 * skills at all. Before #1204 the recursive `agents/` scan hid that: each
 * SKILL.md appeared as a fake agent type, which looked like a listing but
 * could not be invoked as a skill. The `skills` key adds to the default scan
 * rather than replacing it.
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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKILLS_DIR = './agents/skills/claude-code/';

const readJson = (rel: string) =>
  JSON.parse(readFileSync(join(REPO_ROOT, rel), 'utf-8'));

const manifest = readJson('.claude-plugin/plugin.json');
const marketplace = readJson('.claude-plugin/marketplace.json');
const marketplaceEntry = marketplace.plugins.find(
  (p: { name: string }) => p.name === manifest.name,
);

/**
 * Problems that would stop a skill under `dir` from loading: a skill
 * directory with no SKILL.md, no frontmatter, a `name` that is not the
 * directory name, or no `description`. Returns the skill names it checked
 * alongside the problems, so a caller can tell "clean" from "found nothing".
 */
function auditSkills(dir: string): { names: string[]; problems: string[] } {
  const names: string[] = [];
  const problems: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (!statSync(join(dir, entry)).isDirectory()) continue;
    names.push(entry);
    let text: string;
    try {
      text = readFileSync(join(dir, entry, 'SKILL.md'), 'utf-8');
    } catch {
      problems.push(`${entry}: no SKILL.md`);
      continue;
    }
    const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1];
    if (front === undefined) {
      problems.push(`${entry}: no frontmatter`);
      continue;
    }
    const name = /^name:\s*(\S+)\s*$/m.exec(front)?.[1];
    if (name !== entry) problems.push(`${entry}: name is ${name}`);
    if (!/^description:\s*\S/m.test(front))
      problems.push(`${entry}: no description`);
  }
  return { names, problems };
}

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

describe('auditSkills', () => {
  it('flags a skill that would not load and passes one that would', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plugin-skills-'));
    const skill = (name: string, body: string) => {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, 'SKILL.md'), body);
    };
    skill('good', '---\nname: good\ndescription: >\n  does a thing\n---\n');
    skill('renamed', '---\nname: other\ndescription: x\n---\n');
    skill('mute', '---\nname: mute\n---\n');
    skill('bare', '# no frontmatter\n');
    mkdirSync(join(dir, 'empty'));
    writeFileSync(join(dir, 'README.md'), '# not a skill\n');

    expect(auditSkills(dir)).toEqual({
      names: ['bare', 'empty', 'good', 'mute', 'renamed'],
      problems: [
        'bare: no frontmatter',
        'empty: no SKILL.md',
        'mute: no description',
        'renamed: name is other',
      ],
    });
  });
});

describe('plugin.json skills (#1210)', () => {
  it('registers the skills directory', () => {
    expect(manifest.skills).toEqual([SKILLS_DIR]);
  });

  it('points at skills that all load', () => {
    for (const rel of manifest.skills ?? []) {
      const { names, problems } = auditSkills(join(REPO_ROOT, rel));
      // A zero denominator is an abstention, not a pass.
      expect(names.length, rel).toBeGreaterThanOrEqual(30);
      expect(problems, rel).toEqual([]);
    }
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
