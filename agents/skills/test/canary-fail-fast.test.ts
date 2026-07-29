// Unit suite for the canary-fail-fast skill, ported from Python to vitest as the
// skill moves to JS (canary mirrors harness, which is TS/Node). Behavior is
// preserved from the Python version: same Playwright-JSON parsing, same failure
// categorization, same digest text, same ::error annotations, same exit codes.
//
// canary-fail-fast surfaces test failures fast (audit a config for fail-fast
// knobs) and loud (a categorized run-end digest + ::error annotations, exit 1).

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  parseFailures,
  Failure,
} from '../claude-code/canary-fail-fast/scripts/parse.mjs';
import { categorizeFailure } from '../claude-code/canary-fail-fast/scripts/failures.mjs';
import { checkConfig } from '../claude-code/canary-fail-fast/scripts/fastfail_check.mjs';
import { buildDigest } from '../claude-code/canary-fail-fast/scripts/digest.mjs';
import { main } from '../claude-code/canary-fail-fast/scripts/cli.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.join(HERE, '..', 'claude-code', 'canary-fail-fast');
const SCRIPTS = path.join(SKILL_DIR, 'scripts');

const tmps: string[] = [];
const mkTmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'failfast-'));
  tmps.push(d);
  return d;
};
afterEach(() => {
  vi.restoreAllMocks();
  while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const writeResults = (tmp: string, data: any): string => {
  const p = path.join(tmp, 'results.json');
  fs.writeFileSync(p, JSON.stringify(data));
  return p;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const spec = (title: string, tests: any[]) => ({
  title,
  location: { file: 'a.spec.ts', line: 7 },
  tests,
});

const captureLog = () => {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((s?: unknown) => {
    out.push(String(s));
  });
  vi.spyOn(console, 'error').mockImplementation((s?: unknown) => {
    err.push(String(s));
  });
  return { out, err };
};

// --- parse -----------------------------------------------------------------

describe('parse', () => {
  it('missing file returns empty', () => {
    expect(parseFailures(path.join(mkTmp(), 'nope.json'))).toEqual([]);
  });

  it('malformed json throws', () => {
    const p = path.join(mkTmp(), 'bad.json');
    fs.writeFileSync(p, 'not json');
    expect(() => parseFailures(p)).toThrow(/not valid JSON/);
  });

  it('non-object top level throws', () => {
    expect(() => parseFailures(writeResults(mkTmp(), [1, 2, 3]))).toThrow(
      /top-level value must be an object/,
    );
  });

  it('extracts a failure with location and error', () => {
    const data = {
      suites: [
        {
          title: 'root',
          specs: [
            spec('logs in', [
              {
                title: 'logs in',
                status: 'unexpected',
                location: { file: 'login.spec.ts', line: 12 },
                results: [{ status: 'unexpected', error: { message: 'boom' } }],
              },
            ]),
          ],
        },
      ],
    };
    const result = parseFailures(writeResults(mkTmp(), data));
    expect(result.length).toBe(1);
    const f = result[0];
    expect(f.title).toBe('root > logs in > logs in');
    expect(f.file).toBe('login.spec.ts');
    expect(f.line).toBe(12);
    expect(f.error).toBe('boom');
  });

  it('excludes a flaky test (failed with a passing retry)', () => {
    const data = {
      suites: [
        {
          title: 'root',
          specs: [
            spec('flaky', [
              {
                title: 'flaky',
                status: 'failed',
                results: [
                  { status: 'failed', error: { message: 'x' } },
                  { status: 'passed' },
                ],
              },
            ]),
          ],
        },
      ],
    };
    expect(parseFailures(writeResults(mkTmp(), data))).toEqual([]);
  });

  it('falls back to the errors[] array for the message', () => {
    const data = {
      suites: [
        {
          title: 'r',
          specs: [
            spec('t', [
              {
                title: 't',
                status: 'failed',
                results: [
                  { status: 'failed', errors: [{ message: 'from-array' }] },
                ],
              },
            ]),
          ],
        },
      ],
    };
    expect(parseFailures(writeResults(mkTmp(), data))[0].error).toBe(
      'from-array',
    );
  });

  it('malformed structure (suites is a string) throws', () => {
    expect(() =>
      parseFailures(writeResults(mkTmp(), { suites: 'nope' })),
    ).toThrow(/unexpected structure/);
  });

  it('non-dict suite entry throws (not a raw type error)', () => {
    expect(() =>
      parseFailures(writeResults(mkTmp(), { suites: [123] })),
    ).toThrow(/unexpected structure/);
  });

  it('strips a leading non-JSON banner before parsing', () => {
    const p = path.join(mkTmp(), 'banner.json');
    fs.writeFileSync(
      p,
      'WARN: reporter banner line\n' + JSON.stringify({ suites: [] }),
    );
    expect(parseFailures(p)).toEqual([]);
  });

  it('skips non-failing tests and keeps the failure', () => {
    const data = {
      suites: [
        {
          title: 'root',
          specs: [
            spec('mixed', [
              {
                title: 'ok',
                status: 'expected',
                results: [{ status: 'expected' }],
              },
              {
                title: 'bad',
                status: 'failed',
                results: [{ status: 'failed', error: { message: 'kaboom' } }],
              },
            ]),
          ],
        },
      ],
    };
    const result = parseFailures(writeResults(mkTmp(), data));
    expect(result.map((f) => f.title)).toEqual(['root > mixed > bad']);
  });

  it('walks nested suites, inherits file, and falls back to the spec title', () => {
    const data = {
      suites: [
        {
          title: 'outer',
          file: 'suite.spec.ts',
          suites: [
            {
              title: 'inner',
              specs: [
                {
                  title: 'inherits',
                  // no spec location, no test title -> spec title + inherited file
                  tests: [
                    {
                      status: 'failed',
                      results: [
                        { status: 'failed', error: { message: 'nope' } },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const result = parseFailures(writeResults(mkTmp(), data));
    expect(result.length).toBe(1);
    const f = result[0];
    expect(f.title).toBe('outer > inner > inherits > inherits');
    expect(f.file).toBe('suite.spec.ts');
    expect(f.line).toBeNull();
  });
});

// --- categorize ------------------------------------------------------------

describe('categorizeFailure', () => {
  it('null / empty is other', () => {
    expect(categorizeFailure(null)).toBe('other');
    expect(categorizeFailure('')).toBe('other');
  });

  it.each([
    ['ZodError: invalid_type expected string', 'schema'],
    ['Request failed with status 401 Unauthorized', 'auth'],
    ['connect ECONNREFUSED 127.0.0.1:5432', 'network'],
    ['Timeout of 30000ms exceeded', 'timeout'],
    ['500 Internal Server Error', 'server'],
    ['404 Not Found', 'client'],
    ['something totally unrecognized', 'other'],
  ])('%s -> %s', (msg, cat) => {
    expect(categorizeFailure(msg)).toBe(cat);
  });

  it('schema beats a status code (rule order)', () => {
    expect(categorizeFailure('ZodError at path "x"; server returned 404')).toBe(
      'schema',
    );
  });
});

// --- fastfail config audit -------------------------------------------------

describe('checkConfig', () => {
  it('all knobs present -> empty', () => {
    expect(
      checkConfig('forbidOnly: true, maxFailures: 10, retries: 2'),
    ).toEqual([]);
  });

  it('one missing knob is flagged', () => {
    const recs = checkConfig('forbidOnly: true, maxFailures: 10'); // no retries
    expect(recs.length).toBe(1);
    expect(recs[0]).toContain('retries');
  });

  it('all missing -> three recommendations', () => {
    expect(checkConfig('').length).toBe(3);
  });
});

// --- digest ----------------------------------------------------------------

const fail = (
  title: string,
  error: string | null,
  file?: string,
  line?: number,
) =>
  Failure({
    title,
    status: 'failed',
    file: file ?? null,
    line: line ?? null,
    error,
  });

describe('buildDigest', () => {
  it('no failures exits zero with no annotations', () => {
    const d = buildDigest([]);
    expect(d.exitCode).toBe(0);
    expect(d.annotations).toEqual([]);
    expect(d.text).toContain('0 failing');
  });

  it('singular vs plural header', () => {
    expect(buildDigest([fail('t', 'boom')]).text).toContain('1 failing test ');
    expect(buildDigest([fail('a', 'x'), fail('b', 'y')]).text).toContain(
      '2 failing tests',
    );
  });

  it('groups by category and exits one', () => {
    const d = buildDigest([
      fail('t1', 'ZodError bad'),
      fail('t2', '401 Unauthorized'),
    ]);
    expect(d.exitCode).toBe(1);
    expect(d.text).toContain('schema (1):');
    expect(d.text).toContain('auth (1):');
  });

  it('annotation includes location', () => {
    const d = buildDigest([fail('logs in', 'boom', 'login.spec.ts', 12)]);
    expect(d.annotations[0]).toMatch(
      /^::error file=login\.spec\.ts,line=12,title=Test failure::/,
    );
    expect(d.annotations[0]).toContain('logs in');
  });

  it('annotation omits absent location', () => {
    const ann = buildDigest([fail('no-loc', 'boom')]).annotations[0];
    expect(ann).not.toContain('file=');
    expect(ann).not.toContain('line=');
    expect(ann.startsWith('::error title=Test failure::')).toBe(true);
  });

  it('renders a placeholder when the error is null or whitespace-only', () => {
    const d = buildDigest([
      fail('null-err', null),
      fail('blank-err', '   \n  '),
    ]);
    expect(d.text).toContain('(no error message)');
    // both land in the "other" bucket (categorizeFailure of a falsy/other msg)
    expect(d.text).toContain('other (2):');
    for (const ann of d.annotations)
      expect(ann).toContain('(no error message)');
  });

  it('takes the first non-empty line of a multi-line error, capped', () => {
    const long = 'x'.repeat(300);
    const d = buildDigest([fail('multi', `\n  first line  \nsecond\n${long}`)]);
    expect(d.text).toContain('- multi');
    expect(d.text).toContain('first line');
    // 160-char cap is applied to the chosen line
    expect(d.text).not.toContain(long);
  });
});

// --- cli -------------------------------------------------------------------

describe('cli', () => {
  it('no args returns 1', () => {
    const { err } = captureLog();
    expect(main([])).toBe(1);
    expect(err.join('\n')).toContain('nothing to do');
  });

  it('config OK returns 0', () => {
    const cfg = path.join(mkTmp(), 'playwright.config.ts');
    fs.writeFileSync(cfg, 'forbidOnly maxFailures retries');
    const { out } = captureLog();
    expect(main(['--config', cfg])).toBe(0);
    expect(out.join('\n')).toContain('Fail-fast config OK.');
  });

  it('config with recommendations still returns 0', () => {
    const cfg = path.join(mkTmp(), 'playwright.config.ts');
    fs.writeFileSync(cfg, 'forbidOnly only');
    const { out } = captureLog();
    expect(main(['--config', cfg])).toBe(0);
    expect(out.join('\n')).toContain('recommendations');
  });

  it('accepts the --flag=value form', () => {
    const cfg = path.join(mkTmp(), 'playwright.config.ts');
    fs.writeFileSync(cfg, 'forbidOnly maxFailures retries');
    const { out } = captureLog();
    expect(main([`--config=${cfg}`])).toBe(0);
    expect(out.join('\n')).toContain('Fail-fast config OK.');
  });

  // On a plain object literal every inherited key resolves truthy, so
  // `VALUE_FLAGS['toString']` was Object.prototype.toString and the token was
  // swallowed as a value flag -- the run then fell through to "nothing to do"
  // (exit 1) instead of rejecting the argument (exit 2).
  it.each([
    'toString',
    'constructor',
    'valueOf',
    '__proto__',
    'hasOwnProperty',
  ])('rejects the inherited key %s instead of swallowing it', (key) => {
    const { err } = captureLog();
    expect(main([key, 'x'])).toBe(2);
    expect(err.join('\n')).toContain(`unrecognized arguments: ${key}`);
  });

  // Note: there is deliberately no inline-form twin of the case above. The
  // inline branch only runs for tokens starting with '--' and looks up
  // `a.slice(0, eq)`, which therefore always starts with '--' -- and no
  // Object.prototype key does. An inline prototype-key case is unreachable by
  // construction, so a test for it would pass against pre-fix code too.
  it('rejects an unknown inline flag', () => {
    const { err } = captureLog();
    expect(main(['--bogus=x'])).toBe(2);
    expect(err.join('\n')).toContain('unrecognized arguments: --bogus=x');
  });

  it('unreadable config (a directory) returns 1 cleanly', () => {
    const d = path.join(mkTmp(), 'a_dir.config');
    fs.mkdirSync(d);
    const { err } = captureLog();
    expect(main(['--config', d])).toBe(1);
    expect(err.join('\n')).toContain('cannot read config');
  });

  it('results missing file returns 1', () => {
    const { err } = captureLog();
    expect(main(['--results', path.join(mkTmp(), 'nope.json')])).toBe(1);
    expect(err.join('\n')).toContain('not found');
  });

  it('results malformed returns 1 with no traceback', () => {
    const bad = path.join(mkTmp(), 'bad.json');
    fs.writeFileSync(bad, 'not json');
    const { err } = captureLog();
    expect(main(['--results', bad])).toBe(1);
    expect(err.join('\n')).toContain('not valid JSON');
  });

  it('results with a failure returns 1', () => {
    const data = {
      suites: [
        {
          title: 'r',
          specs: [
            {
              title: 't',
              location: { file: 'a.ts', line: 1 },
              tests: [
                {
                  title: 't',
                  status: 'failed',
                  results: [{ status: 'failed', error: { message: 'boom' } }],
                },
              ],
            },
          ],
        },
      ],
    };
    const { out } = captureLog();
    expect(main(['--results', writeResults(mkTmp(), data)])).toBe(1);
    expect(out.join('\n')).toContain('1 failing test');
  });

  it('results with no failures returns 0', () => {
    const { out } = captureLog();
    expect(main(['--results', writeResults(mkTmp(), { suites: [] })])).toBe(0);
    expect(out.join('\n')).toContain('0 failing');
  });

  it('unreadable results (a directory) returns 1 cleanly', () => {
    const d = path.join(mkTmp(), 'a_dir_results.json');
    fs.mkdirSync(d);
    const { err } = captureLog();
    expect(main(['--results', d])).toBe(1);
    expect(err.join('\n')).toContain('canary-fail-fast:');
  });

  it('malformed structure results returns 1', () => {
    const { err } = captureLog();
    expect(main(['--results', writeResults(mkTmp(), { suites: 'nope' })])).toBe(
      1,
    );
    expect(err.join('\n')).toContain('unexpected structure');
  });

  it('config recs do not zero out the digest exit code', () => {
    const tmp = mkTmp();
    const cfg = path.join(tmp, 'playwright.config.ts');
    fs.writeFileSync(cfg, 'forbidOnly only'); // missing knobs -> recs
    const data = {
      suites: [
        {
          title: 'r',
          specs: [
            {
              title: 't',
              location: { file: 'a.ts', line: 1 },
              tests: [
                {
                  title: 't',
                  status: 'failed',
                  results: [{ status: 'failed', error: { message: 'boom' } }],
                },
              ],
            },
          ],
        },
      ],
    };
    const res = writeResults(tmp, data);
    const { out } = captureLog();
    expect(main(['--config', cfg, '--results', res])).toBe(1);
    const joined = out.join('\n');
    expect(joined).toContain('recommendations');
    expect(joined).toContain('1 failing test');
  });
});

// --- skill packaging contract ----------------------------------------------

describe('packaging', () => {
  it('SKILL.md declares the executable contract (node, cli.mjs)', () => {
    const head = fs
      .readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8')
      .split('---')[1];
    expect(head).toContain('name: canary-fail-fast');
    expect(head).toContain('cli: scripts/cli.mjs');
    expect(head).toContain('node>=20');
  });

  // The skill runner spawns the `cli:` target directly (ts/src/skills-cli.ts
  // execs the file, relying on its shebang), so a cli.mjs without the exec bit
  // makes the documented `canary skills run canary-fail-fast -- --help` fail with no
  // output at all. Assert the bit AND a real spawn, not just the file's text.
  it('cli.mjs is executable and runs when spawned directly', () => {
    const cli = path.join(SCRIPTS, 'cli.mjs');
    expect(fs.statSync(cli).mode & 0o111).toBeTruthy();
    const res = spawnSync(cli, ['--help'], { encoding: 'utf8' });
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('usage:');
  });

  it('scripts are ascii-only (no emoji in source)', () => {
    for (const name of fs.readdirSync(SCRIPTS)) {
      if (!name.endsWith('.mjs')) continue;
      const text = fs.readFileSync(path.join(SCRIPTS, name), 'utf8');
      // eslint-disable-next-line no-control-regex
      expect(/^[\x00-\x7F]*$/.test(text)).toBe(true);
    }
  });

  it('is self-contained: no engine (agent/) imports', () => {
    for (const name of fs.readdirSync(SCRIPTS)) {
      if (!name.endsWith('.mjs')) continue;
      const text = fs.readFileSync(path.join(SCRIPTS, name), 'utf8');
      expect(text.includes('agent/') || text.includes('agent.')).toBe(false);
    }
  });

  it('the skill dir has no client strings', () => {
    const banned = ['capi' + 'llary', 'cap' + 'well'];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== 'node_modules') walk(full);
        } else if (['.mjs', '.md'].includes(path.extname(full))) {
          const text = fs.readFileSync(full, 'utf8').toLowerCase();
          for (const bad of banned) expect(text.includes(bad)).toBe(false);
        }
      }
    };
    walk(SKILL_DIR);
  });

  // --- review fixes: Python→JS truthiness + argparse exit-code parity ---

  it('empty suites object yields no failures (Python {} is falsy, JS truthy)', () => {
    expect(parseFailures(writeResults(mkTmp(), { suites: {} }))).toEqual([]);
    expect(
      parseFailures(
        writeResults(mkTmp(), { suites: [{ title: 'r', suites: {} }] }),
      ),
    ).toEqual([]);
  });

  it('empty suites object exits 0 via main (a pass, not a hard failure)', () => {
    captureLog();
    expect(main(['--results', writeResults(mkTmp(), { suites: {} })])).toBe(0);
  });

  it('unknown flag exits 2 (argparse parity)', () => {
    captureLog();
    expect(main(['--bogus'])).toBe(2);
  });

  it('a value-flag with no value exits 2', () => {
    captureLog();
    expect(main(['--results'])).toBe(2);
  });

  it('--help and -h exit 0', () => {
    captureLog();
    expect(main(['--help'])).toBe(0);
    expect(main(['-h'])).toBe(0);
  });
});
