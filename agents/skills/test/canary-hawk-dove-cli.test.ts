// canary-hawk-dove CLI end to end (#618): the real `main` over a temp repo.
// Labellers are synthetic; no fixture comes from a real diff.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from '../claude-code/canary-hawk-dove/scripts/cli.mjs';

const NOW = new Date('2026-01-01T00:00:00Z');
const deps = { now: () => NOW };
const LEDGER = '.canary/hawk-dove/ledger.jsonl';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hd-cli-')));
  dirs.push(d);
  return d;
}

function run(argv: string[]): { code: number; out: string; err: string } {
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
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** A git repo with two commits: base adds a.ts, head touches a.ts. */
function gitRepo(): { dir: string; base: string; head: string } {
  const dir = tmp();
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 'synthetic@example.invalid');
  git('config', 'user.name', 'Synthetic Labeller');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/a.ts'), 'export const a = 1;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(dir, 'src/a.ts'), 'export const a = 2;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'head');
  return { dir, base, head: git('rev-parse', 'HEAD') };
}

interface GF {
  path: string;
  unit: string;
  suppressed?: boolean;
  suppression_reason?: string | null;
  fidelity?: string;
}

function writeRun(
  dir: string,
  name: string,
  findings: GF[],
  base: string,
  head: string,
) {
  const doc = {
    findings: findings.map((f) => ({
      kind: 'untested',
      fidelity: 'coverage-verified',
      suppressed: false,
      suppression_reason: null,
      ...f,
    })),
    tier: 0,
    checked: 1,
    abstained: false,
    coverage: { status: 'verified', unitsTotal: 1, unitsMatched: 1 },
    provenance: { base, head, origin: 'git', fileCount: 1 },
    skipped: [],
  };
  fs.writeFileSync(path.join(dir, name), JSON.stringify(doc));
}

function ledgerLines(dir: string) {
  return fs
    .readFileSync(path.join(dir, LEDGER), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
}

const findingIds = (dir: string) =>
  ledgerLines(dir)
    .filter((r) => r.kind === 'finding')
    .map((r) => r.id as string);

describe('usage', () => {
  it('prints help and exits 0', () => {
    const res = run(['--help']);
    expect(res.code).toBe(0);
    expect(res.out).toContain('usage: canary-hawk-dove');
  });

  it.each([
    [[], 'expected a command'],
    [['tune'], 'unknown command'],
    [['report', '--gate', 'guardian'], 'argument --gate: not used by report'],
    [['record', '--from', 'x.json'], 'argument --gate: required'],
    [['record', '--gate', 'Bad Gate', '--from', 'x.json'], 'argument --gate'],
    [['record', '--gate', 'guardian', '--from', 'x.json', '--pr', '0'], '--pr'],
    [
      ['record', '--gate', 'g', '--from', 'x.json', '--at', 'yesterday'],
      '--at',
    ],
    [
      ['escape', '--gate', 'g', '--by', 'derived', '--evidence', 'e'],
      'reserved',
    ],
    [['escape', '--gate', 'g', '--by', 'synthetic-labeller'], '--evidence'],
    [
      [
        'escape',
        'hd1-0000000000000000',
        '--gate',
        'g',
        '--by',
        'x',
        '--evidence',
        'e',
      ],
      'no finding id',
    ],
    [
      ['label', '--outcome', 'real', '--by', 'x', '--evidence', 'e'],
      'one finding id',
    ],
    [
      ['label', 'id', '--outcome', 'escape', '--by', 'x', '--evidence', 'e'],
      '--outcome',
    ],
    [['report', 'extra'], 'takes no arguments'],
  ])('%j is a usage error', (argv, text) => {
    const res = run(argv as string[]);
    expect(res.code).toBe(2);
    expect(res.err).toContain(text);
  });
});

describe('record', () => {
  it('records findings with stable ids, at the default ledger path', () => {
    const { dir, base, head } = gitRepo();
    writeRun(dir, 'r1.json', [{ path: 'src/a.ts', unit: 'a' }], base, head);
    const res = run([
      'record',
      '--repo',
      dir,
      '--gate',
      'guardian',
      '--from',
      'r1.json',
    ]);
    expect(res.code).toBe(0);
    expect(res.out).toContain('recorded run-1 (guardian): 1 finding(s), 1 new');
    expect(fs.existsSync(path.join(dir, LEDGER))).toBe(true);
    // Recording the same run again adds a run, never a duplicate finding.
    run(['record', '--repo', dir, '--gate', 'guardian', '--from', 'r1.json']);
    expect(findingIds(dir)).toHaveLength(1);
  });

  it('derives fp: noise and reasoned intentional labels with their rule', () => {
    const { dir, base, head } = gitRepo();
    writeRun(
      dir,
      'r.json',
      [
        {
          path: 'src/a.ts',
          unit: 'a',
          suppressed: true,
          suppression_reason: 'fp: type-only',
        },
        {
          path: 'src/a.ts',
          unit: 'b',
          suppressed: true,
          suppression_reason: 'generated',
        },
      ],
      base,
      head,
    );
    const res = run([
      'record',
      '--repo',
      dir,
      '--gate',
      'guardian',
      '--from',
      'r.json',
    ]);
    expect(res.out).toContain('2 derived label(s)');
    const labels = ledgerLines(dir).filter((r) => r.kind === 'label');
    expect(labels.map((l) => [l.outcome, l.rule, l.by])).toEqual([
      ['noise', 'guardian-fp-suppression', 'derived'],
      ['intentional', 'guardian-reasoned-suppression', 'derived'],
    ]);
  });

  it('derives covered-later real across two runs of one PR, through real git', () => {
    const { dir, base, head } = gitRepo();
    writeRun(dir, 'first.json', [{ path: 'src/a.ts', unit: 'a' }], base, head);
    writeRun(dir, 'last.json', [], base, head);
    const argv = ['record', '--repo', dir, '--gate', 'guardian', '--pr', '7'];
    run([...argv, '--from', 'first.json']);
    const res = run([...argv, '--from', 'last.json']);
    expect(res.out).toContain('1 derived label(s)');
    const real = ledgerLines(dir).filter((r) => r.kind === 'label');
    expect(real).toEqual([
      expect.objectContaining({
        outcome: 'real',
        rule: 'guardian-covered-later',
        evidence: 'run run-1 -> run run-2, PR 7',
        at: NOW.toISOString(),
      }),
    ]);
  });

  it('reads the scan-baseline shape for any other gate', () => {
    const dir = tmp();
    fs.writeFileSync(
      path.join(dir, 's.json'),
      JSON.stringify({
        findings: [{ file: 't.test.ts', rule: 'SV004', anchor: 'let x' }],
      }),
    );
    const res = run([
      'record',
      '--repo',
      dir,
      '--gate',
      'savant',
      '--from',
      's.json',
    ]);
    expect(res.code).toBe(0);
    expect(findingIds(dir)).toHaveLength(1);
  });

  it.each([
    [
      'a directory',
      (d: string) => fs.mkdirSync(path.join(d, 'in.json')),
      'not a regular file',
    ],
    [
      'a symlink',
      (d: string) => {
        fs.writeFileSync(path.join(d, 'real.json'), '{"findings":[]}');
        fs.symlinkSync(path.join(d, 'real.json'), path.join(d, 'in.json'));
      },
      'not read: symlink',
    ],
    ['missing', () => {}, 'not read: missing'],
  ])('refuses --from that is %s', (_what, make, text) => {
    const dir = tmp();
    make(dir);
    const res = run([
      'record',
      '--repo',
      dir,
      '--gate',
      'g',
      '--from',
      'in.json',
    ]);
    expect(res.code).toBe(2);
    expect(res.err).toContain(text);
    expect(fs.existsSync(path.join(dir, LEDGER))).toBe(false);
  });

  it('refuses a non-.json input and a path outside the repository', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'in.txt'), '{"findings":[]}');
    expect(
      run(['record', '--repo', dir, '--gate', 'g', '--from', 'in.txt']).err,
    ).toContain('not a .json file');
    const other = tmp();
    fs.writeFileSync(path.join(other, 'in.json'), '{"findings":[]}');
    const res = run([
      'record',
      '--repo',
      dir,
      '--gate',
      'g',
      '--from',
      path.join(other, 'in.json'),
    ]);
    expect(res.err).toContain('outside the repository');
  });

  it('a malformed input names itself and a position, never its bytes', () => {
    const dir = tmp();
    fs.writeFileSync(
      path.join(dir, 'bad.json'),
      '{"findings": [ SECRET-VALUE ]}',
    );
    const res = run([
      'record',
      '--repo',
      dir,
      '--gate',
      'g',
      '--from',
      'bad.json',
    ]);
    expect(res.code).toBe(2);
    expect(res.err).toContain('invalid JSON in bad.json');
    expect(res.err).not.toContain('SECRET');
  });

  it('cannot write through a symlinked ledger directory', () => {
    const dir = tmp();
    const outside = tmp();
    fs.writeFileSync(path.join(dir, 's.json'), '{"findings":[]}');
    fs.symlinkSync(outside, path.join(dir, '.canary'));
    const res = run([
      'record',
      '--repo',
      dir,
      '--gate',
      'g',
      '--from',
      's.json',
    ]);
    expect(res.code).toBe(2);
    expect(res.err).toContain('ledger not read: symlink');
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});

describe('label and escape', () => {
  function recorded(): { dir: string; id: string } {
    const dir = tmp();
    fs.writeFileSync(
      path.join(dir, 's.json'),
      JSON.stringify({ findings: [{ file: 'a.ts', rule: 'r', anchor: 'x' }] }),
    );
    run(['record', '--repo', dir, '--gate', 'savant', '--from', 's.json']);
    return { dir, id: findingIds(dir)[0]! };
  }

  it('labels a known finding with full provenance', () => {
    const { dir, id } = recorded();
    const res = run([
      'label',
      id,
      '--repo',
      dir,
      '--outcome',
      'noise',
      '--by',
      'synthetic-labeller',
      '--evidence',
      'issue-123',
      '--note',
      'shared fixture',
      '--at',
      '2026-02-03T04:05:06Z',
    ]);
    expect(res.code).toBe(0);
    expect(ledgerLines(dir).at(-1)).toEqual({
      v: 1,
      kind: 'label',
      rule: 'explicit',
      finding: id,
      gate: 'savant',
      outcome: 'noise',
      by: 'synthetic-labeller',
      at: '2026-02-03T04:05:06.000Z',
      evidence: 'issue-123',
      note: 'shared fixture',
    });
  });

  it('rejects an unknown finding id and stores nothing', () => {
    const { dir } = recorded();
    const before = fs.readFileSync(path.join(dir, LEDGER));
    for (const id of ['hd1-ffffffffffffffff', '__proto__', 'x\u001b[2Jy']) {
      const res = run([
        'label',
        id,
        '--repo',
        dir,
        '--outcome',
        'real',
        '--by',
        'synthetic-labeller',
        '--evidence',
        'e',
      ]);
      expect(res.code).toBe(2);
      expect(res.err).toContain('unknown finding id');
      expect(res.err).not.toContain('\u001b');
    }
    expect(fs.readFileSync(path.join(dir, LEDGER)).equals(before)).toBe(true);
  });

  it('records an escape with gate and evidence and no finding id', () => {
    const dir = tmp();
    const res = run([
      'escape',
      '--repo',
      dir,
      '--gate',
      'guardian',
      '--by',
      'synthetic-labeller',
      '--evidence',
      'incident-9\nforged line',
    ]);
    expect(res.code).toBe(0);
    expect(ledgerLines(dir)).toEqual([
      expect.objectContaining({
        kind: 'label',
        finding: null,
        gate: 'guardian',
        outcome: 'escape',
        evidence: 'incident-9 forged line',
        at: NOW.toISOString(),
      }),
    ]);
  });

  it('every command appends: earlier bytes are never rewritten', () => {
    const { dir, id } = recorded();
    const before = fs.readFileSync(path.join(dir, LEDGER));
    run([
      'label',
      id,
      '--repo',
      dir,
      '--outcome',
      'real',
      '--by',
      'a',
      '--evidence',
      'e',
    ]);
    run([
      'escape',
      '--repo',
      dir,
      '--gate',
      'savant',
      '--by',
      'a',
      '--evidence',
      'e',
    ]);
    const after = fs.readFileSync(path.join(dir, LEDGER));
    expect(after.subarray(0, before.length).equals(before)).toBe(true);
  });
});

describe('report', () => {
  it('abstains (exit 3) with no ledger, on stdout and stderr', () => {
    const dir = tmp();
    const res = run(['report', '--repo', dir]);
    expect(res.code).toBe(3);
    expect(res.out).toContain('Abstained');
    expect(res.out).toContain(`no ledger at ${LEDGER}`);
    expect(res.err).toContain('Abstained');
  });

  it('abstains below the floor and says how many more', () => {
    const dir = tmp();
    for (let i = 0; i < 3; i += 1) {
      run([
        'escape',
        '--repo',
        dir,
        '--gate',
        'guardian',
        '--by',
        'a',
        '--evidence',
        `e${i}`,
      ]);
    }
    const res = run(['report', '--repo', dir, '--json']);
    expect(res.code).toBe(3);
    const json = JSON.parse(res.out);
    expect(json).toMatchObject({ abstained: true, checked: 3, floor: 30 });
    expect(json.gates[0]).toMatchObject({
      gate: 'guardian',
      escape: 3,
      needs: 30,
    });
  });

  it('reports counts at the floor and exits 0, writing --out', () => {
    const dir = tmp();
    const findings = Array.from({ length: 30 }, (_, i) => ({
      file: `f${i}.ts`,
      rule: 'r',
      anchor: '',
    }));
    fs.writeFileSync(path.join(dir, 's.json'), JSON.stringify({ findings }));
    run(['record', '--repo', dir, '--gate', 'savant', '--from', 's.json']);
    for (const [i, id] of findingIds(dir).entries()) {
      run([
        'label',
        id,
        '--repo',
        dir,
        '--outcome',
        i < 20 ? 'real' : 'noise',
        '--by',
        'a',
        '--evidence',
        'e',
      ]);
    }
    const out = path.join(dir, 'reports', 'hd.md');
    const res = run(['report', '--repo', dir, '--out', out]);
    expect(res.code).toBe(0);
    expect(res.out).toMatch(
      /\| savant \| 20 \| 10 \| 0 \| 0 \| 0 \| 30 \| at floor \|/,
    );
    expect(res.out).toContain('Threshold tuning is not built yet');
    expect(fs.readFileSync(out, 'utf8')).toBe(`${res.out}\n`);
  });

  it('a failed --out write is a clean cannot-write error (exit 1)', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'file'), '');
    const res = run([
      'report',
      '--repo',
      dir,
      '--out',
      path.join(dir, 'file', 'x.md'),
    ]);
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/cannot write .*x\.md: E[A-Z]+/);
  });

  it('an unreadable ledger is exit 2, not an abstention', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, LEDGER), { recursive: true });
    const res = run(['report', '--repo', dir]);
    expect(res.code).toBe(2);
    expect(res.err).toContain('ledger not read: not a regular file');
  });
});
