/**
 * `npm/scripts/sync-gate-result.mjs --check` is npm's `pretest` drift gate
 * for the mirrored engine modules. When it cannot read an engine source under
 * `ts/src/core/` it used to return 0 with no output, which is right for a
 * tree with no engine sources at all but a silent false green inside the
 * repo, where a renamed or unreadable source means the gate checked nothing
 * (#1196, sibling of #1189).
 *
 * Each case copies the script into a throwaway tree so the presence of the
 * repo markers (`ts/package.json`, `.git`) is the one variable under test.
 */

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'npm', 'scripts', 'sync-gate-result.mjs');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** A tree holding the script and a mirror copy, but no engine sources. */
function treeWithoutEngineSources(): string {
  const tree = mkdtempSync(join(tmpdir(), 'sync-gate-result-'));
  dirs.push(tree);
  mkdirSync(join(tree, 'npm', 'scripts'), { recursive: true });
  mkdirSync(join(tree, 'npm', 'src'), { recursive: true });
  writeFileSync(join(tree, 'npm', 'src', 'gate-result.ts'), 'anything\n');
  copyFileSync(SCRIPT, join(tree, 'npm', 'scripts', 'sync-gate-result.mjs'));
  return tree;
}

function check(tree: string) {
  const result = spawnSync(
    process.execPath,
    [join(tree, 'npm', 'scripts', 'sync-gate-result.mjs'), '--check'],
    { encoding: 'utf-8' },
  );
  return { status: result.status, output: result.stdout + result.stderr };
}

describe('sync-gate-result --check with a missing engine source (#1196)', () => {
  it('abstains loudly (exit 3) inside a repo marked by ts/package.json', () => {
    const tree = treeWithoutEngineSources();
    mkdirSync(join(tree, 'ts'));
    writeFileSync(join(tree, 'ts', 'package.json'), '{}\n');

    const { status, output } = check(tree);

    expect(status).toBe(3);
    expect(output).toMatch(/ABSTAINED/);
    expect(output).toContain(join('ts', 'src', 'core', 'gate-result.ts'));
    expect(output).toContain(join('ts', 'src', 'core', 'test-shapes.ts'));
  });

  it('abstains loudly (exit 3) inside a repo marked by .git', () => {
    const tree = treeWithoutEngineSources();
    mkdirSync(join(tree, '.git'));

    expect(check(tree).status).toBe(3);
  });

  it('lets a real drift outrank the abstention (exit 1)', () => {
    const tree = treeWithoutEngineSources();
    mkdirSync(join(tree, 'ts', 'src', 'core'), { recursive: true });
    writeFileSync(join(tree, 'ts', 'package.json'), '{}\n');
    writeFileSync(join(tree, 'ts', 'src', 'core', 'gate-result.ts'), 'a\n');

    const { status, output } = check(tree);

    expect(status).toBe(1);
    expect(output).toMatch(/has drifted/);
    expect(output).toContain(join('ts', 'src', 'core', 'test-shapes.ts'));
  });

  it('still passes outside a repo, but says the check was skipped', () => {
    const tree = treeWithoutEngineSources();

    const { status, output } = check(tree);

    expect(status).toBe(0);
    expect(output).toMatch(/skipped/);
  });
});
