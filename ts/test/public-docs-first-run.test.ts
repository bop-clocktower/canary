/**
 * Facts a first-time visitor reads, pinned against the files that own them
 * (#1749).
 *
 * canary is public as a showcase, so the README's plugin summary and the wiki's
 * Getting Started page are the first things anyone reads. Both had drifted:
 *
 * - The README said "15 agents, 17 skills … plus the `harness` MCP server"
 *   while `.claude-plugin/plugin.json` shipped 8 agents, 35 skills and
 *   `canary-mcp`. A hard-coded count is a second copy of the manifest, and a
 *   second copy drifts. If a count appears it must equal the manifest's; every
 *   MCP server named must be one the manifest declares.
 * - The wiki still taught the retired Python install (`pip install -e .`, with
 *   no `pyproject.toml` to install) and sent readers to `/canary:generate`,
 *   which never existed as a command.
 *
 * Offline: reads files only.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf-8');

interface Manifest {
  agents: string[];
  skills: string[];
  mcpServers: Record<string, unknown>;
}
const manifest = JSON.parse(read('.claude-plugin/plugin.json')) as Manifest;

/** The README's `### Claude Code plugin` section, up to the next heading. */
function pluginSection(): string {
  const readme = read('README.md');
  const start = readme.indexOf('### Claude Code plugin');
  expect(start, 'README has a Claude Code plugin section').toBeGreaterThan(-1);
  const body = readme.slice(readme.indexOf('\n', start) + 1);
  const end = body.search(/^#{2,3} /m);
  const section = end === -1 ? body : body.slice(0, end);
  expect(section.trim(), 'plugin section has a body').not.toBe('');
  return section;
}

const wikiPages = readdirSync(join(REPO_ROOT, 'docs', 'wiki'))
  .filter((f) => f.endsWith('.md'))
  .map((f) => `docs/wiki/${f}`);

describe('README plugin summary', () => {
  it('states no agent or skill count the manifest does not have', () => {
    const text = pluginSection();
    for (const m of text.matchAll(/(\d+)\s+agents\b/g)) {
      expect(Number(m[1]), 'agent count').toBe(manifest.agents.length);
    }
    for (const m of text.matchAll(/(\d+)\s+skills\b/g)) {
      expect(Number(m[1]), 'skill count').toBe(manifest.skills.length);
    }
  });

  it('names only MCP servers the manifest declares, and all of them', () => {
    const text = pluginSection();
    const named = [...text.matchAll(/`([\w-]+)` MCP server/g)].map((m) => m[1]);
    for (const server of named) {
      expect(Object.keys(manifest.mcpServers)).toContain(server);
    }
    for (const server of Object.keys(manifest.mcpServers)) {
      expect(text).toContain(`\`${server}\``);
    }
  });
});

describe('wiki first-run path', () => {
  it('has pages to check (a zero denominator is not a pass)', () => {
    expect(wikiPages.length).toBeGreaterThan(0);
  });

  it.each(wikiPages)('%s teaches no retired Python install', (page) => {
    const text = read(page);
    expect(text).not.toMatch(/\bpipx? install\b/);
    expect(text).not.toMatch(/\bpython3? scripts\/\S+\.py\b/);
  });
});

describe('slash commands in public docs exist', () => {
  const commands = new Set(
    readdirSync(join(REPO_ROOT, 'commands'))
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, '')),
  );
  const skillDir = join(REPO_ROOT, 'agents', 'skills', 'claude-code');
  const skills = new Set(readdirSync(skillDir));
  const skillPages = [...skills]
    .filter((s) => existsSync(join(skillDir, s, 'SKILL.md')))
    .map((s) => `agents/skills/claude-code/${s}/SKILL.md`);
  // A `/canary-...` preceded by a path character is a file path or URL, not a
  // slash command (`../../../canary-flake-hunter.md`, `bop-clocktower/canary`).
  const SLASH = /(?:^|[^\w./-])\/(canary(?:-[\w-]+|:[\w-]+))/g;

  it('found commands and skill pages to check against', () => {
    expect(commands.size).toBeGreaterThan(0);
    expect(skillPages.length).toBeGreaterThan(0);
  });

  it.each(['README.md', ...wikiPages, ...skillPages])(
    '%s only names real slash commands',
    (page) => {
      for (const m of read(page).matchAll(SLASH)) {
        const ref = m[1] ?? '';
        if (ref.startsWith('canary:')) {
          // Plugin-namespaced form: `/canary:<command-or-skill>`.
          const name = ref.slice('canary:'.length);
          expect(
            commands.has(name) || skills.has(name),
            `/${ref} is a command or skill`,
          ).toBe(true);
        } else {
          expect(commands.has(ref), `/${ref} is a command`).toBe(true);
        }
      }
    },
  );
});
