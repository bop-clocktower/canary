/**
 * `canary ci-ready` — the deterministic half of the canary-ci-ready skill.
 *
 * The skill defines five checks. Today only one of them has a real producer
 * behind it: flakiness, read from the run-history store. The other four name
 * inputs nothing in canary writes (no `canary coverage` command exists, and the
 * history store records no durations), so they must report `skip` with the
 * missing input named. They must never pass.
 *
 * The verdict contract these tests pin:
 *   - abstained  (exit 3): every check skipped. "Checked nothing" is not ready.
 *   - not-ready  (exit 1): any check failed.
 *   - incomplete (exit 0): nothing failed, but at least one check skipped.
 *   - ready      (exit 0): all five checks passed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT_ABSTAINED } from '../src/core/gate-result.js';
import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

interface Check {
  name: string;
  verdict: 'pass' | 'warn' | 'fail' | 'skip';
  reason: string;
}
interface Report {
  verdict: 'ready' | 'incomplete' | 'not-ready' | 'abstained';
  checked: number;
  checks: Check[];
}

const HISTORY = join('test-results', 'reports', 'history-v2.jsonl');

/** One stored run per entry; `flakyIn` lists the run indexes where `t1` flaked. */
function writeHistory(
  root: string,
  runs: number,
  flakyIn: number[] = [],
): void {
  mkdirSync(join(root, 'test-results', 'reports'), { recursive: true });
  const lines: string[] = [];
  for (let i = 0; i < runs; i++) {
    const flaky = flakyIn.includes(i);
    lines.push(
      JSON.stringify({
        run_id: `api-${i}`,
        suite: 'api',
        branch: 'main',
        commit_sha: `abc1234${i}`,
        timestamp: `2026-06-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
        total: 1,
        passed: flaky ? 0 : 1,
        failed: 0,
        flaky: flaky ? 1 : 0,
        skipped: 0,
        schema_version: 2,
        tests: [
          {
            test_name: 't1',
            test_file: 'tests/t1.spec.ts',
            status: flaky ? 'flaky' : 'passed',
          },
        ],
      }),
    );
  }
  writeFileSync(join(root, HISTORY), lines.join('\n') + '\n', 'utf-8');
}

function check(report: Report, name: string): Check {
  const c = report.checks.find((x) => x.name === name);
  if (!c) throw new Error(`no check named ${name}`);
  return c;
}

async function runJson(
  root: string,
): Promise<{ code: number; report: Report }> {
  const res = await invokeCanary(['ci-ready', '--root', root, '--json']);
  return { code: res.code, report: JSON.parse(res.stdout) as Report };
}

describe('canary ci-ready', () => {
  let root: string;
  beforeEach(() => {
    root = mkTmp();
  });
  afterEach(() => {
    rmTmp(root);
  });

  it('abstains with exit 3 when no input exists, and never claims readiness', async () => {
    const { code, report } = await runJson(root);
    expect(code).toBe(EXIT_ABSTAINED);
    expect(report.verdict).toBe('abstained');
    expect(report.checked).toBe(0);
    expect(report.checks.map((c) => c.name)).toEqual([
      'coverage-depth',
      'flakiness',
      'assertion-quality',
      'critical-paths',
      'suite-runtime',
    ]);
    expect(report.checks.every((c) => c.verdict === 'skip')).toBe(true);

    const text = await invokeCanary(['ci-ready', '--root', root]);
    expect(text.code).toBe(EXIT_ABSTAINED);
    expect(text.stdout).not.toMatch(/\bready\b(?!ness)/i);
  });

  it('passes flakiness on clean history but reports incomplete, not ready', async () => {
    writeHistory(root, 5);
    const { code, report } = await runJson(root);
    expect(check(report, 'flakiness').verdict).toBe('pass');
    expect(report.checked).toBe(1);
    expect(report.verdict).toBe('incomplete');
    expect(code).toBe(0);
  });

  it('fails flakiness when a test flakes at or above 10% of the window', async () => {
    writeHistory(root, 5, [2]); // 1 of 5 runs = 20%
    const { code, report } = await runJson(root);
    expect(check(report, 'flakiness').verdict).toBe('fail');
    expect(report.verdict).toBe('not-ready');
    expect(code).toBe(1);
  });

  it('warns on flakiness below 10% of the window', async () => {
    writeHistory(root, 20, [7]); // 1 of 20 runs = 5%
    const { code, report } = await runJson(root);
    expect(check(report, 'flakiness').verdict).toBe('warn');
    expect(report.verdict).toBe('incomplete');
    expect(code).toBe(0);
  });

  it('skips flakiness, naming the store, when the history file holds no runs', async () => {
    mkdirSync(join(root, 'test-results', 'reports'), { recursive: true });
    writeFileSync(join(root, HISTORY), '', 'utf-8');
    const { report } = await runJson(root);
    const f = check(report, 'flakiness');
    expect(f.verdict).toBe('skip');
    expect(f.reason).toMatch(/history-v2\.jsonl/);
  });

  it('always skips suite runtime, because the history store records no durations', async () => {
    writeHistory(root, 5);
    const { report } = await runJson(root);
    const r = check(report, 'suite-runtime');
    expect(r.verdict).toBe('skip');
    expect(r.reason).toMatch(/duration/i);
  });

  it('skips the inventory checks and names test-inventory.json as the missing input', async () => {
    mkdirSync(join(root, '.canary'), { recursive: true });
    writeFileSync(
      join(root, '.canary', 'critical-areas.json'),
      JSON.stringify({
        generated: '2026-09-14T00:00:00Z',
        areas: [{ path: 'src/a.ts', risk_score: 0.9, signals: [] }],
      }),
      'utf-8',
    );
    const { report } = await runJson(root);
    for (const name of [
      'coverage-depth',
      'assertion-quality',
      'critical-paths',
    ]) {
      const c = check(report, name);
      expect(c.verdict).toBe('skip');
      expect(c.reason).toMatch(/test-inventory\.json/);
    }
  });
});
