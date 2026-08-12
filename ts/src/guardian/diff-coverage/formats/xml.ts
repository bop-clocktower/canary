/**
 * The XML primitives the Cobertura reader stands on: a non-throwing
 * well-formedness check and an attribute extractor.
 *
 * Node has no built-in XML parser, and pulling one in would put a third-party
 * parser inside the guardian's security boundary. Instead the check below is a
 * hand-rolled scanner that resolves no entities and reads no DTD.
 *
 * Structured as one dispatch per construct rather than a single loop: each
 * reader takes the current offset and returns the offset just past what it
 * consumed, or `-1` for "not well formed". That keeps the branch count of every
 * individual function low enough to reason about — the shape the 38-branch
 * original could not offer (#668).
 */

const XML_WS = new Set([' ', '\t', '\n', '\r']);

// Sticky (`y`) so each reader matches exactly at the offset it was handed, with
// no substring allocation. Every use sets `lastIndex` immediately before `exec`.
const NAME_RE = /[A-Za-z_][\w.:-]*/y;
const END_TAG_RE = /([A-Za-z_][\w.:-]*)[ \t\n\r]*>/y;
const ATTR_NAME_EQ_RE = /[A-Za-z_][\w.:-]*[ \t\n\r]*=[ \t\n\r]*/y;
const ENTITY_RE = /(?:#[0-9]+|#x[0-9A-Fa-f]+|[A-Za-z_][\w.-]*);/y;

/** "Not well formed" — the sentinel every reader below returns on failure. */
const BAD = -1;

/**
 * Minimal, non-throwing XML well-formedness check — the analog of what
 * `ET.fromstring` enforces before it will yield an element tree. Returns
 * `false` (so the caller degrades to `null`) on: an unbalanced or mismatched
 * tag, an unquoted attribute value, or a raw `&` that is not a valid entity
 * reference. Skips comments, CDATA, processing instructions, and DOCTYPE
 * declarations (entity-bearing DOCTYPEs are already rejected upstream). O(n)
 * over the size-capped input, allocation-free via sticky regexes.
 */
export function isWellFormedXml(text: string): boolean {
  const stack: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    let next: number;
    if (ch === '<') next = readMarkup(text, i, stack);
    else if (ch === '&') next = readEntity(text, i);
    else next = i + 1;
    if (next === BAD) return false;
    i = next;
  }
  return stack.length === 0;
}

/** Dispatch on which `<`-introduced construct starts at `i`. */
function readMarkup(text: string, i: number, stack: string[]): number {
  if (text.startsWith('<!--', i)) return skipPast(text, '-->', i + 4);
  if (text.startsWith('<![CDATA[', i)) return skipPast(text, ']]>', i + 9);
  if (text.startsWith('<?', i)) return skipPast(text, '?>', i + 2);
  if (text.startsWith('<!', i)) return skipDeclaration(text, i);
  if (text.startsWith('</', i)) return readEndTag(text, i, stack);
  return readStartTag(text, i, stack);
}

/** Offset just past the next `marker` at or after `from`. */
function skipPast(text: string, marker: string, from: number): number {
  const end = text.indexOf(marker, from);
  return end === BAD ? BAD : end + marker.length;
}

/**
 * Skip a DOCTYPE or other `<!` declaration to its matching top-level `>`,
 * honoring an internal-subset `[ ... ]` whose contents may contain `>`.
 */
function skipDeclaration(text: string, i: number): number {
  let depth = 0;
  for (let j = i + 2; j < text.length; j++) {
    const c = text[j]!;
    if (c === '[') depth++;
    else if (c === ']') {
      if (depth > 0) depth--;
    } else if (c === '>' && depth === 0) return j + 1;
  }
  return BAD;
}

/** Read `</name>`, requiring it to close the element on top of the stack. */
function readEndTag(text: string, i: number, stack: string[]): number {
  END_TAG_RE.lastIndex = i + 2;
  const m = END_TAG_RE.exec(text);
  if (m === null) return BAD;
  if (stack.pop() !== m[1]) return BAD;
  return END_TAG_RE.lastIndex;
}

/** Read a start tag or a self-closing element, pushing the former. */
function readStartTag(text: string, i: number, stack: string[]): number {
  NAME_RE.lastIndex = i + 1;
  const nm = NAME_RE.exec(text);
  if (nm === null) return BAD;
  const name = nm[0];
  let j = NAME_RE.lastIndex;
  while (j < text.length) {
    while (j < text.length && XML_WS.has(text[j]!)) j++;
    if (j >= text.length) return BAD;
    if (text[j] === '>') {
      stack.push(name);
      return j + 1;
    }
    if (text[j] === '/' && text[j + 1] === '>') return j + 2;
    j = readAttribute(text, j);
    if (j === BAD) return BAD;
  }
  return BAD; // ran out of input before the tag closed
}

/** Read one `name="value"` pair; rejects junk and unquoted values. */
function readAttribute(text: string, i: number): number {
  ATTR_NAME_EQ_RE.lastIndex = i;
  if (ATTR_NAME_EQ_RE.exec(text) === null) return BAD; // junk or valueless attr
  const j = ATTR_NAME_EQ_RE.lastIndex;
  const quote = text[j];
  if (quote !== '"' && quote !== "'") return BAD;
  const close = text.indexOf(quote, j + 1);
  return close === BAD ? BAD : close + 1;
}

/** Read an `&entity;` reference; a raw `&` is not well formed. */
function readEntity(text: string, i: number): number {
  ENTITY_RE.lastIndex = i + 1;
  if (ENTITY_RE.exec(text) === null) return BAD;
  return ENTITY_RE.lastIndex;
}

/** Extract an XML attribute value (double- or single-quoted) from a tag body. */
export function attrValue(attrs: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`);
  const m = re.exec(attrs);
  if (m === null) return null;
  return m[2] ?? m[3] ?? '';
}
