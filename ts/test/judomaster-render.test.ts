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
