/**
 * No silent abstention (#508) -- unit tests for the shared denominator
 * helper. The doctrine: a check that verified zero items has abstained, not
 * passed, and the CLI layer must refuse to render a success line for it.
 */

import { describe, expect, it } from 'vitest';

import {
  EXIT_ABSTAINED,
  abstentionNotice,
  isAbstention,
  successOrAbstain,
} from '../src/core/abstention.js';

describe('abstention helper (#508)', () => {
  it('reserves exit 3 for abstained gates (after 0 ok / 1 findings / 2 refusal)', () => {
    expect(EXIT_ABSTAINED).toBe(3);
  });

  it('flags a zero denominator as abstention', () => {
    expect(isAbstention({ checked: 0 })).toBe(true);
    expect(isAbstention({ checked: 1 })).toBe(false);
  });

  it('notice carries the greppable "abstained:" key and the reason', () => {
    const line = abstentionNotice('no test files matched tests/');
    expect(line).toContain('abstained:');
    expect(line).toContain('no test files matched tests/');
    expect(line).toContain('not a pass');
  });

  it('refuses the success line when nothing was checked', () => {
    const zero = successOrAbstain(
      { checked: 0 },
      'All good.',
      'zero items resolved',
    );
    expect(zero.abstained).toBe(true);
    expect(zero.line).not.toContain('All good.');
    expect(zero.line).toContain('abstained:');
  });

  it('passes the success line through when the denominator is nonzero', () => {
    const ok = successOrAbstain({ checked: 5 }, 'All good.', 'unused');
    expect(ok).toEqual({ line: 'All good.', abstained: false });
  });
});
