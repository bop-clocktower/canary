/**
 * Behavioral tests for the .harness/hooks/*.js quality/routing hooks.
 *
 * Ported from `tests/unit/test_js_hooks_behavior.py` (Gap 5 of #310). Drives the
 * real hook scripts as subprocesses and asserts the exit-code policy:
 *   * quality-warner.js / format-check.js — exit 0 on a clean file and on a
 *     project with no formatter (fail-open), exit 2 on a real lint violation,
 *     exit 0 on empty stdin (fail-open);
 *   * prefer-first-party-mcp.js — injects the routing reminder for a
 *     third-party MCP tool but stays silent for first-party prefixes.
 *
 * ruff-gated assertions are skipped when ruff is absent, matching the original.
 */

import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(REPO, '.harness', 'hooks');

function have(cmd: string): boolean {
  const r = spawnSync(cmd, ['--version'], { encoding: 'utf-8' });
  return !r.error && r.status === 0;
}

const HAVE_RUFF = have('ruff');
const itRuff = HAVE_RUFF ? it : it.skip;

interface Proc {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runHook(hook: string, payload: unknown, cwd: string): Proc {
  const r = spawnSync('node', [join(HOOKS, hook)], {
    input: JSON.stringify(payload),
    cwd,
    encoding: 'utf-8',
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const tmps: string[] = [];
function mkProject(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'canary-hooks-'));
  tmps.push(root);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, name), content, 'utf-8');
  }
  return root;
}

afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

describe('quality-warner.js exit codes', () => {
  it('no formatter config fails open (exit 0)', () => {
    const root = mkProject({ 'whatever.py': 'x = 1\n' });
    const cp = runHook(
      'quality-warner.js',
      { tool_input: { file_path: join(root, 'whatever.py') } },
      root,
    );
    expect(cp.status).toBe(0);
  });

  it('empty stdin fails open (exit 0)', () => {
    const root = mkProject();
    const r = spawnSync('node', [join(HOOKS, 'quality-warner.js')], {
      input: '',
      cwd: root,
      encoding: 'utf-8',
    });
    expect(r.status).toBe(0);
  });

  itRuff('clean file with ruff passes (exit 0)', () => {
    const root = mkProject({
      'ruff.toml': 'line-length = 100\n',
      'clean.py': 'x = 1\n',
    });
    const cp = runHook(
      'quality-warner.js',
      { tool_input: { file_path: join(root, 'clean.py') } },
      root,
    );
    expect(cp.status, cp.stderr).toBe(0);
  });

  itRuff('violating file blocks with exit 2', () => {
    // F401: unused import — a deterministic ruff violation.
    const root = mkProject({
      'ruff.toml': 'line-length = 100\n',
      'bad.py': 'import os\n',
    });
    const cp = runHook(
      'quality-warner.js',
      { tool_input: { file_path: join(root, 'bad.py') } },
      root,
    );
    expect(cp.status, cp.stdout + cp.stderr).toBe(2);
    expect(cp.stderr).toContain('BLOCKED');
  });
});

// --- format-check.js status contract (driver .mjs importing the module) -----

function statusDriver(): { root: string; driver: string } {
  const root = mkProject();
  const fcUrl = pathToFileURL(join(HOOKS, 'format-check.js')).href;
  const driver = join(root, 'driver.mjs');
  writeFileSync(
    driver,
    `import { runFormatCheck } from ${JSON.stringify(fcUrl)};\n` +
      'const input = JSON.parse(process.argv[2]);\n' +
      'const res = runFormatCheck(input, process.argv[3]);\n' +
      'process.stdout.write(res.status);\n',
    'utf-8',
  );
  return { root, driver };
}

function status(driver: string, payload: unknown, cwd: string): string {
  const r = spawnSync('node', [driver, JSON.stringify(payload), cwd], {
    encoding: 'utf-8',
  });
  return (r.stdout ?? '').trim();
}

describe('format-check.js status classification', () => {
  it('no formatter returns clean', () => {
    const { root, driver } = statusDriver();
    writeFileSync(join(root, 'f.py'), 'x = 1\n', 'utf-8');
    expect(
      status(driver, { tool_input: { file_path: join(root, 'f.py') } }, root),
    ).toBe('clean');
  });

  itRuff('ruff violation returns violations', () => {
    const { root, driver } = statusDriver();
    writeFileSync(join(root, 'ruff.toml'), 'line-length = 100\n', 'utf-8');
    writeFileSync(join(root, 'bad.py'), 'import os\n', 'utf-8');
    expect(
      status(driver, { tool_input: { file_path: join(root, 'bad.py') } }, root),
    ).toBe('violations');
  });

  it('file outside project root is skipped (clean)', () => {
    const { root, driver } = statusDriver();
    writeFileSync(join(root, 'ruff.toml'), 'line-length = 100\n', 'utf-8');
    const outside = mkProject();
    const bad = join(outside, 'bad.py');
    writeFileSync(bad, 'import os\n', 'utf-8');
    expect(status(driver, { tool_input: { file_path: bad } }, root)).toBe(
      'clean',
    );
  });

  itRuff('skip beats a real violation', () => {
    const { root, driver } = statusDriver();
    writeFileSync(join(root, 'ruff.toml'), 'line-length = 100\n', 'utf-8');
    const violating = 'import os\n';
    writeFileSync(join(root, 'inside.py'), violating, 'utf-8');
    expect(
      status(
        driver,
        { tool_input: { file_path: join(root, 'inside.py') } },
        root,
      ),
      'control: file is a real violation inside',
    ).toBe('violations');

    const outside = mkProject();
    writeFileSync(join(outside, 'outside.py'), violating, 'utf-8');
    expect(
      status(
        driver,
        { tool_input: { file_path: join(outside, 'outside.py') } },
        root,
      ),
      'same violation outside root is skipped',
    ).toBe('clean');
  });

  itRuff('symlinked root still lints in-repo file', () => {
    const { root, driver } = statusDriver();
    const realroot = join(root, 'realroot');
    mkdirSync(realroot);
    writeFileSync(join(realroot, 'ruff.toml'), 'line-length = 100\n', 'utf-8');
    writeFileSync(join(realroot, 'bad.py'), 'import os\n', 'utf-8');
    const linkroot = join(root, 'linkroot');
    symlinkSync(realroot, linkroot, 'dir');
    expect(
      status(
        driver,
        { tool_input: { file_path: join(linkroot, 'bad.py') } },
        realroot,
      ),
    ).toBe('violations');
  });

  itRuff('dotdot normalizing back inside still lints', () => {
    const { root, driver } = statusDriver();
    writeFileSync(join(root, 'ruff.toml'), 'line-length = 100\n', 'utf-8');
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'real.py'), 'import os\n', 'utf-8');
    const filePath = `${root}${sep}sub${sep}..${sep}real.py`;
    expect(status(driver, { tool_input: { file_path: filePath } }, root)).toBe(
      'violations',
    );
  });

  it('empty/missing file_path falls through, not skipped (clean)', () => {
    const { root, driver } = statusDriver(); // no formatter config present
    for (const payload of [
      { tool_input: { file_path: '' } },
      { tool_input: {} },
      {},
    ]) {
      expect(status(driver, payload, root), JSON.stringify(payload)).toBe(
        'clean',
      );
    }
  });
});

// --- isInsideProject() containment predicate (runs everywhere) --------------

function insideDriver(): string {
  const root = mkProject();
  const fcUrl = pathToFileURL(join(HOOKS, 'format-check.js')).href;
  const driver = join(root, 'inside.mjs');
  writeFileSync(
    driver,
    `import { isInsideProject } from ${JSON.stringify(fcUrl)};\n` +
      'const res = isInsideProject(process.argv[2], process.argv[3]);\n' +
      "process.stdout.write(res ? 'inside' : 'outside');\n",
    'utf-8',
  );
  return driver;
}

function inside(
  driver: string,
  filePath: string,
  cwd: string,
  runCwd?: string,
): string {
  const r = spawnSync('node', [driver, filePath, cwd], {
    encoding: 'utf-8',
    cwd: runCwd,
  });
  return (r.stdout ?? '').trim();
}

describe('isInsideProject containment', () => {
  it('relative in-repo path is inside', () => {
    const driver = insideDriver();
    const root = mkProject({ 'bad.py': 'x = 1\n' });
    expect(inside(driver, 'bad.py', root, root)).toBe('inside');
  });

  it('dotdot escaping root is outside', () => {
    const driver = insideDriver();
    const root = mkProject();
    expect(inside(driver, `${root}${sep}..${sep}evil.py`, root)).toBe(
      'outside',
    );
  });

  it('dotdot normalizing back inside is inside', () => {
    const driver = insideDriver();
    const root = mkProject();
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'real.py'), 'x = 1\n', 'utf-8');
    expect(inside(driver, `${root}${sep}sub${sep}..${sep}real.py`, root)).toBe(
      'inside',
    );
  });

  it('root itself is outside', () => {
    const driver = insideDriver();
    const root = mkProject();
    expect(inside(driver, root, root)).toBe('outside');
  });

  it('sibling dir sharing name prefix is outside', () => {
    const parent = mkProject();
    const repo = join(parent, 'repo');
    mkdirSync(repo);
    const sibling = join(parent, 'repo-sibling');
    mkdirSync(sibling);
    writeFileSync(join(sibling, 'y.py'), 'x = 1\n', 'utf-8');
    const driver = insideDriver();
    expect(inside(driver, join(sibling, 'y.py'), repo)).toBe('outside');
  });

  it('empty file_path is inside', () => {
    const driver = insideDriver();
    const root = mkProject();
    expect(inside(driver, '', root)).toBe('inside');
  });

  it('nonexistent outside path is outside', () => {
    const driver = insideDriver();
    const root = mkProject();
    expect(inside(driver, `${sep}no-such-dir-xyzzy${sep}evil.py`, root)).toBe(
      'outside',
    );
  });

  it('symlinked root in-repo file is inside', () => {
    const driver = insideDriver();
    const root = mkProject();
    const realroot = join(root, 'realroot');
    mkdirSync(realroot);
    writeFileSync(join(realroot, 'bad.py'), 'x = 1\n', 'utf-8');
    const linkroot = join(root, 'linkroot');
    symlinkSync(realroot, linkroot, 'dir');
    expect(inside(driver, join(linkroot, 'bad.py'), realroot)).toBe('inside');
  });
});

// --- classifyError() (#317: prettier 'No parser could be inferred') ---------

function classify(err: unknown): string {
  const root = mkProject();
  const fcUrl = pathToFileURL(join(HOOKS, 'format-check.js')).href;
  const driver = join(root, 'driver.mjs');
  writeFileSync(
    driver,
    `import { classifyError } from ${JSON.stringify(fcUrl)};\n` +
      'const err = JSON.parse(process.argv[2]);\n' +
      'process.stdout.write(classifyError(err));\n',
    'utf-8',
  );
  const r = spawnSync('node', [driver, JSON.stringify(err)], {
    encoding: 'utf-8',
  });
  return (r.stdout ?? '').trim();
}

describe('classifyError no-parser handling', () => {
  it('no parser inferred is infra-error', () => {
    const err = {
      status: 2,
      stdout: '',
      stderr: '[error] No parser could be inferred for file "/x/mod.py".',
    };
    expect(classify(err)).toBe('infra-error');
  });

  it('real prettier violation still blocks', () => {
    const err = {
      status: 1,
      stdout: 'app.js\n',
      stderr:
        '[warn] Code style issues found in the above file. Run Prettier to fix.',
    };
    expect(classify(err)).toBe('violations');
  });
});

// --- prefer-first-party-mcp.js routing nudge --------------------------------

function mcpOut(toolName: string): Proc {
  const tmp = mkProject();
  return runHook('prefer-first-party-mcp.js', { tool_name: toolName }, tmp);
}

describe('prefer-first-party-mcp routing nudge', () => {
  it('third-party MCP gets reminder', () => {
    const cp = mcpOut('mcp__plugin_github_github__get_me');
    expect(cp.status).toBe(0);
    expect(cp.stdout).toContain('Trusted MCP hierarchy');
  });

  it('canary-mcp prefix is trusted silent', () => {
    const cp = mcpOut('mcp__canary-mcp__analyze_file');
    expect(cp.status).toBe(0);
    expect(cp.stdout.trim()).toBe('');
  });

  it('harness prefix is trusted silent', () => {
    expect(mcpOut('mcp__harness__run_skill').stdout.trim()).toBe('');
  });

  it('canary bundle prefix is trusted silent', () => {
    expect(
      mcpOut('mcp__plugin_mcp-bundle_context7__query_docs').stdout.trim(),
    ).toBe('');
  });

  it('non-MCP tool is silent', () => {
    expect(mcpOut('Read').stdout.trim()).toBe('');
  });

  it('another third-party bundle gets reminder', () => {
    expect(mcpOut('mcp__plugin_github_github__search_code').stdout).toContain(
      'Trusted MCP hierarchy',
    );
  });
});
