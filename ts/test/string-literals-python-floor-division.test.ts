import { describe, expect, it } from 'vitest';

import { blankStringContent } from '../src/core/string-literals.js';

/**
 * In Python `//` is floor division, not a comment. Read as a comment, it hides
 * the rest of its line from the blanker -- including a `"""` that opens a
 * multi-line string -- so the string's CLOSING delimiter is read as an opener
 * and its content stays visible as code.
 */
describe('blankStringContent python floor division', () => {
  it('blanks a triple-quoted string opened after `//` on the same line', () => {
    const code =
      'def test_render():\n' +
      '    out = render(width // 2, """\n' +
      'def test_fixture():\n' +
      '    pass\n' +
      '""")\n' +
      '    assert out\n';
    const out = blankStringContent(code, { python: true });
    expect(out.split('\n')[2]).toBe(' '.repeat('def test_fixture():'.length));
  });
});
