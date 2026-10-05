/**
 * canary-judomaster regression brief (#614). Frames are built by hand here so
 * the brief is tested apart from parsing and resolution.
 */

import { describe, expect, it } from 'vitest';

import { buildBrief } from '../src/analysis/judomaster/brief.js';
import type {
  ParsedTrace,
  ResolvedFrame,
} from '../src/analysis/judomaster/types.js';

const V8: ParsedTrace = {
  format: 'v8',
  errorType: 'TypeError',
  message: "Cannot read properties of undefined (reading 'qty')\nmore",
  frames: [],
};

const PY: ParsedTrace = {
  format: 'python',
  errorType: 'ValueError',
  message: 'bad qty',
  frames: [],
};

const external: ResolvedFrame = {
  file: '/app/node_modules/lib/index.js',
  line: 3,
  status: 'external',
};
const suspect: ResolvedFrame = {
  file: '/app/src/cart/total.ts',
  line: 12,
  column: 7,
  fn: 'cartTotal',
  status: 'resolved',
  path: 'src/cart/total.ts',
  excerpt: ['a', 'b', 'c'],
};
const pySuspect: ResolvedFrame = {
  file: '/srv/app/cart/total.py',
  line: 8,
  fn: 'total',
  status: 'stale',
  path: 'cart/total.py',
};

describe('buildBrief', () => {
  it('picks the innermost in-repo frame, skipping an external one', () => {
    const b = buildBrief(V8, [external, suspect]);
    expect(b.schema).toBe('canary-judomaster-brief/1');
    expect(b.suspect).toEqual(suspect);
    expect(b.frames).toEqual([external, suspect]);
  });

  it('uses the first line of the message as the signature', () => {
    const b = buildBrief(V8, [suspect]);
    expect(b.signature).toEqual({
      text: "Cannot read properties of undefined (reading 'qty')",
      kind: 'message',
      type: 'TypeError',
    });
  });

  it('falls back to the error type when the message is empty', () => {
    const b = buildBrief({ ...V8, message: '' }, [suspect]);
    expect(b.signature).toEqual({
      text: 'TypeError',
      kind: 'type-only',
      type: 'TypeError',
    });
  });

  it('targets vitest under tests/generated/regression for a V8 trace', () => {
    const b = buildBrief(V8, [suspect]);
    expect(b.framework).toBe('vitest');
    expect(b.outputPath).toBe(
      'tests/generated/regression/total-typeerror.test.ts',
    );
  });

  it('targets pytest for a CPython trace and accepts a stale suspect', () => {
    const b = buildBrief(PY, [pySuspect]);
    expect(b.suspect).toEqual(pySuspect);
    expect(b.framework).toBe('pytest');
    expect(b.outputPath).toBe(
      'tests/generated/regression/test_total_valueerror.py',
    );
  });

  it('writes a requirement naming the frame, signature and the rule', () => {
    const b = buildBrief(V8, [suspect]);
    expect(b.requirement).toContain('src/cart/total.ts:12');
    expect(b.requirement).toContain('cartTotal');
    expect(b.requirement).toContain(
      "Cannot read properties of undefined (reading 'qty')",
    );
    expect(b.requirement).toContain('must fail against the current code');
    expect(b.requirement).toContain('assert the correct behaviour');
    expect(b.requirement).toContain('do not quote the error text');
    expect(b.requirement).toContain(b.outputPath);
  });

  it('leaves suspect null when no frame resolved', () => {
    const missing: ResolvedFrame = {
      file: '/app/src/gone.ts',
      line: 1,
      status: 'missing',
    };
    expect(buildBrief(V8, [external, missing]).suspect).toBeNull();
  });
});

describe('buildBrief: exception chain', () => {
  const QTY = "Cannot read properties of undefined (reading 'qty')";
  const trace: ParsedTrace = {
    format: 'v8',
    errorType: 'Error',
    message: 'checkout failed',
    frames: [
      { file: '/app/src/cart/checkout.ts', line: 30 },
      { file: '/app/src/cart/total.ts', line: 12 },
    ],
    chain: [
      { errorType: 'TypeError', message: QTY, relation: 'cause', start: 1 },
    ],
  };
  const frames: ResolvedFrame[] = [
    {
      ...trace.frames[0]!,
      status: 'resolved',
      path: 'src/cart/checkout.ts',
    },
    { ...trace.frames[1]!, status: 'resolved', path: 'src/cart/total.ts' },
  ];

  it('keeps the reported suspect and signature, and gives each link its own suspect', () => {
    const b = buildBrief(trace, frames);
    expect(b.suspect!.path).toBe('src/cart/checkout.ts');
    expect(b.signature.text).toBe('checkout failed');
    expect(b.chain![0]!.suspect!.path).toBe('src/cart/total.ts');
  });

  it('names the root cause and where it was raised in the requirement', () => {
    expect(buildBrief(trace, frames).requirement).toContain(
      `The reported Error wraps a root cause, TypeError: ${QTY} at src/cart/total.ts:12; exercise the code path that raises it.`,
    );
  });

  it('adds no chain key for an unchained trace', () => {
    const { chain: _drop, ...flat } = trace;
    expect(buildBrief(flat, frames)).not.toHaveProperty('chain');
  });
});
