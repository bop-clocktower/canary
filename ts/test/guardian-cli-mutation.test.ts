/**
 * `canary guardian mutation` (#486).
 *
 * The exit-code contract is the point: 0 all-killed, 1 survivors, 3 abstained.
 * The abstention cases are tested hardest, because an abstention that decays
 * into a silent exit 0 is the false green this command exists to prevent.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { RUNNER_ISSUE } from '../src/guardian/mutation.js';

import { invokeGuardian, invokeGuardianJson } from './guardian-cli-testkit.js';

/** Write a Stryker JSON report and return its path. */
function writeReport(
  mutants: Array<{ line: number; status: string; coveredBy?: string[] }>,
  source = 'const a = 1;\nconst b = 2;\n',
): { reportPath: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'canary-mutation-cli-'));
  mkdirSync(join(root, 'ts', 'src'), { recursive: true });
  writeFileSync(join(root, 'ts', 'src', 'a.ts'), source);
  const report = {
    schemaVersion: '1',
    files: {
      'ts/src/a.ts': {
        mutants: mutants.map((m, i) => ({
          id: String(i),
          mutatorName: 'ConditionalExpression',
          replacement: 'false',
          status: m.status,
          location: { start: { line: m.line, column: 1 } },
          ...(m.coveredBy === undefined ? {} : { coveredBy: m.coveredBy }),
        })),
      },
    },
    testFiles: {
      'ts/test/a.test.ts': { tests: [{ id: 't1', name: 'a covering test' }] },
    },
  };
  const reportPath = join(root, 'mutation.json');
  writeFileSync(reportPath, JSON.stringify(report));
  return { reportPath, root };
}

describe('guardian mutation exit codes', () => {
  it('exits 0 and shows the denominator when every mutant was killed', async () => {
    const { reportPath, root } = writeReport([
      { line: 1, status: 'Killed', coveredBy: ['t1'] },
    ]);
    const res = await invokeGuardian(
      ['mutation', '--report', reportPath, '--repo-root', root],
      {},
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('1/1 mutants killed');
  });

  it('exits 1 on a survivor and names the test that did not fail', async () => {
    const { reportPath, root } = writeReport([
      { line: 1, status: 'Survived', coveredBy: ['t1'] },
    ]);
    const res = await invokeGuardian([
      'mutation',
      '--report',
      reportPath,
      '--repo-root',
      root,
    ]);
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('a covering test');
  });

  it('exits 1 on an unattributed survivor and discloses the missing attribution (ADR 0037 F1)', async () => {
    const { reportPath, root } = writeReport([
      { line: 1, status: 'Killed' },
      { line: 2, status: 'Survived' },
    ]);
    const res = await invokeGuardian([
      'mutation',
      '--report',
      reportPath,
      '--repo-root',
      root,
    ]);
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('attribution not recorded');
    expect(res.stdout).toContain('coverageAnalysis: perTest');
    expect(res.stdout).not.toContain('no covering test');
  });

  it('exits 3 and abstains when the report holds no mutants', async () => {
    const { reportPath, root } = writeReport([]);
    const res = await invokeGuardian([
      'mutation',
      '--report',
      reportPath,
      '--repo-root',
      root,
    ]);
    expect(res.code).toBe(3);
    expect(res.stdout).toContain('Abstained');
    expect(res.stdout).not.toContain('0 survived');
  });

  it('exits 3 rather than passing when the report cannot be read', async () => {
    const res = await invokeGuardian([
      'mutation',
      '--report',
      join(tmpdir(), 'canary-mutation-does-not-exist.json'),
    ]);
    expect(res.code).toBe(3);
    expect(res.stdout).toContain('Abstained');
  });

  it('honors a canary:allow-mutant suppression on the mutated line', async () => {
    const { reportPath, root } = writeReport(
      [{ line: 2, status: 'Survived', coveredBy: ['t1'] }],
      'const a = 1;\nconst b = 2; // canary:allow-mutant equivalent mutant\n',
    );
    const res = await invokeGuardian([
      'mutation',
      '--report',
      reportPath,
      '--repo-root',
      root,
    ]);
    expect(res.stdout).toContain('equivalent mutant');
    expect(res.code).toBe(3);
  });
});

describe('guardian mutation abstain guard (F6)', () => {
  it('abstains, naming the upstream issue, when the runner cannot kill', async () => {
    const res = await invokeGuardian([
      'mutation',
      '--runner-version',
      '10.0.0',
      '--vitest-version',
      '5.0.0',
    ]);
    expect(res.code).toBe(3);
    expect(res.stdout).toContain(RUNNER_ISSUE);
    expect(res.stdout).toContain('Abstained');
  });

  it('never reports a survivor while the guard is closed', async () => {
    const res = await invokeGuardianJson([
      'mutation',
      '--json',
      '--runner-version',
      '10.0.0',
      '--vitest-version',
      '5.0.0',
    ]);
    expect(res.verdict).toBe('abstained');
    expect(res.survived).toBe(0);
    expect(res.findings).toEqual([]);
  });

  it('lets a compatible runner through the guard to the diff (#486 slice 2)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'canary-mutation-guard-'));
    const diff = join(root, 'docs.diff');
    writeFileSync(
      diff,
      'diff --git a/docs/a.md b/docs/a.md\n--- a/docs/a.md\n+++ b/docs/a.md\n@@ -0,0 +1 @@\n+hi\n',
    );
    const res = await invokeGuardian([
      'mutation',
      '--repo-root',
      root,
      '--diff',
      diff,
      '--runner-version',
      '11.0.0',
      '--vitest-version',
      '5.0.0',
    ]);
    expect(res.code).toBe(3);
    expect(res.stdout).toContain('adds no lines under ts/src');
    expect(res.stdout).not.toContain(RUNNER_ISSUE);
  });
});

describe('guardian mutation disclosure', () => {
  it('discloses the thread-unsafe suites a --pool threads report excluded', async () => {
    const { reportPath, root } = writeReport([
      { line: 1, status: 'Killed', coveredBy: ['t1'] },
    ]);
    mkdirSync(join(root, 'ts', 'test'), { recursive: true });
    writeFileSync(join(root, 'ts', 'test', 'a.test.ts'), 'process.chdir(d);');
    const base = ['mutation', '--json', '--report', reportPath];
    const threads = await invokeGuardianJson([
      ...base,
      '--repo-root',
      root,
      '--pool',
      'threads',
    ]);
    expect(threads.excludedTests).toEqual(['test/a.test.ts']);
    // The forks pool (the default, and canary's own run) excludes nothing, so
    // claiming those suites were skipped would be a false disclosure.
    const forks = await invokeGuardianJson([...base, '--repo-root', root]);
    expect(forks.excludedTests).toEqual([]);
  });

  it('writes the report artifact when asked', async () => {
    const { reportPath, root } = writeReport([
      { line: 1, status: 'Killed', coveredBy: ['t1'] },
    ]);
    const out = join(root, 'out', 'mutation-report.json');
    const res = await invokeGuardian([
      'mutation',
      '--report',
      reportPath,
      '--repo-root',
      root,
      '--report-out',
      out,
    ]);
    expect(res.code).toBe(0);
    const written = JSON.parse(readFileSync(out, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(written.verdict).toBe('all-killed');
  });
});

// bug-fleet A5: a report whose file entry has no `mutants` array threw a
// raw TypeError (exit 1 = "survivors" under ADR 0009) instead of abstaining
// like the missing-`files` case does.
describe('bug-fleet A5: malformed stryker file entry', () => {
  it.each([
    ['no mutants list', { 'src/a.ts': {} }],
    ['a mutant without a location', { 'src/a.ts': { mutants: [{ id: '1' }] } }],
  ])('abstains (exit 3) on %s instead of crashing', async (_label, files) => {
    const root = mkdtempSync(join(tmpdir(), 'bf-a5-mut-'));
    const p = join(root, 'r.json');
    writeFileSync(p, JSON.stringify({ files }));
    const outcome = await invokeGuardian([
      'mutation',
      '--report',
      p,
      '--repo-root',
      root,
    ]).then(
      (r) => r.code,
      (e: unknown) => `threw: ${String(e)}`,
    );
    expect(outcome).toBe(3);
  });

  // #1568 item 3: these passed the shape check, then `.map` / `for...of`
  // threw mid-mapping, and an uncaught throw exits 1, which reads as
  // "survivors" under ADR 0009.
  const located = (extra: Record<string, unknown>) => ({
    'src/a.ts': {
      mutants: [
        {
          id: '1',
          mutatorName: 'BooleanLiteral',
          status: 'Survived',
          location: { start: { line: 1, column: 1 } },
          ...extra,
        },
      ],
    },
  });
  it.each([
    ['a string coveredBy', { files: located({ coveredBy: 't1' }) }],
    ['an object coveredBy', { files: located({ coveredBy: { t1: true } }) }],
    // Review of #1568: the new escaping calls string methods on these.
    ['a missing mutatorName', { files: located({ mutatorName: undefined }) }],
    ['a numeric replacement', { files: located({ replacement: 7 }) }],
    [
      'a numeric test name',
      {
        files: located({ coveredBy: ['t1'] }),
        testFiles: { 'a.test.ts': { tests: [{ id: 't1', name: 7 }] } },
      },
    ],
    [
      'a testFiles entry without a tests list',
      { files: located({ coveredBy: ['t1'] }), testFiles: { 'a.test.ts': {} } },
    ],
  ])('abstains (exit 3) on %s instead of crashing', async (_label, body) => {
    const root = mkdtempSync(join(tmpdir(), 'mut-1568-'));
    const p = join(root, 'r.json');
    writeFileSync(p, JSON.stringify(body));
    const outcome = await invokeGuardian([
      'mutation',
      '--report',
      p,
      '--repo-root',
      root,
    ]).then(
      (r) => ({ code: r.code, out: r.stdout }),
      (e: unknown) => ({ code: `threw: ${String(e)}`, out: '' }),
    );
    expect(outcome.code).toBe(3);
    expect(outcome.out).toContain('Abstained');
  });
});
