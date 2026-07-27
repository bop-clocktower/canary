/**
 * TS↔Python parity for the core/ recommender slice.
 *
 * Loads the golden outputs captured from the Python modules
 * (scripts/capture_core_golden.py) and asserts the TS port produces identical
 * results for the same inputs (which are single-sourced in the golden files).
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  TestClassifier,
  extractFrameworkHint,
} from '../src/core/classifier.js';
import { readJsonWithWarning } from '../src/core/config-validation.js';
import { uncertainDetectionMessage } from '../src/core/detection.js';
import { buildFeedback, buildIssueUrl } from '../src/core/feedback.js';
import { FrameworkRegistry } from '../src/core/framework-registry.js';
import { PatternHealer } from '../src/core/pattern-healer.js';
import { PatternMatcher } from '../src/core/pattern-matcher.js';
import { QualityScorer } from '../src/core/quality-scorer.js';
import {
  FrameworkRecommender,
  type ProjectMetadata,
} from '../src/core/recommender.js';
import { Reporter } from '../src/core/reporter.js';
import { TEMPLATES, scaffoldableFrameworks } from '../src/core/scaffolder.js';
import {
  WorkflowDiscovery,
  WorkflowMapping,
} from '../src/core/workflow-discovery.js';

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

describe('detection parity', () => {
  const cases = golden<
    Array<{
      what: string;
      reason: string | null;
      candidates: string[] | null;
      override_hint: string | null;
      message: string;
    }>
  >('detection.json');
  it.each(cases)('uncertain: $what', (c) => {
    expect(
      uncertainDetectionMessage(c.what, {
        reason: c.reason,
        candidates: c.candidates,
        overrideHint: c.override_hint,
      }),
    ).toEqual(c.message);
  });
});

describe('pattern-healer parity', () => {
  interface HealCase {
    name: string;
    code: string;
    patched_content: string;
    changes: Array<{
      line: number;
      rule: string;
      before: string;
      after: string;
      description: string;
    }>;
    skipped: string[];
  }
  const cases = golden<HealCase[]>('pattern-healer.json');
  const healer = new PatternHealer();
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'canary-heal-parity-'));
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });
  it.each(cases)('heal: $name', (c) => {
    // Byte-identical input: the same snippet the Python oracle healed.
    const fp = join(tmp, `${c.name}.txt`);
    writeFileSync(fp, c.code, 'utf-8');
    const result = healer.heal(fp);
    expect(result.patched_content).toEqual(c.patched_content);
    // `result.file` is the temp path — excluded from the golden by design.
    expect(
      result.changes.map((ch) => ({
        line: ch.line,
        rule: ch.rule,
        before: ch.before,
        after: ch.after,
        description: ch.description,
      })),
    ).toEqual(c.changes);
    expect(result.skipped).toEqual(c.skipped);
  });
});

describe('reporter parity', () => {
  const cases = golden<
    Array<{
      name: string;
      result: Record<string, unknown>;
      json: string;
      sarif: string;
    }>
  >('reporter.json');
  const reporter = new Reporter();
  it.each(cases)('toJson/toSarif: $name', (c) => {
    expect(reporter.toJson(c.result)).toEqual(c.json);
    expect(reporter.toSarif(c.result)).toEqual(c.sarif);
  });
});

describe('scaffolder parity', () => {
  const g = golden<{
    frameworks: string[];
    templates: Record<
      string,
      { files: Record<string, string>; dirs: string[] }
    >;
  }>('scaffolder.json');
  it('scaffoldableFrameworks matches', () => {
    expect([...scaffoldableFrameworks()].sort()).toEqual(g.frameworks);
  });
  it('TEMPLATES content matches', () => {
    expect(TEMPLATES).toEqual(g.templates);
  });
});

describe('feedback parity', () => {
  const g = golden<{
    issue_url: Array<{
      category: string;
      message: string;
      context: Record<string, string>;
      endpoint: string;
      title: string;
      body: string;
      labels: string;
    }>;
    build: Array<{
      category: string;
      message: string;
      context_keys: string[];
    }>;
  }>('feedback.json');

  // build_issue_url: CPython quote_plus and JS URLSearchParams percent-encode
  // `*`/`~` differently (the body hardcodes `**Environment**`), so the RAW url
  // bytes diverge. The values are decode-invariant, so we assert on the decoded
  // title/body/labels + endpoint — the actual contract GitHub receives.
  it.each(g.issue_url)('buildIssueUrl: $category', (c) => {
    const url = buildIssueUrl(c.category, c.message, c.context);
    const [endpoint] = url.split('?');
    const q = new URL(url).searchParams;
    expect(endpoint).toEqual(c.endpoint);
    expect(q.get('title')).toEqual(c.title);
    expect(q.get('body')).toEqual(c.body);
    expect(q.get('labels')).toEqual(c.labels);
  });

  // build_feedback: context VALUES + issue_url are runtime-specific (version
  // lookup, OS strings, interpreter/runtime version, install-path probe) and
  // are EXCLUDED; only message/category and the context KEY SET/order are
  // deterministic across runtimes.
  it.each(g.build)('buildFeedback: $category', (c) => {
    const fb = buildFeedback(c.message, c.category);
    expect(fb.message).toEqual(c.message);
    expect(fb.category).toEqual(c.category);
    expect(Object.keys(fb.context)).toEqual(c.context_keys);
  });
});

describe('config-validation parity', () => {
  const cases = golden<
    Array<{
      name: string;
      content: string | null;
      data: unknown;
      warning_is_null: boolean;
    }>
  >('config-validation.json');
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'canary-config-parity-'));
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });
  it.each(cases)('readJsonWithWarning: $name', (c) => {
    // content === null models "no file on disk" (the absent case).
    const path =
      c.content === null
        ? join(tmp, 'does-not-exist.json')
        : join(tmp, `${c.name}.json`);
    if (c.content !== null) writeFileSync(path, c.content, 'utf-8');
    const [data, warning] = readJsonWithWarning(path);
    expect(data).toEqual(c.data);
    // Warning TEXT legitimately differs between runtimes — assert only nullness.
    expect(warning === null).toEqual(c.warning_is_null);
  });
});

describe('workflow-discovery parity', () => {
  const g = golden<{
    toJson: Array<{
      name: string;
      input: Record<string, unknown>;
      json: string;
    }>;
    heuristics: Array<{
      name: string;
      input: Record<string, unknown>;
      result: string;
    }>;
  }>('workflow-discovery.json');

  it.each(g.toJson)('toDict/toJson round-trip: $name', (c) => {
    expect(WorkflowMapping.fromDict(c.input).toJson()).toEqual(c.json);
  });

  const disc = new WorkflowDiscovery();
  it.each(g.heuristics)('applyHeuristics: $name', (c) => {
    const mapping = WorkflowMapping.fromDict(c.input);
    expect(disc.applyHeuristics(mapping).toJson()).toEqual(c.result);
  });
});
