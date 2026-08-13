import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { JS_TEST_EXTENSIONS } from './static-linter.js';
import { PatternMatcher, findTestFiles, isEmpty } from './pattern-matcher.js';

const pm = new PatternMatcher();
const dirs: string[] = [];

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'pm-'));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf-8');
  }
  return root;
}

afterEach(() => {
  // temp dirs are OS-cleaned; nothing to assert here.
});

describe('PatternMatcher edge branches', () => {
  it('returns an empty profile when no test files match', () => {
    const root = project({ 'src/app.ts': 'export const x = 1;\n' });
    const profile = pm.scan(root, 'pytest');
    expect(isEmpty(profile)).toBe(true);
    expect(profile.test_count).toBe(0);
  });

  it('never descends into ignored dirs (node_modules)', () => {
    const root = project({
      'node_modules/pkg/thing.test.ts': 'it("x", () => {});\n',
      'tests/real.test.ts':
        'describe("r", () => { it("works", () => {}); });\n',
    });
    const profile = pm.scan(root, 'vitest');
    expect(profile.test_count).toBe(1);
  });

  it('detects chai assertion style from imports', () => {
    const root = project({
      'a.test.ts': `import { expect } from 'chai';\ndescribe('s', () => { it('Should do a thing', () => {}); });\n`,
    });
    const profile = pm.scan(root, 'vitest');
    expect(profile.assertion_style).toBe('chai expect assertions');
    expect(profile.uses_describe).toBe(true);
  });

  it('detects assert-style imports and imperative names', () => {
    const root = project({
      'a.test.ts': `import assert from 'node:assert';\ntest('adds numbers', () => {});\n`,
    });
    const profile = pm.scan(root, 'vitest');
    expect(profile.assertion_style).toBe('assert-style assertions');
  });

  it('classifies python class-based unittest style', () => {
    const root = project({
      'test_thing.py': `import unittest\n\nclass TestThing(unittest.TestCase):\n    def test_when_ready_it_runs(self):\n        self.assertTrue(True)\n`,
    });
    const profile = pm.scan(root, 'pytest');
    expect(profile.language).toBe('python');
    expect(profile.uses_classes).toBe(true);
    expect(profile.assertion_style).toBe('unittest self.assert* methods');
  });

  it('infers python by extension when framework is ambiguous', () => {
    const root = project({ 'test_x.py': 'def test_a():\n    assert True\n' });
    const profile = pm.scan(root); // no framework/test_type
    expect(profile.language).toBe('python');
  });
});

/**
 * The #566 discovery-denominator class, one module further in.
 *
 * `cli-commands.ts` learned to see `.mjs`/`.cjs` when a directory of ESM tests
 * collected zero files; this module's `FILE_PATTERNS` never did, so a project
 * whose whole suite is ESM produced `test_count: 0` — indistinguishable from a
 * project with no tests at all. Every consumer that branches on `isEmpty()`
 * then silently falls back to generic conventions.
 *
 * CI cannot catch this by accident: every suite in this repo is `.ts`/`.js`, so
 * the denominator is never zero here. The extensions are therefore asserted
 * against `JS_TEST_EXTENSIONS` — the one list that already knows what the
 * scanners can read — rather than restated by hand.
 */
describe('PatternMatcher discovery denominator', () => {
  it.each(['mjs', 'cjs', 'mts', 'cts'])(
    'discovers a .%s suite instead of reporting an empty project',
    (ext) => {
      const root = project({
        [`tests/a.test.${ext}`]:
          `import { it, expect } from 'vitest';\n` +
          `it('should work', () => { expect(1).toBe(1); });\n`,
      });
      const profile = pm.scan(root, 'vitest');
      expect(profile.test_count).toBe(1);
      expect(isEmpty(profile)).toBe(false);
    },
  );

  // `infixes` is what each framework's globs legitimately claim: playwright and
  // vitest match both `.spec.` and `.test.`, the two narrower test types match
  // one each. The assertion is that whatever a framework claims, it claims it
  // across EVERY readable extension — not that every framework matches
  // everything.
  it.each([
    ['playwright', ['spec', 'test']],
    ['vitest', ['spec', 'test']],
    ['e2e_ui', ['spec']],
    ['frontend_unit', ['test']],
  ] as const)(
    'covers every scanner-readable JS extension for framework %s',
    (framework, infixes) => {
      const files: Record<string, string> = {};
      for (const ext of JS_TEST_EXTENSIONS) {
        const stem = ext.slice(1); // `.mjs` -> `mjs`, keeps names unique
        for (const infix of ['spec', 'test']) {
          files[`tests/${stem}_${infix}.${infix}${ext}`] =
            'it("x", () => {});\n';
        }
      }
      const root = project(files);
      const found = findTestFiles(root, framework, '');
      expect(found).toHaveLength(JS_TEST_EXTENSIONS.length * infixes.length);
      // Named explicitly so a regression that drops one extension fails with a
      // readable diff rather than an off-by-N length.
      for (const ext of JS_TEST_EXTENSIONS) {
        for (const infix of infixes) {
          expect(found.some((p) => p.endsWith(`.${infix}${ext}`))).toBe(true);
        }
      }
    },
  );

  it('keeps the default patterns aligned with the readable extensions', () => {
    // `pm.scan()` with no framework and no testType falls through to
    // DEFAULT_PATTERNS. An ESM project hitting that path must still be seen.
    const root = project({
      'tests/a.test.mjs': `it('x', () => { expect(1).toBe(1); });\n`,
    });
    expect(pm.scan(root).test_count).toBe(1);
  });
});
