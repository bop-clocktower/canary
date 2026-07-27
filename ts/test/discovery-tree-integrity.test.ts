/**
 * Regression guard: the on-disk skill / command / agent discovery tree.
 *
 * Ported from `tests/unit/test_discovery_tree_integrity.py` (Gap 3 of #310).
 * Iterates the REAL tree rather than a fixture, so any future skill/command/
 * agent added or renamed is held to the same contract.
 *
 * Contracts enforced:
 *   * every `agents/skills/claude-code/*​/SKILL.md` has parseable YAML
 *     frontmatter carrying a non-empty `name` and `description`;
 *   * every `commands/*.md` references an agent or skill that exists on disk;
 *   * every `@agents/...` reference inside `agents/commands/**` resolves to a
 *     real file on disk.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKILLS_DIR = join(REPO, 'agents', 'skills', 'claude-code');
const COMMANDS_DIR = join(REPO, 'commands');
const AGENT_COMMANDS_DIR = join(REPO, 'agents', 'commands');

// "Use the `canary-foo` agent" / "Use the `canary-foo` skill"
const COMMAND_REF_RE = /Use the [`"']([a-z0-9-]+)[`"'] (?:agent|skill)/;
// "@agents/skills/claude-code/foo/SKILL.md"
const AT_REF_RE = /@(agents\/[\w./-]+)/g;

function isDir(p: string): boolean {
  return existsSync(p) && statSync(p).isDirectory();
}

/** Return the SKILL.md paths under agents/skills/claude-code/​*​/SKILL.md. */
function skillMds(): string[] {
  if (!isDir(SKILLS_DIR)) return [];
  return readdirSync(SKILLS_DIR)
    .map((name) => join(SKILLS_DIR, name, 'SKILL.md'))
    .filter((p) => existsSync(p))
    .sort();
}

/** Parse a `---`-delimited YAML frontmatter block (or null if absent). */
function frontmatter(path: string): Record<string, unknown> | null {
  const text = readFileSync(path, 'utf-8');
  if (!text.startsWith('---')) return null;
  const parts = text.split('---');
  if (parts.length < 3) return null;
  // Python's split('---', 2) → parts[1] is the frontmatter body.
  return (loadYaml(parts[1]) as Record<string, unknown>) ?? {};
}

function existingAgents(): Set<string> {
  return new Set(
    (isDir(join(REPO, 'agents')) ? readdirSync(join(REPO, 'agents')) : [])
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, '')),
  );
}

function existingSkills(): Set<string> {
  return new Set(skillMds().map((p) => relative(SKILLS_DIR, dirname(p))));
}

function markdownFiles(dir: string): string[] {
  if (!isDir(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => join(dir, f))
    .sort();
}

function markdownFilesRecursive(dir: string): string[] {
  if (!isDir(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (isDir(full)) out.push(...markdownFilesRecursive(full));
    else if (entry.endsWith('.md')) out.push(full);
  }
  return out.sort();
}

describe('skill frontmatter', () => {
  it('skill dir is non-empty', () => {
    expect(skillMds().length).toBeGreaterThan(0);
  });

  it('every skill has valid frontmatter with name and description', () => {
    const offenders: string[] = [];
    for (const skillMd of skillMds()) {
      const rel = relative(REPO, skillMd);
      const fm = frontmatter(skillMd);
      if (fm === null) {
        offenders.push(`${rel}: missing/unparseable YAML frontmatter`);
        continue;
      }
      if (!String(fm.name ?? '').trim()) {
        offenders.push(`${rel}: frontmatter has no 'name'`);
      }
      if (!String(fm.description ?? '').trim()) {
        offenders.push(`${rel}: frontmatter has no 'description'`);
      }
    }
    expect(
      offenders,
      `headless/invalid skills:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('skill frontmatter name matches directory', () => {
    const mismatches: string[] = [];
    for (const skillMd of skillMds()) {
      const fm = frontmatter(skillMd) ?? {};
      const name = String(fm.name ?? '').trim();
      const dirName = relative(SKILLS_DIR, dirname(skillMd));
      if (name && name !== dirName) {
        mismatches.push(`${dirName} → declares name '${name}'`);
      }
    }
    expect(mismatches, mismatches.join('\n')).toEqual([]);
  });
});

describe('command references', () => {
  it('command dir is non-empty', () => {
    expect(markdownFiles(COMMANDS_DIR).length).toBeGreaterThan(0);
  });

  it('every command references an existing agent or skill', () => {
    const agents = existingAgents();
    const skills = existingSkills();
    const dangling: string[] = [];
    for (const cmd of markdownFiles(COMMANDS_DIR)) {
      const rel = relative(REPO, cmd);
      const m = COMMAND_REF_RE.exec(readFileSync(cmd, 'utf-8'));
      if (!m) {
        dangling.push(`${rel}: no 'Use the \`X\` agent/skill' reference found`);
        continue;
      }
      const target = m[1];
      if (!agents.has(target) && !skills.has(target)) {
        dangling.push(
          `${rel}: references '${target}' which is neither agent nor skill`,
        );
      }
    }
    expect(
      dangling,
      `dangling command references:\n${dangling.join('\n')}`,
    ).toEqual([]);
  });
});

describe('agent-command @-references', () => {
  it('@agents/... references resolve on disk', () => {
    if (!isDir(AGENT_COMMANDS_DIR)) {
      // Mirrors the Python skipTest — but the dir exists in this repo.
      return;
    }
    const missing: string[] = [];
    let checked = 0;
    for (const cmd of markdownFilesRecursive(AGENT_COMMANDS_DIR)) {
      const text = readFileSync(cmd, 'utf-8');
      for (const match of text.matchAll(AT_REF_RE)) {
        checked += 1;
        const ref = match[1];
        if (!existsSync(join(REPO, ref))) {
          missing.push(`${relative(REPO, cmd)} → @${ref} (missing)`);
        }
      }
    }
    expect(missing, `unresolved @-references:\n${missing.join('\n')}`).toEqual(
      [],
    );
    expect(
      checked,
      'expected at least one @agents/ reference to verify',
    ).toBeGreaterThan(0);
  });
});
