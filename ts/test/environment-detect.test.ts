/**
 * Faithful TypeScript port of `tests/unit/test_environment_detect.py`.
 *
 * Covers the three concrete, testable detection paths of issue #341:
 *   - `.env` BASE_URL extraction
 *   - `playwright.config.*` suite-hint parsing
 *   - the transparent SDET-vs-manual user-level heuristic
 *
 * Browser-tab detection (path (a) in #341) is deferred to #343 and not covered.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  EnvironmentContext,
  detectBaseUrl,
  detectEnvironment,
  detectUserLevel,
  parsePlaywrightSuiteHints,
} from '../src/core/environment-detect.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'canary-env-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(name: string, body: string): void {
  writeFileSync(join(root, name), body, 'utf-8');
}

describe('detectBaseUrl', () => {
  it('reads BASE_URL from .env', () => {
    write('.env', 'BASE_URL=https://app.example.com\n');
    const [url, source] = detectBaseUrl(root);
    expect(url).toBe('https://app.example.com');
    expect(source).toBe('.env');
  });

  it('strips quotes and export prefix', () => {
    write('.env', 'export BASE_URL="https://qa.example.com"\n');
    const [url] = detectBaseUrl(root);
    expect(url).toBe('https://qa.example.com');
  });

  it('ignores comments and blank lines', () => {
    write('.env', '# staging config\n\nBASE_URL=https://staging.example.com\n');
    const [url] = detectBaseUrl(root);
    expect(url).toBe('https://staging.example.com');
  });

  it('accepts the PLAYWRIGHT_BASE_URL alias', () => {
    write('.env', 'PLAYWRIGHT_BASE_URL=https://pw.example.com\n');
    const [url, source] = detectBaseUrl(root);
    expect(url).toBe('https://pw.example.com');
    expect(source).toBe('.env');
  });

  it('canonical BASE_URL wins over an alias', () => {
    write(
      '.env',
      'E2E_BASE_URL=https://alias.example.com\n' +
        'BASE_URL=https://canonical.example.com\n',
    );
    const [url] = detectBaseUrl(root);
    expect(url).toBe('https://canonical.example.com');
  });

  it('falls back to playwright.config baseURL', () => {
    write(
      'playwright.config.ts',
      "export default defineConfig({ use: { baseURL: 'https://cfg.example.com' } });\n",
    );
    const [url, source] = detectBaseUrl(root);
    expect(url).toBe('https://cfg.example.com');
    expect(source).toBe('playwright.config');
  });

  it('.env wins over playwright.config', () => {
    write('.env', 'BASE_URL=https://env.example.com\n');
    write(
      'playwright.config.ts',
      "export default { use: { baseURL: 'https://cfg.example.com' } };\n",
    );
    const [url, source] = detectBaseUrl(root);
    expect(url).toBe('https://env.example.com');
    expect(source).toBe('.env');
  });

  it('ignores a process.env indirection in the config', () => {
    write(
      'playwright.config.ts',
      'export default { use: { baseURL: process.env.BASE_URL } };\n',
    );
    const [url, source] = detectBaseUrl(root);
    expect(url).toBeNull();
    expect(source).toBeNull();
  });

  it('no signal returns null', () => {
    const [url, source] = detectBaseUrl(root);
    expect(url).toBeNull();
    expect(source).toBeNull();
  });
});

describe('parsePlaywrightSuiteHints', () => {
  it('no config returns null', () => {
    const [suiteType, hints] = parsePlaywrightSuiteHints(root);
    expect(suiteType).toBeNull();
    expect(hints).toEqual([]);
  });

  it('e2e testDir infers e2e', () => {
    write(
      'playwright.config.ts',
      "export default { testDir: './tests/e2e' };\n",
    );
    const [suiteType, hints] = parsePlaywrightSuiteHints(root);
    expect(suiteType).toBe('e2e');
    expect(hints).toContain('./tests/e2e');
  });

  it('component testDir/testMatch infers component', () => {
    write(
      'playwright.config.ts',
      "export default { testDir: './src/components', testMatch: '**/*.ct.tsx' };\n",
    );
    const [suiteType] = parsePlaywrightSuiteHints(root);
    expect(suiteType).toBe('component');
  });

  it('api testDir infers api', () => {
    write(
      'playwright.config.ts',
      "export default { testDir: './tests/api' };\n",
    );
    const [suiteType] = parsePlaywrightSuiteHints(root);
    expect(suiteType).toBe('api');
  });

  it('collects project names as hints', () => {
    write(
      'playwright.config.ts',
      "export default { projects: [{ name: 'chromium' }, { name: 'firefox' }] };\n",
    );
    const [, hints] = parsePlaywrightSuiteHints(root);
    expect(hints).toContain('chromium');
    expect(hints).toContain('firefox');
  });

  it('defaults to e2e when config present but unspecified', () => {
    write('playwright.config.js', 'module.exports = {};\n');
    const [suiteType] = parsePlaywrightSuiteHints(root);
    expect(suiteType).toBe('e2e');
  });
});

describe('detectUserLevel', () => {
  it('code files open signal sdet', () => {
    const [level, signals, confidence] = detectUserLevel(root, [
      'tests/login.spec.ts',
      'src/api.ts',
    ]);
    expect(level).toBe('sdet');
    expect(confidence).toBeGreaterThan(0.0);
    expect(signals.length).toBeGreaterThan(0);
  });

  it('docs and spreadsheets signal manual', () => {
    const [level] = detectUserLevel(root, [
      'test-cases.xlsx',
      'regression-plan.md',
    ]);
    expect(level).toBe('manual');
  });

  it('test config presence signals sdet', () => {
    write('playwright.config.ts', 'export default {};\n');
    const [level, signals] = detectUserLevel(root, null);
    expect(level).toBe('sdet');
    expect(signals.some((s) => s.includes('config'))).toBe(true);
  });

  it('manual cwd + component signal manual', () => {
    const manualDir = join(root, 'manual-test-cases');
    mkdirSync(manualDir);
    const [level] = detectUserLevel(manualDir, ['cases.csv']);
    expect(level).toBe('manual');
  });

  it('no signal is unknown with zero confidence', () => {
    const [level, signals, confidence] = detectUserLevel(root, null);
    expect(level).toBe('unknown');
    expect(confidence).toBe(0.0);
    expect(signals).toEqual([]);
  });

  it('confidence is bounded', () => {
    write('playwright.config.ts', 'export default {};\n');
    write('package.json', '{}');
    const [level, , confidence] = detectUserLevel(root, [
      'a.spec.ts',
      'b.test.ts',
      'c.py',
    ]);
    expect(level).toBe('sdet');
    expect(confidence).toBeLessThanOrEqual(1.0);
    expect(confidence).toBeGreaterThanOrEqual(0.0);
  });

  // Regression (adversarial review): Python does `Path(cwd)`, so an empty-string
  // cwd normalizes to "." and scans the current directory. An earlier draft used
  // existsSync("") (false) and skipped the scan entirely — diverging from the
  // oracle. Assert `""` behaves identically to ".".
  it('treats an empty cwd like "." (Path("") normalization)', () => {
    expect(detectUserLevel('', ['a.spec.ts'])).toEqual(
      detectUserLevel('.', ['a.spec.ts']),
    );
  });
});

describe('detectEnvironment', () => {
  it('returns an EnvironmentContext', () => {
    const ctx = detectEnvironment(root);
    expect(ctx).toBeInstanceOf(EnvironmentContext);
  });

  it('aggregates all paths', () => {
    write('.env', 'BASE_URL=https://app.example.com\n');
    write(
      'playwright.config.ts',
      "export default { testDir: './tests/e2e' };\n",
    );
    const ctx = detectEnvironment(root, {
      openFiles: ['tests/e2e/login.spec.ts'],
    });
    expect(ctx.base_url).toBe('https://app.example.com');
    expect(ctx.base_url_source).toBe('.env');
    expect(ctx.suite_type).toBe('e2e');
    expect(ctx.user_level).toBe('sdet');
  });

  it('empty project yields an unknown context', () => {
    const ctx = detectEnvironment(root);
    expect(ctx.base_url).toBeNull();
    expect(ctx.suite_type).toBeNull();
    expect(ctx.user_level).toBe('unknown');
  });

  // Regression (adversarial review): Python does `cwd or project_root`, so an
  // empty-string cwd falls back to project_root. `??` would wrongly keep "".
  it('collapses an empty-string cwd to project_root', () => {
    write('playwright.config.ts', 'export default {};\n');
    const withEmpty = detectEnvironment(root, { cwd: '' });
    const withDefault = detectEnvironment(root);
    expect(withEmpty.user_level).toBe(withDefault.user_level);
    expect(withEmpty.user_level).toBe('sdet');
  });

  it('toDict is JSON-friendly', () => {
    write('.env', 'BASE_URL=https://app.example.com\n');
    const ctx = detectEnvironment(root);
    const data = ctx.toDict();
    expect(data.base_url).toBe('https://app.example.com');
    expect(data).toHaveProperty('user_level');
    expect(data).toHaveProperty('suite_type');
  });

  // Extra (not in the Python oracle): pin round-to-3-decimals in toDict and
  // exercise the OSError-catch degrade paths (a directory in place of a file).
  it('rounds user_level_confidence to 3 decimals in toDict', () => {
    // 1 code file + 1 manual file → tie → confidence 0 is trivial; use a
    // 2:1 split so confidence = 1/3 = 0.333… rounds to 0.333.
    const ctx = new EnvironmentContext({
      user_level: 'sdet',
      user_level_confidence: 1 / 3,
    });
    expect(ctx.toDict().user_level_confidence).toBe(0.333);
  });

  it('degrades to null when .env is unreadable (a directory)', () => {
    mkdirSync(join(root, '.env'));
    const [url, source] = detectBaseUrl(root);
    expect(url).toBeNull();
    expect(source).toBeNull();
  });

  it('degrades when playwright.config is unreadable (a directory)', () => {
    mkdirSync(join(root, 'playwright.config.ts'));
    // base-url config read fails → continue → null.
    expect(detectBaseUrl(root)).toEqual([null, null]);
    // suite-hint read fails → configText '' → present-but-unspecified → e2e.
    const [suiteType, hints] = parsePlaywrightSuiteHints(root);
    expect(suiteType).toBe('e2e');
    expect(hints).toEqual([]);
  });
});
