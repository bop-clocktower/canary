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

  it('abstains on a compatible runner too, because no run is wired yet', async () => {
    const res = await invokeGuardian([
      'mutation',
      '--runner-version',
      '11.0.0',
      '--vitest-version',
      '5.0.0',
    ]);
    expect(res.code).toBe(3);
    expect(res.stdout).toContain('Abstained');
    expect(res.stdout).not.toContain(RUNNER_ISSUE);
  });
});

describe('guardian mutation disclosure', () => {
  it('discloses the excluded thread-unsafe suites in JSON', async () => {
    const root = mkdtempSync(join(tmpdir(), 'canary-mutation-disclose-'));
    mkdirSync(join(root, 'ts', 'test'), { recursive: true });
    mkdirSync(join(root, 'ts', 'src'), { recursive: true });
    writeFileSync(join(root, 'ts', 'test', 'a.test.ts'), 'process.chdir(d);');
    const res = await invokeGuardianJson([
      'mutation',
      '--json',
      '--repo-root',
      root,
      '--runner-version',
      '10.0.0',
      '--vitest-version',
      '5.0.0',
    ]);
    expect(res.excludedTests).toEqual(['test/a.test.ts']);
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
