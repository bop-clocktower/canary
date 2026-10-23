/**
 * Edge behavior of the MCP server's detection helpers, the Python string
 * blanker behind `file_functions`, and the containment gate's refusal paths
 * that need no fault injection (test-fleet, ts/src/mcp-server.ts).
 *
 * These characterize current behavior as-is. The containment fallbacks are
 * contract (fleet decision F2 (a)): only the refusal OUTCOME a caller sees is
 * asserted, never the resolver's intermediate paths. The fallbacks that cannot
 * be reached on a real POSIX filesystem live in
 * `mcp-containment-fs-faults.test.ts`, which injects the faults.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CanaryTestExecutor } from '../src/core/executor.js';
import {
  analyzeFileImpl,
  detectFrameworkFromConfig,
  extractFileFunctions,
  findExistingTests,
  projectRootFor,
  resolveServedRoot,
  runTestsImpl,
  writeTestFileImpl,
} from '../src/mcp-server.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'canary-mcp-edges-'));
  dirs.push(d);
  return d;
}

/** Write `files` (relative path -> content) under `root`, creating parents. */
function layout(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, 'utf-8');
  }
}

const SIGNALS = [
  '.git',
  'pytest.ini',
  'pyproject.toml',
  ...['playwright', 'vitest'].flatMap((fw) =>
    ['ts', 'js', 'mts', 'mjs'].map((ext) => `${fw}.config.${ext}`),
  ),
];
const DIRTY_ANCESTRY =
  'host tmpdir has a .git or framework config above it; the walk cannot reach /';

/**
 * True when no ancestor of `dir` carries a `.git` or a framework config file.
 * The walk-to-filesystem-root cases depend on the host's tmpdir ancestry; on a
 * host where that precondition is false the case is skipped, never faked.
 */
function ancestryIsClean(dir: string): boolean {
  let cur = dirname(resolve(dir));
  for (;;) {
    if (SIGNALS.some((s) => existsSync(join(cur, s)))) return false;
    const parent = dirname(cur);
    if (parent === cur) return true;
    cur = parent;
  }
}

describe('resolveServedRoot for a root that does not exist yet', () => {
  it('falls back to the lexical absolute path', () => {
    const cwd = tmp();
    const root = resolveServedRoot(
      { CANARY_PROJECT_ROOT: 'not-yet/made' },
      cwd,
    );
    expect(root).toBe(resolve(cwd, 'not-yet/made'));
  });
});

describe('detectFrameworkFromConfig', () => {
  it('claims pytest from a pyproject.toml that configures it', () => {
    const root = tmp();
    layout(root, { 'pyproject.toml': '[tool.pytest.ini_options]\n' });
    expect(detectFrameworkFromConfig(root)).toEqual(['pytest', 'config']);
  });

  it('does not claim pytest from a pyproject.toml that never mentions it', () => {
    const root = tmp();
    layout(root, {
      '.git/HEAD': '',
      'pyproject.toml': '[project]\nname="x"\n',
    });
    expect(detectFrameworkFromConfig(root)).toEqual(['unknown', 'unknown']);
  });

  it('keeps walking up past a non-pytest pyproject.toml to a parent config', () => {
    const top = tmp();
    layout(top, {
      '.git/HEAD': '',
      'pytest.ini': '[pytest]\n',
      'pkg/pyproject.toml': '[project]\nname="x"\n',
    });
    expect(detectFrameworkFromConfig(join(top, 'pkg'))).toEqual([
      'pytest',
      'config',
    ]);
  });

  it('treats an unreadable pyproject.toml as no signal', () => {
    // A directory named pyproject.toml exists but cannot be read as text --
    // an uid-independent way to make the read throw (chmod 000 is not, since
    // root reads it anyway).
    const root = tmp();
    mkdirSync(join(root, 'pyproject.toml'));
    mkdirSync(join(root, '.git'));
    expect(detectFrameworkFromConfig(root)).toEqual(['unknown', 'unknown']);
  });

  it('stops at the .git boundary instead of reading a config above it', () => {
    const top = tmp();
    layout(top, { 'vitest.config.ts': '', 'repo/.git/HEAD': '' });
    expect(detectFrameworkFromConfig(join(top, 'repo'))).toEqual([
      'unknown',
      'unknown',
    ]);
  });

  it('returns unknown after walking to the filesystem root', (ctx) => {
    const root = tmp();
    ctx.skip(!ancestryIsClean(root), DIRTY_ANCESTRY);
    expect(detectFrameworkFromConfig(root)).toEqual(['unknown', 'unknown']);
  });
});

describe('projectRootFor', () => {
  it("falls back to the file's own directory when no .git is above it", (ctx) => {
    const root = tmp();
    ctx.skip(!ancestryIsClean(root), DIRTY_ANCESTRY);
    const file = join(root, 'a', 'b', 'mod.ts');
    expect(projectRootFor(file)).toBe(join(root, 'a', 'b'));
  });

  it('returns the nearest ancestor holding .git', () => {
    const root = tmp();
    layout(root, { '.git/HEAD': '' });
    expect(projectRootFor(join(root, 'a', 'b', 'mod.ts'))).toBe(root);
  });
});

/** Extract `file_functions` from a `.py` file holding `src`. */
function pyFunctions(src: string): string[] {
  const p = join(tmp(), 'mod.py');
  writeFileSync(p, src, 'utf-8');
  return extractFileFunctions(p);
}

describe('Python string blanking hides defs inside literals', () => {
  it.each([
    [
      // Read as a closer, the escaped quote would expose `(` as code and the
      // module would look unbalanced (no names at all).
      'an escaped quote does not end the string early',
      'x = "a\\"("\ndef real():\n    pass\n',
      ['real'],
    ],
    [
      'an unterminated single-line string ends at its newline',
      'x = "oops\ndef after():\n    pass\n',
      ['after'],
    ],
    [
      'a closed triple-quoted docstring hides the def inside it',
      '"""\ndef doc_fake():\n"""\ndef real():\n    pass\n',
      ['real'],
    ],
    [
      'an unterminated triple-quoted string runs to end of input',
      'def real():\n    pass\n"""\ndef hidden():\n',
      ['real'],
    ],
    [
      'a lone backslash at end of input is blanked',
      'def real():\n    pass\nx = "tail\\',
      ['real'],
    ],
  ])('%s', (_name, src, expected) => {
    expect(pyFunctions(src)).toEqual(expected);
  });
});

describe('Python bracket balance', () => {
  it.each([
    ['a mismatched closer', 'def f():\n    x = (]\n'],
    ['a closer with nothing open', 'def f():\n    x = )\n'],
  ])('%s makes the module unparseable, so no names', (_name, src) => {
    expect(pyFunctions(src)).toEqual([]);
  });
});

describe('analyzeFileImpl on a path that exists but is not a readable file', () => {
  it('returns no context snippets for a directory', () => {
    const root = tmp();
    mkdirSync(join(root, 'pkg'));
    const result = analyzeFileImpl('pkg', root);
    expect(result['context_snippets']).toEqual([]);
  });
});

describe('containment refuses when the served root itself does not exist', () => {
  it('write_test_file refuses and creates nothing', () => {
    const missingRoot = join(tmp(), 'gone');
    const result = writeTestFileImpl('t.test.ts', 'x', 'vitest', missingRoot);
    expect(result).toEqual({
      error: 'path escapes the project root: t.test.ts',
    });
    expect(existsSync(missingRoot)).toBe(false);
  });

  it('run_tests refuses before spawning a runner', () => {
    const execute = vi.spyOn(CanaryTestExecutor.prototype, 'execute');
    const result = runTestsImpl('t.test.ts', join(tmp(), 'gone'));
    expect(result['error']).toBe('path escapes the project root: t.test.ts');
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('runTestsImpl passed count without a runner summary', () => {
  it('reports zero passed on a failing exit', () => {
    vi.spyOn(CanaryTestExecutor.prototype, 'execute').mockReturnValue([
      1,
      'collection error',
      '',
    ]);
    const root = tmp();
    expect(runTestsImpl(join(root, 'test_a.py'), root)['passed']).toBe(0);
  });
});

describe('findExistingTests path form (#1371)', () => {
  it('keeps a root file whose name starts with ".." project-relative', () => {
    const root = tmp();
    layout(root, {
      '..foo.test.ts': 'it("a", () => {});',
      'tests/bar.test.ts': 'it("b", () => {});',
    });
    // `..foo.test.ts` is a descendant of root, not a parent-directory escape,
    // so it must come back relative like its nested sibling.
    expect(findExistingTests(root, 'vitest')).toEqual([
      '..foo.test.ts',
      join('tests', 'bar.test.ts'),
    ]);
  });
});
