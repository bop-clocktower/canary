/**
 * canary-judomaster (#614) review regressions. The feature claims it never
 * reports a test as pinning a defect it was not shown to catch, so each case
 * here is a way a bare substring match used to call the wrong run
 * `reproduced`, plus captured real runner output (de-identified) so the
 * matching is tested against what vitest and pytest actually print.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseTrace } from '../src/analysis/judomaster/parse.js';
import { resolveFrames } from '../src/analysis/judomaster/resolve.js';
import { classifyRun } from '../src/analysis/judomaster/verify.js';

/** vitest 5 `--reporter=verbose`, one defect and one unrelated failure. */
const VITEST_OUT = [
  ' RUN  v5.0.1 /repo',
  '',
  ' × tests/generated/regression/total-typeerror.test.ts > totals an item with no meta 1ms',
  "   → Cannot read properties of undefined (reading 'qty')",
  '',
  ' FAIL  tests/generated/regression/total-typeerror.test.ts > totals an item with no meta',
  "TypeError: Cannot read properties of undefined (reading 'qty')",
  ' ❯ cartTotal src/cart/total.ts:4:24',
  '      2|   let t = 0;',
  '      3|   for (const i of items) {',
  '      4|     t += i.price * i.meta.qty;',
  ' ❯ tests/generated/regression/total-typeerror.test.ts:4:10',
  '',
  ' Test Files  1 failed (1)',
  '      Tests  1 failed (1)',
].join('\n');

/** vitest 5 output for a plain assertion failure (the defect never fired). */
const VITEST_ASSERT = [
  ' FAIL  tests/generated/regression/total-typeerror.test.ts > totals',
  'AssertionError: expected 1 to be 2 // Object.is equality',
  ' ❯ tests/generated/regression/total-typeerror.test.ts:6:39',
].join('\n');

/** pytest 9 `--tb=short`. */
const PYTEST_OUT = [
  '=================================== FAILURES ===================================',
  '______________________________ test_total_no_meta ______________________________',
  'tests/generated/regression/test_total_keyerror.py:8: in test_total_no_meta',
  '    assert total([{"price": 2}]) == 0',
  'app/cart/total.py:4: in total',
  '    t += i["price"] * i["meta"]["qty"]',
  "E   KeyError: 'meta'",
  '=========================== short test summary info ============================',
  "FAILED tests/generated/regression/test_total_keyerror.py::test_total_no_meta - KeyError: 'meta'",
].join('\n');

const TYPE_ERROR = {
  text: "Cannot read properties of undefined (reading 'qty')",
  kind: 'message' as const,
  type: 'TypeError',
};

describe('signature matching against real runner output', () => {
  it('reproduces from captured vitest output', () => {
    expect(classifyRun([1, VITEST_OUT, ''], TYPE_ERROR, 'vitest').verdict).toBe(
      'reproduced',
    );
  });

  it('reproduces a short pytest KeyError message on its error line', () => {
    const sig = { text: "'meta'", kind: 'message' as const, type: 'KeyError' };
    expect(classifyRun([1, PYTEST_OUT, ''], sig, 'pytest').verdict).toBe(
      'reproduced',
    );
  });

  it('does not reproduce when the message appears only off the error line', () => {
    // The code frame, console output or a diff can carry the text while the
    // run actually failed on something else.
    const out = `${VITEST_ASSERT}\nconsole.log: ${TYPE_ERROR.text}`;
    expect(classifyRun([1, out, ''], TYPE_ERROR, 'vitest').verdict).toBe(
      'failed-other-reason',
    );
  });

  it('does not reproduce the message under a different error type', () => {
    const out = `RangeError: ${TYPE_ERROR.text}`;
    expect(classifyRun([1, out, ''], TYPE_ERROR, 'vitest').verdict).toBe(
      'failed-other-reason',
    );
  });

  it('matches a namespaced or coded error line', () => {
    const sig = {
      text: 'bad qty',
      kind: 'message' as const,
      type: 'app.QtyError',
    };
    for (const line of [
      'E   app.QtyError: bad qty',
      'QtyError [ERR_QTY]: bad qty',
      'Uncaught QtyError: bad qty',
    ]) {
      expect(classifyRun([1, line, ''], sig, 'vitest').verdict).toBe(
        'reproduced',
      );
    }
  });
});

describe('type-only signatures', () => {
  it('does not let an AssertionError confirm a type-only Error', () => {
    const r = classifyRun(
      [1, 'AssertionError: expected 1 to be 2', ''],
      { text: 'Error', kind: 'type-only', type: 'Error' },
      'vitest',
      'expect(f()).toBe(2)',
    );
    expect(r.verdict).not.toBe('reproduced');
  });

  it('refuses a generic type-only signature as too weak to confirm', () => {
    const r = classifyRun(
      [1, 'Error', ''],
      { text: 'Error', kind: 'type-only', type: 'Error' },
      'vitest',
    );
    expect(r.verdict).toBe('unverified');
    expect(r.reason).toContain('--expect');
  });

  it('confirms a specific type on its own error line', () => {
    const sig = {
      text: 'QtyError',
      kind: 'type-only' as const,
      type: 'QtyError',
    };
    expect(classifyRun([1, 'E   QtyError', ''], sig, 'pytest').verdict).toBe(
      'reproduced',
    );
    expect(
      classifyRun([1, 'AssertionError: no QtyError here', ''], sig, 'pytest')
        .verdict,
    ).toBe('failed-other-reason');
  });
});

describe('runs that did not finish', () => {
  it('treats a signal death as could-not-run, whatever the partial output', () => {
    const r = classifyRun(
      [-9, `TypeError: ${TYPE_ERROR.text}`, ''],
      TYPE_ERROR,
      'vitest',
    );
    expect(r.verdict).toBe('unverified');
    expect(r.reason).toContain('signal');
  });

  it('names a possible import-time defect on pytest exit 2', () => {
    const r = classifyRun([2, 'ERROR collecting', ''], TYPE_ERROR, 'pytest');
    expect(r.verdict).toBe('unverified');
    expect(r.reason).toContain('collection error');
  });
});

describe('the test cannot confirm itself', () => {
  it('sees through escaped quotes in the test source', () => {
    const source =
      "throw new TypeError('Cannot read properties of undefined (reading \\'qty\\')')";
    const r = classifyRun([1, VITEST_OUT, ''], TYPE_ERROR, 'vitest', source);
    expect(r.verdict).toBe('failed-other-reason');
    expect(r.reason).toContain("test's own source");
  });
});

describe('trace parsing picks the error that owns the frames', () => {
  it('takes the V8 error line nearest above the frames', () => {
    const t = parseTrace(
      [
        'ConnectionError: retrying in 5s',
        "TypeError: Cannot read properties of undefined (reading 'qty')",
        '    at cartTotal (/app/src/cart/total.ts:4:24)   ',
      ].join('\n'),
    );
    expect(t?.errorType).toBe('TypeError');
    expect(t?.frames).toHaveLength(1);
  });

  it('takes the CPython error line after the last frame', () => {
    const t = parseTrace(
      [
        'Traceback (most recent call last):',
        '  File "/srv/app/cart/total.py", line 4, in total',
        "KeyError: 'meta'",
        'RuntimeError: worker exited',
      ].join('\n'),
    );
    expect(t?.errorType).toBe('KeyError');
    expect(t?.message).toBe("'meta'");
  });

  it('accepts Uncaught, a [CODE] suffix and a bare type', () => {
    const frame = '    at run (/app/src/a.ts:1:1)';
    expect(
      parseTrace(`Uncaught TypeError [ERR_INVALID_ARG_TYPE]: bad arg\n${frame}`)
        ?.errorType,
    ).toBe('TypeError');
    const bare = parseTrace(`QtyError\n${frame}`);
    expect(bare?.errorType).toBe('QtyError');
    expect(bare?.message).toBe('');
  });

  it('does not read ErrorBoundary as an error type', () => {
    expect(
      parseTrace('ErrorBoundary: rendering\n    at run (/app/src/a.ts:1:1)'),
    ).toBeNull();
  });
});

describe('frame resolution does not over-match', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'judomaster-review-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'decoder.py'), 'x = 1\n');
    writeFileSync(join(root, 'src', 'index.ts'), 'export {};\n');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it.each([
    '/usr/lib/python3.11/json/decoder.py',
    '/usr/lib/python3/dist-packages/yaml/decoder.py',
  ])('names the runtime frame %s external', (file) => {
    expect(resolveFrames([{ file, line: 1 }], root)[0]!.status).toBe(
      'external',
    );
  });

  it('does not resolve a foreign path by its basename alone', () => {
    const f = resolveFrames(
      [{ file: '/opt/tool/json/decoder.py', line: 1 }],
      root,
    )[0]!;
    expect(f.status).toBe('missing');
  });

  it('still resolves a two-segment suffix', () => {
    const f = resolveFrames([{ file: '/app/src/index.ts', line: 1 }], root)[0]!;
    expect(f.status).toBe('resolved');
    expect(f.path).toBe('src/index.ts');
  });
});
