/**
 * TS↔Python parity: the ported AnalysisEngine, run over the shared
 * history-v2.jsonl fixture, must produce output identical to the Python golden
 * captures (scripts/capture_analysis_golden.py) after the same normalization.
 *
 * This is the core proof of the pilot. If it fails, the TS port has drifted
 * from Python — fix the TS (or, only if a value hits a banker's-rounding tie,
 * the fixture).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { AnalysisEngine } from '../src/analysis/engine.js';
import type { AnalysisResult } from '../src/analysis/engine.js';
import { NdjsonHistoryStore } from '../src/history/ndjson-store.js';
import { LocalAsyncAdapter } from '../src/history/store.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, 'fixtures', 'history-v2.jsonl');
const goldenDir = join(here, 'fixtures', 'golden');

const ANSI = /\x1b\[[0-9;]*m/g;

function normalize(text: string): string {
  return text
    .replace(ANSI, '')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
}

function golden(name: string): string {
  return normalize(readFileSync(join(goldenDir, name), 'utf-8'));
}

// artifact key (TS) -> golden filename
const CASES: Array<[string, string]> = [
  ['flaky.md', 'flaky.txt'],
  ['spikes.md', 'spikes.txt'],
  ['area-health.md', 'area-health.txt'],
  ['common-failures.md', 'common-failures.txt'],
  ['regression-candidates.md', 'regression-candidates.txt'],
  ['digest.md', 'digest.txt'],
];

describe('TS↔Python analysis parity', () => {
  // The engine is async as of #711; it reaches the same NDJSON fixture through
  // the adapter that now carries `readAll`. The goldens are unchanged — that is
  // the point, since #711 was a mechanical async conversion and any drift in
  // these six files would mean it was not.
  let result: AnalysisResult;
  // This setup acquires no resource: it computes a pure in-memory value into a
  // describe-scoped local, so no teardown hook could release anything (#733).
  // savant-ignore SV002 -- no resource acquired, so no teardown exists to write
  beforeAll(async () => {
    result = await new AnalysisEngine(
      new LocalAsyncAdapter(new NdjsonHistoryStore(fixture)),
    ).run();
  });

  for (const [artifact, goldenFile] of CASES) {
    it(`${artifact} matches the Python golden output`, () => {
      const actual = normalize(result.artifacts[artifact] ?? '');
      expect(actual).toBe(golden(goldenFile));
    });
  }

  it('reports nothing degraded against the local store', () => {
    // VAC-003 (#706): an empty `degraded` list is also what an engine that ran
    // and produced nothing returns, so the absence only means something beside
    // proof that the run happened.
    expect(Object.keys(result.artifacts).length).toBeGreaterThan(0);
    expect(result.degraded).toEqual([]);
  });
});
