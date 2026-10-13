/**
 * Type-only detection (#562) must judge every top-level statement, not just
 * the one a line starts with.
 *
 * `isErasableTopLevelLine` accepts a line by its prefix, so a runtime
 * statement sharing a line with an erasable one is never seen and the module
 * is wrongly proven type-only — suppressing a real coverage finding, the
 * direction the module's own docstring calls the costly one.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isTypeOnlyModule } from '../src/guardian/coverage.js';

let root: string;

function write(rel: string, body: string): string {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body, 'utf-8');
  return rel;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'canary-type-only-line-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('isTypeOnlyModule: runtime code after an erasable statement', () => {
  it('a call after a type alias on the same line is runtime', () => {
    const path = write(
      'src/types.ts',
      "export type Name = string; register('widget');\n",
    );
    expect(isTypeOnlyModule(path, root)).toBe(false);
  });

  it('a call after an interface closing brace on the same line is runtime', () => {
    const path = write(
      'src/shapes.types.ts',
      [
        'export interface Shape {',
        '  sides: number;',
        "} register('shape');",
        '',
      ].join('\n'),
    );
    expect(isTypeOnlyModule(path, root)).toBe(false);
  });

  it('a type alias continued after its closing brace stays type-only', () => {
    const path = write(
      'src/merged.types.ts',
      ['export type Merged = {', '  id: string;', '} & Base;', ''].join('\n'),
    );
    expect(isTypeOnlyModule(path, root)).toBe(true);
  });

  it('a semicolon inside a string literal does not split the statement', () => {
    const path = write('src/types.ts', "export type Separator = ';' | ',';\n");
    expect(isTypeOnlyModule(path, root)).toBe(true);
  });
});
