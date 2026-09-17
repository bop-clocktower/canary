/**
 * Adoption signals (#491): passive measures derived from guardian analysis
 * records. Every fixture here is synthetic; nothing is copied from a real
 * consumer record.
 *
 * The rule under test above all others: a signal with nothing to count is an
 * ABSTENTION, never a zero that reads as healthy.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  computeSignals,
  type GuardianRecord,
} from '../src/adoption/signals.js';
import { loadRecords, scanWorkflows } from '../src/adoption/load.js';
import { resolveMergeState } from '../src/adoption/merge-state.js';

function rec(over: Partial<GuardianRecord> = {}): GuardianRecord {
  return {
    ref: 'pr-1',
    gate: 'soft',
    tier: 1,
    abstained: false,
    degradedNotice: null,
    analyzedAt: '2026-09-01T00:00:00+00:00',
    summary: { total: 2, unaddressed: 2, suppressed: 0 },
    ...over,
  };
}

describe('computeSignals', () => {
  it('abstains on every record-derived signal when there are no records', () => {
    const s = computeSignals([], new Map());
    for (const key of [
      'mergedWithUnaddressed',
      'suppression',
      'gate',
      'degradation',
      'findingsPerPr',
    ] as const) {
      expect(s[key].status).toBe('abstained');
      expect(s[key]).toMatchObject({ denominator: 0 });
    }
  });

  it('counts merged PRs carrying unaddressed findings, with unresolved kept apart', () => {
    const records = [
      rec({
        ref: 'pr-1',
        summary: { total: 3, unaddressed: 3, suppressed: 0 },
      }),
      rec({
        ref: 'pr-2',
        summary: { total: 1, unaddressed: 0, suppressed: 1 },
      }),
      rec({ ref: 'pr-3' }),
      rec({ ref: 'abc1234' }),
    ];
    const merge = new Map([
      ['pr-1', 'merged' as const],
      ['pr-2', 'merged' as const],
      ['pr-3', 'unresolved' as const],
      ['abc1234', 'unresolved' as const],
    ]);
    const s = computeSignals(records, merge);
    expect(s.mergedWithUnaddressed).toEqual({
      status: 'measured',
      denominator: 2,
      value: { merged: 2, withUnaddressed: 1, unresolved: 2 },
    });
  });

  it('abstains on merge signal when no record resolves as merged', () => {
    const s = computeSignals(
      [rec()],
      new Map([['pr-1', 'unresolved' as const]]),
    );
    expect(s.mergedWithUnaddressed.status).toBe('abstained');
  });

  it('measures suppression engagement over findings, not records', () => {
    const s = computeSignals(
      [
        rec({ summary: { total: 4, unaddressed: 3, suppressed: 1 } }),
        rec({
          ref: 'pr-2',
          summary: { total: 6, unaddressed: 6, suppressed: 0 },
        }),
      ],
      new Map(),
    );
    expect(s.suppression).toEqual({
      status: 'measured',
      denominator: 10,
      value: { findings: 10, suppressed: 1, recordsWithSuppression: 1 },
    });
  });

  it('abstains on suppression when records carry zero findings', () => {
    const s = computeSignals(
      [rec({ summary: { total: 0, unaddressed: 0, suppressed: 0 } })],
      new Map(),
    );
    expect(s.suppression.status).toBe('abstained');
  });

  it('reports the gate distribution and the latest gate by analyzedAt', () => {
    const s = computeSignals(
      [
        rec({ gate: 'hard', analyzedAt: '2026-09-03T00:00:00+00:00' }),
        rec({
          ref: 'pr-2',
          gate: 'soft',
          analyzedAt: '2026-09-01T00:00:00+00:00',
        }),
        rec({
          ref: 'pr-3',
          gate: 'soft',
          analyzedAt: '2026-09-02T00:00:00+00:00',
        }),
      ],
      new Map(),
    );
    expect(s.gate).toEqual({
      status: 'measured',
      denominator: 3,
      value: { byGate: { hard: 1, soft: 2 }, latest: 'hard' },
    });
  });

  it('counts degraded and abstained runs and the tier spread', () => {
    const s = computeSignals(
      [
        rec({ tier: 0, degradedNotice: 'dropped to tier 0' }),
        rec({ ref: 'pr-2', tier: 1, abstained: true }),
        rec({ ref: 'pr-3', tier: 1 }),
      ],
      new Map(),
    );
    expect(s.degradation).toEqual({
      status: 'measured',
      denominator: 3,
      value: { degraded: 1, abstained: 1, byTier: { '0': 1, '1': 2 } },
    });
  });

  it('summarises findings per PR including zero-finding runs', () => {
    const totals = [0, 1, 2, 3, 150];
    const s = computeSignals(
      totals.map((t, i) =>
        rec({
          ref: `pr-${i}`,
          summary: { total: t, unaddressed: t, suppressed: 0 },
        }),
      ),
      new Map(),
    );
    expect(s.findingsPerPr).toEqual({
      status: 'measured',
      denominator: 5,
      value: { min: 0, median: 2, p90: 150, max: 150, over100: 1 },
    });
  });
});

describe('loadRecords / scanWorkflows', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adoption-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns no records and no skips for a missing directory', () => {
    expect(loadRecords(join(dir, 'nope'))).toEqual({
      records: [],
      skipped: [],
    });
  });

  it('reads guardian records and names every file it skipped', () => {
    writeFileSync(
      join(dir, 'canary-pr-guardian-pr-7.json'),
      JSON.stringify({ source: 'canary-pr-guardian', ...rec({ ref: 'pr-7' }) }),
    );
    writeFileSync(
      join(dir, 'ISSUE-1.json'),
      JSON.stringify({ source: 'harness' }),
    );
    writeFileSync(join(dir, 'broken.json'), '{nope');
    writeFileSync(join(dir, 'notes.txt'), 'ignored: not json');
    const { records, skipped } = loadRecords(dir);
    expect(records.map((r) => r.ref)).toEqual(['pr-7']);
    expect(skipped).toEqual([
      { file: 'ISSUE-1.json', reason: 'not a canary-pr-guardian record' },
      { file: 'broken.json', reason: 'unparseable JSON' },
    ]);
  });

  it('skips a guardian record missing its summary rather than guessing', () => {
    writeFileSync(
      join(dir, 'canary-pr-guardian-pr-8.json'),
      JSON.stringify({ source: 'canary-pr-guardian', ref: 'pr-8' }),
    );
    expect(loadRecords(dir).skipped).toEqual([
      { file: 'canary-pr-guardian-pr-8.json', reason: 'malformed record' },
    ]);
  });

  it('finds a workflow that runs guardian pr-check', () => {
    const wf = join(dir, '.github', 'workflows');
    mkdirSync(wf, { recursive: true });
    writeFileSync(join(wf, 'ci.yml'), 'run: npm test\n');
    writeFileSync(
      join(wf, 'g.yaml'),
      'run: npx canary guardian pr-check --emit-analysis\n',
    );
    expect(scanWorkflows(dir)).toEqual({ present: true, files: ['g.yaml'] });
  });

  it('reports absent when no workflow runs the guardian', () => {
    expect(scanWorkflows(dir)).toEqual({ present: false, files: [] });
  });
});

describe('resolveMergeState', () => {
  const log = [
    'feat(x): thing (#12)',
    'Merge pull request #40 from someone/branch',
    'fix(y): other (#123)',
    'feat(z): cites an issue (#883) (#952)',
  ].join('\n');

  it('resolves squash and merge-commit subjects, exact number only', () => {
    const calls: string[][] = [];
    const run = (args: string[]) => {
      calls.push(args);
      return { status: 0, stdout: log, stderr: '' };
    };
    const m = resolveMergeState(
      ['pr-12', 'pr-40', 'pr-1', 'pr-23', 'pr-883', 'abc1234'],
      'main',
      run,
    );
    expect(Object.fromEntries(m)).toEqual({
      'pr-12': 'merged',
      'pr-40': 'merged',
      'pr-1': 'unresolved',
      'pr-23': 'unresolved',
      'pr-883': 'unresolved',
      abc1234: 'unresolved',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('main');
  });

  it('leaves everything unresolved when git fails', () => {
    const m = resolveMergeState(['pr-12'], 'main', () => ({
      status: 128,
      stdout: '',
      stderr: 'fatal',
    }));
    expect(m.get('pr-12')).toBe('unresolved');
  });
});

describe('no egress', () => {
  it('imports no network module anywhere under src/adoption', () => {
    const src = fileURLToPath(new URL('../src/adoption', import.meta.url));
    for (const f of readdirSync(src)) {
      const text = readFileSync(join(src, f), 'utf-8');
      expect(text, f).not.toMatch(
        /from ['"](node:)?(https?|net|dgram|tls)['"]/,
      );
      expect(text, f).not.toMatch(/\bfetch\(/);
    }
  });
});
