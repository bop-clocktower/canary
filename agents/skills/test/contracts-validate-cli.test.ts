/**
 * CLI contract for lib/contracts/validate.mjs (#1151). site-deploy.yml
 * (phase 5) refuses on any non-zero exit, so the exit codes ARE the
 * interface: 0 valid, 1 refused (incl. unparseable), 2 usage/unreadable.
 * In-process calls carry coverage; three spawnSync cases prove the real
 * entry point (main guard, stdin, exitCode) with a child-level timeout.
 */
import { spawnSync } from 'node:child_process';
// validate.mjs imports its console from node:console (a vendored copy must
// lint clean with no globals declared). Vitest swaps the GLOBAL console for its
// own, so spying on that would miss every line; spy on the one it imports.
import nodeConsole from 'node:console';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, it, expect, vi } from 'vitest';

import { main } from '../lib/contracts/validate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'lib', 'contracts', 'validate.mjs');
const RUN = path.join(HERE, 'fixtures', 'contracts', 'run.valid.json');
const SITE = path.join(HERE, 'fixtures', 'contracts', 'site.valid.json');
const ASSESSMENT = path.join(
  HERE,
  'fixtures',
  'contracts',
  'assessment.valid.json',
);

afterEach(() => vi.restoreAllMocks());

function call(argv: string[], stdin = '') {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(nodeConsole, 'log').mockImplementation(
    (...a: unknown[]) => void out.push(a.join(' ')),
  );
  vi.spyOn(nodeConsole, 'error').mockImplementation(
    (...a: unknown[]) => void err.push(a.join(' ')),
  );
  const code = main(argv, { readStdin: () => stdin });
  vi.restoreAllMocks();
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

describe('validate.mjs CLI (in-process)', () => {
  it('exits 0 on a valid file and reports its denominator', () => {
    const r = call([RUN]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('valid canary.run/1: 1 record checked, 0 errors');
  });

  it("counts a site feed's flaky and register rows (#1154 S8)", () => {
    expect(call([SITE]).stdout).toBe(
      'valid canary.site/1: 6 records checked, 0 errors',
    );
  });

  it('strips a leading BOM from a file and from stdin (#1154 S7)', () => {
    const text = '\uFEFF' + fs.readFileSync(RUN, 'utf8');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-bom-'));
    const file = path.join(dir, 'run.bom.json');
    fs.writeFileSync(file, text, 'utf8');
    try {
      expect(call([file]).code).toBe(0);
      expect(call(['-'], text).code).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 1 on a refused document and prints each path', () => {
    const r = call(['--layer', 'run', ASSESSMENT]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^contract: expected canary\.run\/1/m);
    expect(r.stderr).toMatch(/refused: 1 error/);
  });

  it('reads stdin for "-" and for no file argument', () => {
    expect(call(['-'], '{').code).toBe(1);
    expect(call([], '{').code).toBe(1);
  });

  it('criterion 18: unparseable and empty stdin exit 1, never 0', () => {
    for (const text of ['{', '', 'not json']) {
      const r = call(['-'], text);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/^\$: not parseable JSON/m);
    }
  });

  it('--json prints {valid, contract, checked, errors} on stdout', () => {
    const r = call(['--json', '-'], '{');
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({
      valid: false,
      contract: null,
      checked: 0,
      errors: [
        { path: '$', message: expect.stringMatching(/^not parseable JSON/) },
      ],
    });
  });

  it('exits 2 on an unknown --layer, an unknown flag, two files, or an unreadable file', () => {
    expect(call(['--layer', 'signal', RUN]).code).toBe(2);
    expect(call(['--strict', RUN]).code).toBe(2);
    expect(call([RUN, RUN]).code).toBe(2);
    const missing = call([path.join(HERE, 'no-such-file.json')]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toMatch(
      /^canary-contracts-validate: error: cannot read/,
    );
  });

  it('exits 2, not a crash, when stdin cannot be read (fork M)', () => {
    const err: string[] = [];
    vi.spyOn(nodeConsole, 'error').mockImplementation(
      (...a: unknown[]) => void err.push(a.join(' ')),
    );
    const unreadable = () => {
      throw Object.assign(new Error('illegal operation on a directory'), {
        code: 'EISDIR',
      });
    };
    expect(main(['-'], { readStdin: unreadable })).toBe(2);
    expect(main([], { readStdin: unreadable })).toBe(2);
    expect(err[0]).toBe(
      'canary-contracts-validate: error: cannot read stdin: EISDIR',
    );
  });

  it('--help exits 0 and documents the exit codes', () => {
    const r = call(['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^usage: canary-contracts-validate/);
    expect(r.stdout).toMatch(/0 valid/);
  });
});

describe('validate.mjs CLI (real process)', () => {
  const run = (args: string[], input?: string) =>
    spawnSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      input,
      timeout: 20_000,
    });

  it('exits 0 on a valid file', () => {
    expect(run([RUN]).status).toBe(0);
  });

  it('exits 1 on unparseable stdin (criterion 18, end to end)', () => {
    const r = run(['-'], '{');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not parseable JSON/);
  });

  it('exits 2 on a usage error', () => {
    expect(run(['--layer']).status).toBe(2);
  });

  it('exits 0 on BOM-prefixed stdin (#1154 S7, end to end)', () => {
    const text = '\uFEFF' + fs.readFileSync(RUN, 'utf8');
    expect(run(['-'], text).status).toBe(0);
  });
});

// #1234: validate.mjs was the one entry point #1182 missed. Its own guard
// compared import.meta.url (always the resolved real path) with
// pathToFileURL(argv[1]) (the path as typed), so through any symlink main()
// never ran: nothing printed, exit 0, and site-deploy.yml read that as a valid
// feed. Every case feeds an INVALID document, so a silent skip reads as a
// failure (0, not 1) instead of a pass.
describe('validate.mjs CLI reached through a symlink (#1234)', () => {
  const LIB = path.join(HERE, '..', 'lib');
  const INVALID = ['--layer', 'run', ASSESSMENT];
  const tmp: string[] = [];
  const mkTmp = (root = os.tmpdir()) => {
    const d = fs.mkdtempSync(path.join(root, 'canary-validate-link-'));
    tmp.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of tmp.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  const spawn = (cli: string, args: string[], input?: string) =>
    spawnSync(process.execPath, [cli, ...args], {
      encoding: 'utf8',
      input,
      timeout: 20_000,
    });

  const expectRefused = (r: ReturnType<typeof spawn>, label: string) => {
    expect(r.status, `${label}: ${r.stderr}`).toBe(1);
    expect(r.stderr, `${label} printed nothing`).toMatch(/^refused: /m);
  };

  it('refuses an invalid file via a symlinked dir whose path has a space', () => {
    const link = path.join(mkTmp(), 'with space');
    fs.symlinkSync(LIB, link, 'dir');
    const cli = path.join(link, 'contracts', 'validate.mjs');
    expectRefused(spawn(cli, INVALID), 'symlinked dir');
  });

  it('refuses an invalid file via a symlink to the file itself', () => {
    const cli = path.join(mkTmp(), 'validate.mjs');
    fs.symlinkSync(CLI, cli, 'file');
    expectRefused(spawn(cli, INVALID), 'file symlink');
  });

  it('refuses an invalid file via an aliased ancestor (/tmp -> /private/tmp)', () => {
    // macOS: /tmp is itself a symlink to /private/tmp, so a lib copied under
    // /tmp and run by its /tmp path is the alias case as users hit it. Where
    // /tmp is a real directory (Linux), build the same shape: run through a
    // symlink that stands in for the aliased ancestor.
    let root: string;
    if (fs.realpathSync('/tmp') !== '/tmp') {
      root = mkTmp('/tmp');
    } else {
      root = path.join(mkTmp(), 'tmp');
      fs.symlinkSync(mkTmp(), root, 'dir');
    }
    expect(fs.realpathSync(root)).not.toBe(root);
    fs.cpSync(LIB, path.join(root, 'lib'), { recursive: true });
    const cli = path.join(root, 'lib', 'contracts', 'validate.mjs');
    expectRefused(spawn(cli, INVALID), 'aliased ancestor');
  });

  it('refuses an invalid document on stdin via a symlink', () => {
    const cli = path.join(mkTmp(), 'validate.mjs');
    fs.symlinkSync(CLI, cli, 'file');
    const r = spawn(
      cli,
      ['--layer', 'run', '-'],
      fs.readFileSync(ASSESSMENT, 'utf8'),
    );
    expectRefused(r, 'stdin via symlink');
  });
});
