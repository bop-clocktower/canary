/**
 * Class-level structural tests for false-green patterns in GitHub Actions
 * workflows (#548, #549).
 *
 * Both issues were filed as single-file bugs and both turned out to be a class:
 * #549 named one workflow and three have the gap; #548 named `arch-snapshot.yml`
 * and `harness-security.yml` fails the same way one step later. These tests
 * assert the INVARIANT rather than the instance, so the next workflow to grow
 * the pattern fails here instead of shipping green.
 *
 * Offline: parses every `.github/workflows/*.yml` with js-yaml and reads run
 * blocks as text. Never executes a workflow.
 *
 * The three invariants:
 *
 * 1. A path-filtered workflow lists its own file. Otherwise it is the one file
 *    in the repo it cannot gate — a change to it ships unverified and first
 *    executes on some later, unrelated PR (#549).
 *
 * 2. No `git push` has its failure swallowed. `git push … || echo "…"` turns a
 *    remote rejection into a green job; `harness-security.yml` did exactly this
 *    on 8/8 recent runs against a ruleset that rejects every one (#548).
 *
 * 3. No workflow pushes directly to `main`. Ruleset 16189198 carries a
 *    `pull_request` rule with `bypass_actors: []`, so `git push origin HEAD:main`
 *    is unreachable code by construction — there are zero github-actions[bot]
 *    commits on `main` in the repo's entire history. Ledger updates land as a
 *    rolling upsert PR instead.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');

interface Step {
  run?: string;
}
interface Job {
  steps?: Step[];
}
interface Trigger {
  paths?: string[];
}
interface Workflow {
  on?: Record<string, Trigger | unknown>;
  /** YAML 1.1 parses the bare `on:` key as boolean true. */
  true?: Record<string, Trigger | unknown>;
  jobs?: Record<string, Job>;
}

/** Every workflow file, as `[basename, parsed]`. */
function allWorkflows(): Array<[string, Workflow]> {
  return readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort()
    .map((f) => [
      f,
      loadYaml(readFileSync(join(WORKFLOW_DIR, f), 'utf-8')) as Workflow,
    ]);
}

/** The trigger block, accounting for YAML folding `on:` into `true`. */
function triggers(wf: Workflow): Record<string, unknown> {
  return (wf.true ?? wf.on ?? {}) as Record<string, unknown>;
}

/** Every `run:` script in the workflow, as raw text. */
function runBlocks(wf: Workflow): string[] {
  const blocks: string[] = [];
  for (const job of Object.values(wf.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (typeof step.run === 'string') blocks.push(step.run);
    }
  }
  return blocks;
}

/**
 * Join continuation lines so a `git push … || \n  echo …` pair reads as one
 * logical line. Without this the swallow check misses every wrapped instance —
 * which is how all of them were written.
 */
function logicalLines(script: string): string[] {
  return script
    .replace(/\\\r?\n\s*/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

describe('workflow false-green invariants', () => {
  it('finds workflow files to check (zero denominator is an abstention)', () => {
    expect(allWorkflows().length).toBeGreaterThan(0);
  });

  describe('#549 — a path-filtered workflow must list its own file', () => {
    const cases: Array<[string, string, string[]]> = [];
    for (const [name, wf] of allWorkflows()) {
      for (const [event, cfg] of Object.entries(triggers(wf))) {
        const paths = (cfg as Trigger)?.paths;
        if (Array.isArray(paths)) cases.push([name, event, paths]);
      }
    }

    it('has at least one path-filtered trigger to check', () => {
      expect(cases.length).toBeGreaterThan(0);
    });

    it.each(cases)('%s (on: %s) gates its own file', (name, _event, paths) => {
      expect(paths).toContain(`.github/workflows/${name}`);
    });
  });

  describe('#548 — no workflow swallows a push failure', () => {
    const cases: Array<[string, string]> = [];
    for (const [name, wf] of allWorkflows()) {
      for (const line of runBlocks(wf).flatMap(logicalLines)) {
        if (line.includes('git push')) cases.push([name, line]);
      }
    }

    it('has at least one git push to check', () => {
      expect(cases.length).toBeGreaterThan(0);
    });

    it.each(cases)('%s does not swallow: %s', (_name, line) => {
      expect(line).not.toMatch(/git push[^|]*\|\|\s*(echo|true|:)/);
    });

    it.each(cases)('%s does not push straight to main: %s', (_name, line) => {
      expect(line).not.toMatch(/git push\s+\S+\s+HEAD:main\b/);
    });
  });

  /**
   * A workflow that pushes a ledger branch and says nothing about it is a
   * quieter version of the same disease: the job is green, the work really
   * happened, and nobody knows where it went. `gh pr create` used to provide
   * that visibility, until the repo's `can_approve_pull_request_reviews: false`
   * setting refused it (run 30976556644). The step summary replaces it and is
   * pinned here so the visibility cannot be dropped silently later.
   */
  describe('a workflow that pushes a side branch announces where it went', () => {
    const cases: Array<[string, string]> = [];
    for (const [name, wf] of allWorkflows()) {
      for (const script of runBlocks(wf)) {
        const pushesSideBranch = logicalLines(script).some((l) =>
          /git push\s+(--force\s+)?\S+\s+"?HEAD:\$/.test(l),
        );
        if (pushesSideBranch) cases.push([name, script]);
      }
    }

    it('has at least one side-branch push to check', () => {
      expect(cases.length).toBeGreaterThan(0);
    });

    it.each(cases)('%s writes a step summary', (_name, script) => {
      expect(script).toContain('GITHUB_STEP_SUMMARY');
    });
  });
});
