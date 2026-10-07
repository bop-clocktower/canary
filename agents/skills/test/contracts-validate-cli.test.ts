/**
 * CLI contract for lib/contracts/validate.mjs (#1151). site-deploy.yml
 * (phase 5) refuses on any non-zero exit, so the exit codes ARE the
 * interface: 0 valid, 1 refused (incl. unparseable), 2 usage/unreadable.
 * In-process calls carry coverage; three spawnSync cases prove the real
 * entry point (main guard, stdin, exitCode) with a child-level timeout.
 */
import { spawnSync } from 'node:child_process';
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
  vi.spyOn(console, 'log').mockImplementation(
    (...a: unknown[]) => void out.push(a.join(' ')),
  );
  vi.spyOn(console, 'error').mockImplementation(
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
    vi.spyOn(console, 'error').mockImplementation(
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
});
