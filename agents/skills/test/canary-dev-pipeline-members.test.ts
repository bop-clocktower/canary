/**
 * canary-dev-pipeline (#666) -- the four deterministic members and the budget
 * loop. Each member composes an existing skill (spec Q1/Q2): the
 * critical-areas map through katana's loader, katana's tie predicate, and the
 * savant and blackhawk static scanners. Fixtures are synthetic; scanner
 * positives live inside string literals, so this file does not trip the
 * repo's own strict dogfood scans.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  MAP_REL,
  loadMap,
  riskMember,
  tiesMember,
} from '../claude-code/canary-dev-pipeline/scripts/members.mjs';
import {
  isolationMember,
  temporalMember,
} from '../claude-code/canary-dev-pipeline/scripts/scans.mjs';
import { runMembers } from '../claude-code/canary-dev-pipeline/scripts/budget.mjs';

const tmps: string[] = [];
function tmp(): string {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'canary-devpipe-m-')),
  );
  tmps.push(dir);
  return dir;
}

afterEach(() => {
  while (tmps.length) {
    fs.rmSync(tmps.pop()!, { recursive: true, force: true });
  }
});

function write(dir: string, rel: string, lines: string[]): void {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
}

type Kind = 'source' | 'test' | 'other';
const file = (p: string, kind: Kind) => ({ path: p, kind });

function ctxFor(root: string, files: { path: string; kind: Kind }[]) {
  return { root, files };
}

function writeMap(root: string, areas: unknown[]): void {
  write(root, MAP_REL, [
    JSON.stringify({
      version: 1,
      generated: '2026-11-01T00:00:00Z',
      areas,
    }),
  ]);
}

describe('loadMap', () => {
  it('names the command that creates a missing map', () => {
    const m = loadMap(tmp());
    expect(m.available).toBe(false);
    expect(m.reason).toMatch(/canary critical-areas/);
  });

  it('is unavailable, not throwing, on a malformed map', () => {
    const root = tmp();
    write(root, MAP_REL, ['{ nope']);
    const m = loadMap(root);
    expect(m.available).toBe(false);
    expect(m.reason).toMatch(/malformed/);
  });
});

describe('riskMember (canary-critical-areas map)', () => {
  it('is not-checked without a map', () => {
    const root = tmp();
    const r = riskMember.run(ctxFor(root, [file('src/a.ts', 'source')]));
    expect(r.status).toBe('not-checked');
    expect(r.checked).toBe(0);
  });

  it('lists changed files found in the map, highest risk first', () => {
    const root = tmp();
    writeMap(root, [
      { path: 'src/low.ts', risk_score: 0.2 },
      { path: 'src/high.ts', risk_score: 0.9 },
      { path: 'src/untouched.ts', risk_score: 0.95 },
    ]);
    const r = riskMember.run(
      ctxFor(root, [
        file('src/low.ts', 'source'),
        file('src/high.ts', 'source'),
        file('src/new.ts', 'source'),
      ]),
    );
    expect(r.status).toBe('ran');
    expect(r.checked).toBe(3);
    expect(r.rows).toEqual([
      { path: 'src/high.ts', risk_score: 0.9 },
      { path: 'src/low.ts', risk_score: 0.2 },
    ]);
  });

  it('is not-checked when the target holds no source file', () => {
    const root = tmp();
    writeMap(root, []);
    const r = riskMember.run(ctxFor(root, [file('README.md', 'other')]));
    expect(r.status).toBe('not-checked');
    expect(r.reason).toMatch(/no source file/);
  });
});

describe('tiesMember (katana tie rules)', () => {
  function fixture(): string {
    const root = tmp();
    write(root, 'src/cart.ts', ['export const add = () => 1;']);
    write(root, 'src/orphan.ts', ['export const lonely = 1;']);
    write(root, 'tests/cart.test.ts', [
      "import { add } from '../src/cart';",
      "it('adds', () => { add(); });",
    ]);
    return root;
  }

  it('reports a tied source with its test and an untied one as a gap', () => {
    const root = fixture();
    const r = tiesMember.run(
      ctxFor(root, [
        file('src/cart.ts', 'source'),
        file('src/orphan.ts', 'source'),
      ]),
    );
    expect(r.status).toBe('ran');
    expect(r.checked).toBe(2);
    expect(r.rows).toEqual([
      {
        path: 'src/orphan.ts',
        tied: false,
        tests: [],
        test_count: 0,
      },
      {
        path: 'src/cart.ts',
        tied: true,
        tests: ['tests/cart.test.ts'],
        test_count: 1,
      },
    ]);
    expect((r as { detail?: string }).detail).toMatch(
      /1 test file\(s\) indexed/,
    );
  });

  it('is not-checked when no source file changed', () => {
    const r = tiesMember.run(
      ctxFor(fixture(), [file('tests/cart.test.ts', 'test')]),
    );
    expect(r.status).toBe('not-checked');
  });
});

describe('isolation and temporal members (savant, blackhawk)', () => {
  function fixture(): string {
    const root = tmp();
    write(root, 'tests/leaky.test.ts', [
      'const cache = {};',
      "it('a', () => { cache['k'] = 1; });",
      "it('b', () => { const t = Date.now(); expect(t).toBeTruthy(); });",
    ]);
    write(root, 'tests/clean.test.ts', ["it('c', () => {});"]);
    return root;
  }

  it('savant reports a module mutable with a repo-relative path', () => {
    const root = fixture();
    const r = isolationMember.run(
      ctxFor(root, [
        file('tests/leaky.test.ts', 'test'),
        file('tests/clean.test.ts', 'test'),
      ]),
    );
    expect(r.status).toBe('ran');
    expect(r.checked).toBe(2);
    expect(r.rows[0]).toMatchObject({
      file: 'tests/leaky.test.ts',
      line: 1,
      rule_id: 'SV001-module-mutable-global',
    });
  });

  it('blackhawk reports a wall-clock read', () => {
    const root = fixture();
    const r = temporalMember.run(
      ctxFor(root, [file('tests/leaky.test.ts', 'test')]),
    );
    expect(r.checked).toBe(1);
    expect(r.rows.map((f: { rule_id: string }) => f.rule_id)).toContain(
      'BH001-wall-clock',
    );
    expect(r.rows[0].file).toBe('tests/leaky.test.ts');
  });

  it('both are not-checked when no test file changed', () => {
    const ctx = ctxFor(tmp(), [file('src/a.ts', 'source')]);
    expect(isolationMember.run(ctx).status).toBe('not-checked');
    expect(temporalMember.run(ctx).status).toBe('not-checked');
  });
});

describe('runMembers (time budget)', () => {
  const member = (name: string, checked = 1) => ({
    name,
    skill: `canary-${name}`,
    run: () => ({ status: 'ran', checked, reason: null, rows: [] }),
  });

  it('runs every member inside the budget', () => {
    const out = runMembers({}, [member('a'), member('b')], {
      clock: () => 0,
      budgetMs: 100,
    });
    expect(out.map((m) => m.status)).toEqual(['ran', 'ran']);
    expect(out[0]).toMatchObject({ name: 'a', skill: 'canary-a' });
  });

  it('reports members after the budget as not run, and keeps going to render', () => {
    let t = 0;
    const slow = {
      ...member('slow'),
      run: () => {
        t += 500;
        return { status: 'ran', checked: 1, reason: null, rows: [] };
      },
    };
    const out = runMembers({}, [slow, member('late'), member('later')], {
      clock: () => t,
      budgetMs: 100,
    });
    expect(out.map((m) => m.status)).toEqual(['ran', 'budget', 'budget']);
    expect(out[1].reason).toMatch(/time budget spent/);
    expect(out[1].checked).toBe(0);
  });

  it('turns a throwing member into an error row and runs the rest', () => {
    const boom = {
      ...member('boom'),
      run: () => {
        throw new Error('kaput\nline two');
      },
    };
    const out = runMembers({}, [boom, member('ok')], {
      clock: () => 0,
      budgetMs: 100,
    });
    expect(out[0]).toMatchObject({ status: 'error', checked: 0 });
    expect(out[0].reason).toMatch(/kaput/);
    expect(out[1].status).toBe('ran');
  });
});
