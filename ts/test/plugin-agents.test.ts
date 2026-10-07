/**
 * The plugin's agent list is declared, not discovered (issue #1204).
 *
 * With no `agents` key, Claude Code scans `agents/` recursively and names each
 * nested file after its path, so every SKILL.md, generated command and
 * gemini-cli mirror under `agents/` registered as a fake agent type
 * (`canary:skills:claude-code:canary-ship:canary-ship`), a name that looks
 * like a skill but cannot be invoked as one. Declaring `agents` replaces that
 * scan. This test keeps the declaration equal to the real agents: the
 * top-level `agents/*.md` files, no more (nothing nested), no fewer (a new
 * agent cannot be silently left out).
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

const readJson = (rel: string) =>
  JSON.parse(readFileSync(join(REPO_ROOT, rel), 'utf-8'));

const manifest = readJson('.claude-plugin/plugin.json');
const schema = readJson('.claude-plugin/schemas/plugin.schema.json');

/**
 * The top-level agent files under `dir`, in the manifest's `./agents/x.md`
 * form. An agent is a `.md` file whose frontmatter names it; a README or
 * CHANGELOG beside the agents is a document, and must not be demanded in the
 * agent list (declaring it would register a document as an agent).
 */
function agentFiles(dir: string): string[] {
  const isAgent = (f: string) => {
    const text = readFileSync(join(dir, f), 'utf-8');
    const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
    return /^name:\s*\S/m.test(front);
  };
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .filter((f) => statSync(join(dir, f)).isFile())
    .filter(isAgent)
    .map((f) => `./agents/${f}`)
    .sort();
}

const realAgents = agentFiles(join(REPO_ROOT, 'agents'));

describe('agentFiles', () => {
  it('counts a named agent, not a document or a nested agent beside it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plugin-agents-'));
    writeFileSync(join(dir, 'real.md'), '---\nname: real\n---\nbody\n');
    writeFileSync(
      join(dir, 'README.md'),
      '# Agents\n\nname: not frontmatter\n',
    );
    mkdirSync(join(dir, 'skills'));
    writeFileSync(join(dir, 'skills', 'deep.md'), '---\nname: deep\n---\n');
    expect(agentFiles(dir)).toEqual(['./agents/real.md']);
  });
});

describe('plugin.json agents (#1204)', () => {
  it('finds the agents it is checking (a zero denominator is an abstention)', () => {
    expect(realAgents.length).toBeGreaterThanOrEqual(8);
  });

  it('declares agents explicitly, which replaces the recursive agents/ scan', () => {
    expect(Array.isArray(manifest.agents)).toBe(true);
  });

  it('declares exactly the top-level agents/*.md files', () => {
    expect([...manifest.agents].sort()).toEqual(realAgents);
  });

  it('declares nothing nested under agents/', () => {
    for (const p of manifest.agents)
      expect(p, p).toMatch(/^\.\/agents\/[^/]+\.md$/);
  });

  it('has a schema that accepts the array form Claude Code documents', () => {
    const forms = schema.properties.agents.anyOf;
    const array = forms.find((f: { type: string }) => f.type === 'array');
    expect(array).toBeDefined();
    expect(array.items).toEqual(expect.objectContaining({ type: 'string' }));
  });
});
