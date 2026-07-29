// Unit suite for the canary-test-reporter skill, ported from Python to vitest as
// the skill moves to JS (canary mirrors harness, which is TS/Node). Behavior is
// preserved from the Python version: same Playwright-JSON parsing, same JSON
// report shape (field names AND order), same themed Markdown bytes (middle-dot /
// em-dash / ellipsis glyphs), same counts, same exit codes.
//
// canary-test-reporter turns a Playwright JSON results file into a human
// Markdown report and a machine JSON artifact, exiting 1 when any test failed.

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  parseResults,
  TestResult,
  ReportData,
} from '../claude-code/canary-test-reporter/scripts/parse.mjs';
import { renderMarkdown } from '../claude-code/canary-test-reporter/scripts/render.mjs';
import { renderJson } from '../claude-code/canary-test-reporter/scripts/json_report.mjs';
import { main } from '../claude-code/canary-test-reporter/scripts/cli.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.join(HERE, '..', 'claude-code', 'canary-test-reporter');
const SCRIPTS = path.join(SKILL_DIR, 'scripts');

const MIDDOT = '·';
const EMDASH = '—';
const ELLIPSIS = '…';

const tmps: string[] = [];
const mkTmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'reporter-'));
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

// --- Playwright-JSON shape builders (mirror the Python test helpers) --------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mkResult = (status: string, duration?: number, error?: string): any => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r: any = { status };
  if (duration !== undefined) r.duration = duration;
  if (error) r.error = { message: error };
  return r;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mkTest = (
  title: string,
  status: string,
  results: any[],
  location?: any,
) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const t: any = { title, status, results };
  if (location) t.location = location;
  return t;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mkSpec = (title: string, tests: any[], location?: any) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s: any = { title, tests };
  if (location) s.location = location;
  return s;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mkSuite = (title: string, specs: any[] = [], suites: any[] = []) => ({
  title,
  specs,
  suites,
});

// --- parse -----------------------------------------------------------------

describe('parseResults', () => {
  it('missing file returns empty report', () => {
    const data = parseResults(path.join(mkTmp(), 'nope.json'));
    expect(data.total).toBe(0);
    expect(data.results).toEqual([]);
  });

  it('malformed json throws', () => {
    const p = path.join(mkTmp(), 'bad.json');
    fs.writeFileSync(p, 'not json');
    expect(() => parseResults(p)).toThrow(/not valid JSON/);
  });

  it('non-object top level throws', () => {
    expect(() => parseResults(writeResults(mkTmp(), [1, 2, 3]))).toThrow(
      /top-level value must be an object/,
    );
  });

  it('malformed structure (suites is a string) throws', () => {
    expect(() =>
      parseResults(writeResults(mkTmp(), { suites: 'not-a-list' })),
    ).toThrow(/unexpected structure/);
  });

  it('passed test', () => {
    const data = writeResults(mkTmp(), {
      suites: [
        mkSuite('root', [
          mkSpec(
            'loads',
            [mkTest('loads', 'passed', [mkResult('passed', 123)])],
            {
              file: 'a.spec.ts',
              line: 1,
            },
          ),
        ]),
      ],
    });
    const report = parseResults(data);
    expect(report.total).toBe(1);
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(0);
    const r = report.results[0];
    expect(r.status).toBe('passed');
    expect(r.error).toBeNull();
    expect(r.duration_ms).toBe(123);
  });

  it('failed test carries error, file, and line', () => {
    const data = writeResults(mkTmp(), {
      suites: [
        mkSuite('root', [
          mkSpec(
            'auth',
            [
              mkTest(
                'rejects bad pw',
                'unexpected',
                [mkResult('unexpected', 500, 'Expected 401, got 200')],
                { file: 'auth.spec.ts', line: 42 },
              ),
            ],
            { file: 'auth.spec.ts', line: 1 },
          ),
        ]),
      ],
    });
    const report = parseResults(data);
    expect(report.failed).toBe(1);
    const r = report.results[0];
    expect(r.status).toBe('failed');
    expect(r.error).toBe('Expected 401, got 200');
    expect(r.file).toBe('auth.spec.ts');
    expect(r.line).toBe(42);
  });

  it('flaky = failed/unexpected with a passing retry, no error', () => {
    const data = writeResults(mkTmp(), {
      suites: [
        mkSuite('root', [
          mkSpec(
            'search',
            [
              mkTest('autocomplete', 'unexpected', [
                mkResult('unexpected', 200, 'timeout'),
                mkResult('passed', 180),
              ]),
            ],
            { file: 'search.spec.ts', line: 17 },
          ),
        ]),
      ],
    });
    const report = parseResults(data);
    expect(report.flaky).toBe(1);
    expect(report.failed).toBe(0);
    expect(report.results[0].status).toBe('flaky');
    expect(report.results[0].error).toBeNull();
  });

  it('literal flaky status is honored', () => {
    const data = writeResults(mkTmp(), {
      suites: [
        mkSuite('root', [
          mkSpec('search', [mkTest('autocomplete', 'flaky', [])]),
        ]),
      ],
    });
    const report = parseResults(data);
    expect(report.flaky).toBe(1);
    expect(report.results[0].status).toBe('flaky');
  });

  it('unrecognized status fails closed (counts as failed)', () => {
    const data = writeResults(mkTmp(), {
      suites: [
        mkSuite('root', [mkSpec('s', [mkTest('t', 'interrupted', [])])]),
      ],
    });
    const report = parseResults(data);
    expect(report.passed).toBe(0);
    expect(report.failed).toBe(1);
    expect(report.results[0].status).toBe('failed');
  });

  it('title is not duplicated when the test has no distinct title', () => {
    const data = writeResults(mkTmp(), {
      suites: [
        mkSuite('root', [
          mkSpec(
            'should reject bad password',
            [{ status: 'passed', results: [mkResult('passed', 10)] }],
            { file: 'auth.spec.ts', line: 5 },
          ),
        ]),
      ],
    });
    const report = parseResults(data);
    const title = report.results[0].title;
    expect(title.split('should reject bad password').length - 1).toBe(1);
  });

  it('skipped test', () => {
    const data = writeResults(mkTmp(), {
      suites: [
        mkSuite('root', [mkSpec('slow', [mkTest('heavy', 'skipped', [])])]),
      ],
    });
    const report = parseResults(data);
    expect(report.skipped).toBe(1);
    expect(report.results[0].status).toBe('skipped');
  });

  it('sums durations across results', () => {
    const data = writeResults(mkTmp(), {
      suites: [
        mkSuite('root', [
          mkSpec('a', [mkTest('t1', 'passed', [mkResult('passed', 100)])]),
          mkSpec('b', [mkTest('t2', 'passed', [mkResult('passed', 250)])]),
        ]),
      ],
    });
    expect(parseResults(data).duration_ms).toBe(350);
  });

  it('walks nested suites and joins titles', () => {
    const inner = mkSuite('inner', [
      mkSpec('logs in', [
        mkTest('logs in', 'passed', [mkResult('passed', 10)]),
      ]),
    ]);
    const outer = mkSuite('outer', [], [inner]);
    const report = parseResults(writeResults(mkTmp(), { suites: [outer] }));
    expect(report.total).toBe(1);
    expect(report.results[0].title).toContain('outer');
    expect(report.results[0].title).toContain('inner');
  });

  it('counts each status correctly', () => {
    const specs = [
      mkSpec('p', [mkTest('p', 'passed', [mkResult('passed')])]),
      mkSpec('f', [
        mkTest('f', 'unexpected', [mkResult('unexpected', undefined, 'boom')]),
      ]),
      mkSpec('fl', [
        mkTest('fl', 'unexpected', [
          mkResult('unexpected'),
          mkResult('passed'),
        ]),
      ]),
      mkSpec('s', [mkTest('s', 'skipped', [])]),
    ];
    const report = parseResults(
      writeResults(mkTmp(), { suites: [mkSuite('r', specs)] }),
    );
    expect(report.total).toBe(4);
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.flaky).toBe(1);
    expect(report.skipped).toBe(1);
  });

  it('strips a leading non-JSON banner', () => {
    const p = path.join(mkTmp(), 'results.json');
    fs.writeFileSync(p, 'Playwright run\n{"suites": []}');
    expect(parseResults(p).total).toBe(0);
  });
});

// --- render ----------------------------------------------------------------

const mkReport = (o: {
  passed?: number;
  failed?: number;
  flaky?: number;
  skipped?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  results?: any[];
  duration_ms?: number;
}) => {
  const passed = o.passed ?? 0;
  const failed = o.failed ?? 0;
  const flaky = o.flaky ?? 0;
  const skipped = o.skipped ?? 0;
  return ReportData({
    total: passed + failed + flaky + skipped,
    passed,
    failed,
    flaky,
    skipped,
    duration_ms: o.duration_ms ?? 0,
    results: o.results ?? [],
  });
};

const failedResult = (
  title = 'suite > spec > test',
  file: string | null = 'a.spec.ts',
  line: number | null = 1,
  error: string | null = 'boom',
) => TestResult({ title, status: 'failed', file, line, error });

const passedResult = (title = 'suite > spec > ok', duration_ms = 100) =>
  TestResult({ title, status: 'passed', duration_ms });

const flakyResult = (
  title = 'suite > spec > flaky',
  file = 'b.spec.ts',
  line = 5,
) => TestResult({ title, status: 'flaky', file, line });

describe('renderMarkdown', () => {
  it('starts with the H1 heading', () => {
    const md = renderMarkdown(
      mkReport({ passed: 1, results: [passedResult()] }),
    );
    expect(md.startsWith('# Test Report')).toBe(true);
  });

  it('status line shows counts, labels, and duration with the middle-dot glyph', () => {
    const results = [
      failedResult(),
      failedResult('s>s>t2'),
      flakyResult(),
      passedResult(),
      ...Array.from({ length: 13 }, (_, i) => passedResult(`s>s>p${i}`)),
      TestResult({ title: 's>s>sk', status: 'skipped' }),
    ];
    const md = renderMarkdown(
      mkReport({
        passed: 14,
        failed: 2,
        flaky: 1,
        skipped: 1,
        duration_ms: 12400,
        results,
      }),
    );
    expect(md).toContain('**2 failed**');
    expect(md).toContain('**14 passed**');
    expect(md).toContain('**1 flaky**');
    expect(md).toContain('**1 skipped**');
    expect(md).toContain('12.4s');
    expect(md).toContain(MIDDOT);
  });

  // FIX 1: duration rounds half-to-EVEN to match Python's f"{s:.1f}", not JS
  // toFixed's half-up. The exact-tie inputs (ms == 250 mod 500) are where they
  // diverge; the byte-exact strings below are Python's actual output.
  it('rounds the duration half-to-even (byte-exact with Python) on ties', () => {
    const durationOf = (ms: number) =>
      renderMarkdown(mkReport({ duration_ms: ms })).split('\n')[2];
    expect(durationOf(250)).toBe(`0 tests ${MIDDOT} 0.2s`); // toFixed would say 0.3s
    expect(durationOf(1250)).toBe(`0 tests ${MIDDOT} 1.2s`);
    expect(durationOf(2250)).toBe(`0 tests ${MIDDOT} 2.2s`);
    expect(durationOf(750)).toBe(`0 tests ${MIDDOT} 0.8s`);
    expect(durationOf(350)).toBe(`0 tests ${MIDDOT} 0.3s`); // 0.35 is < .35, floors
    expect(durationOf(12400)).toBe(`0 tests ${MIDDOT} 12.4s`);
  });

  it('failed section shows title, location, and error', () => {
    const r = failedResult(
      'auth > login > rejects bad pw',
      'auth.spec.ts',
      42,
      'Expected 401',
    );
    const md = renderMarkdown(mkReport({ failed: 1, results: [r] }));
    expect(md).toContain('## Failed');
    expect(md).toContain('auth > login > rejects bad pw');
    expect(md).toContain('auth.spec.ts:42');
    expect(md).toContain('Expected 401');
  });

  it('failed error goes in a fenced code block', () => {
    const md = renderMarkdown(
      mkReport({
        failed: 1,
        results: [
          failedResult(undefined, undefined, undefined, 'line one\nline two'),
        ],
      }),
    );
    expect(md).toContain('```');
    expect(md).toContain('line one');
    expect(md).toContain('line two');
  });

  it('error is truncated at 10 lines with the ellipsis glyph', () => {
    const longError = Array.from({ length: 15 }, (_, i) => `line ${i}`).join(
      '\n',
    );
    const md = renderMarkdown(
      mkReport({
        failed: 1,
        results: [failedResult(undefined, undefined, undefined, longError)],
      }),
    );
    expect(md).toContain('truncated');
    expect(md).toContain(`${ELLIPSIS} (truncated)`);
    expect(md).toContain('line 9');
    expect(md).not.toContain('line 10');
  });

  it('flaky section is present', () => {
    const r = flakyResult('search > auto > debounce', 's.spec.ts', 17);
    const md = renderMarkdown(mkReport({ flaky: 1, results: [r] }));
    expect(md).toContain('## Flaky');
    expect(md).toContain('search > auto > debounce');
    expect(md).toContain(EMDASH);
  });

  it('flaky lines carry no error block', () => {
    const r = TestResult({
      title: 's>s>t',
      status: 'flaky',
      file: 'f.ts',
      line: 1,
    });
    const md = renderMarkdown(mkReport({ flaky: 1, results: [r] }));
    expect(md).not.toContain('```');
  });

  it('no failed section when zero failures', () => {
    const md = renderMarkdown(
      mkReport({
        passed: 5,
        results: Array.from({ length: 5 }, (_, i) => passedResult(`s>s>p${i}`)),
      }),
    );
    expect(md).not.toContain('## Failed');
  });

  it('no flaky section when zero flakes', () => {
    const md = renderMarkdown(
      mkReport({ passed: 1, results: [passedResult()] }),
    );
    expect(md).not.toContain('## Flaky');
  });

  it('summary table is present', () => {
    const md = renderMarkdown(
      mkReport({
        passed: 2,
        failed: 1,
        results: [failedResult(), passedResult(), passedResult('s>s>p2')],
      }),
    );
    expect(md).toContain('## Summary');
    expect(md).toContain('Passed');
    expect(md).toContain('Failed');
    expect(md).toContain('Total');
  });

  it('all-pass report has no failed section and formats duration', () => {
    const md = renderMarkdown(
      mkReport({
        passed: 3,
        duration_ms: 3000,
        results: Array.from({ length: 3 }, (_, i) =>
          passedResult(`s>s>p${i}`, 1000),
        ),
      }),
    );
    expect(md).not.toContain('## Failed');
    expect(md).toContain('3.0s');
  });

  it('empty report has no stray separator on the status line', () => {
    const md = renderMarkdown(mkReport({}));
    const line = md.split('\n')[2];
    expect(line.startsWith(MIDDOT)).toBe(false);
    expect(line).toBe(`0 tests ${MIDDOT} 0.0s`);
  });

  it('flaky location falls back to file only when line is null', () => {
    const r = TestResult({
      title: 's>s>t',
      status: 'flaky',
      file: 'f.spec.ts',
      line: null,
    });
    const md = renderMarkdown(mkReport({ flaky: 1, results: [r] }));
    expect(md).toContain('f.spec.ts');
    expect(md).not.toContain('f.spec.ts:');
  });
});

// --- json_report -----------------------------------------------------------

describe('renderJson', () => {
  it('emits valid JSON', () => {
    const out = renderJson(mkReport({ passed: 1, results: [passedResult()] }));
    const parsed = JSON.parse(out);
    expect(typeof parsed).toBe('object');
  });

  it('version is 1', () => {
    expect(JSON.parse(renderJson(mkReport({}))).version).toBe(1);
  });

  it('generated_at is second-precision ISO-8601 Z (no milliseconds)', () => {
    const out = JSON.parse(renderJson(mkReport({})));
    expect(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(out.generated_at),
    ).toBe(true);
  });

  it('summary fields are complete', () => {
    const report = mkReport({
      passed: 3,
      failed: 1,
      flaky: 1,
      skipped: 1,
      duration_ms: 5000,
      results: [
        failedResult(),
        flakyResult(),
        passedResult(),
        passedResult('s>s>p2'),
        passedResult('s>s>p3'),
        TestResult({ title: 's>s>sk', status: 'skipped' }),
      ],
    });
    const s = JSON.parse(renderJson(report)).summary;
    expect(s.total).toBe(6);
    expect(s.passed).toBe(3);
    expect(s.failed).toBe(1);
    expect(s.flaky).toBe(1);
    expect(s.skipped).toBe(1);
    expect(s.duration_ms).toBe(5000);
  });

  it('results include every status', () => {
    const results = [
      passedResult('s>s>p'),
      failedResult('s>s>f'),
      flakyResult('s>s>fl'),
      TestResult({ title: 's>s>sk', status: 'skipped' }),
    ];
    const out = JSON.parse(
      renderJson(
        mkReport({ passed: 1, failed: 1, flaky: 1, skipped: 1, results }),
      ),
    );
    const statuses = new Set(
      out.results.map((r: { status: string }) => r.status),
    );
    expect(statuses).toEqual(new Set(['passed', 'failed', 'flaky', 'skipped']));
  });

  it('error is null for a passed test', () => {
    const out = JSON.parse(
      renderJson(mkReport({ passed: 1, results: [passedResult()] })),
    );
    expect(out.results[0].error).toBeNull();
  });

  it('results carry every field', () => {
    const r = failedResult('s > t', 'f.spec.ts', 7, 'kaboom');
    const out = JSON.parse(renderJson(mkReport({ failed: 1, results: [r] })));
    const result = out.results[0];
    expect(result.title).toBe('s > t');
    expect(result.status).toBe('failed');
    expect(result.file).toBe('f.spec.ts');
    expect(result.line).toBe(7);
    expect(result.duration_ms).toBeNull();
    expect(result.error).toBe('kaboom');
  });

  it('preserves the top-level field order (version, generated_at, summary, results)', () => {
    const out = renderJson(mkReport({}));
    const keys = Object.keys(JSON.parse(out));
    expect(keys).toEqual(['version', 'generated_at', 'summary', 'results']);
  });

  // FIX 2: ensure_ascii=True parity -- every codepoint >= U+0080 is emitted as a
  // \uXXXX escape (astral chars as UTF-16 surrogate-pair escapes), matching
  // Python json.dumps byte-for-byte so a non-ASCII title/error never breaks the
  // artifact's byte-identity.
  it('escapes non-ASCII to \\uXXXX like Python ensure_ascii (incl. surrogates)', () => {
    // Glyphs built via fromCodePoint so this .ts source stays ASCII while the
    // in-memory strings hold the real characters: "cafe"-with-acute (U+00E9), a
    // check mark (U+2713), CJK "Nihongo" (U+65E5 U+672C U+8A9E), a rocket
    // (U+1F680, astral/surrogate pair), an em dash (U+2014), and a collision
    // emoji (U+1F4A5). renderJson must escape each of these back out.
    const cp = String.fromCodePoint;
    const cafe = 'caf' + cp(0xe9);
    const title = `renders ${cafe} ${cp(0x2713)} ${cp(0x65e5, 0x672c, 0x8a9e)} ${cp(0x1f680)}`;
    const r = TestResult({
      title,
      status: 'failed',
      file: `${cafe}.spec.ts`,
      line: 7,
      error: `em${cp(0x2014)}dash ${cp(0x1f4a5)}`,
    });
    const out = renderJson(mkReport({ failed: 1, results: [r] }));
    // Raw source has no byte >= 0x80; only escape sequences carry the glyphs.
    // eslint-disable-next-line no-control-regex
    expect(/[^\x00-\x7f]/.test(out)).toBe(false);
    expect(out).toContain(
      '"title": "renders caf\\u00e9 \\u2713 \\u65e5\\u672c\\u8a9e \\ud83d\\ude80"',
    );
    expect(out).toContain('"file": "caf\\u00e9.spec.ts"');
    expect(out).toContain('"error": "em\\u2014dash \\ud83d\\udca5"');
    // Round-trips back to the original glyphs.
    expect(JSON.parse(out).results[0].title).toBe(title);
  });
});

// --- cli -------------------------------------------------------------------

const captureIO = () => {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(
    (s: string | Uint8Array) => {
      out.push(String(s));
      return true;
    },
  );
  vi.spyOn(console, 'error').mockImplementation((s?: unknown) => {
    err.push(String(s));
  });
  return { out, err };
};

const resultsFile = (tmp: string, passed = 0, failed = 0): string => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const specs: any[] = [];
  for (let i = 0; i < passed; i += 1) {
    specs.push(
      mkSpec(`p${i}`, [
        mkTest(`p${i}`, 'passed', [mkResult('passed', 100)], {
          file: 'p.spec.ts',
          line: i + 1,
        }),
      ]),
    );
  }
  for (let i = 0; i < failed; i += 1) {
    specs.push(
      mkSpec(`f${i}`, [
        mkTest(`f${i}`, 'unexpected', [mkResult('unexpected', 200, 'boom')], {
          file: 'f.spec.ts',
          line: i + 1,
        }),
      ]),
    );
  }
  return writeResults(tmp, { suites: [mkSuite('root', specs)] });
};

describe('cli', () => {
  it('missing --results exits nonzero (argparse parity: 2)', () => {
    captureIO();
    expect(main([])).toBe(2);
  });

  // On a plain object literal every inherited key resolves truthy, so
  // `VALUE_FLAGS['toString']` was Object.prototype.toString and the token was
  // consumed as a value flag. This is the worst symptom in the family: katana
  // and fail-fast at least exit non-zero, but here the run SUCCEEDS -- rc 0,
  // the report written, and the user's tokens silently discarded.
  it.each([
    'toString',
    'constructor',
    'valueOf',
    '__proto__',
    'hasOwnProperty',
  ])(
    'rejects the inherited key %s instead of silently discarding it',
    (key) => {
      const tmp = mkTmp();
      const results = resultsFile(tmp, 1, 0);
      const md = path.join(tmp, 'report.md');
      const { err } = captureIO();
      // Control: the same argv without the junk succeeds and writes the report,
      // so the assertions below cannot pass vacuously.
      expect(main(['--results', results, '--markdown-out', md])).toBe(0);
      expect(fs.existsSync(md)).toBe(true);
      fs.rmSync(md);

      expect(
        main(['--results', results, '--markdown-out', md, key, 'GARBAGE']),
      ).toBe(2);
      expect(err.join('\n')).toContain(`unrecognized arguments: ${key}`);
      expect(fs.existsSync(md)).toBe(false);
    },
  );

  it('results file not found exits 1', () => {
    const { err } = captureIO();
    expect(main(['--results', path.join(mkTmp(), 'nope.json')])).toBe(1);
    expect(err.join('\n')).toContain('not found');
  });

  it('exits 0 when all pass', () => {
    const p = resultsFile(mkTmp(), 3);
    captureIO();
    expect(main(['--results', p])).toBe(0);
  });

  it('exits 1 on failures', () => {
    const p = resultsFile(mkTmp(), 0, 2);
    captureIO();
    expect(main(['--results', p])).toBe(1);
  });

  it('markdown goes to stdout by default', () => {
    const p = resultsFile(mkTmp(), 1);
    const { out } = captureIO();
    main(['--results', p]);
    expect(out.join('')).toContain('# Test Report');
  });

  it('--markdown-out writes a file and prints nothing', () => {
    const tmp = mkTmp();
    const p = resultsFile(tmp, 2);
    const outPath = path.join(tmp, 'report.md');
    const { out } = captureIO();
    main(['--results', p, '--markdown-out', outPath]);
    expect(fs.existsSync(outPath)).toBe(true);
    expect(fs.readFileSync(outPath, 'utf8')).toContain('# Test Report');
    expect(out.join('')).toBe('');
  });

  it('--json-out writes a JSON file', () => {
    const tmp = mkTmp();
    const p = resultsFile(tmp, 1);
    const outPath = path.join(tmp, 'report.json');
    captureIO();
    main(['--results', p, '--json-out', outPath]);
    expect(fs.existsSync(outPath)).toBe(true);
    const data = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    expect(data.version).toBe(1);
    expect(data.summary.passed).toBe(1);
  });

  it('both flags write both files and exit 1 on failure', () => {
    const tmp = mkTmp();
    const p = resultsFile(tmp, 1, 1);
    const mdPath = path.join(tmp, 'r.md');
    const jsonPath = path.join(tmp, 'r.json');
    captureIO();
    const code = main([
      '--results',
      p,
      '--markdown-out',
      mdPath,
      '--json-out',
      jsonPath,
    ]);
    expect(fs.existsSync(mdPath)).toBe(true);
    expect(fs.existsSync(jsonPath)).toBe(true);
    expect(fs.readFileSync(mdPath, 'utf8')).toContain('# Test Report');
    expect(JSON.parse(fs.readFileSync(jsonPath, 'utf8')).version).toBe(1);
    expect(code).toBe(1);
  });

  it('--json-out alone writes no markdown to stdout', () => {
    const tmp = mkTmp();
    const p = resultsFile(tmp, 1);
    const outPath = path.join(tmp, 'r.json');
    const { out } = captureIO();
    main(['--results', p, '--json-out', outPath]);
    expect(out.join('')).toBe('');
  });

  it('malformed results exits 1 with a prefixed error', () => {
    const bad = path.join(mkTmp(), 'bad.json');
    fs.writeFileSync(bad, 'not json');
    const { err } = captureIO();
    expect(main(['--results', bad])).toBe(1);
    expect(err.join('\n')).toContain('canary-test-reporter:');
  });

  it('unknown flag exits 2 (argparse parity)', () => {
    captureIO();
    expect(main(['--results', 'x', '--bogus'])).toBe(2);
  });

  it('--help exits 0', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(main(['--help'])).toBe(0);
    expect(main(['-h'])).toBe(0);
  });

  it('accepts the --flag=value form', () => {
    const p = resultsFile(mkTmp(), 1);
    const { out } = captureIO();
    expect(main([`--results=${p}`])).toBe(0);
    expect(out.join('')).toContain('# Test Report');
  });
});

// --- packaging contract ----------------------------------------------------

describe('packaging', () => {
  it('SKILL.md declares the executable contract (node, cli.mjs)', () => {
    const head = fs
      .readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8')
      .split('---')[1];
    expect(head).toContain('name: canary-test-reporter');
    expect(head).toContain('cli: scripts/cli.mjs');
    expect(head).toContain('node>=20');
  });

  // The skill runner spawns the `cli:` target directly (ts/src/skills-cli.ts
  // execs the file, relying on its shebang), so a cli.mjs without the exec bit
  // makes the documented `canary skills run canary-test-reporter -- --help` fail with no
  // output at all. Assert the bit AND a real spawn, not just the file's text.
  it('cli.mjs is executable and runs when spawned directly', () => {
    const cli = path.join(SCRIPTS, 'cli.mjs');
    expect(fs.statSync(cli).mode & 0o111).toBeTruthy();
    const res = spawnSync(cli, ['--help'], { encoding: 'utf8' });
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('usage:');
  });

  it('scripts are ascii-only (no emoji/glyphs in source)', () => {
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
});
