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
  uses?: string;
  if?: string;
  with?: Record<string, unknown>;
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

/** Every job in the workflow, as `[jobId, job]`. */
function jobsOf(wf: Workflow): Array<[string, Job]> {
  return Object.entries(wf.jobs ?? {});
}

/**
 * A stdout redirect to a file — `> report.json`, `>> log`.
 *
 * The two exclusions are both real hazards seen in this repo's workflows:
 * a digit before `>` is an fd redirect (`2>/dev/null`), which sends none of
 * the report anywhere and must not count as capture; and `=>` inside an
 * inline `node -e '…'` body is a JS arrow, not a shell redirect. Reading
 * `d=>s+=d` as "captured to file `s+=d`" would silently pass a step that
 * dumps its whole report to the log.
 */
const STDOUT_TO_FILE =
  /(?:^|[^0-9&=<>!+-])>>?\s*([A-Za-z0-9_./$"'-][^\s;|&)]*)/;

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
  /**
   * #542 — a required check must run on every PR.
   *
   * `main`'s ruleset carried NO `required_status_checks` rule at all, so every
   * check in this repo was advisory: PR #540 merged while `markdownlint` was
   * reporting FAILURE and `main` went red. The fix is a required set — but a
   * required check that sits behind a `paths:` filter is worse than none. It
   * never reports on a PR that does not touch its paths, GitHub shows it as
   * "Expected — waiting for status" forever, and the PR can never merge.
   *
   * `.github/required-checks.json` is the in-repo record of that decision, and
   * these tests keep it honest in both directions: every required check runs
   * unconditionally, and every check-producing job is accounted for as either
   * required or advisory-with-a-stated-reason. A new job that is neither fails
   * here rather than joining the advisory pile by default — "nobody configured
   * it" is exactly the state #542 was filed about.
   */
  describe('#542 — required checks run on every PR', () => {
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, '.github', 'required-checks.json'), 'utf-8'),
    ) as {
      required: Array<{ check: string; workflow: string }>;
      advisory: Array<{ check: string; workflow: string; reason: string }>;
    };

    /** The check name GitHub reports for a job: its `name`, else its job id. */
    function checkNames(wf: Workflow): string[] {
      return Object.entries(wf.jobs ?? {}).map(
        ([id, job]) => (job as { name?: string }).name ?? id,
      );
    }

    /** Workflows that report a check on a pull request. */
    function prWorkflows(): Array<[string, Workflow]> {
      return allWorkflows().filter(([, wf]) => 'pull_request' in triggers(wf));
    }

    it('lists checks to enforce (zero denominator is an abstention)', () => {
      expect(manifest.required.length).toBeGreaterThan(0);
      expect(prWorkflows().length).toBeGreaterThan(0);
    });

    it.each(manifest.required.map((r) => [r.check, r.workflow]))(
      'required check %s is produced by %s',
      (check, workflow) => {
        const wf = allWorkflows().find(([n]) => n === workflow)?.[1];
        expect(wf, `${workflow} not found`).toBeDefined();
        expect(checkNames(wf!)).toContain(check);
      },
    );

    it.each(
      [...new Set(manifest.required.map((r) => r.workflow))].map((w) => [w]),
    )('%s runs on every PR (no paths filter)', (workflow) => {
      const wf = allWorkflows().find(([n]) => n === workflow)?.[1];
      const pr = triggers(wf!)['pull_request'] as Trigger | null;
      expect(pr?.paths).toBeUndefined();
      expect(
        (pr as { 'paths-ignore'?: string[] } | null)?.['paths-ignore'],
      ).toBeUndefined();
    });

    it('every PR check is either required or advisory with a reason', () => {
      const classified = new Map<string, string>();
      for (const r of manifest.required) classified.set(r.check, 'required');
      for (const a of manifest.advisory) {
        expect(a.reason.trim(), `${a.check} has an empty reason`).not.toBe('');
        classified.set(a.check, 'advisory');
      }
      const unclassified: string[] = [];
      for (const [, wf] of prWorkflows())
        for (const check of checkNames(wf))
          if (!classified.has(check)) unclassified.push(check);
      expect(unclassified).toEqual([]);
    });

    it('no check is listed as both required and advisory', () => {
      const required = new Set(manifest.required.map((r) => r.check));
      const both = manifest.advisory
        .map((a) => a.check)
        .filter((c) => required.has(c));
      expect(both).toEqual([]);
    });
  });

  /**
   * #588 — a machine-readable report must be readable.
   *
   * `harness.yml` ran `harness ci check --json` with the 162 KB report going
   * straight to stdout, and TWO independent truncations meant nobody could
   * ever read it: the Actions log stops at 60 KB, and Node's stdout is async
   * when it is a pipe, so `process.exit()` drops whatever is still buffered
   * (~64 KB). Both cuts are silent — no marker, no closing brace.
   *
   * The consequence on PR #584: the job failed with exit 1 while the visible
   * log showed four checks, all pass/warn, zero error-severity findings. The
   * real cause, `arch: fail`, was one of the five checks past the cut. A
   * failing job whose log reads "nothing failed" is the same false-green shape
   * as #548 and #549, just produced by a byte limit instead of a swallowed
   * exit code.
   *
   * Two invariants, because dodging one truncation does not dodge the other:
   *
   * 1. `--json` output never goes straight to the log. Redirecting to a file
   *    (or piping into a consumer) also makes Node's stdout synchronous, which
   *    is what fixes the 64 KB pipe cut — not just the 60 KB log cut.
   *
   * 2. A report written to a file is uploaded with `if: always()`. Without the
   *    upload the file dies with the runner, so on the failing run — the only
   *    run anyone needs it for — it is exactly as unreachable as before.
   */
  describe('#588 — a --json report is readable after the run', () => {
    /** `[workflow, jobId, logical line]` for every `--json` invocation. */
    const jsonLines: Array<[string, string, string]> = [];
    /** `[workflow, jobId, filename]` for every report redirected to a file. */
    const reportFiles: Array<[string, string, string]> = [];

    for (const [name, wf] of allWorkflows()) {
      for (const [jobId, job] of jobsOf(wf)) {
        const scripts = (job.steps ?? [])
          .map((s) => s.run)
          .filter((r): r is string => typeof r === 'string');
        for (const line of scripts.flatMap(logicalLines)) {
          if (!line.includes('--json')) continue;
          jsonLines.push([name, jobId, line]);
          const target = STDOUT_TO_FILE.exec(line)?.[1];
          if (target) reportFiles.push([name, jobId, target]);
        }
      }
    }

    it('has --json invocations to check (zero denominator is an abstention)', () => {
      expect(jsonLines.length).toBeGreaterThan(0);
      expect(reportFiles.length).toBeGreaterThan(0);
    });

    it.each(jsonLines)(
      '%s/%s does not dump --json to the log: %s',
      (_name, _jobId, line) => {
        const captured = STDOUT_TO_FILE.test(line) || line.includes('|');
        expect(
          captured,
          'send --json to a file or a consumer; the Actions log truncates at 60 KB',
        ).toBe(true);
      },
    );

    it.each(reportFiles)(
      '%s/%s uploads %s as an artifact',
      (name, jobId, file) => {
        const job = allWorkflows().find(([n]) => n === name)?.[1].jobs?.[jobId];
        const uploads = (job?.steps ?? []).filter((s) =>
          s.uses?.startsWith('actions/upload-artifact'),
        );
        const forThisFile = uploads.filter((s) =>
          String(s.with?.path ?? '').includes(file),
        );
        expect(
          forThisFile.length,
          `no upload step for ${file}`,
        ).toBeGreaterThan(0);
        // The property is "still uploads when the job failed", which both
        // `always()` and `!cancelled()` satisfy. `harness.yml` prefers the
        // latter because its `cancel-in-progress: true` would otherwise fire
        // this step on every superseded run.
        for (const step of forThisFile) {
          expect(
            step.if,
            `${file} is uploaded only on success — useless on the run that failed`,
          ).toMatch(/always\(\)|!\s*cancelled\(\)/);
        }
      },
    );
  });
});
