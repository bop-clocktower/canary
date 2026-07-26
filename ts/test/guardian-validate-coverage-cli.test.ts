/**
 * Faithful TypeScript port of `tests/unit/test_guardian_validate_coverage_cli.py`.
 *
 * Exit-code contract (so a producer can gate its CI on it):
 *   0 -- valid (or valid with warnings, unless --strict)
 *   1 -- contract errors (or warnings under --strict)
 *   2 -- the file is missing or not JSON
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { invokeGuardian, mkTmp, rmTmp } from './guardian-cli-testkit.js';

let tmp: string;
beforeEach(() => {
  tmp = mkTmp();
});
afterEach(() => {
  rmTmp(tmp);
});

function write(obj: unknown): string {
  const p = join(tmp, 'coverage.json');
  writeFileSync(p, JSON.stringify(obj), 'utf-8');
  return p;
}

it('valid file exits zero', async () => {
  const path = write({ files: { 'a.py': { line_hits: { '1': 2 } } } });
  const res = await invokeGuardian(['validate-coverage', path]);
  expect(res.code).toBe(0);
});

it('error file exits one', async () => {
  const path = write({ files: ['a.py'] }); // files must be an object
  const res = await invokeGuardian(['validate-coverage', path]);
  expect(res.code).toBe(1);
});

it('warning only exits zero but reports', async () => {
  const path = write({ files: { 'a.py': { covered_lines: [1, 'x'] } } });
  const res = await invokeGuardian(['validate-coverage', path]);
  expect(res.code).toBe(0);
  expect(res.stdout.toLowerCase()).toContain('warning');
});

it('warning under strict exits one', async () => {
  const path = write({ files: { 'a.py': { covered_lines: [1, 'x'] } } });
  const res = await invokeGuardian(['validate-coverage', path, '--strict']);
  expect(res.code).toBe(1);
});

it('missing file exits two', async () => {
  const res = await invokeGuardian([
    'validate-coverage',
    join(tmp, 'nope.json'),
  ]);
  expect(res.code).toBe(2);
});

it('non json exits two', async () => {
  const p = join(tmp, 'coverage.json');
  writeFileSync(p, 'not json {', 'utf-8');
  const res = await invokeGuardian(['validate-coverage', p]);
  expect(res.code).toBe(2);
});

it('json output is machine readable', async () => {
  const path = write({ files: { 'a.py': { covered_lines: [1, 'x'] } } });
  const res = await invokeGuardian(['validate-coverage', path, '--json']);
  expect(res.code).toBe(0);
  const payload = JSON.parse(res.stdout);
  expect(payload.valid).toBe(true); // warnings don't invalidate
  expect(
    payload.problems.some(
      (p: { severity: string }) => p.severity === 'warning',
    ),
  ).toBe(true);
});

it('markup-looking path key does not corrupt json', async () => {
  const path = write({ files: { '[red]evil[/red]': { covered_lines: [1] } } });
  const res = await invokeGuardian(['validate-coverage', path, '--json']);
  const payload = JSON.parse(res.stdout); // must parse -- no markup stripping
  expect(payload.valid).toBe(true);
});

it('unbalanced markup in human path is safe', async () => {
  const path = write({ files: { '[/]': {} } });
  const res = await invokeGuardian(['validate-coverage', path]);
  expect(res.code).toBe(0); // only a warning (empty entry)
});

it('deeply nested json exits two not crash', async () => {
  const p = join(tmp, 'coverage.json');
  writeFileSync(p, '['.repeat(100000), 'utf-8');
  const res = await invokeGuardian(['validate-coverage', p]);
  expect(res.code).toBe(2);
});

it('directory path exits two', async () => {
  const res = await invokeGuardian(['validate-coverage', tmp]);
  expect(res.code).toBe(2);
});

it('valid clean document prints the success line', async () => {
  // A fully-valid document with no warnings hits the "valid document" branch.
  const path = write({ files: { 'a.py': { line_hits: { '1': 2 } } } });
  const res = await invokeGuardian(['validate-coverage', path]);
  expect(res.code).toBe(0);
  expect(res.stdout).toContain('valid coverage-json document');
});
