// Tier-1 static scanner: test sources -> shared-state suspect findings (pure).
//
// AST-lite by design -- no test execution, no parser dependency, standard
// library only -- so it ships wherever node does and runs cheaply on every PR.
// Two rules (SV001, SV002) need whole-file context, so the scan is two-pass: a
// file-level pass for those, plus a line pass for the local rules (SV003,
// SV004). See SKILL.md for the fidelity limits this buys.

import fs from 'node:fs';
import path from 'node:path';

import {
  SEVERITY,
  WHY,
  SV004_CODE_PATTERN,
  PHP_SV004_CODE_PATTERN,
  SV004_TEXT_PATTERN,
  PYTHON_SETUP_TEARDOWN,
  JS_SETUP_TEARDOWN,
  PHP_SETUP_TEARDOWN,
  PY_MODULE_MUTABLE,
  JS_MODULE_MUTABLE,
  PHP_MODULE_MUTABLE,
  PHP_STATIC_DECL,
  PHP_GLOBAL_DECL,
  mutationPattern,
  phpMutationPattern,
} from './rules.mjs';
import {
  analyzeRestoration,
  classifyMutation,
  isSnapshotWriteBack,
} from './restoration.mjs';
import {
  stringLiteralRanges,
  inStringLiteral,
  execOutsideStrings,
  maskJsxForFile,
  trimmedRanges,
} from './string-literals.mjs';

export const SNIPPET_LIMIT = 120;

const SUPPORTED_SUFFIXES = [
  '.py',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.php',
];

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  'dist',
  'build',
  '.mypy_cache',
  '.pytest_cache',
  '.tox',
  'vendor', // Composer's node_modules (#1106)
  // Fixture directories are test DATA: files here never RUN as tests, so a
  // temporal/order smell in one is a property of the data, not a defect (#493
  // one level up). Also keeps pragmas out of golden-pinned fixture files.
  'fixtures',
  '__fixtures__',
  '__mocks__',
  'testdata',
]);

const TEST_DIRS = new Set(['tests', 'test', '__tests__', 'e2e', 'spec']);

const COMMENT_PREFIXES = ['#', '//', '*', '/*', '"""', "'''"];

const splitLines = (text) => text.split(/\r\n|\r|\n/);
const isComment = (stripped) =>
  COMMENT_PREFIXES.some((p) => stripped.startsWith(p));

/** @returns {string[]} the path's components, separator-agnostic. */
const partsOf = (p) => p.split(/[\\/]/).filter(Boolean);

/** True when a path looks like a test file by name or containing directory. */
function isTestFile(filePath) {
  const suffix = path.extname(filePath);
  if (!SUPPORTED_SUFFIXES.includes(suffix)) return false;
  const name = path.basename(filePath);
  const stem = name.slice(0, name.length - suffix.length);
  // PHPUnit FooTest.php, WordPress test-foo.php (#1106 D11) - by name only:
  // tests/ also holds bootstrap.php and wp-tests-config.php, never tests.
  if (suffix === '.php') return /^test-|Test$/.test(stem);
  if (name.includes('.test.') || name.includes('.spec.')) return true;
  if (stem.startsWith('test_') || stem.endsWith('_test')) return true;
  const dirs = partsOf(filePath).slice(0, -1);
  return dirs.some((part) => TEST_DIRS.has(part));
}

function makeFinding(file, line, ruleId, snippet) {
  return {
    file,
    line,
    ruleId,
    severity: SEVERITY[ruleId],
    snippet: snippet.slice(0, SNIPPET_LIMIT),
    why: WHY[ruleId],
  };
}

/** Convert an internal finding to its JSON-contract shape (snake_case id). */
export function toJson(f) {
  return {
    file: f.file,
    line: f.line,
    rule_id: f.ruleId,
    severity: f.severity,
    snippet: f.snippet,
    why: f.why,
  };
}

/** Module-level mutable declarations that some line later mutates in place. */
function sv001ModuleMutables(lines, file, isPy, text) {
  const declRe = isPy ? PY_MODULE_MUTABLE : JS_MODULE_MUTABLE;
  const findings = [];
  lines.forEach((raw, i) => {
    // Module scope == column 0 (unindented). A mutable declared inside a
    // function is local and cannot leak between tests.
    if (/^\s/.test(raw)) return;
    const match = declRe.exec(raw.trim());
    if (!match) return;
    const name = match[1];
    if (mutationPattern(name).test(text)) {
      findings.push(
        makeFinding(file, i + 1, 'SV001-module-mutable-global', raw.trim()),
      );
    }
  });
  return findings;
}

/**
 * PHP shared declarations on a code line (#1106 D4), as [name, scope] with the
 * name without `$`. Scope decides which mutations indict it: `bare` (local
 * `static`, `global`) any `$x`; `qualified` (a class static property) only
 * `Name::$x`; `module` (column 0) only file-scope code or a `global` import.
 */
function phpDeclaredNames(code) {
  const names = [];
  const moduleLevel = PHP_MODULE_MUTABLE.exec(code); // anchored at column 0
  if (moduleLevel) names.push([moduleLevel[1], 'module']);
  const stat = PHP_STATIC_DECL.exec(code);
  if (stat) names.push([stat[2], stat[1] ? 'qualified' : 'bare']);
  for (const n of phpGlobalNames(code)) names.push([n, 'bare']);
  return names;
}

const phpGlobalNames = (code) => {
  const glob = PHP_GLOBAL_DECL.exec(code);
  return glob ? glob[1].split(',').map((v) => v.trim().slice(1)) : [];
};

/**
 * PHP SV001: a column-0 array, a `static $x` or a `global $x` import fires on
 * its declaration line when the file mutates that variable in place. Both
 * halves read the code-only projection, so comments and strings never count.
 * A column-0 array is judged against unindented lines, plus the whole file
 * when ANY function imports it with `global` - an approximation: which
 * function holds the import is not tracked.
 */
function sv001PhpMutables(lines, file) {
  const codeLines = lines.map(codeOnly);
  const text = {
    all: codeLines.join('\n'),
    top: codeLines.filter((c) => !/^\s/.test(c)).join('\n'),
  };
  const imported = new Set(codeLines.flatMap(phpGlobalNames));
  const indicts = ([name, scope]) => {
    const pattern = phpMutationPattern(name, scope === 'qualified');
    const wide = scope !== 'module' || imported.has(name);
    return pattern.test(wide ? text.all : text.top);
  };
  const findings = [];
  codeLines.forEach((code, i) => {
    if (phpDeclaredNames(code).some(indicts)) {
      const snippet = lines[i].trim();
      findings.push(
        makeFinding(file, i + 1, 'SV001-module-mutable-global', snippet),
      );
    }
  });
  return findings;
}

// Line comment openers, for the code-only projection below. A whole-line
// comment is caught earlier by isComment (which also covers block-comment
// continuations and Python docstring fences).
const COMMENT_OPENERS = ['//', '/*', '#'];

/**
 * The line with comments dropped and string-literal CONTENT blanked, so a
 * token found in the result is code rather than prose or data.
 *
 * #732: SV002 asked `text.includes(teardown)` of the RAW file while its setup
 * half already skipped comments, so any file that merely MENTIONED the
 * teardown token exempted itself -- invisibly, because a finding that is never
 * generated never appears in the `N suppressed` line either. Blanking rather
 * than deleting preserves column positions for callers that keep ranges.
 *
 * Erring here means erring toward FIRING (a token wrongly read as prose costs
 * a false flag, which restoration.mjs's header calls the safe direction),
 * never toward the silent exemption this replaces.
 */
function codeOnly(line) {
  if (isComment(line.trim())) return '';
  const ranges = stringLiteralRanges(line);
  let out = '';
  for (let i = 0; i < line.length; i += 1) {
    if (inStringLiteral(ranges, i)) {
      out += ' ';
      continue;
    }
    // Rest of the line is a trailing comment.
    if (COMMENT_OPENERS.some((c) => line.startsWith(c, i))) break;
    out += line[i];
  }
  return out;
}

// Per-language rule inputs (#1106): one table instead of isPy/isPhp branches,
// so scanTextFull's complexity does not grow with each language.
const LANGS = {
  py: {
    pairs: PYTHON_SETUP_TEARDOWN,
    setupHit: (code, setup) => code.includes(`def ${setup}`),
    sv001: (lines, file, text) => sv001ModuleMutables(lines, file, true, text),
  },
  js: {
    pairs: JS_SETUP_TEARDOWN,
    setupHit: (code, setup) =>
      code.startsWith(`${setup}(`) || code.includes(` ${setup}(`),
    sv001: (lines, file, text) => sv001ModuleMutables(lines, file, false, text),
  },
  php: {
    pairs: PHP_SETUP_TEARDOWN,
    setupHit: (code, setup) => code.includes(`function ${setup}(`),
    sv001: (lines, file) => sv001PhpMutables(lines, file),
  },
};
const langOf = (file) => {
  if (file.endsWith('.py')) return 'py';
  return file.endsWith('.php') ? 'php' : 'js';
};

/** Setup markers whose matching teardown is absent from the file. */
function sv002MissingTeardown(lines, file, lang, masks) {
  const { pairs, setupHit } = LANGS[lang];
  // #732: pair against code only. Both halves read the same projection, so
  // the rule can no longer be switched off by a comment or a fixture string.
  // #1188: the projection is taken of the JSX-masked twin of each line.
  const codeLines = masks.map(codeOnly);
  const codeText = codeLines.join('\n');
  const findings = [];
  for (const [setup, teardown] of pairs) {
    if (codeText.includes(teardown)) continue;
    for (let i = 0; i < lines.length; i += 1) {
      const code = codeLines[i].trim();
      if (!code) continue;
      if (setupHit(code, setup)) {
        const stripped = lines[i].trim();
        findings.push(
          makeFinding(file, i + 1, 'SV002-missing-teardown', stripped),
        );
        break; // one finding per unmatched setup marker
      }
    }
  }
  return findings;
}

// Inline suppression pragma (#496): `savant-ignore <RULE>[,<RULE>] -- reason`
// in a comment, matching canary-blackhawk's `blackhawk-ignore` (#393) so a
// user moving between the two skills learns one dialect. Rule-scoped (so it
// never blanket-silences a line) and the reason is required (keeps
// suppressions honest and greppable). A pragma covers the finding on its own
// line (trailing comment) and the next line (comment above the code) - the
// two idioms teams reach for. One deliberate divergence from blackhawk: the
// anchor is string-literal guarded (#493 style), because savant's own suite
// carries pragma text inside fixture strings and data must never act as a
// directive.
const PRAGMA = /\bsavant-ignore\s+([A-Za-z0-9,\s-]*?)\s*--\s*(\S.*)$/;

function parsePragmas(lines, masks) {
  const map = new Map();
  const add = (ln, tokens) => {
    if (!map.has(ln)) map.set(ln, new Set());
    for (const t of tokens) map.get(ln).add(t);
  };
  lines.forEach((raw, i) => {
    const m = execOutsideStrings(
      PRAGMA,
      raw,
      stringLiteralRanges(raw, masks[i]),
    );
    if (!m || !m[2].trim()) return; // reason required
    const tokens = m[1].split(/[,\s]+/).filter(Boolean);
    if (!tokens.length) return; // rule-scoped: must name a rule
    add(i + 1, tokens); // same-line (trailing pragma)
    add(i + 2, tokens); // next line (pragma above the code)
  });
  return map;
}

// An `SV003` token matches `SV003-shared-singleton-mutation`; the full id
// also matches.
const tokenMatches = (ruleId, token) =>
  ruleId === token || ruleId.split('-')[0] === token;

/**
 * @typedef {{file: string, line: number, ruleId: string, severity: string,
 *            snippet: string, why: string}} Finding
 */

/**
 * Scan source text. Returns kept `findings` plus `suppressed` findings
 * silenced by an inline pragma, both ordered by line then rule id.
 * @returns {{findings: Finding[], suppressed: Finding[]}}
 */
export function scanTextFull(text, file = '<text>') {
  const lang = langOf(file);
  const isPhp = lang === 'php';
  const lines = splitLines(text);
  // #1188: .tsx/.jsx lines are read through a twin with JSX text blanked.
  const masked = maskJsxForFile(text, file);
  const masks = splitLines(masked);
  const findings = [];
  // #493 root cause 2: SV003's why asserts persistence, so a file that
  // restores the global (teardown restore or snapshot write-back) must not
  // be flagged. Computed once per file.
  const restoration = analyzeRestoration(masked, isPhp);

  findings.push(...LANGS[lang].sv001(lines, file, text));
  findings.push(...sv002MissingTeardown(lines, file, lang, masks));

  lines.forEach((raw, i) => {
    const stripped = raw.trim();
    // #1193: comment-ness, SV004 prose and write-back evidence come from the
    // masked line -- rendered JSX text is none of the three.
    const view = masks[i].trim();
    if (!view) return;
    // #493: a match starting inside a string literal is fixture data, not
    // code. SV003 and SV004's code-anchored alternatives reject those; the
    // SV004 text alternatives stay unfiltered because their signal (titles,
    // docstrings, comments) legitimately lives inside strings.
    const ranges = trimmedRanges(raw, masks[i]);
    // SV004 is self-reported ordering: it fires on comments and code alike.
    if (
      execOutsideStrings(
        isPhp ? PHP_SV004_CODE_PATTERN : SV004_CODE_PATTERN,
        stripped,
        ranges,
      ) ||
      SV004_TEXT_PATTERN.test(view)
    ) {
      findings.push(
        makeFinding(file, i + 1, 'SV004-order-coupled-name', stripped),
      );
    }
    if (isComment(view)) return;
    const mutation = classifyMutation(stripped, ranges, isPhp);
    if (mutation) {
      const restored =
        isSnapshotWriteBack(mutation, masks) ||
        restoration.restores(mutation.family, mutation.key);
      if (!restored) {
        findings.push(
          makeFinding(file, i + 1, 'SV003-shared-singleton-mutation', stripped),
        );
      }
    }
  });

  findings.sort((a, b) => a.line - b.line || a.ruleId.localeCompare(b.ruleId));

  // Partition after the sort (stable), so both arrays stay line-ordered.
  const pragmas = parsePragmas(lines, masks);
  const kept = [];
  const suppressed = [];
  for (const f of findings) {
    const tokens = pragmas.get(f.line);
    if (tokens && [...tokens].some((t) => tokenMatches(f.ruleId, t))) {
      suppressed.push(f);
    } else {
      kept.push(f);
    }
  }
  return { findings: kept, suppressed };
}

/** Scan source text, returning kept findings (back-compat wrapper). */
export function scanText(text, file = '<text>') {
  return scanTextFull(text, file).findings;
}

/** Scan one file. Unreadable files yield nothing. */
function scanFileFull(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { findings: [], suppressed: [] };
  }
  return scanTextFull(text, filePath);
}

/** Yield the files a path contributes: explicit files win, dirs are filtered. */
function* iterFiles(root) {
  let stat;
  try {
    stat = fs.statSync(root);
  } catch {
    return;
  }
  if (stat.isFile()) {
    if (SUPPORTED_SUFFIXES.includes(path.extname(root))) yield root;
    return;
  }
  const collected = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (SKIP_DIRS.has(entry.name)) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) collected.push(full);
    }
  };
  walk(root);
  collected.sort();
  for (const f of collected) {
    if (partsOf(f).some((part) => SKIP_DIRS.has(part))) continue;
    if (isTestFile(f)) yield f;
  }
}

/** Scan every given file/directory, de-duplicating overlapping paths. */
export function scanPaths(paths) {
  const seen = new Set();
  const findings = [];
  let scanned = 0;
  let suppressed = 0;
  for (const entry of paths) {
    for (const filePath of iterFiles(entry)) {
      const resolved = path.resolve(filePath);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      scanned += 1;
      const r = scanFileFull(filePath);
      findings.push(...r.findings);
      suppressed += r.suppressed.length;
    }
  }
  findings.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.ruleId.localeCompare(b.ruleId),
  );
  return { findings, filesScanned: scanned, suppressed };
}
