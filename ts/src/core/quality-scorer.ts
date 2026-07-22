/**
 * Test quality static analyser.
 *
 * Faithful TypeScript port of `agent/core/quality_scorer.py`. Scores test code
 * on coverage breadth, assertion density, and flakiness risk, plus a
 * magic-number maintainability nudge. Purely lexical — no execution.
 */

import { num1, roundHalfEvenInt } from '../util/round.js';

const TEST_FN: Record<string, RegExp> = {
  pytest: /^[ \t]*def test_/gm,
  playwright: /\btest\s*\(/gm,
  vitest: /\b(?:it|test)\s*\(/gm,
  k6: /\bcheck\s*\(/gm,
};

const ASSERTIONS: Record<string, RegExp> = {
  pytest: /\bassert\b|\bpytest\.raises\b|\bself\.assert\w+\b/g,
  playwright:
    /\bexpect\s*\(|\btoBeVisible\b|\btoHaveText\b|\btoHaveTitle\b|\btoHaveURL\b|\btoBeEnabled\b|\btoBeDisabled\b|\btoBeChecked\b|\btoHaveValue\b|\btoHaveCount\b/g,
  vitest:
    /\bexpect\s*\(|\btoBe\s*\(|\btoEqual\s*\(|\btoThrow\b|\btoContain\s*\(|\btoBeNull\b|\btoBeUndefined\b|\btoMatchObject\b/g,
  k6: /\bcheck\s*\(|'[^']+'\s*:\s*\([^)]*\)\s*=>/g,
};

const NEGATIVE_KW =
  /\b(error|invalid|empty|null|undefined|throws|raises|exception|fail|missing|negative|reject|4\d{2}|5\d{2}|boundary|edge)\b/i;
const PARAMETRIZE =
  /@pytest\.mark\.parametrize|test\.each\s*\(|describe\.each\s*\(|it\.each\s*\(/;
const SLEEP =
  /time\.sleep\s*\(|page\.waitForTimeout\s*\(|await\s+new\s+Promise[^)]*setTimeout|setTimeout\s*\(/g;
const RANDOM =
  /Math\.random\s*\(|random\.random\s*\(|random\.choice\s*\(|random\.randint\s*\(/;
const TIMESTAMP = /Date\.now\s*\(|datetime\.now\s*\(|datetime\.utcnow\s*\(/;

// Blank out string contents before magic-number scanning.
const STRING_LITERAL = /(['"])(?:\\.|(?!\1).)*?\1/g;
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
const MAX_MAGIC_FINDINGS = 10;

export interface QualityScore {
  score: number;
  grade: string;
  coverage_breadth: number;
  assertion_density: number;
  flakiness_risk: number;
  magic_numbers: number;
  details: string[];
}

function countMatches(re: RegExp, code: string): number {
  return (code.match(re) ?? []).length;
}

function isAllowedNumber(token: string): boolean {
  if (ALLOWED_NUMBERS.has(token) || HTTP_STATUS.has(token)) return true;
  const bare = token.replace(/^-/, '');
  return /^\d$/.test(bare);
}

function detectMagicNumbers(code: string): string[] {
  const findings: string[] = [];
  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i]!.trim();
    if (stripped.startsWith('#') || stripped.startsWith('//')) continue;
    const scrubbed = lines[i]!.replace(STRING_LITERAL, '""');
    for (const m of scrubbed.matchAll(NUMERIC_LITERAL)) {
      const token = m[0];
      if (isAllowedNumber(token)) continue;
      findings.push(
        `line ${i + 1}: magic number ${token} — name it or derive it`,
      );
      if (findings.length >= MAX_MAGIC_FINDINGS) return findings;
    }
  }
  return findings;
}

const COVERAGE_BASE = [0, 25, 45, 65, 80, 90];

function scoreCoverage(code: string, framework: string): [number, string[]] {
  const details: string[] = [];
  const pattern = TEST_FN[framework] ?? TEST_FN['pytest']!;
  const count = countMatches(pattern, code);

  const label = framework === 'k6' ? 'check' : 'test function';
  details.push(`${count} ${label}${count !== 1 ? 's' : ''} found`);

  const base = Math.min(90, COVERAGE_BASE[Math.min(count, 5)]!);
  let bonus = 0;
  if (NEGATIVE_KW.test(code)) {
    bonus += 10;
    details.push('Covers error/invalid paths');
  }
  if (PARAMETRIZE.test(code)) {
    bonus += 10;
    details.push('Parametrized test cases detected');
  }
  return [Math.min(100, base + bonus), details];
}

function densityScore(density: number): number {
  if (density === 0) return 0;
  if (density < 1) return 25;
  if (density < 2) return 55;
  if (density < 3) return 75;
  if (density < 4) return 88;
  return 97;
}

function scoreAssertions(code: string, framework: string): [number, string[]] {
  const fnPat = TEST_FN[framework] ?? TEST_FN['pytest']!;
  const assertPat = ASSERTIONS[framework] ?? ASSERTIONS['pytest']!;
  const testCount = Math.max(1, countMatches(fnPat, code));
  const assertCount = countMatches(assertPat, code);
  const density = assertCount / testCount;
  const details = [
    `${assertCount} assertion${assertCount !== 1 ? 's' : ''}, ${num1(density)} per test`,
  ];
  return [densityScore(density), details];
}

function scoreFlakiness(code: string): [number, string[]] {
  const details: string[] = [];
  let score = 100;

  const sleepN = countMatches(SLEEP, code);
  if (sleepN) {
    score -= Math.min(40, sleepN * 20);
    details.push(`${sleepN} hardcoded wait${sleepN !== 1 ? 's' : ''} detected`);
  }
  if (RANDOM.test(code)) {
    score -= 15;
    details.push('Non-deterministic random values detected');
  }
  if (TIMESTAMP.test(code)) {
    score -= 10;
    details.push('Timestamp-dependent assertions detected');
  }
  if (details.length === 0) details.push('No flakiness signals detected');
  return [Math.max(0, score), details];
}

function grade(score: number): string {
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 55) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

function magicDetails(findings: string[]): string[] {
  if (findings.length === 0) return ['No magic numbers detected'];
  return [`${findings.length} magic number(s) detected`, ...findings];
}

export class QualityScorer {
  /** Score `code` (a source string) for the given framework. */
  score(code: string, framework: string): QualityScore {
    const fw = framework.toLowerCase();
    const [coverage, covDetails] = scoreCoverage(code, fw);
    const [assertion, asrDetails] = scoreAssertions(code, fw);
    const [flakiness, flkDetails] = scoreFlakiness(code);
    const magic = detectMagicNumbers(code);

    const raw = roundHalfEvenInt(
      0.4 * coverage + 0.4 * assertion + 0.2 * flakiness,
    );
    const composite = Math.max(0, raw - Math.min(15, magic.length * 3));

    return {
      score: composite,
      grade: grade(composite),
      coverage_breadth: coverage,
      assertion_density: assertion,
      flakiness_risk: flakiness,
      magic_numbers: magic.length,
      details: [
        ...covDetails,
        ...asrDetails,
        ...flkDetails,
        ...magicDetails(magic),
      ],
    };
  }
}
