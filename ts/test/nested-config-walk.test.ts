/**
 * The nested config tier (#1212): a bounded, deterministic walk below a
 * single-package root, and the agree / disagree verdict over what it found.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  findNestedConfigs,
  NESTED_CONFIG_MAX_DEPTH,
  NESTED_CONFIG_SKIP_DIRS,
  probeNestedConfig,
} from '../src/core/config-probes.js';
import { probeFramework } from '../src/core/framework-probes.js';

function withTmp<T>(fn: (tmp: string) => T): T {
  const tmp = mkdtempSync(join(tmpdir(), 'canary-nested-'));
  try {
    return fn(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function touch(root: string, rel: string, content = 'export default {};\n') {
  const path = join(root, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf-8');
}

const ROOT_TIERS = [
  'config',
  'content',
  'nested-config',
  'scripts',
  'dependency',
  'language',
] as const;

describe('findNestedConfigs', () => {
  it('reaches exactly NESTED_CONFIG_MAX_DEPTH (3) levels below the root', () =>
    withTmp((root) => {
      expect(NESTED_CONFIG_MAX_DEPTH).toBe(3);
      touch(root, 'a/wdio.conf.ts');
      touch(root, 'a/b/c/wdio.conf.ts');
      touch(root, 'a/b/c/d/wdio.conf.ts'); // depth 4: out of bounds
      expect(findNestedConfigs(root)).toEqual([
        'a/b/c/wdio.conf.ts',
        'a/wdio.conf.ts',
      ]);
    }));

  it('leaves a root-level config to the root config tier', () =>
    withTmp((root) => {
      touch(root, 'vitest.config.ts');
      expect(findNestedConfigs(root)).toEqual([]);
    }));

  it('pins the skip list: dependencies, VCS metadata, build/tool output', () => {
    expect([...NESTED_CONFIG_SKIP_DIRS].sort()).toEqual(
      [
        '.cache',
        '.git',
        '.next',
        '.nuxt',
        '.turbo',
        '.venv',
        '__pycache__',
        'build',
        'coverage',
        'dist',
        'node_modules',
        'out',
        'target',
        'venv',
      ].sort(),
    );
  });

  it('never enters a skipped directory, node_modules included', () =>
    withTmp((root) => {
      for (const dir of NESTED_CONFIG_SKIP_DIRS) {
        touch(root, `${dir}/playwright.config.ts`);
        touch(root, `pkg/${dir}/vitest.config.ts`);
      }
      touch(root, 'e2e/wdio.conf.ts'); // the planted positive
      expect(findNestedConfigs(root)).toEqual(['e2e/wdio.conf.ts']);
    }));

  it('returns code-point order regardless of creation order', () =>
    withTmp((root) => {
      touch(root, 'zeta/wdio.conf.ts');
      touch(root, 'Alpha/wdio.conf.ts');
      touch(root, 'mid/x/wdio.conf.js');
      expect(findNestedConfigs(root)).toEqual([
        'Alpha/wdio.conf.ts',
        'mid/x/wdio.conf.js',
        'zeta/wdio.conf.ts',
      ]);
    }));
});

describe('probeNestedConfig', () => {
  it('is null when nothing nested matches', () =>
    withTmp((root) => {
      touch(root, 'src/index.ts');
      expect(probeNestedConfig(root)).toBeNull();
    }));

  it('reports agreeing configs as one hit naming the first path', () =>
    withTmp((root) => {
      touch(root, 'Mobile/android/android-app/wdio.conf.ts');
      touch(root, 'Mobile/iOS/ios-app/wdio.conf.ts');
      expect(probeNestedConfig(root)).toEqual([
        'wdio',
        'mobile',
        'nested configs Mobile/android/android-app/wdio.conf.ts (+1 more)',
        'config',
      ]);
    }));

  it('abstains, naming every config, when the pairs disagree', () =>
    withTmp((root) => {
      touch(root, 'web/vitest.config.ts');
      touch(root, 'e2e/playwright.config.ts');
      expect(probeNestedConfig(root)).toEqual([
        null,
        'unknown',
        'nested configs (mixed: e2e/playwright.config.ts (playwright/e2e_ui), ' +
          'web/vitest.config.ts (vitest/frontend_unit))',
        'none',
      ]);
    }));

  it('refines a nested playwright config against its own specs', () =>
    withTmp((root) => {
      touch(root, 'api-tests/playwright.config.ts');
      touch(
        root,
        'api-tests/tests/health.spec.ts',
        "test('h', async ({ request }) => { await request.get('/'); });\n",
      );
      expect(probeNestedConfig(root)).toEqual([
        'playwright',
        'api',
        'nested config api-tests/playwright.config.ts',
        'content',
      ]);
    }));
});

describe('probeFramework nested-config tier (#1212)', () => {
  it('detects a package whose only evidence is a nested wdio.conf.ts', () =>
    withTmp((root) => {
      touch(root, 'package.json', JSON.stringify({ name: 'mobile' }));
      touch(root, 'Mobile/android/android-app/wdio.conf.ts');
      expect(probeFramework(root, {}, [...ROOT_TIERS])).toEqual([
        'wdio',
        'mobile',
        'nested config Mobile/android/android-app/wdio.conf.ts',
        'config',
      ]);
    }));

  it('does not walk when the caller withholds the tier', () =>
    withTmp((root) => {
      touch(root, 'Mobile/android/android-app/wdio.conf.ts');
      const tiers = ROOT_TIERS.filter((t) => t !== 'nested-config');
      expect(probeFramework(root, {}, tiers)[0]).toBeNull();
    }));

  it('lets a mixed abstention end the probe before the language guess', () =>
    withTmp((root) => {
      touch(root, 'web/vitest.config.ts');
      touch(root, 'e2e/wdio.conf.ts');
      const [fw, shape, source] = probeFramework(
        root,
        { language: 'typescript' },
        [...ROOT_TIERS],
      );
      expect([fw, shape]).toEqual([null, 'unknown']);
      expect(source).toMatch(/^nested configs \(mixed: /);
    }));

  it("keeps the root's own scripts.test above a nested config", () =>
    withTmp((root) => {
      touch(
        root,
        'package.json',
        JSON.stringify({ scripts: { test: 'vitest run' } }),
      );
      touch(root, 'e2e/playwright.config.ts');
      expect(probeFramework(root, {}, [...ROOT_TIERS])).toEqual([
        'vitest',
        'frontend_unit',
        'package.json (scripts.test)',
        'content',
      ]);
    }));

  it('ranks a nested config above a root dependency', () =>
    withTmp((root) => {
      touch(
        root,
        'package.json',
        JSON.stringify({ devDependencies: { vitest: '^2' } }),
      );
      touch(root, 'e2e/wdio.conf.ts');
      expect(probeFramework(root, {}, [...ROOT_TIERS])[0]).toBe('wdio');
    }));
});
