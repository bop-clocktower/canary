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

const ALL = ['config', 'content', 'scripts', 'dependency', 'language'] as const;
const PKG = ['config', 'content', 'scripts', 'dependency'] as const;

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value), 'utf-8');
}

/**
 * A multi-target WebdriverIO package (#1205): no `scripts.test`, only
 * `test:<variant>` scripts, `@wdio/cli` in its dependencies, and its
 * `wdio.conf.ts` files nested below the package root where the config tier
 * never looks.
 */
function multiTargetWdioPackage(
  dir: string,
  opts: { scripts?: boolean; deps?: boolean } = {},
): void {
  const pkg: Record<string, unknown> = { name: 'mobile-suite' };
  if (opts.scripts ?? true) {
    pkg['scripts'] = {
      build: 'tsc -p .',
      'test:wdio:android': 'wdio run ./Mobile/android/android-app/wdio.conf.ts',
      'test:wdio:ios': 'wdio run ./Mobile/iOS/ios-app/wdio.conf.ts',
    };
  }
  if (opts.deps ?? true) {
    pkg['devDependencies'] = {
      '@wdio/cli': '^9.0.0',
      '@wdio/local-runner': '^9.0.0',
      typescript: '^5.0.0',
    };
  }
  writeJson(join(dir, 'package.json'), pkg);
  for (const target of ['android/android-app', 'iOS/ios-app']) {
    const conf = join(dir, 'Mobile', target, 'wdio.conf.ts');
    mkdirSync(join(conf, '..'), { recursive: true });
    writeFileSync(conf, 'export const config = {};\n', 'utf-8');
  }
}

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

describe('multi-target JS packages (#1205)', () => {
  it('detects wdio end to end from the reported package layout', () =>
    withTmp((tmp) => {
      multiTargetWdioPackage(tmp);
      expect(probeFramework(tmp, {}, [...ALL]).slice(0, 2)).toEqual([
        'wdio',
        'mobile',
      ]);
    }));

  it('reads every scripts.* value and names the script that matched', () =>
    withTmp((tmp) => {
      multiTargetWdioPackage(tmp, { deps: false });
      expect(probeFramework(tmp, {}, ['scripts'])).toEqual([
        'wdio',
        'mobile',
        'package.json (scripts.test:wdio:android)',
        'content',
      ]);
    }));

  it('detects from package.json dependencies alone', () =>
    withTmp((tmp) => {
      multiTargetWdioPackage(tmp, { scripts: false });
      expect(probeFramework(tmp, {}, ['dependency'])).toEqual([
        'wdio',
        'mobile',
        'package.json (devDependencies: @wdio/cli)',
        'content',
      ]);
    }));

  it('keeps scripts.test first, ahead of any other script', () =>
    withTmp((tmp) => {
      writeJson(join(tmp, 'package.json'), {
        scripts: { 'test:e2e': 'playwright test', test: 'vitest run' },
      });
      expect(probeFramework(tmp, {}, [...ALL])).toEqual([
        'vitest',
        'frontend_unit',
        'package.json (scripts.test)',
        'content',
      ]);
    }));

  it('ranks a matching script above a matching dependency', () =>
    withTmp((tmp) => {
      writeJson(join(tmp, 'package.json'), {
        scripts: { test: 'vitest run' },
        devDependencies: { '@wdio/cli': '^9.0.0' },
      });
      expect(probeFramework(tmp, {}, [...ALL])[0]).toBe('vitest');
    }));

  it('ranks a matching dependency above the language fallback', () =>
    withTmp((tmp) => {
      writeJson(join(tmp, 'package.json'), {
        dependencies: { webdriverio: '^9.0.0' },
      });
      expect(probeFramework(tmp, { language: 'typescript' }, [...ALL])).toEqual(
        [
          'wdio',
          'mobile',
          'package.json (dependencies: webdriverio)',
          'content',
        ],
      );
    }));

  it.each([
    ['vitest', 'vitest', 'frontend_unit'],
    ['k6', 'k6', 'performance'],
    ['webdriverio', 'wdio', 'mobile'],
    ['@playwright/test', 'playwright', 'e2e_ui'],
  ])('maps the %s dependency to %s/%s', (dep, framework, shape) =>
    withTmp((tmp) => {
      writeJson(join(tmp, 'package.json'), { devDependencies: { [dep]: '*' } });
      expect(probeFramework(tmp, {}, ['dependency']).slice(0, 2)).toEqual([
        framework,
        shape,
      ]);
    }),
  );

  it('refines a @playwright/test dependency to api like the config tier', () =>
    withTmp((tmp) => {
      writeJson(join(tmp, 'package.json'), {
        devDependencies: { '@playwright/test': '*' },
      });
      mkdirSync(join(tmp, 'tests'), { recursive: true });
      writeFileSync(
        join(tmp, 'tests', 'a.spec.ts'),
        'test("x", async ({ request }) => {});',
      );
      expect(probeFramework(tmp, {}, ['dependency']).slice(0, 2)).toEqual([
        'playwright',
        'api',
      ]);
    }));

  it('stays unknown when no script or dependency names a known framework', () =>
    withTmp((tmp) => {
      writeJson(join(tmp, 'package.json'), {
        scripts: { build: 'tsc -p .', lint: 'eslint .', start: 'node .' },
        dependencies: { react: '*', lodash: '*' },
        devDependencies: { eslint: '*', typescript: '*', '@types/k6': '*' },
      });
      expect(probeFramework(tmp, {}, [...PKG])).toEqual([
        null,
        'unknown',
        'none',
        'none',
      ]);
    }));

  it('withholds the dependency tier when it is not requested', () =>
    withTmp((tmp) => {
      multiTargetWdioPackage(tmp, { scripts: false });
      expect(probeFramework(tmp, {}, ['config', 'content'])[0]).toBeNull();
    }));

  it('reads only scripts.test in the content tier, as before #1205', () =>
    withTmp((tmp) => {
      multiTargetWdioPackage(tmp, { deps: false });
      expect(probeFramework(tmp, {}, ['content'])[0]).toBeNull();
    }));

  it('never takes an npm lifecycle hook as test evidence', () =>
    withTmp((tmp) => {
      writeJson(join(tmp, 'package.json'), {
        scripts: { postinstall: 'playwright install', prepare: 'k6 version' },
        devDependencies: { vitest: '*' },
      });
      expect(probeFramework(tmp, {}, [...PKG])).toEqual([
        'vitest',
        'frontend_unit',
        'package.json (devDependencies: vitest)',
        'content',
      ]);
    }));

  it('skips the pre/post hooks of another script, not pre-named scripts', () =>
    withTmp((tmp) => {
      writeJson(join(tmp, 'package.json'), {
        scripts: {
          test: 'node run.js',
          e2e: 'node run.js',
          pree2e: 'playwright install',
          posttest: 'k6 run x.js',
          preview: 'vitest --ui',
        },
      });
      expect(probeFramework(tmp, {}, ['scripts'])).toEqual([
        'vitest',
        'frontend_unit',
        'package.json (scripts.preview)',
        'content',
      ]);
    }));
});
