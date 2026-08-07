/**
 * Tests for workspace ("monorepo") topology detection and per-package framework
 * findings (#504 part 1).
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

describe('detectWorkspace -- what it must not claim', () => {
  // Spec test 8. The language tier maps `typescript` to playwright/e2e_ui. If it
  // ran per package, every package in a TypeScript monorepo would "detect"
  // playwright it never carried -- findings invented by inheritance.
  it('never attributes a framework via the root language fallback', () =>
    withTmp((tmp) => {
      write(join(tmp, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n');
      mkPkg(tmp, 'apps/web');

      const ws = detectWorkspace(tmp, { language: 'typescript' });

      expect(ws!.scanned).toBe(1);
      expect(ws!.findings).toEqual([]);
    }));

  // Spec test 11.
  it('locates a nested package through a ** glob', () =>
    withTmp((tmp) => {
      write(join(tmp, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/**"\n');
      write(join(mkPkg(tmp, 'apps/group/web'), 'playwright.config.ts'), '');

      const ws = detectWorkspace(tmp, {});

      expect(ws!.findings.map((f) => f.dir)).toContain('apps/group/web');
    }));

  // Spec test 12. A dependency ships its own playwright.config.ts; mistaking it
  // for this repo's suite would suppress a scaffold the user needs.
  it('never yields a finding from inside node_modules', () =>
    withTmp((tmp) => {
      write(join(tmp, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/**"\n');
      mkPkg(tmp, 'apps/web');
      write(
        join(mkPkg(tmp, 'apps/web/node_modules/dep'), 'playwright.config.ts'),
        '',
      );

      const ws = detectWorkspace(tmp, {});

      expect(ws!.findings).toEqual([]);
      // `apps/**` matches `apps` itself (`**` matches zero directories) plus
      // `apps/web` -- but never `apps/web/node_modules/dep`.
      expect(ws!.scanned).toBe(2);
    }));
});

describe('detectWorkspace -- the denominator', () => {
  // Spec test 17. `scanned: 0` against a declared glob is what makes "found
  // nothing" distinguishable from "never looked".
  it('reports zero scanned when the globs match no directory', () =>
    withTmp((tmp) => {
      write(join(tmp, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n');

      const ws = detectWorkspace(tmp, {});

      expect(ws).not.toBeNull();
      expect(ws!.globs).toHaveLength(1);
      expect(ws!.scanned).toBe(0);
      expect(ws!.findings).toEqual([]);
    }));

  // Spec test 19. Root ignores the mode bit, so an unguarded version of this
  // test would pass for the wrong reason in a container running as root.
  const canChmod = process.platform !== 'win32' && process.getuid?.() !== 0;
  it.runIf(canChmod)('lists a package directory it cannot read', () =>
    withTmp((tmp) => {
      write(join(tmp, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n');
      const locked = mkPkg(tmp, 'apps/locked');
      write(join(mkPkg(tmp, 'apps/web'), 'playwright.config.ts'), '');
      chmodSync(locked, 0o000);
      try {
        const ws = detectWorkspace(tmp, {});

        expect(ws).not.toBeNull();
        expect(ws!.unreadable).toEqual(['apps/locked']);
        expect(ws!.scanned).toBe(2);
        expect(ws!.findings.map((f) => f.dir)).toEqual(['apps/web']);
      } finally {
        chmodSync(locked, 0o755);
      }
    }),
  );
});
