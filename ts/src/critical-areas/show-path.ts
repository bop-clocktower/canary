/** `\xHH` up to U+00FF, `\u{H…}` above: the code point, not its UTF-16 units. */
const escapeCodePoint = (c: string): string => {
  const cp = c.codePointAt(0) ?? 0;
  const hex = cp.toString(16);
  return cp <= 0xff ? `\\x${hex.padStart(2, '0')}` : `\\u{${hex}}`;
};

/**
 * A path from an existing map, in a tree that may not be trusted (#1575), as
 * safe terminal text. A raw control would reach the terminal: an ESC sequence
 * could rewrite the screen, a newline or U+2028 forge a line, a bidi override
 * or zero-width character reorder or hide part of a path. So every \p{C}
 * (controls, format characters, unassigned, private use, lone surrogates)
 * and line/paragraph separator is escaped. The path is double-quoted with
 * `\` and `"` escaped first, so an escape cannot be faked by a literal
 * backslash and a `, ` inside a path cannot pass for a second entry.
 * Unlike canary-unquarantine's noteField, nothing is stripped: the operator
 * should still see that the path was odd.
 */
export const showPath = (path: string): string =>
  `"${path
    .replace(/[\\"]/g, '\\$&')
    .replace(/[\p{C}\p{Zl}\p{Zp}]/gu, escapeCodePoint)}"`;
