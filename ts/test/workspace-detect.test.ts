/**
 * Tests for workspace ("monorepo") topology detection and per-package framework
 * findings (#504 part 1).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { detectWorkspace } from '../src/core/workspace-detect.js';

function withTmp<T>(fn: (tmp: string) => T): T {
  const tmp = mkdtempSync(join(tmpdir(), 'canary-ws-'));
  try {
    return fn(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function write(path: string, content: string): void {
  writeFileSync(path, content, 'utf-8');
}

/** Create *rel* under *root* (recursively) and return its absolute path. */
function mkPkg(root: string, rel: string): string {
  const dir = join(root, ...rel.split('/'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('detectWorkspace -- topology', () => {
  it('reads pnpm-workspace.yaml and probes the declared packages', () =>
    withTmp((tmp) => {
      write(join(tmp, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n');
      write(join(mkPkg(tmp, 'apps/web'), 'playwright.config.ts'), '');

      const ws = detectWorkspace(tmp, {});

      expect(ws).not.toBeNull();
      expect(ws!.manager).toBe('pnpm');
      expect(ws!.globs).toEqual(['apps/*']);
      expect(ws!.scanned).toBe(1);
      expect(ws!.findings).toEqual([
        {
          dir: 'apps/web',
          framework: 'playwright',
          shape: 'e2e_ui',
          source: 'playwright.config.ts',
          confidence: 'config',
        },
      ]);
    }));

  it('reads the npm array form of package.json workspaces', () =>
    withTmp((tmp) => {
      write(
        join(tmp, 'package.json'),
        JSON.stringify({ workspaces: ['apps/*'] }),
      );
      write(join(mkPkg(tmp, 'apps/web'), 'playwright.config.ts'), '');

      const ws = detectWorkspace(tmp, {});

      expect(ws).not.toBeNull();
      expect(ws!.manager).toBe('npm');
      expect(ws!.globs).toEqual(['apps/*']);
      expect(ws!.findings.map((f) => f.dir)).toEqual(['apps/web']);
    }));

  it('reads the yarn object form of package.json workspaces', () =>
    withTmp((tmp) => {
      write(
        join(tmp, 'package.json'),
        JSON.stringify({ workspaces: { packages: ['apps/*'] } }),
      );
      write(join(mkPkg(tmp, 'apps/web'), 'vitest.config.ts'), '');

      const ws = detectWorkspace(tmp, {});

      expect(ws).not.toBeNull();
      expect(ws!.findings.map((f) => [f.dir, f.framework])).toEqual([
        ['apps/web', 'vitest'],
      ]);
    }));
});

describe('detectWorkspace -- plural findings', () => {
  it('reports a finding per package across the workspace', () =>
    withTmp((tmp) => {
      write(join(tmp, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n');
      write(join(mkPkg(tmp, 'apps/e2e'), 'playwright.config.ts'), '');
      write(join(mkPkg(tmp, 'apps/lib'), 'vitest.config.ts'), '');

      const ws = detectWorkspace(tmp, {});

      expect(ws!.scanned).toBe(2);
      expect(ws!.findings).toHaveLength(2);
      expect([...new Set(ws!.findings.map((f) => f.shape))].sort()).toEqual([
        'e2e_ui',
        'frontend_unit',
      ]);
    }));

  // `dir` is NOT unique across findings: a single package carrying two configs
  // yields two findings, so findings.length can exceed `scanned`.
  it('reports both frameworks when one package declares two', () =>
    withTmp((tmp) => {
      write(join(tmp, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n');
      const pkg = mkPkg(tmp, 'apps/web');
      write(join(pkg, 'playwright.config.ts'), '');
      write(join(pkg, 'vitest.config.ts'), '');

      const ws = detectWorkspace(tmp, {});

      expect(ws!.scanned).toBe(1);
      expect(ws!.findings).toHaveLength(2);
      expect(ws!.findings.every((f) => f.dir === 'apps/web')).toBe(true);
      expect(ws!.findings.map((f) => f.framework).sort()).toEqual([
        'playwright',
        'vitest',
      ]);
    }));
});
