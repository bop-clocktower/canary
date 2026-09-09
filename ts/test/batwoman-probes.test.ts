/**
 * The three shipped probes (spec Phase 2).
 *
 * Every test here injects its own `RunHistoryPort`: Phase 2 is offline by
 * construction, and the `gh` adapter does not arrive until Phase 3. A probe
 * that reached the network would pass these tests and fail in the only
 * environment that matters, so `ctx.runs` is the single seam and nothing else
 * is allowed to reach outward.
 *
 * The workflow cases are built from #749's real data -- a label-gated workflow
 * whose last run predates the fix that closed the issue -- because that is the
 * case batwoman was written to catch and a synthetic stand-in would not prove
 * criterion 1.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  noExecutionProbe,
  shippedProbes,
  workflowProbe,
  workflowScriptProbe,
} from '../src/analysis/batwoman/probes.js';
import { matchProbe } from '../src/analysis/batwoman/registry.js';
import type {
  ExerciseContext,
  ExerciseVerdict,
  RunHistoryPort,
  WorkflowRun,
} from '../src/analysis/batwoman/verdict.js';

const MERGED_AT = new Date('2026-08-22T17:34:00Z');

/** A port that answers from a fixture and records what was asked of it. */
function fixturePort(
  byWorkflow: Readonly<Record<string, readonly WorkflowRun[]>>,
): RunHistoryPort & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async runsForWorkflow(path: string): Promise<WorkflowRun[]> {
      asked.push(path);
      return [...(byWorkflow[path] ?? [])];
    },
  };
}

/** A port that fails, standing in for an unreachable or unauthenticated `gh`. */
const brokenPort: RunHistoryPort = {
  async runsForWorkflow(): Promise<WorkflowRun[]> {
    throw new Error('gh: not authenticated');
  },
};

function run(iso: string, conclusion: string | null = 'success'): WorkflowRun {
  return { createdAt: new Date(iso), conclusion };
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'batwoman-probe-'));
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function ctx(runs: RunHistoryPort): ExerciseContext {
  return { mergedAt: MERGED_AT, repo: 'bop-clocktower/canary', runs, root };
}

/** Writes #749's workflow: label-gated, exactly as the real file triggers. */
function writeLabelGatedWorkflow(name = 'refresh-arch-baseline.yml'): string {
  const path = `.github/workflows/${name}`;
  writeFileSync(
    join(root, path),
    'name: Refresh arch baseline\non:\n  pull_request:\n    types: [labeled]\njobs:\n  refresh:\n    runs-on: ubuntu-latest\n',
  );
  return path;
}

describe('workflowProbe', () => {
  const probe = workflowProbe();

  it('matches workflow files and nothing else', () => {
    expect(probe.matches('.github/workflows/harness.yml')).toBe(true);
    expect(probe.matches('.github/workflows/ci.yaml')).toBe(true);
    expect(probe.matches('.github/actions/setup/action.yml')).toBe(false);
    expect(probe.matches('ts/src/cli.ts')).toBe(false);
    expect(probe.matches('docs/guides/pr-guardian.md')).toBe(false);
  });

  it('reports exercised when a run started after the merge', async () => {
    const path = writeLabelGatedWorkflow();
    const port = fixturePort({
      [path]: [run('2026-08-10T09:00:00Z'), run('2026-08-25T11:02:00Z')],
    });

    const verdict = await probe.probe(path, ctx(port));

    expect(verdict.status).toBe('exercised');
    expect(verdict.explanation).toContain('2026-08-25');
    // A claim must name its source (ClaimedVerdict.evidence is required).
    expect((verdict as { evidence: string }).evidence).toBeTruthy();
  });

  it("reports #749's real case: last run predates the fix, and says why", async () => {
    const path = writeLabelGatedWorkflow();
    const port = fixturePort({ [path]: [run('2026-08-10T09:00:00Z')] });

    const verdict = await probe.probe(path, ctx(port));

    expect(verdict.status).toBe('not-exercised');
    // The bare fact...
    expect(verdict.explanation).toContain('2026-08-10');
    // ...and the cause, which is the half that stops a reader hunting a bug.
    expect(verdict.explanation).toContain(
      'triggered only when a label is added to a pull request',
    );
  });

  it('distinguishes never-ran from ran-before-the-merge', async () => {
    const path = writeLabelGatedWorkflow();
    const port = fixturePort({ [path]: [] });

    const verdict = await probe.probe(path, ctx(port));

    expect(verdict.status).toBe('not-exercised');
    expect(verdict.explanation).toMatch(/no recorded runs|has never run/i);
    // It must not claim a last-run date it does not have.
    expect(verdict.explanation).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('still explains itself when the on: block cannot be read', async () => {
    // An unreadable workflow file must not cost the run-history verdict --
    // the two facts come from different places and fail independently.
    const path = '.github/workflows/absent.yml';
    const port = fixturePort({ [path]: [run('2026-08-10T09:00:00Z')] });

    const verdict = await probe.probe(path, ctx(port));

    expect(verdict.status).toBe('not-exercised');
    expect(verdict.explanation).toContain('2026-08-10');
    expect(verdict.explanation.trim()).not.toBe('');
  });

  it('lets a failing port surface, so the registry can record an abstention', async () => {
    const path = writeLabelGatedWorkflow();
    // probeFile turns a throw into `abstain`. Swallowing it here would report
    // "not exercised" over a history nobody managed to read -- a claim with no
    // evidence, which is the defect batwoman exists to detect.
    await expect(probe.probe(path, ctx(brokenPort))).rejects.toThrow(
      /not authenticated/,
    );
  });
});

describe('workflowScriptProbe', () => {
  const probe = workflowScriptProbe();

  it('matches scripts and nothing else', () => {
    expect(probe.matches('scripts/refresh-arch-baseline.mjs')).toBe(true);
    expect(probe.matches('ts/scripts/copy-data.mjs')).toBe(false);
    expect(probe.matches('scripts/lib/authorship-scan.mjs')).toBe(false);
    expect(probe.matches('.github/workflows/harness.yml')).toBe(false);
  });

  it('abstains when no workflow references it, naming the gap', async () => {
    writeFileSync(join(root, 'scripts/orphan.mjs'), '// nothing calls this\n');
    writeLabelGatedWorkflow();
    const port = fixturePort({});

    const verdict = await probe.probe('scripts/orphan.mjs', ctx(port));

    // `abstain`, not `not-exercised`: a probe looked and could not tell.
    // Claiming it never ran would assert something no workflow file supports.
    expect(verdict.status).toBe('abstain');
    expect(verdict.explanation).toMatch(/no workflow/i);
    expect(port.asked).toEqual([]);
  });

  it('inherits exercised from the workflow that calls it', async () => {
    const wf = writeLabelGatedWorkflow('caller.yml');
    writeFileSync(
      join(root, '.github/workflows/caller.yml'),
      'name: Caller\non:\n  push:\n    branches: [main]\njobs:\n  go:\n    steps:\n      - run: node scripts/refresh-arch-baseline.mjs --report r.json\n',
    );
    writeFileSync(join(root, 'scripts/refresh-arch-baseline.mjs'), '// x\n');
    const port = fixturePort({ [wf]: [run('2026-08-25T11:02:00Z')] });

    const verdict = await probe.probe(
      'scripts/refresh-arch-baseline.mjs',
      ctx(port),
    );

    expect(verdict.status).toBe('exercised');
    expect(verdict.explanation).toContain('caller.yml');
  });

  it('is exercised when ANY referencing workflow ran, not only the first', async () => {
    writeFileSync(
      join(root, '.github/workflows/dormant.yml'),
      'name: A\non:\n  pull_request:\n    types: [labeled]\njobs:\n  a:\n    steps:\n      - run: node scripts/shared.mjs\n',
    );
    writeFileSync(
      join(root, '.github/workflows/active.yml'),
      'name: B\non:\n  push:\n    branches: [main]\njobs:\n  b:\n    steps:\n      - run: node scripts/shared.mjs\n',
    );
    writeFileSync(join(root, 'scripts/shared.mjs'), '// x\n');
    const port = fixturePort({
      '.github/workflows/dormant.yml': [run('2026-08-01T09:00:00Z')],
      '.github/workflows/active.yml': [run('2026-08-25T09:00:00Z')],
    });

    const verdict = await probe.probe('scripts/shared.mjs', ctx(port));

    expect(verdict.status).toBe('exercised');
    expect(verdict.explanation).toContain('active.yml');
  });

  it('reports not-exercised when every referencing workflow is dormant', async () => {
    const wf = writeLabelGatedWorkflow('only.yml');
    writeFileSync(
      join(root, '.github/workflows/only.yml'),
      'name: Only\non:\n  pull_request:\n    types: [labeled]\njobs:\n  a:\n    steps:\n      - run: node scripts/dormant.mjs\n',
    );
    writeFileSync(join(root, 'scripts/dormant.mjs'), '// x\n');
    const port = fixturePort({ [wf]: [run('2026-08-10T09:00:00Z')] });

    const verdict = await probe.probe('scripts/dormant.mjs', ctx(port));

    expect(verdict.status).toBe('not-exercised');
    expect(verdict.explanation).toContain('only.yml');
  });

  it('abstains rather than crashing in a repo with no workflows directory', async () => {
    // A consuming repo need not have .github/workflows at all. The probe has
    // to degrade to "cannot trace this" -- an unhandled ENOENT here would take
    // down the whole run over a file batwoman merely could not classify.
    const bare = mkdtempSync(join(tmpdir(), 'batwoman-bare-'));
    try {
      const verdict = await probe.probe('scripts/anything.mjs', {
        mergedAt: MERGED_AT,
        repo: 'bop-clocktower/canary',
        runs: fixturePort({}),
        root: bare,
      });
      expect(verdict.status).toBe('abstain');
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('does not match a basename inside a longer name', async () => {
    // `scripts/lint.mjs` must not be considered called by a workflow whose
    // only mention is `scripts/lint-staged.mjs`.
    writeFileSync(
      join(root, '.github/workflows/other.yml'),
      'name: Other\non:\n  push:\njobs:\n  a:\n    steps:\n      - run: node scripts/lint-staged.mjs\n',
    );
    writeFileSync(join(root, 'scripts/lint.mjs'), '// x\n');
    const port = fixturePort({});

    const verdict = await probe.probe('scripts/lint.mjs', ctx(port));

    expect(verdict.status).toBe('abstain');
  });
});

describe('noExecutionProbe', () => {
  const probe = noExecutionProbe();

  it('matches prose and known config manifests', () => {
    expect(probe.matches('README.md')).toBe(true);
    expect(probe.matches('docs/guides/pr-guardian.md')).toBe(true);
    expect(probe.matches('CHANGELOG.md')).toBe(true);
    expect(probe.matches('ts/tsconfig.json')).toBe(true);
    expect(probe.matches('.gitignore')).toBe(true);
  });

  it('does not match anything that executes', () => {
    expect(probe.matches('ts/src/cli.ts')).toBe(false);
    expect(probe.matches('scripts/refresh-arch-baseline.mjs')).toBe(false);
    expect(probe.matches('.github/workflows/harness.yml')).toBe(false);
  });

  it('returns not-applicable and reads nothing at all', async () => {
    // The root does not exist and the port throws. A probe that touched
    // either would fail here, which is how "reads nothing" is proved rather
    // than asserted.
    const verdict = await probe.probe('README.md', {
      mergedAt: MERGED_AT,
      repo: 'bop-clocktower/canary',
      runs: brokenPort,
      root: '/nonexistent-batwoman-root',
    });

    expect(verdict.status).toBe('not-applicable');
    expect(verdict.explanation.trim()).not.toBe('');
  });
});

describe('shippedProbes', () => {
  it('dispatches a workflow to the workflow probe, not to no-execution', () => {
    // A workflow is YAML, so both probes could plausibly claim it. If
    // no-execution won, every workflow in the repo would report
    // `not-applicable` -- a whole artifact type vanishing into a status that
    // asks nothing of anyone. Both halves of the guard are pinned: the order
    // here, and the explicit exclusion inside noExecutionProbe.matches.
    const matched = matchProbe(
      shippedProbes(),
      '.github/workflows/refresh-arch-baseline.yml',
    );
    expect(matched?.id).toBe('workflow');
    expect(noExecutionProbe().matches('.github/workflows/harness.yml')).toBe(
      false,
    );
  });

  it('routes each artifact type to the probe that owns it', () => {
    const idFor = (file: string): string | undefined =>
      matchProbe(shippedProbes(), file)?.id;
    expect(idFor('scripts/refresh-arch-baseline.mjs')).toBe('workflow-script');
    expect(idFor('README.md')).toBe('no-execution');
    // v1's honest gap: source files have no probe, and the registry makes that
    // countable rather than silent.
    expect(idFor('ts/src/cli.ts')).toBeUndefined();
  });
});

describe('every shipped probe', () => {
  const probes = [workflowProbe(), workflowScriptProbe(), noExecutionProbe()];

  it('gives each probe a distinct id and a noun-phrase artifact name', () => {
    const ids = probes.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of probes) {
      expect(p.artifact.trim()).not.toBe('');
      // A noun phrase, not a code: "workflow", not "WF_PROBE".
      expect(p.artifact).toMatch(/^[a-z][a-z ]*$/);
    }
  });

  it('never returns a claiming verdict without evidence', async () => {
    const path = writeLabelGatedWorkflow();
    writeFileSync(
      join(root, '.github/workflows/caller2.yml'),
      'name: C\non:\n  push:\njobs:\n  a:\n    steps:\n      - run: node scripts/s.mjs\n',
    );
    writeFileSync(join(root, 'scripts/s.mjs'), '// x\n');
    const port = fixturePort({
      [path]: [run('2026-08-25T09:00:00Z')],
      '.github/workflows/caller2.yml': [run('2026-08-25T09:00:00Z')],
    });

    const verdicts: ExerciseVerdict[] = [
      await workflowProbe().probe(path, ctx(port)),
      await workflowScriptProbe().probe('scripts/s.mjs', ctx(port)),
      await noExecutionProbe().probe('README.md', ctx(port)),
    ];

    for (const v of verdicts) {
      expect(v.explanation.trim()).not.toBe('');
      if (v.status === 'exercised' || v.status === 'not-exercised') {
        expect(v.evidence.trim()).not.toBe('');
      }
    }
  });

  it('emits no success token, even on the exercised path', async () => {
    const path = writeLabelGatedWorkflow();
    const port = fixturePort({ [path]: [run('2026-08-25T09:00:00Z')] });

    const verdict = await workflowProbe().probe(path, ctx(port));

    // Spec criterion 2 binds the probes too, not only the renderer.
    const text = `${verdict.explanation} ${(verdict as { evidence?: string }).evidence ?? ''}`;
    expect(text).not.toMatch(/[✓✅]|\bOK\b|\bclean\b|\bpassed\b/i);
  });
});
