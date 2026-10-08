/**
 * #1225: the producer (canary-starling) and the validator share one idea of a
 * valid timestamp and a repo-relative path. Before the fix, starling admitted
 * `2026-02-30T…` (Date.parse rolls it over to 03-02) and the validator then
 * refused the whole feed; the validator's own timestamp regex was a
 * hand-written copy of the schema pattern that nothing pinned.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { TIMESTAMP_RE } from '../lib/contracts/field-checks.mjs';
import { validateDocument } from '../lib/contracts/document.mjs';
import { historyToRun } from '../claude-code/canary-starling/scripts/runs.mjs';
import { ciReadyAssessments } from '../claude-code/canary-starling/scripts/assess.mjs';
import { registerRows } from '../claude-code/canary-starling/scripts/register.mjs';

const SCOPE = { id: 'canary', env: 'ci' };
const schema = (layer: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../lib/contracts/${layer}.v1.schema.json`, import.meta.url),
      'utf8',
    ),
  );

describe('TIMESTAMP_RE is the schema timestamp pattern (#1225 item 2)', () => {
  const run = schema('run');
  const assessment = schema('assessment');

  it.each([
    ['run $defs.timestamp', run.$defs.timestamp.pattern],
    ['assessment $defs.timestamp', assessment.$defs.timestamp.pattern],
    ['assessment verified_at', assessment.properties.verified_at.pattern],
  ])('matches the %s pattern exactly', (_where, pattern) => {
    expect(TIMESTAMP_RE.source).toBe(new RegExp(pattern).source);
  });

  it('every other timestamp field references one of those definitions', () => {
    expect(assessment.properties.observed_at.$ref).toBe('#/$defs/timestamp');
    const site = schema('site');
    expect(site.properties.generated_at).toEqual({
      $ref: 'run.v1.schema.json#/$defs/timestamp',
    });
  });
});

const historyRow = (over: Record<string, unknown> = {}) => ({
  run_id: 'r1',
  suite: 'ts-engine',
  timestamp: '2026-10-06T10:00:00Z',
  duration_ms: 1000,
  tests: [{ test_name: 'a', test_file: 'test/a.test.ts', status: 'passed' }],
  ...over,
});

describe('starling refuses a timestamp the validator refuses (#1225 item 1)', () => {
  it.each([
    '2026-02-30T10:00:00Z',
    '2026-02-29T10:00:00Z',
    '2026-04-31T10:00:00+02:00',
  ])('leaves out a history row finishing at %s', (timestamp) => {
    const out = historyToRun(historyRow({ timestamp }), SCOPE);
    expect(out.run).toBeNull();
    expect(out.skipped).toMatch(/r1: unparseable timestamp/);
  });

  it('admits a real leap day, and the record validates (control)', () => {
    const { run } = historyToRun(
      historyRow({ timestamp: '2028-02-29T10:00:00Z' }),
      SCOPE,
    );
    expect(run).not.toBeNull();
    expect(validateDocument(run, { layer: 'run' }).errors).toEqual([]);
  });

  it('treats a ci-ready report observed at 2026-02-30 as undated', () => {
    const out = ciReadyAssessments(
      { observed_at: '2026-02-30T00:00:00Z', checks: [] },
      SCOPE,
      { now: '2026-10-08T00:00:00Z', source: 'r.json' },
    );
    expect(out.note).toMatch(/r\.json.*observed_at/);
    for (const a of out.synthetic) {
      expect(a.observed_at).toBe('2026-10-08T00:00:00Z');
      expect(validateDocument(a, { layer: 'assessment' }).errors).toEqual([]);
    }
  });

  it('leaves out a katana ledger row dated 2026-02-30', () => {
    const { rows, skipped } = registerRows(
      [
        {
          test: 't',
          file: 'tests/a.test.ts',
          kind: 'skipped',
          reason: 'r',
          commit: 'abc1234',
          date: '2026-02-30T00:00:00Z',
        },
      ],
      SCOPE,
    );
    expect(rows).toEqual([]);
    expect(skipped).toEqual(['ledger row tests/a.test.ts :: t: no date']);
  });
});

describe('starling refuses a file the validator refuses (#1225 item 3)', () => {
  it.each(['.', './', 'a/..', 'C:x', '~/x.test.ts', '../x.test.ts'])(
    'leaves out a history row with test_file %j',
    (testFile) => {
      const tests = [{ test_name: 'a', test_file: testFile, status: 'passed' }];
      const out = historyToRun(historyRow({ tests }), SCOPE);
      expect(out.run).toBeNull();
      expect(out.skipped).toMatch(/r1:/);
    },
  );

  it('leaves out a katana ledger row whose file is "."', () => {
    const { rows, skipped } = registerRows(
      [
        {
          test: 't',
          file: '.',
          kind: 'skipped',
          reason: 'r',
          commit: 'abc1234',
          date: '2026-10-01T00:00:00Z',
        },
      ],
      SCOPE,
    );
    expect(rows).toEqual([]);
    expect(skipped).toEqual(['ledger row . :: t: no repo-relative file']);
  });
});
