/**
 * #1566 item 2: failure text is redacted at the history WRITE boundary, so
 * neither the local NDJSON store nor `canary history push` (the remote
 * Supabase upsert) keeps a credential, raw ANSI, or an out-of-repo absolute
 * path. Same rule set as the TestTracker path (#1354).
 *
 * Every planted value is assembled at runtime from obviously fake parts, so
 * this file holds no credential-shaped literal for a scanner to trip on.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readVitestReport } from '../src/history/formats/vitest-report.js';
import { NdjsonHistoryStore } from '../src/history/ndjson-store.js';
import {
  serializeTestResult,
  type RunInput,
  type TestResultInput,
} from '../src/history/schema.js';
import { SupabaseHistoryStore } from '../src/history/supabase-store.js';

const EMAIL = ['qa.member+fixture', 'example.test'].join('@');
const b64url = (s: string) => Buffer.from(s).toString('base64url');
const JWT = [
  b64url('{"alg":"none"}'),
  b64url('{"sub":"fixture-member","iat":1}'),
  b64url('not-a-real-signature-just-fixture-bytes'),
].join('.');
const BARE = 'Fx7'.repeat(12);
const NAMED_VALUE = ['fixture', 'pass', 'phrase', '42'].join('-');
const ESC = String.fromCharCode(27);
const RED = `${ESC}[31m`;
const RESET = `${ESC}[39m`;
// A path that cannot be under the test's cwd: a home directory naming a user.
const OUT_OF_REPO = '/nonexistent-root/home/fixture-user/lib/helper.js';

const leaks = (text: string) =>
  [EMAIL, JWT, BARE, NAMED_VALUE, ESC, 'fixture-user'].filter((v) =>
    text.includes(v),
  );

const run: RunInput = {
  run_id: 'api-abc12345-1',
  suite: 'api',
  repo: 'acme/app',
  branch: 'main',
  commit_sha: 'abc12345',
  timestamp: '2026-06-01T00:00:00Z',
  total: 1,
  passed: 0,
  failed: 1,
  flaky: 0,
  skipped: 0,
};

const failing = (error_text: string): TestResultInput => ({
  run_id: run.run_id,
  suite: 'api',
  repo: 'acme/app',
  test_name: 'logs in',
  test_file: 'tests/login.spec.ts',
  status: 'failed',
  error_text,
});

const dirty =
  `${RED}login as ${EMAIL} failed${RESET}; Bearer ${JWT}; key ${BARE}; ` +
  `typed ${NAMED_VALUE}\n    at helper (${OUT_OF_REPO}:3:9)`;

beforeEach(() => {
  vi.stubEnv('CANARY_INGEST_REDACT_ENV', 'MEMBER_PASSWORD');
  vi.stubEnv('MEMBER_PASSWORD', NAMED_VALUE);
});
afterEach(() => vi.unstubAllEnvs());

describe('history write boundary redacts error_text (#1566)', () => {
  it('serializeTestResult redacts credentials, ANSI and out-of-repo paths', () => {
    const out = String(serializeTestResult(failing(dirty)).error_text);
    expect(leaks(out)).toEqual([]);
    expect(out).toContain('login as <email> failed;');
    expect(out).toContain('Bearer <token>;');
    expect(out).toContain('key <token>;');
    expect(out).toContain('typed <secret:MEMBER_PASSWORD>');
    expect(out).toContain('at helper (<path>/helper.js:3:9)');
  });

  it('an in-repo absolute path is rewritten repo-relative, not hidden', () => {
    const inRepo = join(process.cwd(), 'tests', 'login.spec.ts');
    const out = serializeTestResult(failing(`at t (${inRepo}:4:2)`)).error_text;
    expect(out).toBe('at t (tests/login.spec.ts:4:2)');
  });

  it('a null error_text stays null', () => {
    const row = serializeTestResult({ ...failing(''), error_text: null });
    expect(row.error_text).toBeNull();
  });

  describe('local NDJSON store', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'canary-redact-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('writes the redacted text to history-v2.jsonl', () => {
      const path = join(dir, 'history-v2.jsonl');
      new NdjsonHistoryStore(path).pushRun(run, [failing(dirty)]);
      const line = readFileSync(path, 'utf-8');
      expect(leaks(line)).toEqual([]);
      expect(line).toContain('<email>');
    });
  });

  describe('remote store (history push)', () => {
    it('upserts the redacted text, and redacts BEFORE the 2000-char cut', async () => {
      const upserts: unknown[] = [];
      const builder = {
        upsert: (rows: unknown) => {
          upserts.push(rows);
          return Promise.resolve({ data: null, error: null });
        },
      };
      const client = { from: () => builder } as unknown as SupabaseClient;
      const store = new SupabaseHistoryStore('https://x.supabase.co', client);
      // The cut at 2000 lands inside the JWT: unredacted, its first part
      // would survive as a fragment no rule can match any more.
      const straddle = `${'x '.repeat(990)} ${JWT}`;
      await store.pushRun(run, [failing(dirty), failing(straddle)]);
      const wire = JSON.stringify(upserts);
      expect(leaks(wire)).toEqual([]);
      expect(wire).not.toContain(JWT.slice(0, 12));
    });
  });

  describe('reader truncation', () => {
    it('a secret straddling the reader cut leaves no leading fragment', () => {
      const report = {
        testResults: [
          {
            name: 'tests/a.test.ts',
            assertionResults: [
              {
                fullName: 'a > logs in',
                status: 'failed',
                failureMessages: [`${'x '.repeat(990)} ${JWT}`],
              },
            ],
          },
        ],
      };
      const { results } = readVitestReport(report, {
        suite: 'api',
        repo: 'acme/app',
        branch: 'main',
        commitSha: 'abc12345',
        nowMs: 0,
      });
      const text = String(results[0]?.error_text);
      expect(text).not.toContain(JWT.slice(0, 12));
      expect(text).toContain('<token>');
    });
  });
});
