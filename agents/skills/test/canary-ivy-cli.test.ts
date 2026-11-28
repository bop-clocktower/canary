/**
 * canary-ivy (#615) -- the CLI end to end: the planted ADR 0039 invariant
 * (SC1), exit codes (SC4, SC5), --out, and hostile input (SC10). Suites,
 * coverage and stores are synthetic and written to temp directories.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CLI_SPEC, main } from '../claude-code/canary-ivy/scripts/cli.mjs';
import { CAVEAT } from '../claude-code/canary-ivy/scripts/coverage.mjs';
import { ABSTAINED_LINE } from '../claude-code/canary-ivy/scripts/render.mjs';

const CLI = fileURLToPath(
  new URL('../claude-code/canary-ivy/scripts/cli.mjs', import.meta.url),
);

const ESC = String.fromCharCode(27);

/**
 * ADR 0039, Decision 2: no output may recommend that a test be deleted,
 * removed, pruned, dropped, skipped, quarantined or merged away, nor call it
 * redundant or removable. Stems, so every inflection is caught.
 */
const DELETION_VOCABULARY =
  /\b(delet|remov|prun|drop|skip|quarantin|merg|redundan|consolidat|unnecessar|obsolet|superfluous|unneeded|safe[\s_-]*to[\s_-]*(delete|remove))/i;

const tmps: string[] = [];
function tmp(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-ivy-cli-'));
  tmps.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true });
});

function run(argv: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    stdout.push(a.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    stderr.push(a.join(' '));
  });
  const code = main(argv);
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

/** Two tests, the same covered lines, different assertions. */
const PLANTED_TESTS = [
  'from cart import Cart',
  '',
  'def test_total_sums_items():',
  '    cart = Cart([5, 7])',
  '    assert cart.total() == 12',
  '',
  'def test_total_rounds_to_cents():',
  '    cart = Cart([0.105, 0.2])',
  '    assert cart.total() == 0.31',
].join('\n');

const PLANTED_COVERAGE = {
  schema_version: 1,
  tests: {
    'tests/test_cart.py::test_total_sums_items': {
      'src/cart.py': [3, 4, 5, 9],
    },
    'tests/test_cart.py::test_total_rounds_to_cents': {
      'src/cart.py': [3, 4, 5, 9],
    },
    'tests/test_cart.py::test_other': { 'src/cart.py': [3] },
  },
};

const emptyStore = (dir: string) => {
  const file = path.join(dir, 'history-v2.jsonl');
  fs.writeFileSync(file, '');
  return file;
};

function planted() {
  const dir = tmp({
    'tests/test_cart.py': PLANTED_TESTS,
    'cov.json': JSON.stringify(PLANTED_COVERAGE),
  });
  return { dir, cov: path.join(dir, 'cov.json'), store: emptyStore(dir) };
}

describe('SC1: the planted identical-coverage, different-assertion pair', () => {
  it('is reported as an overlap and recommended for nothing', () => {
    const { dir, cov, store } = planted();
    const markdown = run([dir, '--coverage', cov, '--history', store]);
    const json = run([dir, '--coverage', cov, '--history', store, '--json']);
    expect(markdown.code).toBe(0);
    expect(json.code).toBe(0);

    const report = JSON.parse(json.stdout);
    expect(report.sections.coverage.groups).toEqual([
      {
        tests: [
          'tests/test_cart.py::test_total_rounds_to_cents',
          'tests/test_cart.py::test_total_sums_items',
        ],
        line_count: 4,
        shared_lines: [{ file: 'src/cart.py', ranges: '3-5,9' }],
        caveat: CAVEAT,
      },
    ]);
    expect(markdown.stdout).toContain(
      'tests/test\\_cart.py::test\\_total\\_sums\\_items',
    );
    expect(markdown.stdout).toContain(CAVEAT);

    for (const out of [markdown, json]) {
      expect(out.stdout + out.stderr).not.toMatch(DELETION_VOCABULARY);
    }
  });

  it('the denylist itself bites on the words it guards', () => {
    for (const phrase of [
      'delete this test',
      'safe to remove',
      'prune the suite',
      'Dropped',
      'skip it',
      'quarantine',
      'merge these tests',
      'redundant',
      'safe_to_delete',
    ]) {
      expect(phrase).toMatch(DELETION_VOCABULARY);
    }
  });

  it('no message the CLI can emit uses the deletion vocabulary', () => {
    const dir = tmp();
    const outputs = [
      run(['--help']),
      run([dir, '--history', emptyStore(dir)]),
      run([dir, '--history', path.join(dir, 'missing.jsonl')]),
      run([dir, '--coverage', path.join(dir, 'missing.json')]),
      run([dir, '--bogus']),
      run([dir, '--history', emptyStore(dir), '--out', dir]),
    ];
    for (const out of outputs) {
      expect(out.stdout + out.stderr).not.toMatch(DELETION_VOCABULARY);
    }
  });
});

describe('exit codes', () => {
  it('SC4: abstains with 3 when no section has input, and says so', () => {
    const dir = tmp();
    const out = run([dir, '--history', emptyStore(dir)]);
    expect(out.code).toBe(3);
    expect(out.stdout).toContain(ABSTAINED_LINE);
    expect(out.stdout).not.toContain('no setup body repeats');
    const asJson = run([dir, '--history', emptyStore(dir), '--json']);
    expect(asJson.code).toBe(3);
    expect(JSON.parse(asJson.stdout).abstained).toBe(true);
  });

  it('SC4: exits 0 when a section is assessed, findings or not', () => {
    const { dir, cov, store } = planted();
    expect(run([dir, '--history', store]).code).toBe(0); // fixtures only
    expect(run([dir, '--coverage', cov, '--history', store]).code).toBe(0);
  });

  it('SC5: a named input that cannot be read exits 1 with a cleaned message', () => {
    const dir = tmp();
    const hist = run([dir, '--history', path.join(dir, 'nope.jsonl')]);
    expect(hist.code).toBe(1);
    expect(hist.stderr).toMatch(/^canary-ivy: history store not found: /);
    const cov = run([dir, '--coverage', path.join(dir, 'nope.json')]);
    expect(cov.code).toBe(1);
    expect(cov.stderr).toMatch(/^canary-ivy: coverage file not found: /);
    const p = run([path.join(dir, 'no-such-dir')]);
    expect(p.code).toBe(1);
    expect(p.stderr).toMatch(/^canary-ivy: path not found: /);
  });

  it('SC5: a usage error exits 2', () => {
    const out = run(['--bogus']);
    expect(out.code).toBe(2);
    expect(out.stderr).toBe(
      'canary-ivy: error: unrecognized arguments: --bogus',
    );
    expect(run(['--coverage']).code).toBe(2);
  });

  it('prints usage with --help and exits 0', () => {
    const out = run(['--help']);
    expect(out.code).toBe(0);
    expect(out.stdout).toMatch(/^usage: canary-ivy/);
    expect(CLI_SPEC.prog).toBe('canary-ivy');
  });
});

describe('--out', () => {
  it('writes the printed report, creating parent directories', () => {
    const { dir, cov, store } = planted();
    const target = path.join(dir, 'deep', 'er', 'ivy.md');
    const out = run([
      dir,
      '--coverage',
      cov,
      '--history',
      store,
      '--out',
      target,
    ]);
    expect(out.code).toBe(0);
    expect(fs.readFileSync(target, 'utf8')).toBe(out.stdout);
  });

  it('fails cleanly with "cannot write artifact" and exit 1', () => {
    const { dir, store } = planted();
    const asDir = run([dir, '--history', store, '--out', dir]);
    expect(asDir.code).toBe(1);
    expect(asDir.stderr).toMatch(/^canary-ivy: cannot write artifact: /);
    const underFile = run([
      dir,
      '--history',
      store,
      '--out',
      path.join(dir, 'tests', 'test_cart.py', 'x.md'),
    ]);
    expect(underFile.code).toBe(1);
    expect(underFile.stderr).toMatch(/^canary-ivy: cannot write artifact: /);
  });
});

describe('SC10: hostile input is cleaned on every surface', () => {
  const evil =
    `x\n# Forged heading\r\n${ESC}[2J${ESC}]8;;http://e${String.fromCharCode(7)}[click](http://e)|cell|\u202e` +
    'z'.repeat(10000);

  function hostile() {
    const fixture = [
      'import pytest',
      '@pytest.fixture',
      'def db():',
      `    a = "${evil.replace(/\n|\r/g, ' ')}"`,
      '    b = 2',
    ].join('\n');
    const runs = [800, 800, 800, 2400, 2400, 2400].map((ms, i) => ({
      schema_version: 3,
      run_id: `${evil}${i}`,
      commit_sha: `${ESC}[31m${evil}`,
      timestamp: `2026-01-0${i + 1}T00:00:00Z`,
      tests: [
        { test_file: `${evil}.spec.ts`, test_name: evil, duration_ms: ms },
      ],
    }));
    const dir = tmp({
      'a/conftest.py': fixture,
      'b/conftest.py': fixture,
      'cov.json': JSON.stringify({
        schema_version: 1,
        tests: { [`${evil}1`]: { [evil]: [1] }, [`${evil}2`]: { [evil]: [1] } },
      }),
      'h.jsonl': runs.map((r) => JSON.stringify(r)).join('\n'),
    });
    return [
      dir,
      '--coverage',
      path.join(dir, 'cov.json'),
      '--history',
      path.join(dir, 'h.jsonl'),
    ];
  }

  it('Markdown: one line per value, no escape byte, links and cells escaped, clamped', () => {
    const out = run(hostile());
    expect(out.code).toBe(0);
    expect(out.stdout).not.toContain(ESC);
    expect(out.stdout).not.toContain('\u202e');
    expect(out.stdout).not.toMatch(/^# Forged/m);
    expect(out.stdout).not.toContain('[click](http://e)');
    expect(out.stdout).toContain('\\[click\\]\\(http://e\\)\\|cell\\|');
    for (const line of out.stdout.split('\n'))
      expect(line.length).toBeLessThan(2000);
  });

  it('JSON: values are single-line, escape-free and clamped', () => {
    const out = run([...hostile(), '--json']);
    const report = JSON.parse(out.stdout);
    const strings: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === 'string') strings.push(v);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(report);
    expect(report.sections.runtime.creep.length).toBeGreaterThan(0);
    expect(report.sections.coverage.groups).toHaveLength(1);
    expect(report.sections.fixtures.groups).toHaveLength(1);
    for (const s of strings) {
      expect(s).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202e]/);
      expect([...s].length).toBeLessThanOrEqual(400);
    }
  });

  it('stderr: a hostile path in an error message is cleaned and clamped', () => {
    const dir = tmp();
    const out = run([
      dir,
      '--coverage',
      path.join(dir, `${ESC}[31m\nforged` + 'q'.repeat(5000)),
    ]);
    expect(out.code).toBe(1);
    expect(out.stderr).not.toContain(ESC);
    expect(out.stderr).not.toContain('\n');
    expect(out.stderr.length).toBeLessThanOrEqual(420);
  });
});

describe('as a process', () => {
  it('marks a missing default store dark and abstains with 3', () => {
    const dir = tmp();
    const res = spawnSync(process.execPath, [CLI, '.'], {
      cwd: dir,
      encoding: 'utf8',
    });
    expect(res.status).toBe(3);
    expect(res.stdout).toContain(
      'not assessed: no history store at test-results/reports/history-v2.jsonl',
    );
  });

  it('reads the default store when it exists', () => {
    const store = [800, 800, 800, 2400, 2400, 2400]
      .map((ms, i) =>
        JSON.stringify({
          timestamp: `2026-01-0${i + 1}T00:00:00Z`,
          tests: [{ test_file: 'a.spec.ts', test_name: 'a', duration_ms: ms }],
        }),
      )
      .join('\n');
    const dir = tmp({ 'test-results/reports/history-v2.jsonl': store });
    const res = spawnSync(process.execPath, [CLI, '--json', '.'], {
      cwd: dir,
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout).sections.runtime.creep).toHaveLength(2);
  });
});
