/**
 * Unit suite for the canary-screech skill runtime (#591).
 *
 * canary-screech is the CROSS-RUN member of the failure-surfacing family:
 * canary-fail-fast aborts inside one run, canary-test-reporter summarises one
 * run, and neither of them can tell you the default branch went red — that
 * fact only exists in the sequence of runs, which is what this skill reads.
 *
 * The signal source is the run-history store (`history-v2.jsonl`, one
 * `RunRecord` per line, see `ts/src/history/record.ts`): no network, no
 * credentials, no write access. The skill emits a markdown one-pager plus a
 * `::error` annotation and nothing else.
 *
 * Two failure shapes get explicit tests because both have bitten this repo:
 *
 *  - a zero denominator reported as a pass. An empty store, or a store with no
 *    rows for the requested branch, is an ABSTENTION. "main is green" derived
 *    from no observations is the exact false-green this repo keeps re-learning.
 *  - a confident recommendation derived from absent data. No `area` field on
 *    any failing test means the siren says `investigate`, not `revert`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  loadRuns,
  runsForBranch,
} from '../claude-code/canary-screech/scripts/history.mjs';
import { assessBranch } from '../claude-code/canary-screech/scripts/redness.mjs';
import { clusterFailures } from '../claude-code/canary-screech/scripts/cluster.mjs';
import { renderBlast } from '../claude-code/canary-screech/scripts/blast.mjs';
import { main } from '../claude-code/canary-screech/scripts/cli.mjs';

/**
 * `assessBranch` returns a discriminated union expressed in JSDoc, which `tsc
 * --strict` reads as "every branch-specific field may be null". The assertions
 * below ARE the narrowing, so they are made through this helper rather than
 * scattering non-null assertions over every line.
 */
const assess = (rows: unknown[]): any => assessBranch(rows as never[]);

const tmps: string[] = [];
function tmpdir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-screech-'));
  tmps.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true });
});

/** One RunRecord line, with only the fields this skill reads. */
function run(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: 'suite-abc-1',
    suite: 'e2e',
    branch: 'main',
    commit_sha: 'aaaaaaa',
    timestamp: '2026-09-01T00:00:00Z',
    total: 3,
    passed: 3,
    failed: 0,
    flaky: 0,
    skipped: 0,
    schema_version: 2,
    tests: [],
    ...over,
  };
}

function writeStore(rows: Record<string, unknown>[]): string {
  const file = path.join(tmpdir(), 'history-v2.jsonl');
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

/** Run the CLI's `main`, capturing everything it writes. */
function callMain(argv: string[]): { code: number; out: string } {
  const out: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    out.push(a.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    out.push(a.join(' '));
  });
  const code = main(argv);
  vi.restoreAllMocks();
  return { code, out: out.join('\n') };
}

// ---------------------------------------------------------------- history --

describe('history.mjs', () => {
  it('reads one record per line and tolerates blank lines', () => {
    const file = path.join(tmpdir(), 'h.jsonl');
    fs.writeFileSync(
      file,
      `${JSON.stringify(run())}\n\n${JSON.stringify(run({ run_id: 'b' }))}\n`,
    );
    expect(loadRuns(file).map((r: any) => r.run_id)).toEqual([
      'suite-abc-1',
      'b',
    ]);
  });

  it('names the line number of a malformed record', () => {
    const file = path.join(tmpdir(), 'h.jsonl');
    fs.writeFileSync(file, `${JSON.stringify(run())}\n{not json\n`);
    expect(() => loadRuns(file)).toThrow(/line 2/);
  });

  it('throws on a missing store rather than returning nothing', () => {
    // Returning [] would be indistinguishable from a real empty store, and the
    // caller would report an abstention when the truth is a bad --history path.
    expect(() => loadRuns(path.join(tmpdir(), 'nope.jsonl'))).toThrow(
      /history store not found/,
    );
  });

  it('rejects a line that parses but is not a record object', () => {
    // `[1,2]` and `null` are both valid JSON and both would sail through a
    // bare JSON.parse, then read as a record with every field undefined.
    const file = path.join(tmpdir(), 'h.jsonl');
    fs.writeFileSync(file, '[1,2]\n');
    expect(() => loadRuns(file)).toThrow(/line 1: not an object/);
  });

  it('filters to one branch and orders oldest-first by timestamp', () => {
    const rows = [
      run({ run_id: 'c', timestamp: '2026-09-03T00:00:00Z' }),
      run({ run_id: 'x', branch: 'feat/other' }),
      run({ run_id: 'a', timestamp: '2026-09-01T00:00:00Z' }),
    ];
    expect(runsForBranch(rows, 'main').map((r: any) => r.run_id)).toEqual([
      'a',
      'c',
    ]);
  });
});

// ---------------------------------------------------------------- redness --

describe('redness.mjs', () => {
  it('abstains on an empty run list instead of calling it green', () => {
    const a = assess([]);
    expect(a.state).toBe('abstained');
  });

  it('reports green when the latest run had no failures', () => {
    expect(assess([run()]).state).toBe('green');
  });

  it('reports red when the latest run had failures', () => {
    expect(assess([run({ failed: 2 })]).state).toBe('red');
  });

  it('walks back to the FIRST red run, not the latest one', () => {
    const rows = [
      run({
        run_id: 'g',
        commit_sha: 'green01',
        timestamp: '2026-09-01T00:00:00Z',
      }),
      run({
        run_id: 'r1',
        commit_sha: 'red001',
        failed: 1,
        timestamp: '2026-09-02T00:00:00Z',
      }),
      run({
        run_id: 'r2',
        commit_sha: 'red002',
        failed: 4,
        timestamp: '2026-09-03T00:00:00Z',
      }),
    ];
    const a = assess(rows);
    expect(a.state).toBe('red');
    expect(a.firstRed.run_id).toBe('r1');
    expect(a.lastGreen.run_id).toBe('g');
    expect(a.culpritRange.from).toBe('green01');
    expect(a.culpritRange.to).toBe('red001');
    expect(a.culpritRange.bounded).toBe(true);
    expect(a.culpritRange.commits).toEqual(['red001']);
  });

  it('admits an unknown lower bound when no green run precedes the break', () => {
    const a = assess([run({ commit_sha: 'red001', failed: 1 })]);
    expect(a.culpritRange.from).toBeNull();
    expect(a.culpritRange.bounded).toBe(false);
  });
});

// ---------------------------------------------------------------- cluster --

describe('cluster.mjs', () => {
  const failing = (over: Record<string, unknown>) => ({
    test_name: 'checkout pays',
    status: 'failed',
    failure_category: 'assertion',
    area: 'checkout',
    ...over,
  });

  it('groups failures by category, largest cluster first', () => {
    const c = clusterFailures(
      run({
        failed: 3,
        tests: [
          failing({ test_name: 't1', failure_category: 'timeout' }),
          failing({ test_name: 't2' }),
          failing({ test_name: 't3' }),
          { test_name: 'ok', status: 'passed' },
        ],
      }),
      { commits: ['red001'], bounded: true },
    );
    expect(c.clusters.map((x: any) => x.category)).toEqual([
      'assertion',
      'timeout',
    ]);
    expect(c.clusters[0].tests).toHaveLength(2);
  });

  it('recommends revert for one area attributable to one commit', () => {
    const c = clusterFailures(run({ failed: 1, tests: [failing({})] }), {
      commits: ['red001'],
      bounded: true,
    });
    expect(c.owningArea).toBe('checkout');
    expect(c.recommendation).toBe('revert');
  });

  it('recommends quarantine when the break spans more than one area', () => {
    const c = clusterFailures(
      run({
        failed: 2,
        tests: [
          failing({ test_name: 'a' }),
          failing({ test_name: 'b', area: 'search' }),
        ],
      }),
      { commits: ['red001'], bounded: true },
    );
    expect(c.recommendation).toBe('quarantine');
  });

  it('recommends quarantine when the culprit range holds several commits', () => {
    const c = clusterFailures(run({ failed: 1, tests: [failing({})] }), {
      commits: ['red001', 'red002'],
      bounded: true,
    });
    expect(c.recommendation).toBe('quarantine');
  });

  it('recommends investigate, not revert, when no failure carries an area', () => {
    const c = clusterFailures(
      run({ failed: 1, tests: [failing({ area: null })] }),
      { commits: ['red001'], bounded: true },
    );
    expect(c.owningArea).toBeNull();
    expect(c.recommendation).toBe('investigate');
  });
});

// ------------------------------------------------------------------ blast --

describe('blast.mjs', () => {
  const redRun = run({
    failed: 1,
    commit_sha: 'red001',
    tests: [
      {
        test_name: 'checkout pays',
        status: 'failed',
        failure_category: 'assertion',
        area: 'checkout',
        error_text: 'expected 200, got 500',
      },
    ],
  });

  it('renders all five sections of the one-pager', () => {
    const assessment = assess([
      run({ commit_sha: 'green01', timestamp: '2026-09-01T00:00:00Z' }),
      { ...redRun, timestamp: '2026-09-02T00:00:00Z' },
    ]);
    const cluster = clusterFailures(
      assessment.firstRed,
      assessment.culpritRange,
    );
    const blast = renderBlast({ branch: 'main', assessment, cluster });

    expect(blast.markdown).toContain('Culprit commit range');
    expect(blast.markdown).toContain('Failure cluster');
    expect(blast.markdown).toContain('Owning area');
    expect(blast.markdown).toContain('Recommendation');
    expect(blast.markdown).toContain('Chat-ready block');
    expect(blast.markdown).toContain('green01');
    expect(blast.markdown).toContain('red001');
  });

  it('emits exactly one ::error annotation for a red branch', () => {
    const assessment = assess([redRun]);
    const cluster = clusterFailures(
      assessment.firstRed,
      assessment.culpritRange,
    );
    const blast = renderBlast({ branch: 'main', assessment, cluster });
    expect(blast.annotations).toHaveLength(1);
    expect(blast.annotations[0]).toMatch(/^::error /);
    expect(blast.annotations[0]).toContain('main');
  });

  it('emits no annotation for a green branch', () => {
    const assessment = assess([run()]);
    const blast = renderBlast({ branch: 'main', assessment, cluster: null });
    expect(blast.annotations).toEqual([]);
    expect(blast.markdown).toContain('green');
  });

  it('puts the chat block in a fenced code block so it pastes cleanly', () => {
    const assessment = assess([redRun]);
    const cluster = clusterFailures(
      assessment.firstRed,
      assessment.culpritRange,
    );
    const blast = renderBlast({ branch: 'main', assessment, cluster });
    expect(blast.markdown).toContain('```text\n' + blast.chatBlock);
  });
});

// -------------------------------------------------------------------- cli --

describe('cli.mjs', () => {
  it('exits 0 on --help with usage on stdout', () => {
    const r = callMain(['--help']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^usage: /m);
  });

  it('rejects an unknown flag with the usage exit code', () => {
    expect(callMain(['--nope']).code).toBe(2);
  });

  it('requires --history', () => {
    expect(callMain([]).code).toBe(2);
  });

  it('is loud and advisory when the store holds no run for the branch', () => {
    const file = writeStore([run({ branch: 'feat/elsewhere' })]);
    const r = callMain(['--history', file, '--branch', 'main']);
    expect(r.out.toLowerCase()).toContain('abstained');
    expect(r.out).not.toContain('green');
    expect(r.code).toBe(0);
  });

  it('inherits exit 3 for that abstention under --strict', () => {
    const file = writeStore([run({ branch: 'feat/elsewhere' })]);
    const r = callMain(['--history', file, '--branch', 'main', '--strict']);
    expect(r.code).toBe(3);
  });

  it('reports a green branch and exits 0 under --strict', () => {
    const file = writeStore([run()]);
    const r = callMain(['--history', file, '--strict']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('green');
  });

  it('screeches on a red branch: advisory 0, strict 1, annotation emitted', () => {
    const file = writeStore([
      run({ commit_sha: 'green01', timestamp: '2026-09-01T00:00:00Z' }),
      run({
        commit_sha: 'red001',
        timestamp: '2026-09-02T00:00:00Z',
        failed: 1,
        tests: [
          {
            test_name: 'checkout pays',
            status: 'failed',
            failure_category: 'assertion',
            area: 'checkout',
            error_text: 'expected 200, got 500',
          },
        ],
      }),
    ]);
    const advisory = callMain(['--history', file]);
    expect(advisory.code).toBe(0);
    expect(advisory.out).toContain('::error');
    expect(advisory.out).toContain('red001');

    const strict = callMain(['--history', file, '--strict']);
    expect(strict.code).toBe(1);
  });

  it('writes the markdown artifact to --out', () => {
    const file = writeStore([run({ failed: 1, commit_sha: 'red001' })]);
    const out = path.join(tmpdir(), 'nested', 'screech.md');
    const r = callMain(['--history', file, '--out', out]);
    expect(r.code).toBe(0);
    expect(fs.readFileSync(out, 'utf8')).toContain('Culprit commit range');
  });

  it('reports an unwritable --out as an error rather than exiting quietly', () => {
    // A siren whose artifact silently failed to land is a siren nobody hears.
    const file = writeStore([run({ failed: 1, commit_sha: 'red001' })]);
    const blocker = path.join(tmpdir(), 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    const r = callMain([
      '--history',
      file,
      '--out',
      path.join(blocker, 'screech.md'),
    ]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('cannot write artifact');
  });

  it('reports a bad --history path as an error, never as a green branch', () => {
    const r = callMain(['--history', path.join(tmpdir(), 'missing.jsonl')]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('history store not found');
  });
});
