// SV003 restoration analysis: does the file restore the global it mutates?
//
// SV003's `why` asserts persistence ("the change persists across tests").
// Dogfooding (#493) showed 37 of 51 self-scan findings were in files using
// the textbook save-in-beforeEach / restore-in-afterEach pattern -- the rule
// was asserting a consequence it never checked. This module supplies the
// check; when it finds restoration, the scanner suppresses the finding.
//
// Chosen heuristic -- deliberately conservative, because a false skip hides
// real pollution while a false flag is merely advisory noise. A mutation of
// family F (process.env / os.environ / sys.modules) with key K is considered
// restored only when there is POSITIVE evidence:
//
//  1. Snapshot write-back: the mutation's own RHS is a plain identifier (or
//     one index/property off it) that some line saves FROM the same family
//     (`saved[v] = process.env[v]`, `origCI = process.env.CI`,
//     `old = os.environ.copy()`). That line IS the restore, not a pollution.
//  2. Teardown restore: inside a teardown region, the same family is
//     restored -- assigned or deleted with key K, or with a computed key /
//     update() / clear() / Object.assign(family, ...) which restores the
//     whole family (the save-restore loop pattern).
//
// Teardown regions: JS afterEach/afterAll call bodies (paren-balanced,
// string-aware, capped at 50 lines if unclosed -- an unbalanced count must
// not swallow the file into "teardown"); Python teardown_*/tearDown* def
// bodies, code after a fixture `yield` (indentation-scoped), and addCleanup
// lines. Detection is language-agnostic like the rest of the scanner; a JS
// generator `yield` could open a phantom region, but a same-family restore
// idiom inside one is overwhelmingly teardown-intent anyway.
// PHP (#1106): tearDown*/tear_down*/wpTearDown* bodies are regions too; see
// rules.mjs for the unrestorable, pairAnywhere and wpAutoRestored families.
//
// Known non-suppressors, on purpose:
// - vi.stubEnv/vi.unstubAllEnvs and monkeypatch only undo their OWN
//   mutations, never a direct `process.env.X = ...` / `os.environ[...] =`,
//   so their presence must not launder a direct mutation. (Mutations made
//   THROUGH them never match SV003's assign patterns in the first place.)
// - `addCleanup(os.environ.pop, 'K')` (function-reference form) is not
//   recognized; only idioms where the restore call is spelled out are. A
//   missed restore is a false flag, the safe direction.

import {
  SINGLETON_FAMILIES,
  familiesFor,
  PHP_TEARDOWN_FN,
  COMMENT_LINE,
  WP_TESTCASE_BASE,
} from './rules.mjs';
import {
  stringLiteralRanges,
  inStringLiteral,
  execOutsideStrings,
} from './string-literals.mjs';

// An unclosed JS teardown region (unbalanced parens, e.g. a regex literal
// confusing the counter) extends at most this many lines past its opener.
const REGION_CAP_LINES = 50;

const splitLines = (text) => text.split(/\r\n|\r|\n/);

/** Every match of `pattern` in `line` whose start index is code. */
function execAllOutsideStrings(pattern, line, ranges) {
  const flags = pattern.flags.includes('g')
    ? pattern.flags
    : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  const matches = [];
  let match;
  while ((match = re.exec(line)) !== null) {
    if (!inStringLiteral(ranges, match.index)) matches.push(match);
    if (re.lastIndex === match.index) re.lastIndex += 1;
  }
  return matches;
}

/** 'FOO' from a quoted bracket expression; null for a computed key. */
function literalKey(expr) {
  if (expr == null) return null;
  const m = /^\s*(['"`])(.*)\1\s*$/.exec(expr);
  return m ? m[2] : null;
}

/** Key from an assign/delete match: dot-property group or bracket literal. */
function keyOf(match, family) {
  if (family.keyOf) return family.keyOf(match); // putenv NAME= (#1106)
  // process.env has (dotKey, bracketExpr); the Python families have a single
  // bracket/arg group. A dot-property is always a literal key.
  if (match.length > 2) return match[1] ?? literalKey(match[2]);
  return literalKey(match[1]);
}

/**
 * Classify the singleton mutation on `line`, if any.
 * @param {string} line
 * @param {Array<[number, number]>} ranges string ranges for `line`
 * @param {boolean} [isPhp] include the PHP families (#1106)
 * @returns {{family: string, key: string|null, rhs: string}|null}
 */
export function classifyMutation(line, ranges, isPhp = false) {
  for (const family of familiesFor(isPhp)) {
    const match = execOutsideStrings(family.assign, line, ranges);
    if (!match) continue;
    return {
      family: family.id,
      key: keyOf(match, family),
      rhs: line.slice(match.index + match[0].length),
    };
  }
  return null;
}

// The mutation's RHS must be a bare identifier plus at most one index or
// property -- `saved[v]`, `origCI`, `snap.CI` -- for write-back detection.
const RHS_IDENT = /^\s*([A-Za-z_$][\w$]*)\s*(?:\[[^\]]*\]|\.\w+)?\s*[;,]?\s*$/;

const RE_META = /[.*+?^${}()|[\]\\]/g;
const escapeRe = (s) => s.replace(RE_META, '\\$&');

/**
 * True when the mutation is a write-back from a snapshot of the same family:
 * its RHS reads a variable that some line saved from the family via a PURE
 * snapshot (`x = process.env[...]`, `x = os.environ.copy()`,
 * `x = dict(os.environ)`, `x = { ...process.env }`). Expressions
 * (`x = process.env.A + '/y'`) are not snapshots and do not count.
 * @param {{family: string, rhs: string}} mutation from classifyMutation
 * @param {string[]} lines the file's lines
 * @returns {boolean}
 */
export function isSnapshotWriteBack(mutation, lines) {
  const rhs = RHS_IDENT.exec(mutation.rhs);
  if (!rhs) return false;
  const family = SINGLETON_FAMILIES.find((f) => f.id === mutation.family);
  const saveEvidence = new RegExp(
    `(?:^|[^.\\w$])${escapeRe(rhs[1])}\\s*(?:\\[[^\\]]*\\]|\\.\\w+)?\\s*=\\s*` +
      `(?:\\{\\s*\\.\\.\\.\\s*${family.token}\\s*\\}` +
      `|dict\\(\\s*${family.token}\\s*\\)` +
      `|${family.token}(?:\\s*\\[[^\\]]*\\]|\\.\\w+\\([^)]*\\)|\\.\\w+)?` +
      `)\\s*[;,)]?\\s*$`,
  );
  return lines.some((l) => saveEvidence.test(l));
}

// --- Teardown-region collection ----------------------------------------------

const JS_TEARDOWN_TOKEN = /\b(?:afterEach|afterAll)\s*\(/;
const PY_TEARDOWN_DEF = /^(\s*)def\s+(?:teardown\w*|tearDown\w*)\s*\(/;
const PY_YIELD = /^(\s*)yield\b/;
// #733: an in-test `finally` restore is TIGHTER than an afterEach -- the
// window in which the global is dirty is the try block, not the whole test --
// yet only framework hooks counted, so the better idiom was the flagged one.
const JS_FINALLY = /\bfinally\s*\{/;
const PY_FINALLY = /^(\s*)finally\s*:/;

const indentOf = (line) => /^\s*/.exec(line)[0].length;
const isBlank = (line) => line.trim() === '';

/**
 * Balanced bodies opened at `re`, string-aware: `finally { ... }` (#733) by
 * default, afterEach/afterAll call parens, and PHP teardown methods (#1106).
 * Counting starts at the token's last char, never the line start (`} finally
 * {` opens with the TRY block's `}`), and runs on to the first opener, so an
 * Allman brace on the next line works. Capped if unclosed.
 */
function collectJsFinallyRegions(
  lines,
  rangesByLine,
  region,
  re = JS_FINALLY,
  [open, close] = '{}',
) {
  lines.forEach((line, i) => {
    const token = execOutsideStrings(re, line, rangesByLine[i]);
    if (!token) return;
    let depth = 0;
    let col = token.index + token[0].length - 1;
    for (let j = i; j < lines.length && j <= i + REGION_CAP_LINES; j += 1) {
      region.add(j);
      const text = lines[j];
      const start = j === i ? col : 0;
      for (let k = start; k < text.length; k += 1) {
        if (inStringLiteral(rangesByLine[j], k)) continue;
        if (text[k] === open) depth += 1;
        else if (text[k] === close) {
          depth -= 1;
          if (depth === 0) return;
        }
      }
    }
  });
}

// Python regions are indentation-scoped, as [opener, strict]: a def/finally
// body is indented DEEPER than its opener; post-yield code may share it.
const PY_SCOPED = [
  [PY_TEARDOWN_DEF, true],
  [PY_YIELD, false],
  [PY_FINALLY, true], // #733
];

/** Add the lines after `i` that stay inside an indentation scope. */
function addIndentScope(lines, i, indent, strict, region) {
  for (let j = i + 1; j < lines.length; j += 1) {
    const depth = indentOf(lines[j]);
    const inside = depth > indent || (!strict && depth === indent);
    if (!isBlank(lines[j]) && !inside) return;
    region.add(j);
  }
}

/** Python: teardown def bodies, post-yield code, addCleanup lines. */
function collectPyRegions(lines, rangesByLine, region) {
  lines.forEach((line, i) => {
    for (const [opener, strict] of PY_SCOPED) {
      const m = opener.exec(line);
      if (m) addIndentScope(lines, i, m[1].length, strict, region);
    }
    if (execOutsideStrings(/\baddCleanup\b/, line, rangesByLine[i])) {
      region.add(i);
    }
  });
}

/**
 * Record restores (#493): a family's idioms inside a teardown region, plus
 * (#1106) a pairAnywhere family's deletes on any code line of the file.
 */
function recordRestores(lines, rangesByLine, region, isPhp, record) {
  const families = familiesFor(isPhp);
  lines.forEach((line, i) => {
    const inRegion = region.has(i);
    const code = !COMMENT_LINE.test(line);
    for (const family of families) {
      const paired = family.pairAnywhere; // add_filter never restores itself
      const patterns = [
        ...(inRegion && !paired ? [family.assign, ...family.restoreAll] : []),
        ...(inRegion || (code && paired) ? family.deletes : []),
      ];
      for (const pattern of patterns) {
        for (const m of execAllOutsideStrings(pattern, line, rangesByLine[i])) {
          record(family.id, keyOf(m, family)); // restoreAll: no group -> null
        }
      }
    }
  });
}

/** A family-level verdict that overrides key evidence, else null (#1106). */
function familyVerdict(familyId, wpAuto) {
  const family = SINGLETON_FAMILIES.find((f) => f.id === familyId);
  if (family?.unrestorable) return false;
  if (wpAuto && family?.wpAutoRestored) return true;
  return null;
}

/**
 * Analyze which globals the file restores in teardown.
 * @param {string} text file contents
 * @param {boolean} [isPhp] enable the PHP families and regions (#1106)
 * @returns {{restores: (family: string, key: string|null) => boolean}}
 */
export function analyzeRestoration(text, isPhp = false) {
  const lines = splitLines(text);
  const rangesByLine = lines.map((l) => stringLiteralRanges(l));
  const region = new Set();
  const collect = (token, pair) =>
    collectJsFinallyRegions(lines, rangesByLine, region, token, pair);
  collect();
  // A PHP `yield` is a data provider, not fixture teardown: no Python regions.
  if (isPhp) collect(PHP_TEARDOWN_FN);
  else {
    collect(JS_TEARDOWN_TOKEN, '()');
    collectPyRegions(lines, rangesByLine, region);
  }

  const restoresAll = new Set();
  const restoredKeys = new Map(); // family id -> Set<key>
  const record = (familyId, key) => {
    if (key == null) {
      restoresAll.add(familyId);
      return;
    }
    if (!restoredKeys.has(familyId)) restoredKeys.set(familyId, new Set());
    restoredKeys.get(familyId).add(key);
  };

  recordRestores(lines, rangesByLine, region, isPhp, record);
  // D9: a WP_UnitTestCase base restores hooks and rolls back the DB.
  const wpAuto = isPhp && lines.some((l) => WP_TESTCASE_BASE.test(l));

  return {
    restores(familyId, key) {
      const verdict = familyVerdict(familyId, wpAuto);
      if (verdict !== null) return verdict;
      if (restoresAll.has(familyId)) return true;
      return key != null && (restoredKeys.get(familyId)?.has(key) ?? false);
    },
  };
}
