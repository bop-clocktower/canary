import { describe, expect, it } from 'vitest';

import {
  makeRunId,
  serializeLocalRecord,
  serializeRun,
  serializeTestResult,
  type RunInput,
  type TestResultInput,
} from './schema.js';

const run: RunInput = {
  run_id: 'api-abc12345-1700000000',
  suite: 'api',
  repo: 'acme/app',
  branch: 'main',
  commit_sha: 'abc12345def',
  timestamp: '2026-06-01T00:00:00Z',
  total: 10,
  passed: 8,
  failed: 1,
  flaky: 1,
  skipped: 0,
};

const result: TestResultInput = {
  run_id: run.run_id,
  suite: 'api',
  repo: 'acme/app',
  test_name: 'test_login',
  test_file: 'tests/test_login.py',
  status: 'flaky',
};

describe('makeRunId', () => {
  it('matches the Python {suite}-{commit[:8]}-{epoch} pattern', () => {
    expect(makeRunId('api', 'abc12345def', 1700000000)).toBe(
      'api-abc12345-1700000000',
    );
  });

  it('truncates the commit to 8 chars', () => {
    expect(makeRunId('e2e', 'deadbeefcafe', 42)).toBe('e2e-deadbeef-42');
  });
});

describe('serializeRun', () => {
  it('emits every RunRecord field with optionals defaulted to null', () => {
    expect(serializeRun(run)).toEqual({
      run_id: 'api-abc12345-1700000000',
      suite: 'api',
      repo: 'acme/app',
      branch: 'main',
      commit_sha: 'abc12345def',
      timestamp: '2026-06-01T00:00:00Z',
      total: 10,
      passed: 8,
      failed: 1,
      flaky: 1,
      skipped: 0,
      commit_message: null,
      env: null,
      base_url: null,
      duration_ms: null,
    });
  });

  it('preserves provided optional fields', () => {
    const out = serializeRun({ ...run, env: 'ci', duration_ms: 1234 });
    expect(out.env).toBe('ci');
    expect(out.duration_ms).toBe(1234);
  });
});

describe('serializeTestResult', () => {
  it('applies retry_count=0 and tags=[] defaults', () => {
    const out = serializeTestResult(result);
    expect(out.retry_count).toBe(0);
    expect(out.tags).toEqual([]);
    expect(out.area).toBeNull();
    expect(out.failure_category).toBeNull();
    expect(out.error_text).toBeNull();
  });
});

describe('serializeLocalRecord', () => {
  it('nests serialized tests under a tests key', () => {
    const record = serializeLocalRecord(run, [result]);
    expect(record.run_id).toBe(run.run_id);
    expect(Array.isArray(record.tests)).toBe(true);
    expect((record.tests as unknown[]).length).toBe(1);
  });
});
