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
import { measurabilityOf } from '../../util/flake-window.js';
import { REPLAYABLE_RUNNERS, testFileProblem } from '../rewind/plan.js';

/** What a requirement's denominator counts. */
export type Scope = 'run' | 'test' | 'failed-test';

export interface Requirement {
  field: string;
  scope: Scope;
  /**
   * Narrows a test scope to the rows the consumer actually reads (screech's
   * failures exclude flakes). Absent: every row the scope names.
   */
  where?: (test: TestResultRecord) => boolean;
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

const text = (v: unknown): boolean => typeof v === 'string' && v.length > 0;
const num = (v: unknown): boolean =>
  typeof v === 'number' && Number.isFinite(v);
const obj = (v: unknown): boolean => typeof v === 'object' && v !== null;

// ci-ready's runtime check drops zero and negative durations (core/ci-ready.ts).
const positive = (v: unknown): boolean => num(v) && (v as number) > 0;

// Only these readers can emit the `flaky` status at all (#604); a store written
// by the Vitest reader alone is structurally dark for retry flakes (G6). Asked
// of flake-window itself, so the capable set keeps one owner.
const retry = (v: unknown): boolean =>
  typeof v === 'string' && measurabilityOf([{ reporter_format: v }]) === 'yes';

// rewind's refusals (analysis/rewind/plan.ts), asked of rewind itself.
const replayableSha = (v: unknown): boolean => text(v) && v !== 'local';
const replayableRunner = (v: unknown): boolean =>
  typeof v === 'string' &&
  (REPLAYABLE_RUNNERS as readonly string[]).includes(v);
const replayableFile = (v: unknown): boolean =>
  typeof v === 'string' && testFileProblem(v) === null;

// canary-screech's `isFailure` (scripts/cluster.mjs): a flake is not a failure.
const hardFailure = (t: TestResultRecord): boolean => t.status === 'failed';

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
  where?: (test: TestResultRecord) => boolean,
): Requirement {
  const req: Requirement = {
    field,
    scope,
    carried: (_run, test) => test !== undefined && ok(test[field]),
  };
  if (where !== undefined) req.where = where;
  return req;
}

/*
 * Not a row: `analyze area-health`. Its engine hard-codes an empty row set
 * (analysis/engine.ts, "area rows are never populated by run()"), so it is dark
 * whatever the store carries -- no field a writer fills can light it. It is
 * named in docs/guides/history-gaps.md instead of measured here.
 */
export const CONSUMERS: readonly Consumer[] = [
  {
    id: 'screech-range',
    surface: 'canary-screech culprit range, history timeline',
    requirements: [
      onRun('branch', text),
      onRun('commit_sha', text),
      onRun('timestamp', text),
    ],
  },
  {
    id: 'screech-cluster',
    surface: 'canary-screech owning area, failure clusters, recommendation',
    requirements: [
      onTest('area', text, 'failed-test', hardFailure),
      onTest('failure_category', text, 'failed-test', hardFailure),
    ],
  },
  {
    id: 'ci-ready-runtime',
    surface: 'canary ci-ready suite runtime',
    requirements: [onRun('duration_ms', positive)],
  },
  {
    id: 'flaky-retry',
    surface: 'history flaky, analyze flaky',
    requirements: [onRun('reporter_format', retry)],
  },
  {
    id: 'flaky-area',
    surface: 'history flaky area column',
    requirements: [onTest('area', text)],
  },
  {
    id: 'failure-categories',
    surface: 'analyze common-failures',
    requirements: [
      onTest('error_text', text, 'failed-test'),
      onTest('failure_category', text, 'failed-test'),
    ],
  },
  {
    id: 'order',
    surface: 'canary order',
    requirements: [onTest('test_file', text), onTest('duration_ms', num)],
  },
  {
    id: 'rewind',
    surface: 'canary rewind',
    requirements: [
      onRun('commit_sha', replayableSha),
      onRun('reporter_format', replayableRunner),
      onTest('test_file', replayableFile, 'failed-test'),
    ],
  },
  {
    id: 'order-ttff',
    surface: 'canary order --report (TTFF)',
    requirements: [onRun('order', obj)],
    optIn: '--order-plan',
  },
];
