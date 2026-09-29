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
