// Security floors for transitive dev dependencies that a parent pins below the
// patched release, so Dependabot cannot raise them itself
// (`security_update_not_possible`). Each one is held up by an `overrides`
// entry in package.json. This test keeps the override from being quietly
// dropped: removing it, or a lockfile regenerated without it, fails here
// instead of reopening the alert with nobody noticing.
//
// minimatch: GHSA-g3hv-75wg-m249 (DoS through globparts amplification) affects
// >=7.0.0 <11.0.1. eslint 10.14.0 and @eslint/config-array 0.23.5 require
// ^10.x, so the patched 11.x line only arrives through the override (alert #65).

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'),
);

const FLOORS: Record<string, string> = {
  minimatch: '11.0.1',
};

// Numeric collation compares x.y.z component by component (10.2.6 < 11.0.1).
// Any prerelease suffix is dropped before comparing.
const atLeast = (version: string, floor: string): boolean =>
  version.split('-')[0].localeCompare(floor, 'en', { numeric: true }) >= 0;

describe('lockfile advisory floors', () => {
  for (const [name, floor] of Object.entries(FLOORS)) {
    const installs = Object.entries(
      lock.packages as Record<string, { version?: string }>,
    )
      .filter(
        ([p]) =>
          p === `node_modules/${name}` || p.endsWith(`/node_modules/${name}`),
      )
      .map(([p, meta]) => ({ path: p, version: meta.version ?? '' }));

    it(`${name} is in the lockfile (a zero count would pass vacuously)`, () => {
      expect(installs.length).toBeGreaterThan(0);
    });

    it(`every ${name} install is at or above ${floor}`, () => {
      const below = installs.filter((i) => !atLeast(i.version, floor));
      expect(below).toEqual([]);
    });
  }
});
