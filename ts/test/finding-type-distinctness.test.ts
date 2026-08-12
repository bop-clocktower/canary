import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import * as prCheck from '../src/guardian/pr-check.js';
import * as staticLinter from '../src/core/static-linter.js';
import type { LintFinding } from '../src/core/static-linter.js';

const here = dirname(fileURLToPath(import.meta.url));
const srcOf = (rel: string) =>
  readFileSync(resolve(here, '..', 'src', rel), 'utf8');

/**
 * Two unrelated exported types were both named `Finding` — a lint finding
 * (static-linter, an interface) and a guardian coverage/weak-test finding
 * (pr-check, a class). Importers of each sat side by side in the same tree,
 * so a signature reading `Finding[]` did not say which contract applied.
 *
 * These guards keep the two names distinct. They are source-text assertions
 * because the static-linter type is an interface and erases at runtime, so
 * there is nothing to introspect after compilation.
 */
describe('Finding type distinctness', () => {
  it('static-linter exports LintFinding, not a bare Finding', () => {
    const src = srcOf('core/static-linter.ts');
    expect(src).toContain('export interface LintFinding {');
    expect(src).not.toMatch(/^export interface Finding\b/m);
  });

  it('pr-check exports GuardianFinding, not a bare Finding', () => {
    const src = srcOf('guardian/pr-check.ts');
    expect(src).toContain('export class GuardianFinding {');
    expect(src).not.toMatch(/^export class Finding\b/m);
  });

  it('the guardian finding is constructible under its new name', () => {
    expect(typeof prCheck.GuardianFinding).toBe('function');
    expect('Finding' in prCheck).toBe(false);
  });

  it('the lint finding keeps its shape under its new name', () => {
    const finding: LintFinding = {
      file: 'a.spec.ts',
      line: 1,
      rule: 'no-sleep',
      severity: 'warning',
      message: 'msg',
      suggestion: 'fix',
    };
    // formatFinding still consumes the lint shape — only the name moved.
    expect(staticLinter.formatFinding(finding)).toContain('a.spec.ts:1');
  });
});
