// window -- which records a digest covers (spec D6).
//
// --until makes a digest reproducible: the same store and the same --until
// always produce the same digest, which is what lets it be tested and
// re-run for a past week. Records with no parseable date are COUNTED, never
// silently dropped -- "N undated runs excluded" is the difference between a
// thin week and a store that lost its timestamps.

const DAY_MS = 86_400_000;

/**
 * @param {number} days window length, >= 1
 * @param {string|null} until ISO-8601 end (inclusive); null = now
 * @returns {{window: {since: Date, until: Date}} | {error: string}}
 */
export function resolveWindow(days, until) {
  if (!(days >= 1)) {
    return { error: `argument --days: must be >= 1, got ${days}` };
  }
  const end = until == null ? new Date() : new Date(until);
  if (Number.isNaN(end.getTime())) {
    return { error: `argument --until: not an ISO-8601 time: '${until}'` };
  }
  return {
    window: { since: new Date(end.getTime() - days * DAY_MS), until: end },
  };
}

/**
 * Split items into those dated inside [since, until] and a count of those
 * with no parseable date. Items dated outside the window are neither.
 */
export function partitionByWindow(items, dateOf, window) {
  const lo = window.since.getTime();
  const hi = window.until.getTime();
  const inside = [];
  let undated = 0;
  for (const item of items) {
    const at = Date.parse(dateOf(item) ?? '');
    if (Number.isNaN(at)) undated += 1;
    else if (at >= lo && at <= hi) inside.push(item);
  }
  return { inside, undated };
}
