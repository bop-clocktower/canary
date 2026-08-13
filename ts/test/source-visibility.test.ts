/**
 * Contract tests for `scripts/source-visibility.mjs` (#688).
 *
 * The arch analyzer walks the tree with a hard-coded skip list
 * (`DEFAULT_SKIP_DIRS` in `@harness-engineering/graph` — 55 names, including
 * `coverage`, `dist`, `build`, `bin`, `out`, `target`, `vendor`). A directory
 * whose name collides is never walked, so every line inside it is invisible to
 * `module-size`, `complexity` and every other architecture metric.
 *
 * That is worse than it sounds, because it fails **OPEN**. Splitting
 * `ts/src/guardian/coverage.ts` into `ts/src/guardian/coverage/` dropped the
 * reported `module-size` by 1822 lines — the exact size of the code that had
 * just moved there — while `harness check-arch` stayed green-ish and the
 * ratchet gained headroom. A metric that silently *improves* is exactly as
 * strong a signal that something is wrong as one that regresses, and nothing
 * in the repo said a word. Renaming the directory to `diff-coverage/` put the
 * number back.
 *
 * Two independent mechanisms hid the same code, so this guard checks both:
 *
 *   1. **Name collision.** A source directory named after a skip-list entry is
 *      never walked. Caught for tracked files by path segment, and for files
 *      git has not seen by walking the working tree.
 *   2. **`.gitignore`.** `ts/.gitignore` carries `coverage/`, so those files
 *      were unstageable — they would never have been committed at all, and
 *      prettier had been skipping them too. A source file git refuses to
 *      track is invisible to every gate downstream of the index.
 *
 * The denominator is the whole point. A guard that enumerates zero source
 * files and reports "no collisions" is the same false green in a smaller
 * package, so the script **abstains with exit 3** rather than passing when it
 * finds nothing to check — and the cases below pin that, not just the happy
 * path.
 *
 * Offline: reads the working tree and asks git for its index.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCapture } from './subprocess-testkit.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'source-visibility.mjs');

interface Finding {
  path: string;
  hiddenBy: string;
}

interface Report {
  verdict: string;
  filesChecked: number;
  dirsChecked: number;
  skipDirCount: number;
  hiddenFiles: Finding[];
  hiddenDirs: Finding[];
  ignoredSourceFiles: string[];
  hiddenLoc: number;
}

function run(root: string) {
  return runCapture('node', [SCRIPT, '--json', '--root', root]);
}

/**
 * The report is the first stdout line; a `::error` annotation may follow it.
 * Annotations have to go to stdout for Actions to pick them up, so the JSON
 * cannot own the whole stream.
 */
function parse(output: string): Report {
  return JSON.parse(output.split('\n')[0] ?? '') as Report;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'source-visibility-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A fixture repo with a git index — `git ls-files` reads the index, not HEAD. */
function fixture(files: Record<string, string>): string {
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body, 'utf-8');
  }
  execFileSync('git', ['init', '--quiet'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  return dir;
}

const SOURCE = 'export const a = 1;\n\nexport const b = 2;\n';

/**
 * Skip-list names a `ts/src/**` directory could plausibly be given by mistake.
 * Hoisted out of the assertion because the arch analyzer counts each element of
 * an inline literal in a `for … of` head as a parameter, and six of them trips
 * its `parameterCount` threshold of 5.
 */
const PLAUSIBLE_SOURCE_DIR_NAMES = [
  'coverage',
  'dist',
  'build',
  'bin',
  'out',
  'target',
];

describe('source-visibility — a clean tree', () => {
  it('passes when every source directory is walkable', () => {
    const r = run(fixture({ 'src/core/thing.ts': SOURCE }));
    expect(r.status).toBe(0);
    const report = parse(r.stdout);
    expect(report.verdict).toBe('visible');
    expect(report.hiddenDirs).toEqual([]);
    expect(report.hiddenFiles).toEqual([]);
  });

  it('reports the denominator it actually checked', () => {
    const r = run(
      fixture({ 'src/core/a.ts': SOURCE, 'src/guardian/b.ts': SOURCE }),
    );
    const report = parse(r.stdout);
    expect(report.filesChecked).toBe(2);
    expect(report.dirsChecked).toBeGreaterThan(0);
    expect(report.skipDirCount).toBeGreaterThan(0);
  });

  it('does not mistake build output for hidden source', () => {
    // `dist/` collides with the skip list by design — it is build output, and
    // the analyzer is right to skip it. Only hand-written `.ts` counts, so a
    // tree of `.d.ts` and `.js` must not raise a finding.
    const r = run(
      fixture({
        'src/core/a.ts': SOURCE,
        'dist/a.d.ts': 'export declare const a: number;\n',
        'dist/a.js': 'export const a = 1;\n',
      }),
    );
    expect(r.status).toBe(0);
    expect(parse(r.stdout).hiddenDirs).toEqual([]);
  });
});

describe('source-visibility — the #688 mechanism', () => {
  it('catches a source directory named after a skip-list entry', () => {
    const r = run(fixture({ 'src/guardian/coverage/paths.ts': SOURCE }));
    expect(r.status).toBe(1);
    const report = parse(r.stdout);
    expect(report.verdict).toBe('hidden');
    expect(
      report.hiddenDirs.some((d) => d.path.endsWith('src/guardian/coverage')),
    ).toBe(true);
    expect(report.hiddenDirs[0]?.hiddenBy).toBe('coverage');
  });

  it('reports how many lines the gate cannot see', () => {
    // The number is the finding. "1822 lines are invisible" is actionable in
    // a way that "a directory name collides" is not, and it is the same
    // quantity that showed up as a module-size *improvement* on #668.
    const r = run(fixture({ 'src/guardian/coverage/paths.ts': SOURCE }));
    const report = parse(r.stdout);
    expect(report.hiddenLoc).toBe(2);
  });

  it('catches the collision even when git refuses to track the files', () => {
    // The nastier half: `ts/.gitignore` carries `coverage/`, so the split files
    // were never staged. A guard reading only `git ls-files` would enumerate
    // zero of them and report a clean tree.
    const r = run(
      fixture({
        '.gitignore': 'coverage/\n',
        'src/core/a.ts': SOURCE,
        'src/guardian/coverage/paths.ts': SOURCE,
      }),
    );
    expect(r.status).toBe(1);
    const report = parse(r.stdout);
    expect(
      report.hiddenDirs.some((d) => d.path.endsWith('src/guardian/coverage')),
    ).toBe(true);
    expect(report.ignoredSourceFiles).toContain(
      'src/guardian/coverage/paths.ts',
    );
  });

  it('catches a gitignored source file whose directory name is innocent', () => {
    // `.gitignore` is the second mechanism in its own right: a source file git
    // will not track is invisible to prettier, to the index, and to every gate
    // that reads from it — no name collision required.
    const r = run(
      fixture({
        '.gitignore': 'scratch/\n',
        'src/core/a.ts': SOURCE,
        'src/scratch/hidden.ts': SOURCE,
      }),
    );
    expect(r.status).toBe(1);
    expect(parse(r.stdout).ignoredSourceFiles).toContain(
      'src/scratch/hidden.ts',
    );
  });

  it('catches a dot-directory holding tracked source', () => {
    // The analyzer skips any segment starting with `.` as well as the named
    // list, and `git add -f` will stage one.
    const root = fixture({ 'src/core/a.ts': SOURCE });
    mkdirSync(join(root, '.hidden'), { recursive: true });
    writeFileSync(join(root, '.hidden', 'x.ts'), SOURCE, 'utf-8');
    execFileSync('git', ['add', '-f', '.hidden/x.ts'], { cwd: root });
    const r = run(root);
    expect(r.status).toBe(1);
    expect(parse(r.stdout).hiddenFiles.map((f) => f.path)).toContain(
      '.hidden/x.ts',
    );
  });
});

describe('source-visibility — zero denominator is an abstention', () => {
  it('abstains rather than passing when there is no source to check', () => {
    // The rule this whole batch is about. An empty enumeration reported as
    // "no collisions found" would be a gate that abstained wearing a pass.
    const r = run(fixture({ 'README.md': '# nothing\n' }));
    expect(r.status).toBe(3);
    expect(r.output).toMatch(/ABSTAIN/i);
    expect(r.output).toMatch(/zero|no source/i);
  });

  it('abstains when the root is not a git working tree', () => {
    // No index means no tracked-file arm and no `check-ignore`, so half the
    // check is dark. Reporting the half that ran as a pass is the same lie.
    const bare = mkdtempSync(join(tmpdir(), 'source-visibility-bare-'));
    try {
      mkdirSync(join(bare, 'src'), { recursive: true });
      writeFileSync(join(bare, 'src', 'a.ts'), SOURCE, 'utf-8');
      const r = run(bare);
      expect(r.status).toBe(3);
      expect(r.output).toMatch(/ABSTAIN/i);
      expect(r.output).toMatch(/git/i);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('abstains when the skip list it checks against is empty', () => {
    // A skip list that shrank to nothing would make every collision check
    // vacuously true. `--skip-dirs=` forces that state so the abstention is
    // proven rather than assumed.
    const r = runCapture('node', [
      SCRIPT,
      '--json',
      '--root',
      fixture({ 'src/core/a.ts': SOURCE }),
      '--skip-dirs',
      '',
    ]);
    expect(r.status).toBe(3);
    expect(r.output).toMatch(/ABSTAIN/i);
  });
});

describe('source-visibility — the skip list it vendors', () => {
  it('carries the names that actually collide with source directories', () => {
    const r = runCapture('node', [SCRIPT, '--print-skip-dirs']);
    expect(r.status).toBe(0);
    const names = JSON.parse(r.stdout) as string[];
    // Not the whole 55 — these are the ones a `ts/src/**` directory could
    // plausibly be named, which is the population the guard exists for.
    for (const name of PLAUSIBLE_SOURCE_DIR_NAMES) {
      expect(names).toContain(name);
    }
    expect(names.length).toBeGreaterThanOrEqual(50);
  });
});

describe('source-visibility — this repository', () => {
  // The guard is only worth anything if it runs against the real tree. This is
  // the case that would have gone red the moment `ts/src/guardian/coverage/`
  // was created.
  const r = run(REPO_ROOT);
  const report = parse(r.stdout);

  it('enumerates a non-empty set of source files', () => {
    expect(report.filesChecked).toBeGreaterThan(50);
  });

  it('hides no source directory from the arch analyzer', () => {
    expect(report.hiddenDirs).toEqual([]);
    expect(report.hiddenFiles).toEqual([]);
  });

  it('leaves no source file unstageable', () => {
    expect(report.ignoredSourceFiles).toEqual([]);
  });

  it('reports zero lines invisible to the gate', () => {
    expect(report.hiddenLoc).toBe(0);
    expect(r.status).toBe(0);
  });
});
