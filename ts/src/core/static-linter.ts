/**
 * Static linter for test files — faithful TS port of
 * `agent/core/static_linter.py`.
 *
 * Produces file:line findings without executing tests. Powers the static
 * review + flake-check subsets. Regex/line based; pure filesystem reads.
 */

import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';

import { blankStringContent } from './string-literals.js';

export interface LintFinding {
  file: string;
  line: number;
  rule: string;
  severity: 'critical' | 'warning' | 'info';
  message: string;
  suggestion: string;
}

export function formatFinding(f: LintFinding): string {
  return `[${f.severity.toUpperCase()}] ${f.file}:${f.line} (${f.rule})\n  ${f.message}\n  → ${f.suggestion}`;
}

// Flakiness
const SLEEP = /time\.sleep\s*\(|page\.waitForTimeout\s*\(/;
const SETTIMEOUT = /(?<!\w)setTimeout\s*\(/;
const RANDOM =
  /Math\.random\s*\(|random\.random\s*\(|random\.choice\s*\(|random\.randint\s*\(/;
const TIMESTAMP = /Date\.now\s*\(|datetime\.now\s*\(|datetime\.utcnow\s*\(/;

// Brittle selectors
const CSS_CLASS_SELECTOR = /['"]\.[a-zA-Z][\w-]*['"]/;
const CSS_ID_SELECTOR = /['"]#[a-zA-Z][\w-]*['"]/;
const XPATH_SELECTOR = /['"]\/+[a-zA-Z[\]/@*]/;
const LOCATOR_METHODS = /\.(locator|querySelector)\s*\(/;

// Missing await
const BARE_PLAYWRIGHT_CALL =
  /(?<!await\s)(?<!return\s)(?<!\w)(?:page|frame|locator)\.(?:click|fill|type|check|uncheck|selectOption|hover|focus|press|tap|dblclick)\s*\(/;

// Assertion detection
// Indentation is `[ \t]*`, NOT `\s*`: `\s` matches a newline, so a `^`-anchored
// `\s*` starts the match at the FIRST of any run of blank lines above the `def`
// and counts those newlines as indentation. PEP 8 mandates blank lines between
// defs, so that was the normal case, and it broke two things at once -- the
// reported line landed above the test, and the inflated indent made the
// "next def at the same indent" body boundary un-matchable, so the body ran to
// end-of-file and could borrow a later test's assert (#633).
const TEST_FN_PY = /^([ \t]*)def (test_\w+)\s*\(/gm;
// `d` (hasIndices) so the NAME can be read back out of the ORIGINAL source.
// The scanner matches against string-blanked source, where the name itself has
// been blanked away; blanking is length-preserving precisely so these offsets
// still address the untouched text (#590).
const TEST_FN_JS = /(?:^|\s)(?:it|test)\s*\(\s*['"]([^'"]*)['"]/dgm;
const ASSERT_PY = /\bassert\b|\bpytest\.raises\b/;
// Assertion styles a JS/TS test may use. `expect()` (jest/vitest/playwright)
// was the only one recognized until canary was pointed at its own suites and
// reported 216 assertion-free tests of which 13 were real -- the other 200 were
// `node:test` + `node:assert`, a whole framework the linter could not see.
// Kept as a union of shapes rather than an import-aware parse: a static linter
// that needs to resolve imports to judge one line is the wrong trade.
// The `expectX()/assertX()` alternative covers a test that delegates its
// assertion to a named helper (`expectAuthoringAllowed(res)`) -- 9 of canary's
// own 16 residual findings. A regex linter cannot follow the call, so the NAME
// carries the signal; the `[A-Z]` keeps it to the convention rather than
// excusing any call that merely starts with those letters.
const ASSERT_JS =
  /\bexpect\s*\(|\bto(?:Be|Equal|Contain|Have|Match|Throw|Raise)\b|\bassert\s*\.\s*\w+\s*\(|\bassert\s*\(|\bshould\s*\.|\.should\b|\b(?:expect|assert)[A-Z]\w*\s*\(/;

// Strippers
const STRING_LITERAL = /(['"])(?:\\.|(?!\1).)*?\1/g;
/**
 * A backtick template literal that opens and closes on ONE line.
 *
 * `blankStrings` knew only `'` and `"`, so a single-line template literal was
 * read as live code by every rule. In a TS suite that is the common case for
 * fixture data -- pointing the soundness rules at canary's own tests reported 6
 * findings inside the fixtures of the file testing those very rules. The
 * multi-line stripper below never covered it either: it only blanks the
 * INTERIOR of a run whose delimiter count is odd, so a balanced one-line
 * literal falls through both.
 */
const TEMPLATE_LITERAL = /`(?:\\.|[^`])*?`/g;
/** A `${...}` substitution: string syntax wrapping genuinely live code. */
const TEMPLATE_SUBSTITUTION = /\$\{[^{}]*\}/g;

// Magic numbers -- scoped to TIMING values only.
//
// "Extract the magic number to a named constant" is a production-code
// principle, and it inverts in a test: the literal IS the specification.
// `expect(notes.length).toBe(2048)` states the contract that
// `expect(notes.length).toBe(MAX_NOTES)` hides behind a name the reader now has
// to go look up. Since this linter only ever reads TEST files, the unscoped
// rule was misapplied across its entire domain -- measured at 0-for-157
// actionable when canary was first pointed at its own suites.
//
// A timing value is the one case that survives: a bare `5000` in a
// setTimeout/retry/interval position is a duration whose units and intent are
// genuinely unclear, and naming it genuinely helps. (Hardcoded sleeps are
// separately flagged at CRITICAL by FLAKE-001/002; this is the softer signal
// for the non-sleep timing values those rules do not cover.)
const TIMING_CONTEXT =
  /\b(?:setTimeout|setInterval|waitForTimeout|sleep|delay|timeout|interval|retryDelay|retries|backoff|pollInterval|debounce|throttle)\b/i;
const NUMERIC_LITERAL = /(?<![\w.])-?\d+(?:\.\d+)?(?![\w.])/g;
const ALLOWED_NUMBERS = new Set(['0', '1', '2', '-1', '10', '100']);
const HTTP_STATUS = new Set([
  '200',
  '201',
  '202',
  '204',
  '301',
  '302',
  '304',
  '400',
  '401',
  '403',
  '404',
  '405',
  '409',
  '410',
  '422',
  '429',
  '500',
  '501',
  '502',
  '503',
  '504',
]);

function isAllowedNumber(token: string): boolean {
  if (ALLOWED_NUMBERS.has(token) || HTTP_STATUS.has(token)) return true;
  const bare = token.replace(/^-+/, '');
  return /^\d$/.test(bare);
}

function isComment(line: string): boolean {
  const s = line.trim();
  return s.startsWith('#') || s.startsWith('//') || s.startsWith('*');
}

function mk(
  file: string,
  line: number,
  rule: string,
  severity: LintFinding['severity'],
  message: string,
  suggestion: string,
): LintFinding {
  return { file, line, rule, severity, message, suggestion };
}

interface FlakeRule {
  re: RegExp;
  rule: string;
  severity: LintFinding['severity'];
  message: string;
  suggestion: string;
  guard?: (line: string) => boolean;
}

const FLAKINESS_RULES: FlakeRule[] = [
  {
    re: SLEEP,
    rule: 'FLAKE-001',
    severity: 'critical',
    message: 'Hardcoded sleep/wait detected.',
    suggestion:
      'Replace with an event-based wait (e.g. expect(locator).toBeVisible(), page.waitForResponse(), waitFor()).',
  },
  {
    re: SETTIMEOUT,
    rule: 'FLAKE-002',
    severity: 'critical',
    message: 'setTimeout used without a corresponding waitFor.',
    suggestion:
      'Wrap in page.waitForFunction() or replace with an awaitable assertion.',
    guard: (line) => !line.includes('waitFor'),
  },
  {
    re: RANDOM,
    rule: 'FLAKE-003',
    severity: 'warning',
    message: 'Non-deterministic random value in test.',
    suggestion: 'Use a fixed seed or a static fixture value instead.',
  },
  {
    re: TIMESTAMP,
    rule: 'FLAKE-004',
    severity: 'warning',
    message: 'Timestamp-dependent value detected.',
    suggestion: 'Mock Date.now()/datetime.now() or use a fixed reference date.',
  },
];

/**
 * Blank single-line string literals so a rule matching CODE cannot fire on test
 * DATA.
 *
 * `scanMagicNumbers` has always done this; the flakiness and missing-await
 * rules never did, so `const src = 'const t = Date.now();'` -- a fixture string
 * feeding a linter test -- was reported as a real timestamp dependency. Any
 * suite that carries the patterns it tests as string data hits this, and
 * canary's own linter tests are the worst case.
 *
 * The same defect shipped in `canary-blackhawk`'s pragma parser (#499) and was
 * guarded in `canary-savant` (#495/#498): data must never act as code, nor as
 * directive.
 *
 * NOT applied to the selector rules: LINT-001/002/003 match `'.btn'` / `'#id'`
 * inside quotes by construction, because a selector IS a string. Stripping
 * would delete those rules outright.
 */
function blankStrings(line: string): string {
  // Template literals first: their interior can contain `'`/`"` that would
  // otherwise pair up across the boundary and blank the wrong span.
  //
  // `${...}` substitutions are preserved, because they are the one part of a
  // template literal that IS executed -- blanking them would take a real
  // `Date.now()` dark, which is the abstention shape rather than a false
  // positive. So the literal is replaced by the concatenation of its
  // substitutions, and the quoted text around them disappears.
  const detemplated = line.replace(TEMPLATE_LITERAL, (lit) => {
    const subs = lit.match(TEMPLATE_SUBSTITUTION) ?? [];
    return subs.length === 0 ? '""' : `""+${subs.join('+')}+""`;
  });
  return detemplated.replace(STRING_LITERAL, '""');
}

function scanFlakiness(lines: string[], file: string): LintFinding[] {
  const out: LintFinding[] = [];
  lines.forEach((raw, idx) => {
    if (isComment(raw)) return;
    const line = blankStrings(raw);
    for (const r of FLAKINESS_RULES) {
      if (r.re.test(line) && (!r.guard || r.guard(line))) {
        out.push(
          mk(file, idx + 1, r.rule, r.severity, r.message, r.suggestion),
        );
      }
    }
  });
  return out;
}

function selectorFinding(
  line: string,
  i: number,
  file: string,
): LintFinding | null {
  if (CSS_CLASS_SELECTOR.test(line)) {
    return mk(
      file,
      i,
      'LINT-001',
      'warning',
      'CSS class selector is brittle.',
      'Prefer getByRole(), getByLabel(), or data-testid attributes.',
    );
  }
  if (CSS_ID_SELECTOR.test(line)) {
    return mk(
      file,
      i,
      'LINT-002',
      'warning',
      'CSS id selector may break if the id changes.',
      'Prefer getByTestId() or getByRole() over id-based selectors.',
    );
  }
  if (XPATH_SELECTOR.test(line)) {
    return mk(
      file,
      i,
      'LINT-003',
      'warning',
      'XPath selector is fragile.',
      'Replace with role, label, or test-id based locators.',
    );
  }
  return null;
}

function scanSelectors(lines: string[], file: string): LintFinding[] {
  const out: LintFinding[] = [];
  lines.forEach((line, idx) => {
    if (isComment(line) || !LOCATOR_METHODS.test(line)) return;
    const finding = selectorFinding(line, idx + 1, file);
    if (finding) out.push(finding);
  });
  return out;
}

function scanMissingAwait(lines: string[], file: string): LintFinding[] {
  const out: LintFinding[] = [];
  lines.forEach((raw, idx) => {
    if (isComment(raw)) return;
    // A `page.click(...)` inside a string is fixture data, not a missing await.
    const line = blankStrings(raw);
    if (BARE_PLAYWRIGHT_CALL.test(line) && !line.includes('await')) {
      out.push(
        mk(
          file,
          idx + 1,
          'LINT-004',
          'critical',
          'Playwright action called without await.',
          'Add `await` before the call to ensure it completes before the next step.',
        ),
      );
    }
  });
  return out;
}

/** Multi-line string delimiters: JS template literal, Python triple quotes. */
const MULTILINE_DELIMS = ['`', '"""', "'''"];

/**
 * Blank the INTERIOR of multi-line strings, preserving line count and numbering.
 *
 * Every per-line rule (magic numbers, selectors, flakiness) sees one line at a
 * time, so a line inside a multi-line template literal or a Python
 * triple-quoted block reads as bare code. Canary's own diff fixtures are
 * template literals, so `100644` -- a git file mode sitting in test DATA -- was
 * reported as a magic number 30 times. Any consumer with a multi-line SQL,
 * JSON, HTML, or diff fixture has the same defect.
 *
 * Deliberately conservative about an UNBALANCED delimiter (a stray backtick in
 * a comment, say): blanking to end-of-file would silently disable these rules
 * from that point down -- the abstention shape, one layer inside the linter. An
 * unclosed run is therefore discarded rather than applied.
 */
function blankMultilineStrings(lines: string[]): string[] {
  const out = [...lines];
  for (const delim of MULTILINE_DELIMS) {
    let openAt: number | null = null;
    for (let i = 0; i < out.length; i += 1) {
      const hits = out[i]!.split(delim).length - 1;
      // An even count opens and closes on the same line, which the single-line
      // stripper already handles; only an odd count toggles the state.
      if (hits === 0 || hits % 2 === 0) continue;
      if (openAt === null) {
        openAt = i;
      } else {
        for (let j = openAt + 1; j < i; j += 1) out[j] = '';
        openAt = null;
      }
    }
  }
  return out;
}

function scanMagicNumbers(lines: string[], file: string): LintFinding[] {
  const out: LintFinding[] = [];
  lines.forEach((raw, idx) => {
    if (isComment(raw)) return;
    const scrubbed = raw.replace(STRING_LITERAL, '""');
    // Only timing positions: everywhere else in a test file the literal is the
    // specification, not a smell. See TIMING_CONTEXT above.
    if (!TIMING_CONTEXT.test(scrubbed)) return;
    for (const m of scrubbed.matchAll(NUMERIC_LITERAL)) {
      if (isAllowedNumber(m[0])) continue;
      out.push(
        mk(
          file,
          idx + 1,
          'LINT-005',
          'info',
          `Magic timing value ${m[0]}.`,
          'Name the duration (e.g. RETRY_DELAY_MS) so its units and intent are readable.',
        ),
      );
      break; // one finding per line
    }
  });
  return out;
}

// --- Soundness (#605) -------------------------------------------------------
//
// A test can assert, pass, and still prove nothing about the implementation --
// because the value it pins is one no correct implementation is OBLIGED to
// produce. A generated test that pins a UUID, a pid, a temp-dir path, or a
// float it compares with exact equality goes green on the machine that made it
// and is a scheduled failure everywhere else. Nothing in this linter saw that
// class: the assertion exists, so LINT-006 is satisfied, and the assertion line
// itself is often clean, so FLAKE-003/004 never fire.
//
// The three rules below all key off the EXPECTATION position rather than the
// line, which is what keeps them actionable. A random temp dir used as test
// INPUT is fine and extremely common; the same value used as the expected
// RESULT is the defect. A rule that could not tell those apart would fire on
// every fixture-using test in the repo and be ignored within a week -- the
// LINT-005 outcome (0-for-157 actionable), re-run.

/**
 * Non-deterministic sources FLAKE-003/004 do not already name. Kept disjoint
 * from them so one defect never yields two findings the author must dismiss
 * separately.
 */
const NONDET_EXTRA =
  /\b(?:crypto\.)?randomUUID\s*\(|\buuid4\s*\(|\bnanoid\s*\(|\bprocess\.pid\b|\bprocess\.hrtime\b|\bos\.getpid\s*\(|\bos\.hostname\s*\(|\bsocket\.gethostname\s*\(|\bperformance\.now\s*\(|\btime\.monotonic\s*\(|\bmkdtempSync\s*\(|\btempfile\.mkdtemp\s*\(|\bos\.tmpdir\s*\(/;

/**
 * Sources whose value a test may legitimately pin as an EXPECTATION, and so the
 * only ones worth tracking through a variable.
 *
 * Deliberately excludes the path family (`mkdtempSync`, `tmpdir`, `mkdtemp`).
 * Measured against canary's own suite, taint through a temp directory was
 * 0-for-3 actionable: a temp path is non-deterministic by design, and the
 * assertion built from it (`expect(globDirs(tmp)).toEqual([join(tmp, 'apps')])`)
 * is about the relationship between input and output, not about the path. The
 * path family stays a direct-mode source, where `toBe(mkdtempSync(...))` --
 * pinning a directory created in the assertion itself -- is still nonsense.
 */
const NONDET_TAINT_SOURCE = new RegExp(
  `${RANDOM.source}|${TIMESTAMP.source}|` +
    `\\b(?:crypto\\.)?randomUUID\\s*\\(|\\buuid4\\s*\\(|\\bnanoid\\s*\\(|` +
    `\\bprocess\\.pid\\b|\\bprocess\\.hrtime\\b|\\bos\\.getpid\\s*\\(|` +
    `\\bos\\.hostname\\s*\\(|\\bsocket\\.gethostname\\s*\\(|` +
    `\\bperformance\\.now\\s*\\(|\\btime\\.monotonic\\s*\\(`,
);

/**
 * Where a JS/TS assertion's EXPECTED value begins.
 *
 * `toBeCloseTo` deliberately does not match: `\s*\(` must follow the matcher
 * name, and `CloseTo(` does not. That single fact is what exempts the CORRECT
 * float comparison from SOUND-002 and the pinned-fraction contract from
 * SOUND-003, without either rule naming the fix.
 */
const JS_MATCHER_OPEN =
  /\.to(?:Be|Equal|StrictEqual|MatchObject|Contain|ContainEqual|HaveProperty|HaveLength|HaveValue)\s*\(/;
/** The Python analogue: `==` in an assert, or `assertEqual(`'s argument list. */
const PY_MATCHER_OPEN = /==|\bassertEqual\s*\(/;

/** A `const|let|var x = <rhs>` (JS) or `x = <rhs>` (Python) binding. */
const JS_BINDING = /\b(?:const|let|var)\s+(\w+)\s*=\s*(.*)$/;
const PY_BINDING = /^\s*(\w+)\s*=\s*([^=].*)$/;

const LEADING_FRACTION = /^\s*-?\d+\.\d+(?![\d.])/;
const LEADING_INTEGER = /^\s*-?\d+(?![\d.])/;
/** A division between two operands, e.g. `total / count`. */
const DIVISION = /[\w)\]]\s*\/\s*[\w(]/;

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * True iff a decimal literal has an exact binary-float representation.
 *
 * The discrimination that makes SOUND-002 usable rather than noise. `0.5` and
 * `1.125` are exact, so `toBe(0.5)` states a contract an implementation can
 * actually honour; `0.1` and `0.3` are not, so exact equality on them is a bet
 * on the specific arithmetic path that produced the value. Flagging the exact
 * ones too would train readers to dismiss the rule.
 */
function isBinaryExact(literal: string): boolean {
  const frac = literal.split('.')[1] ?? '';
  if (frac === '') return true;
  let num = Number(frac);
  let den = 10 ** frac.length;
  const d = gcd(num, den);
  num = num / d;
  den = den / d;
  // A reduced denominator that is a power of two is exactly representable.
  return (den & (den - 1)) === 0;
}

/** The expected-value text of an assertion line, or null if there is none. */
function expectationOf(line: string, python: boolean): string | null {
  const open = python ? PY_MATCHER_OPEN : JS_MATCHER_OPEN;
  const m = open.exec(line);
  if (m === null) return null;
  // To end-of-line rather than to a matching paren: a nested call in the
  // expectation (`toBe(mkdtempSync(dir))`) has unbalanced parens under any
  // regex, and the actual-value side is already excluded by starting after the
  // matcher.
  return line.slice(m.index + m[0].length);
}

/** The actual-value text of an assertion line (everything before the matcher). */
function actualOf(line: string, python: boolean): string | null {
  const open = python ? PY_MATCHER_OPEN : JS_MATCHER_OPEN;
  const m = open.exec(line);
  return m === null ? null : line.slice(0, m.index);
}

function scanSoundness(
  lines: string[],
  file: string,
  python: boolean,
): LintFinding[] {
  const out: LintFinding[] = [];
  // Variables bound to a non-deterministic source, name -> the source text.
  //
  // File-scoped, not test-scoped, and deliberately so: bounding taint by test
  // body needs the same next-declaration machinery the assertion scanners use,
  // and a name reused across tests in the same file with one tainted binding is
  // a finding worth showing either way. Same trade blackhawk documents for
  // file-wide frozen-clock suppression.
  const tainted = new Map<string, string>();

  lines.forEach((raw, idx) => {
    if (isComment(raw)) return;
    // Data must never read as code: a fixture string carrying `Date.now()` is
    // the linter's own test suite, not a defect in it.
    const line = blankStrings(raw);
    const lineNo = idx + 1;

    const binding = (python ? PY_BINDING : JS_BINDING).exec(line);
    if (binding && NONDET_TAINT_SOURCE.test(binding[2]!)) {
      tainted.set(binding[1]!, binding[2]!.trim());
    }

    const isAssertion = (python ? ASSERT_PY : ASSERT_JS).test(line);
    if (!isAssertion) return;
    const expected = expectationOf(line, python);
    if (expected === null) return;

    // SOUND-001a: a non-deterministic source called straight into the
    // expectation.
    if (NONDET_EXTRA.test(expected)) {
      out.push(
        mk(
          file,
          lineNo,
          'SOUND-001',
          'warning',
          'Assertion pins a non-deterministic value.',
          'Pin a fixture value, or assert the SHAPE (matcher/regex/type) instead of the exact value.',
        ),
      );
    } else {
      // SOUND-001b: the mode a line-based rule cannot see -- the value became
      // non-deterministic on an earlier line and arrives here through a
      // variable, so this line reads as perfectly clean.
      for (const [name, source] of tainted) {
        if (!new RegExp(`\\b${name}\\b`).test(expected)) continue;
        out.push(
          mk(
            file,
            lineNo,
            'SOUND-001',
            'warning',
            `Assertion pins \`${name}\`, which came from \`${source}\`.`,
            'A value the implementation did not have to produce proves nothing. Freeze the source (fake timers / fixed seed) or assert the shape.',
          ),
        );
        break; // one finding per assertion line
      }
    }

    // SOUND-002: exact equality against a fraction with no exact binary form.
    const frac = LEADING_FRACTION.exec(expected);
    if (frac && !isBinaryExact(frac[0].trim())) {
      out.push(
        mk(
          file,
          lineNo,
          'SOUND-002',
          'warning',
          `Exact equality against ${frac[0].trim()}, which has no exact binary representation.`,
          python
            ? 'Use pytest.approx() -- exact float equality depends on the arithmetic path, not the contract.'
            : 'Use toBeCloseTo() -- exact float equality depends on the arithmetic path, not the contract.',
        ),
      );
    }

    // SOUND-003: a ratio pinned to an integer never states whether the
    // operation truncates. This is the realworld S4 integer/fractional
    // precondition, one layer down: the test exercises the input shape the
    // author had in mind and leaves the other one unspecified.
    const actual = actualOf(line, python);
    if (actual && DIVISION.test(actual) && LEADING_INTEGER.test(expected)) {
      out.push(
        mk(
          file,
          lineNo,
          'SOUND-003',
          'warning',
          'A ratio is pinned to an integer, leaving the integer/fractional contract unpinned.',
          'Add a case whose inputs divide to a fractional result, so the test says whether the operation truncates.',
        ),
      );
    }
  });

  return out;
}

function lineOf(code: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < offset && i < code.length; i++) {
    if (code[i] === '\n') n++;
  }
  return n;
}

/** One test declaration and the source span that belongs to it. */
export interface TestBlock {
  /** The test's name as written in the ORIGINAL (unblanked) source. */
  name: string;
  /** 1-based line of the declaration. */
  line: number;
  /** The body text, bounded by the next declaration. */
  body: string;
  /** Byte offset of `body` in the source it was sliced from. */
  bodyStart: number;
}

/**
 * Every test declaration in `code`, with its body bounded by the NEXT one.
 *
 * Extracted so the vacuity scanner (#612) shares one notion of "where does this
 * test end" with LINT-006 rather than growing a second, subtly different one.
 * The boundary logic is the part with a bug history — a fixed 2000-character
 * lookahead was wrong in both directions (#590), the `(?:^|\s)` prefix put the
 * reported line one early (#633) — so a divergent copy would inherit none of
 * those fixes.
 *
 * `code` must be the string-blanked source (see `blankStringContent`) so a
 * declaration inside a fixture cannot truncate a real test's body; `source` is
 * the untouched text, read only to recover names that blanking erased.
 */
export function enumerateTests(
  code: string,
  source: string,
  python: boolean,
): TestBlock[] {
  const out: TestBlock[] = [];
  if (python) {
    for (const m of code.matchAll(TEST_FN_PY)) {
      const indent = m[1]!.length;
      const start = m.index!;
      const bodyStart = start + m[0].length;
      const rest = code.slice(bodyStart);
      const nextFn = rest.match(new RegExp(`^[ \\t]{${indent}}def `, 'm'));
      out.push({
        name: m[2]!,
        line: lineOf(code, start),
        body: nextFn ? rest.slice(0, nextFn.index!) : rest,
        bodyStart,
      });
    }
    return out;
  }
  const decls = [...code.matchAll(TEST_FN_JS)];
  for (let i = 0; i < decls.length; i += 1) {
    const m = decls[i]!;
    const start = m.index!;
    const bodyStart = start + m[0].length;
    const bodyEnd = decls[i + 1]?.index ?? code.length;
    // The coordinate comes from the NAME's offset, not the match's: TEST_FN_JS
    // opens with `(?:^|\s)`, which CONSUMES the character before `it`/`test` --
    // for any test not on line 1 that is the previous line's newline (#633).
    const nameStart = m.indices?.[1]?.[0] ?? start;
    out.push({
      name: m.indices?.[1]
        ? source.slice(m.indices[1][0], m.indices[1][1])
        : m[1]!,
      line: lineOf(code, nameStart),
      body: code.slice(bodyStart, bodyEnd),
      bodyStart,
    });
  }
  return out;
}

function scanAssertionFreePy(code: string, file: string): LintFinding[] {
  const out: LintFinding[] = [];
  for (const t of enumerateTests(code, code, true)) {
    if (!ASSERT_PY.test(t.body)) {
      out.push(
        mk(
          file,
          t.line,
          'LINT-006',
          'warning',
          `\`${t.name}\` contains no assertions.`,
          'Add at least one assert statement; a test that never fails proves nothing.',
        ),
      );
    }
  }
  return out;
}

function scanAssertionFreeJs(
  code: string,
  file: string,
  source: string,
): LintFinding[] {
  const out: LintFinding[] = [];
  // Bodies are bounded by the NEXT declaration -- see `enumerateTests`, which
  // now owns that logic and its bug history (#590, #633) for both languages.
  for (const t of enumerateTests(code, source, false)) {
    if (!ASSERT_JS.test(t.body)) {
      out.push(
        mk(
          file,
          t.line,
          'LINT-006',
          'warning',
          `Test "${t.name}" contains no assertions.`,
          'Add an expect() call; a test that never asserts always passes.',
        ),
      );
    }
  }
  return out;
}

/**
 * Extensions whose contents the JS/TS scanners can actually read. ESM (`.mjs`)
 * and CJS (`.cjs`) belong here as much as `.js` does -- omitting them is what
 * made #566 possible.
 */
export const JS_TEST_EXTENSIONS = [
  '.ts',
  '.js',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
] as const;

const JS_EXT_SET: ReadonlySet<string> = new Set(JS_TEST_EXTENSIONS);

/**
 * The framework whose scanners can parse `path`, or `null` when no scanner
 * understands the extension.
 *
 * This deliberately has no default. The previous `return 'pytest'` fallback
 * meant an unrecognised extension was silently handed to the Python assertion
 * scanners: over ESM JavaScript they match nothing, so a `.mjs` file with real
 * defects linted to zero findings and rendered a green all-clear (#566). A
 * guess that cannot be distinguished from a clean result is a false green;
 * `null` forces the caller to abstain instead.
 */
export function frameworkForPath(path: string): string | null {
  const suffix = extname(path).toLowerCase();
  const name = basename(path).toLowerCase();
  if (suffix === '.py') return 'pytest';
  if (name.includes('playwright')) return 'playwright';
  if (JS_EXT_SET.has(suffix)) return 'vitest';
  return null;
}

/** Thrown when a scanner is asked for a file no ruleset can parse. */
export class UnsupportedTestFileError extends Error {
  constructor(readonly path: string) {
    super(`No linter ruleset can parse ${extname(path) || basename(path)}`);
    this.name = 'UnsupportedTestFileError';
  }
}

function requireFramework(path: string, framework?: string): string {
  const fw = framework || frameworkForPath(path);
  if (fw === null) throw new UnsupportedTestFileError(path);
  return fw;
}

export class StaticLinter {
  /** Full quality audit — all rules. */
  lint(path: string, framework?: string): LintFinding[] {
    const code = readFileSync(path, 'utf-8');
    // No rule may read the interior of a string as code. The per-line rules
    // keep the line-oriented blanking they were written against; the assertion
    // scanners take a whole-source pass instead, because they are the only
    // rules that bound one match by the offset of the NEXT one -- so a phantom
    // declaration inside a fixture does not just add a finding, it truncates a
    // real test's body and attributes its assertion past the end (#590).
    // Both blankers preserve line numbering, so findings agree on line numbers.
    const lines = blankMultilineStrings(code.split('\n'));
    const fw = requireFramework(path, framework);
    const scanned = blankStringContent(code, { python: fw === 'pytest' });
    const findings: LintFinding[] = [
      ...scanFlakiness(lines, path),
      ...scanSelectors(lines, path),
      ...scanMissingAwait(lines, path),
      ...scanMagicNumbers(lines, path),
      ...scanSoundness(lines, path, fw === 'pytest'),
      ...(fw === 'pytest'
        ? scanAssertionFreePy(scanned, path)
        : scanAssertionFreeJs(scanned, path, code)),
    ];
    findings.sort((a, b) => a.line - b.line || cmp(a.rule, b.rule));
    return findings;
  }

  /** Flakiness-only subset. */
  flakeCheck(path: string): LintFinding[] {
    const code = readFileSync(path, 'utf-8');
    const findings = scanFlakiness(
      blankMultilineStrings(code.split('\n')),
      path,
    );
    findings.sort((a, b) => a.line - b.line);
    return findings;
  }
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
