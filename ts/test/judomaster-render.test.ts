/**
 * canary-judomaster markdown renderers (#614).
 */

import { describe, expect, it } from 'vitest';

import {
  renderBrief,
  renderVerify,
} from '../src/analysis/judomaster/render.js';
import type { RegressionBrief } from '../src/analysis/judomaster/types.js';

const BRIEF: RegressionBrief = {
  schema: 'canary-judomaster-brief/1',
  format: 'v8',
  errorType: 'TypeError',
  message: "Cannot read properties of undefined (reading 'qty')",
  signature: {
    text: "Cannot read properties of undefined (reading 'qty')",
    kind: 'message',
  },
  suspect: {
    file: '/app/src/cart/total.ts',
    line: 12,
    fn: 'cartTotal',
    status: 'resolved',
    path: 'src/cart/total.ts',
    excerpt: ['  const items = cart.items;', '  return items[0].qty;'],
  },
  frames: [
    {
      file: '/app/node_modules/lib/index.js',
      line: 3,
      status: 'external',
    },
    {
      file: '/app/src/cart/total.ts',
      line: 12,
      fn: 'cartTotal',
      status: 'resolved',
      path: 'src/cart/total.ts',
    },
    {
      file: '/app/src/cart/old.ts',
      line: 90,
      status: 'stale',
      path: 'src/cart/old.ts',
    },
    { file: '/app/src/gone.ts', line: 4, status: 'missing' },
  ],
  framework: 'vitest',
  outputPath: 'tests/generated/regression/total-typeerror.test.ts',
  requirement: 'Write one vitest regression test for src/cart/total.ts:12.',
};

describe('renderBrief', () => {
  const md = renderBrief(BRIEF);

  it('names the suspect, signature and its kind', () => {
    expect(md).toContain('src/cart/total.ts:12');
    expect(md).toContain('cartTotal');
    expect(md).toContain(BRIEF.signature.text);
    expect(md).toContain('message');
  });

  it('names every non-resolved frame with its status', () => {
    expect(md).toContain('/app/node_modules/lib/index.js:3');
    expect(md).toContain('external');
    expect(md).toContain('src/cart/old.ts:90');
    expect(md).toContain('stale');
    expect(md).toContain('/app/src/gone.ts:4');
    expect(md).toContain('missing');
  });

  it('carries the requirement, output path and excerpt', () => {
    expect(md).toContain(BRIEF.requirement);
    expect(md).toContain(BRIEF.outputPath);
    expect(md).toContain('return items[0].qty;');
  });
});

describe('renderVerify', () => {
  it('prints each warning after the vacuity line, verdict unchanged', () => {
    const md = renderVerify({
      verdict: 'not-reproduced',
      label: 'not-reproduced',
      vacuity: true,
      reason: 'the test passed against the code it was written to catch',
      warnings: ['the test mocks the suspect module src/cart/total.ts (x)'],
    });
    const lines = md.split('\n');
    const vac = lines.findIndex((l) => l.startsWith('VACUITY RED FLAG'));
    const warn = lines.indexOf(
      'WARNING: the test mocks the suspect module src/cart/total.ts (x)',
    );
    expect(warn).toBeGreaterThan(vac);
    expect(warn).toBeLessThan(lines.findIndex((l) => l.startsWith('Reason:')));
  });

  it('puts the verdict first and flags vacuity', () => {
    const md = renderVerify({
      verdict: 'not-reproduced',
      label: 'not-reproduced',
      vacuity: true,
      reason: 'the test passed',
    });
    expect(md.split('\n')[0]).toContain('not-reproduced');
    expect(md).toContain(
      'VACUITY RED FLAG: the test passed against the code it was written to catch',
    );
  });

  it('prints the unverified label verbatim and no vacuity flag', () => {
    const md = renderVerify({
      verdict: 'unverified',
      label: 'unverified — could not reproduce',
      vacuity: false,
      reason: 'the run timed out',
    });
    expect(md.split('\n')[0]).toContain('unverified — could not reproduce');
    expect(md).toContain('the run timed out');
    expect(md).not.toContain('VACUITY');
  });

  it('shows the runner output tail when the run was not a reproduction', () => {
    const md = renderVerify({
      verdict: 'failed-other-reason',
      label: 'unverified',
      vacuity: false,
      reason: 'no signature',
      tail: ['Error: Cannot find module ./total'],
    });
    expect(md).toContain('Runner output (last 1 lines)');
    expect(md).toContain('Error: Cannot find module ./total');
  });

  it('omits the runner output on a reproduction', () => {
    const md = renderVerify({
      verdict: 'reproduced',
      label: 'reproduced',
      vacuity: false,
      reason: 'signature',
      tail: ['TypeError: boom'],
    });
    expect(md).not.toContain('Runner output');
  });

  it('labels a failed-other-reason run unverified', () => {
    const md = renderVerify({
      verdict: 'failed-other-reason',
      label: 'unverified',
      vacuity: false,
      reason: 'no signature',
    });
    expect(md.split('\n')[0]).toContain('failed-other-reason');
    expect(md).toContain('unverified');
  });
});

describe('renderBrief: exception chain', () => {
  const chained: RegressionBrief = {
    ...BRIEF,
    errorType: 'Error',
    message: 'checkout failed',
    chain: [
      {
        errorType: 'RangeError',
        message: 'mid',
        relation: 'context',
        start: 1,
        suspect: null,
      },
      {
        errorType: 'TypeError',
        message: 'qty',
        relation: 'cause',
        start: 2,
        suspect: BRIEF.frames[1]!,
      },
    ],
  };

  it('lists the chain reported first with the root cause marked', () => {
    const md = renderBrief(chained);
    expect(md).toContain('## Exception chain (reported first)');
    expect(md).toContain('1. Error: checkout failed (reported)');
    expect(md).toContain('2. while handling RangeError: mid');
    expect(md).toContain(
      '3. caused by TypeError: qty at `src/cart/total.ts:12` (root cause)',
    );
  });

  it('marks each boundary in the frame list before the link start frame', () => {
    const lines = renderBrief(chained).split('\n');
    const at = lines.indexOf('- --- while handling RangeError: mid ---');
    expect(at).toBeGreaterThan(lines.indexOf('## Frames (innermost first)'));
    expect(lines[at + 1]).toContain('src/cart/total.ts:12');
  });

  it('marks a frameless trailing cause and omits the colon on an empty message', () => {
    const md = renderBrief({
      ...BRIEF,
      chain: [
        {
          errorType: 'StopIteration',
          message: '',
          relation: 'cause',
          start: BRIEF.frames.length,
          suspect: null,
        },
      ],
    });
    const lines = md.split('\n');
    expect(lines).toContain('2. caused by StopIteration (root cause)');
    const last = lines.lastIndexOf('- --- caused by StopIteration ---');
    expect(last).toBeGreaterThan(lines.indexOf('## Frames (innermost first)'));
  });

  it('leaves an unchained brief unchanged', () => {
    const md = renderBrief(BRIEF);
    expect(md).not.toContain('Exception chain');
    expect(md).not.toContain('- ---');
  });
});
