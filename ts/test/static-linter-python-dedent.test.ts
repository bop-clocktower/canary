import { describe, expect, it } from 'vitest';

import { enumerateTests } from '../src/core/static-linter.js';

/**
 * A Python test's body ends where the code dedents to (or past) its own
 * `def`. Bounding it only at the next `def` at EXACTLY the same indent let a
 * class-method test run on past its class into a later module-level test, and
 * borrow that test's `assert` -- so an assertion-free test escaped LINT-006.
 */
describe('enumerateTests python body boundary', () => {
  it('ends a method test body at a dedented module-level def', () => {
    const code =
      'class TestA:\n' +
      '    def test_empty(self):\n' +
      '        pass\n' +
      '\n' +
      '\n' +
      'def test_other():\n' +
      '    assert 1 == 1\n';
    const empty = enumerateTests(code, code, true).find(
      (t) => t.name === 'test_empty',
    );
    expect(empty?.body).not.toContain('assert');
  });
});
