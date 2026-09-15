/**
 * Cobertura `coverage.xml` reader — a minimal, targeted scanner pinned to the
 * canonical `<coverage>...<class filename="..."><line number hits/>` shape
 * rather than a general XML parser (see `./xml.ts` for why).
 */

import { attrValue, isWellFormedXml } from './xml.js';
import {
  pyInt,
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
  const index: Record<string, LineHits> = {};
  collectClasses(body, index);
  return pruneEmptyClasses(index);
}

/**
 * The comment-stripped document, or `null` if it is not a Cobertura report we
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
  // relative to the oracle.
  if (!isWellFormedXml(text)) return null;

  // Pin to the canonical (namespace-free) Cobertura root; anything else is a
  // different XML format and is rejected rather than guessed at. Strip comments
  // first so a `<foo>` inside a comment can't masquerade as the root element.
  const withoutComments = stripComments(text);
  const rootMatch = /<(?![?!])([A-Za-z_][\w.:-]*)/.exec(withoutComments);
  if (rootMatch === null || rootMatch[1] !== 'coverage') return null;
  return withoutComments;
}

const CDATA_OPEN = '<![CDATA[';
const CDATA_CLOSE = ']]>';
const COMMENT_OPEN = '<!--';
const COMMENT_CLOSE = '-->';

/**
 * Drop every XML comment, leaving CDATA sections intact.
 *
 * Must not be a plain `/<!--[\s\S]*?-->/g` replace: inside CDATA those markers
 * are ordinary character data, so a document carrying `<!--` in one CDATA
 * section and `-->` in a later one would have every real element between them
 * deleted. The damage is worse than data loss — the surviving `</class>` then
 * rebinds the next class's `<line>` records to the previous class's filename,
 * so a crafted report can attribute one file's hit counts to another.
 *
 * Chunked with `indexOf` rather than scanned per character so the cost stays
 * proportional to the number of markers, not the size of the capped document.
 */
function stripComments(text: string): string {
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const cdata = text.indexOf(CDATA_OPEN, i);
    const comment = text.indexOf(COMMENT_OPEN, i);
    if (comment === -1) break;
    // A CDATA section that opens first swallows this comment marker: copy the
    // whole section verbatim and resume looking after it.
    if (cdata !== -1 && cdata < comment) {
      const end = text.indexOf(CDATA_CLOSE, cdata + CDATA_OPEN.length);
      if (end === -1) break; // unterminated CDATA — nothing further is markup
      out.push(text.slice(i, end + CDATA_CLOSE.length));
      i = end + CDATA_CLOSE.length;
      continue;
    }
    const end = text.indexOf(COMMENT_CLOSE, comment + COMMENT_OPEN.length);
    if (end === -1) break; // unterminated comment — leave the tail as-is
    out.push(text.slice(i, comment));
    i = end + COMMENT_CLOSE.length;
  }
  out.push(text.slice(i));
  return out.join('');
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
    const filename = raw === null ? null : raw.replace(/\\/g, '/');

    if (cls[2] === '/') {
      // Record the filename (mirrors ET's `setdefault`), but consume no body so
      // the next class keeps its own lines.
      if (filename) bucketFor(index, filename);
      continue;
    }

    const openEnd = classOpenRe.lastIndex;
    const closeIdx = body.indexOf(CLOSE_CLASS, openEnd);
    if (closeIdx === -1) return; // no close (well-formed XML guarantees one)
    classOpenRe.lastIndex = closeIdx + CLOSE_CLASS.length;
    if (!filename) continue;
    readClassLines(body.slice(openEnd, closeIdx), bucketFor(index, filename));
  }
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
    const lineno = pyInt(num);
    const hits = pyInt(attrValue(ln[1]!, 'hits') ?? '0');
    if (lineno === null || hits === null) continue;
    // A line can appear at both method and class scope; keep the max.
    hitsByLine[lineno] = Math.max(hitsByLine[lineno] ?? 0, hits);
  }
}

/** Drop classes that yielded no parseable lines; require at least one. */
function pruneEmptyClasses(
  index: Record<string, LineHits>,
): ReportIndex | null {
  const pruned: ReportIndex = {};
  for (const [path, hits] of Object.entries(index)) {
    if (Object.keys(hits).length > 0) pruned[path] = selfDescribing(hits);
  }
  return Object.keys(pruned).length > 0 ? pruned : null;
}
