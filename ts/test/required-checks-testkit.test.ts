/**
 * The manifest reader refuses a zero denominator, keeps `required` and
 * `advisory` apart, and is the only reader (#1144).
 *
 * Every doc and workflow test that asks "what blocks a merge?" reads
 * `.github/required-checks.json` through `required-checks-testkit.ts`. Two ways
 * that one reader can lie, each pinned here with a planted manifest:
 *
 * - a renamed or missing `required` key read as `[]`, so every caller compares
 *   against an empty set and passes vacuously;
 * - a flatten-every-array reader that counts the `advisory` rows as required,
 *   which is what `contributing-fork-note.test.ts` did before #1144.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REPO_ROOT,
  advisoryEntries,
  readRequiredChecksManifest,
  requiredCheckNames,
  requiredEntries,
} from './required-checks-testkit.js';

const PLANTED = {
  required: [{ check: 'only-required', workflow: 'a.yml' }],
  advisory: [{ check: 'only-advisory', workflow: 'b.yml', reason: 'planted' }],
};

describe('required-checks testkit refuses a zero denominator', () => {
  it.each([
    ['missing', {}],
    ['not an array', { required: { check: 'x' } }],
    ['empty', { required: [] }],
  ])('throws when `required` is %s', (_label, manifest) => {
    expect(() => requiredEntries(manifest)).toThrow(/`required` section/);
    expect(() => requiredCheckNames(manifest)).toThrow(/`required` section/);
  });

  it.each([
    ['missing', { required: PLANTED.required }],
    ['not an array', { ...PLANTED, advisory: 'nope' }],
  ])('throws when `advisory` is %s', (_label, manifest) => {
    expect(() => advisoryEntries(manifest)).toThrow(/`advisory` section/);
  });
});

describe('required-checks testkit keeps required and advisory apart', () => {
  it('a planted advisory-only check is not a required check name', () => {
    const names = requiredCheckNames(PLANTED);
    expect([...names]).toEqual(['only-required']);
    expect(names.has('only-advisory')).toBe(false);
  });

  it('on the live manifest, required names equal the `required` section exactly', () => {
    const manifest = readRequiredChecksManifest();
    const names = requiredCheckNames();
    expect(names.size).toBeGreaterThan(0);
    expect([...names].sort()).toEqual(
      requiredEntries(manifest)
        .map((e) => e.check)
        .sort(),
    );
    for (const a of advisoryEntries(manifest)) {
      expect(names.has(a.check), `${a.check} is advisory`).toBe(false);
    }
  });
});

describe('required-checks.json has exactly one reader', () => {
  it('no test other than the testkit names the manifest file as a path', () => {
    const testDir = join(REPO_ROOT, 'ts', 'test');
    // Opening the file needs its name as a quoted string literal (the second
    // argument to `join`); prose in comments uses backticks and is not a read.
    const quotedPath = /['"]required-checks\.json['"]/;
    const files = readdirSync(testDir, { recursive: true })
      .map(String)
      .filter((f) => /\.(ts|js|mjs)$/.test(f));
    // Zero denominator is an abstention: the scan must have looked at files.
    expect(files.length).toBeGreaterThan(0);
    const readers = files.filter((f) =>
      quotedPath.test(readFileSync(join(testDir, f), 'utf-8')),
    );
    expect(readers).toEqual(['required-checks-testkit.ts']);
  });
});
