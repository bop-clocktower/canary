/**
 * Behavioral tests for the plugin hooks under `hooks/*.mjs` (wired via
 * `.claude-plugin/hooks.json`). Replaces the retired `tests/unit/test_hooks.py`
 * after the Python→Node port (PR-B part 2). Drives each hook as a subprocess and
 * asserts the stdin-JSON → exit-code protocol:
 *   * block-no-verify — exit 2 on `git commit --no-verify`/`-n`, else 0;
 *   * protect-config — exit 2 on a protected Python config, else 0; fail-open 0;
 *   * quality-gate — never blocks (exit 0); runs ruff on .py edits (ruff-gated);
 *   * pre-compact-state — writes the summary file, exit 0;
 *   * dedup — each hook defers (exit 0) when its `.harness/hooks/*.js`
 *     counterpart is present in the project.
 *
 * Hooks run with a temp project as cwd so the harness-JS dedup does not
 * short-circuit the real logic (there is no `.harness/hooks/` there unless a
 * test plants one).
 */

import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(REPO, 'hooks');

function have(cmd: string): boolean {
  const r = spawnSync(cmd, ['--version'], { encoding: 'utf-8' });
  return !r.error && r.status === 0;
}
const itRuff = have('ruff') ? it : it.skip;

function runHook(hook: string, payload: unknown, cwd: string) {
  const r = spawnSync('node', [join(HOOKS, hook)], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    cwd,
    encoding: 'utf-8',
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const tmps: string[] = [];
function mkProject(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-hooks-'));
  tmps.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}
afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

describe('block-no-verify.mjs', () => {
  it('allows an ordinary git command', () => {
    const p = runHook(
      'block-no-verify.mjs',
      { tool_input: { command: 'git status' } },
      mkProject(),
    );
    expect(p.status).toBe(0);
  });

  it('blocks git commit --no-verify', () => {
    const p = runHook(
      'block-no-verify.mjs',
      { tool_input: { command: 'git commit --no-verify -m x' } },
      mkProject(),
    );
    expect(p.status).toBe(2);
    expect(p.stderr).toContain('--no-verify flag detected');
  });

  it('blocks the -n short flag', () => {
    const p = runHook(
      'block-no-verify.mjs',
      { tool_input: { command: 'git commit -n -m x' } },
      mkProject(),
    );
    expect(p.status).toBe(2);
  });

  it('ignores --no-verify inside a quoted string', () => {
    const p = runHook(
      'block-no-verify.mjs',
      { tool_input: { command: "echo 'git commit --no-verify'" } },
      mkProject(),
    );
    expect(p.status).toBe(0);
  });

  it('defers when the harness JS counterpart is present', () => {
    const proj = mkProject({
      '.harness/hooks/block-no-verify.js': '// harness hook',
    });
    const p = runHook(
      'block-no-verify.mjs',
      { tool_input: { command: 'git commit --no-verify -m x' } },
      proj,
    );
    expect(p.status).toBe(0); // deferred, so the bypass is NOT blocked here
  });
});

describe('protect-config.mjs', () => {
  it('allows a non-config file', () => {
    const p = runHook(
      'protect-config.mjs',
      { tool_input: { file_path: 'foo.txt' } },
      mkProject(),
    );
    expect(p.status).toBe(0);
  });

  it('blocks a protected Python config', () => {
    const p = runHook(
      'protect-config.mjs',
      { tool_input: { file_path: '/x/pyproject.toml' } },
      mkProject(),
    );
    expect(p.status).toBe(2);
    expect(p.stderr).toContain('protected config file');
  });

  it('fails open on empty stdin', () => {
    const p = runHook('protect-config.mjs', '', mkProject());
    expect(p.status).toBe(0);
    expect(p.stderr).toContain('fail-open');
  });
});

describe('quality-gate.mjs', () => {
  it('exits 0 (silently) for a non-Python file', () => {
    const p = runHook(
      'quality-gate.mjs',
      { tool_input: { file_path: 'foo.txt' } },
      mkProject(),
    );
    expect(p.status).toBe(0);
    expect(p.stderr).toBe('');
  });

  itRuff('runs ruff on a clean .py edit and never blocks', () => {
    const proj = mkProject({ 'clean.py': 'x = 1\n' });
    const p = runHook(
      'quality-gate.mjs',
      { tool_input: { file_path: join(proj, 'clean.py') } },
      proj,
    );
    expect(p.status).toBe(0);
    expect(p.stderr).toContain('ruff check passed');
  });
});

describe('pre-compact-state.mjs', () => {
  it('writes the summary file and exits 0', () => {
    const proj = mkProject();
    const p = runHook('pre-compact-state.mjs', {}, proj);
    expect(p.status).toBe(0);
    expect(
      existsSync(join(proj, '.harness', 'state', 'pre-compact-summary.json')),
    ).toBe(true);
  });

  it('defers when the harness JS counterpart is present', () => {
    const proj = mkProject({
      '.harness/hooks/pre-compact-state.js': '// harness hook',
    });
    const p = runHook('pre-compact-state.mjs', {}, proj);
    expect(p.status).toBe(0);
    // deferred: no summary written by the plugin hook
    expect(
      existsSync(join(proj, '.harness', 'state', 'pre-compact-summary.json')),
    ).toBe(false);
  });
});
