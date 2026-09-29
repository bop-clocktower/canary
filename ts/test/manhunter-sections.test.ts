/**
 * canary-manhunter (#611): one builder per evidence source.
 *
 * Every builder is held to the same rule: it is FED only when its source was
 * read AND has a non-zero denominator. Missing, malformed, self-abstained and
 * zero-denominator sources are DARK with a reason a reader can act on. The
 * fixtures are synthetic.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { historySection } from '../src/analysis/manhunter/history.js';
import { guardianSections } from '../src/analysis/manhunter/guardian.js';
import { readinessSection } from '../src/analysis/manhunter/readiness.js';
import { ledgerSection } from '../src/analysis/manhunter/ledger.js';
import { sweepSection } from '../src/analysis/manhunter/sweep.js';
import { escapesSection } from '../src/analysis/manhunter/escapes.js';
import { mkTmp, rmTmp } from './canary-cli-testkit.js';

let tmp: string;
beforeEach(() => {
  tmp = mkTmp();
});
afterEach(() => {
  rmTmp(tmp);
});

function write(rel: string, body: unknown): string {
  const path = join(tmp, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(
    path,
    typeof body === 'string' ? body : JSON.stringify(body, null, 2),
  );
  return path;
}

interface RunSpec {
  suite: string;
  failed?: number;
  statuses: Record<string, string>;
}

function historyFile(runs: RunSpec[]): string {
  const lines = runs.map((r, i) => {
    const tests = Object.entries(r.statuses).map(([name, status]) => ({
      test_name: name,
      test_file: `tests/${name}.spec.ts`,
      status,
    }));
    const failed = tests.filter((t) => t.status === 'failed').length;
    return JSON.stringify({
      schema_version: 3,
      run_id: `${r.suite}-${i}`,
      suite: r.suite,
      branch: 'main',
      commit_sha: `c0ffee${i}`,
      timestamp: `2026-09-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
      total: tests.length,
      passed: tests.filter((t) => t.status === 'passed').length,
      failed,
      flaky: tests.filter((t) => t.status === 'flaky').length,
      skipped: 0,
      tests,
    });
  });
  return write('history.jsonl', lines.join('\n') + '\n');
}

describe('run-history section', () => {
  it('is dark when the store file does not exist', () => {
    const s = historySection(join(tmp, 'missing.jsonl'), 30);
    expect(s.status).toBe('dark');
    expect(s.reason).toContain('no run-history store');
  });

  it('is dark when the store holds zero runs (an empty file is not a clean history)', () => {
    const s = historySection(write('history.jsonl', ''), 30);
    expect(s.status).toBe('dark');
    expect(s.reason).toContain('0 runs');
  });

  it('is dark, not empty, when the store is corrupt', () => {
    const s = historySection(write('history.jsonl', '{broken\n'), 30);
    expect(s.status).toBe('dark');
    expect(s.reason).toContain('could not be read');
  });

  it('is dark when every stored run executed zero tests', () => {
    const s = historySection(historyFile([{ suite: 'api', statuses: {} }]), 30);
    expect(s.status).toBe('dark');
    expect(s.reason).toContain('none executed a test');
  });

  it('is fed with a run denominator, and flags a failing latest run and a flaky test', () => {
    const path = historyFile([
      { suite: 'api', statuses: { a: 'passed', b: 'flaky' } },
      { suite: 'api', statuses: { a: 'passed', b: 'passed' } },
      { suite: 'api', statuses: { a: 'failed', b: 'passed' } },
      { suite: 'web', statuses: { c: 'passed' } },
    ]);
    const s = historySection(path, 30);
    expect(s.status).toBe('fed');
    expect(s.denominator).toBe('4 runs across 2 suites');
    expect(s.sources[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(s.eyes).toContain(
      'suite api: latest run api-2 has 1 failed of 2 tests',
    );
    expect(s.eyes.some((e) => e.startsWith('flaky: b (api)'))).toBe(true);
    expect(s.eyes.some((e) => e.includes('suite web'))).toBe(false);
  });
});

function guardianRecord(over: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: '1.3',
    source: 'canary-pr-guardian',
    ref: 'pr-12',
    gate: 'advisory',
    exitCode: 0,
    checked: 40,
    abstained: false,
    tier: 0,
    degradedNotice: null,
    coverage: { status: 'verified', unitsTotal: 40, unitsMatched: 40 },
    skipped: [],
    provenance: null,
    summary: {
      total: 3,
      unaddressed: 2,
      suppressed: 1,
      byFidelity: { 'coverage-verified': 2, heuristic: 1 },
    },
    findings: [
      {
        path: 'src/pay.ts',
        unit: 'charge',
        severity: 'high',
        fidelity: 'coverage-verified',
        evidence: 'lines 10-14 uncovered',
        suppressed: false,
      },
      {
        path: 'src/pay.ts',
        unit: 'refund',
        severity: 'medium',
        fidelity: 'heuristic',
        evidence: 'no test names refund',
        suppressed: false,
      },
      {
        path: 'src/util.ts',
        unit: 'fmt',
        severity: 'low',
        fidelity: 'coverage-verified',
        evidence: 'uncovered',
        suppressed: true,
      },
    ],
    analyzedAt: '2026-09-01T00:00:00+00:00',
    ...over,
  };
}

describe('guardian sections (coverage tiers + findings)', () => {
  const dir = () => join(tmp, '.harness', 'analyses');

  it('are both dark when there is no analyses directory', () => {
    const [tiers, findings] = guardianSections(dir());
    expect(tiers.status).toBe('dark');
    expect(findings.status).toBe('dark');
    expect(tiers.reason).toContain('no guardian analysis records');
  });

  it('are dark when every record abstained or checked nothing', () => {
    write(
      '.harness/analyses/canary-pr-guardian-pr-1.json',
      guardianRecord({ abstained: true, checked: 0 }),
    );
    write(
      '.harness/analyses/canary-pr-guardian-pr-2.json',
      guardianRecord({ checked: 0 }),
    );
    const [tiers, findings] = guardianSections(dir());
    expect(tiers.status).toBe('dark');
    expect(findings.status).toBe('dark');
    expect(tiers.reason).toContain('judged nothing');
  });

  it('ignore files that are not guardian records and name unreadable ones', () => {
    write('.harness/analyses/other-tool.json', { hello: 1 });
    write('.harness/analyses/canary-pr-guardian-pr-3.json', '{nope');
    write('.harness/analyses/canary-pr-guardian-pr-4.json', guardianRecord());
    const [tiers] = guardianSections(dir());
    expect(tiers.status).toBe('fed');
    expect(tiers.sources.map((s) => s.path.split('/').pop())).toEqual([
      'canary-pr-guardian-pr-3.json',
      'canary-pr-guardian-pr-4.json',
    ]);
    expect(tiers.facts.join('\n')).toContain(
      '1 record(s) unreadable or malformed and not counted',
    );
  });

  it('refuse a record whose findings are not an array instead of reading it as clean', () => {
    write(
      '.harness/analyses/canary-pr-guardian-pr-7.json',
      guardianRecord({ findings: {} }),
    );
    const [tiers, findings] = guardianSections(dir());
    expect(tiers.status).toBe('dark');
    expect(findings.status).toBe('dark');
    expect(findings.reason).toContain('none readable as a guardian record');
  });

  it('refuse a record whose findings disagree with its own summary, or that is not a guardian record', () => {
    write(
      '.harness/analyses/canary-pr-guardian-pr-8.json',
      guardianRecord({ findings: [] }),
    );
    write(
      '.harness/analyses/canary-pr-guardian-pr-9.json',
      guardianRecord({ source: 'something-else' }),
    );
    write('.harness/analyses/canary-pr-guardian-pr-10.json', guardianRecord());
    const [, findings] = guardianSections(dir());
    expect(findings.status).toBe('fed');
    expect(findings.denominator).toBe('1 record, 40 units checked');
    expect(findings.facts).toContain(
      '2 record(s) unreadable or malformed and not counted',
    );
  });

  it('state abstained records rather than silently dropping them', () => {
    write(
      '.harness/analyses/canary-pr-guardian-pr-11.json',
      guardianRecord({ abstained: true }),
    );
    write('.harness/analyses/canary-pr-guardian-pr-12.json', guardianRecord());
    const [tiers] = guardianSections(dir());
    expect(tiers.facts).toContain(
      '1 record(s) abstained or checked 0 units and not counted',
    );
  });

  it('report the fidelity mix and flag coverage that was not verified', () => {
    write('.harness/analyses/canary-pr-guardian-pr-5.json', guardianRecord());
    write(
      '.harness/analyses/canary-pr-guardian-pr-6.json',
      guardianRecord({
        ref: 'pr-6',
        coverage: { status: 'partial', unitsTotal: 10, unitsMatched: 4 },
      }),
    );
    const [tiers, findings] = guardianSections(dir());
    expect(tiers.status).toBe('fed');
    expect(tiers.denominator).toBe('2 records, 80 units checked');
    expect(tiers.facts).toContain(
      'coverage-verified: 4, graph-verified: 0, heuristic: 2 (of 6 findings)',
    );
    expect(tiers.eyes).toContain(
      'pr-6: coverage input partial, so part of that diff was judged below the coverage tier',
    );
    expect(tiers.eyes).toContain(
      '2 of 6 findings rest on heuristic evidence only',
    );
    expect(findings.status).toBe('fed');
    expect(findings.facts).toContain('6 findings: 4 unaddressed, 2 suppressed');
    expect(findings.eyes).toContain(
      'pr-12: src/pay.ts charge (high, coverage-verified): lines 10-14 uncovered',
    );
    expect(findings.eyes.some((e) => e.includes('src/util.ts'))).toBe(false);
  });
});

describe('ci-readiness section', () => {
  const paths = () => ({
    historyPath: join(tmp, 'history.jsonl'),
    inventoryPath: join(tmp, '.canary', 'test-inventory.json'),
    criticalAreasPath: join(tmp, '.canary', 'critical-areas.json'),
  });

  it('is dark when ci-ready itself abstains (no inputs at all)', () => {
    const s = readinessSection(paths());
    expect(s.status).toBe('dark');
    expect(s.reason).toContain('ci-ready abstained');
  });

  it('is dark, not absent, when the store is corrupt (ci-ready would throw)', () => {
    writeFileSync(paths().historyPath, '{broken\n');
    const s = readinessSection(paths());
    expect(s.status).toBe('dark');
    expect(s.reason).toContain('ci-ready cannot read');
  });

  it('is fed once any check scores, and flags the incomplete verdict', () => {
    historyFile([
      { suite: 'api', statuses: { a: 'passed' } },
      { suite: 'api', statuses: { a: 'passed' } },
    ]);
    const s = readinessSection(paths());
    expect(s.status).toBe('fed');
    expect(s.denominator).toMatch(/^\d of 5 checks scored$/);
    expect(s.eyes.some((e) => e.startsWith('ci-ready is incomplete'))).toBe(
      true,
    );
  });
});

describe('quarantine section', () => {
  const now = '2026-09-28T00:00:00Z';

  it('is dark when katana has never written a ledger', () => {
    const s = ledgerSection(join(tmp, '.canary', 'quarantine.json'), now);
    expect(s.status).toBe('dark');
    expect(s.reason).toContain('cannot be told apart');
  });

  it('is dark when the ledger has no entries array', () => {
    const s = ledgerSection(write('q.json', { schema_version: 2 }), now);
    expect(s.status).toBe('dark');
    expect(s.reason).toContain('not a katana v2 ledger');
  });

  it('is fed by an empty v2 ledger, which katana writes on every scan', () => {
    const s = ledgerSection(
      write('q.json', { schema_version: 2, entries: [] }),
      now,
    );
    expect(s.status).toBe('fed');
    expect(s.facts).toEqual([
      'katana has recorded no deleted or skipped tests',
    ]);
  });

  it('is fed and flags untracked defects, expired rows and causeless removals', () => {
    const row = (over: Record<string, string>) => ({
      test: 't',
      file: 'tests/t.py',
      kind: 'skipped',
      marker: 'skip',
      commit: 'c',
      author: 'Ada',
      date: '2026-09-01',
      reason: 'r',
      cause: 'flaky',
      issue: '#9',
      expiry: '',
      ...over,
    });
    const s = ledgerSection(
      write('q.json', {
        schema_version: 2,
        entries: [
          row({ test: 'ok_row' }),
          row({ test: 'untracked', cause: 'product-defect', issue: '' }),
          row({ test: 'stale', expiry: '2026-09-01' }),
          row({ test: 'gone', kind: 'removed', cause: '' }),
        ],
      }),
      now,
    );
    expect(s.status).toBe('fed');
    expect(s.denominator).toBe('4 ledger rows');
    expect(s.eyes).toEqual([
      'untracked (tests/t.py): out as product-defect with no linked issue',
      'stale (tests/t.py): quarantine expired 2026-09-01',
      'gone (tests/t.py): removed with no stated cause',
    ]);
  });
});

describe('sweep section', () => {
  it('is dark when no sweep report was given', () => {
    const s = sweepSection(null);
    expect(s.status).toBe('dark');
    expect(s.reason).toContain('--sweep');
  });

  it('is dark when the sweep report abstained, carrying its own reason', () => {
    const s = sweepSection(
      write('a11y.json', {
        version: 1,
        summary: {
          pages: 0,
          rule_evaluations: 0,
          abstained: true,
          abstention_reason: 'no axe result document was read',
        },
        findings: [],
      }),
    );
    expect(s.status).toBe('dark');
    expect(s.reason).toContain('no axe result document was read');
  });

  it('refuses a report whose findings are not an array instead of reading it as clean', () => {
    const s = sweepSection(
      write('a11y.json', {
        version: 1,
        summary: { pages: 3, rule_evaluations: 50, findings: 4 },
        findings: null,
      }),
    );
    expect(s.status).toBe('dark');
    expect(s.reason).toContain('disagrees with summary.findings');
  });

  it('refuses a report that is not canary-sweep v1', () => {
    const s = sweepSection(
      write('a11y.json', {
        summary: { pages: 3, rule_evaluations: 50, findings: 0 },
        findings: [],
      }),
    );
    expect(s.status).toBe('dark');
    expect(s.reason).toContain('not canary-sweep v1');
  });

  it('is fed and flags serious findings and unattributed nodes', () => {
    const s = sweepSection(
      write('a11y.json', {
        version: 1,
        summary: {
          pages: 3,
          rule_evaluations: 120,
          violation_nodes: 9,
          components: 2,
          unattributed_nodes: 2,
          findings: 3,
          abstained: false,
          abstention_reason: null,
        },
        findings: [
          {
            component: 'site-header',
            rule: 'color-contrast',
            impact: 'serious',
            occurrences: 5,
          },
          {
            component: null,
            rule: 'label',
            impact: 'critical',
            occurrences: 2,
          },
          {
            component: 'footer',
            rule: 'region',
            impact: 'moderate',
            occurrences: 2,
          },
        ],
      }),
    );
    expect(s.status).toBe('fed');
    expect(s.denominator).toBe('3 pages, 120 rule evaluations');
    expect(s.eyes).toEqual([
      'site-header: color-contrast (serious, 5 occurrences)',
      '(unattributed): label (critical, 2 occurrences)',
      '2 violating nodes could not be attributed to a component',
    ]);
  });
});

describe('escapes section', () => {
  it('is dark when no escape log exists, naming why canary cannot fill it', () => {
    const s = escapesSection(join(tmp, '.canary', 'escapes.json'));
    expect(s.status).toBe('dark');
    expect(s.reason).toContain('canary holds no incident data');
  });

  it('is dark when the log has no tracked_since, even with an empty list', () => {
    const s = escapesSection(
      write('e.json', { schema_version: 1, escapes: [] }),
    );
    expect(s.status).toBe('dark');
    expect(s.reason).toContain('tracked_since');
  });

  it('is dark when tracked_since is not a date', () => {
    const s = escapesSection(
      write('e.json', { schema_version: 1, tracked_since: 'x', escapes: [] }),
    );
    expect(s.status).toBe('dark');
  });

  it('is fed by an empty list that states its tracking window', () => {
    const s = escapesSection(
      write('e.json', {
        schema_version: 1,
        tracked_since: '2026-07-01',
        escapes: [],
      }),
    );
    expect(s.status).toBe('fed');
    expect(s.denominator).toBe('tracked since 2026-07-01');
    expect(s.facts).toContain('0 escapes recorded since 2026-07-01');
    expect(s.eyes).toEqual([]);
  });

  it('lists each recorded escape as worth your eyes', () => {
    const s = escapesSection(
      write('e.json', {
        schema_version: 1,
        tracked_since: '2026-07-01',
        escapes: [
          {
            id: 'ESC-1',
            summary: 'totals rounded wrong',
            found_at: '2026-08-02',
          },
        ],
      }),
    );
    expect(s.eyes).toEqual(['ESC-1: totals rounded wrong (found 2026-08-02)']);
  });
});
