/**
 * #1753: a local home-directory path is a generic leak.
 *
 * A plan or provenance file written in a worktree tends to record the absolute
 * path of that worktree, and on macOS that path names the local account. The
 * 2026-11-26 audit found 85 of them under docs/changes/** before the gate knew
 * the shape. This suite pins the structural pattern that now catches them, and
 * the placeholder forms the docs were rewritten to, which must stay clean.
 *
 * NOTE FOR EDITORS: this file is itself scanned by the gate it tests, so the
 * offending path is assembled at runtime and never appears as a literal.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'check_removed_symbols.mjs');

/** A made-up local account, joined at runtime so this file stays clean. */
const HOME = ['', 'Users', 'jdoe-example', ''].join('/');

const tempRoots: string[] = [];

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixtureRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'leak-gate-home-'));
  tempRoots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body, 'utf-8');
  }
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf-8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('add', '-A');
  return root;
}

function runGate(root: string): { status: number; stdout: string } {
  const res = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      CANARY_LEAK_SCAN_ROOT: root,
      // A synthetic denylist term, so the run is not DEGRADED.
      CANARY_PROPRIETARY_DENYLIST: 'Zorbatron',
    },
  });
  return { status: res.status ?? -1, stdout: `${res.stdout}${res.stderr}` };
}

describe('#1753 proprietary gate: local home-directory paths', () => {
  it.each([
    ['docs/changes/x/plan.md', `Run from \`${HOME}Github/canary-x/ts\`.\n`],
    [
      'docs/changes/x/provenance.json',
      `{ "worktree": "${HOME}Github/canary-fleet-1" }\n`,
    ],
  ])('fails on a home path in %s', (rel, body) => {
    const { status, stdout } = runGate(fixtureRepo({ [rel]: body }));

    expect(stdout).toContain(rel);
    expect(stdout).toContain('home-directory path');
    expect(status).toBe(1);
  });

  it('passes the placeholder forms the docs were rewritten to', () => {
    const root = fixtureRepo({
      'docs/changes/x/plan.md': [
        'Run from `<repo>/ts`.',
        'The lane worktree is `../canary-fleet-1`.',
        'Paths like `~/Github/canary-x` and `/Users/<local-user>/` are fine.',
        // A CI runner path and a Windows-style test fixture are not a home.
        'at (/home/runner/work/canary/canary/a.ts:1:1)',
        'at file:///C:/Users/fixture/a/b.js:1:1',
        '',
      ].join('\n'),
    });

    const { status, stdout } = runGate(root);

    expect(stdout).toContain('clean');
    expect(status).toBe(0);
  });
});
