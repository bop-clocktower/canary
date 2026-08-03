/**
 * Static linter for test files — faithful TS port of
 * `agent/core/static_linter.py`.
 *
 * Produces file:line findings without executing tests. Powers the static
 * review + flake-check subsets. Regex/line based; pure filesystem reads.
 */

import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';

export interface Finding {
  file: string;
  line: number;
  rule: string;
  severity: 'critical' | 'warning' | 'info';
  message: string;
  suggestion: string;
}

export function formatFinding(f: Finding): string {
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
const TEST_FN_PY = /^(\s*)def (test_\w+)\s*\(/gm;
const TEST_FN_JS = /(?:^|\s)(?:it|test)\s*\(\s*['"]([^'"]*)['"]/gm;
const ASSERT_PY = /\bassert\b|\bpytest\.raises\b/;
// Assertion styles a JS/TS test may use. `expect()` (jest/vitest/playwright)
// was the only one recognized until canary was pointed at its own suites and
// reported 216 assertion-free tests of which 13 were real -- the other 200 were
// `node:test` + `node:assert`, a whole framework the linter could not see.
// Kept as a union of shapes rather than an import-aware parse: a static linter
// that needs to resolve imports to judge one line is the wrong trade.
const ASSERT_JS =
  /\bexpect\s*\(|\bto(?:Be|Equal|Contain|Have|Match|Throw|Raise)\b|\bassert\s*\.\s*\w+\s*\(|\bassert\s*\(|\bshould\s*\.|\.should\b/;

// Strippers
const STRING_LITERAL = /(['"])(?:\\.|(?!\1).)*?\1/g;

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
  severity: Finding['severity'],
  message: string,
  suggestion: string,
): Finding {
  return { file, line, rule, severity, message, suggestion };
}

interface FlakeRule {
  re: RegExp;
  rule: string;
  severity: Finding['severity'];
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

function scanFlakiness(lines: string[], file: string): Finding[] {
  const out: Finding[] = [];
  lines.forEach((line, idx) => {
    if (isComment(line)) return;
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
): Finding | null {
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

function scanSelectors(lines: string[], file: string): Finding[] {
  const out: Finding[] = [];
  lines.forEach((line, idx) => {
    if (isComment(line) || !LOCATOR_METHODS.test(line)) return;
    const finding = selectorFinding(line, idx + 1, file);
    if (finding) out.push(finding);
  });
  return out;
}

function scanMissingAwait(lines: string[], file: string): Finding[] {
  const out: Finding[] = [];
  lines.forEach((line, idx) => {
    if (isComment(line)) return;
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

function scanMagicNumbers(lines: string[], file: string): Finding[] {
  const out: Finding[] = [];
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

function lineOf(code: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < offset && i < code.length; i++) {
    if (code[i] === '\n') n++;
  }
  return n;
}

function scanAssertionFreePy(code: string, file: string): Finding[] {
  const out: Finding[] = [];
  for (const m of code.matchAll(TEST_FN_PY)) {
    const indent = m[1]!.length;
    const start = m.index!;
    const rest = code.slice(start + m[0].length);
    const nextFn = rest.match(new RegExp(`^[ \\t]{${indent}}def `, 'm'));
    const body = nextFn ? rest.slice(0, nextFn.index!) : rest;
    if (!ASSERT_PY.test(body)) {
      out.push(
        mk(
          file,
          lineOf(code, start),
          'LINT-006',
          'warning',
          `\`${m[2]!}\` contains no assertions.`,
          'Add at least one assert statement; a test that never fails proves nothing.',
        ),
      );
    }
  }
  return out;
}

function scanAssertionFreeJs(code: string, file: string): Finding[] {
  const out: Finding[] = [];
  // The test declarations, in source order, so each body can be bounded by the
  // NEXT one -- the JS analogue of what the pytest scanner already does with
  // "next `def` at the same indent".
  //
  // This replaces a fixed 2000-character lookahead that was wrong in BOTH
  // directions: a long test whose first assertion fell past the window was
  // flagged (false positive), and a short empty test could borrow the next
  // test's assertion from inside the window (false negative). Neither failure
  // is visible without a real codebase to run it against, which is why
  // dogfooding found them and the unit tests did not.
  const decls = [...code.matchAll(TEST_FN_JS)];
  for (let i = 0; i < decls.length; i += 1) {
    const m = decls[i]!;
    const start = m.index!;
    const bodyStart = start + m[0].length;
    const bodyEnd = decls[i + 1]?.index ?? code.length;
    const rest = code.slice(bodyStart, bodyEnd);
    if (!ASSERT_JS.test(rest)) {
      out.push(
        mk(
          file,
          lineOf(code, start),
          'LINT-006',
          'warning',
          `Test "${m[1]!}" contains no assertions.`,
          'Add an expect() call; a test that never asserts always passes.',
        ),
      );
    }
  }
  return out;
}

function detectFramework(path: string): string {
  const suffix = extname(path).toLowerCase();
  const name = basename(path).toLowerCase();
  if (suffix === '.py') return 'pytest';
  if (name.includes('playwright')) return 'playwright';
  if (suffix === '.ts' || suffix === '.js') return 'vitest';
  return 'pytest';
}

export class StaticLinter {
  /** Full quality audit — all rules. */
  lint(path: string, framework?: string): Finding[] {
    const code = readFileSync(path, 'utf-8');
    // Per-line rules must not read the interior of a multi-line string as code.
    const lines = blankMultilineStrings(code.split('\n'));
    const fw = framework || detectFramework(path);
    const findings: Finding[] = [
      ...scanFlakiness(lines, path),
      ...scanSelectors(lines, path),
      ...scanMissingAwait(lines, path),
      ...scanMagicNumbers(lines, path),
      ...(fw === 'pytest'
        ? scanAssertionFreePy(code, path)
        : scanAssertionFreeJs(code, path)),
    ];
    findings.sort((a, b) => a.line - b.line || cmp(a.rule, b.rule));
    return findings;
  }

  /** Flakiness-only subset. */
  flakeCheck(path: string): Finding[] {
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
