/**
 * No silent abstention (#508) -- CLI-level negative tests. For every wired
 * gate/command, a fixture where the denominator collapses to zero must produce
 * the loud outcome: exit 3 (EXIT_ABSTAINED) for gates, an explicit
 * `⚠ abstained: <reason>` line for advisory commands. A run that checked
 * nothing must never read as a pass.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { EXIT_ABSTAINED } from '../src/core/abstention.js';
import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

const HISTORY_REL = join('test-results', 'reports', 'history-v2.jsonl');

function fake<T>(obj: unknown): T {
  return obj as T;
}

function fakeHarnessProject(root: string): void {
  writeFileSync(
    join(root, 'harness.config.json'),
    '{"framework": "vitest"}',
    'utf-8',
  );
  mkdirSync(join(root, '.harness'));
}

// --- review-test / flake-check: gates over zero matched files ---------------

describe('review-test / flake-check abstain on zero matched files (#508)', () => {
  it('review-test on a dir with no test files exits 3 with the notice', async () => {
    const tmp = mkTmp();
    try {
      const res = await invokeCanary(['review-test', tmp]);
      expect(res.code).toBe(EXIT_ABSTAINED);
      expect(res.stdout).toContain('abstained:');
      expect(res.stdout).not.toContain('No issues found');
    } finally {
      rmTmp(tmp);
    }
  });

  it('review-test --json keeps stdout parseable, notice on stderr, exit 3', async () => {
    const tmp = mkTmp();
    try {
      const res = await invokeCanary(['review-test', tmp, '--json']);
      expect(res.code).toBe(EXIT_ABSTAINED);
      expect(JSON.parse(res.stdout)).toEqual([]);
      expect(res.stderr).toContain('abstained:');
    } finally {
      rmTmp(tmp);
    }
  });

  it('flake-check on a dir with no test files exits 3 with the notice', async () => {
    const tmp = mkTmp();
    try {
      const res = await invokeCanary(['flake-check', tmp]);
      expect(res.code).toBe(EXIT_ABSTAINED);
      expect(res.stdout).toContain('abstained:');
      expect(res.stdout).not.toContain('No flakiness patterns detected');
    } finally {
      rmTmp(tmp);
    }
  });

  it('a clean lint run states its denominator (#508a)', async () => {
    const tmp = mkTmp();
    try {
      writeFileSync(join(tmp, 'test_a.py'), 'x = 1\n', 'utf-8');
      const res = await invokeCanary(['review-test', tmp], {
        deps: { makeLinter: () => fake({ lint: () => [] }) },
      });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('No issues found in 1 file(s).');
    } finally {
      rmTmp(tmp);
    }
  });
});

// --- migrate dry run: JSON carries the denominator ---------------------------

describe('migrate dry run reports checked/abstained (#508/#504)', () => {
  /** Parse the JSON payload after the migrate banner (existing CLI shape). */
  const payloadOf = (stdout: string): Record<string, unknown> =>
    JSON.parse(stdout.slice(stdout.indexOf('{'))) as Record<string, unknown>;

  it('--json includes the denominator when the dry run resolves work', async () => {
    const base = mkTmp();
    try {
      const project = join(base, 'proj');
      const home = join(base, 'home');
      mkdirSync(project);
      fakeHarnessProject(project);
      const res = await invokeCanary(
        ['migrate', '--path', project, '--framework', 'pytest', '--json'],
        { deps: { home: () => home } },
      );
      expect(res.code).toBe(0);
      const payload = payloadOf(res.stdout);
      expect(payload['abstained']).toBe(false);
      expect(payload['checked'] as number).toBeGreaterThan(0);
    } finally {
      rmTmp(base);
    }
  });

  it('--json flags an unknown-framework dry run that resolved nothing (#504)', async () => {
    const base = mkTmp();
    try {
      const project = join(base, 'proj');
      const home = join(base, 'home');
      mkdirSync(project);
      fakeHarnessProject(project); // no detectable framework, no overlay
      const res = await invokeCanary(['migrate', '--path', project, '--json'], {
        deps: { home: () => home },
      });
      expect(res.code).toBe(0);
      const payload = payloadOf(res.stdout);
      expect(payload['checked']).toBe(0);
      expect(payload['abstained']).toBe(true);
    } finally {
      rmTmp(base);
    }
  });

  it('dry-run markdown never says Migration complete', async () => {
    const base = mkTmp();
    try {
      const project = join(base, 'proj');
      const home = join(base, 'home');
      mkdirSync(project);
      fakeHarnessProject(project);
      const res = await invokeCanary(['migrate', '--path', project], {
        deps: { home: () => home },
      });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('Dry run');
      expect(res.stdout).not.toContain('Migration complete');
    } finally {
      rmTmp(base);
    }
  });
});

// --- skills run: zero resolved targets is already loud -----------------------

describe('skills run with zero resolvable targets stays loud (#508)', () => {
  it('a registry that discovers zero skills exits 1, never 0', async () => {
    const res = await invokeCanary(['skills', 'run', 'anything'], {
      deps: {
        makeSkillRegistry: () => fake({ discover: () => [], find: () => null }),
      },
    });
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('No skill named');
  });
});

// --- analyze: empty run-history windows --------------------------------------

describe('analyze abstains on an empty run-history window (#508)', () => {
  const cases: string[][] = [
    ['analyze', 'flaky'],
    ['analyze', 'spikes'],
    ['analyze', 'common-failures'],
    ['analyze', 'regression-candidates'],
  ];

  for (const argv of cases) {
    it(`${argv.join(' ')} prints the abstention notice, not a green all-clear`, async () => {
      const tmp = mkTmp();
      try {
        const res = await invokeCanary(argv, { cwd: tmp });
        expect(res.code).toBe(0); // advisory: notice, not exit code
        expect(res.stdout).toContain('abstained:');
        expect(res.stdout).not.toContain('No tests above');
        expect(res.stdout).not.toContain('No spikes detected');
      } finally {
        rmTmp(tmp);
      }
    });
  }

  it('analyze flaky --json keeps stdout parseable with the notice on stderr', async () => {
    const tmp = mkTmp();
    try {
      const res = await invokeCanary(['analyze', 'flaky', '--json'], {
        cwd: tmp,
      });
      expect(res.code).toBe(0);
      expect(JSON.parse(res.stdout)).toEqual([]);
      expect(res.stderr).toContain('abstained:');
    } finally {
      rmTmp(tmp);
    }
  });

  it('analyze digest on an empty store carries the notice', async () => {
    const tmp = mkTmp();
    try {
      const res = await invokeCanary(
        ['analyze', 'digest', '--output', 'out-dir'],
        { cwd: tmp },
      );
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('abstained:');
    } finally {
      rmTmp(tmp);
    }
  });

  it('a seeded store still gets the genuine green line', async () => {
    const tmp = mkTmp();
    try {
      const path = join(tmp, HISTORY_REL);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({
          run_id: 'r1',
          suite: 's',
          timestamp: '2026-07-02T00:00:00Z',
          passed: 1,
          failed: 0,
          flaky: 0,
          total: 1,
          tests: [{ test_name: 't', status: 'passed' }],
        }) + '\n',
        'utf-8',
      );
      const res = await invokeCanary(['analyze', 'flaky'], { cwd: tmp });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('No tests above');
      expect(res.stdout).not.toContain('abstained:');
    } finally {
      rmTmp(tmp);
    }
  });
});

// --- history: empty stores / zero-run summaries -------------------------------

describe('history abstains on zero-run denominators (#508)', () => {
  it('flaky over an empty store abstains instead of "no flaky tests"', async () => {
    const tmp = mkTmp();
    try {
      const res = await invokeCanary(['history', 'flaky'], { cwd: tmp });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('abstained:');
      expect(res.stdout).not.toContain('No tests above');
    } finally {
      rmTmp(tmp);
    }
  });

  it('summary over a suite with zero runs abstains instead of a 0.0% stat', async () => {
    const tmp = mkTmp();
    try {
      const res = await invokeCanary(['history', 'summary', 'ghost-suite'], {
        cwd: tmp,
      });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('abstained:');
      expect(res.stdout).not.toContain('avg pass rate');
    } finally {
      rmTmp(tmp);
    }
  });

  it('migrate over a file with zero parseable runs abstains, not "Migrated 0"', async () => {
    const tmp = mkTmp();
    try {
      const v1 = join(tmp, 'history.jsonl');
      writeFileSync(v1, 'not-json\n\n{broken\n', 'utf-8');
      const res = await invokeCanary(
        [
          'history',
          'migrate',
          v1,
          '--suite',
          's',
          '--repo',
          'a/b',
          '--dry-run',
        ],
        { cwd: tmp },
      );
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('abstained:');
      expect(res.stdout).not.toContain('Migrated 0');
    } finally {
      rmTmp(tmp);
    }
  });
});
