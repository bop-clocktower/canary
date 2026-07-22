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

import { describe, expect, it } from 'vitest';

import { AnalysisEngine } from '../src/analysis/engine.js';
import { NdjsonHistoryStore } from '../src/history/ndjson-store.js';

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
  const result = new AnalysisEngine(new NdjsonHistoryStore(fixture)).run();

  for (const [artifact, goldenFile] of CASES) {
    it(`${artifact} matches the Python golden output`, () => {
      const actual = normalize(result.artifacts[artifact] ?? '');
      expect(actual).toBe(golden(goldenFile));
    });
  }
});
