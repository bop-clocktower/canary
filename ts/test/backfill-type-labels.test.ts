/**
 * Contract tests for `scripts/backfill-type-labels.mjs` (#880).
 *
 * Roadmap sync files issues with `harness-managed` and no type label, so
 * roadmap-fleet's metadata routing step can never fire for them. The backfill
 * infers one type label per untyped open issue. These tests pin the contract
 * that matters for a tool that writes to a live tracker:
 *
 *   - dry run is the default and never calls `gh issue edit`
 *   - `--apply` only ever ADDS a label (no `--remove-label`, ever)
 *   - issues that already carry a type label are left alone
 *   - zero harness-managed issues examined = exit 3 (abstention, not a pass)
 *
 * Run as a subprocess against fixture files, like roadmap-groom.test.ts, so a
 * plain `.mjs` stays out of the typecheck graph. `BACKFILL_GH_STUB` points the
 * script at a node stub that records its argv instead of reaching GitHub.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCapture } from './subprocess-testkit.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'backfill-type-labels.mjs');

type Issue = { number: number; title: string; body: string; labels: string[] };

let dir: string;
let calls: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canary-backfill-'));
  calls = join(dir, 'gh-calls.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(issues: Issue[], args: string[] = []) {
  const file = join(dir, 'issues.json');
  const json = issues.map((i) => ({
    ...i,
    labels: i.labels.map((name) => ({ name })),
  }));
  writeFileSync(file, JSON.stringify(json));
  const stub = join(dir, 'gh-stub.mjs');
  writeFileSync(
    stub,
    `import { appendFileSync } from 'node:fs';\n` +
      `appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`,
  );
  return runCapture(
    process.execPath,
    [SCRIPT, '--issues-json', file, ...args],
    { env: { ...process.env, BACKFILL_GH_STUB: stub } },
  );
}

function ghCalls(): string[][] {
  if (!existsSync(calls)) return [];
  return readFileSync(calls, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as string[]);
}

const managed = (
  n: number,
  title: string,
  body = '',
  extra: string[] = [],
) => ({
  number: n,
  title,
  body,
  labels: ['harness-managed', ...extra],
});

describe('inference', () => {
  it('infers bug from a defect-shaped title', () => {
    const r = run(
      [managed(1, 'Guardian crashes when the diff is empty')],
      ['--json'],
    );
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.plan).toEqual([
      expect.objectContaining({ number: 1, label: 'bug' }),
    ]);
  });

  it('infers chore from maintenance wording', () => {
    const r = run([managed(2, 'Bump the harness CLI pin to 12')], ['--json']);
    expect(JSON.parse(r.stdout).plan[0].label).toBe('chore');
  });

  it('infers bug from the body when the title is neutral', () => {
    const r = run(
      [managed(3, 'Coverage headline', 'This is a regression since #900.')],
      ['--json'],
    );
    expect(JSON.parse(r.stdout).plan[0].label).toBe('bug');
  });

  it('defaults to enhancement and says so in the reason', () => {
    const r = run([managed(4, 'canary-ivy — suite pruning')], ['--json']);
    const [item] = JSON.parse(r.stdout).plan;
    expect(item.label).toBe('enhancement');
    expect(item.reason).toMatch(/default/);
  });
});

describe('selection', () => {
  it('skips issues that already carry a type label', () => {
    const r = run(
      [managed(5, 'Fix a bug', '', ['enhancement']), managed(6, 'Fix crash')],
      ['--json'],
    );
    const out = JSON.parse(r.stdout);
    expect(out.examined).toBe(2);
    expect(out.plan.map((p: { number: number }) => p.number)).toEqual([6]);
  });

  it('ignores issues without harness-managed', () => {
    const r = run(
      [
        { number: 7, title: 'Fix crash', body: '', labels: [] },
        managed(8, 'New skill'),
      ],
      ['--json'],
    );
    const out = JSON.parse(r.stdout);
    expect(out.examined).toBe(1);
    expect(out.plan).toHaveLength(1);
  });
});

describe('writes', () => {
  it('dry run is the default and never calls gh', () => {
    const r = run([managed(9, 'Fix crash')]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/dry run/i);
    expect(r.stdout).toContain('#9');
    expect(ghCalls()).toEqual([]);
  });

  it('--apply adds exactly one label per planned issue and never removes', () => {
    const r = run(
      [managed(10, 'Fix crash'), managed(11, 'New skill')],
      ['--apply'],
    );
    expect(r.status).toBe(0);
    const argv = ghCalls();
    expect(argv).toEqual([
      ['issue', 'edit', '10', '--add-label', 'bug'],
      ['issue', 'edit', '11', '--add-label', 'enhancement'],
    ]);
    expect(argv.flat()).not.toContain('--remove-label');
  });
});

describe('denominator', () => {
  it('exits 3 when no harness-managed issue was examined', () => {
    const r = run([{ number: 12, title: 'x', body: '', labels: [] }]);
    expect(r.status).toBe(3);
    expect(r.output).toMatch(/zero denominator/i);
  });

  it('exits 0 with an empty plan when every managed issue is already typed', () => {
    const r = run([managed(13, 'x', '', ['bug'])], ['--json']);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.examined).toBe(1);
    expect(out.plan).toEqual([]);
  });

  it('exits 2 on an unknown flag', () => {
    const r = run([managed(14, 'x')], ['--bogus']);
    expect(r.status).toBe(2);
  });
});
