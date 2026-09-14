/**
 * `canary analyze gh-flaky` (#884): flake signals that survive an in-place
 * GitHub Re-run.
 *
 * A Re-run bumps `run_attempt` and REPLACES the run's conclusion, so a
 * failed-then-rerun-to-green run leaves one row reading `success`. A scan
 * keyed only on same-SHA outcome flips reads that row and reports a zero it
 * never verified. Every fixture here injects a fake gh through the
 * `SubprocessRun` seam, so nothing shells out.
 */
import { describe, expect, it } from 'vitest';

import { CommanderError } from 'commander';

import { CliExitError } from '../src/cli-common.js';
import type {
  SubprocessResult,
  SubprocessRun,
} from '../src/core/workflow-discovery.js';
import { EXIT_ABSTAINED } from '../src/core/gate-result.js';
import { createAnalyzeCommand } from '../src/analysis/cli.js';
import {
  ghFlakyExitCode,
  renderGhFlaky,
  scanGhFlaky,
} from '../src/analysis/gh-flaky/gh-run-attempts.js';

const REPO = 'bop-clocktower/canary';

interface RunFixture {
  databaseId: number;
  headSha: string;
  workflowName: string;
  conclusion: string | null;
  attempt: number;
}

function run(over: Partial<RunFixture> & { databaseId: number }): RunFixture {
  return {
    headSha: `sha-${over.databaseId}`,
    workflowName: 'CI',
    conclusion: 'success',
    attempt: 1,
    ...over,
  };
}

const ok = (value: unknown): SubprocessResult => ({
  returncode: 0,
  stdout: JSON.stringify(value),
  stderr: '',
});

/**
 * A fake gh: `runs` answers `gh run list`; `attempts` maps
 * `<runId>/<n>` to that attempt's conclusion, and a missing key answers 404.
 */
function fakeGh(
  runs: RunFixture[] | SubprocessResult,
  attempts: Record<string, string> = {},
): SubprocessRun & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = ((cmd: string[]) => {
    calls.push(cmd);
    if (cmd[1] === 'run') return Array.isArray(runs) ? ok(runs) : runs;
    const m = /actions\/runs\/(\d+)\/attempts\/(\d+)$/.exec(cmd[2] ?? '');
    const key = m ? `${m[1]}/${m[2]}` : '';
    if (key in attempts) return ok({ conclusion: attempts[key] });
    return { returncode: 1, stdout: '', stderr: 'HTTP 404: Not Found' };
  }) as SubprocessRun & { calls: string[][] };
  fn.calls = calls;
  return fn;
}

// --- fixtures ----------------------------------------------------------------

/** Run 11 failed on attempt 1 and was re-run to green on attempt 2. */
const RERUN_TO_GREEN = [
  run({ databaseId: 10 }),
  run({ databaseId: 11, attempt: 2 }),
];
const RERUN_ATTEMPTS = { '11/1': 'failure' };

/** Run 21 was re-run, but its earlier attempt cannot be read. */
const UNREADABLE = [
  run({ databaseId: 20 }),
  run({ databaseId: 21, attempt: 3 }),
];
const UNREADABLE_ATTEMPTS = { '21/2': 'success' }; // 21/1 is missing

/** Two green runs, one a rerun after a success: a genuine, verified zero. */
const CLEAN = [run({ databaseId: 30 }), run({ databaseId: 31, attempt: 2 })];
const CLEAN_ATTEMPTS = { '31/1': 'success' };

describe('scanGhFlaky', () => {
  it('asks gh for runs with the attempt field and an explicit limit', () => {
    const gh = fakeGh(CLEAN, CLEAN_ATTEMPTS);
    scanGhFlaky(REPO, 50, gh);
    const list = gh.calls[0] ?? [];
    expect(list.slice(0, 3)).toEqual(['gh', 'run', 'list']);
    expect(list).toContain(REPO);
    expect(list).toContain('50');
    expect(list.join(' ')).toContain('attempt');
    expect(gh.calls[1]).toEqual([
      'gh',
      'api',
      `repos/${REPO}/actions/runs/31/attempts/1`,
    ]);
  });

  it('detects a rerun-to-green run that the same-SHA signature cannot see', () => {
    const report = scanGhFlaky(
      REPO,
      100,
      fakeGh(RERUN_TO_GREEN, RERUN_ATTEMPTS),
    );
    expect(report.verdict).toBe('candidates');
    expect(report.candidates).toEqual([
      expect.objectContaining({
        signature: 'rerun-attempt',
        runId: 11,
        earlierConclusion: 'failure',
      }),
    ]);
    expect(ghFlakyExitCode(report)).toBe(1);
  });

  it('reports an unreadable attempt as flake-signal-unverifiable, never a zero', () => {
    const report = scanGhFlaky(
      REPO,
      100,
      fakeGh(UNREADABLE, UNREADABLE_ATTEMPTS),
    );
    expect(report.verdict).toBe('flake-signal-unverifiable');
    expect(report.verifiedAgainst).toEqual(['same-sha-flip']);
    expect(report.unverifiable).toEqual([
      expect.objectContaining({
        runId: 21,
        attempt: 1,
        source: `/repos/${REPO}/actions/runs/21/attempts/1`,
      }),
    ]);
    const text = renderGhFlaky(report).join('\n');
    expect(text).toContain('flake-signal-unverifiable');
    expect(text).toContain(`/repos/${REPO}/actions/runs/21/attempts/1`);
    expect(text).not.toMatch(/(^|\n)0 candidates/);
    expect(ghFlakyExitCode(report)).toBe(EXIT_ABSTAINED);
  });

  it('names both signatures on a clean verified zero', () => {
    const report = scanGhFlaky(REPO, 100, fakeGh(CLEAN, CLEAN_ATTEMPTS));
    expect(report.verdict).toBe('verified-zero');
    expect(report.verifiedAgainst).toEqual(['same-sha-flip', 'rerun-attempt']);
    const text = renderGhFlaky(report).join('\n');
    expect(text).toContain('0 candidates');
    expect(text).toContain('same-SHA flip');
    expect(text).toContain('rerun-attempt');
    expect(ghFlakyExitCode(report)).toBe(0);
  });

  it('detects a same-SHA outcome flip across two runs of one workflow', () => {
    const gh = fakeGh([
      run({ databaseId: 40, headSha: 'abc', conclusion: 'failure' }),
      run({ databaseId: 41, headSha: 'abc', conclusion: 'success' }),
      run({ databaseId: 42, headSha: 'abc', workflowName: 'Docs' }),
    ]);
    const report = scanGhFlaky(REPO, 100, gh);
    expect(report.candidates).toEqual([
      expect.objectContaining({
        signature: 'same-sha-flip',
        headSha: 'abc',
        workflow: 'CI',
      }),
    ]);
  });

  it('does not count a rerun whose current conclusion is not success', () => {
    const gh = fakeGh(
      [run({ databaseId: 50, attempt: 2, conclusion: 'failure' })],
      {},
    );
    const report = scanGhFlaky(REPO, 100, gh);
    expect(report.verdict).toBe('verified-zero');
    expect(gh.calls).toHaveLength(1);
  });

  it('abstains on an empty window', () => {
    const report = scanGhFlaky(REPO, 100, fakeGh([]));
    expect(report.verdict).toBe('abstained');
    expect(renderGhFlaky(report).join('\n').toLowerCase()).toContain(
      'abstained',
    );
    expect(ghFlakyExitCode(report)).toBe(EXIT_ABSTAINED);
  });

  it('abstains, naming the source, when gh run list fails', () => {
    const report = scanGhFlaky(
      REPO,
      100,
      fakeGh({ returncode: 4, stdout: '', stderr: 'gh auth login required' }),
    );
    expect(report.verdict).toBe('abstained');
    expect(report.reason).toContain('gh run list');
    expect(report.reason).toContain('gh auth login required');
  });

  it('marks a page that filled to the limit as truncated, and says so', () => {
    const full = [run({ databaseId: 60 }), run({ databaseId: 61 })];
    const report = scanGhFlaky(REPO, 2, fakeGh(full));
    expect(report.complete).toBe(false);
    // Disclosure only: a zero over the declared window stays verified.
    expect(report.verdict).toBe('verified-zero');
    expect(ghFlakyExitCode(report)).toBe(0);
    expect(renderGhFlaky(report).join('\n')).toContain(
      'window truncated at 2 runs; older runs unchecked',
    );
  });

  it('marks a page with fewer rows than the limit as complete', () => {
    const report = scanGhFlaky(REPO, 100, fakeGh(CLEAN, CLEAN_ATTEMPTS));
    expect(report.complete).toBe(true);
    expect(renderGhFlaky(report).join('\n')).not.toContain('truncated');
  });

  it('renders the same-SHA flip line in text output', () => {
    const gh = fakeGh([
      run({ databaseId: 80, headSha: 'abc', conclusion: 'failure' }),
      run({ databaseId: 81, headSha: 'abc', conclusion: 'success' }),
    ]);
    const text = renderGhFlaky(scanGhFlaky(REPO, 100, gh)).join('\n');
    expect(text).toContain('  same-SHA flip  CI @ abc: failure / success');
  });

  it('discloses malformed gh rows it skipped instead of dropping them silently', () => {
    const gh = fakeGh([
      run({ databaseId: 90 }),
      {
        headSha: 'no-id',
        workflowName: 'CI',
        conclusion: 'failure',
        attempt: 1,
      },
    ] as RunFixture[]);
    const report = scanGhFlaky(REPO, 100, gh);
    expect(report.runsChecked).toBe(1);
    expect(report.skippedRows).toBe(1);
    expect(renderGhFlaky(report).join('\n')).toContain(
      '1 malformed run row(s) from gh skipped; not checked',
    );
  });

  it('(a) never verifies rerun-attempt when rows carry no attempt number', () => {
    const noAttempt = [
      {
        databaseId: 100,
        headSha: 'x',
        workflowName: 'CI',
        conclusion: 'success',
      },
      {
        databaseId: 101,
        headSha: 'y',
        workflowName: 'CI',
        conclusion: 'success',
      },
    ] as RunFixture[];
    const report = scanGhFlaky(REPO, 100, fakeGh(noAttempt));
    expect(report.verifiedAgainst).toEqual(['same-sha-flip']);
    expect(report.verdict).toBe('flake-signal-unverifiable');
    expect(ghFlakyExitCode(report)).toBe(EXIT_ABSTAINED);
    expect(report.missingAttemptRows).toBe(2);
    const text = renderGhFlaky(report).join('\n');
    expect(text).toContain(
      '2 run row(s) carried no attempt number; rerun-attempt not verified',
    );
    expect(text).not.toMatch(/(^|\n)0 candidates/);
  });

  it('(b) does not treat an in-progress run ("") as a flip partner', () => {
    const report = scanGhFlaky(
      REPO,
      100,
      fakeGh([
        run({ databaseId: 110, headSha: 'p', conclusion: 'success' }),
        run({ databaseId: 111, headSha: 'p', conclusion: '' }),
      ]),
    );
    expect(report.candidates).toEqual([]);
    expect(report.nonOutcomeRows).toBe(1);
    expect(ghFlakyExitCode(report)).toBe(0);
    expect(renderGhFlaky(report).join('\n')).toContain(
      '1 run row(s) had no completed outcome',
    );
  });

  it('(c) does not treat skipped or action_required runs as flip partners', () => {
    const report = scanGhFlaky(
      REPO,
      100,
      fakeGh([
        run({ databaseId: 120, headSha: 'q', conclusion: 'success' }),
        run({ databaseId: 121, headSha: 'q', conclusion: 'skipped' }),
        run({ databaseId: 122, headSha: 'q', conclusion: 'action_required' }),
      ]),
    );
    expect(report.candidates).toEqual([]);
    expect(report.nonOutcomeRows).toBe(2);
    expect(ghFlakyExitCode(report)).toBe(0);
  });

  it('(c) does not count a non-outcome earlier attempt as a rerun candidate', () => {
    const report = scanGhFlaky(
      REPO,
      100,
      fakeGh([run({ databaseId: 130, attempt: 2 })], { '130/1': 'skipped' }),
    );
    expect(report.candidates).toEqual([]);
    expect(report.verdict).toBe('verified-zero');
  });

  it('(d) still reports success + failure on one sha as a flip', () => {
    const report = scanGhFlaky(
      REPO,
      100,
      fakeGh([
        run({ databaseId: 140, headSha: 'r', conclusion: 'success' }),
        run({ databaseId: 141, headSha: 'r', conclusion: 'failure' }),
        run({ databaseId: 142, headSha: 'r', conclusion: '' }),
      ]),
    );
    expect(report.candidates).toEqual([
      expect.objectContaining({ signature: 'same-sha-flip', headSha: 'r' }),
    ]);
    expect(ghFlakyExitCode(report)).toBe(1);
  });

  it('abstains when gh itself cannot be spawned', () => {
    const missing: SubprocessRun = () => {
      throw new Error('spawn gh ENOENT');
    };
    const report = scanGhFlaky(REPO, 100, missing);
    expect(report.verdict).toBe('abstained');
    expect(report.reason).toContain('ENOENT');
  });
});

// --- CLI ---------------------------------------------------------------------

async function invokeGhFlaky(
  args: string[],
  runGh: SubprocessRun,
): Promise<{ code: number; stdout: string }> {
  const out: string[] = [];
  const cmd = createAnalyzeCommand({
    out: (s) => out.push(s),
    err: () => undefined,
    runGh,
  });
  let code = 0;
  try {
    await cmd.parseAsync(['gh-flaky', ...args], { from: 'user' });
  } catch (e) {
    if (e instanceof CliExitError) code = e.code;
    else if (e instanceof CommanderError) code = e.exitCode;
    else throw e;
  }
  return { code, stdout: out.join('\n') };
}

describe('canary analyze gh-flaky', () => {
  it('exits 1 with the rerun candidate on a rerun-to-green window', async () => {
    const res = await invokeGhFlaky(
      ['--repo', REPO],
      fakeGh(RERUN_TO_GREEN, RERUN_ATTEMPTS),
    );
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('rerun-attempt');
  });

  it('exits 3 on an unreadable-attempts window', async () => {
    const res = await invokeGhFlaky(
      ['--repo', REPO],
      fakeGh(UNREADABLE, UNREADABLE_ATTEMPTS),
    );
    expect(res.code).toBe(EXIT_ABSTAINED);
  });

  it('exits 0 and emits parseable JSON on a verified zero', async () => {
    const res = await invokeGhFlaky(
      ['--repo', REPO, '--json'],
      fakeGh(CLEAN, CLEAN_ATTEMPTS),
    );
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as { verifiedAgainst: string[] };
    expect(parsed.verifiedAgainst).toEqual(['same-sha-flip', 'rerun-attempt']);
  });

  it('passes --limit-runs through to gh', async () => {
    const gh = fakeGh(CLEAN, CLEAN_ATTEMPTS);
    await invokeGhFlaky(['--repo', REPO, '--limit-runs', '7'], gh);
    expect(gh.calls[0]).toContain('7');
  });

  it('names the cutoff in --json when the window is truncated', async () => {
    const res = await invokeGhFlaky(
      ['--repo', REPO, '--limit-runs', '2', '--json'],
      fakeGh([run({ databaseId: 70 }), run({ databaseId: 71 })]),
    );
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as {
      complete: boolean;
      window: string;
    };
    expect(parsed.complete).toBe(false);
    expect(parsed.window).toBe(
      'window truncated at 2 runs; older runs unchecked',
    );
  });

  it('rejects a missing --repo as a usage error', async () => {
    const res = await invokeGhFlaky([], fakeGh(CLEAN));
    expect(res.code).toBe(2);
  });
});
