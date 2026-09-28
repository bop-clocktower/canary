/**
 * The consumer table for `canary history gaps` (#610): which history consumers
 * read which record fields, and over which denominator.
 *
 * This is the ONE place to update when a consumer starts reading a new field or
 * a writer starts filling one. Every row is pinned to the source line it
 * mirrors in `ts/test/clocktower-consumers.test.ts`, so drift has a named test.
 *
 * Deliberately a data table rather than per-consumer instrumentation: the
 * consumers live in five modules and a skill script, and asking each to report
 * its own missing fields would touch all of them (and `ts/src/history`, which
 * has no arch headroom -- #1074) while still saying nothing about consumers
 * nobody ran.
 */
import type { RunRecord, TestResultRecord } from '../../history/record.js';

/** What a requirement's denominator counts. */
export type Scope = 'run' | 'test' | 'failed-test';

export interface Requirement {
  field: string;
  scope: Scope;
  /** Does this row carry the field in a form the consumer can use? */
  carried(run: RunRecord, test?: TestResultRecord): boolean;
}

export interface Consumer {
  id: string;
  /** The commands / skills that read these fields. */
  surface: string;
  requirements: Requirement[];
  /** The `history record` flag that feeds an opt-in consumer. */
  optIn?: string;
}

// Only these readers can emit the `flaky` status at all (#604); a store written
// by the Vitest reader alone is structurally dark for retry flakes (G6).
const RETRY_CAPABLE = new Set(['playwright', 'junit']);

const text = (v: unknown): boolean => typeof v === 'string' && v.length > 0;
const num = (v: unknown): boolean =>
  typeof v === 'number' && Number.isFinite(v);
const obj = (v: unknown): boolean => typeof v === 'object' && v !== null;
const retry = (v: unknown): boolean =>
  typeof v === 'string' && RETRY_CAPABLE.has(v);

function onRun(
  field: keyof RunRecord,
  ok: (v: unknown) => boolean,
): Requirement {
  return { field, scope: 'run', carried: (run) => ok(run[field]) };
}

function onTest(
  field: keyof TestResultRecord,
  ok: (v: unknown) => boolean,
  scope: 'test' | 'failed-test' = 'test',
): Requirement {
  return {
    field,
    scope,
    carried: (_run, test) => test !== undefined && ok(test[field]),
  };
}

export const CONSUMERS: readonly Consumer[] = [
  {
    id: 'screech',
    surface: 'canary-screech, history timeline',
    requirements: [
      onRun('branch', text),
      onRun('commit_sha', text),
      onRun('timestamp', text),
    ],
  },
  {
    id: 'ci-ready-runtime',
    surface: 'canary ci-ready suite runtime',
    requirements: [onRun('duration_ms', num)],
  },
  {
    id: 'flaky-retry',
    surface: 'history flaky, analyze flaky',
    requirements: [onRun('reporter_format', retry)],
  },
  {
    id: 'area-health',
    surface: 'analyze area-health, flaky area column',
    requirements: [onTest('area', text)],
  },
  {
    id: 'failure-categories',
    surface: 'analyze spikes / common-failures',
    requirements: [onTest('failure_category', text, 'failed-test')],
  },
  {
    id: 'order',
    surface: 'canary order',
    requirements: [onTest('test_file', text), onTest('duration_ms', num)],
  },
  {
    id: 'rewind',
    surface: 'canary rewind',
    requirements: [onRun('replay', obj), onTest('start_index', num)],
  },
  {
    id: 'order-ttff',
    surface: 'canary order --report (TTFF)',
    requirements: [onRun('order', obj)],
    optIn: '--order-plan',
  },
];
