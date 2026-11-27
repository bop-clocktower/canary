/**
 * canary-ivy (#615) -- report assembly and rendering (spec D4, D9, D13, SC2,
 * SC3, SC9). Inputs are built in memory from the real module outputs' shapes.
 */
import { describe, expect, it } from 'vitest';

import { CAVEAT } from '../claude-code/canary-ivy/scripts/coverage.mjs';
import {
  assembleReport,
  renderJson,
} from '../claude-code/canary-ivy/scripts/report.mjs';
import {
  ABSTAINED_LINE,
  BANNER,
  MAX_ROWS,
  renderMarkdown,
} from '../claude-code/canary-ivy/scripts/render.mjs';

const at = {
  timestamp: '2026-01-05T00:00:00Z',
  commit_sha: 'c0ffee04',
  run_id: 'r4',
};

function fullRaw() {
  return {
    fixtures: {
      filesScanned: 3,
      setupBlocks: 4,
      unread: [
        {
          file: 'big/conftest.py',
          reason: 'longer than 20000 lines, not parsed',
        },
      ],
      groups: [
        {
          kind: 'pytest-fixture',
          body_lines: 3,
          first_line: 'conn = make_db()',
          locations: [
            { file: 'a/conftest.py', line: 4, name: 'db' },
            { file: 'b/conftest.py', line: 4, name: 'database' },
          ],
        },
      ],
    },
    coverage: {
      note: null,
      overlaps: {
        testsWithCoverage: 3,
        groups: [
          {
            tests: ['t::a', 't::b'],
            line_count: 5,
            shared_lines: [{ file: 'src/cart.py', ranges: '3-5,9' }],
            caveat: CAVEAT,
          },
        ],
      },
    },
    runtime: {
      dark: null,
      analysis: {
        denominator: { runs: 8, timed_tests: 2, series_long_enough: 2 },
        where_time_went: [
          { file: 'tests/dash.spec.ts', median_ms: 2400, share: 0.96 },
        ],
        creep: [
          {
            scope: 'test',
            file: 'tests/dash.spec.ts',
            test: 'loads the dashboard',
            before_median_ms: 802.5,
            after_median_ms: 2402.5,
            gap_ms: 1600,
            observations: 8,
            grew_at: at,
          },
          {
            scope: 'file',
            file: 'tests/dash.spec.ts',
            test: null,
            before_median_ms: 900,
            after_median_ms: 2500,
            gap_ms: 1600,
            observations: 8,
            grew_at: { timestamp: null, commit_sha: null, run_id: null },
          },
        ],
      },
    },
  };
}

const emptyRaw = () => ({
  fixtures: { filesScanned: 0, setupBlocks: 0, unread: [], groups: [] },
  coverage: null,
  runtime: { dark: 'no history store at x.jsonl', analysis: null },
});

describe('assembleReport', () => {
  it('assesses every section that has input', () => {
    const report = assembleReport(fullRaw());
    expect(report.abstained).toBe(false);
    expect(report.schema_version).toBe(1);
    expect(report.tool).toBe('canary-ivy');
    const { fixtures, coverage, runtime } = report.sections;
    expect([fixtures.status, coverage.status, runtime.status]).toEqual([
      'assessed',
      'assessed',
      'assessed',
    ]);
    expect(fixtures.not_read).toHaveLength(1);
    expect(fixtures.denominator.files_not_read).toBe(1);
    expect(runtime.thresholds).toEqual({
      min_observations: 6,
      min_ratio: 1.5,
      min_gap_ms: 100,
    });
  });

  it('SC2: every overlap group carries the caveat', () => {
    const report = assembleReport(fullRaw());
    for (const g of report.sections.coverage.groups)
      expect(g.caveat).toBe(CAVEAT);
    const markdown = renderMarkdown(report);
    expect(markdown.split(CAVEAT).length - 1).toBe(2); // section + group
  });

  it('abstains when no section has input, naming each reason', () => {
    const report = assembleReport(emptyRaw());
    expect(report.abstained).toBe(true);
    const markdown = renderMarkdown(report);
    expect(markdown).toContain(ABSTAINED_LINE);
    expect(markdown).toContain(
      'not assessed: no test file found under the given paths',
    );
    expect(markdown).toContain(
      'not assessed: no per-test coverage given \\(--coverage\\)',
    );
    expect(markdown).toContain('not assessed: no history store at x.jsonl');
    expect(markdown).not.toContain('no setup body repeats');
  });

  it('names why each section was not assessed when inputs are thin', () => {
    const raw = fullRaw();
    raw.fixtures = { ...emptyRaw().fixtures, unread: raw.fixtures.unread };
    raw.coverage = {
      note: null,
      overlaps: { testsWithCoverage: 1, groups: [] },
    };
    raw.runtime.analysis.denominator = {
      runs: 4,
      timed_tests: 0,
      series_long_enough: 0,
    };
    const report = assembleReport(raw);
    expect(report.sections.fixtures.reason).toBe(
      'no test file could be read (1 over the size limits)',
    );
    expect(report.sections.coverage.reason).toBe(
      'fewer than two tests carry coverage',
    );
    expect(report.sections.runtime.reason).toBe(
      'no test in 4 run(s) carries duration_ms',
    );
    expect(renderMarkdown(report)).toContain(
      'big/conftest.py: longer than 20000 lines',
    );
  });

  it('carries the coverage.py note when the file has no contexts', () => {
    const raw = fullRaw();
    raw.coverage = {
      note: 'no contexts here',
      overlaps: { testsWithCoverage: 0, groups: [] },
    };
    expect(assembleReport(raw).sections.coverage).toMatchObject({
      status: 'not_assessed',
      reason: 'no contexts here',
    });
  });
});

describe('renderMarkdown', () => {
  it('prints the banner, sections in a fixed order, and creep rows', () => {
    const markdown = renderMarkdown(assembleReport(fullRaw()));
    expect(markdown).toContain(`> ${BANNER}`);
    const order = [
      '## Duplicated fixtures',
      '## Overlapping coverage',
      '## Runtime creep',
    ];
    const at = order.map((h) => markdown.indexOf(h));
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(markdown).toContain('  - a/conftest.py:4 (db)');
    expect(markdown).toContain('Not read (1):');
    expect(markdown).toContain('| tests/dash.spec.ts | 2400 | 96% |');
    expect(markdown).toContain(
      'test tests/dash.spec.ts > loads the dashboard: 802.5 ms to 2402.5 ms (+1600 ms, 8 runs), from run r4 at c0ffee04 (2026-01-05T00:00:00Z)',
    );
    expect(markdown).toContain(
      'from an unrecorded run at an unrecorded commit (no timestamp)',
    );
  });

  it('says so when an assessed section found nothing', () => {
    const raw = fullRaw();
    raw.fixtures.groups = [];
    raw.coverage.overlaps.groups = [];
    raw.runtime.analysis.creep = [];
    const markdown = renderMarkdown(assembleReport(raw));
    expect(markdown).toContain('- no setup body repeats');
    expect(markdown).toContain('- no two tests share an identical line set');
    expect(markdown).toContain('- no series grew by the rules above');
  });

  it('caps long lists and points at --json', () => {
    const raw = fullRaw();
    const g = raw.fixtures.groups[0];
    raw.fixtures.groups = Array.from({ length: MAX_ROWS + 7 }, () => g);
    const report = assembleReport(raw);
    expect(report.sections.fixtures.groups).toHaveLength(MAX_ROWS + 7);
    expect(renderMarkdown(report)).toContain('- 7 more in --json');
  });

  it('SC3/SC9: no removability field, no score, no grade or p95', () => {
    const report = assembleReport(fullRaw());
    const json = renderJson(report);
    const markdown = renderMarkdown(report);
    expect(json).not.toMatch(/removable|safe_to_delete|redundant|score/i);
    for (const text of [json, markdown]) {
      expect(text).not.toMatch(/p95|\b(pass|passed|warn|fail|failed|ready)\b/i);
    }
  });
});
