/**
 * Executes the pytest `conftest.py` adapter documented in
 * `docs/guides/order.md` (#1030).
 *
 * The snippet is EXTRACTED FROM THE DOC rather than duplicated here, so the
 * doc is the single source of truth and snippet drift is a test failure. A
 * throwaway pytest suite is written to an OS temp dir (never inside the repo)
 * and `python3 -m pytest` is run for real: a snippet nobody executed is design
 * intent, not capability.
 *
 * Canary ships no Python, so the pytest-executing half is environment-gated.
 * When pytest is missing the gate SAYS SO out loud (a silent skip is a zero
 * denominator reported as a pass), and `CANARY_REQUIRE_PYTEST=1` turns the
 * abstention into a failure — which is what CI sets.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const guide = join(repoRoot, 'docs', 'guides', 'order.md');

/** The one ```python block under "Applying a plan in pytest", or a throw. */
function extractSnippet(): string {
  const md = readFileSync(guide, 'utf-8');
  const start = md.indexOf('\n## Applying a plan in pytest\n');
  if (start === -1) {
    throw new Error(`${guide} has no "## Applying a plan in pytest" section`);
  }
  const after = md.slice(start + 1);
  const next = after.indexOf('\n## ');
  const section = next === -1 ? after : after.slice(0, next);
  const blocks = [...section.matchAll(/```python\n([\s\S]*?)\n```/g)].map(
    (m) => m[1] as string,
  );
  if (blocks.length !== 1) {
    throw new Error(
      `expected exactly 1 \`\`\`python block in the pytest section, found ${blocks.length}`,
    );
  }
  return blocks[0] as string;
}

function probe(args: string[]): { ok: boolean; reason: string } {
  const r = spawnSync('python3', args, { encoding: 'utf-8' });
  if (r.error) return { ok: false, reason: `python3: ${r.error.message}` };
  if (r.status !== 0) {
    return {
      ok: false,
      reason: `python3 ${args.join(' ')} exited ${String(r.status)}`,
    };
  }
  return { ok: true, reason: (r.stdout || '').trim() };
}

function gate(name: string, args: string[]): boolean {
  const { ok, reason } = probe(args);
  if (ok) return true;
  const message =
    `SKIPPED: pytest-executing assertions did not run — ${name} unavailable: ` +
    `${reason}. Set CANARY_REQUIRE_PYTEST=1 to make this a failure.`;
  if (process.env['CANARY_REQUIRE_PYTEST'] === '1') {
    throw new Error(message.replace('SKIPPED', 'FAILED'));
  }
  console.warn(message);
  return false;
}

const hasPython = gate('python3', ['--version']);
const hasPytest = hasPython && gate('pytest', ['-m', 'pytest', '--version']);

describe('the documented pytest conftest snippet', () => {
  it('is the single python block in the doc and defines the hook', () => {
    const snippet = extractSnippet();
    expect(snippet).toContain('pytest_collection_modifyitems');
    expect(snippet).toContain('CANARY_ORDER_PLAN');
  });
});

describe.runIf(hasPython)('the snippet as Python source', () => {
  it('compiles under py_compile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'canary-order-pycompile-'));
    try {
      const file = join(dir, 'conftest.py');
      writeFileSync(file, extractSnippet());
      const r = spawnSync('python3', ['-m', 'py_compile', file], {
        encoding: 'utf-8',
      });
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** `n` from pytest's own `collected n items` line — the real denominator. */
function collectedCount(output: string): number {
  const m = /collected (\d+) items?/.exec(output);
  if (m === null) {
    throw new Error(`pytest reported no collected count:\n${output}`);
  }
  return Number(m[1]);
}

describe.runIf(hasPytest)('applying a plan in a real pytest run', () => {
  let dir = '';

  /** `python3 -m pytest -v`, optionally with a plan. */
  function run(planPath?: string): {
    status: number | null;
    out: string;
    order: string[];
    collected: number;
  } {
    const env = { ...process.env };
    if (planPath === undefined) delete env['CANARY_ORDER_PLAN'];
    else env['CANARY_ORDER_PLAN'] = planPath;
    // `-s` disables pytest's own capture so the snippet's stderr line reaches
    // us; `-p no:randomly` keeps a consumer's shuffle plugin out of the
    // measurement if one happens to be installed.
    const r = spawnSync(
      'python3',
      ['-m', 'pytest', '-v', '-s', '-p', 'no:randomly'],
      { cwd: dir, encoding: 'utf-8', env },
    );
    const out = `${r.stdout}${r.stderr}`;
    const order = [...out.matchAll(/^(test_[a-z]+)\.py::/gm)].map(
      (m) => m[1] as string,
    );
    return {
      status: r.status,
      out,
      order: [...new Set(order)],
      collected: collectedCount(out),
    };
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'canary-order-pytest-'));
    writeFileSync(join(dir, 'conftest.py'), extractSnippet());
    writeFileSync(
      join(dir, 'test_a.py'),
      'def test_a1():\n    assert True\n\n\ndef test_a2():\n    assert True\n',
    );
    writeFileSync(join(dir, 'test_b.py'), 'def test_b1():\n    assert True\n');
    writeFileSync(join(dir, 'test_c.py'), 'def test_c1():\n    assert True\n');
    const plan = {
      entries: [{ test_file: 'test_c.py' }, { test_file: 'test_a.py' }],
    };
    writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan));
    writeFileSync(join(dir, 'garbage.json'), 'not json');
  });

  afterAll(() => {
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  it('loses no test: ordered and unordered report the same count', () => {
    const unordered = run();
    const ordered = run(join(dir, 'plan.json'));
    expect(unordered.collected).toBe(4);
    expect(ordered.collected).toBe(unordered.collected);
    expect(ordered.status).toBe(0);
    expect(unordered.status).toBe(0);
  });

  it('runs plan-named files in plan order, unknown files last', () => {
    expect(run().order).toEqual(['test_a', 'test_b', 'test_c']);
    expect(run(join(dir, 'plan.json')).order).toEqual([
      'test_c',
      'test_a',
      'test_b',
    ]);
  });

  it('leaves order, count and exit code alone for an unreadable plan', () => {
    const unordered = run();
    const garbage = run(join(dir, 'garbage.json'));
    expect(garbage.status).toBe(0);
    expect(garbage.collected).toBe(unordered.collected);
    expect(garbage.order).toEqual(unordered.order);
    expect(garbage.out).toMatch(/canary order/);

    const missing = run(join(dir, 'no-such-plan.json'));
    expect(missing.status).toBe(0);
    expect(missing.order).toEqual(unordered.order);
  });
});
