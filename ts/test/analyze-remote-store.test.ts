/**
 * `canary analyze` against a remote history store (#711, ADR 0013 Decision 4).
 *
 * Before this change `analyze` accepted `--db-url` / `CANARY_HISTORY_DB_URL`,
 * printed `note: --db-url is ignored by analyze; it reads local NDJSON only.`,
 * and read the local file anyway. The note was the honest interim behaviour —
 * silently reading a different data source would be far worse — but a flag that
 * is accepted and ignored is the product-lies class one layer down, and it
 * existed only because `AnalysisEngine` held the synchronous store contract.
 *
 * The engine is async now, so the flag is honoured. That exposes the second
 * half of the problem, which these tests pin: four of the six analyze paths are
 * built on `readAll()`, a capability only the local NDJSON backend has. Against
 * a backend without it those sections are UNKNOWN, not clean — so each one says
 * so by name instead of rendering an empty report that reads as an all-clear.
 *
 * The stub below is deliberately shaped like `SupabaseHistoryStore`: the four
 * contract methods, and neither `readAll()` nor `countRuns()`.
 */

import { describe, expect, it } from 'vitest';

import { createAnalyzeCommand } from '../src/analysis/cli.js';
import type { AsyncHistoryStore } from '../src/history/async-store.js';
import type { FlakyQueryRow } from '../src/history/ndjson-store.js';

const DB_URL = 'https://proj.supabase.co';

function flakyRow(name: string): FlakyQueryRow {
  return {
    test_name: name,
    test_file: 'tests/test_pay.py',
    suite: 'checkout',
    area: null,
    flake_count: 3,
    pass_count: 7,
    fail_count: 0,
    total_runs: 10,
    last_seen_run: 'r10',
    flake_rate_pct: 30.0,
  };
}

/** A remote-shaped backend: contract methods only, no optional capabilities. */
function remoteStore(rows: FlakyQueryRow[] = []): AsyncHistoryStore {
  return {
    pushRun: async () => {},
    queryFlaky: async () => rows,
    queryTimeline: async () => [],
    querySummary: async (suite) => ({
      suite,
      total_runs: 12,
      avg_pass_rate: 95.0,
      runs: [],
    }),
  };
}

interface Captured {
  stdout: string;
  stderr: string;
}

/** Drive one analyze subcommand against an injected store. */
async function run(
  argv: string[],
  store: AsyncHistoryStore,
): Promise<Captured> {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const cmd = createAnalyzeCommand({
    out: (s) => outLines.push(s),
    err: (s) => errLines.push(s),
    makeStore: () => store,
  });
  await cmd.parseAsync(argv, { from: 'user' });
  return { stdout: outLines.join('\n'), stderr: errLines.join('\n') };
}

describe('the --db-url apology is gone (#711 acceptance signal)', () => {
  it('no analyze subcommand prints the "ignored" note any more', async () => {
    for (const sub of [
      'flaky',
      'spikes',
      'common-failures',
      'regression-candidates',
    ]) {
      const res = await run([sub, '--db-url', DB_URL], remoteStore());
      expect(res.stderr).not.toContain('is ignored by analyze');
      expect(res.stdout).not.toContain('is ignored by analyze');
    }
  });

  it('the --db-url help no longer says analyze reads local NDJSON', () => {
    const cmd = createAnalyzeCommand({ out: () => {}, err: () => {} });
    const flaky = cmd.commands.find((c) => c.name() === 'flaky');
    const help = flaky!.helpInformation().replace(/\s+/g, ' ');
    expect(help).not.toContain('analyze reads local NDJSON');
  });
});

describe('sections that ride the contract still work remotely', () => {
  it('flaky renders real remote rows', async () => {
    const res = await run(
      ['flaky', '--db-url', DB_URL],
      remoteStore([flakyRow('test_pay')]),
    );
    expect(res.stdout).toContain('test_pay');
    expect(res.stdout).not.toContain('cannot verify');
  });

  it('flaky --json emits the rows, keeping stdout machine-clean', async () => {
    const res = await run(
      ['flaky', '--db-url', DB_URL, '--json'],
      remoteStore([flakyRow('test_pay')]),
    );
    const rows = JSON.parse(res.stdout) as { test_name: string }[];
    expect(rows.map((r) => r.test_name)).toEqual(['test_pay']);
  });
});

describe('sections that need raw records abstain BY NAME, never silently', () => {
  const cases: Array<[string, string]> = [
    ['spikes', 'failure spikes'],
    ['common-failures', 'common failures'],
    ['regression-candidates', 'regression candidates'],
  ];

  for (const [sub, section] of cases) {
    it(`${sub} says it cannot verify "${section}"`, async () => {
      const res = await run([sub, '--db-url', DB_URL], remoteStore());
      const all = `${res.stdout}\n${res.stderr}`;
      expect(all).toContain('cannot verify');
      expect(all).toContain(section);
      // The whole point: it must NOT look like a measured clean result.
      expect(res.stdout).not.toMatch(/No .*(found|detected)/i);
    });

    it(`${sub} --json keeps stdout parseable and puts the notice on stderr`, async () => {
      const res = await run([sub, '--db-url', DB_URL, '--json'], remoteStore());
      expect(() => JSON.parse(res.stdout)).not.toThrow();
      expect(res.stderr).toContain('cannot verify');
    });
  }

  it('digest names every degraded section rather than reporting zeros', async () => {
    const res = await run(['digest', '--db-url', DB_URL], remoteStore());
    const all = `${res.stdout}\n${res.stderr}`;
    expect(all).toContain('cannot verify');
    expect(all).toContain('failure spikes');
    expect(all).toContain('common failures');
    expect(all).toContain('regression candidates');
  });
});

describe('an absent denominator is UNKNOWN, not zero (ADR 0013 Decision 3)', () => {
  it('does not abstain-on-empty when the backend cannot count runs', async () => {
    // The #508 guard keys off countRuns(). The remote backend has none, and
    // treating "cannot count" as "counted zero" would abstain on every remote
    // query — muting the doctrine exactly the way the katana lesson warns.
    const res = await run(
      ['flaky', '--db-url', DB_URL],
      remoteStore([flakyRow('test_pay')]),
    );
    expect(res.stdout).toContain('test_pay');
    expect(`${res.stdout}\n${res.stderr}`).not.toContain(
      'No run history to analyze',
    );
  });
});
