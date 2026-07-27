/**
 * Tests for the `migrator` port (`agent/core/migrator.py`).
 *
 * Ports the migrator-facing suites -- test_migrator.py,
 * test_migrator_config_tolerance.py, test_migrate_freshness.py,
 * test_migrator_non_test_repo_guard.py, test_skill_deployment.py,
 * test_migrate_unknown_shape_deploy.py. Every Python case is preserved. The
 * Typer-CLI suites (test_migrate_cli.py, test_migrate_check_cli.py) are out of
 * scope for the core port.
 *
 * `Path.home()` (the `~/.canary/skills` tier) is injected as an empty temp dir
 * so the home tier never contributes -- matching what the Python tests assume of
 * the runner's home.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { HarnessMigrator, hashSkillDir } from '../src/core/migrator.js';
import { SkillRegistry } from '../src/core/skill-registry.js';

// Empty, isolated home so `~/.canary/skills` never contributes overlay skills.
const HOME = mkdtempSync(join(tmpdir(), 'canary-mig-home-'));
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

function mig(): HarnessMigrator {
  return new HarnessMigrator(HOME);
}

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), 'canary-mig-'));
}

function withTmp<T>(fn: (tmp: string) => T): T {
  const tmp = mkTmp();
  try {
    return fn(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function write(path: string, content: string): void {
  writeFileSync(path, content, 'utf-8');
}

function makeHarnessProject(
  root: string,
  opts: { language?: string; layers?: unknown[] } = {},
): void {
  const language = opts.language ?? 'python';
  const layers = opts.layers ?? [];
  const config = {
    version: 1,
    name: 'test-project',
    language,
    template: { language, version: 1, level: 'intermediate' },
    tooling: { testRunner: 'pytest' },
    layers,
  };
  write(join(root, 'harness.config.json'), JSON.stringify(config));
  mkdirSync(join(root, '.harness'), { recursive: true });
  write(join(root, '.harness', '.gitignore'), '*\n');
}

/** Bare harness project: harness.config.json + empty .harness/. */
function harnessProject(root: string, config: unknown): void {
  write(join(root, 'harness.config.json'), JSON.stringify(config));
  mkdirSync(join(root, '.harness'), { recursive: true });
}

function makeOverlaySkill(
  overlay: string,
  name: string,
  deployTo: string[],
  extraContent = '',
): string {
  const skillDir = join(overlay, '.canary', 'skills', name);
  mkdirSync(skillDir, { recursive: true });
  const frontmatter = `---\nname: ${name}\ndeploy_to: [${deployTo.join(', ')}]\n---\n\n# ${name}\n${extraContent}`;
  write(join(skillDir, 'SKILL.md'), frontmatter);
  return skillDir;
}

function overlayWithSkill(
  overlay: string,
  dirName: string,
  body: string,
  deployTo = 'all',
): string {
  const skillDir = join(overlay, '.canary', 'skills', dirName);
  mkdirSync(skillDir, { recursive: true });
  write(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${dirName}\ndeploy_to: [${deployTo}]\n---\n\n${body}\n`,
  );
  return skillDir;
}

// ===========================================================================
// test_migrator.py
// ===========================================================================

// Regression (adversarial review, SHIP-BLOCKER): the skill-dir hash feeds
// deploy/freshness verdicts and is compared against Python-written
// .deploy-manifest.json files on the upgrade path. Python sorts Path objects
// component-wise; a joined-string sort diverges when a directory name prefixes
// a sibling file ('scripts/' vs 'scripts.md', '.' 0x2E < '/' 0x2F), producing a
// different hash for byte-identical trees -> untouched skills misclassified as
// local_edit. This pins the TS hash to the Python oracle value.
describe('hashSkillDir Python parity (component-wise path sort)', () => {
  it('matches the Python _hash_skill_dir for a scripts/ + scripts.md tree', () =>
    withTmp((dir) => {
      write(join(dir, 'SKILL.md'), '---\nname: hashtest\n---\n\n# hashtest\n');
      mkdirSync(join(dir, 'scripts'), { recursive: true });
      write(join(dir, 'scripts', 'run.sh'), 'echo hi\n');
      write(join(dir, 'scripts.md'), 'docs\n');
      // Value computed by running agent/core/migrator._hash_skill_dir on the
      // byte-identical tree via the Python oracle.
      expect(hashSkillDir(dir)).toBe(
        'd7255b77dd2c68ba9f583c6132b25b851b301a65e78f49ff7c6c41e35d542f14',
      );
    }));
});

describe('TestDetectHarnessMarkers', () => {
  it('detects harness project with both markers', () =>
    withTmp((root) => {
      makeHarnessProject(root);
      expect(mig().detect(root).is_harness_project).toBe(true);
    }));
  it('not harness without config', () =>
    withTmp((root) => {
      mkdirSync(join(root, '.harness'));
      expect(mig().detect(root).is_harness_project).toBe(false);
    }));
  it('not harness without harness dir', () =>
    withTmp((root) => {
      write(join(root, 'harness.config.json'), '{}');
      expect(mig().detect(root).is_harness_project).toBe(false);
    }));
  it('not harness for empty directory', () =>
    withTmp((root) => {
      expect(mig().detect(root).is_harness_project).toBe(false);
    }));
});

describe('TestDetectFramework', () => {
  it('detects playwright from config file', () =>
    withTmp((root) => {
      makeHarnessProject(root);
      write(join(root, 'playwright.config.ts'), 'export default {};');
      const ctx = mig().detect(root);
      expect(ctx.detected_framework).toBe('playwright');
      expect(ctx.detected_shape).toBe('e2e_ui');
    }));
  it('detects vitest from config file', () =>
    withTmp((root) => {
      makeHarnessProject(root);
      write(join(root, 'vitest.config.ts'), 'export default {};');
      const ctx = mig().detect(root);
      expect(ctx.detected_framework).toBe('vitest');
      expect(ctx.detected_shape).toBe('frontend_unit');
    }));
  it('detects pytest from ini', () =>
    withTmp((root) => {
      makeHarnessProject(root, { language: 'python' });
      write(join(root, 'pytest.ini'), '[pytest]\n');
      const ctx = mig().detect(root);
      expect(ctx.detected_framework).toBe('pytest');
      expect(ctx.detected_shape).toBe('api');
    }));
  it('detects pytest from pyproject toml', () =>
    withTmp((root) => {
      makeHarnessProject(root, { language: 'python' });
      write(join(root, 'pyproject.toml'), '[tool.pytest.ini_options]\n');
      expect(mig().detect(root).detected_framework).toBe('pytest');
    }));
  it('detects k6 from config file', () =>
    withTmp((root) => {
      makeHarnessProject(root);
      write(join(root, 'k6.config.js'), 'export const options = {};');
      const ctx = mig().detect(root);
      expect(ctx.detected_framework).toBe('k6');
      expect(ctx.detected_shape).toBe('performance');
    }));
  it('playwright api suite detected when no page fixtures', () =>
    withTmp((root) => {
      makeHarnessProject(root);
      write(join(root, 'playwright.config.ts'), 'export default {};');
      const testsDir = join(root, 'tests', 'challenges');
      mkdirSync(testsDir, { recursive: true });
      write(
        join(testsDir, 'enroll.spec.ts'),
        "test('enroll', async ({api, user}) => { const r = await api.challenges.enroll(); });\n",
      );
      const ctx = mig().detect(root);
      expect(ctx.detected_framework).toBe('playwright');
      expect(ctx.detected_shape).toBe('api');
    }));
  it('playwright ui suite stays e2e_ui when page fixture present', () =>
    withTmp((root) => {
      makeHarnessProject(root);
      write(join(root, 'playwright.config.ts'), 'export default {};');
      const testsDir = join(root, 'tests');
      mkdirSync(testsDir, { recursive: true });
      write(
        join(testsDir, 'login.spec.ts'),
        "test('login', async ({ page }) => { await page.goto('/login'); });\n",
      );
      const ctx = mig().detect(root);
      expect(ctx.detected_framework).toBe('playwright');
      expect(ctx.detected_shape).toBe('e2e_ui');
    }));
  it('playwright api shape via company json override', () =>
    withTmp((root) => {
      makeHarnessProject(root);
      write(join(root, 'playwright.config.ts'), 'export default {};');
      const testsDir = join(root, 'tests');
      mkdirSync(testsDir, { recursive: true });
      write(
        join(testsDir, 'ui.spec.ts'),
        "test('ui', async ({ page }) => { await page.goto('/'); });\n",
      );
      const canaryDir = join(root, '.canary');
      mkdirSync(canaryDir);
      write(join(canaryDir, 'company.json'), '{"canary_shape": "api"}');
      expect(mig().detect(root).detected_shape).toBe('api');
    }));
  it('falls back to python language as pytest', () =>
    withTmp((root) => {
      makeHarnessProject(root, { language: 'python' });
      expect(mig().detect(root).detected_framework).toBe('pytest');
    }));
  it('falls back to playwright for typescript language', () =>
    withTmp((root) => {
      makeHarnessProject(root, { language: 'typescript' });
      expect(mig().detect(root).detected_framework).toBe('playwright');
    }));
  it('unknown framework when no signals', () =>
    withTmp((root) => {
      makeHarnessProject(root, { language: 'unknown-lang' });
      expect(mig().detect(root).detected_framework).toBeNull();
    }));
});

describe('TestPreservesExistingTests', () => {
  it('reports existing test files as preserved', () =>
    withTmp((root) => {
      makeHarnessProject(root, { language: 'python' });
      mkdirSync(join(root, 'tests'));
      write(join(root, 'tests', 'test_login.py'), 'def test_login(): pass\n');
      const report = mig().migrate(root, { dryRun: true });
      expect(report.preserved_files).toContain('tests/test_login.py');
    }));
  it('does not delete existing test files', () =>
    withTmp((root) => {
      makeHarnessProject(root, { language: 'python' });
      mkdirSync(join(root, 'tests'));
      const testFile = join(root, 'tests', 'test_existing.py');
      write(testFile, 'def test_existing(): pass\n');
      mig().migrate(root, { dryRun: false });
      expect(existsSync(testFile)).toBe(true);
      expect(readFileSync(testFile, 'utf-8')).toBe(
        'def test_existing(): pass\n',
      );
    }));
});

describe('TestDryRun', () => {
  it('dry run creates no files', () =>
    withTmp((root) => {
      makeHarnessProject(root, { language: 'python' });
      const before = new Set(collectAll(root));
      const report = mig().migrate(root, { dryRun: true });
      const after = new Set(collectAll(root));
      expect(after).toEqual(before);
      expect(report.dry_run).toBe(true);
    }));
  it('dry run still reports what would be created', () =>
    withTmp((root) => {
      makeHarnessProject(root, { language: 'python' });
      expect(
        mig().migrate(root, { dryRun: true }).would_create.length,
      ).toBeGreaterThan(0);
    }));
});

describe('TestApplyMode', () => {
  it('creates oracle config files', () =>
    withTmp((root) => {
      makeHarnessProject(root, { language: 'python' });
      mig().migrate(root, { dryRun: false });
      expect(existsSync(join(root, 'pytest.ini'))).toBe(true);
    }));
  it('creates oracle test dirs', () =>
    withTmp((root) => {
      makeHarnessProject(root, { language: 'python' });
      mig().migrate(root, { dryRun: false });
      expect(existsSync(join(root, 'tests'))).toBe(true);
    }));
  it('skips existing config files', () =>
    withTmp((root) => {
      makeHarnessProject(root, { language: 'python' });
      const original = '[pytest]\ntestpaths = custom\n';
      write(join(root, 'pytest.ini'), original);
      const report = mig().migrate(root, { dryRun: false });
      expect(report.skipped_configs).toContain('pytest.ini');
      expect(readFileSync(join(root, 'pytest.ini'), 'utf-8')).toBe(original);
    }));
  it('idempotent when run twice', () =>
    withTmp((root) => {
      makeHarnessProject(root, { language: 'python' });
      mig().migrate(root, { dryRun: false });
      const report2 = mig().migrate(root, { dryRun: false });
      expect(report2.created_files.length).toBe(0);
    }));
});

describe('TestMigrationReport', () => {
  it('report includes framework', () =>
    withTmp((root) => {
      makeHarnessProject(root, { language: 'python' });
      expect(mig().migrate(root, { dryRun: true }).framework).toBe('pytest');
    }));
  it('report includes shape', () =>
    withTmp((root) => {
      makeHarnessProject(root, { language: 'python' });
      const report = mig().migrate(root, { dryRun: true });
      expect([
        'api',
        'e2e_ui',
        'frontend_unit',
        'performance',
        'mobile',
        'unknown',
      ]).toContain(report.shape);
    }));
  it('report has manual followups for unknown framework', () =>
    withTmp((root) => {
      makeHarnessProject(root, { language: 'unknown-lang' });
      expect(
        mig().migrate(root, { dryRun: true }).manual_followups.length,
      ).toBeGreaterThan(0);
    }));
  it('to_markdown contains framework', () =>
    withTmp((root) => {
      makeHarnessProject(root, { language: 'python' });
      expect(mig().migrate(root, { dryRun: true }).to_markdown()).toContain(
        'pytest',
      );
    }));
  it('to_markdown contains dry run notice', () =>
    withTmp((root) => {
      makeHarnessProject(root, { language: 'python' });
      expect(
        mig().migrate(root, { dryRun: true }).to_markdown().toLowerCase(),
      ).toContain('dry run');
    }));
  it('to_markdown lists preserved files', () =>
    withTmp((root) => {
      makeHarnessProject(root, { language: 'python' });
      mkdirSync(join(root, 'tests'));
      write(join(root, 'tests', 'test_auth.py'), 'pass');
      expect(mig().migrate(root, { dryRun: true }).to_markdown()).toContain(
        'test_auth.py',
      );
    }));
});

describe('TestFrameworkOverride', () => {
  it('override replaces auto detected framework', () =>
    withTmp((root) => {
      makeHarnessProject(root, { language: 'python' });
      expect(
        mig().migrate(root, { dryRun: true, framework: 'playwright' })
          .framework,
      ).toBe('playwright');
    }));
  it('override is used for scaffold in apply mode', () =>
    withTmp((root) => {
      makeHarnessProject(root, { language: 'python' });
      mig().migrate(root, { dryRun: false, framework: 'vitest' });
      expect(existsSync(join(root, 'vitest.config.ts'))).toBe(true);
    }));
});

describe('TestNonHarnessProject', () => {
  it('migrate raises for non harness project', () =>
    withTmp((root) => {
      expect(() => mig().migrate(root, { dryRun: true })).toThrow();
    }));
  it('error message mentions harness markers', () =>
    withTmp((root) => {
      expect(() => mig().migrate(root, { dryRun: true })).toThrow(/harness/i);
    }));
});

describe('TestExtendedConfigFileDetection', () => {
  const cases: Array<[string, string, string, string | null]> = [
    ['jest.config.ts', 'export default {};', 'vitest', 'frontend_unit'],
    ['jest.config.js', 'module.exports = {};', 'vitest', null],
    ['cypress.config.ts', 'export default {};', 'playwright', 'e2e_ui'],
    ['vitest.config.mts', 'export default {};', 'vitest', null],
    ['locustfile.py', 'from locust import HttpUser\n', 'locust', 'load'],
    ['backstop.json', '{}', 'backstopjs', 'visual'],
    ['stryker.config.js', 'module.exports = {};', 'stryker', 'mutation'],
  ];
  for (const [file, body, framework, shape] of cases) {
    it(`detects ${file}`, () =>
      withTmp((root) => {
        makeHarnessProject(root, { language: 'typescript' });
        write(join(root, file), body);
        const ctx = mig().detect(root);
        expect(ctx.detected_framework).toBe(framework);
        if (shape !== null) expect(ctx.detected_shape).toBe(shape);
      }));
  }
});

describe('TestPackageJsonDetection', () => {
  function makePkg(root: string, testScript: string): void {
    makeHarnessProject(root, { language: 'typescript' });
    write(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { test: testScript } }),
    );
  }
  it('detects playwright from package json', () =>
    withTmp((root) => {
      makePkg(root, 'playwright test');
      const ctx = mig().detect(root);
      expect(ctx.detected_framework).toBe('playwright');
      expect(ctx.detection_source).toBe('package.json (scripts.test)');
      expect(ctx.detection_confidence).toBe('content');
    }));
  it('detects vitest from package json', () =>
    withTmp((root) => {
      makePkg(root, 'vitest run');
      expect(mig().detect(root).detected_framework).toBe('vitest');
    }));
  it('detects jest from package json', () =>
    withTmp((root) => {
      makePkg(root, 'jest --coverage');
      expect(mig().detect(root).detected_framework).toBe('vitest');
    }));
  it('config file takes precedence over package json', () =>
    withTmp((root) => {
      makePkg(root, 'jest --coverage');
      write(join(root, 'playwright.config.ts'), 'export default {};');
      const ctx = mig().detect(root);
      expect(ctx.detected_framework).toBe('playwright');
      expect(ctx.detection_confidence).toBe('config');
    }));
});

describe('TestRequirementsTxtDetection', () => {
  it('detects pytest from requirements txt', () =>
    withTmp((root) => {
      makeHarnessProject(root, { language: 'python' });
      write(join(root, 'requirements.txt'), 'pytest>=7.0\nrequests\n');
      const ctx = mig().detect(root);
      expect(ctx.detected_framework).toBe('pytest');
      expect(ctx.detection_source).toBe('requirements.txt');
      expect(ctx.detection_confidence).toBe('content');
    }));
  it('detects locust from requirements txt', () =>
    withTmp((root) => {
      makeHarnessProject(root, { language: 'python' });
      write(join(root, 'requirements.txt'), 'locust==2.17\n');
      const ctx = mig().detect(root);
      expect(ctx.detected_framework).toBe('locust');
      expect(ctx.detected_shape).toBe('load');
    }));
  it('detects from requirements dev txt', () =>
    withTmp((root) => {
      makeHarnessProject(root, { language: 'python' });
      write(join(root, 'requirements-dev.txt'), 'pytest\n');
      const ctx = mig().detect(root);
      expect(ctx.detected_framework).toBe('pytest');
      expect(ctx.detection_source).toBe('requirements-dev.txt');
    }));
  it('detects pytest from pyproject dependencies', () =>
    withTmp((root) => {
      makeHarnessProject(root, { language: 'python' });
      write(
        join(root, 'pyproject.toml'),
        '[tool.poetry.dependencies]\npytest = "^7.0"\nrequests = "*"\n',
      );
      const ctx = mig().detect(root);
      expect(ctx.detected_framework).toBe('pytest');
      expect(ctx.detection_source).toBe('pyproject.toml (dependencies)');
    }));
});

describe('TestDetectionSourceAndConfidence', () => {
  it('config file yields high confidence', () =>
    withTmp((root) => {
      makeHarnessProject(root);
      write(join(root, 'playwright.config.ts'), 'export default {};');
      const ctx = mig().detect(root);
      expect(ctx.detection_confidence).toBe('config');
      expect(ctx.detection_source).toBe('playwright.config.ts');
    }));
  it('language fallback yields low confidence', () =>
    withTmp((root) => {
      makeHarnessProject(root, { language: 'python' });
      const ctx = mig().detect(root);
      expect(ctx.detection_confidence).toBe('language');
      expect(ctx.detection_source).toContain('python');
    }));
  it('no detection yields none confidence', () =>
    withTmp((root) => {
      makeHarnessProject(root, { language: 'unknown-lang' });
      const ctx = mig().detect(root);
      expect(ctx.detection_confidence).toBe('none');
      expect(ctx.detected_framework).toBeNull();
    }));
  it('report includes detection source', () =>
    withTmp((root) => {
      makeHarnessProject(root);
      write(join(root, 'playwright.config.ts'), 'export default {};');
      const report = mig().migrate(root, { dryRun: true });
      expect(report.detection_source).toBe('playwright.config.ts');
      expect(report.detection_confidence).toBe('config');
    }));
  it('markdown shows detection source', () =>
    withTmp((root) => {
      makeHarnessProject(root);
      write(join(root, 'playwright.config.ts'), 'export default {};');
      const md = mig().migrate(root, { dryRun: true }).to_markdown();
      expect(md).toContain('playwright.config.ts');
      expect(md).toContain('high');
    }));
  it('markdown shows medium confidence for content detection', () =>
    withTmp((root) => {
      makeHarnessProject(root, { language: 'python' });
      write(join(root, 'requirements.txt'), 'pytest\n');
      expect(mig().migrate(root, { dryRun: true }).to_markdown()).toContain(
        'medium',
      );
    }));
  it('cli override recorded in report', () =>
    withTmp((root) => {
      makeHarnessProject(root, { language: 'python' });
      expect(
        mig().migrate(root, { dryRun: true, framework: 'vitest' })
          .detection_source,
      ).toBe('CLI override');
    }));
  it('dry run shows already present files', () =>
    withTmp((root) => {
      makeHarnessProject(root, { language: 'python' });
      write(join(root, 'pytest.ini'), '[pytest]\n');
      expect(mig().migrate(root, { dryRun: true }).skipped_configs).toContain(
        'pytest.ini',
      );
    }));
  it('dry run markdown shows already present section', () =>
    withTmp((root) => {
      makeHarnessProject(root, { language: 'python' });
      write(join(root, 'pytest.ini'), '[pytest]\n');
      expect(mig().migrate(root, { dryRun: true }).to_markdown()).toContain(
        'Already Present',
      );
    }));
});

describe('TestNewConfigShapes', () => {
  const cases: Array<[string, string, string, string]> = [
    ['axe.config.js', 'module.exports = {};', 'accessibility', 'axe-core'],
    ['backstop.json', '{}', 'visual', 'backstopjs'],
    ['pact.json', '{}', 'contract', 'pact'],
    ['stryker.config.mjs', 'export default {};', 'mutation', 'stryker'],
    ['locust.conf', '[locust]\n', 'load', 'locust'],
  ];
  for (const [file, body, shape, framework] of cases) {
    it(`detects ${shape}`, () =>
      withTmp((root) => {
        makeHarnessProject(root, { language: 'python' });
        write(join(root, file), body);
        const ctx = mig().detect(root);
        expect(ctx.detected_shape).toBe(shape);
        expect(ctx.detected_framework).toBe(framework);
      }));
  }
  it('detects synthetic_data from requirements', () =>
    withTmp((root) => {
      makeHarnessProject(root, { language: 'python' });
      write(join(root, 'requirements.txt'), 'faker==20.0\n');
      const ctx = mig().detect(root);
      expect(ctx.detected_shape).toBe('synthetic_data');
      expect(ctx.detected_framework).toBe('faker');
    }));
  it('detects integration shape from requirements', () =>
    withTmp((root) => {
      makeHarnessProject(root, { language: 'python' });
      write(join(root, 'requirements.txt'), 'testcontainers\n');
      const ctx = mig().detect(root);
      expect(ctx.detected_shape).toBe('integration');
      expect(ctx.detected_framework).toBe('testcontainers');
    }));
  it('detects wdio from config file', () =>
    withTmp((root) => {
      makeHarnessProject(root, { language: 'typescript' });
      write(join(root, 'wdio.conf.ts'), 'export const config = {};');
      const ctx = mig().detect(root);
      expect(ctx.detected_framework).toBe('wdio');
      expect(ctx.detected_shape).toBe('mobile');
    }));
  it('detects wdio from package json', () =>
    withTmp((root) => {
      makeHarnessProject(root, { language: 'typescript' });
      write(
        join(root, 'package.json'),
        JSON.stringify({ scripts: { test: 'wdio run wdio.conf.ts' } }),
      );
      const ctx = mig().detect(root);
      expect(ctx.detected_framework).toBe('wdio');
      expect(ctx.detected_shape).toBe('mobile');
    }));
});

describe('TestUnknownFrameworkFailsLoud', () => {
  it('unknown followup lists known frameworks', () =>
    withTmp((root) => {
      makeHarnessProject(root, { language: 'unknown-lang' });
      const joined = mig()
        .migrate(root, { dryRun: true })
        .manual_followups.join(' ');
      expect(joined).toContain('playwright');
      expect(joined).toContain('pytest');
      expect(joined).toContain('wdio');
    }));
  it('unknown followup mentions override flag', () =>
    withTmp((root) => {
      makeHarnessProject(root, { language: 'unknown-lang' });
      const joined = mig()
        .migrate(root, { dryRun: true })
        .manual_followups.join(' ');
      expect(joined).toContain('--framework');
    }));
  it('unknown followup is actionable not bare unknown', () =>
    withTmp((root) => {
      makeHarnessProject(root, { language: 'unknown-lang' });
      const joined = mig()
        .migrate(root, { dryRun: true })
        .manual_followups.join(' ')
        .toLowerCase();
      expect(joined).toContain('auto-detect');
    }));
  it('deploy_to all skills deploy even when framework unknown', () =>
    withTmp((base) => {
      const root = join(base, 'proj');
      mkdirSync(root);
      makeHarnessProject(root, { language: 'unknown-lang' });
      const overlay = join(base, 'overlay');
      const skillDir = join(overlay, '.canary', 'skills', 'universal-skill');
      mkdirSync(skillDir, { recursive: true });
      write(
        join(skillDir, 'SKILL.md'),
        '---\nname: universal-skill\ndeploy_to: [all]\n---\n\n# universal-skill\n',
      );
      const report = mig().migrate(root, {
        dryRun: true,
        overlayPath: overlay,
      });
      expect(report.deployed_skills.map((r) => r.skill_name)).toContain(
        'universal-skill',
      );
    }));
});

describe('TestMigrateUnsupportedFrameworkDegrades', () => {
  const followupText = (report: { manual_followups: string[] }): string =>
    report.manual_followups.join(' ').toLowerCase();

  it('apply surfaces followup not silent complete', () =>
    withTmp((root) => {
      makeHarnessProject(root);
      const report = mig().migrate(root, {
        dryRun: false,
        framework: 'locust',
      });
      expect(report.created_files).toEqual([]);
      const followup = followupText(report);
      expect(followup).toContain('scaffold template');
      expect(followup).toContain('locust');
      expect(report.to_markdown()).not.toContain('Migration complete');
    }));
  it('dry run does not claim already migrated', () =>
    withTmp((root) => {
      makeHarnessProject(root);
      const report = mig().migrate(root, { dryRun: true, framework: 'locust' });
      expect(followupText(report)).toContain('scaffold template');
      expect(report.to_markdown()).not.toContain('Migration complete');
    }));
  it('supported framework still reports complete', () =>
    withTmp((root) => {
      makeHarnessProject(root);
      const report = mig().migrate(root, {
        dryRun: false,
        framework: 'pytest',
      });
      expect(followupText(report)).not.toContain('scaffold template');
    }));
});

// ===========================================================================
// test_migrator_config_tolerance.py
// ===========================================================================

const AGENT_BACKENDS = { backends: { craft: { type: 'claude' } } };
const CRAFT_LLM = { llm: { backend: 'craft' } };
// ts/test -> repo root is two levels up.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('TestConfigToleranceOfBackendBlocks', () => {
  it('detect does not crash with backend blocks', () =>
    withTmp((root) => {
      harnessProject(root, {
        language: 'python',
        agent: AGENT_BACKENDS,
        craft: CRAFT_LLM,
      });
      expect(mig().detect(root).is_harness_project).toBe(true);
    }));
  it('language still read with backend blocks present', () =>
    withTmp((root) => {
      harnessProject(root, {
        language: 'python',
        agent: AGENT_BACKENDS,
        craft: CRAFT_LLM,
      });
      const ctx = mig().detect(root);
      expect(ctx.harness_config['language']).toBe('python');
      expect(ctx.detected_framework).toBe('pytest');
      expect(ctx.detected_shape).toBe('api');
      expect(ctx.detection_confidence).toBe('language');
    }));
  it('backend blocks do not emit a config warning', () =>
    withTmp((root) => {
      harnessProject(root, {
        language: 'typescript',
        agent: AGENT_BACKENDS,
        craft: CRAFT_LLM,
      });
      const ctx = mig().detect(root);
      expect(ctx.config_warnings).toEqual([]);
      expect(ctx.detected_framework).toBe('playwright');
    }));
  it('repo own harness config is tolerated', () => {
    const cfg = JSON.parse(
      readFileSync(join(REPO_ROOT, 'harness.config.json'), 'utf-8'),
    );
    withTmp((root) => {
      harnessProject(root, cfg);
      const ctx = mig().detect(root);
      expect(ctx.is_harness_project).toBe(true);
      expect(ctx.config_warnings).toEqual([]);
      expect(ctx.harness_config['language']).toBe(cfg.language);
    });
  });
  it('repo config plus synthetic backend blocks is tolerated', () => {
    const cfg = JSON.parse(
      readFileSync(join(REPO_ROOT, 'harness.config.json'), 'utf-8'),
    );
    cfg.agent = AGENT_BACKENDS;
    cfg.craft = CRAFT_LLM;
    withTmp((root) => {
      harnessProject(root, cfg);
      const ctx = mig().detect(root);
      expect(ctx.is_harness_project).toBe(true);
      expect(ctx.config_warnings).toEqual([]);
      expect(ctx.harness_config['language']).toBe(cfg.language);
    });
  });
});

describe('TestMalformedConfigSurfacesWarning', () => {
  it('malformed json populates config warnings', () =>
    withTmp((root) => {
      write(join(root, 'harness.config.json'), '{ not valid json');
      mkdirSync(join(root, '.harness'));
      const ctx = mig().detect(root);
      expect(ctx.is_harness_project).toBe(true);
      expect(ctx.config_warnings.length).toBe(1);
      expect(ctx.config_warnings[0]).toContain('not valid JSON');
      expect(ctx.harness_config).toEqual({});
    }));
  it('warning is not emitted for wellformed config', () =>
    withTmp((root) => {
      harnessProject(root, { language: 'python' });
      expect(mig().detect(root).config_warnings).toEqual([]);
    }));
  it('malformed company json also warns without blocking', () =>
    withTmp((root) => {
      harnessProject(root, { language: 'python' });
      const canary = join(root, '.canary');
      mkdirSync(canary);
      write(join(canary, 'company.json'), '{bad');
      const ctx = mig().detect(root);
      expect(ctx.config_warnings.some((w) => w.includes('company.json'))).toBe(
        true,
      );
      expect(ctx.detected_framework).toBe('pytest');
    }));
  it('config warning propagates into migration report', () =>
    withTmp((root) => {
      write(join(root, 'harness.config.json'), '}{');
      mkdirSync(join(root, '.harness'));
      const report = mig().migrate(root, { dryRun: true });
      expect(report.config_warnings.length).toBeGreaterThan(0);
      expect(report.to_markdown()).toContain('Config Warnings');
    }));
});

// The migrator.py-side config-validation tests (duplicated shape in
// test_migrator.py::TestConfigValidationWarnings) are covered above; the two
// unique markdown/hard-fail assertions are pinned here.
describe('TestConfigValidationWarnings (migrator.py)', () => {
  it('config warnings rendered in markdown', () =>
    withTmp((root) => {
      write(join(root, 'harness.config.json'), '{not valid json');
      mkdirSync(join(root, '.harness'));
      const md = mig()
        .migrate(root, { dryRun: true, framework: 'pytest' })
        .to_markdown();
      expect(md).toContain('Warning');
      expect(md).toContain('harness.config.json');
    }));
  it('malformed config does not hard fail migrate', () =>
    withTmp((root) => {
      write(join(root, 'harness.config.json'), '{not valid json');
      mkdirSync(join(root, '.harness'));
      const report = mig().migrate(root, { dryRun: true, framework: 'pytest' });
      expect(report.framework).toBe('pytest');
    }));
});

// ===========================================================================
// test_migrator_non_test_repo_guard.py
// ===========================================================================

// Regression (adversarial review #3): a malformed `layers` that is a truthy
// non-array (a JSON object) must NOT crash detect(). Python does
// `config.get("layers") or []` then iterates; a dict yields its keys (no dicts
// among them), so `names` is empty and detection proceeds. The port cast a
// non-array to unknown[] and for-of threw. Malformed configs are in scope.
describe('TestNonArrayLayersDoesNotCrash', () => {
  it('a non-array layers object does not throw detect()', () =>
    withTmp((root) => {
      const config = {
        version: 1,
        name: 'test-project',
        language: 'python',
        template: { language: 'python', version: 1, level: 'intermediate' },
        tooling: { testRunner: 'pytest' },
        layers: { skills: { pattern: '.canary/skills/**' } }, // object, not array
      };
      write(join(root, 'harness.config.json'), JSON.stringify(config));
      mkdirSync(join(root, '.harness'), { recursive: true });
      write(join(root, '.harness', '.gitignore'), '*\n');
      expect(() => mig().detect(root)).not.toThrow();
    }));
});

describe('TestSkillsDocsOverlayGuard', () => {
  it('skills docs overlay is not a test project', () =>
    withTmp((root) => {
      harnessProject(root, {
        language: 'python',
        entryPoints: [],
        layers: [
          { name: 'skills', pattern: '.canary/skills/**' },
          { name: 'docs', pattern: 'docs/**' },
        ],
      });
      const ctx = mig().detect(root);
      expect(ctx.is_harness_project).toBe(false);
      expect(ctx.not_test_project_reason).not.toBeNull();
      expect(ctx.not_test_project_reason!.toLowerCase()).toContain('overlay');
    }));
  it('missing entrypoints key with only doc layers is guarded', () =>
    withTmp((root) => {
      harnessProject(root, { layers: [{ name: 'docs', pattern: 'docs/**' }] });
      const ctx = mig().detect(root);
      expect(ctx.is_harness_project).toBe(false);
      expect(ctx.not_test_project_reason).not.toBeNull();
    }));
  it('real test project with entrypoints is not guarded', () =>
    withTmp((root) => {
      harnessProject(root, {
        language: 'python',
        entryPoints: ['agent.cli:app'],
        layers: [{ name: 'skills', pattern: '.canary/skills/**' }],
      });
      const ctx = mig().detect(root);
      expect(ctx.is_harness_project).toBe(true);
      expect(ctx.not_test_project_reason).toBeNull();
    }));
  it('code layers are not guarded even without entrypoints', () =>
    withTmp((root) => {
      harnessProject(root, {
        layers: [
          { name: 'core', pattern: 'src/core/**' },
          { name: 'tests', pattern: 'tests/**' },
        ],
      });
      expect(mig().detect(root).is_harness_project).toBe(true);
    }));
  it('migrate raises distinct error for overlay', () =>
    withTmp((root) => {
      harnessProject(root, {
        entryPoints: [],
        layers: [{ name: 'skills', pattern: '.canary/skills/**' }],
      });
      let msg = '';
      try {
        mig().migrate(root, {});
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).not.toContain('Expected harness.config.json');
      expect(msg.toLowerCase()).toContain('overlay');
    }));
  it('no config at all keeps the generic message', () =>
    withTmp((root) => {
      const ctx = mig().detect(root);
      expect(ctx.is_harness_project).toBe(false);
      expect(ctx.not_test_project_reason).toBeNull();
    }));
});

// ===========================================================================
// test_skill_deployment.py
// ===========================================================================

describe('TestDeployToFrontmatter', () => {
  function skillInfo(deployToLine: string) {
    return withTmp((tmp) => {
      const skillDir = join(tmp, 'myskill');
      mkdirSync(skillDir);
      write(
        join(skillDir, 'SKILL.md'),
        `---\nname: myskill\n${deployToLine}\n---\n\n# My skill`,
      );
      return new SkillRegistry().parseNested(
        join(skillDir, 'SKILL.md'),
        'myskill',
        'local',
      );
    });
  }
  it('list value parsed', () =>
    expect(skillInfo('deploy_to: [api, e2e]')!.deploy_to).toEqual([
      'api',
      'e2e',
    ]));
  it('single value in list', () =>
    expect(skillInfo('deploy_to: [api]')!.deploy_to).toEqual(['api']));
  it('all sentinel', () =>
    expect(skillInfo('deploy_to: [all]')!.deploy_to).toEqual(['all']));
  it('missing field returns empty', () =>
    expect(skillInfo('')!.deploy_to).toEqual([]));
  it('scalar value wrapped in list', () =>
    expect(skillInfo('deploy_to: api')!.deploy_to).toEqual(['api']));
  it('whitespace trimmed', () =>
    expect(skillInfo('deploy_to: [ api , e2e ]')!.deploy_to).toEqual([
      'api',
      'e2e',
    ]));
});

describe('TestDeploySkills', () => {
  function setup(): { root: string; target: string; overlay: string } {
    const root = mkTmp();
    const target = join(root, 'target');
    const overlay = join(root, 'overlay');
    mkdirSync(target);
    mkdirSync(overlay);
    return { root, target, overlay };
  }
  function run<T>(fn: (s: { target: string; overlay: string }) => T): T {
    const s = setup();
    try {
      return fn(s);
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  }

  it('matching skill copied on apply', () =>
    run(({ target, overlay }) => {
      makeOverlaySkill(overlay, 'login-helper', ['e2e_ui']);
      const results = mig().deploySkills('e2e_ui', overlay, target, false);
      expect(results.length).toBe(1);
      expect(results[0]!.status).toBe('copied');
      expect(
        existsSync(
          join(target, '.canary', 'skills', 'login-helper', 'SKILL.md'),
        ),
      ).toBe(true);
    }));
  it('dry run does not copy', () =>
    run(({ target, overlay }) => {
      makeOverlaySkill(overlay, 'login-helper', ['e2e_ui']);
      const results = mig().deploySkills('e2e_ui', overlay, target, true);
      expect(results[0]!.status).toBe('dry_run');
      expect(
        existsSync(join(target, '.canary', 'skills', 'login-helper')),
      ).toBe(false);
    }));
  it('non matching shape not deployed', () =>
    run(({ target, overlay }) => {
      makeOverlaySkill(overlay, 'api-bridge', ['api']);
      expect(mig().deploySkills('e2e_ui', overlay, target, false)).toEqual([]);
    }));
  it('all sentinel deploys to any shape', () =>
    run(({ target, overlay }) => {
      makeOverlaySkill(overlay, 'universal-skill', ['all']);
      expect(mig().deploySkills('api', overlay, target, false)[0]!.status).toBe(
        'copied',
      );
    }));
  it('already present skill skipped', () =>
    run(({ target, overlay }) => {
      makeOverlaySkill(overlay, 'login-helper', ['e2e_ui']);
      const dest = join(target, '.canary', 'skills', 'login-helper');
      mkdirSync(dest, { recursive: true });
      write(join(dest, 'SKILL.md'), 'existing');
      const results = mig().deploySkills('e2e_ui', overlay, target, false);
      expect(results[0]!.status).toBe('skipped');
      expect(readFileSync(join(dest, 'SKILL.md'), 'utf-8')).toBe('existing');
    }));
  it('no deploy_to field not deployed', () =>
    run(({ target, overlay }) => {
      const skillDir = join(overlay, '.canary', 'skills', 'markdown-only');
      mkdirSync(skillDir, { recursive: true });
      write(
        join(skillDir, 'SKILL.md'),
        '---\nname: markdown-only\n---\n\n# Skill',
      );
      expect(mig().deploySkills('api', overlay, target, false)).toEqual([]);
    }));
  it('multiple skills filtered by shape', () =>
    run(({ target, overlay }) => {
      makeOverlaySkill(overlay, 'api-bridge', ['api']);
      makeOverlaySkill(overlay, 'login-helper', ['e2e_ui', 'api']);
      makeOverlaySkill(overlay, 'ui-bridge', ['e2e_ui']);
      const results = mig().deploySkills('api', overlay, target, false);
      const deployed = new Set(
        results.filter((r) => r.status === 'copied').map((r) => r.skill_name),
      );
      expect(deployed.has('api-bridge')).toBe(true);
      expect(deployed.has('login-helper')).toBe(true);
      expect(deployed.has('ui-bridge')).toBe(false);
    }));
  it('none overlay returns empty', () =>
    run(({ target }) => {
      expect(mig().deploySkills('api', null, target, false)).toEqual([]);
    }));
  it('overlay extra files copied with skill', () =>
    run(({ target, overlay }) => {
      const skillDir = makeOverlaySkill(overlay, 'rich-skill', ['api']);
      write(join(skillDir, 'helpers.py'), '# helper');
      mig().deploySkills('api', overlay, target, false);
      expect(
        existsSync(
          join(target, '.canary', 'skills', 'rich-skill', 'helpers.py'),
        ),
      ).toBe(true);
    }));

  // Coverage: overlayPath pointing directly at a `.canary/skills` dir.
  it('overlay path may be the skills dir itself', () =>
    run(({ target, overlay }) => {
      makeOverlaySkill(overlay, 'direct-skill', ['api']);
      const skillsDir = join(overlay, '.canary', 'skills');
      const results = mig().deploySkills('api', skillsDir, target, false);
      expect(results.map((r) => r.skill_name)).toContain('direct-skill');
    }));

  // Coverage: identical hand-placed skill (no manifest) is "already current"
  // and back-fills the manifest so a later check_freshness reads it as current.
  it('identical hand-placed skill is already current and back-fills manifest', () =>
    run(({ target, overlay }) => {
      makeOverlaySkill(overlay, 'demo', ['api']);
      const dest = join(target, '.canary', 'skills', 'demo');
      mkdirSync(dest, { recursive: true });
      write(
        join(dest, 'SKILL.md'),
        `---\nname: demo\ndeploy_to: [api]\n---\n\n# demo\n`,
      );
      const results = mig().deploySkills('api', overlay, target, false);
      expect(results[0]!.status).toBe('skipped');
      expect(results[0]!.note).toBe('already current');
      expect(
        existsSync(join(target, '.canary', 'skills', '.deploy-manifest.json')),
      ).toBe(true);
    }));

  // Coverage: home-dir tier (~/.canary/skills) contributes overlay skills.
  it('home tier skills deploy', () => {
    const home = mkTmp();
    const target = mkTmp();
    try {
      const skillDir = join(home, '.canary', 'skills', 'home-skill');
      mkdirSync(skillDir, { recursive: true });
      write(
        join(skillDir, 'SKILL.md'),
        '---\nname: home-skill\ndeploy_to: [all]\n---\n\n# home-skill\n',
      );
      const results = new HarnessMigrator(home).deploySkills(
        'api',
        null,
        target,
        false,
      );
      expect(results.map((r) => r.skill_name)).toContain('home-skill');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe('TestMigrateWithSkillDeployment', () => {
  function run<T>(fn: (s: { target: string; overlay: string }) => T): T {
    const root = mkTmp();
    const target = join(root, 'target');
    const overlay = join(root, 'overlay');
    mkdirSync(target);
    mkdirSync(overlay);
    makeHarnessProject(target); // default python -> but this helper uses playwright below
    try {
      return fn({ target, overlay });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  // Python helper makes a playwright project; replicate that shape here.
  function playwrightTarget(target: string): void {
    write(
      join(target, 'harness.config.json'),
      JSON.stringify({ language: 'typescript', framework: 'playwright' }),
    );
    if (!existsSync(join(target, '.harness')))
      mkdirSync(join(target, '.harness'));
    write(join(target, 'playwright.config.ts'), 'export default {};');
  }

  it('migrate deploys matching skills', () =>
    run(({ target, overlay }) => {
      playwrightTarget(target);
      makeOverlaySkill(overlay, 'login-helper', ['e2e_ui']);
      const report = mig().migrate(target, {
        dryRun: false,
        overlayPath: overlay,
      });
      expect(report.deployed_skills.length).toBe(1);
      expect(report.deployed_skills[0]!.status).toBe('copied');
    }));
  it('migrate dry run reports but does not copy', () =>
    run(({ target, overlay }) => {
      playwrightTarget(target);
      makeOverlaySkill(overlay, 'login-helper', ['e2e_ui']);
      const report = mig().migrate(target, {
        dryRun: true,
        overlayPath: overlay,
      });
      expect(report.deployed_skills[0]!.status).toBe('dry_run');
      expect(
        existsSync(join(target, '.canary', 'skills', 'login-helper')),
      ).toBe(false);
    }));
  it('migrate without overlay no deployed skills', () =>
    run(({ target }) => {
      playwrightTarget(target);
      expect(mig().migrate(target, { dryRun: true }).deployed_skills).toEqual(
        [],
      );
    }));
  it('to_markdown includes skill section', () =>
    run(({ target, overlay }) => {
      playwrightTarget(target);
      makeOverlaySkill(overlay, 'login-helper', ['e2e_ui']);
      const md = mig()
        .migrate(target, { dryRun: false, overlayPath: overlay })
        .to_markdown();
      expect(md).toContain('Skills Deployed');
      expect(md).toContain('login-helper');
    }));
  it('to_markdown dry run skill section', () =>
    run(({ target, overlay }) => {
      playwrightTarget(target);
      makeOverlaySkill(overlay, 'login-helper', ['e2e_ui']);
      const md = mig()
        .migrate(target, { dryRun: true, overlayPath: overlay })
        .to_markdown();
      expect(md).toContain('would deploy');
      expect(md).toContain('login-helper');
    }));
});

// ===========================================================================
// test_migrate_unknown_shape_deploy.py
// ===========================================================================

describe('TestUnknownShapeDeployment', () => {
  function run<T>(fn: (s: { target: string; overlay: string }) => T): T {
    const root = mkTmp();
    const target = join(root, 'target');
    const overlay = join(root, 'overlay');
    mkdirSync(target);
    mkdirSync(overlay);
    harnessProject(target, { name: 'mystery' });
    try {
      return fn({ target, overlay });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('detection is genuinely unknown', () =>
    run(({ target }) => {
      const ctx = mig().detect(target);
      expect(ctx.detected_framework).toBeNull();
      expect(ctx.detected_shape).toBe('unknown');
    }));
  it('all sentinel skill deploys despite unknown framework', () =>
    run(({ target, overlay }) => {
      makeOverlaySkill(overlay, 'universal-helper', ['all']);
      const report = mig().migrate(target, {
        dryRun: false,
        overlayPath: overlay,
      });
      expect(report.framework).toBe('unknown');
      expect(report.shape).toBe('unknown');
      const deployed = new Set(
        report.deployed_skills
          .filter((r) => r.status === 'copied')
          .map((r) => r.skill_name),
      );
      expect(deployed.has('universal-helper')).toBe(true);
      expect(
        existsSync(
          join(target, '.canary', 'skills', 'universal-helper', 'SKILL.md'),
        ),
      ).toBe(true);
    }));
  it('shape specific skill skipped when shape unknown', () =>
    run(({ target, overlay }) => {
      makeOverlaySkill(overlay, 'ui-only', ['e2e_ui']);
      const report = mig().migrate(target, {
        dryRun: false,
        overlayPath: overlay,
      });
      const names = new Set(report.deployed_skills.map((r) => r.skill_name));
      expect(names.has('ui-only')).toBe(false);
      expect(existsSync(join(target, '.canary', 'skills', 'ui-only'))).toBe(
        false,
      );
    }));
  it('mixed overlay only all sentinel survives', () =>
    run(({ target, overlay }) => {
      makeOverlaySkill(overlay, 'universal-helper', ['all']);
      makeOverlaySkill(overlay, 'ui-only', ['e2e_ui']);
      makeOverlaySkill(overlay, 'api-only', ['api']);
      const report = mig().migrate(target, {
        dryRun: false,
        overlayPath: overlay,
      });
      const copied = new Set(
        report.deployed_skills
          .filter((r) => r.status === 'copied')
          .map((r) => r.skill_name),
      );
      expect(copied).toEqual(new Set(['universal-helper']));
    }));
  it('unknown branch still reports detection followup', () =>
    run(({ target, overlay }) => {
      makeOverlaySkill(overlay, 'universal-helper', ['all']);
      const report = mig().migrate(target, {
        dryRun: false,
        overlayPath: overlay,
      });
      expect(report.manual_followups.length).toBeGreaterThan(0);
      expect(
        report.manual_followups.some((f) =>
          f.toLowerCase().includes('framework'),
        ),
      ).toBe(true);
    }));
  it('dry run unknown branch reports all sentinel without copying', () =>
    run(({ target, overlay }) => {
      makeOverlaySkill(overlay, 'universal-helper', ['all']);
      const report = mig().migrate(target, {
        dryRun: true,
        overlayPath: overlay,
      });
      const statuses = Object.fromEntries(
        report.deployed_skills.map((r) => [r.skill_name, r.status]),
      );
      expect(statuses['universal-helper']).toBe('dry_run');
      expect(
        existsSync(join(target, '.canary', 'skills', 'universal-helper')),
      ).toBe(false);
    }));
});

describe('TestLessCommonFrameworkDeployment', () => {
  function run<T>(fn: (s: { target: string; overlay: string }) => T): T {
    const root = mkTmp();
    const target = join(root, 'target');
    const overlay = join(root, 'overlay');
    mkdirSync(target);
    mkdirSync(overlay);
    harnessProject(target, { language: 'typescript' });
    write(join(target, 'wdio.conf.js'), 'exports.config = {};');
    try {
      return fn({ target, overlay });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  it('wdio detected as mobile shape', () =>
    run(({ target }) => {
      const ctx = mig().detect(target);
      expect(ctx.detected_framework).toBe('wdio');
      expect(ctx.detected_shape).toBe('mobile');
    }));
  it('mobile shape skill deploys and ui skill skipped', () =>
    run(({ target, overlay }) => {
      makeOverlaySkill(overlay, 'mobile-helper', ['mobile']);
      makeOverlaySkill(overlay, 'ui-only', ['e2e_ui']);
      const report = mig().migrate(target, {
        dryRun: false,
        overlayPath: overlay,
      });
      expect(report.framework).toBe('wdio');
      expect(report.shape).toBe('mobile');
      const copied = new Set(
        report.deployed_skills
          .filter((r) => r.status === 'copied')
          .map((r) => r.skill_name),
      );
      expect(copied.has('mobile-helper')).toBe(true);
      expect(copied.has('ui-only')).toBe(false);
    }));
});

// ===========================================================================
// test_migrate_freshness.py
// ===========================================================================

function makeFreshnessProject(root: string): void {
  write(
    join(root, 'harness.config.json'),
    JSON.stringify({ language: 'python', layers: [] }),
  );
  mkdirSync(join(root, '.harness'), { recursive: true });
}

describe('TestFreshnessInSync', () => {
  it('identical deployed skill is current', () =>
    withTmp((base) => {
      const root = join(base, 'proj');
      const overlay = join(base, 'overlay');
      mkdirSync(root);
      makeFreshnessProject(root);
      overlayWithSkill(overlay, 'demo', '# demo v1');
      const m = mig();
      m.migrate(root, { dryRun: false, overlayPath: overlay });
      const report = m.checkFreshness(root, { overlayPath: overlay });
      expect(report.in_sync).toBe(true);
      expect(report.has_drift).toBe(false);
      expect(report.has_local_edits).toBe(false);
      expect(report.results.map((r) => r.status)).toEqual(['current']);
    }));
});

describe('TestFreshnessDrift', () => {
  it('missing skill is drift', () =>
    withTmp((base) => {
      const root = join(base, 'proj');
      const overlay = join(base, 'overlay');
      mkdirSync(root);
      makeFreshnessProject(root);
      overlayWithSkill(overlay, 'demo', '# demo v1');
      const report = mig().checkFreshness(root, { overlayPath: overlay });
      expect(report.has_drift).toBe(true);
      expect(report.results[0]!.status).toBe('missing');
    }));
  it('updated overlay makes deployed skill stale', () =>
    withTmp((base) => {
      const root = join(base, 'proj');
      const overlay = join(base, 'overlay');
      mkdirSync(root);
      makeFreshnessProject(root);
      overlayWithSkill(overlay, 'demo', '# demo v1');
      const m = mig();
      m.migrate(root, { dryRun: false, overlayPath: overlay });
      overlayWithSkill(overlay, 'demo', `# demo v2 \u{2014} new guidance`);
      const report = m.checkFreshness(root, { overlayPath: overlay });
      expect(report.has_drift).toBe(true);
      expect(report.has_local_edits).toBe(false);
      expect(report.results[0]!.status).toBe('stale');
    }));
});

describe('TestFreshnessLocalEdits', () => {
  it('locally edited deployed skill is refused', () =>
    withTmp((base) => {
      const root = join(base, 'proj');
      const overlay = join(base, 'overlay');
      mkdirSync(root);
      makeFreshnessProject(root);
      overlayWithSkill(overlay, 'demo', '# demo v1');
      const m = mig();
      m.migrate(root, { dryRun: false, overlayPath: overlay });
      write(
        join(root, '.canary', 'skills', 'demo', 'SKILL.md'),
        `---\nname: demo\ndeploy_to: [all]\n---\n\n# demo \u{2014} hand tweaked locally\n`,
      );
      const report = m.checkFreshness(root, { overlayPath: overlay });
      expect(report.has_local_edits).toBe(true);
      expect(report.has_drift).toBe(false);
      expect(report.results[0]!.status).toBe('local_edit');
    }));
  it('deployed without provenance and differing is treated as local edit', () =>
    withTmp((base) => {
      const root = join(base, 'proj');
      const overlay = join(base, 'overlay');
      mkdirSync(root);
      makeFreshnessProject(root);
      overlayWithSkill(overlay, 'demo', '# demo v1');
      const dest = join(root, '.canary', 'skills', 'demo');
      mkdirSync(dest, { recursive: true });
      write(
        join(dest, 'SKILL.md'),
        `---\nname: demo\ndeploy_to: [all]\n---\n\n# demo \u{2014} my own\n`,
      );
      const report = mig().checkFreshness(root, { overlayPath: overlay });
      expect(report.results[0]!.status).toBe('local_edit');
    }));
});

describe('TestFreshnessReportRendering', () => {
  it('markdown names skills and statuses', () =>
    withTmp((base) => {
      const root = join(base, 'proj');
      const overlay = join(base, 'overlay');
      mkdirSync(root);
      makeFreshnessProject(root);
      overlayWithSkill(overlay, 'demo', '# demo v1');
      const md = mig()
        .checkFreshness(root, { overlayPath: overlay })
        .to_markdown();
      expect(md).toContain('demo');
      expect(md.toLowerCase()).toContain('missing');
    }));
  it('non harness project raises', () =>
    withTmp((root) => {
      expect(() => mig().checkFreshness(root, { overlayPath: null })).toThrow();
    }));
});

describe('TestApplyRefreshesStaleButSkipsLocalEdits', () => {
  it('apply overwrites stale skill', () =>
    withTmp((base) => {
      const root = join(base, 'proj');
      const overlay = join(base, 'overlay');
      mkdirSync(root);
      makeFreshnessProject(root);
      overlayWithSkill(overlay, 'demo', '# demo v1');
      const m = mig();
      m.migrate(root, { dryRun: false, overlayPath: overlay });
      overlayWithSkill(overlay, 'demo', `# demo v2 \u{2014} new guidance`);
      const report = m.migrate(root, { dryRun: false, overlayPath: overlay });
      const deployed = join(root, '.canary', 'skills', 'demo', 'SKILL.md');
      expect(readFileSync(deployed, 'utf-8')).toContain('v2');
      const statuses = Object.fromEntries(
        report.deployed_skills.map((r) => [r.skill_name, r.status]),
      );
      expect(statuses['demo']).toBe('updated');
      expect(m.checkFreshness(root, { overlayPath: overlay }).in_sync).toBe(
        true,
      );
    }));
  it('apply never overwrites local edit', () =>
    withTmp((base) => {
      const root = join(base, 'proj');
      const overlay = join(base, 'overlay');
      mkdirSync(root);
      makeFreshnessProject(root);
      overlayWithSkill(overlay, 'demo', '# demo v1');
      const m = mig();
      m.migrate(root, { dryRun: false, overlayPath: overlay });
      const edited =
        '---\nname: demo\ndeploy_to: [all]\n---\n\n# demo \u{2014} precious local work\n';
      write(join(root, '.canary', 'skills', 'demo', 'SKILL.md'), edited);
      overlayWithSkill(overlay, 'demo', '# demo v2');
      const report = m.migrate(root, { dryRun: false, overlayPath: overlay });
      expect(
        readFileSync(
          join(root, '.canary', 'skills', 'demo', 'SKILL.md'),
          'utf-8',
        ),
      ).toBe(edited);
      const statuses = Object.fromEntries(
        report.deployed_skills.map((r) => [r.skill_name, r.status]),
      );
      expect(statuses['demo']).toBe('skipped');
    }));
});

// Extra coverage for FreshnessReport surface not hit above.
describe('FreshnessReport surface coverage', () => {
  it('empty results markdown branch', () =>
    withTmp((base) => {
      const root = join(base, 'proj');
      mkdirSync(root);
      makeFreshnessProject(root);
      // No overlay skills -> no results -> the "no overlay skills" branch.
      const report = mig().checkFreshness(root, {
        overlayPath: join(base, 'empty'),
      });
      expect(report.results).toEqual([]);
      expect(report.to_markdown()).toContain('No overlay skills match');
    }));
  it('to_dict and exit_code reflect status', () =>
    withTmp((base) => {
      const root = join(base, 'proj');
      const overlay = join(base, 'overlay');
      mkdirSync(root);
      makeFreshnessProject(root);
      overlayWithSkill(overlay, 'demo', '# demo v1');
      const report = mig().checkFreshness(root, { overlayPath: overlay });
      const d = report.to_dict();
      expect(d['has_drift']).toBe(true);
      expect(d['exit_code']).toBe(1);
      expect(report.overlay_path).toBe(overlay);
      expect((d['skills'] as unknown[]).length).toBe(1);
    }));
  it('in-sync and local-edit markdown branches', () =>
    withTmp((base) => {
      const root = join(base, 'proj');
      const overlay = join(base, 'overlay');
      mkdirSync(root);
      makeFreshnessProject(root);
      overlayWithSkill(overlay, 'demo', '# demo v1');
      const m = mig();
      m.migrate(root, { dryRun: false, overlayPath: overlay });
      // In-sync markdown.
      expect(
        m.checkFreshness(root, { overlayPath: overlay }).to_markdown(),
      ).toContain('In sync');
      // Local edit markdown + exit_code 2.
      write(
        join(root, '.canary', 'skills', 'demo', 'SKILL.md'),
        '---\nname: demo\ndeploy_to: [all]\n---\n\n# hand edit\n',
      );
      const edited = m.checkFreshness(root, { overlayPath: overlay });
      expect(edited.exit_code()).toBe(2);
      const md = edited.to_markdown();
      expect(md).toContain('Local edits');
      expect(md).toContain('one-way ownership');
    }));
});

// Extra coverage for MigrationReport apply-mode markdown branches.
describe('MigrationReport apply markdown coverage', () => {
  it('renders created files, dirs, and skipped-as-preserved', () =>
    withTmp((root) => {
      makeHarnessProject(root, { language: 'python' });
      write(join(root, 'pytest.ini'), '[pytest]\ncustom\n'); // pre-existing config
      const md = mig().migrate(root, { dryRun: false }).to_markdown();
      // pytest scaffolds tests/ dir; pytest.ini is skipped as preserved.
      expect(md).toContain('Created Directories');
      expect(md).toContain('Skipped (already exist)');
      expect(md).toContain('preserved as-is');
      expect(md).toContain('Migration complete');
    }));
});

// Deployment edge cases: nested skill files, bogus overlay, malformed manifest.
describe('deploy edge coverage', () => {
  function run<T>(fn: (s: { target: string; overlay: string }) => T): T {
    const root = mkTmp();
    const target = join(root, 'target');
    const overlay = join(root, 'overlay');
    mkdirSync(target);
    mkdirSync(overlay);
    try {
      return fn({ target, overlay });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('hashes and deploys skills with nested subdirectories', () =>
    run(({ target, overlay }) => {
      const skillDir = makeOverlaySkill(overlay, 'nested', ['all']);
      const sub = join(skillDir, 'lib', 'deep');
      mkdirSync(sub, { recursive: true });
      write(join(sub, 'util.ts'), 'export const x = 1;\n');
      const m = new HarnessMigrator(HOME);
      const results = m.deploySkills('api', overlay, target, false);
      expect(results[0]!.status).toBe('copied');
      expect(
        existsSync(
          join(target, '.canary', 'skills', 'nested', 'lib', 'deep', 'util.ts'),
        ),
      ).toBe(true);
      // Re-deploy: identical nested content -> already current (nested hash walk).
      const again = m.deploySkills('api', overlay, target, false);
      expect(again[0]!.status).toBe('skipped');
      expect(again[0]!.note).toBe('already current');
    }));

  it('overlay path without a .canary/skills dir yields no skills', () =>
    run(({ target, overlay }) => {
      // overlay has no .canary/skills subtree at all.
      expect(mig().deploySkills('api', overlay, target, false)).toEqual([]);
    }));

  it('malformed deploy manifest is treated as empty provenance', () =>
    run(({ target, overlay }) => {
      makeOverlaySkill(overlay, 'demo', ['api']);
      const skillsDir = join(target, '.canary', 'skills');
      mkdirSync(skillsDir, { recursive: true });
      write(join(skillsDir, '.deploy-manifest.json'), 'not json at all');
      const results = mig().deploySkills('api', overlay, target, false);
      expect(results[0]!.status).toBe('copied');
    }));

  it('manifest with non-object skills degrades to empty', () =>
    run(({ target, overlay }) => {
      makeOverlaySkill(overlay, 'demo', ['api']);
      const skillsDir = join(target, '.canary', 'skills');
      mkdirSync(skillsDir, { recursive: true });
      write(
        join(skillsDir, '.deploy-manifest.json'),
        JSON.stringify({ schemaVersion: 1, skills: [] }),
      );
      const results = mig().deploySkills('api', overlay, target, false);
      expect(results[0]!.status).toBe('copied');
    }));
});

/** Recursive list of every path under root (files + dirs), like rglob("*"). */
function collectAll(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      out.push(full);
      if (e.isDirectory()) walk(full);
    }
  };
  walk(root);
  return out;
}
