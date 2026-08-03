/**
 * Gate-abstention conformance suite (#508, no-silent-abstention D5).
 *
 * The ROWS table below IS the canonical registry of gates and advisory
 * commands. Every command swept onto the gate-result helper gets a row
 * whose fixture collapses its denominator to zero and whose expectation
 * proves the loud outcome -- the #495 negative-testing discipline applied
 * to every gate. A new gate is not done until it has a row here.
 *
 * This file holds the ENGINE rows. The other layers keep their own registries,
 * because each runs in a different module system / process model:
 *   - npm (doctor, overlay lint) -> npm/scripts/__tests__/gate-conformance.test.js
 *     (CommonJS, node:test);
 *   - skill CLIs -> agents/skills/test/gate-conformance.test.ts (subprocess).
 *
 * Wave 1 seeded the engine layer (migrate --check, migrate dry-run); Wave 2
 * added guardian; Wave 3 added the npm registry above. Waves 4-5 add the long
 * tail and the workflow rows.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { EXIT_ABSTAINED } from '../src/core/gate-result.js';
import { HarnessMigrator } from '../src/core/migrator.js';
import { FakeBranchProtectionClient } from '../src/guardian/hard-gate.js';
import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';
import { invokeGuardian } from './guardian-cli-testkit.js';

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

/** A directory that exists but holds no collectible test file (Wave 4a). */
function emptyTestDir(base: string): string {
  const dir = join(base, 'no-tests');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README.md'), '# not a test\n', 'utf-8');
  return dir;
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
  {
    command: 'guardian pr-check (empty diff)',
    layer: 'engine',
    kind: 'gate',
    expect: 'exit3',
    forbid: ['no test-coverage gaps', 'nothing to verify'],
    // #456 permanent negative fixture (spec SC4): the guardian silently
    // no-opped for weeks; an empty diff must never render as a pass again.
    run: (base) =>
      invokeGuardian(['pr-check', '--diff', '-'], { input: '', cwd: base }),
  },
  {
    command: 'guardian harden-gate --apply (zero observed checks)',
    layer: 'engine',
    kind: 'gate',
    expect: 'exit3',
    forbid: ['already required', 'Finish the flip'],
    run: () =>
      invokeGuardian(
        ['harden-gate', '--repo', 'o/r', '--apply', '--token', 'x'],
        {
          deps: {
            buildBranchProtectionClient: () =>
              new FakeBranchProtectionClient({
                contexts: ['build'],
                observed: [],
              }),
          },
        },
      ),
  },
  {
    command: 'guardian analyze (zero-endpoint diff)',
    layer: 'engine',
    kind: 'advisory',
    expect: 'warnLine',
    forbid: ['"abstained": false'],
    run: (base) =>
      invokeGuardian(['analyze', 'abc1234', '--json'], { cwd: base }),
  },
  {
    command: 'guardian validate-coverage (zero file entries)',
    layer: 'engine',
    kind: 'advisory',
    expect: 'warnLine',
    forbid: ['valid coverage-json document'],
    run: async (base) => {
      const path = join(base, 'coverage.json');
      writeFileSync(path, JSON.stringify({ files: {} }), 'utf-8');
      return invokeGuardian(['validate-coverage', path]);
    },
  },

  // --- Wave 4a: the engine long tail ---------------------------------------
  {
    command: 'review-test (directory matching zero test files)',
    layer: 'engine',
    kind: 'gate',
    expect: 'exit3',
    forbid: ['No issues found'],
    run: (base) => invokeCanary(['review-test', emptyTestDir(base)]),
  },
  {
    command: 'flake-check (directory matching zero test files)',
    layer: 'engine',
    kind: 'gate',
    expect: 'exit3',
    forbid: ['No flakiness patterns detected'],
    run: (base) => invokeCanary(['flake-check', emptyTestDir(base)]),
  },
  {
    command: 'analyze flaky (zero runs recorded)',
    layer: 'engine',
    kind: 'advisory',
    expect: 'warnLine',
    forbid: ['No tests above'],
    run: (base) => invokeCanary(['analyze', 'flaky'], { cwd: base }),
  },
  {
    command: 'analyze regression-candidates (zero runs recorded)',
    layer: 'engine',
    kind: 'advisory',
    expect: 'warnLine',
    forbid: [],
    run: (base) =>
      invokeCanary(['analyze', 'regression-candidates'], { cwd: base }),
  },
  {
    command: 'analyze area-health (row set is hardcoded empty)',
    layer: 'engine',
    kind: 'advisory',
    expect: 'warnLine',
    forbid: [],
    run: (base) => invokeCanary(['analyze', 'area-health'], { cwd: base }),
  },
  {
    command: 'history flaky (zero runs recorded)',
    layer: 'engine',
    kind: 'advisory',
    expect: 'warnLine',
    forbid: ['No tests above'],
    run: (base) => invokeCanary(['history', 'flaky'], { cwd: base }),
  },
  // --- review-round gaps: surfaces #515's audit table never listed ---------
  {
    command: 'history timeline (zero runs recorded)',
    layer: 'engine',
    kind: 'advisory',
    expect: 'warnLine',
    forbid: ['No history found for'],
    run: (base) =>
      invokeCanary(['history', 'timeline', 'some-test'], { cwd: base }),
  },
  {
    command: 'guardian author-plan (empty diff)',
    layer: 'engine',
    kind: 'advisory',
    expect: 'warnLine',
    // `"abstained": false` must never appear -- the #456 class was exactly
    // "examined nothing, therefore do not block".
    forbid: ['"abstained": false'],
    run: (base) =>
      invokeGuardian(['author-plan', '--diff', '-'], { input: '', cwd: base }),
  },
  {
    command: 'history summary (zero runs -- the fabricated 0.0% average)',
    layer: 'engine',
    kind: 'advisory',
    expect: 'warnLine',
    forbid: ['0.0%'],
    run: (base) => invokeCanary(['history', 'summary', 'api'], { cwd: base }),
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
