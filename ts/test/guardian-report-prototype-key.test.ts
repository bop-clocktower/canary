/**
 * A path or name taken from an external report that collides with an
 * Object.prototype key must neither leak data into every other object in the
 * process nor crash the reader, and a file that is genuinely named that way
 * must resolve as itself (GHSA-w522-r2v2-gcc3, CWE-1321).
 *
 * `prototype` is in the positive-control block only: on a plain object it is an
 * ordinary own key, so it was never vulnerable — the control proves the fix
 * keeps it that way.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveFromReport } from '../src/guardian/coverage.js';
import { readJunitReport } from '../src/history/formats/junit-report.js';
import { invokeGuardian } from './guardian-cli-testkit.js';

const LINE = 987654;
let dir: string | null = null;

afterEach(() => {
  // Undo any leak so a red run never poisons sibling tests.
  delete (Object.prototype as Record<number, unknown>)[LINE];
  delete (Object as unknown as Record<number, unknown>)[LINE];
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function writeReport(name: string, body: string): string {
  dir = mkdtempSync(join(tmpdir(), 'canary-proto-key-'));
  const report = join(dir, name);
  writeFileSync(report, body, 'utf-8');
  return report;
}

const lcov = (key: string): string =>
  `SF:${key}\nDA:${LINE},3\nend_of_record\nSF:src/a.ts\nDA:1,1\nend_of_record\n`;

const cobertura = (key: string): string =>
  '<?xml version="1.0"?>\n<coverage><packages><package><classes>' +
  `<class filename="${key}"><lines><line number="${LINE}" hits="3"/></lines></class>` +
  '<class filename="src/a.ts"><lines><line number="1" hits="1"/></lines></class>' +
  '</classes></package></packages></coverage>\n';

const READERS = [
  { format: 'lcov', file: 'lcov.info', body: lcov },
  { format: 'Cobertura', file: 'coverage.xml', body: cobertura },
] as const;

const leaked = (): unknown[] => [
  ({} as Record<number, unknown>)[LINE],
  (Object as unknown as Record<number, unknown>)[LINE],
];

describe('report keys that collide with Object.prototype', () => {
  it('an lcov SF record named __proto__ leaves Object.prototype untouched', () => {
    const report = writeReport('lcov.info', lcov('__proto__'));
    resolveFromReport([{ path: 'src/a.ts', added_ranges: [[1, 1]] }], report);
    expect(({} as Record<number, unknown>)[LINE]).toBeUndefined();
  });

  for (const { format, file, body } of READERS) {
    for (const key of ['__proto__', 'constructor']) {
      it(`a ${format} record named ${key} mutates no shared object`, () => {
        const report = writeReport(file, body(key));
        resolveFromReport(
          [{ path: 'src/a.ts', added_ranges: [[1, 1]] }],
          report,
        );
        expect(leaked()).toEqual([undefined, undefined]);
      });

      it(`a ${format} record named ${key} resolves as its own file`, () => {
        const report = writeReport(file, body(key));
        const results = resolveFromReport(
          [{ path: key, added_ranges: [[LINE, LINE]] }],
          report,
        );
        expect(results?.map((r) => [r.unit.path, r.covered])).toEqual([
          [key, true],
        ]);
      });
    }
  }

  it('a coverage-json entry named __proto__ resolves as its own file', () => {
    // Written by hand: JSON.parse makes `__proto__` an own key, which is
    // exactly the shape a crafted report arrives in.
    const report = writeReport(
      'coverage.json',
      `{"files": {"__proto__": {"covered_lines": [${LINE}]}}}`,
    );
    const results = resolveFromReport(
      [{ path: '__proto__', added_ranges: [[LINE, LINE]] }],
      report,
    );
    expect(results?.map((r) => [r.unit.path, r.covered])).toEqual([
      ['__proto__', true],
    ]);
  });

  for (const key of ['__proto__', 'constructor', 'toString']) {
    it(`a changed file named ${key} the report never lists falls through`, () => {
      const report = writeReport(
        'lcov.info',
        'SF:src/a.ts\nDA:1,1\nend_of_record\n',
      );
      const results = resolveFromReport(
        [{ path: key, added_ranges: [[1, 1]] }],
        report,
      );
      expect(results).toEqual([]);
    });
  }

  it('a JUnit entity named after a prototype key stays literal text', () => {
    const xml =
      '<testsuite name="s">' +
      '<testcase classname="&constructor;" name="&__proto__;"/>' +
      '<testcase name="&toString;"/>' +
      '</testsuite>';
    const { results } = readJunitReport(xml, {
      suite: 's',
      repo: 'r',
      branch: 'b',
      commitSha: 'c',
      nowMs: 0,
    });
    expect(results.map((r) => r.test_name)).toEqual([
      '&constructor;::&__proto__;',
      '&toString;',
    ]);
  });

  it('a Stryker file named after a prototype key has its suppressions read', async () => {
    dir = mkdtempSync(join(tmpdir(), 'canary-proto-key-'));
    const root = join(dir, 'repo');
    mkdirSync(root, { recursive: true });
    const keys = ['__proto__', 'constructor'];
    for (const key of keys) {
      writeFileSync(
        join(root, key),
        'x(); // canary:allow-mutant equivalent mutant\n',
        'utf-8',
      );
    }
    // fromEntries defines `__proto__` as an own key, so it survives
    // JSON.stringify the way it would arrive in a crafted report.
    const files = Object.fromEntries(
      keys.map((key) => [
        key,
        {
          mutants: [
            {
              id: key,
              mutatorName: 'ConditionalExpression',
              replacement: 'false',
              status: 'Survived',
              location: { start: { line: 1, column: 1 } },
              coveredBy: ['t1'],
            },
          ],
        },
      ]),
    );
    const report = join(dir, 'mutation.json');
    writeFileSync(
      report,
      JSON.stringify({ schemaVersion: '1', files }),
      'utf-8',
    );
    const res = await invokeGuardian([
      'mutation',
      '--report',
      report,
      '--repo-root',
      root,
      '--json',
    ]);
    const data = JSON.parse(res.stdout);
    expect(data.findings).toEqual([]);
    expect(
      data.suppressed.map((s: { finding: { path: string } }) => s.finding.path),
    ).toEqual(keys);
  });
});

describe('positive control: ordinary and never-vulnerable keys', () => {
  for (const { format, file, body } of READERS) {
    for (const key of ['src/b.ts', 'prototype']) {
      it(`a ${format} record named ${key} resolves exactly as before`, () => {
        const report = writeReport(file, body(key));
        const results = resolveFromReport(
          [
            { path: key, added_ranges: [[LINE, LINE]] },
            { path: 'src/a.ts', added_ranges: [[1, 2]] },
          ],
          report,
        );
        expect(
          results?.map((r) => [r.unit.path, r.covered, r.uncovered_lines]),
        ).toEqual([
          [key, true, []],
          ['src/a.ts', true, []],
        ]);
        expect(leaked()).toEqual([undefined, undefined]);
      });
    }
  }
});
