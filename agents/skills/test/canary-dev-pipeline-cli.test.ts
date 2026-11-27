/**
 * canary-dev-pipeline (#666) -- the CLI end to end: zero-argument use over the
 * working diff, the abstention contract (exit 3, never an all-clear), the
 * advisory contract (findings never change the exit code), --json, --out,
 * escaping, the time budget, and the success criteria SC1-SC10 of
 * docs/changes/666-canary-dev-pipeline/proposal.md. Fixtures are synthetic
 * repositories; scanner positives live inside string literals.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from '../claude-code/canary-dev-pipeline/scripts/cli.mjs';
import { MAX_ROWS } from '../claude-code/canary-dev-pipeline/scripts/render.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.join(HERE, '..', 'claude-code', 'canary-dev-pipeline');
const CLI = path.join(SKILL, 'scripts', 'cli.mjs');

const tmps: string[] = [];
function tmp(): string {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'canary-devpipe-c-')),
  );
  tmps.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tmps.length) {
    fs.rmSync(tmps.pop()!, { recursive: true, force: true });
  }
});

function git(dir: string, ...args: string[]): void {
  execFileSync(
    'git',
    [
      '-C',
      dir,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    { stdio: 'ignore' },
  );
}

function write(dir: string, rel: string, lines: string[] = ['x']): void {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
}

/** `main` on a branch off `main`, with a clean working tree. */
function repo(): string {
  const dir = tmp();
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, 'src/base.ts', ['export const base = 1;']);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'feature');
  return dir;
}

/** A diff with a tied source, an untied source and a leaky test. */
function busyRepo(): string {
  const dir = repo();
  write(dir, 'src/cart.ts', ['export const add = () => 1;']);
  write(dir, 'src/orphan.ts', ['export const lonely = 1;']);
  write(dir, 'tests/cart.test.ts', [
    "import { add } from '../src/cart';",
    'const cache = {};',
    "it('adds', () => { cache['k'] = add(); const t = Date.now(); });",
  ]);
  return dir;
}

function run(argv: string[], deps = {}) {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    out.push(a.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    err.push(a.join(' '));
  });
  const code = main(argv, deps);
  vi.restoreAllMocks();
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

function envWithoutGit(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  return env;
}

/** Spawn the real CLI with no arguments, as a developer would. */
function spawnBare(cwd: string, argv: string[] = []) {
  const r = spawnSync(process.execPath, [CLI, ...argv], {
    cwd,
    encoding: 'utf8',
    env: envWithoutGit(),
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('zero-argument use (SC1)', () => {
  it('reads the working diff with no flags at all and exits 0', () => {
    const r = spawnBare(busyRepo());
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('working diff against main');
    expect(r.stdout).toContain('3 file(s), 2 source, 1 test');
    for (const section of [
      '## Risk (canary-critical-areas)',
      '## Isolation smells (canary-savant)',
      '## Temporal dependence (canary-blackhawk)',
      '## Test ties (gap analysis) (canary-katana)',
    ]) {
      expect(r.stdout).toContain(section);
    }
  });
});

describe('abstention (SC2) -- exit 3, never an all-clear', () => {
  it('abstains on an empty working diff, on stdout and stderr', () => {
    const r = spawnBare(repo());
    expect(r.code).toBe(3);
    expect(r.stdout).toContain('Abstained');
    expect(r.stdout).toMatch(/working diff is empty/);
    expect(r.stderr).toMatch(/canary-dev-pipeline: .*Abstained.*empty/);
    expect(r.stdout).not.toContain('No finding');
    expect(r.stdout).not.toContain('Checked');
  });

  it('abstains outside a git repository when no path is given', () => {
    const r = run(['--repo', tmp()]);
    expect(r.code).toBe(3);
    expect(r.stdout).toMatch(/not a git repository/);
  });

  it('abstains when no member could check any file (docs-only diff)', () => {
    const dir = repo();
    write(dir, 'docs/guide.md');
    const r = run(['--repo', dir]);
    expect(r.code).toBe(3);
    expect(r.stdout).toMatch(/no member checked any of the 1 file/);
  });

  it('keeps the per-path notes when named paths select nothing', () => {
    const dir = repo();
    const r = run(['--repo', dir, 'nope.ts'], { cwd: dir });
    expect(r.code).toBe(3);
    expect(r.stdout).toContain('the given paths select no file');
    expect(r.stdout).toContain('- path not found: nope.ts');
  });

  it('abstains when the budget is spent before any member runs', () => {
    let t = 0;
    const r = run(['--repo', busyRepo(), '--budget-ms', '0'], {
      clock: () => (t += 10),
    });
    expect(r.code).toBe(3);
    expect(r.stdout).toMatch(/time budget spent/);
  });
});

describe('explicit paths override the diff (SC3)', () => {
  it('analyses only the named file', () => {
    const dir = busyRepo();
    const r = run(['--repo', dir, '--json', 'src/base.ts'], { cwd: dir });
    const brief = JSON.parse(r.stdout);
    expect(r.code).toBe(0);
    expect(brief.target).toMatchObject({ mode: 'paths', files: 1 });
  });
});

describe('the brief (SC4-SC6)', () => {
  it('names gaps, ties, savant and blackhawk findings', () => {
    const r = run(['--repo', busyRepo()]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('src/orphan.ts: **no test ties to it**');
    expect(r.stdout).toContain('src/cart.ts: tied to tests/cart.test.ts');
    expect(r.stdout).toMatch(
      /tests\/cart\.test\.ts:2 SV001-module-mutable-global/,
    );
    expect(r.stdout).toMatch(/tests\/cart\.test\.ts:3 BH001-wall-clock/);
    expect(r.stdout).toMatch(
      /Not checked: no map at \.canary\/critical-areas\.json; run canary critical-areas/,
    );
  });

  it('findings never change the exit code (SC8)', () => {
    const r = run(['--repo', busyRepo(), '--json']);
    const brief = JSON.parse(r.stdout);
    const rows = brief.members.flatMap((m: { rows: unknown[] }) => m.rows);
    expect(rows.length).toBeGreaterThan(2);
    expect(r.code).toBe(0);
  });

  it('suggests edge cases for gaps first and failure impact for high risk', () => {
    const dir = busyRepo();
    write(dir, '.canary/critical-areas.json', [
      JSON.stringify({
        version: 1,
        generated: '2026-11-01T00:00:00Z',
        areas: [
          { path: 'src/cart.ts', risk_score: 0.9 },
          { path: 'src/orphan.ts', risk_score: 0.3 },
        ],
      }),
    ]);
    const brief = JSON.parse(run(['--repo', dir, '--json']).stdout);
    expect(brief.members[0]).toMatchObject({ name: 'risk', status: 'ran' });
    expect(brief.suggestions).toEqual([
      {
        command: '/canary-edge-cases',
        path: 'src/orphan.ts',
        why: 'changed, no test ties to it',
      },
      {
        command: '/canary-edge-cases',
        path: 'src/cart.ts',
        why: 'changed, tied',
      },
      {
        command: '/canary-failure-impact',
        path: 'src/cart.ts',
        why: 'risk 0.9',
      },
    ]);
    const md = run(['--repo', dir]).stdout;
    expect(md).toContain('- src/cart.ts: risk 0.9');
    expect(md).toContain(
      'Confirm with the user before running `/canary-write-test`',
    );
  });

  it('carries the spec JSON shape', () => {
    const brief = JSON.parse(run(['--repo', busyRepo(), '--json']).stdout);
    expect(brief).toMatchObject({
      schema_version: 1,
      advisory: true,
      abstained: false,
      reason: null,
      budget_ms: 5000,
    });
    expect(Object.keys(brief.target).sort()).toEqual(
      [
        'base',
        'base_ref',
        'clamped',
        'deleted',
        'files',
        'mode',
        'notes',
        'other',
        'source',
        'test',
      ].sort(),
    );
    expect(brief.members.map((m: { name: string }) => m.name)).toEqual([
      'risk',
      'isolation',
      'temporal',
      'ties',
    ]);
    expect(typeof brief.elapsed_ms).toBe('number');
  });

  it(`lists at most ${MAX_ROWS} rows per section in Markdown, all of them in JSON`, () => {
    const dir = repo();
    for (let i = 0; i < MAX_ROWS + 4; i += 1) write(dir, `src/f${i}.ts`);
    const md = run(['--repo', dir]).stdout;
    expect(md).toContain('- ... and 4 more (see --json)');
    const brief = JSON.parse(run(['--repo', dir, '--json']).stdout);
    expect(brief.members[3].rows).toHaveLength(MAX_ROWS + 4);
  });

  it('reports deleted and clamped counts and notes', () => {
    const dir = repo();
    fs.rmSync(path.join(dir, 'src/base.ts'));
    write(dir, 'src/kept.ts');
    const r = run(['--repo', dir, 'src', 'nope'], { cwd: dir });
    expect(r.stdout).toContain('## Notes');
    expect(r.stdout).toContain('- path not found: nope');
    const d = run(['--repo', dir]).stdout;
    expect(d).toContain(
      '1 deleted (not analysed; canary-katana covers deletions)',
    );
  });
});

describe('--out (SC8)', () => {
  it('writes the brief and still prints it', () => {
    const dir = busyRepo();
    const out = path.join(tmp(), 'nested', 'brief.json');
    const r = run(['--repo', dir, '--json', '--out', out]);
    expect(r.code).toBe(0);
    expect(JSON.parse(fs.readFileSync(out, 'utf8')).advisory).toBe(true);
    expect(r.stdout).toContain('"advisory": true');
  });

  it('fails cleanly with "cannot write artifact" and exit 1', () => {
    const blocker = path.join(tmp(), 'file');
    fs.writeFileSync(blocker, 'x');
    const r = run(['--repo', busyRepo(), '--out', path.join(blocker, 'b.md')]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^canary-dev-pipeline: cannot write artifact: /);
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });
});

describe('usage', () => {
  it('rejects a negative budget', () => {
    const r = run(['--budget-ms', '-1']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--budget-ms: must be 0 or more/);
  });
});

describe('escaping end to end (SC9)', () => {
  it('a hostile file name renders as one escaped, plain row', () => {
    const dir = repo();
    write(dir, 'src/x\n# Owned [a](evil) \u001b[31mred|.ts');
    for (const argv of [
      ['--repo', dir],
      ['--repo', dir, '--json'],
    ]) {
      const r = run(argv);
      expect(r.stdout).not.toContain('\u001b');
      expect(r.stdout).not.toMatch(/^# Owned/m);
    }
    const md = run(['--repo', dir]).stdout;
    expect(md).not.toMatch(/(^|[^\\])\[a\]/);
    expect(md).toContain('src/x \\# Owned \\[a\\](evil) red\\|.ts');
  });

  it('builds no regular expression from input outside escape.mjs', () => {
    const dir = path.join(SKILL, 'scripts');
    const names = fs.readdirSync(dir).filter((n) => n !== 'escape.mjs');
    expect(names.length).toBeGreaterThan(4);
    for (const name of names) {
      const src = fs.readFileSync(path.join(dir, name), 'utf8');
      expect(src, name).not.toMatch(/(?<!escape)RegExp\(/);
    }
  });

  it('ships ASCII-only scripts', () => {
    const dir = path.join(SKILL, 'scripts');
    for (const name of fs.readdirSync(dir)) {
      const src = fs.readFileSync(path.join(dir, name), 'utf8');
      expect(/^[\x00-\x7f]*$/.test(src), name).toBe(true);
    }
  });
});

describe('time budget (SC7)', () => {
  it('finishes a 200-file diff over a 300-test repository inside 5000 ms', () => {
    const dir = repo();
    for (let i = 0; i < 300; i += 1) {
      write(dir, `tests/t${i}.test.ts`, [
        `import { f${i} } from '../src/f${i}';`,
        `it('f${i}', () => { f${i}(); });`,
      ]);
    }
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'tests');
    for (let i = 0; i < 200; i += 1) {
      write(dir, `src/f${i}.ts`, [`export const f${i} = () => ${i};`]);
    }
    const r = spawnBare(dir, ['--json']);
    expect(r.code).toBe(0);
    const brief = JSON.parse(r.stdout);
    expect(brief.target.files).toBe(200);
    expect(brief.members.map((m: { status: string }) => m.status)).toEqual([
      'not-checked',
      'not-checked',
      'not-checked',
      'ran',
    ]);
    expect(brief.elapsed_ms).toBeLessThan(5000);
  }, 30_000);
});
