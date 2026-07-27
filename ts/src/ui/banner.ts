/**
 * CLI startup banner -- faithful TypeScript port of `agent/ui/banner.py`.
 *
 * The Python banner writes raw ANSI escape codes with `print()` (NOT rich), so
 * it never strips color for a non-TTY sink -- the bytes are identical whether
 * stdout is a terminal or a captured test buffer. This port reproduces those
 * exact bytes: the ESC byte (Python `\033`) as `\u{1b}`, the SGR sequences
 * verbatim, and the box-drawing glyphs as `\u{...}` escapes (ASCII-source rule).
 *
 * Only `renderBanner` is ported -- it is all the CLI's `version` command and
 * `--version` option need. `print_result_line` / `print_section` are unused by
 * the CLI and intentionally omitted.
 */

const ESC = '\u{1b}';
const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;

// Canary gold (#F0C040) and the supporting palette (true-color SGR).
const GOLD = `${ESC}[38;2;240;192;64m`;
const AMBER = `${ESC}[38;2;192;144;24m`;
const WHITE = `${ESC}[38;2;245;245;245m`;
const MUTED = `${ESC}[38;2;85;85;85m`;
const DARK = `${ESC}[38;2;46;46;46m`;

// Bird mark (3-line ASCII-art): U+25B2 up-triangle, U+2588 full block,
// U+2580 upper-half block.
const BIRD = [
  `${GOLD}  \u{25b2}${RESET}`,
  `${GOLD} \u{25b2}\u{2588}\u{25b2}${RESET}`,
  `${AMBER}  \u{2580}${RESET}`,
];

const TAGLINE = 'test automation agent';
// U+00B7 middle dot separator.
const NETWORK = 'birds of prey network \u{00b7} clocktower voice system';
const RULE = '\u{2500}'.repeat(44); // U+2500 box drawings light horizontal

/**
 * Render the Canary startup banner as a single string (no trailing newline;
 * the caller's line sink adds one, matching Python `print(banner)`).
 */
export function renderBanner(version: string): string {
  const divider = `${DARK}${RULE}${RESET}`;
  const lines = [
    '',
    `  ${BIRD[0]}   ${BOLD}${WHITE}canary${RESET}  ${GOLD}v${version}${RESET}`,
    `  ${BIRD[1]}   ${MUTED}${TAGLINE}${RESET}`,
    `  ${BIRD[2]}   ${DARK}${NETWORK}${RESET}`,
    `       ${divider}`,
    '',
  ];
  return lines.join('\n');
}
