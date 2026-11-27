/**
 * `ciReadyReportFor` (#855): the readiness report for a root, callable without
 * the `ci-ready` command, so `canary evidence export` scores through the same
 * code path instead of a copy. Fixtures are synthetic.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ciReadyReportFor } from '../src/ci-ready-cli.js';
import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

let root: string;

beforeEach(() => {
  root = mkTmp();
});

afterEach(() => rmTmp(root));

function recordRun(): void {
  const dir = join(root, 'test-results', 'reports');
  const path = join(dir, 'history-v2.jsonl');
  mkdirSync(dir, { recursive: true });
  const run = {
    run_id: 'r1',
    suite: 'api',
    timestamp: '2026-03-01T00:00:00.000Z',
    total: 1,
    passed: 1,
    duration_ms: 1000,
    schema_version: 3,
    tests: [{ test_name: 't1', status: 'passed' }],
  };
  writeFileSync(path, `${JSON.stringify(run)}\n`);
}

describe('ciReadyReportFor', () => {
  it('abstains with five skipped checks for a root holding no input', () => {
    const report = ciReadyReportFor(root);
    expect(report.verdict).toBe('abstained');
    expect(report.checked).toBe(0);
    expect(report.checks).toHaveLength(5);
  });

  it('scores the checks whose input exists under the root', () => {
    recordRun();
    const report = ciReadyReportFor(root);
    expect(report.checked).toBeGreaterThan(0);
    const runtime = report.checks.find((c) => c.name === 'suite-runtime');
    expect(runtime?.verdict).toBe('pass');
  });

  it('is the report the ci-ready command prints', async () => {
    recordRun();
    const res = await invokeCanary(['ci-ready', '--root', root, '--json']);
    const printed = JSON.parse(res.stdout) as Record<string, unknown>;
    const { observed_at: _observedAt, ...rest } = printed;
    expect(rest).toEqual(JSON.parse(JSON.stringify(ciReadyReportFor(root))));
  });
});
