/**
 * No-silent-abstention, Wave 4a: the engine long tail (#508).
 *
 * Two shapes are covered here, and they abstain on DIFFERENT denominators:
 *
 *   - file-scanning gates (`review-test`, `flake-check`) -- denominator is the
 *     number of test files collected. A directory that matched nothing is the
 *     #503 shape: exit 3, never a green all-clear.
 *   - history-backed advisory commands (`analyze`, `history`) -- denominator is
 *     the number of RUNS in the window, NOT the number of result rows. Zero
 *     flaky rows across 500 runs is a genuine clean result; zero rows across
 *     zero runs is an absent measurement. Using rows as the denominator would
 *     abstain on every healthy fleet.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { EXIT_ABSTAINED } from '../src/core/gate-result.js';
import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

/** A directory that exists but holds no test files. */
function emptyTestDir(base: string): string {
  const dir = join(base, 'no-tests');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README.md'), '# not a test\n', 'utf-8');
  return dir;
}

/** A directory holding exactly one collectible test file. */
function oneTestDir(base: string): string {
  const dir = join(base, 'has-tests');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'test_a.py'), 'x = 1\n', 'utf-8');
  return dir;
}

const noFindings = { lint: () => [], flakeCheck: () => [] };

describe('review-test: zero collected files abstains (gate)', () => {
  it('a directory matching no test files exits 3, never "No issues found"', async () => {
    const base = mkTmp();
    try {
      const res = await invokeCanary(['review-test', emptyTestDir(base)], {
        deps: { makeLinter: () => noFindings as never },
      });
      expect(res.code).toBe(EXIT_ABSTAINED);
      expect(res.stdout).not.toContain('No issues found');
      expect(res.stdout).toContain('Abstained');
    } finally {
      rmTmp(base);
    }
  });

  it('remediation names the collapsed denominator and a first fix step', async () => {
    const base = mkTmp();
    try {
      const res = await invokeCanary(['review-test', emptyTestDir(base)], {
        deps: { makeLinter: () => noFindings as never },
      });
      expect(res.stdout).toMatch(/test file/i);
    } finally {
      rmTmp(base);
    }
  });

  it('a directory WITH a test file still reports the clean pass', async () => {
    const base = mkTmp();
    try {
      const res = await invokeCanary(['review-test', oneTestDir(base)], {
        deps: { makeLinter: () => noFindings as never },
      });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('No issues found');
      expect(res.stdout).not.toContain('Abstained');
    } finally {
      rmTmp(base);
    }
  });

  it('a single-file target is a denominator of 1, never an abstention', async () => {
    const res = await invokeCanary(['review-test', 'x.py'], {
      deps: { makeLinter: () => noFindings as never },
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('No issues found');
  });

  it('--json over zero files still abstains on the exit code', async () => {
    const base = mkTmp();
    try {
      const res = await invokeCanary(
        ['review-test', emptyTestDir(base), '--json'],
        { deps: { makeLinter: () => noFindings as never } },
      );
      expect(res.code).toBe(EXIT_ABSTAINED);
      // stdout stays a parseable array -- the notice rides stderr.
      expect(Array.isArray(JSON.parse(res.stdout))).toBe(true);
    } finally {
      rmTmp(base);
    }
  });
});

describe('flake-check: zero collected files abstains (gate)', () => {
  it('exits 3 instead of "No flakiness patterns detected"', async () => {
    const base = mkTmp();
    try {
      const res = await invokeCanary(['flake-check', emptyTestDir(base)], {
        deps: { makeLinter: () => noFindings as never },
      });
      expect(res.code).toBe(EXIT_ABSTAINED);
      expect(res.stdout).not.toContain('No flakiness patterns detected');
      expect(res.stdout).toContain('Abstained');
    } finally {
      rmTmp(base);
    }
  });

  it('a directory WITH a test file still reports the clean pass', async () => {
    const base = mkTmp();
    try {
      const res = await invokeCanary(['flake-check', oneTestDir(base)], {
        deps: { makeLinter: () => noFindings as never },
      });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('No flakiness patterns detected');
    } finally {
      rmTmp(base);
    }
  });
});

/**
 * Seed a history store with one run so the denominator is genuinely non-zero.
 * `analyze`/`history` read `test-results/reports/history-v2.jsonl` under cwd.
 */
function seedHistory(base: string): void {
  const dir = join(base, 'test-results', 'reports');
  mkdirSync(dir, { recursive: true });
  const record = {
    run_id: 'r1',
    suite: 'api',
    repo: 'o/r',
    branch: 'main',
    commit_sha: 'abc1234',
    timestamp: '2026-08-01T00:00:00+00:00',
    total: 2,
    passed: 2,
    failed: 0,
    flaky: 0,
    skipped: 0,
    tests: [
      { test_name: 't1', status: 'passed' },
      { test_name: 't2', status: 'passed' },
    ],
  };
  writeFileSync(
    join(dir, 'history-v2.jsonl'),
    `${JSON.stringify(record)}\n`,
    'utf-8',
  );
}

describe('analyze: zero RUNS abstains, zero ROWS does not (#508 Wave 4a)', () => {
  const EMPTY_ABSTAINS = [
    'flaky',
    'spikes',
    'common-failures',
    'regression-candidates',
  ];

  for (const sub of EMPTY_ABSTAINS) {
    it(`${sub} over an empty store abstains at exit 0 (advisory)`, async () => {
      const base = mkTmp();
      try {
        const res = await invokeCanary(['analyze', sub], { cwd: base });
        expect(res.code).toBe(0);
        expect(res.stdout).toContain('Abstained');
      } finally {
        rmTmp(base);
      }
    });

    it(`${sub} over a SEEDED store renders its report, never abstaining`, async () => {
      const base = mkTmp();
      try {
        seedHistory(base);
        const res = await invokeCanary(['analyze', sub], { cwd: base });
        expect(res.code).toBe(0);
        // The control that proves the denominator is RUNS, not rows: this store
        // yields zero flaky/spike/failure rows but is emphatically not empty.
        expect(res.stdout).not.toContain('Abstained');
      } finally {
        rmTmp(base);
      }
    });
  }

  it('--json keeps stdout a parseable array; the notice rides stderr', async () => {
    const base = mkTmp();
    try {
      const res = await invokeCanary(['analyze', 'flaky', '--json'], {
        cwd: base,
      });
      expect(res.code).toBe(0);
      expect(JSON.parse(res.stdout)).toEqual([]);
      expect(res.stdout).not.toContain('Abstained');
      expect(res.stderr).toContain('Abstained');
    } finally {
      rmTmp(base);
    }
  });

  it('area-health always abstains -- its row set is hardcoded empty', async () => {
    const base = mkTmp();
    try {
      seedHistory(base);
      const res = await invokeCanary(['analyze', 'area-health'], { cwd: base });
      expect(res.code).toBe(0);
      // Even WITH history: the command computes no rows, so a clean-looking
      // report would be a fiction.
      expect(res.stdout).toContain('Abstained');
    } finally {
      rmTmp(base);
    }
  });
});

describe('history: zero runs abstains (#508 Wave 4a)', () => {
  it('flaky over an empty store abstains, never "No tests above"', async () => {
    const base = mkTmp();
    try {
      const res = await invokeCanary(['history', 'flaky'], { cwd: base });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('Abstained');
      expect(res.stdout).not.toContain('No tests above');
    } finally {
      rmTmp(base);
    }
  });

  it('summary over zero runs never fabricates "avg pass rate: 0.0%"', async () => {
    const base = mkTmp();
    try {
      const res = await invokeCanary(['history', 'summary', 'api'], {
        cwd: base,
      });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('Abstained');
      expect(res.stdout).not.toContain('0.0%');
      expect(res.stdout).toMatch(/unknown/i);
    } finally {
      rmTmp(base);
    }
  });

  it('summary --json carries abstained additively', async () => {
    const base = mkTmp();
    try {
      const res = await invokeCanary(['history', 'summary', 'api', '--json'], {
        cwd: base,
      });
      expect(res.code).toBe(0);
      const payload = JSON.parse(res.stdout) as Record<string, unknown>;
      expect(payload['abstained']).toBe(true);
      expect(payload['total_runs']).toBe(0);
    } finally {
      rmTmp(base);
    }
  });

  it('summary over a SEEDED store reports the real rate', async () => {
    const base = mkTmp();
    try {
      seedHistory(base);
      const res = await invokeCanary(['history', 'summary', 'api'], {
        cwd: base,
      });
      expect(res.code).toBe(0);
      expect(res.stdout).not.toContain('Abstained');
      expect(res.stdout).toContain('avg pass rate');
    } finally {
      rmTmp(base);
    }
  });
});

/**
 * `skills run` was audited, not changed. It already carries an exit ladder
 * (1 = no such skill ... 6 = import failure) whose exit 3 predates D4's
 * CLI-wide reservation of 3 for "abstained". The collision resolves in the
 * doctrine's favor rather than against it, and these pins record which reading
 * won so a future reader does not re-litigate it.
 */
describe('skills run: exit-ladder classification (#508 Wave 4a)', () => {
  it('an unknown skill is a BAD ARGUMENT (exit 1), not an abstention', async () => {
    const res = await invokeCanary(['skills', 'run', 'no-such-skill'], {
      deps: {
        makeSkillRegistry: () => ({ find: () => null }) as never,
      },
    });
    expect(res.code).toBe(1);
    expect(res.stdout).not.toContain('Abstained');
  });

  it('refusing to invoke an executable skill IS an abstention, and already exits 3', async () => {
    const res = await invokeCanary(['skills', 'run', 'exec-skill'], {
      deps: {
        makeSkillRegistry: () =>
          ({
            find: () => ({
              name: 'exec-skill',
              error: null,
              isExecutable: true,
              cli: 'run.js',
              dir: '/tmp',
            }),
          }) as never,
      },
    });
    // Zero skills executed, with an explicit printed reason -- the exit code
    // was already right; Wave 4a only records the classification.
    expect(res.code).toBe(EXIT_ABSTAINED);
    expect(res.stdout).toContain('Refusing to invoke');
  });
});

describe('heal-test: audited, no zero-denominator path (#508 Wave 4a)', () => {
  it('a non-file target errors at exit 1 -- not an abstention', async () => {
    const base = mkTmp();
    try {
      const res = await invokeCanary(['heal-test', base]);
      expect(res.code).toBe(1);
      expect(res.stdout).not.toContain('Abstained');
    } finally {
      rmTmp(base);
    }
  });

  it('"no auto-fixable patterns" over a real file is a RESULT, not silence', async () => {
    const base = mkTmp();
    try {
      const path = join(base, 'test_a.py');
      writeFileSync(path, 'x = 1\n', 'utf-8');
      const res = await invokeCanary(['heal-test', path], {
        deps: {
          makeHealer: () =>
            ({
              heal: () => ({
                file: path,
                changed: false,
                changes: [],
                skipped: [],
                patched_content: '',
              }),
            }) as never,
        },
      });
      // The denominator is always exactly 1 (the file), so this must stay green.
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('No auto-fixable patterns found');
      expect(res.stdout).not.toContain('Abstained');
    } finally {
      rmTmp(base);
    }
  });
});
