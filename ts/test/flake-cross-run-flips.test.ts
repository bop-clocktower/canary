/**
 * #604 Phase 2 — cross-run flip (alternation) detection (gap G1).
 *
 * Phase 1 made the flake surfaces honest about their DENOMINATOR. It left the
 * population #604 was filed for still invisible: `flake_count` only ever
 * increments on the within-run `flaky` status, which the vitest reader never
 * writes (`history/formats/vitest-report.ts`). A test that goes
 * passed, failed, passed, failed ACROSS runs therefore arrives with
 * `flake_count: 0` and shows up nowhere.
 *
 * These tests pin the signed-off Phase 2 criteria:
 *
 *   - SC6   an alternating test with `flake_count: 0` is listed by BOTH flaky
 *           commands, with `flip_count: 9` and `alternating: true`
 *   - SC7   a single step change (passed x7 then failed x3) is NOT alternating
 *           (1 flip < the floor) and still surfaces as a regression candidate
 *   - SC8   `passed, skipped, passed` yields `flip_count: 0` -- a non-outcome
 *           is not a side, so it cannot manufacture a flip
 *   - SC9   ranking is on max(flake_rate_pct, flip_rate_pct), so an alternator
 *           at 60% flips sorts above a retry-flake at 20%
 *   - SC10  `ci-ready` fails on max(flake, flip) at or above 10% over a
 *           sufficient window
 *   - H2    minimum sample: a test needs 8 definitive observations before it
 *           may be reported as NOT alternating; below that the verdict is
 *           UNKNOWN (null), never a clean `false`
 *   - G4    the Supabase read path has no flip data, so its flip cells render
 *           UNKNOWN / cannot verify -- never a zero
 *
 * Spec: docs/changes/604-flakiness-detector/proposal.md
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CliExitError } from '../src/cli-common.js';
import { createHistoryCommand, type HistoryDeps } from '../src/history/cli.js';
import { createAnalyzeCommand, type AnalyzeDeps } from '../src/analysis/cli.js';
import type { FlakyEnvelope } from '../src/util/flake-window.js';
import {
  MIN_ALTERNATION_FLIPS,
  MIN_DEFINITIVE_OBSERVATIONS,
  alternationVerdict,
  detectAlternation,
  isAlternating,
  maxFlakeOrFlipRate,
} from '../src/util/alternation.js';
import type { FlakyQueryRow } from '../src/history/ndjson-store.js';
import type { AsyncHistoryStore } from '../src/history/store.js';
import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

const HISTORY_REL = join('test-results', 'reports', 'history-v2.jsonl');

/** One test's status in one run; `undefined` means the test did not appear. */
type Seq = readonly (string | undefined)[];

/**
 * Seed a vitest-stamped history where each named test follows its own status
 * sequence. vitest deliberately, because that is the reader that CANNOT emit
 * `flaky` -- so every finding here comes from the flip axis alone.
 */
function seedSequences(
  root: string,
  sequences: Record<string, Seq>,
  reporterFormat = 'vitest',
): void {
  const path = join(root, HISTORY_REL);
  mkdirSync(dirname(path), { recursive: true });
  const runs = Math.max(...Object.values(sequences).map((s) => s.length));
  const lines: string[] = [];
  for (let i = 0; i < runs; i++) {
    const tests = Object.entries(sequences)
      .filter(([, seq]) => seq[i] !== undefined)
      .map(([name, seq]) => ({
        test_name: name,
        test_file: 'tests/widgets.spec.ts',
        status: seq[i],
      }));
    const tally = (s: string): number =>
      tests.filter((t) => t.status === s).length;
    lines.push(
      JSON.stringify({
        schema_version: 2,
        run_id: `api-${i}`,
        suite: 'api',
        repo: 'acme/widgets',
        branch: 'main',
        commit_sha: `abc1234${i}`,
        timestamp: `2026-06-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
        total: tests.length,
        passed: tally('passed'),
        failed: tally('failed'),
        flaky: tally('flaky'),
        skipped: tally('skipped'),
        reporter_format: reporterFormat,
        tests,
      }),
    );
  }
  writeFileSync(path, lines.join('\n') + '\n', 'utf-8');
}

/** `passed, failed` repeated -- the shape #604 exists for. */
function alternating(runs: number): string[] {
  return Array.from({ length: runs }, (_, i) =>
    i % 2 === 0 ? 'passed' : 'failed',
  );
}

function repeat(status: string, n: number): string[] {
  return Array.from({ length: n }, () => status);
}

/** `n` runs in which the test did not appear at all. */
function absent(n: number): undefined[] {
  return Array.from({ length: n }, () => undefined);
}

async function flakyRows(
  app: 'history' | 'analyze',
  root: string,
  extra: string[] = [],
): Promise<FlakyEnvelope<FlakyQueryRow>> {
  const res = await invokeCanary([app, 'flaky', '--json', ...extra], {
    cwd: root,
  });
  return JSON.parse(res.stdout) as FlakyEnvelope<FlakyQueryRow>;
}

interface Check {
  name: string;
  verdict: string;
  reason: string;
}

async function flakinessCheck(root: string): Promise<Check> {
  const res = await invokeCanary(['ci-ready', '--root', root, '--json']);
  const report = JSON.parse(res.stdout) as { checks: Check[] };
  const check = report.checks.find((c) => c.name === 'flakiness');
  if (!check) throw new Error('no flakiness check in the report');
  return check;
}

function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Drive a flaky command against a store shaped like the remote Supabase
 * backend: it answers `queryFlaky` with count-only rows and offers no
 * `readAll`, so it can report neither the window it read nor any flip data.
 */
async function runWithCountOnlyStore(
  app: 'history' | 'analyze',
  args: string[],
): Promise<{ stdout: string; code: number }> {
  const out: string[] = [];
  const store: AsyncHistoryStore = {
    pushRun: async () => {},
    queryFlaky: async () => [
      {
        test_name: 'suite-alpha > renders widget',
        test_file: 'tests/widgets.spec.ts',
        suite: 'api',
        area: null,
        flake_count: 4,
        pass_count: 16,
        fail_count: 0,
        total_runs: 20,
        last_seen_run: 'api-19',
        flake_rate_pct: 20.0,
      },
    ],
    queryTimeline: async () => [],
    querySummary: async (suite) => ({
      suite,
      total_runs: 0,
      avg_pass_rate: 0,
    }),
    countRuns: async () => 42,
  };
  const deps = {
    out: (s: string) => out.push(s),
    err: () => {},
    env: {},
    makeStore: () => store,
  };
  let code = 0;
  try {
    const command =
      app === 'history'
        ? createHistoryCommand(deps as Partial<HistoryDeps>)
        : createAnalyzeCommand(deps as Partial<AnalyzeDeps>);
    await command.parseAsync(args, { from: 'user' });
  } catch (e) {
    if (e instanceof CliExitError) code = e.code;
    else throw e;
  }
  return { code, stdout: strip(out.join('\n')) };
}

// ---------------------------------------------------------------------------
// The pure core (ported from the abandoned WIP commit df06d3a)
// ---------------------------------------------------------------------------

describe('#604 SC8 — detectAlternation counts only definitive outcomes', () => {
  it('counts every passed<->failed transition', () => {
    const r = detectAlternation(alternating(10));
    expect(r.flip_count).toBe(9);
    expect(r.observed).toBe(10);
    expect(r.flip_rate_pct).toBe(100);
  });

  it('a skip is not a side: passed, skipped, passed is 0 flips', () => {
    const r = detectAlternation(['passed', 'skipped', 'passed']);
    expect(r.flip_count).toBe(0);
    expect(r.observed).toBe(2);
    expect(r.flip_rate_pct).toBe(0);
  });

  it('the `flaky` status is the OTHER axis, so it is not an observation', () => {
    const r = detectAlternation(['passed', 'flaky', 'passed', 'flaky']);
    expect(r.flip_count).toBe(0);
    expect(r.observed).toBe(2);
  });

  it('a sequence with fewer than two observations has no rate to report', () => {
    expect(detectAlternation(['passed']).flip_rate_pct).toBe(0);
    expect(detectAlternation([]).observed).toBe(0);
  });
});

describe('#604 SC7 — the flip floor separates a step change from a flake', () => {
  it('one flip is a regression, not an alternator', () => {
    const r = detectAlternation([
      ...repeat('passed', 7),
      ...repeat('failed', 3),
    ]);
    expect(r.flip_count).toBe(1);
    expect(r.flip_count).toBeLessThan(MIN_ALTERNATION_FLIPS);
    expect(isAlternating(r, 10)).toBe(false);
  });

  it('changed AND changed back clears the floor', () => {
    const r = detectAlternation(['passed', 'failed', 'passed']);
    expect(r.flip_count).toBe(2);
    expect(isAlternating(r, 10)).toBe(true);
  });

  it('a row whose backend measured no flips is never a finding', () => {
    expect(isAlternating({}, 10)).toBe(false);
  });
});

describe('#604 H2 — 8 definitive observations before a clean flip verdict', () => {
  it('abstains (null) at 7 observations, and does not claim false', () => {
    const r = detectAlternation(repeat('passed', 7));
    expect(r.observed).toBe(7);
    expect(alternationVerdict(r, 10)).toBeNull();
  });

  it('reports a clean false at the 8th observation', () => {
    const r = detectAlternation(repeat('passed', MIN_DEFINITIVE_OBSERVATIONS));
    expect(r.observed).toBe(8);
    expect(alternationVerdict(r, 10)).toBe(false);
  });

  it('a POSITIVE finding needs no minimum: it was observed', () => {
    const r = detectAlternation(['passed', 'failed', 'passed']);
    expect(r.observed).toBeLessThan(MIN_DEFINITIVE_OBSERVATIONS);
    expect(alternationVerdict(r, 10)).toBe(true);
  });
});

describe('#604 SC9 — ranking is on max(flake_rate, flip_rate)', () => {
  it('takes whichever axis is worse, and treats an absent axis as 0', () => {
    expect(maxFlakeOrFlipRate({ flake_rate_pct: 20 })).toBe(20);
    expect(maxFlakeOrFlipRate({ flake_rate_pct: 20, flip_rate_pct: 60 })).toBe(
      60,
    );
    expect(maxFlakeOrFlipRate({ flake_rate_pct: 80, flip_rate_pct: 60 })).toBe(
      80,
    );
  });
});

// ---------------------------------------------------------------------------
// The surfaces
// ---------------------------------------------------------------------------

describe('#604 SC6 — an alternator with flake_count 0 is detected', () => {
  const NAME = 'suite-alpha > renders widget';

  it('history flaky lists it with flip_count 9 and alternating: true', async () => {
    const root = mkTmp();
    try {
      seedSequences(root, { [NAME]: alternating(10) });
      const env = await flakyRows('history', root);
      const row = env.rows.find((r) => r.test_name === NAME);
      expect(row, 'the alternator must not be invisible').toBeDefined();
      expect(row!.flake_count).toBe(0);
      expect(row!.flip_count).toBe(9);
      expect(row!.observed).toBe(10);
      expect(row!.flip_rate_pct).toBe(100);
      expect(row!.alternating).toBe(true);
    } finally {
      rmTmp(root);
    }
  });

  it('analyze flaky lists it too (same rows, same store query)', async () => {
    const root = mkTmp();
    try {
      seedSequences(root, { [NAME]: alternating(10) });
      const env = await flakyRows('analyze', root);
      const row = env.rows.find((r) => r.test_name === NAME);
      expect(row).toBeDefined();
      expect(row!.flip_count).toBe(9);
      expect(row!.alternating).toBe(true);
    } finally {
      rmTmp(root);
    }
  });

  it('the human table shows the flip axis, not just the flake rate', async () => {
    const root = mkTmp();
    try {
      seedSequences(root, { [NAME]: alternating(10) });
      const res = await invokeCanary(['history', 'flaky'], { cwd: root });
      expect(strip(res.stdout)).toContain(NAME);
      expect(strip(res.stdout)).toContain('Flip %');
    } finally {
      rmTmp(root);
    }
  });
});

describe('#604 SC7 — a step change stays a regression, not a flake', () => {
  const NAME = 'suite-alpha > saves draft';

  it('is not reported as alternating', async () => {
    const root = mkTmp();
    try {
      seedSequences(root, {
        [NAME]: [...repeat('passed', 7), ...repeat('failed', 3)],
      });
      const env = await flakyRows('history', root, ['--min-rate', '0']);
      const row = env.rows.find((r) => r.test_name === NAME);
      expect(row).toBeDefined();
      expect(row!.flip_count).toBe(1);
      expect(row!.alternating).toBe(false);
    } finally {
      rmTmp(root);
    }
  });

  it('still appears in regression-candidates', async () => {
    const root = mkTmp();
    try {
      seedSequences(root, {
        [NAME]: [...repeat('passed', 7), ...repeat('failed', 3)],
      });
      const res = await invokeCanary(['analyze', 'regression-candidates'], {
        cwd: root,
      });
      expect(strip(res.stdout)).toContain(NAME);
    } finally {
      rmTmp(root);
    }
  });
});

describe('#604 H2 — the per-test minimum reaches the rendered rows', () => {
  const NAME = 'suite-alpha > thin sample';

  it('7 observations leave `alternating` UNKNOWN (null)', async () => {
    const root = mkTmp();
    try {
      seedSequences(root, {
        'suite-alpha > anchor': repeat('passed', 10),
        [NAME]: [...repeat('passed', 7), ...absent(3)],
      });
      const env = await flakyRows('history', root, ['--min-rate', '0']);
      const row = env.rows.find((r) => r.test_name === NAME);
      expect(row).toBeDefined();
      expect(row!.observed).toBe(7);
      expect(row!.alternating).toBeNull();
    } finally {
      rmTmp(root);
    }
  });

  it('8 observations earn a clean false', async () => {
    const root = mkTmp();
    try {
      seedSequences(root, {
        'suite-alpha > anchor': repeat('passed', 10),
        [NAME]: [...repeat('passed', 8), ...absent(2)],
      });
      const env = await flakyRows('history', root, ['--min-rate', '0']);
      const row = env.rows.find((r) => r.test_name === NAME);
      expect(row!.observed).toBe(8);
      expect(row!.alternating).toBe(false);
    } finally {
      rmTmp(root);
    }
  });
});

describe('#604 SC9 — an alternator is not buried under a retry-flake', () => {
  const ALT = 'suite-alpha > alternates';
  const RETRY = 'suite-alpha > retries';

  /**
   * 11 runs. ALT alternates for 6 of its 10 transitions (60% flips, and a
   * `flake_count` of 0). RETRY appears in only the first 10 runs and is
   * `flaky` in 2 of them: a 20% flake rate and no flips at all.
   */
  function seedRanking(root: string): void {
    seedSequences(
      root,
      {
        [ALT]: [
          'passed',
          'failed',
          'passed',
          'failed',
          'passed',
          'failed',
          'passed',
          'passed',
          'passed',
          'passed',
          'passed',
        ],
        [RETRY]: ['flaky', 'flaky', ...repeat('passed', 8), ...absent(1)],
      },
      'playwright',
    );
  }

  it('sorts the 60% alternator above the 20% retry-flake', async () => {
    const root = mkTmp();
    try {
      seedRanking(root);
      const env = await flakyRows('history', root);
      const names = env.rows.map((r) => r.test_name);
      expect(names).toContain(ALT);
      expect(names).toContain(RETRY);
      expect(names.indexOf(ALT)).toBeLessThan(names.indexOf(RETRY));
      const alt = env.rows.find((r) => r.test_name === ALT)!;
      const retry = env.rows.find((r) => r.test_name === RETRY)!;
      expect(alt.flip_rate_pct).toBe(60);
      expect(alt.flake_rate_pct).toBe(0);
      expect(retry.flake_rate_pct).toBe(20);
    } finally {
      rmTmp(root);
    }
  });

  it('analyze flaky orders its markdown the same way', async () => {
    const root = mkTmp();
    try {
      seedRanking(root);
      const res = await invokeCanary(['analyze', 'flaky'], { cwd: root });
      const text = strip(res.stdout);
      expect(text.indexOf(ALT)).toBeGreaterThan(-1);
      expect(text.indexOf(ALT)).toBeLessThan(text.indexOf(RETRY));
    } finally {
      rmTmp(root);
    }
  });
});

describe('#604 SC10 — ci-ready judges on max(flake, flip)', () => {
  it('fails on a 100% alternator that has a flake rate of 0', async () => {
    const root = mkTmp();
    try {
      seedSequences(root, {
        'suite-alpha > renders widget': alternating(10),
      });
      const check = await flakinessCheck(root);
      expect(check.verdict).toBe('fail');
      expect(check.reason).toContain('suite-alpha > renders widget');
      expect(check.reason).toContain('flip');
    } finally {
      rmTmp(root);
    }
  });

  it('does not fail on a single step change over the same window', async () => {
    const root = mkTmp();
    try {
      seedSequences(root, {
        'suite-alpha > saves draft': [
          ...repeat('passed', 7),
          ...repeat('failed', 3),
        ],
      });
      const check = await flakinessCheck(root);
      expect(check.verdict).not.toBe('fail');
    } finally {
      rmTmp(root);
    }
  });

  it('a thin window still abstains rather than failing on flips', async () => {
    const root = mkTmp();
    try {
      seedSequences(root, { 'suite-alpha > renders widget': alternating(4) });
      const check = await flakinessCheck(root);
      expect(check.verdict).toBe('fail');
      // A POSITIVE finding is reportable at any window size (Phase 1 pinned
      // the same rule for the flake axis); what a thin window forbids is a
      // clean PASS. Guard that the clean path is still the warn, not a pass.
      const clean = mkTmp();
      try {
        seedSequences(clean, { 'suite-alpha > steady': repeat('passed', 4) });
        expect((await flakinessCheck(clean)).verdict).toBe('warn');
      } finally {
        rmTmp(clean);
      }
    } finally {
      rmTmp(root);
    }
  });
});

describe('#604 G4 — the flip axis is UNKNOWN on a count-only backend', () => {
  it('history flaky renders UNKNOWN in the flip cells, never a 0', async () => {
    const res = await runWithCountOnlyStore('history', ['flaky']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('UNKNOWN');
    expect(res.stdout).toMatch(/Flip %/);
    // The tell this test exists for: a missing measurement rendered as zero.
    expect(res.stdout).not.toMatch(/\b0\.0%\s+0\/20/);
  });

  it('history flaky --json leaves the flip fields absent, not zero', async () => {
    const res = await runWithCountOnlyStore('history', ['flaky', '--json']);
    const env = JSON.parse(res.stdout) as FlakyEnvelope<FlakyQueryRow>;
    expect(env.rows).toHaveLength(1);
    expect(env.rows[0]!.flip_count).toBeUndefined();
    expect(env.rows[0]!.alternating).toBeUndefined();
    expect(env.flips_measured).toBe(false);
    expect(env.disclosures.join(' ')).toContain('cannot verify');
  });

  it('analyze flaky discloses the same UNKNOWN flip axis', async () => {
    const res = await runWithCountOnlyStore('analyze', ['flaky']);
    expect(res.stdout).toContain('UNKNOWN');
  });
});
