/**
 * Offset-preserving string-literal blanking for the static linter. #590.
 *
 * The linter regexes over raw source, so a `test(...)` written inside a STRING
 * is indistinguishable from one written in code. That is not a hypothetical:
 * the files most likely to embed test source in a fixture are the linters,
 * scanners and codemods -- exactly the tooling whose own tests you most want
 * read. A downstream overlay on 6.7.0 got four LINT-006 findings on one suite
 * and all four were data, not tests.
 *
 * Two narrower mechanisms already existed and #590 fell through the seam
 * between them:
 *
 * - `blankMultilineStrings` toggles state on an ODD count of a delimiter per
 *   line, so a template literal that opens AND closes on the same physical
 *   line is skipped entirely. A `\n`-escaped fixture is one physical line.
 * - The single-line `STRING_LITERAL` stripper has no backtick in its character
 *   class, and was never applied to the assertion scanners at all.
 *
 * This scanner reads the WHOLE source with a small state machine instead, so a
 * literal is handled the same way whether it spans one line or twenty.
 *
 * ## Why blanking rather than rejecting matches
 *
 * The sibling helper in canary-blackhawk / canary-savant
 * (`scripts/string-literals.mjs`) rejects a match whose start index falls
 * inside a literal, because those scanners need the anchor token to stay
 * visible -- blackhawk's BH003 matches `strftime('..%Z')` with the `%Z` inside
 * the quotes on purpose. LINT-006 has the opposite need: it bounds each test
 * body by the NEXT declaration's offset, so a phantom declaration inside a
 * string truncates a real test's body and its assertion is attributed past the
 * end. Suppressing the match is not enough; the text has to stop looking like
 * a declaration. Hence blanking, and hence a separate implementation rather
 * than a third copy of the `.mjs` helper.
 *
 * ## Invariants
 *
 * - Output has the SAME length and the SAME newline positions as the input, so
 *   every byte offset and computed line number stays valid.
 * - Only literal CONTENT is replaced (with spaces); the quote characters stay,
 *   so a rule keying off the delimiter still sees that a string was there.
 * - An UNTERMINATED literal is discarded, never applied. Blanking an unclosed
 *   run to end-of-file would silently disable every downstream rule from that
 *   point on -- the abstention shape, one layer inside the linter. This
 *   matches the deliberate choice already made in `blankMultilineStrings`.
 *
 * Fidelity limits (a state machine, not a parser):
 * - A regex literal containing a quote (`/['"]/`) can open a phantom string.
 *   Because an unterminated run is discarded, the usual outcome is a no-op;
 *   the residual risk is a suppressed finding, never a fabricated one.
 * - JSX text and Python f-string nesting beyond `${...}` are not modelled.
 */

export interface BlankOptions {
  /** Recognise `#` line comments and `'''`/`\"\"\"` triple-quoted blocks. */
  python?: boolean;
}

/** A resolved literal-content span, half-open: [start, end). */
type Span = [number, number];

const SPACE = ' ';

/**
 * Replace the content of every CLOSED string literal in `code` with spaces,
 * preserving length, newline positions, and the quote characters themselves.
 */
export function blankStringContent(
  code: string,
  options: BlankOptions = {},
): string {
  const spans = literalContentSpans(code, options.python === true);
  if (spans.length === 0) return code;

  const out = [...code];
  for (const [start, end] of spans) {
    for (let i = start; i < end; i += 1) {
      // Newlines survive so line numbering is unchanged; everything else goes.
      if (out[i] !== '\n') out[i] = SPACE;
    }
  }
  return out.join('');
}

/**
 * Walk `code` once and collect the content spans of every literal that closes.
 *
 * The stack holds two frame kinds: a string frame (`quote` set) whose content
 * accumulates, and an interpolation frame (`interp`) for a template's
 * `${...}`, which is CODE and may itself contain strings.
 */
function literalContentSpans(code: string, python: boolean): Span[] {
  const spans: Span[] = [];
  const stack: Frame[] = [];
  const top = (): Frame | undefined => stack[stack.length - 1];

  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i]!;
    const frame = top();

    if (frame?.kind === 'string') {
      i = advanceInsideString(code, i, frame, spans, stack);
      continue;
    }

    // Code context: top level, or inside a `${ ... }` interpolation.
    const commentEnd = skipComment(code, i, python);
    if (commentEnd !== null) {
      i = commentEnd;
      continue;
    }

    const opener = readOpener(code, i, python);
    if (opener !== null) {
      stack.push({ kind: 'string', quote: opener, start: i + opener.length });
      i += opener.length - 1;
      continue;
    }

    if (frame?.kind === 'interp') {
      if (ch === '{') frame.depth += 1;
      else if (ch === '}') {
        if (frame.depth === 0) {
          stack.pop();
          // The enclosing template resumes its content after the `}`.
          const enclosing = top();
          if (enclosing?.kind === 'string') enclosing.start = i + 1;
        } else {
          frame.depth -= 1;
        }
      }
    }
  }

  // Anything still open never closed. Discard it -- see the header.
  return spans;
}

/**
 * A string frame accumulates content; an interpolation frame is CODE and may
 * nest strings of its own. Splitting them keeps `depth` off the string case,
 * where brace nesting has no meaning.
 */
type Frame =
  | { kind: 'string'; quote: string; start: number }
  | { kind: 'interp'; depth: number };

/**
 * Handle one character while inside a string frame. Returns the index the main
 * loop should continue FROM (it will be incremented), so escape pairs and
 * multi-character delimiters are consumed atomically.
 */
function advanceInsideString(
  code: string,
  i: number,
  frame: Extract<Frame, { kind: 'string' }>,
  spans: Span[],
  stack: Frame[],
): number {
  const ch = code[i]!;

  // An escaped character is content and can never close the literal. Python
  // raw strings are not modelled; treating `\` as an escape there costs at
  // most a suppressed match, never a fabricated one.
  if (ch === '\\') return i + 1;

  if (code.startsWith(frame.quote, i)) {
    pushSpan(spans, frame.start, i);
    stack.pop();
    return i + frame.quote.length - 1;
  }

  // Template interpolation closes the current content run and opens code.
  if (frame.quote === '`' && ch === '$' && code[i + 1] === '{') {
    pushSpan(spans, frame.start, i);
    stack.push({ kind: 'interp', depth: 0 });
    return i + 1;
  }

  return i;
}

/** Record a content span, skipping empty ones. */
function pushSpan(spans: Span[], start: number, end: number): void {
  if (end > start) spans.push([start, end]);
}

/**
 * If a comment starts at `i`, return the index of its last character so the
 * caller can skip it. Quotes inside a comment are prose, not delimiters: an
 * apostrophe in "don't" would otherwise open a phantom literal.
 */
function skipComment(code: string, i: number, python: boolean): number | null {
  if (python && code[i] === '#') return endOfLine(code, i);
  if (code[i] !== '/') return null;
  if (code[i + 1] === '/') return endOfLine(code, i);
  if (code[i + 1] === '*') {
    const close = code.indexOf('*/', i + 2);
    // An unterminated block comment runs to EOF; that IS how the language
    // reads it, so unlike an unclosed string there is nothing to discard.
    return close === -1 ? code.length - 1 : close + 1;
  }
  return null;
}

function endOfLine(code: string, i: number): number {
  const nl = code.indexOf('\n', i);
  return nl === -1 ? code.length - 1 : nl - 1;
}

/**
 * Return the delimiter opening at `i`, longest first so a Python triple quote
 * is never mistaken for an empty string followed by an opener.
 */
function readOpener(code: string, i: number, python: boolean): string | null {
  if (python) {
    if (code.startsWith('"""', i)) return '"""';
    if (code.startsWith("'''", i)) return "'''";
  }
  const ch = code[i]!;
  if (ch === "'" || ch === '"') return ch;
  if (!python && ch === '`') return '`';
  return null;
}
