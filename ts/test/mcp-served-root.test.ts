/**
 * Which directory the MCP server serves (and contains every path argument to).
 *
 * Claude Code sets CLAUDE_PLUGIN_ROOT to the plugin's INSTALL directory and
 * CLAUDE_PROJECT_DIR to the user's project, and a plugin-launched server
 * inherits both. Rooting at CLAUDE_PLUGIN_ROOT confines every tool to the
 * plugin cache and refuses every path in the user's project, so the root is
 * `CANARY_PROJECT_ROOT ?? CLAUDE_PROJECT_DIR ?? cwd` and never the plugin dir.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  analyzeFileImpl,
  initSuiteImpl,
  migrateImpl,
  resolveServedRoot,
  writeTestFileImpl,
} from '../src/mcp-server.js';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

describe('resolveServedRoot', () => {
  it('serves CLAUDE_PROJECT_DIR, not CLAUDE_PLUGIN_ROOT, when both are set', () => {
    const plugin = tmp('canary-plugin-');
    const project = tmp('canary-project-');
    const root = resolveServedRoot(
      { CLAUDE_PLUGIN_ROOT: plugin, CLAUDE_PROJECT_DIR: project },
      tmp('canary-cwd-'),
    );
    expect(root).toBe(realpathSync(project));
  });

  it('lets CANARY_PROJECT_ROOT override CLAUDE_PROJECT_DIR', () => {
    const explicit = tmp('canary-explicit-');
    const root = resolveServedRoot(
      {
        CANARY_PROJECT_ROOT: explicit,
        CLAUDE_PROJECT_DIR: tmp('canary-project-'),
      },
      tmp('canary-cwd-'),
    );
    expect(root).toBe(realpathSync(explicit));
  });

  it('falls back to the cwd when neither project variable is set', () => {
    const cwd = tmp('canary-cwd-');
    expect(resolveServedRoot({}, cwd)).toBe(realpathSync(cwd));
  });

  it('never serves the plugin dir, even when it is the only variable set', () => {
    const plugin = tmp('canary-plugin-');
    const cwd = tmp('canary-cwd-');
    const root = resolveServedRoot({ CLAUDE_PLUGIN_ROOT: plugin }, cwd);
    expect(root).not.toBe(realpathSync(plugin));
    expect(root).toBe(realpathSync(cwd));
  });

  it('treats an empty-string variable as unset', () => {
    const project = tmp('canary-project-');
    const cwd = tmp('canary-cwd-');
    expect(
      resolveServedRoot(
        { CANARY_PROJECT_ROOT: '', CLAUDE_PROJECT_DIR: project },
        cwd,
      ),
    ).toBe(realpathSync(project));
    expect(
      resolveServedRoot(
        { CANARY_PROJECT_ROOT: '', CLAUDE_PROJECT_DIR: '' },
        cwd,
      ),
    ).toBe(realpathSync(cwd));
  });

  it('returns an absolute realpath for a relative variable', () => {
    const cwd = tmp('canary-cwd-');
    mkdirSync(join(cwd, 'proj'));
    expect(resolveServedRoot({ CLAUDE_PROJECT_DIR: 'proj' }, cwd)).toBe(
      realpathSync(join(cwd, 'proj')),
    );
  });
});

describe('tools under a plugin-launched environment serve the project', () => {
  function pluginEnvRoot(): { plugin: string; project: string; root: string } {
    const plugin = tmp('canary-plugin-');
    const project = tmp('canary-project-');
    mkdirSync(join(project, '.git'));
    const root = resolveServedRoot(
      { CLAUDE_PLUGIN_ROOT: plugin, CLAUDE_PROJECT_DIR: project },
      tmp('canary-cwd-'),
    );
    return { plugin, project, root };
  }

  it('write_test_file resolves a relative path under the project', () => {
    const { plugin, project, root } = pluginEnvRoot();
    const result = writeTestFileImpl('t/a.spec.ts', 'ok', 'playwright', root);
    expect(result).not.toHaveProperty('error');
    expect(existsSync(join(project, 't', 'a.spec.ts'))).toBe(true);
    expect(readdirSync(plugin)).toEqual([]);
  });

  it('analyze_file accepts an in-project path', () => {
    const { project, root } = pluginEnvRoot();
    writeFileSync(join(project, 'login.ts'), 'export function login() {}\n');
    const result = analyzeFileImpl(join(project, 'login.ts'), root);
    expect(result).not.toHaveProperty('error');
    expect(result['file_functions']).toEqual(['login']);
  });

  it('init_suite accepts an in-project target_dir', () => {
    const { project, root } = pluginEnvRoot();
    const result = initSuiteImpl('vitest', join(project, 'suite'), root);
    expect(result).not.toHaveProperty('error');
    expect(existsSync(join(project, 'suite', 'vitest.config.ts'))).toBe(true);
  });

  it('migrate accepts an in-project target_dir', () => {
    const { project, root } = pluginEnvRoot();
    const result = migrateImpl(project, false, root);
    // Not a harness project, so detection says so -- the point is that the
    // path reached detection instead of being refused as an escape.
    expect(String(result['error'])).not.toContain('escapes');
    expect(String(result['error'])).toContain('harness.config.json');
  });

  it('the registered tool wrappers root at the project, not the plugin', async () => {
    const plugin = tmp('canary-plugin-');
    const project = tmp('canary-project-');
    vi.stubEnv('CANARY_PROJECT_ROOT', '');
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', plugin);
    vi.stubEnv('CLAUDE_PROJECT_DIR', project);
    vi.resetModules();
    const fresh = await import('../src/mcp-server.js');
    const out = fresh.writeTestFileTool({
      file_path: 'w/a.spec.ts',
      content: 'ok',
      framework: 'playwright',
    });
    const parsed = JSON.parse(out.content[0]!.text);
    expect(parsed.error).toBeUndefined();
    expect(existsSync(join(project, 'w', 'a.spec.ts'))).toBe(true);
    expect(readdirSync(plugin)).toEqual([]);
  });
});
