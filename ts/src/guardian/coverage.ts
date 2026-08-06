/**
 * Tiered, agent-free coverage-fidelity resolution for the PR guardian.
 *
 * Faithful TypeScript port of `agent/guardian/coverage.py`.
 *
 * Phase 1 (Tier 0) — resolves diff-coverage for a changed unit at the highest
 * available fidelity: an explicit coverage **report** beats a **graph**-derived
 * signal beats a naming **heuristic**. Each result is labeled with its
 * {@link Fidelity} so downstream findings can communicate confidence.
 *
 * SC-11 boundary: this module imports **no** agent/LLM module and never
 * references the `analyze_diff`/`get_impact` MCP tools. Graph coverage reads
 * the NDJSON `.harness/graph/graph.json` directly.
 *
 * Python→TS nuances (see the module-porting notes for the migration):
 *   - **XML**: Node has no built-in XML parser. The Cobertura reader is a
 *     minimal, targeted scanner pinned to the canonical
 *     `<coverage>...<class filename="..."><line number hits/>` shape. The
 *     entity-expansion / oversize / DOCTYPE guards are pre-parse *string*
 *     checks, so no XML library is involved in the security boundary.
 *   - **int vs. number**: `JSON.parse` collapses `3.0` to the integer `3`
 *     (JS has no int/float distinction), so — unlike Python's `json` — a
 *     literal `3.0` in a coverage-json cannot be rejected as "not an integer".
 *     Genuine non-integers (`3.7`) and booleans/strings are still rejected.
 *   - **UTF-8**: `read_text(encoding="utf-8")` raises on invalid bytes; Node's
 *     `readFileSync(path, 'utf-8')` silently substitutes U+FFFD. The report
 *     reader decodes with a *fatal* `TextDecoder` to preserve the Python
 *     "non-UTF-8 report → fall through" behavior.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, extname, join, posix } from 'node:path';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** Confidence tier of a coverage signal (lower rank == higher fidelity). */
export enum Fidelity {
  CoverageVerified = 'coverage-verified',
  GraphVerified = 'graph-verified',
  Heuristic = 'heuristic',
}

const FIDELITY_RANK: Record<Fidelity, number> = {
  [Fidelity.CoverageVerified]: 0,
  [Fidelity.GraphVerified]: 1,
  [Fidelity.Heuristic]: 2,
};

/** 0=coverage, 1=graph, 2=heuristic. Lower means higher fidelity. */
export function fidelityRank(fidelity: Fidelity): number {
  return FIDELITY_RANK[fidelity];
}

/** Inclusive, 1-based `[start, end]` line range. */
export type LineRange = [number, number];

/**
 * A file changed by a diff, with the line ranges it *added*.
 *
 * `added_ranges` are inclusive, 1-based `[start, end]` line ranges.
 */
export interface ChangedUnit {
  path: string;
  added_ranges: LineRange[];
  symbol?: string;
}

/** The resolved coverage verdict for a single {@link ChangedUnit}. */
export interface CoverageResult {
  unit: ChangedUnit;
  covered: boolean;
  fidelity: Fidelity;
  evidence: string;
  uncovered_lines: number[];
}

/**
 * Build a {@link CoverageResult}, defaulting `uncovered_lines` to `[]`. Stands
 * in for the Python dataclass's `field(default_factory=list)` — the graph and
 * heuristic tiers never populate uncovered lines and rely on that default.
 */
function makeResult(
  fields: Omit<CoverageResult, 'uncovered_lines'> & {
    uncovered_lines?: number[];
  },
): CoverageResult {
  return { ...fields, uncovered_lines: fields.uncovered_lines ?? [] };
}

/** `{path: {line: hits}}` — one report's per-line hit counts. */
type LineHits = Record<number, number>;
type ReportIndex = Record<string, LineHits>;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Split like Python's `str.splitlines()` for the common line endings. */
function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/**
 * Parse an integer the way Python's `int(str)` does for our inputs: optional
 * surrounding whitespace and sign, digits only. Returns `null` on failure
 * (Python would raise `ValueError`, which the callers catch-and-skip).
 */
function pyInt(value: string): number | null {
  const trimmed = value.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) return null;
  return Number.parseInt(trimmed, 10);
}

/** bool is excluded (a JSON true/false is not a valid line/hit count). */
function isInt(value: unknown): value is number {
  // typeof boolean !== 'number', so booleans are already excluded here — the
  // JS analog of Python's explicit `not isinstance(value, bool)` guard.
  return typeof value === 'number' && Number.isInteger(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Flatten inclusive `[start, end]` ranges into a sorted, de-duped line list. */
function expandRanges(ranges: LineRange[]): number[] {
  const lines = new Set<number>();
  for (const [start, end] of ranges) {
    for (let ln = start; ln <= end; ln++) lines.add(ln);
  }
  return [...lines].sort((a, b) => a - b);
}

/** Python's `Path(p).stem`: basename minus its final extension. */
function stem(path: string): string {
  const base = basename(path);
  const ext = extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}

/**
 * True iff `candidate` and `target` name the same file path suffix.
 *
 * Exact match, or one is a suffix of the other on a **path-separator boundary**
 * (`a/b/foo.py` vs `foo.py`). Rejects loose substring collisions such as
 * `foobar.py` vs `bar.py` and `usermodels.py` vs `models.py` (FIX 6).
 */
function pathBoundaryMatch(candidate: string, target: string): boolean {
  return (
    candidate === target ||
    candidate.endsWith('/' + target) ||
    target.endsWith('/' + candidate)
  );
}

/**
 * Look up per-line hit counts for `path` in a report index.
 *
 * Prefers an EXACT path match. Otherwise falls back to a **boundary** suffix
 * match (report paths may be absolute, `./`-prefixed, or repo-relative). On
 * multiple boundary matches (duplicate basenames) the lookup is ambiguous and
 * returns `null` — the unit is then skipped and falls through rather than
 * binding to an arbitrary first match (FIX 6).
 */
function matchHits(path: string, index: ReportIndex): LineHits | null {
  if (path in index) return index[path]!;
  const matches: LineHits[] = [];
  for (const [reportPath, hits] of Object.entries(index)) {
    if (pathBoundaryMatch(reportPath, path)) matches.push(hits);
  }
  return matches.length === 1 ? matches[0]! : null;
}

/** Render ranges compactly, e.g. `[[12, 28], [30, 30]]` → `"12-28, 30"`. */
function rangesStr(ranges: LineRange[]): string {
  return ranges
    .map(([start, end]) => (start === end ? `${start}` : `${start}-${end}`))
    .join(', ');
}

// ---------------------------------------------------------------------------
// LCOV
// ---------------------------------------------------------------------------

/** Parse `lcov.info` into `{path: {line: hits}}`. */
function parseLcov(text: string): ReportIndex {
  const index: ReportIndex = {};
  let current: string | null = null;
  for (const line of splitLines(text)) {
    if (line.startsWith('SF:')) {
      current = line.slice(3).trim();
      if (!(current in index)) index[current] = {};
    } else if (line.startsWith('DA:') && current !== null) {
      const body = line.slice(3).trim();
      const parts = body.split(',');
      if (parts.length >= 2) {
        const lineno = pyInt(parts[0]!);
        const hits = pyInt(parts[1]!);
        if (lineno === null || hits === null) continue;
        index[current]![lineno] = hits;
      }
    } else if (line.trim() === 'end_of_record') {
      current = null;
    }
  }
  return index;
}

// ---------------------------------------------------------------------------
// coverage-json
// ---------------------------------------------------------------------------

// The coverage-json contract version this build understands. Bumped only on a
// breaking change; the shape evolves additively (see
// docs/specs/coverage-json-contract.md).
export const COVERAGE_JSON_SCHEMA_VERSION = 1;

/**
 * Parse the canary coverage-json shape into `{path: {line: hits}}`.
 *
 * Supports `{"files": {"<path>": {"covered_lines": [...]}}}` and the same with
 * an explicit `line_hits` mapping. Unrecognized structure, or a
 * `schema_version` this build does not understand, → `null`. The v1 contract
 * is enforced strictly (integers only, 1-based lines, non-negative hits) so
 * this parser and {@link validateCoverageJson} stay in lockstep.
 */
export function parseCoverageJson(data: unknown): ReportIndex | null {
  if (!isRecord(data)) return null;
  // Refuse a version we don't understand rather than silently consuming its
  // v1-compatible parts and mislabeling the result coverage-verified.
  const version = data['schema_version'];
  if (
    version !== undefined &&
    version !== null &&
    !(isInt(version) && version === COVERAGE_JSON_SCHEMA_VERSION)
  ) {
    return null;
  }
  const files = data['files'];
  if (!isRecord(files)) return null;

  const index: ReportIndex = {};
  for (const [path, entry] of Object.entries(files)) {
    if (!isRecord(entry)) continue;
    const hits: LineHits = {};
    const authoritative = new Set<number>(); // lines line_hits recorded (may be 0)

    const lineHits = entry['line_hits'];
    if (isRecord(lineHits)) {
      for (const [k, v] of Object.entries(lineHits)) {
        // Integers only, 1-based line, non-negative hits (see docstring).
        if (!(isInt(v) && v >= 0)) continue;
        const lineno = pyInt(k);
        if (lineno === null) continue;
        if (lineno < 1) continue;
        hits[lineno] = v;
        authoritative.add(lineno);
      }
    }

    const covered = entry['covered_lines'];
    if (Array.isArray(covered)) {
      for (const lineno of covered) {
        if (!(isInt(lineno) && lineno >= 1)) continue;
        // line_hits is authoritative: covered_lines may add a line it didn't
        // mention, but never override an explicit hit count (so a `{"14": 0}`
        // unhit line stays uncovered).
        if (!authoritative.has(lineno)) hits[lineno] = 1;
      }
    }
    index[String(path)] = hits;
  }
  return index;
}

/**
 * One issue found validating a coverage-json document against the contract.
 *
 * `error`   — {@link parseCoverageJson} cannot use this (whole doc → null, or
 * a file entry is dropped): coverage is *lost*.
 * `warning` — the parser ignores a sub-part but still uses the rest: coverage
 * is *degraded*, not lost.
 */
export interface CoverageProblem {
  severity: 'error' | 'warning';
  location: string;
  message: string;
}

/**
 * Validate a coverage-json document against the v1 producer contract.
 *
 * Reports, loudly, exactly what {@link parseCoverageJson} would silently
 * accept-and-drop, at two severities. Never raises and never mutates — it is a
 * lint for producers, mirroring the parser it lives beside so the two cannot
 * drift.
 */
export function validateCoverageJson(data: unknown): CoverageProblem[] {
  const problems: CoverageProblem[] = [];
  const err = (location: string, message: string): void => {
    problems.push({ severity: 'error', location, message });
  };
  const warn = (location: string, message: string): void => {
    problems.push({ severity: 'warning', location, message });
  };

  if (!isRecord(data)) {
    err('(root)', 'top-level value must be a JSON object');
    return problems;
  }

  const version = data['schema_version'];
  if (
    version !== undefined &&
    version !== null &&
    !(isInt(version) && version === COVERAGE_JSON_SCHEMA_VERSION)
  ) {
    err(
      'schema_version',
      `unsupported schema_version ${repr(version)}; this build understands ` +
        `v${COVERAGE_JSON_SCHEMA_VERSION} (omit the field to default to it)`,
    );
  }

  const files = data['files'];
  if (files === undefined || files === null) {
    err('files', "missing required 'files' object");
    return problems;
  }
  if (!isRecord(files)) {
    err('files', "'files' must be an object mapping path -> coverage");
    return problems;
  }

  for (const [path, entry] of Object.entries(files)) {
    const loc = `files['${path}']`;
    if (!isRecord(entry)) {
      err(loc, "entry must be an object; this file's coverage is dropped");
      continue;
    }

    const lineHits = entry['line_hits'];
    const covered = entry['covered_lines'];
    // Mirror the parser's surviving hit map so the verdict is bound to what
    // the parser actually keeps.
    const recorded: LineHits = {};

    if (lineHits !== undefined && lineHits !== null) {
      if (!isRecord(lineHits)) {
        warn(
          `${loc}.line_hits`,
          'must be an object mapping line -> hits; ignored',
        );
      } else {
        for (const [k, v] of Object.entries(lineHits)) {
          const kloc = `${loc}.line_hits['${k}']`;
          if (!isInt(v)) {
            warn(kloc, `hits ${repr(v)} is not an integer; dropped`);
            continue;
          }
          if (v < 0) {
            warn(kloc, `hits ${v} is negative; dropped`);
            continue;
          }
          const lineno = pyInt(k);
          if (lineno === null) {
            warn(kloc, 'line key is not an integer; dropped');
            continue;
          }
          if (lineno < 1) {
            warn(kloc, 'line number must be >= 1; dropped');
            continue;
          }
          recorded[lineno] = v;
        }
      }
    }

    if (covered !== undefined && covered !== null) {
      if (!Array.isArray(covered)) {
        warn(
          `${loc}.covered_lines`,
          'must be an array of line numbers; ignored',
        );
      } else {
        covered.forEach((lineno, i) => {
          const cloc = `${loc}.covered_lines[${i}]`;
          if (!isInt(lineno)) {
            warn(cloc, `${repr(lineno)} is not an integer; dropped`);
            return;
          }
          if (lineno < 1) {
            warn(cloc, 'line number must be >= 1; dropped');
            return;
          }
          if (lineno in recorded) {
            if (recorded[lineno] === 0) {
              warn(
                cloc,
                `line ${lineno} is also in line_hits as unhit (0); ` +
                  'line_hits wins, so it stays uncovered',
              );
            }
            // a positive line_hits count makes this entry redundant
          } else {
            recorded[lineno] = 1;
          }
        });
      }
    }

    if (Object.keys(recorded).length === 0) {
      warn(loc, 'no usable coverage lines; contributes nothing');
    }
  }

  return problems;
}

/** Rough analog of Python's `repr()` for scalar diagnostic values. */
function repr(value: unknown): string {
  if (typeof value === 'string') return `'${value}'`;
  // Match Python's `{v!r}` spelling of the JSON scalars so warning messages
  // read byte-for-byte like the oracle (true→True, false→False, null→None).
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (value === null) return 'None';
  return String(value);
}

// ---------------------------------------------------------------------------
// Cobertura XML
// ---------------------------------------------------------------------------

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
function parseCobertura(text: string): ReportIndex | null {
  if (text.length > coverageLimits.maxReportBytes) return null;
  // Reject any internal-subset DOCTYPE that declares entities. Scan the FULL
  // (already size-capped) text: a leading comment can push the DOCTYPE past
  // any fixed window, so a windowed check is bypassable.
  if (text.includes('<!DOCTYPE') && text.includes('<!ENTITY')) return null;

  // Reject malformed XML up front, matching Python's `ET.fromstring` raising
  // `ParseError` → the caller falls through to a lower-fidelity tier. Without
  // this, a lenient scanner would happily extract coverage from a broken
  // document, flipping both the fidelity tier AND the covered/uncovered verdict
  // relative to the oracle.
  if (!isWellFormedXml(text)) return null;

  // Pin to the canonical (namespace-free) Cobertura root; anything else is a
  // different XML format and is rejected rather than guessed at. Strip comments
  // first so a `<foo>` inside a comment can't masquerade as the root element.
  const withoutComments = text.replace(/<!--[\s\S]*?-->/g, '');
  const rootMatch = /<(?![?!])([A-Za-z_][\w.:-]*)/.exec(withoutComments);
  if (rootMatch === null || rootMatch[1] !== 'coverage') return null;

  const index: ReportIndex = {};
  // Walk each <class> open tag. A self-closing `<class .../>` is an empty class
  // (its filename recorded, no lines) — critically, it must NOT be paired with
  // the NEXT class's `</class>`, or that class's lines bind to the wrong file.
  // Cobertura classes never nest, so for a real open tag the first following
  // `</class>` is the correct close.
  const CLOSE = '</class>';
  const classOpenRe = /<class\b([^>]*?)(\/?)>/g;
  for (
    let cls = classOpenRe.exec(withoutComments);
    cls !== null;
    cls = classOpenRe.exec(withoutComments)
  ) {
    const attrs = cls[1]!;
    const selfClosing = cls[2] === '/';
    let filename = attrValue(attrs, 'filename');

    if (selfClosing) {
      // Record the filename (mirrors ET's `setdefault`), but consume no body so
      // the next class keeps its own lines.
      if (filename) index[filename.replace(/\\/g, '/')] ??= {};
      continue;
    }

    const openEnd = classOpenRe.lastIndex;
    const closeIdx = withoutComments.indexOf(CLOSE, openEnd);
    if (closeIdx === -1) break; // no close (well-formed XML guarantees one)
    const body = withoutComments.slice(openEnd, closeIdx);
    classOpenRe.lastIndex = closeIdx + CLOSE.length;
    if (!filename) continue;

    // Normalize Windows separators so .NET/coverlet reports resolve against
    // POSIX-style diff paths (the path matcher only recognizes "/").
    filename = filename.replace(/\\/g, '/');
    const hitsByLine = (index[filename] ??= {});

    const lineRe = /<line\b([^>]*)>/g;
    for (let ln = lineRe.exec(body); ln !== null; ln = lineRe.exec(body)) {
      const lineAttrs = ln[1]!;
      const num = attrValue(lineAttrs, 'number');
      if (num === null) continue;
      const lineno = pyInt(num);
      const hits = pyInt(attrValue(lineAttrs, 'hits') ?? '0');
      if (lineno === null || hits === null) continue;
      // A line can appear at both method and class scope; keep the max.
      hitsByLine[lineno] = Math.max(hitsByLine[lineno] ?? 0, hits);
    }
  }

  // Drop classes that yielded no parseable lines; require at least one.
  const pruned: ReportIndex = {};
  for (const [path, hits] of Object.entries(index)) {
    if (Object.keys(hits).length > 0) pruned[path] = hits;
  }
  return Object.keys(pruned).length > 0 ? pruned : null;
}

const XML_WS = new Set([' ', '\t', '\n', '\r']);

/**
 * Minimal, non-throwing XML well-formedness check — the analog of what
 * `ET.fromstring` enforces before it will yield an element tree. Returns
 * `false` (so the caller degrades to `null`) on: an unbalanced or mismatched
 * tag, an unquoted attribute value, or a raw `&` that is not a valid entity
 * reference. Skips comments, CDATA, processing instructions, and DOCTYPE
 * declarations (entity-bearing DOCTYPEs are already rejected upstream). O(n)
 * over the size-capped input, allocation-free via sticky regexes.
 */
function isWellFormedXml(text: string): boolean {
  const n = text.length;
  const stack: string[] = [];
  const nameRe = /[A-Za-z_][\w.:-]*/y;
  const endTagRe = /([A-Za-z_][\w.:-]*)[ \t\n\r]*>/y;
  const attrNameEqRe = /[A-Za-z_][\w.:-]*[ \t\n\r]*=[ \t\n\r]*/y;
  const entityRe = /(?:#[0-9]+|#x[0-9A-Fa-f]+|[A-Za-z_][\w.-]*);/y;
  let i = 0;

  while (i < n) {
    const ch = text[i]!;
    if (ch === '<') {
      if (text.startsWith('<!--', i)) {
        const end = text.indexOf('-->', i + 4);
        if (end === -1) return false;
        i = end + 3;
      } else if (text.startsWith('<![CDATA[', i)) {
        const end = text.indexOf(']]>', i + 9);
        if (end === -1) return false;
        i = end + 3;
      } else if (text.startsWith('<?', i)) {
        const end = text.indexOf('?>', i + 2);
        if (end === -1) return false;
        i = end + 2;
      } else if (text.startsWith('<!', i)) {
        // DOCTYPE / declaration; skip to the matching top-level '>', honoring an
        // internal-subset '[ ... ]' whose contents may contain '>'.
        i += 2;
        let depth = 0;
        let closed = false;
        while (i < n) {
          const c = text[i]!;
          if (c === '[') depth++;
          else if (c === ']') {
            if (depth > 0) depth--;
          } else if (c === '>' && depth === 0) {
            i++;
            closed = true;
            break;
          }
          i++;
        }
        if (!closed) return false;
      } else if (text.startsWith('</', i)) {
        endTagRe.lastIndex = i + 2;
        const m = endTagRe.exec(text);
        if (m === null) return false;
        if (stack.pop() !== m[1]) return false;
        i = endTagRe.lastIndex;
      } else {
        // Start tag or self-closing element.
        nameRe.lastIndex = i + 1;
        const nm = nameRe.exec(text);
        if (nm === null) return false;
        const name = nm[0];
        i = nameRe.lastIndex;
        let closed = false;
        while (i < n) {
          while (i < n && XML_WS.has(text[i]!)) i++;
          if (i >= n) return false;
          if (text[i] === '>') {
            stack.push(name);
            i++;
            closed = true;
            break;
          }
          if (text[i] === '/' && text[i + 1] === '>') {
            i += 2;
            closed = true;
            break;
          }
          attrNameEqRe.lastIndex = i;
          const am = attrNameEqRe.exec(text);
          if (am === null) return false; // junk or a valueless attribute
          i = attrNameEqRe.lastIndex;
          const q = text[i];
          if (q !== '"' && q !== "'") return false; // unquoted attribute value
          const close = text.indexOf(q, i + 1);
          if (close === -1) return false;
          i = close + 1;
        }
        if (!closed) return false;
      }
    } else if (ch === '&') {
      entityRe.lastIndex = i + 1;
      if (entityRe.exec(text) === null) return false; // raw '&' not an entity
      i = entityRe.lastIndex;
    } else {
      i++;
    }
  }
  return stack.length === 0;
}

/** Extract an XML attribute value (double- or single-quoted) from a tag body. */
function attrValue(attrs: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`);
  const m = re.exec(attrs);
  if (m === null) return null;
  return m[2] ?? m[3] ?? '';
}

// ---------------------------------------------------------------------------
// Tier 1 — explicit report
// ---------------------------------------------------------------------------

/** Read a report file as UTF-8, returning `null` on any read/decode failure. */
function readReportText(reportPath: string): string | null {
  try {
    const buf = readFileSync(reportPath);
    // Fatal decode: a non-UTF-8 report must fall through, never raise out of
    // the guardian gate (mirrors Python's UnicodeDecodeError → None).
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

/**
 * Tier 1: resolve coverage from an explicit report (`COVERAGE_VERIFIED`).
 *
 * Supports `lcov.info` (`DA:<line>,<hits>`), the canary coverage-json shape,
 * and Cobertura `coverage.xml` (line-level). Unrecognized/empty/unreadable →
 * `null` (caller falls through to a lower fidelity tier — absence never
 * blocks).
 */
export function resolveFromReport(
  units: ChangedUnit[],
  reportPath: string,
): CoverageResult[] | null {
  const { index } = readReportIndex(reportPath);
  if (index === null) return null;
  return matchUnitsToIndex(units, index);
}

/**
 * What a coverage-report read actually yielded (#554).
 *
 * `found` is "a file exists at that path"; `index` is non-null only when the
 * file also parsed into at least one record. Keeping the two apart is the whole
 * point: "no report" and "a report we could not use" degrade identically today
 * and are separate operator problems.
 */
interface ReportRead {
  found: boolean;
  index: ReportIndex | null;
}

/** Read + parse a coverage report, reporting each step's outcome separately. */
function readReportIndex(reportPath: string): ReportRead {
  if (!existsSync(reportPath)) return { found: false, index: null };
  const text = readReportText(reportPath);
  // Present but unreadable/non-UTF-8 counts as found-and-unusable, not absent.
  if (text === null) return { found: true, index: null };

  const name = basename(reportPath).toLowerCase();
  let index: ReportIndex | null;
  if (name.endsWith('.json')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { found: true, index: null };
    }
    index = parseCoverageJson(parsed);
  } else if (name.endsWith('.info') || name.includes('lcov')) {
    index = parseLcov(text);
  } else if (name.endsWith('.xml')) {
    index = parseCobertura(text);
  } else {
    // Unrecognized format → fall through to a lower fidelity tier.
    return { found: true, index: null };
  }

  if (index === null || Object.keys(index).length === 0) {
    return { found: true, index: null };
  }
  return { found: true, index };
}

/** Resolve every unit the report index can speak to (COVERAGE_VERIFIED). */
function matchUnitsToIndex(
  units: ChangedUnit[],
  index: ReportIndex,
): CoverageResult[] {
  const results: CoverageResult[] = [];
  for (const unit of units) {
    const hits = matchHits(unit.path, index);
    if (hits === null) {
      // Unit path is nowhere in the report index → "not instrumented", which is
      // NOT the same as "instrumented and unhit". Emit no COVERAGE_VERIFIED
      // result so the orchestrator falls through to a lower-fidelity tier for
      // this unit (FIX 2).
      continue;
    }
    const added = expandRanges(unit.added_ranges);
    const uncovered = added.filter((ln) => (hits[ln] ?? 0) <= 0);
    const covered = uncovered.length === 0;
    const evidence = covered
      ? `lines ${rangesStr(unit.added_ranges)}: all covered`
      : `lines ${rangesStr(unit.added_ranges)}: ${uncovered.length} uncovered`;
    results.push(
      makeResult({
        unit,
        covered,
        fidelity: Fidelity.CoverageVerified,
        evidence,
        uncovered_lines: uncovered,
      }),
    );
  }
  return results;
}

// ---------------------------------------------------------------------------
// Tier 2 — knowledge graph
// ---------------------------------------------------------------------------

// Edge types that indicate a test exercises a source unit. The live graph
// carries no explicit `tests`/`covers` edge, so coverage is *derived* from
// calls/imports reach.
const REACH_EDGE_TYPES = new Set(['calls', 'imports']);

const TEST_PATH_RE =
  /(^|\/)tests?\/|(^|\/)test_[^/]*\.py$|\.test\.[^/]+$|\.spec\.[^/]+$/;

/**
 * True if `path` looks like a test file (`tests/**`, `test_*.py`, `*.test.*`,
 * `*.spec.*`).
 */
export function isTestPath(path: string): boolean {
  return TEST_PATH_RE.test(path);
}

/**
 * Split a basename's stem into `-`/`_`/`.`-separated components (#565).
 *
 * `playwright-fixture.ts` → `['playwright', 'fixture']`;
 * `user.fixtures.ts` → `['user', 'fixtures']`. The final extension is dropped
 * first so it never appears as a component.
 */
function basenameComponents(path: string): string[] {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return stem.split(/[-_.]/).filter((part) => part.length > 0);
}

/** Basename components that mark a file as test *support* rather than source. */
const FIXTURE_COMPONENTS: ReadonlySet<string> = new Set([
  'fixture',
  'fixtures',
]);

/**
 * True if `path` is test *infrastructure* identified by filename idiom (#565).
 *
 * {@link isTestPath} recognises tests by directory (`tests/**`) or by the
 * `*.test.*` / `*.spec.*` / `test_*.py` naming rules, and the skip layer
 * recognises fixtures by the `fixtures/` *directory* convention. Neither
 * catches a file that is test support by **name** while sitting in an ordinary
 * source directory — the measured cases being a pytest `conftest_otel.py` and a
 * Playwright `playwright-fixture.ts`, both under `scripts/otel_bootstrap/`.
 *
 * Such a file cannot host a test in the sense a coverage finding means: it *is*
 * the harness the tests run inside. Asking it for a covering test inverts the
 * relationship, so a reviewer's only correct response is 👎 — the precision
 * cost #413 and #562 both describe.
 *
 * Two deliberate narrowings:
 *
 *   - **Components, not substrings.** `conftestimonial.py` and
 *     `prefixtures.ts` are ordinary source and must survive. Matching on
 *     `-`/`_`/`.`-separated components is what pytest's own name-based
 *     resolution and the `*.fixtures.ts` idiom actually mean.
 *   - **`conftest` is Python-only.** It is pytest's resolution rule
 *     specifically; a `conftest.js` carries no framework meaning and is left as
 *     source.
 *
 * Known over-match, accepted: a production module genuinely named
 * `fixture-generator.ts` is suppressed. That trade is deliberate — a missed
 * finding on a file named after fixtures costs far less than a finding no
 * reviewer can ever act on, which is what drags `precision = TP / (TP + FP)`
 * below the promotion bar.
 *
 * Kept separate from {@link isTestPath} on purpose: that predicate also decides
 * what *confers* graph coverage, so widening it would let a conftest mark every
 * module it imports as tested — a false negative in place of a false positive.
 */
export function isTestSupportPath(path: string): boolean {
  const components = basenameComponents(path);
  if (path.endsWith('.py') && components.includes('conftest')) return true;
  return components.some((part) => FIXTURE_COMPONENTS.has(part));
}

/**
 * Extensions that denote hand-authored, executable program source (#413).
 *
 * The membership rule is deliberately simple and defensible: **a programming
 * language belongs; data, config, markup, and style do not.** `.sh` is in (it is
 * executable logic — bats/shunit2 exist); `.json`, `.yaml`, `.sql`, `.css`, and
 * `.html` are out (nothing a naming heuristic could meaningfully judge).
 *
 * A repo that disagrees at the margins tunes the glob layer
 * (`canary.guardian.pr.heuristicExclude`) rather than this list.
 */
const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  // TS/JS + component dialects.
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.vue',
  '.svelte',
  '.astro',
  // Python / Ruby / PHP / Perl / Lua.
  '.py',
  '.pyi',
  '.rb',
  '.php',
  '.pl',
  '.pm',
  '.lua',
  // JVM + .NET.
  '.java',
  '.kt',
  '.kts',
  '.scala',
  '.groovy',
  '.clj',
  '.cljs',
  '.cs',
  '.fs',
  '.vb',
  // Systems.
  '.go',
  '.rs',
  '.c',
  '.h',
  '.cc',
  '.cpp',
  '.cxx',
  '.hpp',
  '.hh',
  '.m',
  '.mm',
  '.swift',
  // Functional / scientific / other.
  '.ex',
  '.exs',
  '.erl',
  '.dart',
  '.r',
  '.jl',
  // Shell.
  '.sh',
  '.bash',
  '.zsh',
  '.ps1',
  '.psm1',
]);

/**
 * True if `path` looks like hand-authored program source (#413).
 *
 * Used to gate the Tier-3 naming heuristic. That heuristic asks "does any test
 * file reference this file's stem or a top-level symbol?" — for a config
 * dotfile, a lockfile, or a data blob there are no symbols and no test will
 * ever name it, so the verdict is structurally always "uncovered": a guaranteed
 * false positive rather than a signal. An extension-less file (`Makefile`,
 * `Dockerfile`) and a bare dotfile (`.eslintrc`) are both non-source.
 */
export function isSourcePath(path: string): boolean {
  const base = basename(path);
  // `.eslintrc` — `extname` calls this '' already, but a dotfile WITH a real
  // extension (`.eslintrc.json`) must be judged on that extension, which the
  // normal path handles.
  const ext = extname(base).toLowerCase();
  if (!ext) return false;
  return SOURCE_EXTENSIONS.has(ext);
}

/**
 * Tier 2: derive coverage from the harness knowledge graph (`GRAPH_VERIFIED`).
 *
 * The graph has no explicit `tests`/`covers` edge, so coverage is **derived**:
 * a changed file is graph-covered iff some **test-path node** reaches the
 * file's node (or a symbol node it `contains`) via a `calls`/`imports` edge.
 * Conservative by design (edge present → covered).
 *
 * `maxDepth` bounds the reverse-BFS hop distance from the changed unit's
 * node(s) to the covering test node (#320). The changed unit's nodes are depth
 * 0; their direct predecessors are depth 1; one hop of indirection is depth 2;
 * and so on. `maxDepth=1` requires a DIRECT test→source edge; `maxDepth=null`
 * is unbounded (today's behavior, byte-for-byte unchanged).
 *
 * Reads the NDJSON `graph.json` directly. Missing/empty graph → `null` (never
 * blocks).
 */
export function resolveFromGraph(
  units: ChangedUnit[],
  graphPath = '.harness/graph/graph.json',
  maxDepth: number | null = null,
): CoverageResult[] | null {
  let text: string;
  try {
    if (!existsSync(graphPath)) return null;
    // ACCEPTED DIVERGENCE: Python's `read_text(encoding="utf-8")` here can raise
    // an UNCAUGHT `UnicodeDecodeError` on a non-UTF-8 graph (the Python only
    // catches `OSError`) — a latent crash that violates the guardian's "absence
    // never blocks" contract. Node's `readFileSync(path, 'utf-8')` substitutes
    // U+FFFD instead of throwing; a replacement char inside a line just fails
    // that line's `JSON.parse` and is skipped. We intentionally KEEP the safe
    // degrade rather than reproduce the crash.
    text = readFileSync(graphPath, 'utf-8');
  } catch {
    return null;
  }
  if (text.trim() === '') return null;

  const idToPath = new Map<string, string>();
  const containsFwd = new Map<string, string[]>();
  const reachRev = new Map<string, string[]>(); // to -> [from] over calls/imports

  for (const raw of splitLines(text)) {
    const line = raw.trim();
    if (!line) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(record)) {
      // Valid JSON but not an object (e.g. `null`, `5`, `[1,2]`, `"x"`) → not a
      // node/edge record; skip it rather than crash on `.get` (FIX 3).
      continue;
    }
    const kind = record['kind'];
    if (kind === 'node') {
      const nodeId = record['id'];
      if (nodeId !== undefined && nodeId !== null) {
        const p = record['path'];
        idToPath.set(String(nodeId), typeof p === 'string' ? p : '');
      }
    } else if (kind === 'edge') {
      const etype = record['type'];
      const src = record['from'];
      const dst = record['to'];
      if (
        src === undefined ||
        src === null ||
        dst === undefined ||
        dst === null
      ) {
        continue;
      }
      const from = String(src);
      const to = String(dst);
      if (etype === 'contains') {
        push(containsFwd, from, to);
      } else if (typeof etype === 'string' && REACH_EDGE_TYPES.has(etype)) {
        push(reachRev, to, from);
      }
    }
  }

  if (idToPath.size === 0) return null;

  // Index file/symbol node ids by path (exact + suffix match support).
  const pathToIds = new Map<string, string[]>();
  for (const [nodeId, nodePath] of idToPath) {
    if (nodePath) push(pathToIds, nodePath, nodeId);
  }

  const idsForPath = (path: string): string[] => {
    const exact = pathToIds.get(path);
    if (exact !== undefined) return exact;
    // Boundary suffix match only; on a unique matched path use its ids. On
    // multiple distinct matched paths (duplicate basenames) treat as ambiguous
    // and return no ids — do NOT union unrelated nodes (FIX 6).
    const matchedPaths: string[] = [];
    for (const nodePath of pathToIds.keys()) {
      if (pathBoundaryMatch(nodePath, path)) matchedPaths.push(nodePath);
    }
    return matchedPaths.length === 1 ? pathToIds.get(matchedPaths[0]!)! : [];
  };

  const results: CoverageResult[] = [];
  for (const unit of units) {
    // Target set: the file node(s) for this unit + all symbols they contain.
    const seedIds = idsForPath(unit.path);
    if (seedIds.length === 0) {
      // Unit has no node in the graph → no graph signal. Emit nothing so the
      // orchestrator falls through to the heuristic tier (FIX 2).
      continue;
    }
    const targets = new Set<string>(seedIds);
    const frontier = [...targets];
    while (frontier.length > 0) {
      const node = frontier.pop()!;
      for (const child of containsFwd.get(node) ?? []) {
        if (!targets.has(child)) {
          targets.add(child);
          frontier.push(child);
        }
      }
    }

    // Reverse-BFS over calls/imports; a reached test-path node → covered.
    // FIX 1 (#320): a genuine FIFO BFS so first-discovery depth is the minimum;
    // a LIFO stack could stamp an intermediate node at a non-minimal depth and
    // prune it before a shorter path arrives, under-crediting coverage at
    // maxDepth >= 3.
    let coveringTest: string | null = null;
    const seen = new Set<string>(targets);
    const queue: Array<[string, number]> = [...targets].map((t) => [t, 0]);
    let head = 0;
    while (head < queue.length && coveringTest === null) {
      const [node, depth] = queue[head++]!;
      if (maxDepth !== null && depth >= maxDepth) {
        continue; // cannot expand deeper — predecessors would exceed bound
      }
      for (const source of reachRev.get(node) ?? []) {
        if (seen.has(source)) continue;
        seen.add(source);
        const sourcePath = idToPath.get(source) ?? '';
        if (sourcePath && isTestPath(sourcePath) && !targets.has(source)) {
          coveringTest = sourcePath; // test reached within maxDepth
          break;
        }
        queue.push([source, depth + 1]);
      }
    }

    const covered = coveringTest !== null;
    const evidence = covered
      ? `reached by test ${coveringTest}`
      : `no test node reaches ${unit.path} via calls/imports`;
    results.push(
      makeResult({
        unit,
        covered,
        fidelity: Fidelity.GraphVerified,
        evidence,
      }),
    );
  }
  return results;
}

function push<K>(map: Map<K, string[]>, key: K, value: string): void {
  const existing = map.get(key);
  if (existing === undefined) map.set(key, [value]);
  else existing.push(value);
}

// ---------------------------------------------------------------------------
// Tier 3 — naming/AST heuristic
// ---------------------------------------------------------------------------

/**
 * Derive candidate symbol names for a unit: the file stem plus top-level
 * `def`/`class` names. Python uses `ast` for `.py`; here a column-0 line scan
 * approximates top-level extraction (indented, nested defs are excluded, just
 * as `ast.parse(...).body` would exclude them). A cheap regex covers other
 * languages.
 *
 * KNOWN HEURISTIC-TIER LIMITATION: unlike a real AST, this lexical scan can pick
 * up a phantom `def ghost()`/`class Phantom` sitting at column 0 inside a
 * triple-quoted string or in a syntactically-broken file, yielding a false
 * heuristic-covered verdict if a test happens to mention that name. Full `ast`
 * parity is not portable to Node; this is accepted as a lowest-fidelity-tier
 * (HEURISTIC) imprecision — the report and graph tiers, which outrank it, are
 * exact. (A cheap mitigation would be to blank string literals before the scan,
 * omitted here to avoid any risk of dropping a real top-level symbol.)
 */
function extractSymbols(unitPath: string, repoRoot: string): Set<string> {
  const symbols = new Set<string>([stem(unitPath)]);
  let source: string;
  try {
    source = readFileSync(join(repoRoot, unitPath), 'utf-8');
  } catch {
    return symbols;
  }
  if (unitPath.endsWith('.py')) {
    const topLevel = /^(?:async\s+def|def|class)\s+([A-Za-z_]\w*)/gm;
    for (let m = topLevel.exec(source); m !== null; m = topLevel.exec(source)) {
      symbols.add(m[1]!);
    }
  } else {
    const decl = /\b(?:function|class|def|const|let|var)\s+([A-Za-z_]\w*)/g;
    for (let m = decl.exec(source); m !== null; m = decl.exec(source)) {
      symbols.add(m[1]!);
    }
  }
  return symbols;
}

/** Recursively list every file under `root` (sorted for determinism). */
function walkFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  walk(root);
  return out;
}

/** Relative POSIX path of `full` under `root`. */
function relPosix(root: string, full: string): string {
  const rel = full.slice(root.length).replace(/^[/\\]/, '');
  return rel.split(/[/\\]/).join(posix.sep);
}

/** Yield `[relPath, text]` for every test-looking file under `repoRoot`. */
function iterTestFiles(repoRoot: string): Array<[string, string]> {
  const all = walkFiles(repoRoot);
  const seen = new Set<string>();
  const out: Array<[string, string]> = [];

  const emit = (full: string): void => {
    if (seen.has(full)) return;
    seen.add(full);
    let text: string;
    try {
      text = readFileSync(full, 'utf-8');
    } catch {
      return;
    }
    out.push([relPosix(repoRoot, full), text]);
  };

  const matchers: Array<(base: string) => boolean> = [
    (b) => /^test_.*\.py$/.test(b),
    (b) => b.includes('.test.'),
    (b) => b.includes('.spec.'),
  ];
  for (const matches of matchers) {
    for (const full of all) {
      if (matches(basename(full))) emit(full);
    }
  }
  // Also any file living under a tests/ directory (broader net).
  for (const full of all) {
    if (!full.endsWith('.py')) continue;
    if (isTestPath(relPosix(repoRoot, full))) emit(full);
  }
  return out;
}

/**
 * Tier 3: last-resort naming/AST heuristic (`HEURISTIC`, never `null`).
 *
 * A unit is heuristic-covered iff some test file under `repoRoot` references
 * the unit's file stem or a top-level symbol name (word-boundary scan).
 */
export function resolveHeuristic(
  units: ChangedUnit[],
  repoRoot = '.',
): CoverageResult[] {
  const testFiles = iterTestFiles(repoRoot);
  const results: CoverageResult[] = [];
  for (const unit of units) {
    const symbols = extractSymbols(unit.path, repoRoot);
    // Avoid pathological single-letter stems matching everything.
    const patterns: RegExp[] = [];
    for (const sym of symbols) {
      if (sym.length >= 2) patterns.push(new RegExp(`\\b${escapeRe(sym)}\\b`));
    }
    let covering: string | null = null;
    for (const [rel, text] of testFiles) {
      // A file never counts as covering itself.
      if (rel === unit.path) continue;
      if (patterns.some((pat) => pat.test(text))) {
        covering = rel;
        break;
      }
    }
    const covered = covering !== null;
    const evidence = covered
      ? `referenced by ${covering}`
      : `no test file references ${stem(unit.path)}`;
    results.push(
      makeResult({
        unit,
        covered,
        fidelity: Fidelity.Heuristic,
        evidence,
      }),
    );
  }
  return results;
}

/** Escape a string for literal use inside a RegExp (Python's `re.escape`). */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/** Options for {@link resolveCoverage}. */
export interface ResolveCoverageOptions {
  coveragePath?: string | null;
  graphPath?: string;
  repoRoot?: string;
  graphMaxDepth?: number | null;
}

/**
 * SC-3 orchestrator: resolve each unit at the highest available fidelity.
 *
 * The ladder is applied **per unit**, not per batch. For each unit the first
 * tier that has a signal for *that* unit wins:
 *
 *   1. `coveragePath` lists the unit's path → `COVERAGE_VERIFIED`
 *   2. else a graph node for the unit exists → `GRAPH_VERIFIED`
 *   3. else the naming heuristic             → `HEURISTIC` (always returns)
 *
 * A unit absent from the report is NOT judged COVERAGE_VERIFIED-uncovered; it
 * falls through to the graph then heuristic tier (FIX 2). Returns exactly one
 * {@link CoverageResult} per input unit, in input order, fidelity-labeled.
 *
 * `graphMaxDepth` bounds the graph tier's reverse-BFS hop distance (#320) and
 * is forwarded verbatim to {@link resolveFromGraph}.
 */
export function resolveCoverage(
  units: ChangedUnit[],
  options: ResolveCoverageOptions = {},
): CoverageResult[] {
  return resolveCoverageWithInput(units, options).results;
}

/**
 * The coverage input's actual state for one run (#554).
 *
 * Every field is a count or a fact about what the run *observed*, never a
 * verdict. `unitsMatched` of `unitsTotal` is the load-bearing pair: it is the
 * denominator that tells a later reader whether "no coverage findings" meant
 * "checked and clean" or "never checked".
 */
export interface CoverageInputState {
  /** The `--coverage` path as given, or `null` when none was supplied. */
  requested: string | null;
  /** A file exists at `requested`. */
  found: boolean;
  /** That file parsed into at least one usable record. */
  parsed: boolean;
  /** How many files the parsed report carries coverage for. */
  filesInReport: number;
  /** Changed units the report actually spoke to (coverage-verified). */
  unitsMatched: number;
  /** Changed units submitted to the ladder. */
  unitsTotal: number;
}

/**
 * `verified` (the report spoke to every changed unit) | `partial` (some) |
 * `unavailable` (none — whatever the reason).
 */
export type CoverageStatus = 'verified' | 'partial' | 'unavailable';

/** Classify a {@link CoverageInputState}. Zero matched is never `verified`. */
export function coverageStatus(state: CoverageInputState): CoverageStatus {
  if (state.unitsTotal > 0 && state.unitsMatched === state.unitsTotal) {
    return 'verified';
  }
  return state.unitsMatched > 0 ? 'partial' : 'unavailable';
}

const COVERAGE_EM_DASH = '\u{2014}';
const FALLBACK_TIER = 'judged at graph/heuristic tier only';

/**
 * The human-readable degradation notice for a coverage run, or `null` when the
 * report covered every changed unit (nothing was degraded, so nothing is said).
 *
 * A run that judged nothing (`unitsTotal === 0`) also returns `null` — it makes
 * no coverage claim in either direction, and the abstention path reports it.
 */
export function coverageDegradedNotice(
  state: CoverageInputState,
): string | null {
  const { requested, found, parsed, filesInReport } = state;
  const { unitsMatched: matched, unitsTotal: total } = state;
  if (total === 0) return null;
  const status = coverageStatus(state);
  if (status === 'verified') return null;
  const dash = ` ${COVERAGE_EM_DASH} `;

  if (status === 'partial') {
    return (
      `coverage partial${dash}report at '${requested}' matched ` +
      `${matched} of ${total} changed file(s); the other ${total - matched} ` +
      FALLBACK_TIER
    );
  }
  const head = `coverage unavailable${dash}`;
  if (requested === null) {
    return `${head}no coverage report was supplied; ${total} changed file(s) ${FALLBACK_TIER}`;
  }
  if (!found) {
    return `${head}report not found at '${requested}'; ${total} changed file(s) ${FALLBACK_TIER}`;
  }
  if (!parsed) {
    return (
      `${head}report at '${requested}' yielded no usable records; ` +
      `${total} changed file(s) ${FALLBACK_TIER}`
    );
  }
  return (
    `${head}report at '${requested}' covers ${filesInReport} file(s) but ` +
    `matched 0 of ${total} changed file(s); ${FALLBACK_TIER}`
  );
}

/** {@link resolveCoverage}'s results plus the run's {@link CoverageInputState}. */
export interface ResolvedCoverage {
  results: CoverageResult[];
  coverage: CoverageInputState;
}

/**
 * {@link resolveCoverage}, additionally reporting which mode the run was in.
 *
 * Identical ladder, identical results — the only addition is the
 * {@link CoverageInputState} record, so a later reader can tell a clean result
 * from a blind one (#554).
 */
export function resolveCoverageWithInput(
  units: ChangedUnit[],
  options: ResolveCoverageOptions = {},
): ResolvedCoverage {
  const {
    coveragePath = null,
    graphPath = '.harness/graph/graph.json',
    repoRoot = '.',
    graphMaxDepth = null,
  } = options;

  // Reference-keyed map mirrors the Python `id(unit)` bookkeeping, so distinct
  // units that happen to share a path are still tracked independently.
  const resolved = new Map<ChangedUnit, CoverageResult>();
  let remaining: ChangedUnit[] = [...units];
  const coverage: CoverageInputState = {
    requested: coveragePath,
    found: false,
    parsed: false,
    filesInReport: 0,
    unitsMatched: 0,
    unitsTotal: units.length,
  };

  if (coveragePath !== null) {
    const read = readReportIndex(coveragePath);
    coverage.found = read.found;
    coverage.parsed = read.index !== null;
    coverage.filesInReport =
      read.index === null ? 0 : Object.keys(read.index).length;
    const report =
      read.index === null ? null : matchUnitsToIndex(remaining, read.index);
    // An empty array (no unit matched the report) is falsy-equivalent in the
    // Python `if report:` guard — fall through rather than lock in nothing.
    if (report !== null && report.length > 0) {
      for (const r of report) resolved.set(r.unit, r);
      coverage.unitsMatched = report.length;
      remaining = remaining.filter((u) => !resolved.has(u));
    }
  }

  if (remaining.length > 0) {
    const graph = resolveFromGraph(remaining, graphPath, graphMaxDepth);
    if (graph !== null && graph.length > 0) {
      for (const r of graph) resolved.set(r.unit, r);
      remaining = remaining.filter((u) => !resolved.has(u));
    }
  }

  if (remaining.length > 0) {
    for (const r of resolveHeuristic(remaining, repoRoot)) {
      resolved.set(r.unit, r);
    }
  }

  return { results: units.map((unit) => resolved.get(unit)!), coverage };
}
