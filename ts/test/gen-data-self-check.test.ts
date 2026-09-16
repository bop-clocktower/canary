import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { selfCheck } from '../src/core/gen-data/self-check.js';

describe('selfCheck', () => {
  it('runs both real detectors and reports 0 findings on clean text', async () => {
    const r = await selfCheck(
      'export function buildX() {\n  return { a: 1 };\n}\n',
      'x.fixtures.ts',
    );
    expect(r).toEqual({
      status: 'ran',
      detectors: ['canary-blackhawk', 'canary-savant'],
      findings: [],
    });
  });
  it('catches a planted clock read (proves the detector is live, not a zero)', async () => {
    const r = await selfCheck(
      'export const at = Date.now();\n',
      'x.fixtures.ts',
    );
    expect(r.status).toBe('ran');
    expect(r.status === 'ran' && r.findings.map((f) => f.ruleId)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^BH001/)]),
    );
  });
  it('reports unavailable, never a pass, when the skills dir is missing', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'no-skills-'));
    try {
      const r = await selfCheck(
        'export const a = 1;\n',
        'x.fixtures.ts',
        empty,
      );
      expect(r.status).toBe('unavailable');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
  it.each([
    ['throws on import', "throw new Error('boom at import');\n"],
    [
      'throws while scanning',
      "export function scanText() { throw new Error('boom in scan'); }\n",
    ],
  ])('reports unavailable when a scanner %s', async (_label, source) => {
    const dir = mkdtempSync(join(tmpdir(), 'bad-skills-'));
    try {
      for (const skill of ['canary-blackhawk', 'canary-savant']) {
        const scripts = join(dir, 'claude-code', skill, 'scripts');
        mkdirSync(scripts, { recursive: true });
        writeFileSync(join(scripts, 'scanner.mjs'), source);
      }
      const r = await selfCheck('export const a = 1;\n', 'x.fixtures.ts', dir);
      expect(r.status).toBe('unavailable');
      expect(r.status === 'unavailable' && r.reason).toMatch(/boom/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
