/**
 * Gate-abstention conformance suite (#508, no-silent-abstention D5).
 *
 * The ROWS table below IS the canonical registry of gates and advisory
 * commands. Every command swept onto the gate-result helper gets a row
 * whose fixture collapses its denominator to zero and whose expectation
 * proves the loud outcome -- the #495 negative-testing discipline applied
 * to every gate. A new gate is not done until it has a row here.
 *
 * Wave 1 seeds the engine layer (migrate --check, migrate dry-run).
 * Waves 2-5 add guardian, npm (doctor / overlay lint), long-tail, and
 * workflow rows; skill-CLI rows live in
 * agents/skills/test/gate-conformance.test.ts (subprocess layer).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { EXIT_ABSTAINED } from '../src/core/gate-result.js';
import { HarnessMigrator } from '../src/core/migrator.js';
import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

interface GateRow {
  /** Human-readable command line, for the test name and review diffs. */
  command: string;
  layer: 'engine' | 'npm' | 'skill' | 'workflow';
  kind: 'gate' | 'advisory';
  /** gate rows exit EXIT_ABSTAINED; advisory rows warn and exit 0. */
  expect: 'exit3' | 'warnLine';
  /** Success copy that must NEVER appear on a zero denominator. */
  forbid: string[];
  /** Build the zero-denominator fixture and run the REAL CLI. */
  run: (base: string) => Promise<{ code: number; stdout: string }>;
}

/** Harness project whose shape cannot be detected (migrator.test.ts:690). */
function unknownShapeProject(base: string): {
  project: string;
  home: string;
} {
  const project = join(base, 'proj');
  const home = join(base, 'home');
  mkdirSync(project, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(project, 'harness.config.json'),
    JSON.stringify({ language: 'unknown-lang', layers: [] }),
    'utf-8',
  );
  mkdirSync(join(project, '.harness'));
  return { project, home };
}

const ROWS: GateRow[] = [
  {
    command: 'migrate --check',
    layer: 'engine',
    kind: 'gate',
    expect: 'exit3',
    forbid: ['In sync', 'Migration complete'],
    // #503/#510: unknown shape + empty overlay -> zero skills matched.
    run: (base) => {
      const { project, home } = unknownShapeProject(base);
      const overlay = join(base, 'empty-overlay');
      mkdirSync(join(overlay, '.canary', 'skills'), { recursive: true });
      return invokeCanary(
        ['migrate', '--path', project, '--check', '--from', overlay],
        { deps: { home: () => home } },
      );
    },
  },
  {
    command: 'migrate (dry run)',
    layer: 'engine',
    kind: 'advisory',
    expect: 'warnLine',
    forbid: ['Migration complete'],
    // #504: pre-apply so the dry run has nothing left to migrate.
    run: (base) => {
      const project = join(base, 'proj');
      const home = join(base, 'home');
      mkdirSync(project, { recursive: true });
      mkdirSync(home, { recursive: true });
      writeFileSync(
        join(project, 'harness.config.json'),
        JSON.stringify({ language: 'python', layers: [] }),
        'utf-8',
      );
      mkdirSync(join(project, '.harness'));
      new HarnessMigrator(home).migrate(project, { dryRun: false });
      return invokeCanary(['migrate', '--path', project], {
        deps: { home: () => home },
      });
    },
  },
];

describe('gate conformance registry (#508)', () => {
  for (const row of ROWS) {
    it(`${row.command} [${row.layer}/${row.kind}] is loud on a zero denominator`, async () => {
      const base = mkTmp();
      try {
        const res = await row.run(base);
        expect(res.stdout.toLowerCase()).toContain('abstained');
        for (const text of row.forbid) {
          expect(res.stdout).not.toContain(text);
        }
        if (row.expect === 'exit3') {
          expect(res.code).toBe(EXIT_ABSTAINED);
        } else {
          expect(res.code).toBe(0);
        }
      } finally {
        rmTmp(base);
      }
    });
  }
});
