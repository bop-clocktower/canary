/**
 * TS↔Python parity for the core/ recommender slice.
 *
 * Loads the golden outputs captured from the Python modules
 * (scripts/capture_core_golden.py) and asserts the TS port produces identical
 * results for the same inputs (which are single-sourced in the golden files).
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  TestClassifier,
  extractFrameworkHint,
} from '../src/core/classifier.js';
import { FrameworkRegistry } from '../src/core/framework-registry.js';
import { PatternMatcher } from '../src/core/pattern-matcher.js';
import { QualityScorer } from '../src/core/quality-scorer.js';
import {
  FrameworkRecommender,
  type ProjectMetadata,
} from '../src/core/recommender.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(HERE, 'fixtures', 'core-golden');
const SAMPLE_PROJECT = join(HERE, 'fixtures', 'sample-project');

function golden<T>(name: string): T {
  return JSON.parse(readFileSync(join(GOLDEN, name), 'utf-8')) as T;
}

beforeAll(() => {
  // Match the deterministic capture environment (no license unlocks / scope).
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('CANARY_')) delete process.env[k];
  }
});

describe('classifier parity', () => {
  const cases =
    golden<Array<{ prompt: string; result: unknown; hint: string | null }>>(
      'classifier.json',
    );
  const clf = new TestClassifier();
  it.each(cases)('classify: $prompt', (c) => {
    expect(clf.classify(c.prompt)).toEqual(c.result);
    expect(extractFrameworkHint(c.prompt)).toEqual(c.hint);
  });
});

describe('recommender parity', () => {
  const cases = golden<
    Array<{
      test_type: string;
      confidence: number;
      framework_hint: string | null;
      metadata_languages: string[] | null;
      result: unknown;
    }>
  >('recommender.json');
  const rec = new FrameworkRecommender();
  it.each(cases)('recommend: $test_type hint=$framework_hint', (c) => {
    const metadata: ProjectMetadata | null =
      c.metadata_languages === null
        ? null
        : { detected_languages: c.metadata_languages };
    const out = rec.recommend(
      {
        intent: 'generate_tests',
        test_type: c.test_type,
        confidence: c.confidence,
      },
      metadata,
      c.framework_hint,
    );
    expect(out).toEqual(c.result);
  });
});

describe('quality-scorer parity', () => {
  const cases =
    golden<Array<{ sample: string; framework: string; score: unknown }>>(
      'quality.json',
    );
  const scorer = new QualityScorer();
  it.each(cases)('score: $sample', (c) => {
    const code = readFileSync(join(GOLDEN, 'samples', c.sample), 'utf-8');
    expect(scorer.score(code, c.framework)).toEqual(c.score);
  });
});

describe('framework-registry parity', () => {
  const g = golden<{
    summaries: unknown;
    byCategory: Record<string, string[]>;
    preferred: Record<string, string | null>;
    findByName: Record<string, string | null>;
    executionInfo: Record<string, unknown>;
    matchByLanguage: Record<string, string[]>;
  }>('registry.json');
  const reg = new FrameworkRegistry();

  it('summaries match', () => {
    expect(reg.summaries()).toEqual(g.summaries);
  });
  it('getByCategory matches', () => {
    for (const [cat, names] of Object.entries(g.byCategory)) {
      expect(reg.getByCategory(cat).map((f) => f.name)).toEqual(names);
    }
  });
  it('getPreferredByCategory matches', () => {
    for (const [cat, name] of Object.entries(g.preferred)) {
      expect(reg.getPreferredByCategory(cat)?.name ?? null).toEqual(name);
    }
  });
  it('findByName matches', () => {
    for (const [name, expected] of Object.entries(g.findByName)) {
      expect(reg.findByName(name)?.name ?? null).toEqual(expected);
    }
  });
  it('executionInfo matches', () => {
    for (const [name, info] of Object.entries(g.executionInfo)) {
      expect(reg.executionInfo(name)).toEqual(info);
    }
  });
  it('matchByLanguage matches', () => {
    for (const [lang, names] of Object.entries(g.matchByLanguage)) {
      expect(reg.matchByLanguage(lang).map((f) => f.name)).toEqual(names);
    }
  });
});

describe('pattern-matcher parity', () => {
  const cases =
    golden<Array<{ framework: string; test_type: string; profile: unknown }>>(
      'pattern.json',
    );
  const pm = new PatternMatcher();
  it.each(cases)('scan: fw=$framework type=$test_type', (c) => {
    const profile = pm.scan(resolve(SAMPLE_PROJECT), c.framework, c.test_type);
    expect(profile).toEqual(c.profile);
  });
});
