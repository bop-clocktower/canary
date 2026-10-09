/**
 * Repo scripts must run when reached through a symlink (#1189, same class as
 * #1182).
 *
 * A script decides whether to run main() by comparing its own location with
 * the invoked path, `process.argv[1]`. A comparison of unresolved paths
 * (`fileURLToPath(import.meta.url)`, or the URL-encoding-safe
 * `pathToFileURL(argv[1]).href`) is false whenever the invoked path is a
 * symlink, because `import.meta.url` is always the resolved real path. The
 * script then printed nothing and exited 0, which a caller reads as a pass --
 * `sync-gate-result --check` is npm's drift gate and `rehearse.mjs` is the gate
 * that proves the other gates fire.
 *
 * Scanned scope: every .mjs/.js/.cjs file under `scripts/`, `npm/scripts/` and
 * `hooks/`, recursively (lib/ and __tests__/ included, node_modules excluded).
 *
 *   - No scanned file may compare unresolved paths (UNRESOLVED below).
 *   - Any scanned file that mentions both `import.meta.url|filename` and
 *     `process.argv` (in any form) is treated as a possible entry guard: it
 *     needs a symlink case in CASES, or an entry in NOT_ENTRY_GUARDED saying
 *     why it has no guard. Neither list may name a file that does not qualify.
 */

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCANNED_DIRS = ['scripts', 'npm/scripts', 'hooks'];

const META = /import\.meta\.(?:url|filename)/;
const ARGV = /process\s*\.\s*argv|\{[^}]*\bargv\b[^}]*\}\s*=\s*process\b/;

/** Entry-guard shapes that compare a path without resolving symlinks. */
const UNRESOLVED: RegExp[] = [
  /import\.meta\.(?:url|filename)\s*[!=]==?/,
  /[!=]==?\s*(?:fileURLToPath\(\s*)?import\.meta\.(?:url|filename)/,
  /process\.argv\s*(?:\[\s*1\s*\]|\.at\(\s*1\s*\))\s*[!=]==?/,
  /[!=]==?\s*process\.argv\s*(?:\[\s*1\s*\]|\.at\(\s*1\s*\))/,
  /pathToFileURL\(\s*(?:process\.)?argv/,
  /file:\/\/\$\{\s*(?:process\.)?argv/,
  /isMain\(\s*import\.meta\.filename/,
];

/** True when `source` contains an entry guard that ignores symlinks. */
function hasUnresolvedGuard(source: string): boolean {
  const code = stripComments(source);
  return UNRESOLVED.some((re) => re.test(code));
}

/** True when `source` could hold an entry guard and so must be accounted for. */
function mayGuardEntry(source: string): boolean {
  const code = stripComments(source);
  return META.test(code) && (ARGV.test(code) || /\bisMain\(/.test(code));
}

/**
 * Drop block comments and whole-line `//` comments, so prose describing an
 * old guard neither trips nor satisfies the detector. Trailing `//` is left
 * alone: it would also match the `//` inside a `file://` string.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Qualifying files that run unconditionally, with why there is no guard. */
const NOT_ENTRY_GUARDED: Record<string, string> = {
  'scripts/bump-version.mjs': 'runs unconditionally; import.meta finds root',
  'scripts/check_doc_links.mjs': 'runs unconditionally; import.meta finds root',
  'scripts/docs-ratchet.mjs': 'runs unconditionally; import.meta finds root',
  'scripts/entropy-ratchet.mjs': 'runs unconditionally; import.meta finds root',
  'scripts/perf-ratchet.mjs': 'runs unconditionally; import.meta finds root',
  'scripts/roadmap-denominator-check.mjs':
    'runs unconditionally; import.meta finds root',
  'scripts/roadmap-groom.mjs': 'runs unconditionally; import.meta finds root',
  'scripts/roadmap-sync.mjs': 'runs unconditionally; import.meta finds files',
  'scripts/roadmap_comment_guard.mjs':
    'runs unconditionally; import.meta finds root',
  'npm/scripts/build-engine.mjs':
    'runs unconditionally; import.meta finds dirs',
};

interface Case {
  args: string[];
  status: number;
  output: RegExp;
  /** Builds the real file to link to; defaults to the repo copy. */
  target?: (dir: string) => string;
}

/**
 * A self-contained copy of the drift gate whose mirror has drifted, so
 * `--check` has something observable to say (it is silent when clean).
 */
function driftedSyncTree(dir: string): string {
  const tree = join(dir, 'tree');
  mkdirSync(join(tree, 'npm', 'scripts'), { recursive: true });
  mkdirSync(join(tree, 'npm', 'src'), { recursive: true });
  mkdirSync(join(tree, 'ts', 'src', 'core'), { recursive: true });
  writeFileSync(join(tree, 'ts', 'src', 'core', 'gate-result.ts'), 'a\n');
  writeFileSync(join(tree, 'npm', 'src', 'gate-result.ts'), 'drifted\n');
  const script = join(tree, 'npm', 'scripts', 'sync-gate-result.mjs');
  copyFileSync(join(REPO_ROOT, 'npm/scripts/sync-gate-result.mjs'), script);
  return script;
}

const usage = { args: [], status: 2, output: /usage:/ };
const CASES: Record<string, Case> = {
  'scripts/arch-verdict.mjs': {
    args: ['absent.json'],
    status: 3,
    output: /ABSTAINED/,
  },
  'scripts/gemini-commands-drift.mjs': {
    args: ['--bogus'],
    status: 2,
    output: /usage:/,
  },
  'scripts/install-siren.mjs': usage,
  'scripts/refresh-arch-baseline.mjs': usage,
  'scripts/rehearse.mjs': {
    args: ['--root', 'absent'],
    status: 3,
    output: /0 fired of \d+ expected/,
  },
  'scripts/schedule-staleness.mjs': usage,
  'scripts/source-visibility.mjs': {
    args: ['--print-skip-dirs'],
    status: 0,
    output: /"\.git"/,
  },
  'scripts/test-duration-ratchet.mjs': usage,
  'scripts/traceability-verdict.mjs': {
    args: ['absent.json'],
    status: 3,
    output: /ABSTAINED/,
  },
  'npm/scripts/sync-gate-result.mjs': {
    args: ['--check'],
    status: 1,
    output: /has drifted/,
    target: driftedSyncTree,
  },
};

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' ? [] : walk(path);
    }
    return /\.(?:mjs|js|cjs)$/.test(entry.name) ? [path] : [];
  });
}

function scannedFiles(): { rel: string; source: string }[] {
  return SCANNED_DIRS.flatMap((dir) => walk(join(REPO_ROOT, dir)))
    .map((path) => ({
      rel: relative(REPO_ROOT, path).split('\\').join('/'),
      source: readFileSync(path, 'utf8'),
    }))
    .sort((a, b) => a.rel.localeCompare(b.rel));
}

/** Run `rel` through a symlink in a directory whose path contains a space. */
function runThroughSymlink(rel: string, c: Case) {
  const tmp = mkdtempSync(join(tmpdir(), 'entry-guard-'));
  try {
    const dir = join(tmp, 'with space');
    mkdirSync(dir);
    const real = c.target ? c.target(dir) : join(REPO_ROOT, rel);
    const link = join(dir, `link to ${rel.split('/').pop()}`);
    symlinkSync(real, link);
    const r = spawnSync(process.execPath, [link, ...c.args], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 30_000,
    });
    return { status: r.status, output: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe('entry-guard detector', () => {
  const broken = [
    'if (import.meta.url === pathToFileURL(process.argv[1]).href) main();',
    'if (process.argv[1] === fileURLToPath(import.meta.url)) main();',
    'if (import.meta.url === `file://${process.argv[1]}`) main();',
    'const [, entry] = process.argv;\nif (entry === fileURLToPath(import.meta.url)) main();',
    'if (process.argv.at(1) === fileURLToPath(import.meta.url)) main();',
    'const { argv } = process;\nif (argv[1] === import.meta.filename) main();',
    'const { argv } = process;\nif (import.meta.url === pathToFileURL(argv[1]).href) main();',
    'if (isMain(import.meta.filename)) main();',
  ];
  it.each(broken)('flags the unresolved guard %#', (source) => {
    expect(hasUnresolvedGuard(source)).toBe(true);
    expect(mayGuardEntry(source)).toBe(true);
  });

  it('accepts the realpath guard', () => {
    expect(hasUnresolvedGuard('if (isMain(import.meta.url)) main();')).toBe(
      false,
    );
  });
});

describe('script entry guards (#1189)', () => {
  it('no scanned file compares unresolved paths to find its entry point', () => {
    const offenders = scannedFiles()
      .filter((f) => hasUnresolvedGuard(f.source))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('every possible entry guard has a symlink case or a stated exemption', () => {
    const qualifying = scannedFiles()
      .filter((f) => mayGuardEntry(f.source))
      .map((f) => f.rel);
    const accounted = [
      ...Object.keys(CASES),
      ...Object.keys(NOT_ENTRY_GUARDED),
    ];
    expect(qualifying).toEqual(
      [...accounted].sort((a, b) => a.localeCompare(b)),
    );
  });

  it('a symlink case never names an exempt file', () => {
    const both = Object.keys(CASES).filter((rel) => rel in NOT_ENTRY_GUARDED);
    expect(both).toEqual([]);
  });

  for (const [rel, c] of Object.entries(CASES)) {
    it(`${rel} runs main() when invoked through a symlink`, () => {
      const r = runThroughSymlink(rel, c);
      expect(r.output).toMatch(c.output);
      expect(r.status).toBe(c.status);
    });
  }
});

describe('scripts/lib/is-main.mjs', () => {
  it('is false for an absent or nonexistent entry, so imports stay inert', async () => {
    const { isMain } = (await import(
      pathToFileURL(join(REPO_ROOT, 'scripts/lib/is-main.mjs')).href
    )) as { isMain: (metaUrl: string, entry?: string) => boolean };
    const self = pathToFileURL(join(REPO_ROOT, 'scripts/rehearse.mjs')).href;
    expect(isMain(self, undefined)).toBe(false);
    expect(isMain(self, join(REPO_ROOT, 'scripts', 'no-such-file.mjs'))).toBe(
      false,
    );
    expect(isMain(self, join(REPO_ROOT, 'scripts', 'arch-verdict.mjs'))).toBe(
      false,
    );
    expect(isMain(self, join(REPO_ROOT, 'scripts', 'rehearse.mjs'))).toBe(true);
  });
});
