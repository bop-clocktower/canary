/**
 * canary-judomaster run classifier (#614): a verdict comes from a real run,
 * and a pass is never reported as success (D2-D5, D9).
 */

import { describe, expect, it } from 'vitest';

import {
  classifyRun,
  inferFramework,
} from '../src/analysis/judomaster/verify.js';

const SIG = {
  text: "Cannot read properties of undefined (reading 'qty')",
  kind: 'message' as const,
};
const COULD_NOT = 'unverified — could not reproduce';

describe('classifyRun', () => {
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
    [[124, 'partial', 'Execution timed out after 60 seconds.'], 'vitest'],
    [[127, '', 'npx: command not found'], 'vitest'],
    [[1, '', 'spawnSync npx ENOENT'], 'vitest'],
  ] as const)('could not run %j (%s)', (exec, framework) => {
    const r = classifyRun([...exec], SIG, framework);
    expect(r.verdict).toBe('unverified');
    expect(r.label).toBe(COULD_NOT);
    expect(r.vacuity).toBe(false);
  });

  it('checks could-not-run before the signature', () => {
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
