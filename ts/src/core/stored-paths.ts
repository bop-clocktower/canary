/**
 * Joining a test file path stored in run history to a path listed somewhere
 * else -- the inventory, or the working tree (#1500, #1561).
 *
 * Neither side says what its path is relative to: a stored path's base differs
 * by reporter (absolute for vitest, testDir-relative for Playwright, sometimes
 * a bare file name), and a listed one's by the root it was collected from. So
 * the join is a whole-segment suffix match, either way round. Pure.
 */

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
}

export function baseOf(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

export function dirOf(p: string): string {
  return p.slice(0, Math.max(p.lastIndexOf('/'), 0));
}

/**
 * Whole segments only: `xtests/cart.spec.ts` is not `tests/cart.spec.ts`, on
 * either side. A bare stored name (`a.spec.ts`) therefore joins any listed
 * `.../a.spec.ts`, the weakest join there is (#1561).
 */
function pathsJoin(stored: string, listed: string): boolean {
  return (
    stored === listed ||
    stored.endsWith(`/${listed}`) ||
    listed.endsWith(`/${stored}`)
  );
}

/**
 * A join tester over `paths`, which are normalized here; the stored path it is
 * asked about must already be. Only same-named files can join, so it indexes
 * by file name.
 */
export function joinerFor(
  paths: readonly string[],
): (stored: string) => boolean {
  const byBase = new Map<string, string[]>();
  for (const raw of paths) {
    const p = normalizePath(raw);
    byBase.set(baseOf(p), [...(byBase.get(baseOf(p)) ?? []), p]);
  }
  return (stored) =>
    (byBase.get(baseOf(stored)) ?? []).some((p) => pathsJoin(stored, p));
}
