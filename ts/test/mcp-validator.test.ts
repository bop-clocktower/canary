/**
 * Tests for the `mcp-validator` port (`agent/core/mcp_validator.py`,
 * `tests/unit/test_mcp_validator.py`). Every Python case is preserved. Python's
 * `patch("...Path.home")` is replaced by the module's optional `home` parameter
 * (see the source's Python→TS notes) — each call passes an isolated temp home.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MCPValidationResult,
  buildRegistry,
  collectConfigWarnings,
  validateMcpServers,
} from '../src/core/mcp-validator.js';

let root: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'canary-mcp-root-'));
  home = mkdtempSync(join(tmpdir(), 'canary-mcp-home-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function writeMcpJson(directory: string, servers: string[]): void {
  mkdirSync(directory, { recursive: true });
  const mcpServers: Record<string, unknown> = {};
  for (const k of servers) mcpServers[k] = { command: 'dummy' };
  writeFileSync(
    join(directory, '.mcp.json'),
    JSON.stringify({ mcpServers }),
    'utf-8',
  );
}

function makePluginCache(
  h: string,
  pluginSlug: string,
  serverKeys: string[],
  enabled = true,
  marketplace = 'claude-plugins-official',
): void {
  const pluginDir = join(
    h,
    '.claude',
    'plugins',
    'cache',
    marketplace,
    pluginSlug,
    'v1.0.0',
  );
  mkdirSync(pluginDir, { recursive: true });
  const mcpServers: Record<string, unknown> = {};
  for (const k of serverKeys) mcpServers[k] = { command: 'dummy' };
  writeFileSync(
    join(pluginDir, '.mcp.json'),
    JSON.stringify({ mcpServers }),
    'utf-8',
  );
  const settingsPath = join(h, '.claude', 'settings.json');
  mkdirSync(join(h, '.claude'), { recursive: true });
  writeFileSync(
    settingsPath,
    JSON.stringify({
      enabledPlugins: { [`${pluginSlug}@${marketplace}`]: enabled },
    }),
    'utf-8',
  );
}

describe('validateMcpServers', () => {
  it('registered server from project .mcp.json', () => {
    writeMcpJson(root, ['harness']);
    const results = validateMcpServers(['harness'], root, home);
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('registered');
    expect(results[0]!.source).toContain('project .mcp.json');
  });

  it('not found server', () => {
    const results = validateMcpServers(['nonexistent_server'], root, home);
    expect(results[0]!.status).toBe('not_found');
  });

  it('empty server list returns empty', () => {
    expect(validateMcpServers([], root, home)).toEqual([]);
  });

  // Regression (adversarial review, Divergence A): a valid-JSON-but-non-object
  // top level (a bare array) crashes the Python oracle with an uncaught
  // AttributeError on `data.get(...)`. We consciously diverge: degrade to
  // "no servers" (safer, unreachable via a well-formed config) instead of
  // throwing. Pin the intended behavior so the choice can't silently regress.
  it('degrades (no throw) on a non-object array .mcp.json', () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, '.mcp.json'), JSON.stringify([]), 'utf-8');
    let results!: ReturnType<typeof validateMcpServers>;
    expect(() => {
      results = validateMcpServers(['harness'], root, home);
    }).not.toThrow();
    expect(results[0]!.status).toBe('not_found');
  });

  it('multiple servers mixed results', () => {
    writeMcpJson(root, ['harness']);
    const results = validateMcpServers(
      ['harness', 'missing_server'],
      root,
      home,
    );
    const statuses: Record<string, string> = {};
    for (const r of results) statuses[r.server_id] = r.status;
    expect(statuses['harness']).toBe('registered');
    expect(statuses['missing_server']).toBe('not_found');
  });

  it('home .mcp.json server registered', () => {
    writeMcpJson(home, ['global_server']);
    const results = validateMcpServers(['global_server'], root, home);
    expect(results[0]!.status).toBe('registered');
    expect(results[0]!.source).toContain('~/.mcp.json');
  });

  it('project .mcp.json takes precedence over home', () => {
    writeMcpJson(root, ['shared']);
    writeMcpJson(home, ['shared']);
    const results = validateMcpServers(['shared'], root, home);
    // registered from project (first wins)
    expect(results[0]!.status).toBe('registered');
    expect(results[0]!.source).toContain('project .mcp.json');
  });
});

describe('plugin registry', () => {
  it('enabled plugin server registered', () => {
    makePluginCache(home, 'atlassian', ['atlassian'], true);
    const results = validateMcpServers(
      ['plugin_atlassian_atlassian'],
      root,
      home,
    );
    expect(results[0]!.status).toBe('registered');
    expect(results[0]!.source).toContain('atlassian');
  });

  it('disabled plugin server flagged', () => {
    makePluginCache(home, 'atlassian', ['atlassian'], false);
    const results = validateMcpServers(
      ['plugin_atlassian_atlassian'],
      root,
      home,
    );
    expect(results[0]!.status).toBe('plugin_disabled');
    expect(results[0]!.note).toContain('not enabled');
  });

  it('plugin with multiple server keys', () => {
    makePluginCache(home, 'myplugin', ['alpha', 'beta'], true);
    const registry = buildRegistry(root, home);
    expect(registry.has('plugin_myplugin_alpha')).toBe(true);
    expect(registry.has('plugin_myplugin_beta')).toBe(true);
  });

  it('missing plugins cache is silent', () => {
    const results = validateMcpServers(['plugin_something_server'], root, home);
    expect(results[0]!.status).toBe('not_found');
  });

  it('malformed plugin .mcp.json skipped', () => {
    const pluginDir = join(
      home,
      '.claude',
      'plugins',
      'cache',
      'official',
      'bad',
      'v1',
    );
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, '.mcp.json'), '{broken json', 'utf-8');
    const results = validateMcpServers(['plugin_bad_server'], root, home);
    expect(results[0]!.status).toBe('not_found');
  });
});

describe('config warnings', () => {
  it('malformed project .mcp.json yields warning', () => {
    writeFileSync(join(root, '.mcp.json'), '{not valid json', 'utf-8');
    const warnings = collectConfigWarnings(root, home);
    expect(warnings.some((w) => w.includes('.mcp.json'))).toBe(true);
  });

  it('malformed home .mcp.json yields warning', () => {
    writeFileSync(join(home, '.mcp.json'), '{broken', 'utf-8');
    const warnings = collectConfigWarnings(root, home);
    expect(warnings.some((w) => w.includes('.mcp.json'))).toBe(true);
  });

  it('well-formed .mcp.json has no warnings', () => {
    writeMcpJson(root, ['harness']);
    expect(collectConfigWarnings(root, home)).toEqual([]);
  });

  it('absent .mcp.json has no warnings', () => {
    expect(collectConfigWarnings(root, home)).toEqual([]);
  });

  it('malformed .mcp.json does not crash validateMcpServers', () => {
    writeFileSync(join(root, '.mcp.json'), '{not valid json', 'utf-8');
    const results = validateMcpServers(['harness'], root, home);
    expect(results[0]!.status).toBe('not_found');
  });
});

describe('MCPValidationResult', () => {
  it('dataclass fields', () => {
    const r = new MCPValidationResult(
      'harness',
      'registered',
      'project .mcp.json',
      '',
    );
    expect(r.server_id).toBe('harness');
    expect(r.status).toBe('registered');
  });

  it('defaults', () => {
    const r = new MCPValidationResult('harness', 'not_found');
    expect(r.source).toBe('');
    expect(r.note).toBe('');
  });
});
