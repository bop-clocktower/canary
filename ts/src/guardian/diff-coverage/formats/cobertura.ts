/**
 * Cobertura `coverage.xml` reader — a minimal, targeted scanner pinned to the
 * canonical `<coverage>...<class filename="..."><line number hits/>` shape
 * rather than a general XML parser (see `./xml.ts` for why).
 */

import { attrValue, isWellFormedXml } from '../../../util/xml.js';
import {
  parseStrictInt,
  selfDescribing,
  type LineHits,
  type ReportIndex,
} from '../types.js';

// Coverage reports are semi-trusted CI artifacts, but canary distrusts input by
// default: cap size so a pathological XML cannot exhaust memory during parse.
// Exposed as a mutable object so tests can shrink the cap (the analog of the
// Python test's `monkeypatch.setattr(cov, "_MAX_REPORT_BYTES", 32)`).
export const coverageLimits = { maxReportBytes: 25 * 1024 * 1024 }; // 25 MiB

/**
 * Parse a Cobertura `coverage.xml` into `{path: {line: hits}}`.
 *
 * Line-level only — branch/`condition-coverage` data is intentionally dropped.
 * Pins to the canonical Cobertura shape emitted by coverage.py, Istanbul,
 * SimpleCov and Jacoco→Cobertura converters: a `<coverage>` root with
 * `<class filename=...>` elements carrying nested `<line number= hits=>`.
 * (Native Jacoco XML uses a `<report>` root and is *not* Cobertura — it
 * correctly returns `null`.) Any other XML → `null` so the caller falls through
 * to a lower fidelity tier (absence never blocks).
 *
 * Security: rejects oversize input and DOCTYPE entity definitions *before*
 * parsing (guards against entity-expansion / "billion laughs"). This targeted
 * scanner resolves no entities and reads no DTD, so XXE is not in scope.
 * Malformed input never throws — it degrades to `null`.
 */
export function parseCobertura(text: string): ReportIndex | null {
  const body = coberturaBody(text);
  if (body === null) return null;
  // Built as raw hit maps; every `<line>` record is a line the instrumenter
  // measured, so the recorded lines become the coverable set on the way out.
  // Null-prototype: a `filename` named `__proto__` must be a file, not a
  // handle on Object.prototype (GHSA-w522-r2v2-gcc3).
  const index: Record<string, LineHits> = Object.create(null);
  collectClasses(body, index);
  return pruneEmptyClasses(index);
}

/**
 * The markup-only document (comments, CDATA and PIs removed), or `null` if it is not a Cobertura report we
 * are willing to read: oversize, entity-bearing, malformed, or a different
 * format entirely.
 */
function coberturaBody(text: string): string | null {
  if (text.length > coverageLimits.maxReportBytes) return null;
  // Reject any internal-subset DOCTYPE that declares entities. Scan the FULL
  // (already size-capped) text: a leading comment can push the DOCTYPE past
  // any fixed window, so a windowed check is bypassable.
  if (text.includes('<!DOCTYPE') && text.includes('<!ENTITY')) return null;

  // Reject malformed XML up front, so the caller falls through to a
  // lower-fidelity tier. Without
  // this, a lenient scanner would happily extract coverage from a broken
  // document, flipping both the fidelity tier AND the covered/uncovered verdict
  // relative to the reference reader.
  if (!isWellFormedXml(text)) return null;

  // Pin to the canonical (namespace-free) Cobertura root; anything else is a
  // different XML format and is rejected rather than guessed at. Strip
  // non-markup first so a `<foo>` inside a comment, CDATA section or PI can't
  // masquerade as the root element (or, later, as a class).
  const markup = stripNonMarkup(text);
  const rootMatch = /<(?![?!])([A-Za-z_][\w.:-]*)/.exec(markup);
  if (rootMatch === null || rootMatch[1] !== 'coverage') return null;
  return markup;
}

// Comments, CDATA sections and processing instructions (the XML declaration
// too): their content is character data, never markup.
const NON_MARKUP_RE =
  /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>/g;

/**
 * Drop every comment, CDATA section and PI, so a `<class` inside one is never
 * read as a tag: paired with the next real `</class>` it would credit that
 * class's hits to the fake filename (#1360). One alternation, so whichever
 * construct opens first wins; inside it the others' markers are plain text (a
 * `<!--` in CDATA opens no comment, which separate per-construct regexes would
 * get wrong). The input has passed isWellFormedXml, so every opener has its
 * close and each lazy match is linear in its own length.
 */
function stripNonMarkup(text: string): string {
  return text.replace(NON_MARKUP_RE, '');
}

const CLOSE_CLASS = '</class>';

/**
 * Walk each `<class>` open tag, folding its lines into `index` by filename.
 *
 * A self-closing `<class .../>` is an empty class (its filename recorded, no
 * lines) — critically, it must NOT be paired with the NEXT class's
 * `</class>`, or that class's lines bind to the wrong file. Cobertura classes
 * never nest, so for a real open tag the first following `</class>` is the
 * correct close.
 */
function collectClasses(body: string, index: Record<string, LineHits>): void {
  const classOpenRe = /<class\b([^>]*?)(\/?)>/g;
  for (
    let cls = classOpenRe.exec(body);
    cls !== null;
    cls = classOpenRe.exec(body)
  ) {
    // Normalize Windows separators so .NET/coverlet reports resolve against
    // POSIX-style diff paths (the path matcher only recognizes "/").
    const raw = attrValue(cls[1]!, 'filename');
    const filename =
      raw === null ? null : decodeEntities(raw).replace(/\\/g, '/');

    if (cls[2] === '/') {
      // Record the filename (mirrors ET's `setdefault`), but consume no body so
      // the next class keeps its own lines.
      if (filename) bucketFor(index, filename);
      continue;
    }

    const openEnd = classOpenRe.lastIndex;
    const closeIdx = body.indexOf(CLOSE_CLASS, openEnd);
    // No close: unreachable once non-markup is stripped, since well-formed
    // XML then pairs every real open tag. Stop rather than guess.
    if (closeIdx === -1) return;
    classOpenRe.lastIndex = closeIdx + CLOSE_CLASS.length;
    if (!filename) continue;
    readClassLines(body.slice(openEnd, closeIdx), bucketFor(index, filename));
  }
}

// A Map, not an object literal: `&constructor;` must not resolve to a
// prototype member.
const PREDEFINED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
]);

/**
 * Decode the XML predefined entities and character references in an attribute
 * value, so `src/a&amp;b.py` names the file the diff calls `src/a&b.py`. One
 * pass, so `&amp;lt;` decodes to the literal `&lt;`, never to `<`. An unknown
 * named reference is left as written (no DTD is ever read).
 */
function decodeEntities(value: string): string {
  return value.replace(
    /&(#x[0-9A-Fa-f]+|#[0-9]+|[A-Za-z]+);/g,
    (whole, ref: string) => decodeReference(ref) ?? whole,
  );
}

/** One reference body (`amp`, `#39`, `#x27`) decoded, or `undefined`. */
function decodeReference(ref: string): string | undefined {
  if (!ref.startsWith('#')) return PREDEFINED_ENTITIES.get(ref);
  const hex = ref[1] === 'x';
  const code = Number.parseInt(ref.slice(hex ? 2 : 1), hex ? 16 : 10);
  return code <= 0x10ffff ? String.fromCodePoint(code) : undefined;
}

/** One filename's hit map, created on first mention (ET's `setdefault`). */
function bucketFor(
  index: Record<string, LineHits>,
  filename: string,
): LineHits {
  return (index[filename] ??= {});
}

/** Fold every `<line number= hits=>` in one class body into `hitsByLine`. */
function readClassLines(body: string, hitsByLine: LineHits): void {
  const lineRe = /<line\b([^>]*)>/g;
  for (let ln = lineRe.exec(body); ln !== null; ln = lineRe.exec(body)) {
    const num = attrValue(ln[1]!, 'number');
    if (num === null) continue;
    const lineno = parseStrictInt(num);
    const hits = parseStrictInt(attrValue(ln[1]!, 'hits') ?? '0');
    if (lineno === null || hits === null) continue;
    // A line can appear at both method and class scope; keep the max.
    hitsByLine[lineno] = Math.max(hitsByLine[lineno] ?? 0, hits);
  }
}

/** Drop classes that yielded no parseable lines; require at least one. */
function pruneEmptyClasses(
  index: Record<string, LineHits>,
): ReportIndex | null {
  const pruned: ReportIndex = Object.create(null);
  for (const [path, hits] of Object.entries(index)) {
    if (Object.keys(hits).length > 0) pruned[path] = selfDescribing(hits);
  }
  return Object.keys(pruned).length > 0 ? pruned : null;
}
