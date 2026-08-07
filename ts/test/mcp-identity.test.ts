/**
 * Consistency contract for canary's MCP server identity (issue #309).
 *
 * Ported from `tests/unit/test_mcp_identity.py`. Locks the canonical name —
 * `canary-mcp` — across plugin.json, .mcp.json, marketplace.json, and the
 * harness first-party-MCP trust list, so the identity can't silently drift.
 *
 * v6 note: the `pyproject.toml` console-script assertion is DROPPED (pyproject
 * is being deleted as the repo goes Python-free). All other identity anchors
 * are preserved exactly.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { runCapture } from './subprocess-testkit.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CANONICAL = 'canary-mcp';
const HOOK = join(REPO_ROOT, '.harness', 'hooks', 'prefer-first-party-mcp.js');

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(REPO_ROOT, rel), 'utf-8'));
}

interface HookResult {
  status: number;
  stdout: string;
}

function runHook(toolName: string): HookResult {
  const { status, stdout } = runCapture(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: toolName }),
  });
  return { status, stdout };
}

describe('MCP server identity', () => {
  it('plugin.json declares the canonical server', () => {
    const data = readJson('.claude-plugin/plugin.json') as {
      mcpServers: Record<string, { command: string }>;
    };
    expect(data.mcpServers).toHaveProperty(CANONICAL);
    expect(data.mcpServers[CANONICAL].command).toBe(CANONICAL);
  });

  it('plugin.json carries the canonical-name "//" comment', () => {
    const data = readJson('.claude-plugin/plugin.json') as { '//'?: string };
    expect(data['//']).toBeDefined();
    expect(data['//']).toContain(CANONICAL);
  });

  it('.mcp.json lists the canonical server', () => {
    const data = readJson('.mcp.json') as {
      mcpServers: Record<string, { command: string }>;
    };
    expect(data.mcpServers).toHaveProperty(CANONICAL);
    expect(data.mcpServers[CANONICAL].command).toBe(CANONICAL);
  });

  it('marketplace description names the canonical server', () => {
    const data = readJson('.claude-plugin/marketplace.json') as {
      plugins: Array<{ name: string; description: string }>;
    };
    const canary = data.plugins.find((p) => p.name === 'canary');
    expect(canary).toBeDefined();
    expect(canary!.description).toContain(CANONICAL);
    // The stale "the harness MCP server" phrasing must be gone.
    expect(canary!.description).not.toContain('harness MCP server');
  });
});

describe('prefer-first-party-mcp trust list', () => {
  it('source trusts the canary-mcp prefix', () => {
    const src = readFileSync(HOOK, 'utf-8');
    expect(src).toContain('mcp__canary-mcp__');
  });

  it('canary-mcp call is not nagged', () => {
    const r = runHook('mcp__canary-mcp__write_test_file');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('harness canary call is not nagged', () => {
    const r = runHook('mcp__harness__canary_probe');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('third-party call is nagged', () => {
    const r = runHook('mcp__slack__send_message');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('additionalContext');
  });
});
