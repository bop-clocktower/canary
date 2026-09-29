/** The #1125 enricher: area from critical-areas.json, category from error text. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { enrichRecordedResults } from '../src/analysis/enrich/enrich.js';
import type { TestResultInput } from '../src/history/schema.js';
import { mkTmp, rmTmp } from './canary-cli-testkit.js';

const row = (
  test_name: string,
  status: string,
  error_text?: string,
): TestResultInput => ({
  run_id: 'r1',
  suite: 'web',
  repo: 'acme/widgets',
  test_name,
  test_file: 'e2e/checkout.spec.ts',
  status,
  ...(error_text === undefined ? {} : { error_text }),
});

const ROWS = [
  row('passes', 'passed'),
  row('fails', 'failed', 'Request failed with status 401'),
  row('flakes', 'flaky', 'Timeout 5000ms exceeded'),
  row('fails silently', 'failed'),
];

let tmp: string;
beforeEach(() => {
  tmp = mkTmp();
});
afterEach(() => {
  rmTmp(tmp);
});

function writeAreas(text: string): void {
  mkdirSync(join(tmp, '.canary'), { recursive: true });
  writeFileSync(join(tmp, '.canary', 'critical-areas.json'), text, 'utf-8');
}

describe('enrichRecordedResults', () => {
  it('sets area on every mapped test and no note', () => {
    writeAreas(
      JSON.stringify({ areas: [{ path: 'src/checkout.ts', risk_score: 3 }] }),
    );
    const { results, notes } = enrichRecordedResults(ROWS, tmp);
    expect(results.map((r) => r.area)).toEqual(
      Array(4).fill('src/checkout.ts'),
    );
    expect(notes).toEqual([]);
  });

  it('leaves area unset on a test no area maps, without a note', () => {
    writeAreas(
      JSON.stringify({ areas: [{ path: 'src/billing.ts', risk_score: 3 }] }),
    );
    const { results, notes } = enrichRecordedResults(ROWS, tmp);
    expect(results.some((r) => 'area' in r)).toBe(false);
    expect(notes).toEqual([]);
  });

  it('categorises failed and flaky rows that carry error text, and only those', () => {
    const { results } = enrichRecordedResults(ROWS, tmp);
    expect(results.map((r) => r.failure_category)).toEqual([
      undefined,
      'auth',
      'timeout',
      undefined,
    ]);
    // D6: no evidence, no key -- `other` here would be a false `fed`.
    expect('failure_category' in results[3]!).toBe(false);
  });

  it('abstains with a note naming the file when it is absent', () => {
    const { results, notes } = enrichRecordedResults(ROWS, tmp);
    expect(results.some((r) => 'area' in r)).toBe(false);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('area not recorded');
    expect(notes[0]).toContain('.canary/critical-areas.json');
  });

  it('abstains when the file is malformed, empty of areas, or unreadable', () => {
    writeAreas('{}');
    expect(enrichRecordedResults(ROWS, tmp).notes[0]).toContain(
      'has no areas list',
    );
    writeAreas('{"areas":[]}');
    expect(enrichRecordedResults(ROWS, tmp).notes[0]).toContain(
      'lists no areas',
    );
    rmTmp(join(tmp, '.canary'));
    mkdirSync(join(tmp, '.canary', 'critical-areas.json'), {
      recursive: true,
    });
    expect(enrichRecordedResults(ROWS, tmp).notes[0]).toContain(
      'could not be read',
    );
  });

  it('does not mutate the rows it was given', () => {
    const before = JSON.stringify(ROWS);
    enrichRecordedResults(ROWS, tmp);
    expect(JSON.stringify(ROWS)).toBe(before);
  });
});
