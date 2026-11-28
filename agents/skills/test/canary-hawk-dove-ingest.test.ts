// canary-hawk-dove ingest (#618): a gate's JSON becomes a run plus findings
// with stable, line-free ids (the scan-baseline identity, #1322).

import { describe, expect, it } from 'vitest';

import {
  MAX_FINDINGS,
  findingId,
  parseRun,
} from '../claude-code/canary-hawk-dove/scripts/ingest.mjs';

const ROOT = '/repo';

function guardian(findings: unknown[], extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    findings,
    tier: 0,
    checked: findings.length,
    abstained: false,
    coverage: { status: 'verified', unitsTotal: 1, unitsMatched: 1 },
    provenance: { base: 'a'.repeat(40), head: 'b'.repeat(40) },
    ...extra,
  });
}

const F = {
  path: 'src/cart.ts',
  unit: 'total',
  kind: 'untested',
  fidelity: 'coverage-verified',
  suppressed: false,
  suppression_reason: null,
};

describe('findingId', () => {
  it('is line-free: a re-indented anchor keeps its id', () => {
    const a = findingId('savant', {
      file: 'a.ts',
      rule: 'SV1',
      anchor: 'x  = 1',
    });
    const b = findingId('savant', {
      file: 'a.ts',
      rule: 'SV1',
      anchor: ' x = 1 ',
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^hd1-[0-9a-f]{16}$/);
  });

  it('separates gates and fields (no concatenation collision)', () => {
    const id = { file: 'a', rule: 'b', anchor: 'c' };
    expect(findingId('guardian', id)).not.toBe(findingId('savant', id));
    expect(findingId('g', { file: 'ab', rule: '', anchor: 'c' })).not.toBe(
      findingId('g', { file: 'a', rule: 'b', anchor: 'c' }),
    );
  });
});

describe('parseRun -- guardian', () => {
  it('keeps path/kind/unit as identity and fidelity and suppression', () => {
    const res = parseRun(
      guardian([
        F,
        {
          ...F,
          unit: 'tax',
          suppressed: true,
          suppression_reason: 'fp: barrel',
        },
      ]),
      { gate: 'guardian', name: 'run.json', root: ROOT },
    );
    expect(res.error).toBeUndefined();
    expect(res.findings).toHaveLength(2);
    expect(res.findings[0]).toMatchObject({
      gate: 'guardian',
      file: 'src/cart.ts',
      rule: 'untested',
      anchor: 'total',
      fidelity: 'coverage-verified',
      suppressed: false,
    });
    expect(res.findings[1]).toMatchObject({
      suppressed: true,
      reason: 'fp: barrel',
    });
    expect(res.run).toMatchObject({
      gate: 'guardian',
      vouches: true,
      base: 'a'.repeat(40),
      head: 'b'.repeat(40),
    });
  });

  it('a run with a degraded notice, partial coverage or an abstention does not vouch', () => {
    const opts = { gate: 'guardian', name: 'r.json', root: ROOT };
    expect(
      parseRun(guardian([F], { degraded_notice: 'x' }), opts).run.vouches,
    ).toBe(false);
    expect(
      parseRun(guardian([F], { coverage: { status: 'partial' } }), opts).run
        .vouches,
    ).toBe(false);
    expect(parseRun(guardian([F], { abstained: true }), opts).run.vouches).toBe(
      false,
    );
    expect(
      parseRun(guardian([F], { coverage: undefined }), opts).run.vouches,
    ).toBe(false);
  });

  it('collapses a repeated identity to one finding', () => {
    const res = parseRun(guardian([F, { ...F }]), {
      gate: 'guardian',
      name: 'r.json',
      root: ROOT,
    });
    expect(res.findings).toHaveLength(1);
  });

  it('counts malformed entries as not read instead of guessing', () => {
    const res = parseRun(guardian([F, 7, { unit: 'x' }, null]), {
      gate: 'guardian',
      name: 'r.json',
      root: ROOT,
    });
    expect(res.findings).toHaveLength(1);
    expect(res.notRead).toBe(3);
  });
});

describe('parseRun -- scan-baseline shape', () => {
  it('reads {file, rule, anchor} for any other gate', () => {
    const res = parseRun(
      JSON.stringify({
        findings: [{ file: 'a.test.ts', rule: 'SV004', anchor: 'let x' }],
      }),
      { gate: 'savant', name: 's.json', root: ROOT },
    );
    expect(res.findings[0]).toMatchObject({
      gate: 'savant',
      file: 'a.test.ts',
      rule: 'SV004',
      anchor: 'let x',
      fidelity: null,
      suppressed: false,
    });
    expect(res.run.vouches).toBe(false);
  });
});

describe('parseRun -- refusals', () => {
  it('a parse error names the input and position, never the file bytes', () => {
    const secret = '{"findings": [ SECRET-TOKEN-abc123 ]}';
    const res = parseRun(secret, {
      gate: 'guardian',
      name: 'r.json',
      root: ROOT,
    });
    expect(res.error).toMatch(/^invalid JSON in r\.json/);
    expect(res.error).not.toContain('SECRET');
    expect(res.error).not.toContain('abc123');
  });

  it('a parse error reports the byte position when the parser gives one', () => {
    const res = parseRun('{"a": 1,,}', {
      gate: 'g',
      name: 'r.json',
      root: ROOT,
    });
    expect(res.error).toMatch(/at position \d+$/);
  });

  it('rejects a document with no findings array', () => {
    const res = parseRun('{"tier": 0}', {
      gate: 'guardian',
      name: 'r.json',
      root: ROOT,
    });
    expect(res.error).toBe('r.json has no findings array');
    expect(
      parseRun('[1]', { gate: 'g', name: 'r.json', root: ROOT }).error,
    ).toBe('r.json has no findings array');
  });

  it('reads at most MAX_FINDINGS and counts the rest as not read', () => {
    const many = Array.from({ length: MAX_FINDINGS + 3 }, (_, i) => ({
      file: `f${i}.ts`,
      rule: 'r',
      anchor: 'a',
    }));
    const res = parseRun(JSON.stringify({ findings: many }), {
      gate: 'g',
      name: 'r.json',
      root: ROOT,
    });
    expect(res.findings).toHaveLength(MAX_FINDINGS);
    expect(res.notRead).toBe(3);
  });
});
