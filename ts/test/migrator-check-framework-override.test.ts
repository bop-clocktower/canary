/**
 * `checkFreshness` must honor `CheckFreshnessOptions.framework` the same way
 * `migrate` honors `MigrateOptions.framework`.
 *
 * The freshness gate's contract is that it examines exactly the skill set
 * `migrate` deploys. A `--framework` override resolves a shape on the migrate
 * path; if the gate ignores the same override, a repo whose detection misses
 * gets its skills deployed under the override's shape and then a gate that
 * looks at the empty shape set, verifies zero skills, and abstains -- about
 * skills that are present and current.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { HarnessMigrator } from '../src/core/migrator.js';

const HOME = mkdtempSync(join(tmpdir(), 'canary-chk-fw-home-'));
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

describe('checkFreshness framework override', () => {
  it('checks the skills a --framework migrate deployed', () => {
    const base = mkdtempSync(join(tmpdir(), 'canary-chk-fw-'));
    try {
      const root = join(base, 'proj');
      const overlay = join(base, 'overlay');
      // A harness project with no framework signal at all: detection misses.
      mkdirSync(join(root, '.harness'), { recursive: true });
      writeFileSync(
        join(root, 'harness.config.json'),
        JSON.stringify({ layers: [] }),
      );
      // An overlay skill scoped to the shape the locust override resolves (locust has no scaffold template, so
      // the apply writes no config file that detection could pick up later).
      const skillDir = join(overlay, '.canary', 'skills', 'sample-skill');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        '---\nname: sample-skill\ndeploy_to: [load]\n---\n\n# sample\n',
      );

      const m = new HarnessMigrator(HOME);
      m.migrate(root, {
        dryRun: false,
        framework: 'locust',
        overlayPath: overlay,
      });

      // Precondition: the override did deploy the skill.
      expect(existsSync(join(root, '.canary', 'skills', 'sample-skill'))).toBe(
        true,
      );

      const report = m.checkFreshness(root, {
        overlayPath: overlay,
        framework: 'locust',
      });
      expect(report.results.map((r) => [r.skill_name, r.status])).toEqual([
        ['sample-skill', 'current'],
      ]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
