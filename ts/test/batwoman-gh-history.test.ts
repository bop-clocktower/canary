/**
 * The `gh`-backed `RunHistoryPort` (spec Phase 3).
 *
 * This is batwoman's only network seam, so it is also the only place where
 * "I could not find out" can be mistaken for "it did not happen". Every test
 * here injects a fake `SubprocessRun` -- the same seam `ticket-updater.ts`
 * uses -- so the suite never shells out to a real `gh`.
 *
 * The rule the whole file serves: **a page that ran out is not an answer.**
 * `gh run list` paginates, and if the fetched window does not reach back past
 * the merge, the absence of a qualifying run is indistinguishable from the
 * page ending. Reporting that as "never ran" is the same false-negative shape
 * batwoman exists to catch.
 */
import { describe, expect, it } from 'vitest';
import type {
  SubprocessResult,
  SubprocessRun,
} from '../src/core/workflow-discovery.js';
import {
  GH_RUN_LIMIT,
  ghRunHistory,
} from '../src/analysis/batwoman/gh-history.js';

function ok(stdout: string): SubprocessResult {
  return { returncode: 0, stdout, stderr: '' };
}

/** Records the argv it was handed, and replies with a canned result. */
function fakeGh(
  reply: (cmd: string[]) => SubprocessResult,
): SubprocessRun & { calls: string[][] } {
  const calls: string[][] = [];
  const run = ((cmd: string[]) => {
    calls.push(cmd);
    return reply(cmd);
  }) as SubprocessRun & { calls: string[][] };
  run.calls = calls;
  return run;
}

function runsJson(...iso: string[]): string {
  return JSON.stringify(
    iso.map((createdAt) => ({ createdAt, conclusion: 'success' })),
  );
}

describe('ghRunHistory', () => {
  it('asks gh for one workflow, as JSON, with an explicit limit', () => {
    const gh = fakeGh(() => ok(runsJson('2026-08-25T09:00:00Z')));
    const port = ghRunHistory('bop-clocktower/canary', gh);

    void port.runsForWorkflow('.github/workflows/harness.yml');

    const cmd = gh.calls[0] ?? [];
    expect(cmd[0]).toBe('gh');
    expect(cmd).toContain('--repo');
    expect(cmd).toContain('bop-clocktower/canary');
    expect(cmd).toContain('--workflow');
    expect(cmd).toContain('.github/workflows/harness.yml');
    // The limit must be explicit. gh's own default (20 at the time of
    // writing) is a silent window, and a silent window is what makes the
    // size of a truncation invisible to the reader of a report.
    expect(cmd).toContain('--limit');
    expect(cmd).toContain(String(GH_RUN_LIMIT));
    expect(cmd).toContain('--json');
  });

  it('parses runs into the two fields a probe decides on', async () => {
    const gh = fakeGh(() =>
      ok(runsJson('2026-08-25T09:00:00Z', '2026-08-10T09:00:00Z')),
    );

    const history = await ghRunHistory('r/r', gh).runsForWorkflow('w.yml');

    expect(history.runs).toHaveLength(2);
    expect(history.runs[0]?.createdAt).toBeInstanceOf(Date);
    expect(history.runs[0]?.createdAt.toISOString()).toBe(
      '2026-08-25T09:00:00.000Z',
    );
    expect(history.runs[0]?.conclusion).toBe('success');
  });

  it('reports complete when the page did not fill', async () => {
    // Fewer results than the limit means gh reached the end of the history:
    // there is nothing older, so a verdict over this window is safe.
    const gh = fakeGh(() => ok(runsJson('2026-08-25T09:00:00Z')));

    const history = await ghRunHistory('r/r', gh).runsForWorkflow('w.yml');

    expect(history.complete).toBe(true);
  });

  it('reports incomplete when the page filled exactly to the limit', async () => {
    // A full page is the tell: older runs may exist beyond it. This is the
    // single fact the whole truncation abstention rests on.
    const full = Array.from(
      { length: GH_RUN_LIMIT },
      () => '2026-08-25T09:00:00Z',
    );
    const gh = fakeGh(() => ok(runsJson(...full)));

    const history = await ghRunHistory('r/r', gh).runsForWorkflow('w.yml');

    expect(history.runs).toHaveLength(GH_RUN_LIMIT);
    expect(history.complete).toBe(false);
  });

  it('treats an empty history as complete, not as a failure', async () => {
    // A workflow that has genuinely never run is a real and reportable state.
    const gh = fakeGh(() => ok('[]'));

    const history = await ghRunHistory('r/r', gh).runsForWorkflow('w.yml');

    expect(history.runs).toEqual([]);
    expect(history.complete).toBe(true);
  });

  it('throws when gh exits non-zero, so the registry records an abstention', async () => {
    const gh = fakeGh(() => ({
      returncode: 1,
      stdout: '',
      stderr: 'gh: could not find any workflows named w.yml',
    }));

    await expect(
      ghRunHistory('r/r', gh).runsForWorkflow('w.yml'),
    ).rejects.toThrow(/could not find any workflows/);
  });

  it('throws rather than reporting empty when gh is not installed', async () => {
    // The dangerous failure: `gh` missing returns nothing, and nothing parsed
    // as "no runs" would report every workflow as never-run. It must fail loud.
    const gh = fakeGh(() => {
      throw new Error('spawnSync gh ENOENT');
    });

    await expect(
      ghRunHistory('r/r', gh).runsForWorkflow('w.yml'),
    ).rejects.toThrow(/ENOENT|gh/);
  });

  it('throws on unparseable output rather than reading it as no runs', async () => {
    const gh = fakeGh(() => ok('not json at all'));

    await expect(
      ghRunHistory('r/r', gh).runsForWorkflow('w.yml'),
    ).rejects.toThrow();
  });

  it('skips malformed entries but keeps the ones it can read', async () => {
    // A run with no createdAt cannot be placed in time. Dropping it is right;
    // dropping the whole page because of it would lose real evidence.
    const gh = fakeGh(() =>
      ok(
        JSON.stringify([
          { createdAt: '2026-08-25T09:00:00Z', conclusion: 'success' },
          { conclusion: 'failure' },
          { createdAt: 'not-a-date', conclusion: null },
        ]),
      ),
    );

    const history = await ghRunHistory('r/r', gh).runsForWorkflow('w.yml');

    expect(history.runs).toHaveLength(1);
    expect(history.runs[0]?.createdAt.toISOString()).toBe(
      '2026-08-25T09:00:00.000Z',
    );
  });

  it('carries a null conclusion through, for a run still in flight', async () => {
    const gh = fakeGh(() =>
      ok(
        JSON.stringify([
          { createdAt: '2026-08-25T09:00:00Z', conclusion: null },
        ]),
      ),
    );

    const history = await ghRunHistory('r/r', gh).runsForWorkflow('w.yml');

    expect(history.runs[0]?.conclusion).toBeNull();
  });
});
