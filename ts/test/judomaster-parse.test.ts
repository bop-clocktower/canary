/**
 * canary-judomaster trace parser (#614). Every trace here is synthetic: a fake
 * cart/total module under `/app/...` paths.
 */

import { describe, expect, it } from 'vitest';

import { parseTrace } from '../src/analysis/judomaster/parse.js';

const V8_TRACE = [
  "TypeError: Cannot read properties of undefined (reading 'qty')",
  '    at cartTotal (/app/src/cart/total.ts:12:7)',
  '    at checkout (/app/src/cart/checkout.ts:30:10)',
].join('\n');

const PY_TRACE = [
  'Traceback (most recent call last):',
  '  File "/srv/app/cart/api.py", line 20, in handler',
  '    return total(cart)',
  '  File "/srv/app/cart/total.py", line 8, in total',
  '    raise ValueError("bad qty")',
  'ValueError: bad qty',
].join('\n');

describe('parseTrace: V8', () => {
  it('reads the error line and frames innermost first', () => {
    const t = parseTrace(V8_TRACE);
    expect(t).not.toBeNull();
    expect(t!.format).toBe('v8');
    expect(t!.errorType).toBe('TypeError');
    expect(t!.message).toBe(
      "Cannot read properties of undefined (reading 'qty')",
    );
    expect(t!.frames[0]).toEqual({
      file: '/app/src/cart/total.ts',
      line: 12,
      column: 7,
      fn: 'cartTotal',
    });
    expect(t!.frames).toHaveLength(2);
  });

  it('reads a frame with no function name', () => {
    const t = parseTrace('Error: boom\n    at /x/y.js:3:1');
    expect(t!.frames[0]).toEqual({ file: '/x/y.js', line: 3, column: 1 });
  });

  it('strips a file:// URL prefix', () => {
    const t = parseTrace(
      'Error: boom\n    at run (file:///home/ci/work/repo/src/a.ts:4:2)',
    );
    expect(t!.frames[0]!.file).toBe('/home/ci/work/repo/src/a.ts');
    expect(t!.frames[0]!.fn).toBe('run');
  });

  it('parses a quoted, fenced, ANSI-coloured paste identically', () => {
    const messy = [
      '> ```',
      "> \x1b[31mTypeError: Cannot read properties of undefined (reading 'qty')\x1b[0m",
      '>     at cartTotal (/app/src/cart/total.ts:12:7)',
      '>     at checkout (/app/src/cart/checkout.ts:30:10)',
      '> ```',
    ].join('\n');
    expect(parseTrace(messy)).toEqual(parseTrace(V8_TRACE));
  });
});

describe('parseTrace: CPython', () => {
  it('reverses frames so the innermost is first', () => {
    const t = parseTrace(PY_TRACE);
    expect(t).not.toBeNull();
    expect(t!.format).toBe('python');
    expect(t!.errorType).toBe('ValueError');
    expect(t!.message).toBe('bad qty');
    expect(t!.frames[0]).toEqual({
      file: '/srv/app/cart/total.py',
      line: 8,
      fn: 'total',
    });
    expect(t!.frames[1]!.fn).toBe('handler');
  });
});

describe('parseTrace: abstains', () => {
  it('returns null for prose with no frames', () => {
    expect(
      parseTrace('checkout broke again for a customer, see screenshot'),
    ).toBeNull();
  });

  it('returns null for a Java trace', () => {
    expect(
      parseTrace(
        'java.lang.IllegalStateException: boom\n\tat com.x.Y(Y.java:3)',
      ),
    ).toBeNull();
  });
});

const QTY = "Cannot read properties of undefined (reading 'qty')";
const V8_CHAIN = [
  'Error: checkout failed',
  '    at checkout (/app/src/cart/checkout.ts:30:10)',
  '    at main (/app/src/main.ts:5:3) {',
  `  [cause]: TypeError: ${QTY}`,
  '      at cartTotal (/app/src/cart/total.ts:12:7)',
  '      ... 2 lines matching cause stack trace ...',
  '      at main (/app/src/main.ts:5:3)',
  '}',
].join('\n');

const pyBlock = (file: string, line: number, error: string) => [
  'Traceback (most recent call last):',
  `  File "${file}", line ${line}, in fn`,
  '    pass',
  error,
];
const CAUSE =
  'The above exception was the direct cause of the following exception:';
const CONTEXT =
  'During handling of the above exception, another exception occurred:';

describe('parseTrace: exception chains', () => {
  it('reads a frame line that ends in " {"', () => {
    const t = parseTrace('TypeError: x\n    at f (/app/src/a.ts:1:2) {')!;
    expect(t.frames[0]).toEqual({
      file: '/app/src/a.ts',
      line: 1,
      column: 2,
      fn: 'f',
    });
  });

  it('keeps the V8 wrapper as the reported error and links its [cause]', () => {
    const t = parseTrace(V8_CHAIN)!;
    expect([t.errorType, t.message]).toEqual(['Error', 'checkout failed']);
    expect(t.frames.map((f) => f.line)).toEqual([30, 5, 12, 5]);
    expect(t.chain).toEqual([
      { errorType: 'TypeError', message: QTY, relation: 'cause', start: 2 },
    ]);
  });

  it('links CPython blocks outward-in with their relation', () => {
    const text = [
      ...pyBlock('/srv/app/cart/db.py', 3, "KeyError: 'qty'"),
      '',
      CONTEXT,
      '',
      ...pyBlock('/srv/app/cart/total.py', 8, 'ValueError: bad qty'),
      '',
      CAUSE,
      '',
      ...pyBlock('/srv/app/cart/api.py', 20, 'cart.errors.CartError: bad cart'),
    ].join('\n');
    const t = parseTrace(text)!;
    expect([t.errorType, t.message]).toEqual([
      'cart.errors.CartError',
      'bad cart',
    ]);
    expect(t.frames.map((f) => f.line)).toEqual([20, 8, 3]);
    expect(t.chain).toEqual([
      {
        errorType: 'ValueError',
        message: 'bad qty',
        relation: 'cause',
        start: 1,
      },
      {
        errorType: 'KeyError',
        message: "'qty'",
        relation: 'context',
        start: 2,
      },
    ]);
  });

  it('drops the chain when a block has no error line', () => {
    const text = [
      'Traceback (most recent call last):',
      '  File "/srv/app/cart/total.py", line 8, in total',
      '',
      CAUSE,
      '',
      ...pyBlock('/srv/app/cart/api.py', 20, 'ValueError: bad qty'),
    ].join('\n');
    const t = parseTrace(text)!;
    expect(t).not.toHaveProperty('chain');
    expect(t.errorType).toBe('ValueError');
    expect(t.frames.map((f) => f.line)).toEqual([20, 8]);
  });

  it('takes the last error line of a frameless cause block, not log noise', () => {
    const text = [
      'ConnectionError: retrying',
      "KeyError: 'k'",
      '',
      CAUSE,
      '',
      ...pyBlock('/srv/app/cart/api.py', 20, 'ValueError: bad qty'),
    ].join('\n');
    const t = parseTrace(text)!;
    expect(t.errorType).toBe('ValueError');
    expect(t.chain).toEqual([
      { errorType: 'KeyError', message: "'k'", relation: 'cause', start: 1 },
    ]);
  });

  it('adds no chain key to an unchained trace', () => {
    expect(parseTrace(V8_TRACE)).not.toHaveProperty('chain');
    expect(parseTrace(PY_TRACE)).not.toHaveProperty('chain');
  });
});
