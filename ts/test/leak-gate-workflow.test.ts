/**
 * The leak gate runs under base-repo secrets on fork PRs, so its workflow must
 * never execute head code (#843, ADR 0023).
 *
 * `pull_request_target` + secrets is the classic pwn-request shape, and the
 * platform does not enforce the safe half of it: only this workflow's shape
 * does. ADR 0023 asks for that invariant to be a test rather than a review
 * habit. Each assertion below maps to one of its numbered rules:
 *
 *   1. checkout is the base ref only — no `ref:` / `repository:` override
 *   2. head commits are data — no `git checkout|switch|worktree|archive|reset`
 *   3. the scanner that runs is base's, reading head as blobs
 *   4. no install, build, or head-keyed cache
 *   5. minimal permissions
 *
 * plus: no `${{ }}` inside a `run:` script (event values reach the shell only
 * through `env:`), and the transitional two-step naming (see below): the
 * required context keeps its docs-lint.yml producer until leak-gate.yml is on
 * main, because a required context with no producer blocks every PR forever.
 *
 * Offline: parses YAML and JSON. Never executes a workflow.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');
const CHECK = 'No removed-symbol or proprietary leaks';
const WORKFLOW = 'leak-gate.yml';
/** leak-gate.yml's job name until step 2 renames it to CHECK (#843). */
const TRANSITIONAL_CHECK = 'Leak gate (pull_request_target, transitional)';

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
}
interface Job {
  name?: string;
  if?: string;
  permissions?: unknown;
  steps?: Step[];
}
interface Workflow {
  on?: Record<string, unknown>;
  true?: Record<string, unknown>;
  permissions?: unknown;
  jobs?: Record<string, Job>;
}

function load(file: string): Workflow {
  return loadYaml(readFileSync(join(WORKFLOW_DIR, file), 'utf-8')) as Workflow;
}

const wf = load(WORKFLOW);
const triggers = (wf.true ?? wf.on ?? {}) as Record<string, unknown>;
const jobs = Object.values(wf.jobs ?? {});
const steps = jobs.flatMap((j) => j.steps ?? []);
const gateJob = jobs[0];

describe('leak gate workflow is fork-reachable (#843)', () => {
  it('runs on pull_request_target, not pull_request', () => {
    expect(Object.keys(triggers)).toContain('pull_request_target');
    expect(Object.keys(triggers)).not.toContain('pull_request');
  });

  it('is not path-filtered on the PR trigger (it is required)', () => {
    const prt = triggers['pull_request_target'] as Record<
      string,
      unknown
    > | null;
    expect(prt?.['paths']).toBeUndefined();
    expect(prt?.['paths-ignore']).toBeUndefined();
    expect(prt?.['branches']).toBeUndefined();
  });

  it('still runs on push to main (post-merge detection)', () => {
    const push = triggers['push'] as { branches?: string[] } | null;
    expect(push?.branches).toContain('main');
  });

  /*
   * Two-step migration (#843). `pull_request_target` runs the workflow as it
   * exists on the BASE branch, so on the PR that introduces leak-gate.yml it
   * cannot report at all. Moving the required context in that same PR left it
   * permanently missing and unmergeable (ruleset 16189198 has no bypass). So
   * step 1 keeps docs-lint.yml as the required producer and adds leak-gate.yml
   * under a DISTINCT name; step 2 (a follow-up PR, once this file is on main)
   * renames the job to CHECK and removes the docs-lint.yml job.
   */
  it('step 1: docs-lint.yml still produces the required context on pull_request', () => {
    const docsLint = load('docs-lint.yml');
    const names = Object.values(docsLint.jobs ?? {}).map((j) => j.name);
    expect(names).toContain(CHECK);
    const dlTriggers = (docsLint.true ?? docsLint.on ?? {}) as Record<
      string,
      unknown
    >;
    expect(Object.keys(dlTriggers)).toContain('pull_request');
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, '.github', 'required-checks.json'), 'utf-8'),
    ) as { required: Array<{ check: string; workflow: string }> };
    const entry = manifest.required.find((r) => r.check === CHECK);
    expect(entry?.workflow).toBe('docs-lint.yml');
  });

  it('step 1: leak-gate.yml has exactly one job, named distinctly from the required context', () => {
    expect(jobs.length).toBe(1);
    expect(gateJob?.name).toBe(TRANSITIONAL_CHECK);
    expect(gateJob?.if).toBeUndefined();
    expect(jobs.map((j) => j.name)).not.toContain(CHECK);
  });
});

describe('leak gate never executes head code under secrets (ADR 0023)', () => {
  it('has steps to inspect (zero denominator is an abstention)', () => {
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.filter((s) => s.run).length).toBeGreaterThan(0);
  });

  it('rule 5: permissions are exactly contents read (no API use needs more)', () => {
    expect(wf.permissions).toEqual({ contents: 'read' });
    for (const job of jobs) expect(job.permissions).toBeUndefined();
  });

  it('rule 1: every checkout is the base ref, without persisted credentials', () => {
    const checkouts = steps.filter((s) =>
      s.uses?.startsWith('actions/checkout'),
    );
    expect(checkouts.length).toBe(1);
    for (const s of checkouts) {
      expect(s.with?.['ref']).toBeUndefined();
      expect(s.with?.['repository']).toBeUndefined();
      expect(s.with?.['persist-credentials']).toBe(false);
    }
  });

  it('rule 2/4: no script checks out, archives, installs, or builds', () => {
    const forbidden =
      /\bgit\s+(checkout|switch|worktree|archive|reset|restore|clone|submodule)\b|\b(npm|pnpm|yarn)\s+(i|install|ci|run|exec)\b|\bnpx\b|\bmake\b/;
    for (const s of steps) {
      if (s.run) expect(s.run, s.name).not.toMatch(forbidden);
    }
  });

  it('rule 4: no dependency cache keyed on head files', () => {
    for (const s of steps.filter((x) => x.uses?.startsWith('actions/setup-'))) {
      expect(s.with?.['cache']).toBeUndefined();
    }
    expect(steps.some((s) => s.uses?.startsWith('actions/cache'))).toBe(false);
  });

  it('only first-party actions are used', () => {
    for (const s of steps.filter((x) => x.uses)) {
      expect(s.uses).toMatch(/^actions\/(checkout|setup-node)@/);
    }
  });

  it('no run: script interpolates an expression (event data goes via env)', () => {
    for (const s of steps) {
      if (s.run) expect(s.run, s.name).not.toContain('${{');
    }
  });

  it('rule 3: the scan runs base scripts and reads the head commit as blobs', () => {
    const scan = steps.find((s) =>
      s.run?.includes('scripts/check_removed_symbols.mjs'),
    );
    expect(scan).toBeDefined();
    expect(String(scan?.env?.['CANARY_LEAK_SCAN_TREE'])).toContain(
      'github.event.pull_request.head.sha',
    );
    expect(String(scan?.env?.['CANARY_PROPRIETARY_DENYLIST'])).toContain(
      'secrets.CANARY_PROPRIETARY_DENYLIST',
    );
  });

  it('secrets appear only on the scan step', () => {
    const withSecrets = steps.filter((s) =>
      JSON.stringify(s).includes('secrets.'),
    );
    expect(withSecrets.length).toBe(1);
    expect(withSecrets[0]?.run).toContain('check_removed_symbols.mjs');
  });
});
