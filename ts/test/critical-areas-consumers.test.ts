/**
 * Generated `critical-areas.json` read by what actually consumes it (#1529):
 * katana's CLI and the three engine readers. A file only this repo's own tests
 * can read would be a map nothing follows.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadAreas } from '../src/analysis/enrich/area.js';
import { readRankIndex } from '../src/briefing/inputs.js';
import { parseCriticalAreas } from '../src/core/inventory-checks.js';
import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const KATANA = join(
  REPO_ROOT,
  'agents/skills/claude-code/canary-katana/scripts/cli.mjs',
);

// Copied from agents/skills/test/canary-katana.test.ts.
const PY_REMOVAL = `diff --git a/tests/test_points.py b/tests/test_points.py
index 1111111..2222222 100644
--- a/tests/test_points.py
+++ b/tests/test_points.py
@@ -1,10 +1,6 @@
 import pytest

-def test_earns_points_on_purchase():
-    assert earn(100) == 10
-
-async def test_points_expire():
-    assert True
-
 def test_still_here():
     assert True
`;

function git(
  cwd: string,
  args: string[],
  date = '2020-06-01T00:00:00Z',
): string {
  // GIT_DIR-style variables inside a pre-commit hook would point git at this
  // repository instead of the fixture.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
  );
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    {
      cwd,
      encoding: 'utf-8',
      env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    },
  );
}

function commit(
  root: string,
  files: Record<string, string>,
  date?: string,
): void {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body, 'utf-8');
  }
  git(root, ['add', '-A'], date);
  git(root, ['commit', '-m', 'c', '--allow-empty'], date);
}

interface WrittenArea {
  path: string;
  risk_score: number;
  rank_score: number;
}

it('the command names no agent that does not exist', () => {
  const text = readFileSync(
    join(REPO_ROOT, 'commands/canary-critical-areas.md'),
    'utf-8',
  );
  const agents = [...text.matchAll(/`([\w-]+)` agent/g)].map((m) => m[1]!);
  for (const name of agents) {
    expect(
      existsSync(join(REPO_ROOT, 'agents/agents/claude-code', `${name}.md`)),
    ).toBe(true);
  }
  expect(text).toContain('`canary-critical-areas` skill');
});

describe('generated critical-areas output', () => {
  let root: string;
  let out: string;

  beforeEach(async () => {
    root = mkTmp();
    git(root, ['init', '-q']);
    commit(root, {
      'src/points.py': 'def earn(n):\n    return n // 10\n',
      'src/app.py': 'from src.points import earn\n',
      'tests/test_points.py': 'x = 1\n',
    });
    const res = await invokeCanary(['critical-areas', '--root', root]);
    expect(res.code).toBe(0);
    out = join(root, '.canary', 'critical-areas.json');
  });
  afterEach(() => {
    rmTmp(root);
  });

  const written = (): WrittenArea[] =>
    (JSON.parse(readFileSync(out, 'utf-8')) as { areas: WrittenArea[] }).areas;

  function katana(areasFile: string) {
    const diff = join(root, 'removal.diff');
    writeFileSync(diff, PY_REMOVAL, 'utf-8');
    const res = spawnSync(
      process.execPath,
      [
        KATANA,
        '--repo',
        root,
        '--diff-file',
        diff,
        '--critical-areas',
        areasFile,
        '--json',
        '--no-write',
      ],
      { encoding: 'utf-8' },
    );
    return JSON.parse(res.stdout) as {
      degraded_notice?: string;
      areas: { total: number };
      findings: { kind: string; area: string }[];
    };
  }

  it('makes katana alarm rather than run degraded (criterion 5)', () => {
    const run = katana(out);
    expect(run.degraded_notice).toBeUndefined();
    expect(run.areas.total).toBeGreaterThan(0);
    expect(run.findings).toContainEqual(
      expect.objectContaining({
        kind: 'last-coverage-removed',
        area: 'src/points.py',
      }),
    );
  });

  it('is what the alarm comes from: without it katana degrades', () => {
    const run = katana(join(root, 'missing.json'));
    expect(run.degraded_notice).toBeDefined();
    expect(run.findings).toEqual([]);
  });

  it('reads through parseCriticalAreas (criterion 6)', () => {
    const rows = written();
    expect(rows.length).toBeGreaterThan(0);
    const parsed = parseCriticalAreas(readFileSync(out, 'utf-8'));
    expect(parsed).toEqual({
      ok: true,
      areas: rows.map((a) => ({ path: a.path, risk_score: a.risk_score })),
    });
  });

  it('reads through loadAreas (criterion 6)', () => {
    const rows = written();
    expect(rows.length).toBeGreaterThan(0);
    expect(loadAreas(root).areas.map((a) => a.path)).toEqual(
      rows.map((a) => a.path),
    );
  });

  it('reads through readRankIndex (criterion 6)', () => {
    const rows = written();
    expect(rows.length).toBeGreaterThan(0);
    expect(readRankIndex(root)).toEqual(
      new Map(rows.map((a) => [a.path, a.rank_score])),
    );
  });
});
