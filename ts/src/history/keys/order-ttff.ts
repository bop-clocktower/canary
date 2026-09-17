/**
 * Time-to-first-failure for a recorded run (#460 D7): how long the suite ran,
 * in a given file order, before its first failing test.
 *
 * Both numbers are ESTIMATES built from recorded per-test durations, summed
 * serially. They ignore parallelism and runner start-up, so they compare two
 * orders of the same run rather than measuring wall clock, and the field names
 * say so. A run with no failure has no first failure: both are null, which the
 * report counts as not measurable rather than as a win.
 */

import { readFileSync } from 'node:fs';

import type { TestResultInput } from '../schema.js';
import type { OrderOutcome } from './replay-record.js';

export interface OrderPlanFile {
  mode: string | null;
  /** The plan's file order. */
  order: string[];
  /** The runner's declaration order the plan was built from. */
  declared: string[];
}

const FAILING = new Set(['failed', 'flaky']);

/** Summed duration up to and including the first failing test, or null. */
export function estimateTtff(
  fileOrder: string[],
  results: Pick<TestResultInput, 'test_file' | 'status' | 'duration_ms'>[],
): number | null {
  const byFile = new Map<string, typeof results>();
  for (const r of results) {
    byFile.set(r.test_file, [...(byFile.get(r.test_file) ?? []), r]);
  }
  const named = fileOrder.filter((f) => byFile.has(f));
  const rest = [...byFile.keys()].filter((f) => !fileOrder.includes(f));
  let elapsed = 0;
  for (const file of [...named, ...rest]) {
    for (const r of byFile.get(file)!) {
      elapsed += r.duration_ms ?? 0;
      if (FAILING.has(r.status)) return elapsed;
    }
  }
  return null;
}

const strings = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : null;

/** A `canary order` plan file, or null when it cannot be read as one. */
export function readOrderPlanFile(path: string): OrderPlanFile | null {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  const entries = data['entries'];
  if (!Array.isArray(entries)) return null;
  const order = strings(
    entries.map((e) => (e as { test_file?: unknown }).test_file),
  );
  if (order === null) return null;
  return {
    mode: typeof data['mode'] === 'string' ? data['mode'] : null,
    order,
    declared: strings(data['declared']) ?? [],
  };
}

/** The estimates `record --order-plan` stores on a run. */
export function orderOutcome(
  plan: OrderPlanFile,
  results: Pick<TestResultInput, 'test_file' | 'status' | 'duration_ms'>[],
): OrderOutcome {
  return {
    mode: plan.mode,
    ttff_ordered_ms_estimate: estimateTtff(plan.order, results),
    ttff_baseline_ms_estimate:
      plan.declared.length === 0 ? null : estimateTtff(plan.declared, results),
  };
}
