/**
 * Truncated history, and the file that no longer exists (spec Phase 3).
 *
 * Both cases exist to stop batwoman from making a claim it has not earned.
 *
 * The truncation half is narrower than the spec's wording, and the tests say
 * why: because `gh run list` returns newest-first, a page that drops older
 * runs cannot conceal a run *after* the merge. The only window that genuinely
 * says nothing is one that is both empty and incomplete. A file the closing PR
 * deleted has nothing left to execute at all.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { workflowProbe } from '../src/analysis/batwoman/probes.js';
import { probeFile } from '../src/analysis/batwoman/registry.js';
import type {
  ExerciseContext,
  RunHistory,
  RunHistoryPort,
  WorkflowRun,
} from '../src/analysis/batwoman/verdict.js';

const MERGED_AT = new Date('2026-08-22T17:34:00Z');

function run(iso: string): WorkflowRun {
  return { createdAt: new Date(iso), conclusion: 'success' };
}

/** A port that hands back a fixed history, complete or not. */
function port(history: RunHistory): RunHistoryPort {
  return { runsForWorkflow: () => Promise.resolve(history) };
}

let root: string;
const WF = '.github/workflows/refresh-arch-baseline.yml';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'batwoman-trunc-'));
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  writeFileSync(
    join(root, WF),
    'name: R\non:\n  pull_request:\n    types: [labeled]\n',
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function ctx(
  runs: RunHistoryPort,
  deleted: readonly string[] = [],
): ExerciseContext {
  return {
    mergedAt: MERGED_AT,
    repo: 'bop-clocktower/canary',
    runs,
    root,
    deleted: new Set(deleted),
  };
}

describe('truncated run history', () => {
  const probe = workflowProbe();

  it('does NOT abstain merely because a full page sits entirely after the merge', async () => {
    // The spec's stated rationale -- abstain whenever the page "does not reach
    // back past mergedAt" -- would abstain here. It is unsound: `gh run list`
    // returns newest-first, so a page whose oldest run postdates the merge
    // necessarily CONTAINS a qualifying run, and the honest answer is the
    // positive one. Abstaining would report ignorance the tool does not have.
    const verdict = await probe.probe(
      WF,
      ctx(
        port({
          runs: [run('2026-09-01T09:00:00Z'), run('2026-08-30T09:00:00Z')],
          complete: false,
        }),
      ),
    );

    expect(verdict.status).toBe('exercised');
  });

  it('abstains on the one window that truly says nothing: empty and truncated', async () => {
    // Empty means no evidence; incomplete means there is more it did not see.
    // Together they are an absence of evidence, not evidence of absence.
    const verdict = await probe.probe(
      WF,
      ctx(port({ runs: [], complete: false })),
    );

    expect(verdict.status).toBe('abstain');
    expect(verdict.explanation).toMatch(/empty but incomplete/i);
    expect(verdict.explanation).toMatch(/not a claim/i);
    // It must say what it read, so a human can widen the window themselves.
    expect((verdict as { evidence?: string }).evidence).toBeTruthy();
  });

  it('decides normally when the page filled but still spans the merge', async () => {
    // Truncation only matters if it hid the merge boundary. A full page whose
    // oldest run predates the merge has seen everything that could qualify,
    // so abstaining would be its own kind of false report.
    const verdict = await probe.probe(
      WF,
      ctx(
        port({
          runs: [run('2026-08-25T09:00:00Z'), run('2026-08-10T09:00:00Z')],
          complete: false,
        }),
      ),
    );

    expect(verdict.status).toBe('exercised');
  });

  it('reports not-exercised on an incomplete page whose oldest run predates the merge', async () => {
    const verdict = await probe.probe(
      WF,
      ctx(port({ runs: [run('2026-08-10T09:00:00Z')], complete: false })),
    );

    expect(verdict.status).toBe('not-exercised');
    expect(verdict.explanation).toContain('2026-08-10');
  });

  it('reports never-ran for an empty history that is complete', async () => {
    // Complete means gh reached the end: there is genuinely nothing. That is a
    // real, reportable state and must not be softened into an abstention.
    const verdict = await probe.probe(
      WF,
      ctx(port({ runs: [], complete: true })),
    );

    expect(verdict.status).toBe('not-exercised');
    expect(verdict.explanation).toMatch(/no recorded runs/i);
  });

  it('still reports exercised when a qualifying run is in a truncated page', async () => {
    // A run that postdates the merge is positive evidence, and a page that
    // omits earlier history cannot retract it, so truncation is moot here.
    const verdict = await probe.probe(
      WF,
      ctx(port({ runs: [run('2026-09-01T09:00:00Z')], complete: false })),
    );

    expect(verdict.status).toBe('exercised');
  });
});

describe('a file the closing PR deleted', () => {
  const probes = [workflowProbe()];

  it('is not-applicable, and says the change deleted it', async () => {
    const verdict = await probeFile(
      probes,
      WF,
      ctx(port({ runs: [], complete: true }), [WF]),
    );

    expect(verdict.status).toBe('not-applicable');
    expect(verdict.explanation).toMatch(/deleted by this change/i);
  });

  it('is decided before any probe runs, so a broken port cannot change it', async () => {
    // There is nothing left to execute, so the answer does not depend on run
    // history at all. A port failure must not turn this into an abstention.
    const exploding: RunHistoryPort = {
      runsForWorkflow: () => Promise.reject(new Error('gh: not authenticated')),
    };

    const verdict = await probeFile(probes, WF, ctx(exploding, [WF]));

    expect(verdict.status).toBe('not-applicable');
  });

  it('applies to a file no probe would have claimed either', async () => {
    // The deletion answer outranks `no-probe`: "nothing looked" is the wrong
    // report for a file that is not there to look at.
    const verdict = await probeFile(
      probes,
      'ts/src/gone.ts',
      ctx(port({ runs: [], complete: true }), ['ts/src/gone.ts']),
    );

    expect(verdict.status).toBe('not-applicable');
    expect(verdict.explanation).toMatch(/deleted by this change/i);
  });

  it('leaves files that were not deleted alone', async () => {
    const verdict = await probeFile(
      probes,
      WF,
      ctx(port({ runs: [], complete: true }), ['some/other/file.ts']),
    );

    expect(verdict.status).toBe('not-exercised');
  });
});
