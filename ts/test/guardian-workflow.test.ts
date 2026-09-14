/**
 * Structural test for the PR Guardian GitHub Actions workflow (SC-1).
 *
 * Ported from `tests/unit/test_guardian_workflow.py`. Offline: parses
 * `.github/workflows/guardian.yml` with js-yaml and asserts the DURABLE,
 * agentless contract — no secret beyond GITHUB_TOKEN, `pull_request` trigger,
 * write permission for commenting, the `guardian pr-check --post-comment`
 * invocation, and (since #485) that the job dogfoods the CONSUMER path by
 * omitting `--diff`. It never runs the workflow.
 *
 * The three-dot base-ref diff used to be asserted here, when the workflow
 * computed it. That responsibility moved into `readPrDiff`; the exact
 * `diff origin/<base>...HEAD` invocation is asserted in
 * `guardian-pr-check-ci-diff.test.ts`.
 *
 * v6 note: this workflow is being repointed from `pip install -e .` + Python
 * `canary guardian pr-check` to the TS engine in the same PR. Every assertion
 * here is language-agnostic and survives that change — none of them keyed on
 * the Python install mechanism (the original never asserted `pip install`
 * either). The `guardian pr-check` + `--post-comment` invocation is the load-
 * bearing durable invariant; `--emit-analysis` (#899) is the harness reverse-
 * handoff and is equally language-agnostic, so it is preserved.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'guardian.yml');

interface Step {
  run?: string;
  with?: Record<string, unknown>;
}
interface Job {
  steps: Step[];
}
interface Workflow {
  name?: string;
  on?: unknown;
  true?: unknown; // YAML may parse the bare `on:` key as boolean true
  permissions?: Record<string, string>;
  jobs?: Record<string, Job>;
}

function load(): Workflow {
  return loadYaml(readFileSync(WORKFLOW, 'utf-8')) as Workflow;
}

function runBlocks(wf: Workflow): string[] {
  const blocks: string[] = [];
  for (const job of Object.values(wf.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (typeof step.run === 'string') blocks.push(step.run);
    }
  }
  return blocks;
}

describe('guardian workflow', () => {
  it('triggers on pull_request', () => {
    const wf = load();
    // js-yaml may parse the bare `on:` key as the boolean true.
    const triggers = (wf.on ?? wf.true) as Record<string, unknown> | undefined;
    expect(triggers).not.toBeUndefined();
    expect(triggers).toHaveProperty('pull_request');
  });

  it('permissions: comment write, contents read', () => {
    const wf = load();
    const perms = wf.permissions!;
    expect(perms['pull-requests']).toBe('write');
    expect(perms['contents']).toBe('read');
  });

  it('checkout uses full fetch-depth', () => {
    const wf = load();
    const depths: unknown[] = [];
    for (const job of Object.values(wf.jobs!)) {
      for (const step of job.steps) {
        depths.push(step.with?.['fetch-depth']);
      }
    }
    expect(depths).toContain(0);
  });

  it('invokes pr-check with --post-comment', () => {
    const blocks = runBlocks(load());
    expect(
      blocks.some(
        (b) => b.includes('guardian pr-check') && b.includes('--post-comment'),
      ),
    ).toBe(true);
  });

  it('hands pr-check a coverage report, so the top fidelity tier can run', () => {
    // Until #655 this job passed no --coverage at all. Every verdict canary
    // posted on its own PRs therefore came from the heuristic (filename) tier:
    // 17 of the last 17 guardian comments read "coverage was unavailable", and
    // the coverage-verified scorer was never executed by this repo's CI. That
    // is why a defect in it could only be found by a downstream consumer.
    const blocks = runBlocks(load());
    expect(
      blocks.some(
        (b) => b.includes('guardian pr-check') && b.includes('--coverage'),
      ),
    ).toBe(true);
  });

  it('produces the lcov it hands over, in a format guardian parses', () => {
    // lcov, not vitest's coverage-final.json: the .json branch of the reader
    // expects canary's own coverage-json contract (`{"files": {...}}`) and
    // returns null on istanbul's shape, which would degrade to heuristic while
    // looking wired.
    const blocks = runBlocks(load());
    expect(blocks.some((b) => /npm .*test/.test(b))).toBe(true);
    expect(blocks.some((b) => b.includes('lcov.info'))).toBe(true);
  });

  it('fails loudly when the coverage report is missing', () => {
    // A absent lcov makes pr-check fall back to the heuristic tier and still
    // exit 0 — indistinguishable from the wiring having worked. An unverifiable
    // gate reports itself rather than reporting nothing (#508).
    const blocks = runBlocks(load());
    // Pins the behaviour, not the shell idiom: some block must test the report
    // for non-emptiness (`-s`) and exit non-zero when it is not there.
    const guard = blocks.find(
      (b) => b.includes('lcov.info') && b.includes('-s ') && /exit 1/.test(b),
    );
    expect(guard).toBeDefined();
  });

  it('invokes pr-check with --emit-analysis', () => {
    // SC-10 / #899: CI writes the finding record to the analyses channel.
    const blocks = runBlocks(load());
    expect(
      blocks.some(
        (b) => b.includes('guardian pr-check') && b.includes('--emit-analysis'),
      ),
    ).toBe(true);
  });

  it('the same block emits AND posts while #899 pending', () => {
    const blocks = runBlocks(load());
    expect(
      blocks.some(
        (b) =>
          b.includes('guardian pr-check') &&
          b.includes('--emit-analysis') &&
          b.includes('--post-comment'),
      ),
    ).toBe(true);
  });

  it('stable job and workflow name', () => {
    // The required-check name "PR Guardian / guardian" (#311) is keyed on the
    // workflow `name:` + job id; both must stay stable for branch protection.
    const wf = load();
    expect(wf.name).toBe('PR Guardian');
    expect(wf.jobs).toHaveProperty('guardian');
  });

  // The workflow no longer computes the diff itself. It used to run
  // `git diff origin/<base>...HEAD > pr.diff` and pass `--diff pr.diff`, which
  // meant canary's own dogfood exercised a path its CONSUMERS do not -- and is
  // exactly why #369 escaped: that bug lived in the base-ref resolution taken
  // when `--diff` is absent, so this job could never have caught it.
  //
  // The three-dot merge-base guarantee did not disappear; it moved into
  // `readPrDiff`, where `guardian-pr-check-ci-diff.test.ts` asserts the exact
  // `diff origin/<base>...HEAD` invocation. What this file now protects is the
  // dogfood property: that the workflow keeps taking the consumer path.
  it('dogfoods the consumer path — no --diff, so pr-check resolves the base ref', () => {
    const blocks = runBlocks(load());
    const prCheck = blocks.find((b) => b.includes('guardian pr-check'));
    expect(prCheck).toBeDefined();
    expect(prCheck).not.toContain('--diff');
  });

  it('fetches the base branch so origin/<base> is resolvable', () => {
    // pr-check tries `origin/$GITHUB_BASE_REF` first; without this fetch it
    // would fall through to the working-tree diff, which is empty on a clean
    // checkout -- the #369 no-op.
    const blocks = runBlocks(load());
    expect(
      blocks.some((b) => b.includes('git fetch') && b.includes('origin')),
    ).toBe(true);
  });

  // #930: coverage-delta (#881) never ran here because nothing supplied
  // --base-coverage — 24 of 24 guardian comments read `head-only`. The base
  // report now comes from the lcov artifact that `TS engine (pilot)` uploads on
  // every push to main, looked up by the PR's merge-base SHA.
  describe('#930 — base coverage for the coverage-delta tier', () => {
    const resolveStep = () =>
      Object.values(load().jobs!)
        .flatMap((j) => j.steps)
        .find(
          (s) =>
            typeof s.run === 'string' && s.run.includes('ts-coverage-lcov-'),
        );

    it('can read artifacts from other runs', () => {
      expect(load().permissions!['actions']).toBe('read');
    });

    it('looks the artifact up by the merge-base SHA, not the latest main run', () => {
      const run = resolveStep()?.run ?? '';
      expect(run).toContain('git merge-base');
      expect(run).toMatch(/ts-coverage-lcov-\$\{?BASE_SHA/);
      // The artifact name alone is not trusted: the run that produced it must
      // have been built from that exact commit.
      expect(run).toMatch(/head_sha/);
    });

    it('never swallows a failed lookup into a green', () => {
      const run = resolveStep()?.run ?? '';
      expect(run).not.toMatch(/\|\|\s*(true|echo|:)/);
    });

    it('passes --base-coverage only when a base report resolved', () => {
      const prCheck =
        runBlocks(load()).find((b) => b.includes('guardian pr-check')) ?? '';
      expect(prCheck).toContain('--base-coverage');
      // Conditional on the resolver's output, so an unresolved base keeps the
      // loud head-only notice instead of pointing pr-check at a missing file.
      expect(prCheck).toMatch(/BASE_COVERAGE/);
      expect(prCheck).toMatch(/if \[ -n "\$BASE_COVERAGE" \]/);
    });

    it('says in the log when it falls back to head-only', () => {
      const run = resolveStep()?.run ?? '';
      expect(run).toMatch(/::notice[^\n]*head-only/);
    });

    it('main uploads the lcov under a SHA-keyed name, on push only', () => {
      const hq = loadYaml(
        readFileSync(
          join(REPO_ROOT, '.github', 'workflows', 'harness-quality.yml'),
          'utf-8',
        ),
      ) as { jobs: Record<string, Job & { name?: string }> };
      const upload = hq.jobs['ts-validate']!.steps.find(
        (s) =>
          String(s.with?.['name'] ?? '').startsWith('ts-coverage-lcov-') &&
          (s as { uses?: string }).uses?.startsWith('actions/upload-artifact'),
      ) as (Step & { if?: string }) | undefined;
      expect(upload).toBeDefined();
      expect(upload!.with!['name']).toBe('ts-coverage-lcov-${{ github.sha }}');
      expect(upload!.with!['path']).toBe('ts/coverage/lcov.info');
      expect(upload!.if).toMatch(/github\.event_name == 'push'/);
      expect(upload!.with!['if-no-files-found']).toBe('error');
    });
  });

  it('agentless — no extra secret', () => {
    // Only GITHUB_TOKEN / github.token may appear — no `secrets.` reference,
    // proving the surface is agentless (no API key, no LLM secret).
    const raw = readFileSync(WORKFLOW, 'utf-8');
    expect(raw).not.toContain('secrets.');
  });
});
