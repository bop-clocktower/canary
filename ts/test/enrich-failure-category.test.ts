/**
 * The engine's failure categoriser (#1125) is a rule-for-rule port of
 * canary-fail-fast's `failures.mjs`. This pins the two together: one
 * vocabulary engine-wide, never two drifting copies.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  FAILURE_CATEGORIES,
  categorizeFailure,
} from '../src/analysis/enrich/failure-category.js';

interface SkillFailures {
  FAILURE_CATEGORIES: string[];
  categorizeFailure(error: string | null | undefined): string;
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(
  REPO_ROOT,
  'agents/skills/claude-code/canary-fail-fast/scripts/failures.mjs',
);
const skill = (await import(pathToFileURL(SCRIPT).href)) as SkillFailures;

// Chosen so every category is produced, and so the precedence rules are
// exercised: schema outranks server, auth outranks timeout.
const SAMPLES = [
  'ZodError: invalid_type at path "user.id"',
  'expected string, received number',
  'schema check failed with 500 and ZodError',
  'Request failed with status 401',
  '403 Forbidden',
  'token expired',
  'timed out waiting for 401',
  'Timeout 30000ms exceeded',
  'connect ECONNREFUSED 127.0.0.1:5432',
  'getaddrinfo ENOTFOUND api.example',
  '500 Internal Server Error',
  '502 Bad Gateway',
  '404 Not Found',
  '422 Unprocessable Entity',
  'response 409 conflict',
  'expected 3, got 4',
  '',
];

describe('categorizeFailure (engine port of canary-fail-fast)', () => {
  it('declares the same vocabulary as the skill script', () => {
    expect([...FAILURE_CATEGORIES]).toEqual(skill.FAILURE_CATEGORIES);
  });

  it('agrees with the skill script on every sample', () => {
    for (const s of SAMPLES) {
      expect([s, categorizeFailure(s)]).toEqual([
        s,
        skill.categorizeFailure(s),
      ]);
    }
  });

  it('produces all seven categories over the samples (parity is not vacuous)', () => {
    const seen = new Set(SAMPLES.map((s) => categorizeFailure(s)));
    expect([...seen].sort()).toEqual([...FAILURE_CATEGORIES].sort());
  });

  it('falls back to other for missing text', () => {
    expect(categorizeFailure(undefined)).toBe('other');
    expect(categorizeFailure(null)).toBe('other');
  });
});
