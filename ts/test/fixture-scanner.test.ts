import { afterEach, describe, expect, it } from 'vitest';

import { FixtureScanner, isEmpty } from '../src/core/fixture-scanner.js';
import { makeProject, type TempProject } from './scanner-testkit.js';

let project: TempProject | null = null;
afterEach(() => {
  project?.cleanup();
  project = null;
});

function scan(files: Record<string, string>) {
  project = makeProject(files);
  return new FixtureScanner().scan(project.root);
}

describe('FixtureScanner', () => {
  it('is empty for a non-existent root', () => {
    const s = new FixtureScanner().scan('/no/such/path/xyzzy');
    expect(isEmpty(s)).toBe(true);
  });

  it('is empty when there are no fixture dirs', () => {
    expect(isEmpty(scan({ 'src/app.ts': 'export const x = 1;' }))).toBe(true);
  });

  it('extracts TS declarations and named exports (with `as` rename)', () => {
    const s = scan({
      'tests/fixtures/helpers.ts': [
        'export const makeUser = () => ({});',
        'export function seed() {}',
        'export class Harness {}',
        'export interface Opts {}',
        'export type Id = string;',
        'const internal = 1;',
        'export { internal as publicName };',
      ].join('\n'),
    });
    expect(s.byModule['tests/fixtures/helpers.ts']).toEqual([
      'makeUser',
      'seed',
      'Harness',
      'Opts',
      'Id',
      'publicName',
    ]);
    expect(s.filesScanned).toBe(1);
  });

  it('extracts Python top-level defs/classes and dedupes', () => {
    const s = scan({
      'tests/fixtures/data.py': [
        'def build():',
        '    pass',
        'class Sample:',
        '    pass',
        'def build():',
        '    pass',
      ].join('\n'),
    });
    expect(s.byModule['tests/fixtures/data.py']).toEqual(['build', 'Sample']);
  });

  it('skips unsupported extensions and files with no exports', () => {
    const s = scan({
      'tests/fixtures/notes.md': 'export const nope = 1;',
      'tests/fixtures/empty.ts': 'const local = 1;\n',
    });
    expect(isEmpty(s)).toBe(true);
  });

  it('skips ignored directories nested in a fixture dir', () => {
    const s = scan({
      'tests/fixtures/node_modules/dep/index.ts': 'export const dep = 1;',
      'tests/fixtures/real.ts': 'export const real = 1;',
    });
    expect(Object.keys(s.byModule)).toEqual(['tests/fixtures/real.ts']);
  });

  it('caps symbols per file at 12', () => {
    const many = Array.from(
      { length: 15 },
      (_, i) => `export const s${i} = ${i};`,
    ).join('\n');
    const s = scan({ 'tests/fixtures/many.ts': many });
    expect(s.byModule['tests/fixtures/many.ts']).toHaveLength(12);
  });

  it('truncates very large files before extraction', () => {
    const big = 'export const head = 1;\n' + '// pad\n'.repeat(6000);
    const s = scan({ 'tests/fixtures/big.ts': big });
    expect(s.byModule['tests/fixtures/big.ts']).toEqual(['head']);
  });
});
