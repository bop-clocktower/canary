/**
 * canary-judomaster run classifier (#614): a verdict comes from a real run,
 * and a pass is never reported as success (D2-D5, D9).
 */

import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  classifyRun,
  containedInGenerated,
  inferFramework,
} from '../src/analysis/judomaster/verify.js';

const SIG = {
  text: "Cannot read properties of undefined (reading 'qty')",
  kind: 'message' as const,
};
const COULD_NOT = 'unverified — could not reproduce';

describe('classifyRun', () => {
  it('refuses a signature match the test could have printed itself', () => {
    // A failing assertion prints its own source; a test that quotes the
    // incident's error text would "match" whatever made it fail.
    const source = `expect(msg).toBe("${SIG.text}")`;
    const r = classifyRun(
      [1, `AssertionError\n> ${source}`, ''],
      SIG,
      'vitest',
      source,
    );
    expect(r.verdict).toBe('failed-other-reason');
    expect(r.label).toBe('unverified');
    expect(r.reason).toContain("test's own source");
  });

  it('still reproduces when the test source does not quote the signature', () => {
    const r = classifyRun(
      [1, `TypeError: ${SIG.text}`, ''],
      SIG,
      'vitest',
      'expect(cartTotal([{ price: 2 }])).toBe(0)',
    );
    expect(r.verdict).toBe('reproduced');
  });

  it('keeps the last lines of runner output, ANSI stripped', () => {
    const out = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const r = classifyRun([1, `\x1b[31m${out}\x1b[0m`, ''], SIG, 'vitest');
    expect(r.tail).toHaveLength(15);
    expect(r.tail?.at(-1)).toBe('line 29');
    expect(r.tail?.join('\n')).not.toContain('\x1b');
  });

  it('flags a first-run pass as not-reproduced with vacuity', () => {
    const r = classifyRun([0, '1 passed', ''], SIG, 'vitest');
    expect(r.verdict).toBe('not-reproduced');
    expect(r.vacuity).toBe(true);
    expect(r.label).toBe('not-reproduced');
  });

  it('reproduces when a failing run carries the signature', () => {
    const r = classifyRun(
      [1, `FAIL x\n\x1b[31m${SIG.text}\x1b[0m\n`, ''],
      SIG,
      'vitest',
    );
    expect(r.verdict).toBe('reproduced');
    expect(r.vacuity).toBe(false);
  });

  it('matches the signature on stderr too', () => {
    const r = classifyRun([1, 'FAIL', `TypeError: ${SIG.text}`], SIG, 'vitest');
    expect(r.verdict).toBe('reproduced');
  });

  it('labels a failure without the signature unverified', () => {
    const r = classifyRun([1, 'AssertionError', ''], SIG, 'vitest');
    expect(r.verdict).toBe('failed-other-reason');
    expect(r.label).toBe('unverified');
  });

  it('cannot confirm a failure with no signature', () => {
    const r = classifyRun([1, SIG.text, ''], null, 'vitest');
    expect(r.verdict).toBe('failed-other-reason');
    expect(r.reason).toContain('no signature to confirm against');
  });

  it.each([
    [[1, 'No test files found, exiting with code 1', ''], 'vitest'],
    [[5, '', ''], 'pytest'],
    [[1, 'Error: No tests found', ''], 'playwright'],
    [[1, 'Error: No test suite found in file /app/x.test.ts', ''], 'vitest'],
    [[124, 'partial', 'Execution timed out after 60 seconds.'], 'vitest'],
    [[127, '', 'npx: command not found'], 'vitest'],
    [[1, '', 'spawnSync npx ENOENT'], 'vitest'],
  ] as const)('could not run %j (%s)', (exec, framework) => {
    const r = classifyRun([...exec], SIG, framework);
    expect(r.verdict).toBe('unverified');
    expect(r.label).toBe(COULD_NOT);
    expect(r.vacuity).toBe(false);
  });

  it('lets a timeout outrank a signature in partial output', () => {
    const r = classifyRun([124, SIG.text, ''], SIG, 'vitest');
    expect(r.verdict).toBe('unverified');
  });
});

describe('inferFramework', () => {
  it.each([
    ['tests/generated/regression/test_a.py', 'pytest'],
    ['a.spec.ts', 'playwright'],
    ['a.e2e.js', 'playwright'],
    ['a.test.mts', 'vitest'],
    ['a.test.ts', 'vitest'],
    ['a.rb', null],
  ])('%s gives %s', (path, want) => {
    expect(inferFramework(path)).toBe(want);
  });
});

describe('containedInGenerated', () => {
  let base: string;
  let root: string;

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'judomaster-contain-'));
    root = join(base, 'repo');
    const regression = join(root, 'tests', 'generated', 'regression');
    mkdirSync(regression, { recursive: true });
    mkdirSync(join(root, 'src'));
    writeFileSync(join(regression, 'total-typeerror.test.ts'), 'x');
    writeFileSync(join(root, 'src', 'x.test.ts'), 'x');
    writeFileSync(join(root, 'src', 'evil.test.ts'), 'x');
    writeFileSync(join(base, 'outside.test.ts'), 'x');
    symlinkSync(
      join(root, 'src', 'evil.test.ts'),
      join(regression, 'link.test.ts'),
    );
  });

  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it('returns the realpath of a file under tests/generated', () => {
    const rel = 'tests/generated/regression/total-typeerror.test.ts';
    expect(containedInGenerated(root, rel)).toBe(realpathSync(join(root, rel)));
  });

  it.each([
    'src/x.test.ts',
    '../outside.test.ts',
    'tests/generated/regression/missing.test.ts',
    'tests/generated/regression/link.test.ts',
  ])('refuses %s', (rel) => {
    expect(containedInGenerated(root, rel)).toBeNull();
  });

  it('refuses an absolute path outside tests/generated', () => {
    expect(
      containedInGenerated(root, join(root, 'src', 'x.test.ts')),
    ).toBeNull();
  });
});
