/**
 * Repo scripts must run when reached through a symlink (#1189, same class as
 * #1182).
 *
 * The scripts under `scripts/` and `npm/scripts/` decide whether to run main()
 * by comparing their own location with `process.argv[1]`. A comparison of
 * unresolved paths (`fileURLToPath(import.meta.url)`, or the URL-encoding-safe
 * `pathToFileURL(argv[1]).href`) is false whenever the invoked path is a
 * symlink, because `import.meta.url` is always the resolved real path. The
 * script then printed nothing and exited 0, which a caller reads as a pass --
 * `sync-gate-result --check` is npm's drift gate and `rehearse.mjs` is the gate
 * that proves the other gates fire.
 *
 * Discovery-driven: every top-level script carrying an entry guard must have a
 * case below, so a new guarded script cannot dodge the symlink check by being
 * absent from a hand-maintained list.
 */

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT_DIRS = ['scripts', 'npm/scripts'];
const GUARD = /isMain\(import\.meta\.url\)|process\.argv\[1\]/;

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

const CASES: Record<string, Case> = {
  'scripts/arch-verdict.mjs': {
    args: ['absent.json'],
    status: 3,
    output: /ABSTAINED/,
  },
  'scripts/install-siren.mjs': { args: [], status: 2, output: /usage:/ },
  'scripts/refresh-arch-baseline.mjs': {
    args: [],
    status: 2,
    output: /usage:/,
  },
  'scripts/rehearse.mjs': {
    args: ['--root', 'absent'],
    status: 3,
    output: /0 fired of \d+ expected/,
  },
  'scripts/source-visibility.mjs': {
    args: ['--print-skip-dirs'],
    status: 0,
    output: /"\.git"/,
  },
  'scripts/test-duration-ratchet.mjs': {
    args: [],
    status: 2,
    output: /usage:/,
  },
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

function guardedScripts(): string[] {
  return SCRIPT_DIRS.flatMap((dir) =>
    readdirSync(join(REPO_ROOT, dir))
      .filter((name) => name.endsWith('.mjs'))
      .map((name) => `${dir}/${name}`)
      .filter((rel) => GUARD.test(readFileSync(join(REPO_ROOT, rel), 'utf8'))),
  ).sort();
}

/** Run `rel` through a symlink in a directory whose path contains a space. */
function runThroughSymlink(rel: string, c: Case) {
  const dir = join(mkdtempSync(join(tmpdir(), 'entry-guard-')), 'with space');
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
}

describe('script entry guards (#1189)', () => {
  it('every guarded script has a symlink case, and every case is guarded', () => {
    expect(guardedScripts()).toEqual(Object.keys(CASES).sort());
  });

  it('no script compares unresolved paths to decide it is the entry point', () => {
    const unresolved =
      /pathToFileURL\(process\.argv\[1\]\)|=== fileURLToPath\(import\.meta\.url\)|file:\/\/\$\{process\.argv\[1\]\}/;
    const offenders = guardedScripts().filter((rel) =>
      unresolved.test(readFileSync(join(REPO_ROOT, rel), 'utf8')),
    );
    expect(offenders).toEqual([]);
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
