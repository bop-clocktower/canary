/**
 * The three inventory-backed ci-ready checks (#957). Pure scoring: every input
 * is a parsed value or an abstain reason, so each rule is pinned without a
 * filesystem. The rule that matters most is the zero-denominator one -- an
 * empty inventory, or a scope nothing touches, is a skip, never a pass.
 */
import { describe, expect, it } from 'vitest';

import {
  parseCriticalAreas,
  parseInventory,
  scoreInventoryChecks,
} from '../src/core/inventory-checks.js';
import type { TestInventory } from '../src/core/test-inventory.js';

type Depth = 0 | 1 | 2;

function inv(files: { target: string; depths: Depth[] }[]): TestInventory {
  return {
    schema_version: 1,
    generated: 'now',
    skipped: [],
    files: files.map((f, i) => ({
      path: `tests/f${i}.test.ts`,
      framework: 'vitest',
      targets: [f.target],
      tests: f.depths.map((depth, j) => ({
        name: `t${j}`,
        line: j + 1,
        depth,
      })),
    })),
  };
}

const ok = (inventory: TestInventory) => ({ ok: true as const, inventory });
const areas = (...paths: string[]) => ({
  ok: true as const,
  areas: paths.map((path, i) => ({ path, risk_score: 1 - i / 10 })),
});
const noAreas = {
  ok: false as const,
  reason: 'no .canary/critical-areas.json',
};

function byName(checks: { name: string }[], name: string) {
  return checks.find((c) => c.name === name) as unknown as {
    verdict: string;
    reason: string;
  };
}

describe('parseInventory', () => {
  it('abstains, naming the producer, when the file is missing', () => {
    const r = parseInventory(null);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/canary inventory/);
  });

  it('abstains on invalid JSON and on an unsupported schema_version', () => {
    expect(parseInventory('{nope')).toMatchObject({ ok: false });
    const r = parseInventory(JSON.stringify({ schema_version: 99, files: [] }));
    expect(!r.ok && r.reason).toMatch(/schema_version/);
  });

  it('abstains on a hand-written files entry missing its tests or targets arrays', () => {
    const r = parseInventory(
      JSON.stringify({
        schema_version: 1,
        files: [{ path: 'tests/a.test.ts' }],
      }),
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/malformed files entry/);
  });

  it('accepts a v1 inventory', () => {
    const r = parseInventory(JSON.stringify(inv([])));
    expect(r.ok).toBe(true);
  });
});

describe('parseCriticalAreas', () => {
  it('abstains when missing, and when areas is not a list', () => {
    expect(parseCriticalAreas(null)).toMatchObject({ ok: false });
    expect(parseCriticalAreas('{"areas": 3}')).toMatchObject({ ok: false });
  });

  it('keeps the path and risk score of each area', () => {
    const r = parseCriticalAreas(
      JSON.stringify({ areas: [{ path: 'src/a.ts', risk_score: 0.5 }] }),
    );
    expect(r).toEqual({
      ok: true,
      areas: [{ path: 'src/a.ts', risk_score: 0.5 }],
    });
  });
});

describe('scoreInventoryChecks', () => {
  it('skips all three when the inventory is missing, naming the reason', () => {
    const checks = scoreInventoryChecks(
      { ok: false, reason: 'no inventory; run `canary inventory`' },
      areas('src/a.ts'),
    );
    expect(checks.map((c) => c.verdict)).toEqual(['skip', 'skip', 'skip']);
    for (const c of checks) expect(c.reason).toMatch(/canary inventory/);
  });

  it('treats an inventory with zero tests as an abstention, not a pass', () => {
    const checks = scoreInventoryChecks(ok(inv([])), areas('src/a.ts'));
    expect(checks.every((c) => c.verdict === 'skip')).toBe(true);
    expect(checks[0]!.reason).toMatch(/0 tests/);
  });

  it('scores suite-wide when there are no critical areas, and skips critical-paths', () => {
    const checks = scoreInventoryChecks(
      ok(inv([{ target: 'src/a', depths: [2, 2] }])),
      noAreas,
    );
    expect(byName(checks, 'coverage-depth').verdict).toBe('pass');
    expect(byName(checks, 'coverage-depth').reason).toMatch(/suite-wide/);
    expect(byName(checks, 'assertion-quality').verdict).toBe('pass');
    expect(byName(checks, 'critical-paths').verdict).toBe('skip');
  });

  it('coverage-depth fails when a critical area has depth 0, warns at depth 1', () => {
    const inventory = inv([
      { target: 'src/a', depths: [2] },
      { target: 'src/b', depths: [1] },
    ]);
    const warn = scoreInventoryChecks(
      ok(inventory),
      areas('src/a.ts', 'src/b.ts'),
    );
    expect(byName(warn, 'coverage-depth').verdict).toBe('warn');
    const fail = scoreInventoryChecks(
      ok(inventory),
      areas('src/a.ts', 'src/untested.ts'),
    );
    expect(byName(fail, 'coverage-depth').verdict).toBe('fail');
  });

  it('assertion-quality warns on a minority of weak tests and fails on a majority', () => {
    const minority = inv([{ target: 'src/a', depths: [2, 2, 1] }]);
    expect(
      byName(scoreInventoryChecks(ok(minority), noAreas), 'assertion-quality')
        .verdict,
    ).toBe('warn');
    const majority = inv([{ target: 'src/a', depths: [2, 0, 1] }]);
    expect(
      byName(scoreInventoryChecks(ok(majority), noAreas), 'assertion-quality')
        .verdict,
    ).toBe('fail');
  });

  it('assertion-quality skips when no test touches any critical area', () => {
    const checks = scoreInventoryChecks(
      ok(inv([{ target: 'src/a', depths: [2] }])),
      areas('src/other.ts'),
    );
    expect(byName(checks, 'assertion-quality').verdict).toBe('skip');
  });

  it('critical-paths passes when every top-5 area is covered, warns at one gap, fails at two', () => {
    const inventory = inv([
      { target: 'src/a', depths: [1] },
      { target: 'src/b', depths: [2] },
    ]);
    const pass = scoreInventoryChecks(
      ok(inventory),
      areas('src/a.ts', 'src/b.ts'),
    );
    expect(byName(pass, 'critical-paths').verdict).toBe('pass');
    const warn = scoreInventoryChecks(
      ok(inventory),
      areas('src/a.ts', 'src/x.ts'),
    );
    expect(byName(warn, 'critical-paths').verdict).toBe('warn');
    const fail = scoreInventoryChecks(
      ok(inventory),
      areas('src/x.ts', 'src/y.ts', 'src/a.ts'),
    );
    expect(byName(fail, 'critical-paths').verdict).toBe('fail');
  });

  it('critical-paths only considers the 5 highest-risk areas', () => {
    const inventory = inv([{ target: 'src/a', depths: [2] }]);
    // Six areas: the lowest-risk one is uncovered but outside the top 5.
    const six = areas(
      'src/a.ts',
      'src/a.ts',
      'src/a.ts',
      'src/a.ts',
      'src/a.ts',
      'src/z.ts',
    );
    expect(
      byName(scoreInventoryChecks(ok(inventory), six), 'critical-paths')
        .verdict,
    ).toBe('pass');
  });
});
