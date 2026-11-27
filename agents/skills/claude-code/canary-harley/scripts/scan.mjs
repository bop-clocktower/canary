/**
 * canary-harley -- a bracket-and-quote-aware scan over type and parameter
 * text. Every reader in this skill splits text through these two functions, so
 * a comma inside `Record<string, number>` or a `)` inside a default string
 * never ends a list early.
 */

const OPENERS = new Set(['(', '[', '{', '<']);
const CLOSERS = new Set([')', ']', '}', '>']);
const QUOTES = new Set(["'", '"', '`']);

// `=>` and `->` are arrows, not the end of a `<...>` group.
const ARROW_TAILS = new Set(['=', '-']);

/** @typedef {{ depth: number, quote: string }} ScanState */

function isCloser(ch, prev) {
  if (!CLOSERS.has(ch)) return false;
  return !(ch === '>' && ARROW_TAILS.has(prev));
}

/**
 * Advances the scan by one character.
 * @param {ScanState} state
 * @param {string} ch
 * @param {string} prev
 * @returns {ScanState}
 */
function step(state, ch, prev) {
  if (state.quote !== '') {
    const closed = ch === state.quote && prev !== '\\';
    return closed ? { depth: state.depth, quote: '' } : state;
  }
  if (QUOTES.has(ch)) return { depth: state.depth, quote: ch };
  if (OPENERS.has(ch)) return { depth: state.depth + 1, quote: '' };
  if (isCloser(ch, prev)) return { depth: state.depth - 1, quote: '' };
  return state;
}

function isSeparator(text, index, sep) {
  const ch = text[index];
  if (!sep.includes(ch)) return false;
  // The `=` of an arrow is not a default-value separator.
  return !(ch === '=' && text[index + 1] === '>');
}

/**
 * Splits `text` on any character of `sep` that sits outside every bracket and
 * quote. Parts are trimmed and empty parts are dropped.
 * @param {string} text
 * @param {string} sep one or more single-character separators
 * @returns {string[]}
 */
export function splitTopLevel(text, sep) {
  const parts = [];
  let state = { depth: 0, quote: '' };
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const atTop = state.depth === 0 && state.quote === '';
    if (atTop && isSeparator(text, i, sep)) {
      parts.push(text.slice(start, i));
      start = i + 1;
    } else {
      state = step(state, text[i], text[i - 1] ?? '');
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

/**
 * Finds the closer that matches the opener at `open`.
 * @param {string} text
 * @param {number} open index of an opening bracket
 * @returns {number} the closer's index, or -1 when the text is unbalanced
 */
export function matchClose(text, open) {
  let state = { depth: 0, quote: '' };
  for (let i = open; i < text.length; i += 1) {
    state = step(state, text[i], text[i - 1] ?? '');
    if (state.depth === 0 && state.quote === '') return i;
  }
  return -1;
}
