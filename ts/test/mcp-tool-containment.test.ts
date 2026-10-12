/**
 * Every MCP tool that takes a filesystem path keeps it inside the served root.
 *
 * A tool argument is untrusted input from the MCP host. Each guarded tool must
 * (a) refuse a path that escapes the root -- by `..`, by an absolute path, or
 * by an option-shaped argument -- before touching the filesystem or spawning
 * anything, and (b) act on the path *it checked*: a relative argument resolves
 * against the root, never against the server's cwd. Each tool also gets a
 * positive control so the guard cannot pass by refusing everything.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CanaryTestExecutor } from '../src/core/executor.js';
import {
  HarnessMigrator,
  MigrationContext,
  MigrationReport,
} from '../src/core/migrator.js';
import { Scaffolder } from '../src/core/scaffolder.js';
import {
  analyzeFileImpl,
  initSuiteImpl,
  migrateImpl,
  runTestsImpl,
  writeTestFileImpl,
} from '../src/mcp-server.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
function outsideDir(): string {
  // os.tmpdir() is outside process.cwd() (the default server root under test).
  return tmp('canary-outside-');
}
/** A served root plus a sibling directory a `..` climb can reach. */
function rootAndSibling(): { root: string; sibling: string } {
  return { root: tmp('canary-root-'), sibling: tmp('canary-sibling-') };
}
function harnessCtx(root: string): MigrationContext {
  return new MigrationContext({ project_root: root, is_harness_project: true });
}

describe('MCP tools refuse paths outside the served root', () => {
  it('init_suite does not scaffold into a directory outside the root', () => {
    const outside = outsideDir();
    initSuiteImpl('vitest', outside);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('analyze_file does not return the contents of a file outside the root', () => {
    const outside = outsideDir();
    const secret = join(outside, 'secret.ts');
    writeFileSync(secret, 'export const TOKEN_MARKER = 1;\n', 'utf-8');
    const result = analyzeFileImpl(secret);
    expect(JSON.stringify(result)).not.toContain('TOKEN_MARKER');
    expect(existsSync(secret)).toBe(true);
  });
});

describe('analyze_file containment', () => {
  it('refuses a `..` climb with a clear error and reads nothing', () => {
    const { root, sibling } = rootAndSibling();
    writeFileSync(join(sibling, 'secret.ts'), 'const TOKEN_MARKER = 1;\n');
    const result = analyzeFileImpl(
      join('..', basename(sibling), 'secret.ts'),
      root,
    );
    expect(String(result['error'])).toContain('escapes the project root');
    expect(JSON.stringify(result)).not.toContain('TOKEN_MARKER');
  });

  it('resolves a relative path against the root, not the cwd', () => {
    const root = tmp('canary-root-');
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, 'login.ts'), 'export function inRoot() {}\n');
    const result = analyzeFileImpl('login.ts', root);
    expect(result['file_functions']).toEqual(['inRoot']);
  });

  it('does not scan a project root above the served root', () => {
    // The served root is a subdirectory of a git repo; the walk up to `.git`
    // must stop at the root so tests elsewhere in the repo are never listed.
    const repo = tmp('canary-repo-');
    mkdirSync(join(repo, '.git'));
    writeFileSync(join(repo, 'outside.spec.ts'), "test('x', () => {});\n");
    const root = join(repo, 'pkg');
    mkdirSync(root);
    writeFileSync(join(root, 'inside.spec.ts'), "test('y', () => {});\n");
    const result = analyzeFileImpl('inside.spec.ts', root);
    expect(result).not.toHaveProperty('error');
    expect(JSON.stringify(result['existing_tests'])).not.toContain(
      'outside.spec.ts',
    );
  });

  it('still analyses a legitimate absolute path inside the root', () => {
    const root = tmp('canary-root-');
    mkdirSync(join(root, '.git'));
    const target = join(root, 'ok.ts');
    writeFileSync(target, 'export function okFn() {}\n');
    const result = analyzeFileImpl(target, root);
    expect(result).not.toHaveProperty('error');
    expect(result['file_functions']).toEqual(['okFn']);
  });
});

describe('init_suite containment', () => {
  it('refuses a `..` climb without scaffolding', () => {
    const { root, sibling } = rootAndSibling();
    const spy = vi.spyOn(Scaffolder.prototype, 'scaffold');
    const result = initSuiteImpl('vitest', join('..', basename(sibling)), root);
    expect(String(result['error'])).toContain('escapes the project root');
    expect(spy).not.toHaveBeenCalled();
    expect(readdirSync(sibling)).toEqual([]);
  });

  it('scaffolds a relative target_dir under the root', () => {
    const root = tmp('canary-root-');
    const result = initSuiteImpl('vitest', 'suite', root);
    expect(result).not.toHaveProperty('error');
    expect(existsSync(join(root, 'suite', 'vitest.config.ts'))).toBe(true);
  });

  it('defaults an empty target_dir to the root itself', () => {
    const root = tmp('canary-root-');
    const spy = vi
      .spyOn(Scaffolder.prototype, 'scaffold')
      .mockReturnValue({ created_files: [], created_dirs: [] });
    initSuiteImpl('vitest', '', root);
    expect(spy).toHaveBeenCalledWith('vitest', root);
  });
});

describe('migrate containment', () => {
  it('refuses an absolute target_dir outside the root, dry-run or apply', () => {
    const root = tmp('canary-root-');
    const outside = outsideDir();
    const detect = vi.spyOn(HarnessMigrator.prototype, 'detect');
    const migrate = vi.spyOn(HarnessMigrator.prototype, 'migrate');
    for (const apply of [false, true]) {
      const result = migrateImpl(outside, apply, root);
      expect(String(result['error'])).toContain('escapes the project root');
    }
    expect(detect).not.toHaveBeenCalled();
    expect(migrate).not.toHaveBeenCalled();
  });

  it('refuses a `..` climb on apply without migrating', () => {
    const { root, sibling } = rootAndSibling();
    const migrate = vi.spyOn(HarnessMigrator.prototype, 'migrate');
    const result = migrateImpl(join('..', basename(sibling)), true, root);
    expect(String(result['error'])).toContain('escapes the project root');
    expect(migrate).not.toHaveBeenCalled();
    expect(readdirSync(sibling)).toEqual([]);
  });

  it('migrates a relative target_dir resolved under the root', () => {
    const root = tmp('canary-root-');
    const sub = join(root, 'proj');
    mkdirSync(sub);
    const detect = vi
      .spyOn(HarnessMigrator.prototype, 'detect')
      .mockReturnValue(harnessCtx(sub));
    vi.spyOn(HarnessMigrator.prototype, 'migrate').mockReturnValue(
      new MigrationReport({
        framework: 'playwright',
        shape: 'e2e-ui',
        dry_run: true,
        manual_followups: [],
      }),
    );
    migrateImpl('proj', false, root);
    expect(detect).toHaveBeenCalledWith(sub);
  });
});

describe('run_tests containment', () => {
  it('refuses an option-shaped argument without executing', () => {
    const root = tmp('canary-root-');
    const spy = vi.spyOn(CanaryTestExecutor.prototype, 'execute');
    const result = runTestsImpl('--config=/etc/evil.js', root);
    expect(result['exit_code']).toBe(1);
    expect(String(result['error'])).toContain('option');
    expect(spy).not.toHaveBeenCalled();
  });

  it('executes a relative path resolved under the root, not the cwd', () => {
    const root = tmp('canary-root-');
    writeFileSync(join(root, 'test_ok.py'), 'x', 'utf-8');
    const spy = vi
      .spyOn(CanaryTestExecutor.prototype, 'execute')
      .mockReturnValue([0, '1 passed', '']);
    runTestsImpl('test_ok.py', root);
    expect(spy).toHaveBeenCalledWith(join(root, 'test_ok.py'), 'pytest');
  });
});

describe('write_test_file containment', () => {
  it('refuses an option-shaped path and writes nothing', () => {
    const root = tmp('canary-root-');
    const result = writeTestFileImpl('-rf.spec.ts', 'x', 'playwright', root);
    expect(String(result['error'])).toContain('option');
    expect(readdirSync(root)).toEqual([]);
  });

  it('writes a relative path into the root and reports where', () => {
    const root = tmp('canary-root-');
    const result = writeTestFileImpl('t/a.spec.ts', 'ok', 'playwright', root);
    expect(result['written_path']).toBe(join(root, 't', 'a.spec.ts'));
    expect(existsSync(join(root, 't', 'a.spec.ts'))).toBe(true);
  });
});
