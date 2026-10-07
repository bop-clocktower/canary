/**
 * `TEST_SHAPES` is the one shape vocabulary (#1206).
 *
 * The classifier, the framework probes, and `canary overlay lint`'s `deploy_to`
 * allow-list each used to carry their own copy of the shape names. The lint's
 * copy stopped at five, so an overlay targeting `mobile` — a shape canary's own
 * probes emit for wdio — was told its target was probably a typo.
 *
 * The classifier and probes are now typed against `TestShape`, so `tsc` rejects
 * a shape that is not in the list; the npm lint reads a verbatim mirror of the
 * list (drift-checked by `npm/scripts/sync-gate-result.mjs --check`). These
 * tests pin the runtime half: what the probes actually return, and the
 * framework registry the classifier's test types must resolve against.
 *
 * Offline: temp-dir fixtures and a JSON read. Never executes a suite.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { TestClassifier } from '../src/core/classifier.js';
import { CONFIG_PROBES, probeFramework } from '../src/core/framework-probes.js';
import { TEST_SHAPES } from '../src/core/test-shapes.js';

const SHAPES: ReadonlySet<string> = new Set(TEST_SHAPES);

interface RegistryEntry {
  name: string;
  category: string;
  categories?: string[];
}

const registry = JSON.parse(
  readFileSync(
    new URL('../src/data/frameworks/registry.json', import.meta.url),
    'utf8',
  ),
) as { frameworks: RegistryEntry[] };

describe('TEST_SHAPES', () => {
  it('has no duplicates and no sentinel values', () => {
    expect(new Set(TEST_SHAPES).size).toBe(TEST_SHAPES.length);
    // `all` is the deploy_to sentinel and `unknown` the probe miss value;
    // neither is a shape a project can have.
    expect(SHAPES.has('all')).toBe(false);
    expect(SHAPES.has('unknown')).toBe(false);
  });

  it('includes mobile, the shape #1206 was filed for', () => {
    expect(SHAPES.has('mobile')).toBe(true);
  });

  it('is exactly the set of framework registry categories', () => {
    // Every classifier test type must resolve to a framework, and every
    // framework category must be a shape canary can emit. Equality pins both.
    const categories = new Set(
      registry.frameworks.flatMap((f) => [f.category, ...(f.categories ?? [])]),
    );
    expect([...categories].sort()).toEqual([...TEST_SHAPES].sort());
  });
});

describe('every shape the probes emit is in TEST_SHAPES', () => {
  it.each(CONFIG_PROBES.map(([file, , shape]) => [file, shape]))(
    'config probe %s declares a known shape (%s)',
    (_file, shape) => {
      expect(SHAPES.has(shape)).toBe(true);
    },
  );

  it.each(CONFIG_PROBES.map(([file]) => [file]))(
    'probing a repo with only %s returns a known shape',
    (file) => {
      const tmp = mkdtempSync(join(tmpdir(), 'canary-shape-'));
      try {
        writeFileSync(join(tmp, file), '');
        const [, shape] = probeFramework(tmp, {}, ['config']);
        expect(SHAPES.has(shape)).toBe(true);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  );
});

describe('every test type the classifier emits is in TEST_SHAPES', () => {
  const classifier = new TestClassifier();

  it.each(registry.frameworks.map((f) => [f.name]))(
    'a prompt naming %s classifies to a known shape',
    (name) => {
      const { test_type } = classifier.classify(`write a ${name} test`);
      expect(SHAPES.has(test_type)).toBe(true);
    },
  );

  it.each(TEST_SHAPES.map((s) => [s]))(
    'a prompt naming the shape %s classifies to a known shape',
    (shape) => {
      const { test_type } = classifier.classify(`a ${shape} test`);
      expect(SHAPES.has(test_type)).toBe(true);
    },
  );
});
