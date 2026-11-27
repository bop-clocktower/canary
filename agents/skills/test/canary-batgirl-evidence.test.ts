/**
 * canary-batgirl's dimension model and its three evidence dimensions (#619).
 *
 * Each dimension is either assessed, with a value, a direction and the numbers
 * behind it, or not assessed with a reason. A dimension with no backing data
 * has a null value, never 0 or 100% (spec D6). The ratios here are the ones
 * whose denominator a developer cannot pad with green tests (spec D4).
 */

import { describe, expect, it } from 'vitest';

import {
  DIMENSIONS,
  evaluate,
} from '../claude-code/canary-batgirl/scripts/dimension.mjs';
import {
  closureExercise,
  coverageShare,
  escapedDefects,
} from '../claude-code/canary-batgirl/scripts/evidence.mjs';
import { LIMITS } from '../claude-code/canary-batgirl/scripts/read.mjs';

const OPTS = { limits: LIMITS, branch: 'main' };

const ok = (value: unknown) => ({ kind: 'ok', value });
const files = (...docs: unknown[]) =>
  docs.map((d, i) => ({ name: `r-${i}.json`, read: ok(d) }));

describe('dimension model', () => {
  it('lists six dimensions, each with a direction and a kind', () => {
    expect(DIMENSIONS.map((d: { id: string }) => d.id)).toEqual([
      'escaped-defects',
      'coverage-verified-share',
      'closure-exercise',
      'unexplained-switch-offs',
      'vacuous-tests',
      'red-mainline-commits',
    ]);
    for (const d of DIMENSIONS) {
      expect(['lower', 'higher']).toContain(d.better);
      expect(['ratio', 'count']).toContain(d.kind);
    }
  });

  it('turns a read that is not ok into not assessed with a null value', () => {
    const dim = evaluate(
      'escaped-defects',
      { source: '.canary/escapes.json', read: { kind: 'missing' } },
      escapedDefects,
      OPTS,
    );
    expect(dim.status).toBe('not-assessed');
    expect(dim.value).toBeNull();
    expect(dim.reason).toBe('nothing at .canary/escapes.json');
  });

  it('keeps a read reason when there is one', () => {
    const dim = evaluate(
      'vacuous-tests',
      { source: null, read: { kind: 'absent', reason: 'no report named' } },
      () => ({ value: 1, basis: 'x' }),
      OPTS,
    );
    expect(dim.reason).toBe('no report named');
  });

  it('builds an assessed dimension from an evaluator result', () => {
    const dim = evaluate(
      'escaped-defects',
      { source: 'e.json', read: ok({}) },
      () => ({ value: 0.25, basis: 'b', detail: { escaped: 1 } }),
      OPTS,
    );
    expect(dim).toMatchObject({
      id: 'escaped-defects',
      status: 'assessed',
      value: 0.25,
      better: 'lower',
      kind: 'ratio',
      reason: null,
      detail: { escaped: 1 },
    });
  });

  it('rejects an unknown dimension id', () => {
    expect(() =>
      evaluate('nope', { source: null, read: ok({}) }, () => ({}), OPTS),
    ).toThrow(/unknown dimension/);
  });
});

describe('escaped-defects', () => {
  const log = (escapes: unknown, caught: unknown, since = '2026-07-01') => ({
    schema_version: 1,
    tracked_since: since,
    escapes,
    caught,
  });
  const entry = (id: string) => ({ id, summary: 's', found_at: '2026-08-01' });

  it('is escapes over escapes plus caught', () => {
    const r = escapedDefects(
      log([entry('E1')], [entry('C1'), entry('C2'), entry('C3')]),
      OPTS,
    );
    expect(r.value).toBe(0.25);
    expect(r.basis).toBe('1 of 4 defects recorded since 2026-07-01 escaped');
    expect(r.detail).toEqual({ escaped: 1, caught: 3 });
  });

  it('is not assessed without tracked_since', () => {
    expect(escapedDefects(log([], [], 'soon'), OPTS).reason).toMatch(
      /tracked_since/,
    );
  });

  it('is not assessed without a caught list: the ratio has no denominator', () => {
    expect(escapedDefects(log([entry('E1')], undefined), OPTS).reason).toMatch(
      /caught array/,
    );
  });

  it('is not assessed when nothing was recorded either side', () => {
    expect(escapedDefects(log([], []), OPTS).reason).toBe(
      '0 defects recorded since 2026-07-01, escaped or caught',
    );
  });

  it('is not assessed for a non-object log', () => {
    expect(escapedDefects([], OPTS).reason).toMatch(/not an object/);
  });

  it('does not read a log over the entry limit', () => {
    const opts = { ...OPTS, limits: { ...LIMITS, entries: 2 } };
    const r = escapedDefects(
      log([entry('E1'), entry('E2')], [entry('C1')]),
      opts,
    );
    expect(r.reason).toBe('not read: 3 entries is over the 2-entry limit');
  });
});

describe('coverage-verified-share', () => {
  const record = (over: Record<string, unknown> = {}) => ({
    schemaVersion: '1.2',
    source: 'canary-pr-guardian',
    abstained: false,
    checked: 4,
    coverage: { status: 'partial', unitsMatched: 3, unitsTotal: 4 },
    ...over,
  });

  it('is matched units over changed units across counted records', () => {
    const r = coverageShare(
      files(record(), record({ coverage: { unitsMatched: 4, unitsTotal: 4 } })),
      OPTS,
    );
    expect(r.value).toBe(7 / 8);
    expect(r.basis).toBe(
      '7 of 8 changed units across 2 guardian records were judged with a coverage report',
    );
  });

  it('does not count records that judged nothing, lack coverage, or are not guardian records', () => {
    const r = coverageShare(
      files(
        record(),
        record({ abstained: true }),
        record({ checked: 0 }),
        record({ coverage: null }),
        record({ coverage: { unitsMatched: 5, unitsTotal: 4 } }),
        { source: 'something-else' },
      ),
      OPTS,
    );
    expect(r.value).toBe(3 / 4);
    expect(r.detail).toMatchObject({
      records: 1,
      not_counted: {
        unreadable: 0,
        not_guardian: 1,
        judged_nothing: 2,
        no_coverage: 2,
      },
    });
  });

  it('counts an unreadable record file as not counted', () => {
    const r = coverageShare(
      [
        ...files(record()),
        { name: 'bad.json', read: { kind: 'invalid', reason: 'x' } },
      ],
      OPTS,
    );
    expect(r.detail.not_counted.unreadable).toBe(1);
  });

  it('is not assessed when no record counts', () => {
    const r = coverageShare(files(record({ abstained: true })), OPTS);
    expect(r.reason).toMatch(/^1 guardian record read, none counted/);
  });

  it('is not assessed for an empty directory', () => {
    expect(coverageShare([], OPTS).reason).toBe(
      'no canary-pr-guardian-*.json records',
    );
  });
});

describe('closure-exercise', () => {
  const report = (issue: unknown, statuses: string[]) => ({
    issue,
    files: statuses.map((status, i) => ({ file: `f${i}`, status })),
  });

  it('is exercised over claiming verdicts, with the other three shown beside', () => {
    const r = closureExercise(
      files(
        report(1, ['exercised', 'not-exercised', 'abstain']),
        report(2, ['exercised', 'no-probe', 'not-applicable']),
      ),
      OPTS,
    );
    expect(r.value).toBe(2 / 3);
    expect(r.detail).toEqual({
      closures: 2,
      exercised: 2,
      'not-exercised': 1,
      abstain: 1,
      'no-probe': 1,
      'not-applicable': 1,
      unrecognised: 0,
      duplicates: 0,
      malformed: 0,
    });
    expect(r.basis).toBe(
      '2 of 3 changed files with a claim had run since their fix merged, across 2 closures; 1 abstain, 1 no-probe, 1 not-applicable',
    );
  });

  it('counts a duplicate report for an issue once, so re-running cannot pad it', () => {
    const once = closureExercise(
      files(report(1, ['not-exercised']), report(2, ['exercised'])),
      OPTS,
    );
    const padded = closureExercise(
      files(
        report(1, ['not-exercised']),
        report(2, ['exercised']),
        report(2, ['exercised']),
        report(2, ['exercised']),
      ),
      OPTS,
    );
    expect(padded.value).toBe(once.value);
    expect(padded.detail.duplicates).toBe(2);
  });

  it('is not assessed when no file made a claim', () => {
    const r = closureExercise(files(report(3, ['abstain', 'no-probe'])), OPTS);
    expect(r.reason).toBe(
      'no changed file made a claim across 1 closure: 1 abstain, 1 no-probe, 0 not-applicable',
    );
  });

  it('counts malformed reports, unreadable files and unknown statuses', () => {
    const r = closureExercise(
      [
        ...files(report('x', []), report(4, ['exercised', 'bogus']), 7),
        { name: 'bad.json', read: { kind: 'invalid', reason: 'x' } },
      ],
      OPTS,
    );
    expect(r.detail).toMatchObject({ malformed: 3, unrecognised: 1 });
  });

  it('does not read reports whose files together exceed the entry limit', () => {
    const opts = { ...OPTS, limits: { ...LIMITS, entries: 2 } };
    const r = closureExercise(
      files(report(1, ['exercised', 'exercised']), report(2, ['exercised'])),
      opts,
    );
    expect(r.reason).toBe('not read: 3 entries is over the 2-entry limit');
  });

  it('is not assessed when there are no reports', () => {
    expect(closureExercise([], OPTS).reason).toBe('no batwoman reports');
  });
});
