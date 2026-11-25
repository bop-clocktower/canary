// Advisory floors for transitive dependencies pinned through `overrides` in
// ts/package.json. An override is invisible once it works, so a dependency
// bump that drops it would quietly reinstall the vulnerable version; this
// reads the committed lockfile so the regression shows up offline, in the
// normal test run, rather than only in `npm audit` (#1707).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface LockPackage {
  version?: string;
}

const lock = JSON.parse(
  readFileSync(join(__dirname, '..', 'package-lock.json'), 'utf8'),
) as { packages: Record<string, LockPackage> };

/** Every resolved version of `name` in the lockfile, keyed by install path. */
function resolved(
  packages: Record<string, LockPackage>,
  name: string,
): Array<[string, string]> {
  return Object.entries(packages)
    .filter(([path]) => path.endsWith(`node_modules/${name}`))
    .map(([path, pkg]) => [path, pkg.version ?? 'unknown']);
}

/** True when `v` is at least `floor` (both bare X.Y.Z). */
function atLeast(v: string, floor: string): boolean {
  const a = v.split('.').map(Number);
  const b = floor.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

describe('lockfile advisory floors', () => {
  it('ranks versions numerically', () => {
    expect(atLeast('11.0.1', '11.0.1')).toBe(true);
    expect(atLeast('10.2.6', '11.0.1')).toBe(false);
    expect(atLeast('11.0.10', '11.0.9')).toBe(true);
  });

  it('resolves every minimatch at or above 11.0.1 (GHSA-g3hv-75wg-m249, #1707)', () => {
    const found = resolved(lock.packages, 'minimatch');
    // A zero denominator would pass vacuously; Stryker always pulls minimatch.
    expect(found.length).toBeGreaterThan(0);
    const below = found.filter(([, v]) => !atLeast(v, '11.0.1'));
    expect(below).toEqual([]);
  });

  it('resolves every qs at or above 6.16.1 (#1706 override)', () => {
    const found = resolved(lock.packages, 'qs');
    expect(found.length).toBeGreaterThan(0);
    expect(found.filter(([, v]) => !atLeast(v, '6.16.1'))).toEqual([]);
  });
});
