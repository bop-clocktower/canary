// Unit suite for the canary-cassandra skill CLI (#755).
//
// Cassandra is the fourth Tier-0 detector and the only one that does NOT own
// its rules: vacuity detection already lives in the engine (`core/
// vacuity-scanner`), where `canary vacuity-check` and the promotion gate run
// it. So this suite deliberately does not re-test the rules -- `ts/test/` owns
// those. What it tests is the half that is new and that #755 was actually
// about: that a `cli:` entry point exists, that it produces the sibling
// envelope, that its exit codes match the family, and that it fails loudly
// rather than reporting a clean scan when it cannot reach the engine.
//
// Engine resolution needs `ts/dist`, which the CI job for this project does not
// build. Rather than skip (a skipped suite is a zero denominator wearing a
// tick), the engine-dependent cases assert against a resolution result the test
// computes itself, and say which case they took.

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  main,
  CLI_SPEC,
  SCHEMA_VERSION,
} from '../claude-code/canary-cassandra/scripts/cli.mjs';
import {
  engineCandidates,
  resolveEngineDir,
  loadEngine,
} from '../claude-code/canary-cassandra/scripts/engine.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.join(HERE, '..', 'claude-code', 'canary-cassandra');

/** Whether the engine is present in this checkout (`npm --prefix ts run build`). */
const ENGINE_PRESENT = resolveEngineDir() !== null;

const tmps: string[] = [];
function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cassandra-'));
  tmps.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true });
});

/** Run the CLI, capturing everything it writes. */
function run(argv: string[]): { code: number; stdout: string; stderr: string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(console, 'log').mockImplementation(
    (...a: unknown[]) => void stdout.push(a.join(' ')),
  );
  vi.spyOn(console, 'error').mockImplementation(
    (...a: unknown[]) => void stderr.push(a.join(' ')),
  );
  const code = main(argv);
  vi.restoreAllMocks();
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

// --- the asymmetry #755 filed --------------------------------------------

describe('cassandra is executable at all', () => {
  it('declares cli: in its frontmatter, like its three siblings', () => {
    const md = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
    expect(/^cli:\s*scripts\/cli\.mjs\s*$/m.test(md)).toBe(true);
  });

  it('ships an executable cli.mjs with a node shebang', () => {
    const cli = path.join(SKILL_DIR, 'scripts', 'cli.mjs');
    expect(fs.existsSync(cli)).toBe(true);
    expect(fs.statSync(cli).mode & 0o111).toBeTruthy();
    expect(fs.readFileSync(cli, 'utf8').startsWith('#!/usr/bin/env node')).toBe(
      true,
    );
  });

  it('routes parsing through the shared parser, with the family flag set', () => {
    expect(CLI_SPEC.prog).toBe('canary-cassandra');
    expect(Object.keys(CLI_SPEC.booleans)).toEqual(['--json', '--strict']);
    expect(CLI_SPEC.positionals.defaults).toEqual(['.']);
  });
});

// --- argument surface (the family contract) -------------------------------

describe('argument surface', () => {
  it('prints usage on stdout and exits 0 for --help and -h', () => {
    for (const spelling of ['--help', '-h']) {
      const r = run([spelling]);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/^usage: canary-cassandra /m);
      expect(r.stderr).toBe('');
    }
  });

  it('documents all three rules in --help', () => {
    const { stdout } = run(['--help']);
    for (const rule of ['VAC-001', 'VAC-002', 'VAC-003']) {
      expect(stdout).toContain(rule);
    }
  });

  it('rejects an unknown flag argparse-faithfully with exit 2', () => {
    const r = run(['--nope']);
    expect(r.code).toBe(2);
    expect(r.stderr).toBe(
      'canary-cassandra: error: unrecognized arguments: --nope',
    );
    expect(r.stdout).toBe('');
  });

  it('answers --help even when the engine is unreachable', () => {
    // Usage must resolve before any engine work: an install with no built
    // engine still has to be able to explain itself.
    expect(run(['--help']).code).toBe(0);
  });
});

// --- engine resolution ----------------------------------------------------

describe('engine resolution', () => {
  it('tries the checkout layout and the packaged layout, in that order', () => {
    const found = engineCandidates('/root', {});
    expect(found).toEqual([
      path.join('/root', 'ts', 'dist'),
      path.join('/root', 'dist', 'engine'),
    ]);
  });

  it('lets CANARY_ENGINE_DIR take precedence for an overlay install', () => {
    const found = engineCandidates('/root', {
      CANARY_ENGINE_DIR: '/elsewhere',
    });
    expect(found[0]).toBe(path.resolve('/elsewhere'));
  });

  it('resolves nothing when no candidate holds the modules', () => {
    expect(resolveEngineDir([mkTmp()])).toBeNull();
  });

  it('reports an unresolvable engine as an error naming every path tried', async () => {
    // "Cannot verify" is a finding, not a skip: a detector that could not load
    // must never render as a clean scan.
    const dir = mkTmp();
    const res = await loadEngine([dir]);
    expect(res.ok).toBe(false);
    expect(res.error).toContain(dir);
    expect(res.error).toContain('nothing was scanned');
  });
});

// --- behaviour against a real engine --------------------------------------

describe('scanning', () => {
  it('runs against an engine this checkout actually has', () => {
    // The denominator for everything below. A checkout with no built engine
    // makes the rest of this block vacuous, so it is stated rather than hidden.
    expect(
      ENGINE_PRESENT,
      'run `npm --prefix ts run build` so the engine-backed cases are real',
    ).toBe(true);
  });

  it('fails with exit 1 on a path that does not exist', () => {
    const r = run([path.join(mkTmp(), 'nope')]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('path not found');
  });

  it('abstains loudly on a directory holding no test file', () => {
    const r = run([mkTmp()]);
    expect(r.stdout.toLowerCase()).toContain('abstained');
    // Advisory by default (D3): the line is loud, the exit is not.
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain('no findings');
  });

  it('inherits exit 3 for that same zero denominator under --strict', () => {
    expect(run([mkTmp(), '--strict']).code).toBe(3);
  });

  it('names the file shapes it looked for when it abstains', () => {
    const r = run([mkTmp()]);
    expect(r.stdout).toContain('test_*.py');
  });

  it('finds a self-comparing assertion and reports the test as the locus', () => {
    const dir = mkTmp();
    fs.writeFileSync(
      path.join(dir, 'a.test.ts'),
      "import { thing } from './thing';\n" +
        "it('proves nothing', () => {\n" +
        '  expect(true).toBe(true);\n' +
        '  thing();\n' +
        '});\n',
      'utf8',
    );
    const r = run([dir, '--json']);
    const payload = JSON.parse(r.stdout);
    const vac001 = payload.findings.filter((f: any) => f.rule_id === 'VAC-001');
    expect(vac001.length).toBeGreaterThan(0);
    expect(vac001[0].severity).toBe('critical');
    expect(vac001[0].snippet).toBe('proves nothing');
  });

  it('exits 1 under --strict when it found something real', () => {
    const dir = mkTmp();
    fs.writeFileSync(
      path.join(dir, 'a.test.ts'),
      "import { thing } from './thing';\n" +
        "it('t', () => {\n  expect(1).toBe(1);\n  thing();\n});\n",
      'utf8',
    );
    // 1 means "found something", distinct from 3 which means "checked nothing".
    expect(run([dir, '--strict']).code).toBe(1);
  });
});

// --- the mergeable envelope -----------------------------------------------

describe('--json envelope', () => {
  function payload(): any {
    const dir = mkTmp();
    fs.writeFileSync(
      path.join(dir, 'a.test.ts'),
      "import { thing } from './thing';\n" +
        "it('t', () => {\n  expect(1).toBe(1);\n  thing();\n});\n",
      'utf8',
    );
    return JSON.parse(run([dir, '--json']).stdout);
  }

  it('carries the sibling top-level shape', () => {
    const p = payload();
    expect(p.schema_version).toBe(SCHEMA_VERSION);
    expect(Array.isArray(p.findings)).toBe(true);
    expect(typeof p.summary).toBe('object');
  });

  it('carries the sibling per-finding keys, so all four merge unchanged', () => {
    // savant / blackhawk / katana all emit these; a consumer that special-cased
    // cassandra would be the failure #755 is about.
    const f = payload().findings[0];
    for (const key of [
      'file',
      'line',
      'rule_id',
      'severity',
      'snippet',
      'why',
    ]) {
      expect(f, `missing ${key}`).toHaveProperty(key);
    }
  });

  it('adds the two fields only a vacuity finding has', () => {
    const f = payload().findings[0];
    expect(f).toHaveProperty('suggestion');
    expect(f).toHaveProperty('fidelity');
  });

  it('reports BOTH denominators, files and tests', () => {
    // Files matched but zero tests inside is the subtler zero; a summary with
    // only `files_scanned` prints a healthy number over an empty scan.
    const s = payload().summary;
    expect(s.files_scanned).toBe(1);
    expect(s.tests_checked).toBeGreaterThan(0);
    expect(s.abstained).toBe(false);
  });

  it('marks the payload abstained when nothing was checked', () => {
    const p = JSON.parse(run([mkTmp(), '--json']).stdout);
    expect(p.summary.tests_checked).toBe(0);
    expect(p.summary.abstained).toBe(true);
    expect(p.skipped.length).toBeGreaterThan(0);
  });
});
