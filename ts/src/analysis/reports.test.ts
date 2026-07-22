import { describe, expect, it } from 'vitest';

import {
  buildAreaHealthReport,
  buildCommonFailuresReport,
  buildDigest,
  buildFlakyReport,
  buildRegressionCandidatesReport,
  buildSpikesReport,
  round1,
} from './reports.js';
import type { AreaHealthRow, FlakyRow, SpikeRow } from './rows.js';

function flakyRow(
  testName: string,
  suite: string,
  area: string,
  flakeRatePct: number,
  flakeCount = 3,
  totalRuns = 10,
): FlakyRow {
  return {
    test_name: testName,
    suite,
    area,
    flake_rate_pct: flakeRatePct,
    flake_count: flakeCount,
    total_runs: totalRuns,
  };
}

function runRow(
  suite: string,
  timestamp: string,
  passed: number,
  failed: number,
  flaky = 0,
  total?: number,
): SpikeRow {
  return {
    suite,
    timestamp,
    failed,
    flaky,
    total: total ?? passed + failed + flaky,
  };
}

/** Mirrors the Python TestBuildSpikesReport._runs helper. */
function runs(
  suite: string,
  earlyPassRate: number,
  recentPassRate: number,
  n = 10,
): SpikeRow[] {
  const mid = Math.floor(n / 2);
  const rows: SpikeRow[] = [];
  for (let i = 0; i < mid; i++) {
    const p = Math.trunc(100 * earlyPassRate);
    const day = String(i + 1).padStart(2, '0');
    rows.push(runRow(suite, `2026-06-${day}T00:00:00Z`, p, 100 - p, 0, 100));
  }
  for (let i = mid; i < n; i++) {
    const p = Math.trunc(100 * recentPassRate);
    const day = String(i + 1).padStart(2, '0');
    rows.push(runRow(suite, `2026-06-${day}T00:00:00Z`, p, 100 - p, 0, 100));
  }
  return rows;
}

function areaRows(
  area: string,
  suite: string,
  passRatesByWeek: number[],
): AreaHealthRow[] {
  return passRatesByWeek.map((rate, week) => ({
    area,
    suite,
    week: `2026-W${String(week + 1).padStart(2, '0')}`,
    pass_rate: rate,
  }));
}

describe('round1 (Python round-half-to-even parity)', () => {
  it('rounds to one decimal', () => {
    expect(round1(33.34)).toBe(33.3);
    expect(round1(33.36)).toBe(33.4);
  });
  it('breaks .5 ties to even like Python', () => {
    // Python: round(0.25, 1) == 0.2, round(0.35, 1) == 0.3 (float repr aside)
    expect(round1(0.25)).toBe(0.2);
    expect(round1(2.5 / 10)).toBe(0.2);
  });
});

describe('buildFlakyReport', () => {
  it('returns a no-issues message on empty rows', () => {
    expect(buildFlakyReport([], 30, 10.0)).toContain('No tests');
  });

  it('renders the table header', () => {
    const md = buildFlakyReport(
      [flakyRow('test A', 'api', 'members', 34.0)],
      30,
      10.0,
    );
    expect(md).toContain('Test');
    expect(md).toContain('Flake %');
  });

  it('renders the test name and one-decimal rate', () => {
    const md = buildFlakyReport(
      [flakyRow('test A', 'api', 'members', 34.0)],
      30,
      10.0,
    );
    expect(md).toContain('test A');
    expect(md).toContain('34.0%');
  });

  it('orders highest rate first', () => {
    const md = buildFlakyReport(
      [
        flakyRow('test A', 'api', 'members', 15.0),
        flakyRow('test B', 'api', 'auth', 40.0),
      ],
      30,
      10.0,
    );
    expect(md.indexOf('test B')).toBeLessThan(md.indexOf('test A'));
  });

  it('includes the window in the header and renders — for missing area', () => {
    const md = buildFlakyReport([flakyRow('t', 'api', '', 12.0)], 30, 10.0);
    expect(md).toContain('30');
    expect(md).toContain('| — |'.replace(' |', '')); // area rendered as em dash
  });

  it('honors the limit', () => {
    const rows = Array.from({ length: 25 }, (_, i) =>
      flakyRow(`t${i}`, 'api', 'a', i + 1),
    );
    const md = buildFlakyReport(rows, 30, 10.0, 20);
    expect(md.match(/\| t\d+ \|/g)?.length).toBe(20);
  });
});

describe('buildSpikesReport', () => {
  it('detects a spike', () => {
    const md = buildSpikesReport(runs('api', 0.98, 0.6), 20.0);
    expect(md).toContain('api');
    expect(md).toContain('%');
  });

  it('reports no spike when stable', () => {
    const md = buildSpikesReport(runs('api', 0.95, 0.94), 20.0);
    expect(md).toContain('No spikes');
  });

  it('returns a message on empty rows', () => {
    expect(buildSpikesReport([], 20.0)).toContain('No run data');
  });

  it('skips suites with fewer than four runs', () => {
    const few = runs('api', 0.9, 0.1, 3);
    expect(buildSpikesReport(few, 20.0)).toContain('No spikes');
  });
});

describe('buildAreaHealthReport', () => {
  it('renders area names', () => {
    const md = buildAreaHealthReport(
      [
        ...areaRows('members', 'api', [0.95, 0.9, 0.85, 0.8]),
        ...areaRows('auth', 'api', [0.99, 0.98, 0.97, 0.99]),
      ],
      4,
    );
    expect(md).toContain('members');
    expect(md).toContain('auth');
  });

  it('flags a degrading area with the down arrow', () => {
    const md = buildAreaHealthReport(
      areaRows('members', 'api', [0.95, 0.9, 0.85, 0.75]),
      4,
    );
    expect(md).toContain('members');
    expect(md).toContain('↓');
  });

  it('marks a stable area', () => {
    const md = buildAreaHealthReport(
      areaRows('auth', 'api', [0.99, 0.99, 0.99, 0.99]),
      4,
    );
    expect(md).toContain('→ stable');
  });

  it('returns a message on empty rows', () => {
    expect(buildAreaHealthReport([], 4)).toContain('No area health');
  });
});

describe('buildCommonFailuresReport', () => {
  const failureRow = (
    testName: string,
    suite: string,
    errorText: string,
    category = 'other',
  ) => ({
    test_name: testName,
    suite,
    failure_category: category,
    error_text: errorText,
  });

  it('groups matching errors across suites', () => {
    const md = buildCommonFailuresReport(
      [
        failureRow('test A', 'api', '401 Unauthorized — token expired'),
        failureRow('test B', 'e2e_ui', '401 Unauthorized — token expired'),
      ],
      2,
    );
    expect(md).toContain('401 Unauthorized');
  });

  it('excludes single-suite failures', () => {
    const md = buildCommonFailuresReport(
      [failureRow('test A', 'api', 'unique error only in api')],
      2,
    );
    expect(md).not.toContain('unique error only in api');
  });

  it('returns a message on empty rows', () => {
    expect(buildCommonFailuresReport([], 2)).toContain('No failure data');
  });
});

describe('buildRegressionCandidatesReport', () => {
  it('renders a regression test and truncated commit', () => {
    const md = buildRegressionCandidatesReport([
      {
        test_name: 'test A',
        suite: 'api',
        area: 'members',
        green_streak: 8,
        first_failure_commit: 'abc12345def',
      },
    ]);
    expect(md).toContain('test A');
    expect(md).toContain('abc12345');
    expect(md).not.toContain('abc12345def');
  });

  it('returns a message on empty rows', () => {
    expect(buildRegressionCandidatesReport([])).toContain('No regression');
  });
});

describe('buildDigest', () => {
  const empty = {
    flaky: [],
    spikes: [],
    areaHealth: [],
    commonFailures: [],
    regressionCandidates: [],
    window: 30,
    delta: 20.0,
    weeks: 4,
    minSuites: 2,
  };

  it('includes all section headings', () => {
    const digest = buildDigest(empty);
    expect(digest).toContain('Flaky');
    expect(digest).toContain('Spike');
    expect(digest).toContain('Area');
    expect(digest).toContain('Regression');
  });

  it('joins sections with a horizontal rule', () => {
    expect(buildDigest(empty)).toContain('\n---\n');
  });
});

describe('branch coverage — fallbacks and alternate row shapes', () => {
  it('flaky: missing suite falls back to empty string', () => {
    const md = buildFlakyReport(
      [{ test_name: 't', flake_rate_pct: 12.0, flake_count: 1, total_runs: 8 }],
      30,
      10.0,
    );
    expect(md).toContain('| t |  | — |'); // empty suite, em-dash area
  });

  it('spikes: rows with total=0 are excluded from the denominator and flaky defaults to 0', () => {
    const rows: SpikeRow[] = [
      // total=0 rows contribute failed but not to total → early rate 0%
      { suite: 'api', timestamp: '2026-06-01T00:00:00Z', failed: 5, total: 0 },
      { suite: 'api', timestamp: '2026-06-02T00:00:00Z', failed: 0, total: 0 },
      // recent rows push the rate up (no flaky key → defaults to 0)
      {
        suite: 'api',
        timestamp: '2026-06-03T00:00:00Z',
        failed: 80,
        total: 100,
      },
      {
        suite: 'api',
        timestamp: '2026-06-04T00:00:00Z',
        failed: 90,
        total: 100,
      },
    ];
    const md = buildSpikesReport(rows, 20.0);
    expect(md).toContain('api');
    expect(md).toContain('pp');
  });

  it('area: uses timestamp when week is absent and drops null pass_rate rows', () => {
    const rows: AreaHealthRow[] = [
      {
        area: 'members',
        suite: 'api',
        timestamp: '2026-06-01',
        pass_rate: 0.95,
      },
      {
        area: 'members',
        suite: 'api',
        timestamp: '2026-06-08',
        pass_rate: null,
      },
      {
        area: 'members',
        suite: 'api',
        timestamp: '2026-06-15',
        pass_rate: 0.8,
      },
    ];
    const md = buildAreaHealthReport(rows, 4);
    expect(md).toContain('members');
    expect(md).toContain('↓'); // 0.95 → 0.80 is a 15pp drop
  });

  it('common failures: null error_text is skipped and missing category defaults to other', () => {
    const md = buildCommonFailuresReport(
      [
        { test_name: 'a', suite: 'api', error_text: null },
        { test_name: 'b', suite: 'api', error_text: 'boom' },
        { test_name: 'c', suite: 'e2e', error_text: 'boom' },
      ],
      2,
    );
    expect(md).toContain('boom');
    expect(md).toContain('- **Category:** other');
  });

  it('regression: missing streak/commit/area/suite render placeholders', () => {
    const md = buildRegressionCandidatesReport([{ test_name: 't' }]);
    expect(md).toContain('| t |  | — | ? runs | ? |');
  });
});
