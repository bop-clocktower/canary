/**
 * The cross-field rules the supported keyword subset cannot express
 * (#1151, ADR 0035). End-to-end criterion tests are in
 * contracts-validate.test.ts; these pin each rule's path and guards.
 */
import { describe, it, expect } from 'vitest';

import { crossFieldErrors } from '../lib/contracts/rules.mjs';

type Doc = Record<string, any>;
const totals = (over: Doc = {}) => ({
  passed: 1,
  failed: 0,
  flaky: 0,
  skipped: 0,
  timed_out: 0,
  interrupted: 0,
  total: 1,
  ...over,
});
const assessment = (over: Doc = {}): Doc => ({
  status: 'healthy',
  value: 1,
  reason: null,
  verified_by: null,
  verified_at: null,
  ...over,
});
const paths = (errs: { path: string }[]) => errs.map((e) => e.path);

describe('run rules', () => {
  it('totals.total must equal results.length when results is an array', () => {
    const run = { totals: totals(), results: [] };
    expect(crossFieldErrors('run', run)).toEqual([
      { path: 'totals.total', message: 'is 1 but results has 0 entries' },
    ]);
  });

  it('skips the length rule when results is null (fork A: not carried)', () => {
    expect(
      crossFieldErrors('run', { totals: totals(), results: null }),
    ).toEqual([]);
  });

  it('per-status counts must sum to totals.total (fork K)', () => {
    const run = { totals: totals({ failed: 1 }), results: null };
    expect(crossFieldErrors('run', run)).toEqual([
      {
        path: 'totals.total',
        message: 'is 1 but the per-status counts sum to 2',
      },
    ]);
  });

  it('refuses a count above 2^53 - 1 instead of summing it lossily (S1)', () => {
    // 2^53 + 1 is not representable, so this sum "matched" before the rule.
    const big = 2 ** 53;
    const run = {
      totals: totals({ passed: big, failed: 1, total: big + 1 }),
      results: [{ duration_ms: 2 ** 60, retries: 0 }],
    };
    expect(crossFieldErrors('run', run)).toEqual([
      {
        path: 'totals.passed',
        message: `must be a safe integer (at most ${Number.MAX_SAFE_INTEGER})`,
      },
      {
        path: 'totals.total',
        message: `must be a safe integer (at most ${Number.MAX_SAFE_INTEGER})`,
      },
      {
        path: 'results[0].duration_ms',
        message: `must be a safe integer (at most ${Number.MAX_SAFE_INTEGER})`,
      },
    ]);
  });

  it('prefixes an unsafe count nested in a site feed (S1)', () => {
    const site = { runs: [{ totals: totals({ skipped: 2 ** 53 }) }] };
    expect(paths(crossFieldErrors('site', site))).toEqual([
      'runs[0].totals.skipped',
    ]);
  });

  it('accepts Number.MAX_SAFE_INTEGER, the largest safe count (control)', () => {
    const max = Number.MAX_SAFE_INTEGER;
    const run = {
      totals: totals({ passed: max - 1, failed: 1, total: max }),
      results: null,
    };
    expect(crossFieldErrors('run', run)).toEqual([]);
  });

  it('leaves a non-object totals to the schema', () => {
    expect(crossFieldErrors('run', { totals: 'x', results: [] })).toEqual([]);
  });
});

describe('assessment rules', () => {
  it.each([true, false, null])(
    'refuses a supplied verified (%s): key presence',
    (v) => {
      expect(
        paths(crossFieldErrors('assessment', assessment({ verified: v }))),
      ).toEqual(['verified']);
    },
  );

  it('names the missing half of the verification pair', () => {
    expect(
      paths(
        crossFieldErrors('assessment', assessment({ verified_by: 'qa-lead' })),
      ),
    ).toEqual(['verified_at']);
    expect(
      paths(
        crossFieldErrors(
          'assessment',
          assessment({ verified_at: '2026-10-05T00:00:00Z' }),
        ),
      ),
    ).toEqual(['verified_by']);
  });

  it('not-assessed: no value, and a non-blank reason', () => {
    expect(
      paths(
        crossFieldErrors(
          'assessment',
          assessment({ status: 'not-assessed', value: 0, reason: '  ' }),
        ),
      ),
    ).toEqual(['value', 'reason']);
  });

  it.each(['healthy', 'degraded', 'critical', 'observed'])(
    '%s: a value, and no reason',
    (status) => {
      expect(
        paths(
          crossFieldErrors(
            'assessment',
            assessment({ status, value: null, reason: 'x' }),
          ),
        ),
      ).toEqual(['value', 'reason']);
    },
  );

  it('leaves an unknown status to the schema enum', () => {
    expect(
      crossFieldErrors(
        'assessment',
        assessment({ status: 'green', value: null }),
      ),
    ).toEqual([]);
  });
});

describe('site rules', () => {
  it('prefixes nested paths with runs[i] and assessments[i]', () => {
    const site = {
      runs: [
        { totals: totals(), results: null },
        { totals: totals(), results: [] },
      ],
      assessments: [assessment({ verified: true })],
    };
    expect(paths(crossFieldErrors('site', site))).toEqual([
      'runs[1].totals.total',
      'assessments[0].verified',
    ]);
  });

  it('tolerates non-array runs/assessments and non-object members (the schema reports them)', () => {
    expect(
      crossFieldErrors('site', { runs: 'x', assessments: [null] }),
    ).toEqual([]);
  });

  it.each(['who', 'author'])(
    'refuses a register row carrying %s: author identity is excluded from a public feed',
    (key) => {
      const site = { register: [{ title: 't' }, { title: 't', [key]: null }] };
      expect(crossFieldErrors('site', site)).toEqual([
        {
          path: `register[1].${key}`,
          message: expect.stringMatching(/author identity/),
        },
      ]);
    },
  );

  it('accepts a register row without who/author (control)', () => {
    expect(
      crossFieldErrors('site', { register: [{ title: 't', commit: 'abc' }] }),
    ).toEqual([]);
  });
});

describe('real-dates (#1151 phase 3 review)', () => {
  const BAD = '2026-13-01T00:00:00Z';
  const run = (finished_at: string) => ({
    run: { started_at: '2026-10-06T00:00:00Z', finished_at },
    totals: totals(),
    results: null,
  });

  it('refuses a pattern-valid timestamp that names no instant', () => {
    expect(paths(crossFieldErrors('run', run(BAD)))).toEqual([
      'run.finished_at',
    ]);
    expect(crossFieldErrors('run', run(BAD))[0].message).toContain(
      'is not a real date',
    );
  });

  it('accepts a real date, offsets included (control)', () => {
    expect(crossFieldErrors('run', run('2026-10-06T10:00:00+05:30'))).toEqual(
      [],
    );
  });

  it('checks every timestamp a site feed carries, with its path', () => {
    const errs = crossFieldErrors('site', {
      generated_at: BAD,
      runs: [run(BAD)],
      assessments: [assessment({ observed_at: BAD })],
      register: [{ recorded_at: BAD }],
    });
    expect(paths(errs)).toEqual([
      'generated_at',
      'runs[0].run.finished_at',
      'assessments[0].observed_at',
      'register[0].recorded_at',
    ]);
  });

  it.each([
    '2026-02-30T00:00:00Z',
    '2025-02-29T00:00:00Z',
    '1900-02-29T00:00:00Z',
    '2026-04-31T00:00:00Z',
    '2026-00-10T00:00:00Z',
    '2026-10-00T00:00:00Z',
    '2026-10-06T24:00:00Z',
    '2026-10-06T23:60:00Z',
    '2026-10-06T23:59:60Z',
    '2026-10-06T10:00:00+24:00',
    '2026-10-06T10:00:00+05:60',
  ])('refuses %s: no such calendar date or clock (#1154 S2)', (ts) => {
    expect(crossFieldErrors('run', run(ts))).toEqual([
      {
        path: 'run.finished_at',
        message: `${JSON.stringify(ts)} matches the timestamp pattern but is not a real date`,
      },
    ]);
  });

  it.each([
    '2024-02-29T00:00:00Z',
    '2000-02-29T00:00:00Z',
    '0000-02-29T00:00:00Z',
    '2026-12-31T23:59:59.999-23:59',
  ])('accepts %s: a real instant, leap days included (control)', (ts) => {
    expect(crossFieldErrors('run', run(ts))).toEqual([]);
  });

  it('leaves a string the pattern refuses to the schema: one error, not two', () => {
    expect(crossFieldErrors('run', run('yesterday'))).toEqual([]);
  });

  it('leaves a non-string timestamp to the schema', () => {
    const errs = crossFieldErrors('assessment', assessment({ observed_at: 5 }));
    expect(
      errs.filter((e: { message: string }) => e.message.includes('real date')),
    ).toEqual([]);
  });
});
