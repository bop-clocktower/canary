/**
 * Apply a `canary order` plan to a runner's file list (#460 phase 3). The pure
 * half of the runner adapters: the vitest sequencer calls it with absolute
 * module ids.
 *
 * Like the plan itself, applying it is a permutation. A file the plan does not
 * name (added after the plan was built) goes last in its original order; it is
 * never dropped.
 */

import type { OrderPlan } from './rank.js';

const posix = (p: string): string => p.replace(/\\/g, '/');

/** `ids` reordered by `plan`; plan paths are relative to `root`. */
export function applyOrderPlan(
  ids: string[],
  plan: Pick<OrderPlan, 'entries'>,
  root: string,
): string[] {
  const prefix = `${posix(root).replace(/\/$/, '')}/`;
  const rank = new Map(plan.entries.map((e, i) => [e.test_file, i]));
  const key = (id: string): number => {
    const p = posix(id);
    const rel = p.startsWith(prefix) ? p.slice(prefix.length) : p;
    return rank.get(rel) ?? Number.POSITIVE_INFINITY;
  };
  return ids
    .map((id, i) => ({ id, i, k: key(id) }))
    .sort((a, b) => (a.k === b.k ? a.i - b.i : a.k - b.k))
    .map((x) => x.id);
}

/** A plan read from disk, or null when it is not one. */
export function parseOrderPlan(
  text: string,
): Pick<OrderPlan, 'entries'> | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const entries = (data as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return null;
  const ok = entries.every(
    (e) => typeof (e as { test_file?: unknown }).test_file === 'string',
  );
  return ok ? { entries: entries as OrderPlan['entries'] } : null;
}
