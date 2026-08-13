import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { probeFramework } from '../src/core/framework-probes.js';

function withTmp<T>(fn: (tmp: string) => T): T {
  const tmp = mkdtempSync(join(tmpdir(), 'canary-probe-'));
  try {
    return fn(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const ALL = ['config', 'content', 'language'] as const;
const PKG = ['config', 'content'] as const;

describe('probeFramework', () => {
  it('hits the config tier and reports the filename as the source', () =>
    withTmp((tmp) => {
      writeFileSync(join(tmp, 'playwright.config.ts'), '');
      expect(probeFramework(tmp, {}, [...ALL])).toEqual([
        'playwright',
        'e2e_ui',
        'playwright.config.ts',
        'config',
      ]);
    }));

  it('applies the language fallback when the language tier is enabled', () =>
    withTmp((tmp) => {
      expect(probeFramework(tmp, { language: 'typescript' }, [...ALL])).toEqual(
        [
          'playwright',
          'e2e_ui',
          'harness.config.json (language: typescript)',
          'language',
        ],
      );
    }));

  // Spec test #8 -- the leak guard. Without the tier gate, every package in a
  // TypeScript monorepo would "detect" playwright by inheritance.
  it('never applies the language fallback without the language tier', () =>
    withTmp((tmp) => {
      expect(probeFramework(tmp, { language: 'typescript' }, [...PKG])).toEqual(
        [null, 'unknown', 'none', 'none'],
      );
    }));

  it('refines playwright to api when no spec uses page/browser fixtures', () =>
    withTmp((tmp) => {
      writeFileSync(join(tmp, 'playwright.config.ts'), '');
      mkdirSync(join(tmp, 'tests'), { recursive: true });
      writeFileSync(
        join(tmp, 'tests', 'a.spec.ts'),
        'test("x", async ({ request }) => {});',
      );
      expect(probeFramework(tmp, {}, [...PKG])[1]).toBe('api');
    }));
});
