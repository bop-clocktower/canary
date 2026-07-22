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
const ASSERT_JS =
  /\bexpect\s*\(|\bto(?:Be|Equal|Contain|Have|Match|Throw|Raise)\b/;

// Strippers
const STRING_LITERAL = /(['"])(?:\\.|(?!\1).)*?\1/g;

// Magic numbers
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

function scanMagicNumbers(lines: string[], file: string): Finding[] {
  const out: Finding[] = [];
  lines.forEach((raw, idx) => {
    if (isComment(raw)) return;
    const scrubbed = raw.replace(STRING_LITERAL, '""');
    for (const m of scrubbed.matchAll(NUMERIC_LITERAL)) {
      if (isAllowedNumber(m[0])) continue;
      out.push(
        mk(
          file,
          idx + 1,
          'LINT-005',
          'info',
          `Magic number ${m[0]}.`,
          'Extract to a named constant or derive from test data.',
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
  for (const m of code.matchAll(TEST_FN_JS)) {
    const start = m.index!;
    const rest = code.slice(start + m[0].length, start + m[0].length + 2000);
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
    const lines = code.split('\n');
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
    const findings = scanFlakiness(code.split('\n'), path);
    findings.sort((a, b) => a.line - b.line);
    return findings;
  }
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
