/**
 * canary-batgirl's three count dimensions (#619): unexplained switch-offs
 * (katana ledger), vacuous tests (cassandra report) and red mainline commits
 * (run-history store).
 *
 * They are counts, not shares, ON PURPOSE (spec D4): a share over ledger rows,
 * tests checked, or commits is diluted by adding more caused rows, more
 * assertion-free tests, or more green commits. Each dilution case below pins
 * that the count does not move.
 */

import { describe, expect, it } from 'vitest';

import { LIMITS } from '../claude-code/canary-batgirl/scripts/read.mjs';
import {
  unexplainedSwitchOffs,
  vacuousTests,
} from '../claude-code/canary-batgirl/scripts/suite.mjs';
import { redMainlineCommits } from '../claude-code/canary-batgirl/scripts/mainline.mjs';

const OPTS = { limits: LIMITS, branch: 'main' };

describe('unexplained-switch-offs', () => {
  const row = (cause: string, issue = '') => ({
    test: 't',
    file: 'f',
    kind: 'skipped',
    author: 'Synthetic Author Zed',
    cause,
    issue,
  });

  it('counts rows with no cause, an unrecognised cause, or a missing required issue', () => {
    const r = unexplainedSwitchOffs(
      {
        schema_version: 2,
        entries: [
          row(''),
          row('gremlins'),
          row('product-defect'),
          row('product-defect', '#12'),
          row('flaky'),
          row('obsolete'),
        ],
      },
      OPTS,
    );
    expect(r.value).toBe(3);
    expect(r.detail).toEqual({
      rows: 6,
      no_cause: 1,
      unrecognised_cause: 1,
      missing_issue: 1,
      causes: {
        flaky: 1,
        'product-defect': 2,
        'blocked-data': 0,
        'pending-feature': 0,
        obsolete: 1,
        'env-gated': 0,
      },
    });
    expect(r.basis).toBe(
      '3 of 6 switched-off tests have no usable cause: 1 no cause, 1 unrecognised cause, 1 without the issue its cause requires',
    );
  });

  it('does not move when the ledger is padded with caused rows', () => {
    const base = [row(''), row('flaky')];
    const padded = [...base, ...Array.from({ length: 50 }, () => row('flaky'))];
    const a = unexplainedSwitchOffs({ entries: base }, OPTS);
    const b = unexplainedSwitchOffs({ entries: padded }, OPTS);
    expect(b.value).toBe(a.value);
  });

  it('never reads or echoes the author', () => {
    const r = unexplainedSwitchOffs({ entries: [row('')] }, OPTS);
    expect(JSON.stringify(r)).not.toContain('Synthetic Author Zed');
    expect(JSON.stringify(r)).not.toContain('author');
  });

  it('is not assessed for an empty ledger, a non-object, or a missing entries array', () => {
    expect(unexplainedSwitchOffs({ entries: [] }, OPTS).reason).toMatch(
      /0 rows/,
    );
    expect(unexplainedSwitchOffs([], OPTS).reason).toMatch(/not an object/);
    expect(unexplainedSwitchOffs({}, OPTS).reason).toMatch(/entries array/);
  });

  it('counts a non-object row as having no usable cause', () => {
    const r = unexplainedSwitchOffs({ entries: [7] }, OPTS);
    expect(r.value).toBe(1);
    expect(r.detail.no_cause).toBe(1);
  });

  it('does not read a ledger over the entry limit', () => {
    const opts = { ...OPTS, limits: { ...LIMITS, entries: 1 } };
    expect(
      unexplainedSwitchOffs({ entries: [row(''), row('')] }, opts).reason,
    ).toBe('not read: 2 entries is over the 1-entry limit');
  });
});

describe('vacuous-tests', () => {
  const finding = (file: string, snippet: string, rule = 'VAC-001') => ({
    file,
    line: 1,
    rule_id: rule,
    snippet,
  });
  const report = (
    findings: unknown[],
    testsChecked: number,
    abstained = false,
  ) => ({
    schema_version: 1,
    findings,
    summary: { tests_checked: testsChecked, abstained },
  });

  it('counts distinct tests with a finding', () => {
    const r = vacuousTests(
      report(
        [
          finding('a.test.ts', 'one'),
          finding('a.test.ts', 'one', 'VAC-003'),
          finding('a.test.ts', 'two'),
          finding('b.test.ts', 'one'),
        ],
        40,
      ),
      OPTS,
    );
    expect(r.value).toBe(3);
    expect(r.basis).toBe('3 vacuous tests among 40 tests checked');
    expect(r.detail).toEqual({
      tests_checked: 40,
      findings: 4,
      vacuous_tests: 3,
    });
  });

  it('does not move when assertion-free tests raise tests_checked', () => {
    const f = [finding('a.test.ts', 'one')];
    expect(vacuousTests(report(f, 10_000), OPTS).value).toBe(
      vacuousTests(report(f, 10), OPTS).value,
    );
  });

  it('is not assessed when cassandra abstained or checked no test', () => {
    expect(vacuousTests(report([], 0), OPTS).reason).toMatch(/0 tests/);
    expect(vacuousTests(report([], 5, true), OPTS).reason).toMatch(/abstained/);
  });

  it('is not assessed for a report that is not cassandra --json', () => {
    expect(vacuousTests({ findings: [] }, OPTS).reason).toMatch(
      /not a canary-cassandra --json report/,
    );
    expect(vacuousTests(null, OPTS).reason).toMatch(/not a canary-cassandra/);
  });

  it('does not read a report over the entry limit', () => {
    const opts = { ...OPTS, limits: { ...LIMITS, entries: 1 } };
    const r = vacuousTests(
      report([finding('a', 'x'), finding('b', 'y')], 5),
      opts,
    );
    expect(r.reason).toBe('not read: 2 entries is over the 1-entry limit');
  });
});

describe('red-mainline-commits', () => {
  const run = (sha: string, failed: number, branch = 'main', extra = {}) =>
    JSON.stringify({
      schema_version: 3,
      run_id: `r-${sha}`,
      branch,
      commit_sha: sha,
      total: 10,
      passed: 10 - failed,
      failed,
      flaky: 0,
      skipped: 0,
      commit_message: 'Synthetic Author Zed fixed it',
      ...extra,
    });

  it('counts distinct commits on the branch with any failing run', () => {
    const text = [
      run('a1', 0),
      run('b2', 2),
      run('b2', 0),
      run('c3', 0),
      run('c3', 1),
      run('d4', 5, 'feature'),
      '',
    ].join('\n');
    const r = redMainlineCommits(text, OPTS);
    expect(r.value).toBe(2);
    expect(r.basis).toBe(
      '2 of 3 commits on main had a run with a failing test',
    );
    expect(r.detail).toEqual({
      runs_read: 6,
      runs_on_branch: 5,
      commits: 3,
      red_commits: 2,
    });
  });

  it('does not move when green commits are added', () => {
    const base = [run('a1', 0), run('b2', 1)];
    const padded = [
      ...base,
      ...Array.from({ length: 40 }, (_, i) => run(`g${i}`, 0)),
    ];
    expect(redMainlineCommits(padded.join('\n'), OPTS).value).toBe(
      redMainlineCommits(base.join('\n'), OPTS).value,
    );
  });

  it('honours --branch', () => {
    const text = [run('a1', 1, 'trunk'), run('b2', 1)].join('\r\n');
    const r = redMainlineCommits(text, { ...OPTS, branch: 'trunk' });
    expect(r.value).toBe(1);
  });

  it('ignores runs without a usable commit sha or failed count', () => {
    const text = [
      run('a1', 1),
      run('', 1),
      run('x', 0, 'main', { failed: 'lots' }),
    ].join('\n');
    const r = redMainlineCommits(text, OPTS);
    expect(r.detail).toMatchObject({ runs_on_branch: 3, commits: 1 });
  });

  it('is not assessed when no run is on the branch', () => {
    expect(redMainlineCommits(run('a', 1, 'dev'), OPTS).reason).toBe(
      '1 run read, none on branch main',
    );
  });

  it('is not assessed, naming the line, for a malformed record', () => {
    const text = [run('a1', 0), '{oops'].join('\n');
    expect(redMainlineCommits(text, OPTS).reason).toMatch(
      /^history line 2 is not valid JSON/,
    );
    expect(
      redMainlineCommits(JSON.stringify({ schema_version: 9 }), OPTS).reason,
    ).toBe('history line 1: unsupported schema_version 9');
    expect(redMainlineCommits('[1]', OPTS).reason).toBe(
      'history line 1: not an object',
    );
  });

  it('does not read a store over the line limit', () => {
    const opts = { ...OPTS, limits: { ...LIMITS, lines: 2 } };
    const text = [run('a', 0), run('b', 0), run('c', 0)].join('\n');
    expect(redMainlineCommits(text, opts).reason).toBe(
      'not read: 3 lines is over the 2-line limit',
    );
  });

  it('never echoes a commit message', () => {
    const r = redMainlineCommits(run('a1', 1), OPTS);
    expect(JSON.stringify(r)).not.toContain('Synthetic Author Zed');
  });
});
