/**
 * canary-batgirl end to end (#619): flags, exit codes, Markdown and JSON.
 *
 * Exit codes (spec D8): 0 when at least one dimension is assessed, whatever
 * the values; 3 when none is (abstained, ADR 0009); 1 for I/O (a named input
 * that cannot be read, an unwritable --out); 2 for usage. A dimension with no
 * input prints "not assessed" with a reason and a null value, never 0 or 100%.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from '../claude-code/canary-batgirl/scripts/cli.mjs';

const dirs: string[] = [];
let cwd = '';
afterEach(() => {
  vi.restoreAllMocks();
  if (cwd) process.chdir(cwd);
  cwd = '';
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

/** A fresh working directory; `main` reads relative to it. */
function workspace(): string {
  const d = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'batgirl-cli-')),
  );
  dirs.push(d);
  cwd = process.cwd();
  process.chdir(d);
  return d;
}

function put(root: string, rel: string, body: unknown): string {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(
    f,
    typeof body === 'string' ? body : JSON.stringify(body, null, 2),
  );
  return f;
}

function run(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation(
    (...a: unknown[]) => void out.push(a.join(' ')),
  );
  vi.spyOn(console, 'error').mockImplementation(
    (...a: unknown[]) => void err.push(a.join(' ')),
  );
  const code = main(argv);
  vi.restoreAllMocks();
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

const ledger = {
  schema_version: 2,
  entries: [
    { test: 't1', file: 'a', cause: '', author: 'Synthetic Author Zed' },
    { test: 't2', file: 'a', cause: 'flaky', author: 'Synthetic Author Zed' },
  ],
};

const historyLine = (sha: string, failed: number) =>
  JSON.stringify({
    schema_version: 3,
    branch: 'main',
    commit_sha: sha,
    total: 3,
    passed: 3 - failed,
    failed,
  });

describe('abstention', () => {
  it('exits 3 and prints every dimension as not assessed, with no value', () => {
    workspace();
    const r = run([]);
    expect(r.code).toBe(3);
    expect(r.stdout).toContain('0 assessed');
    expect(r.stdout).toContain('Abstained: no dimension had backing data');
    expect(r.stdout.match(/\| not assessed \|/g)).toHaveLength(6);
    expect(r.stdout).not.toMatch(/\d+\.\d%/);
  });

  it('gives each JSON dimension a null value', () => {
    workspace();
    const r = run(['--json']);
    expect(r.code).toBe(3);
    const doc = JSON.parse(r.stdout);
    expect(doc.abstained).toBe(true);
    expect(doc.assessed).toBe(0);
    for (const d of doc.dimensions) {
      expect(d.status).toBe('not-assessed');
      expect(d.value).toBeNull();
      expect(d.reason).toBeTruthy();
    }
  });
});

describe('default paths', () => {
  it('reads the conventional locations without flags', () => {
    const root = workspace();
    put(root, '.canary/quarantine.json', ledger);
    put(
      root,
      'test-results/reports/history-v2.jsonl',
      [historyLine('a', 0), historyLine('b', 1)].join('\n'),
    );
    const r = run(['--json']);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    const by = Object.fromEntries(
      doc.dimensions.map((d: { id: string }) => [d.id, d]),
    );
    expect(by['unexplained-switch-offs'].value).toBe(1);
    expect(by['red-mainline-commits'].value).toBe(1);
    expect(by['escaped-defects'].reason).toBe(
      'nothing at .canary/escapes.json',
    );
    expect(by['closure-exercise'].reason).toBe(
      'no batwoman report named (--batwoman PATH)',
    );
    expect(doc.assessed).toBe(2);
  });
});

describe('Markdown', () => {
  it('opens on the sweep line, states the team-only rule, and closes on the gaps', () => {
    const root = workspace();
    put(root, '.canary/quarantine.json', ledger);
    put(root, 'esc.json', {
      schema_version: 1,
      tracked_since: '2026-07-01',
      escapes: [{ id: 'E1' }],
      caught: [{ id: 'C1' }, { id: 'C2' }, { id: 'C3' }],
    });
    const r = run(['--escapes', 'esc.json']);
    expect(r.code).toBe(0);
    const lines = r.stdout.split('\n');
    expect(lines[0]).toBe('# canary-batgirl: team quality scorecard');
    expect(r.stdout).toContain(
      'SWEEP: team scorecard \u00b7 6 dimensions \u00b7 2 assessed',
    );
    expect(r.stdout).toContain('no per-person score');
    expect(r.stdout).toContain('No composite');
    expect(r.stdout).toContain('| Escaped-defect ratio | 25.0% | lower |');
    expect(r.stdout).toContain('| Unexplained switch-offs | 1 | lower |');
    expect(lines.at(-1)).toBe(
      'Gaps: 4 (coverage-verified-share, closure-exercise, vacuous-tests, red-mainline-commits). Closing.',
    );
  });
});

describe('I/O and usage', () => {
  it('exits 1 naming a named input that does not exist', () => {
    workspace();
    const r = run(['--ledger', 'missing.json']);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(
      'canary-batgirl: --ledger missing.json: no such file',
    );
    expect(r.stdout).toBe('');
  });

  it('exits 1 for a named input outside the working directory', () => {
    workspace();
    const r = run(['--escapes', '../elsewhere.json']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('outside the working directory');
  });

  it('reports a named input that does not parse as not assessed, exit 0 or 3', () => {
    const root = workspace();
    put(root, 'bad.json', '{nope');
    const r = run(['--cassandra', 'bad.json', '--json']);
    expect(r.code).toBe(3);
    const vac = JSON.parse(r.stdout).dimensions.find(
      (d: { id: string }) => d.id === 'vacuous-tests',
    );
    expect(vac.reason).toMatch(/^not valid JSON: SyntaxError/);
  });

  it('writes --out, creating parent directories', () => {
    const root = workspace();
    put(root, '.canary/quarantine.json', ledger);
    const r = run(['--out', 'reports/deep/card.md']);
    expect(r.code).toBe(0);
    expect(
      fs.readFileSync(path.join(root, 'reports/deep/card.md'), 'utf8'),
    ).toBe(`${r.stdout}\n`);
  });

  it('exits 1 with cannot write artifact when --out cannot be written', () => {
    const root = workspace();
    put(root, '.canary/quarantine.json', ledger);
    put(root, 'blocker', 'a file, not a directory');
    const r = run(['--out', 'blocker/card.md']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^canary-batgirl: cannot write artifact: /);
  });

  it('honours --branch', () => {
    const root = workspace();
    put(
      root,
      'h.jsonl',
      JSON.stringify({ branch: 'trunk', commit_sha: 'a', failed: 2 }),
    );
    const r = run(['--history', 'h.jsonl', '--branch', 'trunk', '--json']);
    const red = JSON.parse(r.stdout).dimensions.find(
      (d: { id: string }) => d.id === 'red-mainline-commits',
    );
    expect(red.value).toBe(1);
    expect(red.basis).toBe(
      '1 of 1 commit on trunk had a run with a failing test',
    );
  });

  it('prints usage for --help and rejects a positional argument', () => {
    workspace();
    const help = run(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toMatch(/^usage: canary-batgirl/);
    const extra = run(['stray']);
    expect(extra.code).toBe(2);
    expect(extra.stderr).toMatch(/^canary-batgirl: error: /);
  });
});
