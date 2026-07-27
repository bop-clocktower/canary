/**
 * Regression tests: Sentinel injection scan is scoped to UNTRUSTED sources.
 *
 * Ported from `tests/unit/test_sentinel_source_scope.py`. The prompt-injection
 * scan (sentinel-pre input scan + sentinel-post output scan) should only taint
 * on content from genuinely untrusted sources (WebFetch/WebSearch and
 * third-party MCP tools). Reading/writing/running local repo tools
 * (Read/Grep/Glob/Edit/Write/Bash + first-party MCP) must NOT taint.
 *
 * Injection is triggered with a zero-width space (U+200B → rule INJ-UNI-001) so
 * the test needs no security-phrase literal (which would itself self-taint).
 *
 * Node-gated in the original; node is always present under vitest, so the scan
 * runs unconditionally here.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(REPO, '.harness', 'hooks');
const ZW = String.fromCharCode(0x200b); // zero-width space — INJ-UNI-001 trigger

const tmps: string[] = [];
function tmpPath(): string {
  const d = mkdtempSync(join(tmpdir(), 'canary-sentinel-'));
  tmps.push(d);
  return d;
}
afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

function run(hook: string, payload: unknown, cwd: string): void {
  spawnSync('node', [join(HOOKS, hook)], {
    input: JSON.stringify(payload),
    cwd,
    encoding: 'utf-8',
  });
}

function tainted(cwd: string): boolean {
  const d = join(cwd, '.harness');
  if (!existsSync(d)) return false;
  return readdirSync(d).some(
    (f) => f.startsWith('session-taint-') && f.endsWith('.json'),
  );
}

describe('sentinel-post.js tool-output scan', () => {
  it('trusted Read output does not taint', () => {
    const cwd = tmpPath();
    run(
      'sentinel-post.js',
      { tool_name: 'Read', tool_output: `x${ZW}y`, session_id: 'T' },
      cwd,
    );
    expect(tainted(cwd), 'reading a local file must not taint').toBe(false);
  });

  it('trusted Bash output does not taint', () => {
    const cwd = tmpPath();
    run(
      'sentinel-post.js',
      { tool_name: 'Bash', tool_output: `commit${ZW}msg`, session_id: 'T' },
      cwd,
    );
    expect(tainted(cwd), 'local shell output must not taint').toBe(false);
  });

  it('untrusted WebFetch output taints', () => {
    const cwd = tmpPath();
    run(
      'sentinel-post.js',
      { tool_name: 'WebFetch', tool_output: `x${ZW}y`, session_id: 'T' },
      cwd,
    );
    expect(
      tainted(cwd),
      'untrusted web content injection must still taint',
    ).toBe(true);
  });

  it('untrusted third-party MCP output taints', () => {
    const cwd = tmpPath();
    run(
      'sentinel-post.js',
      {
        tool_name: 'mcp__plugin_github_github__get_me',
        tool_output: `x${ZW}y`,
        session_id: 'T',
      },
      cwd,
    );
    expect(
      tainted(cwd),
      'third-party MCP result injection must still taint',
    ).toBe(true);
  });

  it('first-party MCP output does not taint', () => {
    const cwd = tmpPath();
    run(
      'sentinel-post.js',
      {
        tool_name: 'mcp__harness__run_skill',
        tool_output: `x${ZW}y`,
        session_id: 'T',
      },
      cwd,
    );
    expect(tainted(cwd), 'first-party harness MCP must not taint').toBe(false);
  });
});

describe('sentinel-pre.js tool-input scan', () => {
  it('trusted Write input does not taint', () => {
    const cwd = tmpPath();
    run(
      'sentinel-pre.js',
      {
        tool_name: 'Write',
        tool_input: { file_path: join(cwd, 'f.txt'), content: `a${ZW}b` },
        session_id: 'T',
      },
      cwd,
    );
    expect(tainted(cwd), 'writing local content must not taint').toBe(false);
  });

  it('untrusted MCP input taints', () => {
    const cwd = tmpPath();
    run(
      'sentinel-pre.js',
      {
        tool_name: 'mcp__plugin_github_github__get_me',
        tool_input: { query: `a${ZW}b` },
        session_id: 'T',
      },
      cwd,
    );
    expect(
      tainted(cwd),
      'third-party MCP input injection must still taint',
    ).toBe(true);
  });
});
