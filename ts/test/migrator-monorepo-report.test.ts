/**
 * Monorepo-awareness of the migrate report (#504).
 *
 * The fixture is the repo shape the issue was filed from: pnpm workspaces plus
 * turbo, a root `scripts.test` of `turbo test` that matches no probe, a real
 * Playwright suite in `apps/web-e2e/`, a Vitest package beside it, and a
 * package with no test config at all.
 *
 * Every assertion here is about what the report *says* about that tree, because
 * the bug was never that detection crashed -- it was that a run which had
 * walked two real suites reported having found nothing.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { HarnessMigrator, MigrationReport } from '../src/core/migrator.js';

// Isolated home so `~/.canary/skills` never contributes overlay skills.
const HOME = mkdtempSync(join(tmpdir(), 'canary-mono-home-'));
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

function withTmp<T>(fn: (tmp: string) => T): T {
  const tmp = mkdtempSync(join(tmpdir(), 'canary-mono-'));
  try {
    return fn(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf-8');
}

function writeJson(path: string, value: unknown): void {
  write(path, JSON.stringify(value));
}

/** Options for the monorepo fixture, so a case can drop one of its packages. */
interface MonorepoOptions {
  /** Add the Vitest package that makes the workspace disagree. Default true. */
  vitestPackage?: boolean;
  /** Give the Playwright specs a `page` fixture (UI, not API). Default true. */
  uiFixtures?: boolean;
}

/**
 * A pnpm-workspaces + turbo monorepo with a Playwright suite in a subpackage.
 *
 * Note what the root deliberately does NOT have: no playwright/vitest config,
 * no test dependency, and a `scripts.test` of `turbo test` -- the three things
 * every probe tier reads. That is the whole reason the reported repo detected
 * as `unknown`.
 */
function monorepo(root: string, opts: MonorepoOptions = {}): void {
  const vitestPackage = opts.vitestPackage ?? true;
  const uiFixtures = opts.uiFixtures ?? true;

  writeJson(join(root, 'harness.config.json'), {
    version: 1,
    name: 'mono',
    template: { version: 1, level: 'intermediate' },
    layers: [],
  });
  mkdirSync(join(root, '.harness'), { recursive: true });
  write(join(root, '.harness', '.gitignore'), '*\n');

  write(
    join(root, 'pnpm-workspace.yaml'),
    "packages:\n  - 'apps/*'\n  - 'packages/*'\n",
  );
  write(join(root, 'turbo.json'), '{"tasks": {"test": {}}}\n');
  writeJson(join(root, 'package.json'), {
    name: 'mono',
    private: true,
    scripts: { test: 'turbo test' },
  });

  // The suite that already exists and must never be duplicated at the root.
  const e2e = join(root, 'apps', 'web-e2e');
  mkdirSync(join(e2e, 'tests'), { recursive: true });
  writeJson(join(e2e, 'package.json'), {
    name: 'web-e2e',
    scripts: { test: 'playwright test' },
  });
  write(join(e2e, 'playwright.config.ts'), 'export default {};\n');
  write(
    join(e2e, 'tests', 'home.spec.ts'),
    uiFixtures
      ? "test('home', async ({ page }) => { await page.goto('/'); });\n"
      : "test('health', async ({ request }) => { await request.get('/'); });\n",
  );

  if (vitestPackage) {
    const web = join(root, 'apps', 'web');
    mkdirSync(web, { recursive: true });
    writeJson(join(web, 'package.json'), {
      name: 'web',
      scripts: { test: 'vitest run' },
    });
    write(join(web, 'vitest.config.ts'), 'export default {};\n');
  }

  // A package carrying no test config: it must count toward the denominator
  // without contributing a finding.
  const core = join(root, 'packages', 'core');
  mkdirSync(core, { recursive: true });
  writeJson(join(core, 'package.json'), { name: 'core' });
}

function report(root: string, framework?: string): MigrationReport {
  return new HarnessMigrator(HOME).migrate(root, {
    dryRun: true,
    ...(framework === undefined ? {} : { framework }),
  });
}

describe('monorepo detection reports what it walked (#504 part 1)', () => {
  it('walks the workspace globs instead of probing only the root', () =>
    withTmp((root) => {
      monorepo(root);
      const ws = new HarnessMigrator(HOME).detect(root).workspace;

      expect(ws).not.toBeNull();
      expect(ws!.manager).toBe('pnpm');
      expect(ws!.globs).toEqual(['apps/*', 'packages/*']);
      // Three packages matched; two of them carry a config.
      expect(ws!.scanned).toBe(3);
      expect(ws!.findings.map((f) => [f.dir, f.framework, f.shape])).toEqual([
        ['apps/web', 'vitest', 'frontend_unit'],
        ['apps/web-e2e', 'playwright', 'e2e_ui'],
      ]);
    }));

  it('names every package suite it found, with the scanned denominator', () =>
    withTmp((root) => {
      monorepo(root);
      const md = report(root).to_markdown();

      expect(md).toContain('## Workspace');
      expect(md).toContain(
        'pnpm workspace — 3 packages scanned, 2 carrying a test config.',
      );
      expect(md).toContain(
        '`apps/web-e2e/` — playwright / e2e_ui (`playwright.config.ts`)',
      );
      expect(md).toContain(
        '`apps/web/` — vitest / frontend_unit (`vitest.config.ts`)',
      );
    }));

  it('explains an unresolved framework by the disagreement, not by silence', () =>
    withTmp((root) => {
      monorepo(root);
      const md = report(root).to_markdown();

      // The old text claimed nothing matched, of a run that matched twice.
      expect(md).not.toContain(
        'no config file, dependency, or language marker matched',
      );
      expect(md).toContain(
        "this workspace's packages declare 2 different framework/shape " +
          'combinations across 2 packages ' +
          '(vitest/frontend_unit, playwright/e2e_ui)',
      );
      // The route that needs no override at all is offered by name.
      expect(md).toContain(
        'Or re-run `canary migrate` from inside a package — ' +
          '`apps/web/` (vitest), `apps/web-e2e/` (playwright).',
      );
    }));

  it('does not claim a monorepo with no canary config is already migrated', () =>
    withTmp((root) => {
      monorepo(root);
      const md = report(root).to_markdown();

      expect(md).not.toContain('project already has all Canary config files');
      expect(md).toContain(
        "_Nothing — this workspace's packages declare more than one " +
          'framework: `apps/web/` (vitest), `apps/web-e2e/` (playwright). ' +
          'Re-run `canary migrate` from inside a package, or pass ' +
          '`--framework <name>` to pick one._',
      );
    }));

  it('resolves a scalar framework when the packages agree', () =>
    withTmp((root) => {
      // One test framework across the workspace: no ambiguity to report.
      monorepo(root, { vitestPackage: false });
      const r = report(root);

      expect(r.framework).toBe('playwright');
      expect(r.shape).toBe('e2e_ui');
      expect(r.detection_source).toBe('workspace (1 package)');
      expect(r.manual_followups).toEqual([]);
      expect(r.to_markdown()).toContain(
        'pnpm workspace — 2 packages scanned, 1 carrying a test config.',
      );
    }));
});

describe('--framework override on a monorepo (#504 parts 2 and 3)', () => {
  it('resolves the shape and labels the evidence as the flag, not a config', () =>
    withTmp((root) => {
      monorepo(root);
      const r = report(root, 'playwright');

      expect(r.framework).toBe('playwright');
      // The bug: framework set, shape left `unknown`, so every shape-keyed
      // behavior downstream silently no-ops.
      expect(r.shape).toBe('e2e_ui');
      expect(r.shapes).toContain('e2e_ui');
      expect(r.detection_source).toBe('CLI override');
      const md = r.to_markdown();
      expect(md).toContain('**Shape:** e2e_ui');
      expect(md).toContain(
        '**Confidence:** high — explicit `--framework` flag',
      );
      expect(md).not.toContain('dedicated config file');
    }));

  it('refines the override shape to api from the package that holds the specs', () =>
    withTmp((root) => {
      // Same override, different suite contents. The specs live in
      // `apps/web-e2e/tests/`, so a root-only refinement reads zero files and
      // would answer the table default `e2e_ui` -- the refinement has to run
      // where the suite actually is.
      monorepo(root, { vitestPackage: false, uiFixtures: false });
      const r = report(root, 'playwright');

      expect(r.shape).toBe('api');
      expect(r.shapes).toContain('api');
    }));

  it('proposes no root suite beside the one in apps/web-e2e', () =>
    withTmp((root) => {
      monorepo(root);
      const r = report(root, 'playwright');

      expect(r.would_create).toEqual([]);
      expect(r.existing_suites.map((s) => [s.dir, s.config])).toEqual([
        ['apps/web-e2e', 'playwright.config.ts'],
      ]);
      const md = r.to_markdown();
      expect(md).toContain('## Existing Suites Found');
      expect(md).toContain(
        '`apps/web-e2e/` — `playwright.config.ts` (1 test file)',
      );
      expect(md).not.toContain('- `playwright.config.ts`\n');
      expect(md).not.toContain('- `tests/e2e`');
    }));

  it('withholds the duplicate scaffold on --apply too, not just the dry run', () =>
    withTmp((root) => {
      monorepo(root);
      const applied = new HarnessMigrator(HOME).migrate(root, {
        dryRun: false,
        framework: 'playwright',
      });

      expect(applied.created_files).toEqual([]);
      expect(applied.created_dirs).toEqual([]);
      expect(applied.existing_suites.map((s) => s.dir)).toEqual([
        'apps/web-e2e',
      ]);
    }));
});

describe('dry-run status copy (#504 part 4)', () => {
  it('says a dry run would migrate, never that it completed', () =>
    withTmp((root) => {
      // A monorepo whose only suite is Vitest, overridden to playwright: no
      // playwright suite exists anywhere, so the scaffold is genuinely
      // proposed and the Status block has a non-zero count to report. (It also
      // pins that the duplicate guard is per-framework, not per-repo.)
      monorepo(root, { vitestPackage: true });
      rmSync(join(root, 'apps', 'web-e2e'), { recursive: true, force: true });
      const r = report(root, 'playwright');

      expect(r.would_create.length).toBeGreaterThan(0);
      const md = r.to_markdown();
      expect(md).toContain('## Status');
      expect(md).not.toContain('Migration complete');
      expect(md).toMatch(/Dry run — would migrate \d+ item\(s\)/);
    }));

  it('abstains loudly rather than passing when it would migrate zero', () =>
    withTmp((root) => {
      monorepo(root);
      const r = report(root, 'playwright');

      expect(r.would_migrate_count).toBe(0);
      const md = r.to_markdown();
      expect(md).not.toContain('Migration complete');
      expect(md).toContain('would migrate zero item(s)');
      expect(md).toContain('already exists in `apps/web-e2e/`');
    }));
});
