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
  id?: string;
  name?: string;
  run?: string;
  uses?: string;
  if?: string;
  with?: Record<string, unknown>;
  'continue-on-error'?: boolean;
}
interface Job {
  steps?: Step[];
}
interface Trigger {
  paths?: string[];
  /** `push.branches`, read by the post-merge-detection assertions below. */
  branches?: string[];
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

/**
 * An actual `harness … --update-baseline` invocation.
 *
 * `harness` must sit in command position (line start, or after `;`, `&&`,
 * `||`, `(`) — otherwise the very error message that quotes the command it is
 * warning about gets collected as an invocation of it, and the check fails on
 * its own diagnostic text.
 */
const UPDATE_BASELINE_CALL =
  /(?:^|[;&|(]\s*)harness\s+[\w-]+(?=[^;&|]*--update-baseline\b)/;

/**
 * The repo's own baseline refresh (#749).
 *
 * `harness check-arch --update-baseline` writes an ALLOWANCE at CLI 11.x and
 * leaves `baselines.json` byte-identical, so the flag above no longer denotes a
 * baseline mutation at all. This script is what mutates the baseline now, and
 * the #634 invariants (fail on no change, do not spend the label) apply to it
 * for exactly the same reasons.
 */
const REFRESH_BASELINE_CALL = /\brefresh-arch-baseline\.mjs\b/;

/**
 * The opening `if` of a "did anything change?" guard, in either idiom.
 *
 * Matching both is deliberate: the assertion below requires the porcelain
 * form, so a collector that recognised only `git status --porcelain` would
 * find nothing the day someone regressed a guard back to `git diff` — the
 * check would abstain at exactly the moment it was needed.
 */
const NO_CHANGE_GUARD = /^if\b.*(?:git diff --quiet|git status --porcelain)/;

/** Repo-relative paths a guard inspects or a `git add` stages. */
function harnessPaths(line: string): string[] {
  return [...line.matchAll(/\.harness\/[\w./-]*/g)].map((m) =>
    m[0].replace(/\/$/, ''),
  );
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

    /**
     * PR triggers. `pull_request_target` counts (#843, ADR 0023): it reports a
     * check on the PR exactly like `pull_request`, only in base-repo context.
     */
    const PR_TRIGGERS = ['pull_request', 'pull_request_target'];

    /** Workflows that report a check on a pull request. */
    function prWorkflows(): Array<[string, Workflow]> {
      return allWorkflows().filter(([, wf]) =>
        PR_TRIGGERS.some((t) => t in triggers(wf)),
      );
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
      const present = PR_TRIGGERS.filter((t) => t in triggers(wf!));
      // A required workflow with no PR trigger at all never reports.
      expect(present.length).toBeGreaterThan(0);
      for (const t of present) {
        const pr = triggers(wf!)[t] as Trigger | null;
        expect(pr?.paths).toBeUndefined();
        expect(
          (pr as { 'paths-ignore'?: string[] } | null)?.['paths-ignore'],
        ).toBeUndefined();
      }
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
   * #769 — an external app status is outside this suite's denominator.
   *
   * Everything above enumerates checks by parsing workflow YAML, so a commit
   * status posted by a GitHub App rather than by a job in
   * `.github/workflows/` is invisible to it BY CONSTRUCTION. That is not a
   * hypothetical: the `Vercel` context reported FAILURE on every PR and on
   * `main` from 3659ea9 onward, and nothing in the repo accounted for it. It
   * is not in ruleset 16189198's required contexts, so it blocked nothing —
   * which is precisely the harm. A check that is ALWAYS red is
   * indistinguishable from a check that is red because something broke, so it
   * trains reviewers to skim past a red X. #542 was the same signal erosion
   * from the other direction: there nothing could stop a merge, here
   * something always looked like it should.
   *
   * The fix is a denominator this suite cannot compute: an explicit
   * `externalStatuses` list in the manifest. These tests keep that list
   * honest — every entry names its producer and states in prose why it is
   * acceptable, and an entry claiming a repo-side suppression must actually
   * carry it. What they cannot do is discover an app status nobody wrote
   * down; that still needs a human reading a PR page, which is why the entry
   * for a suppressed status asserts the suppression file rather than trusting
   * the note.
   */
  describe('#769 — external app statuses are written down', () => {
    interface ExternalStatus {
      context: string;
      producer: string;
      blocking: boolean;
      expected: string;
      reason: string[];
    }
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, '.github', 'required-checks.json'), 'utf-8'),
    ) as {
      required: Array<{ check: string }>;
      advisory: Array<{ check: string }>;
      externalStatuses?: { statuses?: ExternalStatus[] };
    };
    const statuses = manifest.externalStatuses?.statuses ?? [];

    it('records at least one (a zero denominator is an abstention)', () => {
      // The repo has a known app status. An empty list here would mean the
      // section was gutted, not that the apps went away.
      expect(statuses.length).toBeGreaterThan(0);
    });

    it.each(statuses.map((s) => [s.context]))(
      '%s names a producer and a non-empty reason',
      (context) => {
        const status = statuses.find((s) => s.context === context)!;
        expect(status.producer.trim()).not.toBe('');
        expect(typeof status.blocking).toBe('boolean');
        expect(status.reason.join('').trim()).not.toBe('');
      },
    );

    it('does not double-classify a status that a workflow produces', () => {
      const fromWorkflows = new Set([
        ...manifest.required.map((r) => r.check),
        ...manifest.advisory.map((a) => a.check),
      ]);
      const overlap = statuses
        .map((s) => s.context)
        .filter((c) => fromWorkflows.has(c));
      expect(overlap).toEqual([]);
    });

    it('backs an expected:none entry with a repo-side suppression', () => {
      // The Vercel Git integration reads `git.deploymentEnabled` from
      // vercel.json and skips creating a deployment, so no status is posted.
      // Asserting the file — not the prose — is what makes a silent deletion
      // of the suppression fail here instead of on a PR page weeks later.
      const suppressed = statuses.filter((s) => s.expected === 'none');
      expect(suppressed.map((s) => s.context)).toContain('Vercel');
      const vercelConfig = JSON.parse(
        readFileSync(join(REPO_ROOT, 'vercel.json'), 'utf-8'),
      ) as { git?: { deploymentEnabled?: boolean } };
      expect(vercelConfig.git?.deploymentEnabled).toBe(false);
    });
  });

  /**
   * #1056 — a ruleset rule that produces no status context is invisible here.
   *
   * This suite enumerates PR checks by parsing workflow YAML, so it can only
   * ever see the one ruleset rule that happens to be made of check contexts
   * (`required_status_checks`). The other five rules on ruleset 16189198 —
   * `deletion`, `non_fast_forward`, `pull_request`, `code_quality`,
   * `copilot_code_review` — gate merges to `main` without emitting anything a
   * workflow file mentions. That is the same structural blind spot #769
   * documented for app-produced statuses, and the reason this gap could not
   * have been caught by the existing tests: the manifest opens by calling
   * itself "the source of truth a human can read" while accounting for 2 of 6
   * rules, and nothing disagreed.
   *
   * The fix is again a denominator the suite cannot compute for itself: an
   * explicit `rulesetRules` list, one entry per live rule, each with a boolean
   * verdict and a stated reason. These tests keep that list honest and pin the
   * observed rule-type set, so recording a new rule without a verdict — or
   * quietly deleting a recorded one — fails here. What they cannot do is
   * discover a rule nobody wrote down; that still needs the `gh api` line in
   * the section header, exactly as it does for `strict`.
   */
  describe('#1056 — every live ruleset rule has a recorded verdict', () => {
    interface RulesetRule {
      rule: string;
      blocking: boolean;
      parameters?: Record<string, unknown>;
      reason: string[];
    }
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, '.github', 'required-checks.json'), 'utf-8'),
    ) as {
      rulesetRules?: { rules?: RulesetRule[] };
      reviews?: Record<string, unknown>;
      required: { check: string; workflow: string }[];
    };
    const rules = manifest.rulesetRules?.rules ?? [];

    // Pinned from `gh api repos/bop-clocktower/canary/rulesets/16189198
    // --jq '.rules[].type'` on 2026-09-22. Recording a new rule without a
    // verdict, or deleting a recorded one, fails here.
    const OBSERVED_RULE_TYPES = [
      'code_quality',
      'copilot_code_review',
      'deletion',
      'non_fast_forward',
      'pull_request',
      'required_status_checks',
    ];

    // The verdict per rule type, pinned from the same live read. Asserting
    // only `typeof blocking === 'boolean'` would pass if every verdict
    // flipped to false, which is the one direction that matters: it would
    // silently turn this record into "nothing here gates a merge". Five rules
    // block; `copilot_code_review` does not, because it produces review
    // comments rather than a merge verdict and
    // `required_approving_review_count` does not count it.
    const EXPECTED_BLOCKING: Record<string, boolean> = {
      code_quality: true,
      copilot_code_review: false,
      deletion: true,
      non_fast_forward: true,
      pull_request: true,
      required_status_checks: true,
    };

    it('records at least one (a zero denominator is an abstention)', () => {
      expect(rules.length).toBeGreaterThan(0);
    });

    it('pins the observed rule-type set', () => {
      expect(rules.map((r) => r.rule).sort()).toEqual(OBSERVED_RULE_TYPES);
    });

    // The zero-denominator guard for this it.each is deliberate and lives in
    // the sibling 'records at least one' test above — do not simplify it away.
    it.each(rules.map((r) => [r.rule]))(
      '%s carries its expected verdict and a non-empty reason',
      (rule) => {
        const entry = rules.find((r) => r.rule === rule)!;
        expect(entry.blocking).toBe(EXPECTED_BLOCKING[rule as string]);
        expect(entry.reason.join('').trim()).not.toBe('');
      },
    );

    // The parameters are the most mechanically falsifiable content in the
    // section — they are copied from the live ruleset and can be re-read in
    // one command — so leaving them unasserted would be the easiest place for
    // this record to drift without anything noticing.
    it('pins the code_quality severity', () => {
      const entry = rules.find((r) => r.rule === 'code_quality')!;
      expect(entry.parameters).toEqual({ severity: 'errors' });
    });

    it('pins the pull_request review flags', () => {
      const entry = rules.find((r) => r.rule === 'pull_request')!;
      expect(entry.parameters).toMatchObject({
        required_approving_review_count: 0,
        require_extra_approval_for_unattributed_changes: true,
        dismiss_stale_reviews_on_push: false,
        require_last_push_approval: false,
        require_code_owner_review: false,
        required_review_thread_resolution: false,
      });
    });

    // #1056 review finding 3: `contexts` is a second copy of a fact the
    // manifest already holds in full. Adding a 14th required check must not
    // be able to leave the count silently stale.
    it('keeps the recorded context count equal to the required list', () => {
      const entry = rules.find((r) => r.rule === 'required_status_checks')!;
      const params = entry.parameters as {
        contexts?: number;
        strict_required_status_checks_policy?: boolean;
      };
      expect(params.contexts).toBe(manifest.required.length);
      expect(params.strict_required_status_checks_policy).toBe(true);
    });

    it('states the effective review requirement, not just the count', () => {
      const reviews = manifest.reviews as {
        required_approving_review_count?: number;
        require_extra_approval_for_unattributed_changes?: boolean;
        reason?: string | string[];
      };
      expect(reviews.required_approving_review_count).toBe(0);
      expect(reviews.require_extra_approval_for_unattributed_changes).toBe(
        true,
      );
      const prose = ([] as string[]).concat(reviews.reason ?? []).join(' ');
      expect(prose).toMatch(/unattributed/i);
    });

    it('records access posture as aggregate counts, never accounts', () => {
      const reviews = manifest.reviews as {
        accessPosture?: Record<string, number>;
      };
      const posture = reviews.accessPosture ?? {};
      expect(Object.keys(posture).length).toBeGreaterThan(0);
      // Checking only that the VALUES are numbers leaves the keys
      // uninspected, so `{"some-login": 1}` would pass — an enumerated
      // account in a public repo, which is the exact thing this record
      // promises never to carry. Assert the key set against GitHub's role
      // vocabulary instead: a login can never be a member of it.
      const ROLES = ['admin', 'maintain', 'write', 'triage', 'read'];
      for (const [role, count] of Object.entries(posture)) {
        expect(ROLES).toContain(role);
        expect(typeof count).toBe('number');
      }
    });
  });

  /**
   * #678 — a PR-time green is a verdict about a tree that may never merge.
   *
   * `harness check-arch` reported pass on #660's PR and failed on the identical
   * commit once it was on `main`; #663 then inherited the failure and read as
   * its cause. The mechanism: when GitHub's
   * `strict_required_status_checks_policy` is false a PR merges without being
   * up to date with `main`, and the default `actions/checkout` on
   * `pull_request` checks out the merge commit computed for that event — head
   * merged into `main` as of the last push to the PR BRANCH. Base movement
   * fires no check run, so nothing re-measures. PR-time and post-merge are
   * answers to two different questions.
   *
   * The policy is TRUE on the ruleset and that gap is closed. Note what these
   * tests could NOT catch: the manifest recorded `false` from 2026-08-12 —
   * six minutes before the ruleset was last edited to say otherwise — until
   * 2026-09-03, three weeks, because the only assertion below is that the key
   * is a boolean. Comparing the copy to the live ruleset
   * needs a network call and a token, which is not something this offline suite
   * should grow — so the manifest stays a human-maintained record, and the
   * `gh api` line in its own header is the reconciliation step. Treat a
   * disagreement between them as the manifest being wrong.
   *
   * What is enforced here is that the state is RECORDED and that the
   * post-merge mitigation stays in place: every workflow behind
   * a required check also runs on `push: main`, so a stale green is caught on
   * `main` within one run instead of surfacing as the next PR's failure. A
   * required check that only ever runs on pull requests would put the repo back
   * where #660 left it, and the exemption list makes that a deliberate edit.
   */
  describe('#678 — the PR-time-vs-post-merge gap is recorded and bounded', () => {
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, '.github', 'required-checks.json'), 'utf-8'),
    ) as {
      required: Array<{ check: string; workflow: string }>;
      mergePolicy?: {
        strict?: boolean;
        postMergeDetection?: { prOnlyByNature?: string[] };
      };
    };

    it('records the branch-freshness policy rather than leaving it implicit', () => {
      // Recorded either way. Either value is a stated position with the #678
      // reasoning attached; a missing key is the "nobody configured it" state
      // that #542 was filed about. This does not check the value against the
      // live ruleset — see the note above on why, and on the drift it let
      // through.
      expect(typeof manifest.mergePolicy?.strict).toBe('boolean');
    });

    it('names which required workflows are pull-request-only, if any', () => {
      expect(
        Array.isArray(manifest.mergePolicy?.postMergeDetection?.prOnlyByNature),
      ).toBe(true);
    });

    it('runs every required workflow on main so a stale green is caught there', () => {
      const exempt = new Set(
        manifest.mergePolicy?.postMergeDetection?.prOnlyByNature ?? [],
      );
      const workflows = [...new Set(manifest.required.map((r) => r.workflow))];
      // Zero denominator is an abstention: an empty required set would make
      // the loop below vacuously true.
      expect(workflows.length).toBeGreaterThan(0);
      const missing: string[] = [];
      for (const name of workflows) {
        if (exempt.has(name)) continue;
        const wf = allWorkflows().find(([n]) => n === name)?.[1];
        const push = triggers(wf!)['push'] as Trigger | null;
        if (!push?.branches?.includes('main')) missing.push(name);
      }
      expect(missing).toEqual([]);
    });

    it('keeps the exemption list to workflows that really are PR-only', () => {
      const exempt =
        manifest.mergePolicy?.postMergeDetection?.prOnlyByNature ?? [];
      const wrong = exempt.filter((name) => {
        const wf = allWorkflows().find(([n]) => n === name)?.[1];
        const push = triggers(wf!)['push'] as Trigger | null;
        return push?.branches?.includes('main') === true;
      });
      expect(wrong).toEqual([]);
    });

    it('does not let the Architecture Enforcer job claim the arch ratchet', () => {
      // The secondary #678 symptom: CI's "Architecture Enforcer" passes while a
      // local `harness check-arch` exits 1. Not one gate disagreeing with
      // itself — the `enforce` job runs `check-deps` and `validate`, and never
      // reads the baseline. The ratchet is gated by `harness.yml`. If someone
      // ever moves `check-arch` into the enforcer, this test says so and the
      // manifest comment has to be rewritten with it.
      const arch = allWorkflows().find(
        ([n]) => n === 'harness-architecture.yml',
      )?.[1];
      expect(arch).toBeDefined();
      const commands = runBlocks(arch!).flatMap(logicalLines);
      expect(commands.length).toBeGreaterThan(0);
      expect(commands.some((c) => c.includes('check-arch'))).toBe(false);

      const gating = allWorkflows().find(([n]) => n === 'harness.yml')?.[1];
      const gatingCommands = runBlocks(gating!).flatMap(logicalLines);
      expect(gatingCommands.some((c) => c.includes('check-arch'))).toBe(true);
    });

    it('lets the summariser step fail the job, since it gates new arch violations (#968)', () => {
      // `harness ci check` exits 0 on a new threshold violation, so the
      // summariser's exit 1 is the only thing that blocks one. A `|| true` or a
      // `continue-on-error` on that step would reopen #968 with every test in
      // arch-verdict.test.ts still green.
      const gating = allWorkflows().find(([n]) => n === 'harness.yml')?.[1];
      const steps = Object.values(gating?.jobs ?? {}).flatMap(
        (j) => j.steps ?? [],
      );
      const summarisers = steps.filter((s) =>
        s.run?.includes('harness-report-summary.mjs'),
      );
      expect(summarisers.length).toBeGreaterThan(0);
      for (const step of summarisers) {
        const lines = logicalLines(step.run!);
        expect(lines.some((l) => /\|\|\s*(true|:|exit 0)/.test(l))).toBe(false);
        expect(step['continue-on-error']).not.toBe(true);
        expect(lines.some((l) => l.includes('--arch'))).toBe(true);
      }
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
          // A comment cannot dump anything. Prose explaining the --json
          // contract used to trip this as if it were an invocation (#716).
          // `echo` lines are deliberately NOT skipped: `echo $(cmd --json)`
          // is a real dump wearing an echo.
          if (line.trimStart().startsWith('#')) continue;
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

  /**
   * #634 — an opt-in mutation workflow must fail when it mutated nothing.
   *
   * `refresh-arch-baseline.yml` exists to refresh `.harness/arch/baselines.json`
   * when the ratchet is red, and a red ratchet is the only reason anyone applies
   * the `refresh-baseline` label. But it ran `harness check-arch
   * --update-baseline` bare, and on a regression the CLI *declines to write* —
   * while exiting 0 — telling the caller to re-run with `--allow-regress
   * --reason`. The job then saw a clean `git diff`, printed "Baseline already
   * current; nothing to refresh", went green, and the `if: always()` cleanup
   * consumed the label. The operator spent the opt-in, got a green run, and the
   * ratchet was still red.
   *
   * "Nothing to refresh" and "refused to refresh" were indistinguishable at the
   * call site — the same false-green shape as a zero denominator, which is why
   * this belongs in this file rather than in a workflow-specific one.
   *
   * Three invariants, one per link in that chain:
   *
   * 1. A `--update-baseline` invocation carries `--allow-regress --reason`.
   *    Without them the command is a no-op on the only input it is ever given.
   *
   * 2. In a label-gated workflow, a no-change guard fails rather than exiting 0.
   *    The label was applied precisely because a change was wanted, so a run
   *    that changed nothing has not done what it was asked.
   *
   * 3. The step that consumes the opt-in label does not run with `if: always()`.
   *    A run that refreshed nothing must leave the label in place.
   */
  describe('#634 — an opt-in mutation workflow fails when it changed nothing', () => {
    /**
     * `[workflow, logical line]` for every step that mutates a baseline —
     * a `--update-baseline` invocation or a `refresh-arch-baseline.mjs` run.
     */
    const updateBaseline: Array<[string, string]> = [];
    /** `[workflow, run script]` for no-change guards in label-gated workflows. */
    const noChangeGuards: Array<[string, string]> = [];
    /** `[workflow, step]` for every step that consumes an opt-in label. */
    const labelConsumers: Array<[string, Step]> = [];
    /** `[workflow, run script]` for steps that stage paths in a label-gated job. */
    const stagingSteps: Array<[string, string]> = [];

    /** Route one step into whichever collectors it belongs to. */
    function classify(name: string, labelGated: boolean, step: Step): void {
      if (typeof step.run !== 'string') return;
      const lines = logicalLines(step.run);
      const matches = lines.filter(
        (l) => UPDATE_BASELINE_CALL.test(l) || REFRESH_BASELINE_CALL.test(l),
      );
      updateBaseline.push(...matches.map((l): [string, string] => [name, l]));
      if (step.run.includes('--remove-label'))
        labelConsumers.push([name, step]);
      if (!labelGated) return;
      if (lines.some((l) => NO_CHANGE_GUARD.test(l)))
        noChangeGuards.push([name, step.run]);
      if (/\bgit add\b/.test(step.run)) stagingSteps.push([name, step.run]);
    }

    for (const [name, wf] of allWorkflows()) {
      const pr = triggers(wf)['pull_request'] as { types?: string[] } | null;
      const labelGated = (pr?.types ?? []).includes('labeled');
      for (const [, job] of jobsOf(wf))
        for (const step of job.steps ?? []) classify(name, labelGated, step);
    }

    /**
     * The body of the `if git diff --quiet …; then` branch — the path taken
     * when nothing changed. Tracks `if`/`fi` depth so a nested conditional
     * inside the branch does not end it early.
     */
    function noChangeBranch(script: string): string[] {
      const lines = logicalLines(script);
      const start = lines.findIndex((l) => NO_CHANGE_GUARD.test(l));
      if (start === -1) return [];
      const body: string[] = [];
      let depth = 1;
      for (const line of lines.slice(start + 1)) {
        if (/^if\b/.test(line)) depth += 1;
        if (/^fi\b/.test(line)) {
          depth -= 1;
          if (depth === 0) break;
        }
        body.push(line);
      }
      return body;
    }

    it('has opt-in mutation steps to check (zero denominator is an abstention)', () => {
      expect(updateBaseline.length).toBeGreaterThan(0);
      expect(noChangeGuards.length).toBeGreaterThan(0);
      expect(labelConsumers.length).toBeGreaterThan(0);
    });

    it.each(updateBaseline)(
      '%s passes the regression opt-in through: %s',
      (_name, line) => {
        // Only the CLI form needs the flags: harness declines a regressing
        // `--update-baseline` while exiting 0 unless both are present (#634).
        // `refresh-arch-baseline.mjs` has no such trapdoor — it refuses unsafe
        // writes internally (a lowered value, an absent `currentValue`) with a
        // distinct exit code rather than a silent zero, so there is no opt-in
        // to forget. Asserting the flags on it would be cargo-culted.
        if (!UPDATE_BASELINE_CALL.test(line)) {
          expect(REFRESH_BASELINE_CALL.test(line)).toBe(true);
          return;
        }
        expect(
          line,
          'harness declines a regressing --update-baseline and exits 0',
        ).toMatch(/--allow-regress\b/);
        expect(line, '--allow-regress requires --reason').toMatch(/--reason\b/);
      },
    );

    it.each(noChangeGuards)(
      '%s treats "nothing changed" as a failure',
      (_name, script) => {
        const body = noChangeBranch(script);
        expect(body.length, 'no-change guard body not found').toBeGreaterThan(
          0,
        );
        expect(
          body,
          'the label asked for a change; changing nothing is not success',
        ).not.toContain('exit 0');
        expect(body.join('\n')).toMatch(/exit 1\b/);
      },
    );

    it.each(labelConsumers.map(([n, s]) => [n, s.if ?? '(no if)']))(
      '%s does not consume the opt-in label unconditionally (if: %s)',
      (_name, condition) => {
        expect(
          condition,
          'a run that refreshed nothing must leave the label in place',
        ).not.toMatch(/\balways\(\)/);
      },
    );

    /*
     * #634 follow-up — detection must see NEW files, and staging must cover
     * everything detection looks at.
     *
     * On CLI 11 `--update-baseline --allow-regress` does not rewrite
     * `baselines.json` at all: it writes a per-branch file under
     * `.harness/arch/allowances/` and says so ("baselines.json stays
     * byte-identical to the base"), recording `--reason` in
     * `.harness/audit.log`. So the guard was watching a path the CLI
     * deliberately leaves alone — and even pointed at the right path it would
     * still have missed it, because an allowance is an UNTRACKED file and
     * `git diff` never reports those. The workflow failed honestly (thanks to
     * the guard above) while reporting the wrong cause.
     *
     * Two invariants, both about the guard telling the truth:
     *
     * 4. The guard uses `git status --porcelain`, which lists untracked files,
     *    rather than `git diff`, which cannot. A mutation that creates a file
     *    is the normal case here, not an edge one.
     *
     * 5. Every path the guard inspects is also staged. A guard that passes on
     *    a path `git add` omits produces a green run and an empty commit —
     *    the same lie in a later disguise.
     */
    it.each(noChangeGuards)(
      '%s detects created files, not just modified ones',
      (_name, script) => {
        const guard = logicalLines(script).find((l) => NO_CHANGE_GUARD.test(l));
        expect(guard, 'no-change guard not found').toBeDefined();
        expect(
          guard,
          'an allowance is a NEW file; `git diff` never reports untracked paths',
        ).toMatch(/git status --porcelain/);
      },
    );

    it.each(noChangeGuards)(
      '%s stages every path its no-change guard inspects',
      (name, script) => {
        const guard =
          logicalLines(script).find((l) => NO_CHANGE_GUARD.test(l)) ?? '';
        const inspected = harnessPaths(guard);
        expect(
          inspected.length,
          'guard inspects no .harness path (zero denominator)',
        ).toBeGreaterThan(0);

        const staged = (stagingSteps.find(([n]) => n === name)?.[1] ?? '')
          .split('\n')
          .filter((l) => /\bgit add\b/.test(l))
          .flatMap(harnessPaths);
        const uncovered = inspected.filter(
          (path) => !staged.some((s) => path === s || path.startsWith(`${s}/`)),
        );
        expect(
          uncovered,
          'the guard inspects these paths but no `git add` stages them',
        ).toEqual([]);
      },
    );
  });

  /**
   * #716 — the dogfood loop must actually run the detectors this repo ships.
   *
   * `dogfood.yml` exists on the stated premise that "a test-intelligence tool
   * that has never read its own tests is making a claim it cannot support".
   * `vacuity-check` shipped in #714 and was never added to the loop, so 101
   * findings across our own suites gated nothing — the claim outran the CI.
   *
   * This asserts the instance, not yet the class: a generic "every check
   * subcommand is wired or exempt" invariant is the follow-up on #716. What is
   * pinned here is the pairing that was actually wrong, plus the reason
   * `promote-check` is correctly NOT in this loop — it is a single-file gate
   * and abstains (exit 3) on a directory, so wiring it would manufacture a
   * permanent abstention rather than coverage.
   */
  describe('#716 — the dogfood loop runs the suite-scanning detectors', () => {
    /** Commands that scan a directory of tests and belong in the loop. */
    const SUITE_SCANNERS = ['review-test', 'flake-check', 'vacuity-check'];

    /** Single-file gates, which abstain on a directory by design. */
    const NOT_SUITE_SCANNERS = ['promote-check'];

    const dogfood = allWorkflows().find(([name]) => name === 'dogfood.yml');

    it('finds dogfood.yml to check (zero denominator is an abstention)', () => {
      expect(dogfood, 'dogfood.yml is missing').toBeDefined();
    });

    const scripts = runBlocks(dogfood?.[1] ?? {}).join('\n');

    /**
     * Comments are excluded deliberately. The prose below the step name names
     * every command in this list, so matching raw text would keep passing if
     * someone deleted a command from the loop and left the paragraph behind --
     * a green test measuring documentation instead of behaviour.
     */
    const executable = logicalLines(scripts).filter(
      (line) => !line.trimStart().startsWith('#'),
    );

    it.each(SUITE_SCANNERS)('dogfood.yml runs %s', (cmd) => {
      expect(
        executable.filter((line) => line.includes(cmd)),
        `${cmd} scans a suite but no executable line in dogfood.yml invokes it`,
      ).not.toEqual([]);
    });

    /**
     * The loop counts findings by parsing `--json`, and the checks do not agree
     * on a shape: `review-test`/`flake-check` emit a bare array while
     * `vacuity-check` emits `{checked, abstained, findings, skipped}`. Reading
     * `.length` off the envelope gives `undefined`, which `$(( ))` silently
     * folds to 0 -- the check runs, finds 101 things, and reports a clean 0.
     * A count that cannot be read is an abstention, not a zero (#508).
     */
    it('never lets an unreadable finding count fall back to zero', () => {
      expect(
        scripts,
        'a `catch`/fallback that yields 0 turns a broken count into a clean run',
      ).not.toMatch(/catch\s*\{?\s*console\.log\(\s*0\s*\)/);
    });

    it('treats an uncountable --json result as a failure', () => {
      expect(
        executable.filter((line) => line.includes('Dogfood count unreadable')),
        'the counter must emit a non-numeric sentinel the shell can reject',
      ).not.toEqual([]);
    });

    it.each(NOT_SUITE_SCANNERS)(
      'dogfood.yml does not put %s in a directory loop',
      (cmd) => {
        const inDirLoop = executable.some(
          (line) => line.includes(cmd) && /\$dir\b|\$\{dir\}/.test(line),
        );
        expect(
          inDirLoop,
          `${cmd} is a single-file gate; a directory makes it abstain, not pass`,
        ).toBe(false);
      },
    );
  });

  describe('#717 — a wired check is not scoped into silence', () => {
    /**
     * `check-perf`'s sub-flags, every one of which turns the check into a
     * green tick over findings it should be reporting.
     *
     * Measured on the same tree in the same minute at 8c865b5, CLI 11.1.1:
     *
     *   harness check-perf              -> x Validation failed (237 issues)
     *   harness check-perf --structural -> x Validation failed (209 issues)
     *   harness check-perf --coupling   -> v validation passed
     *   harness check-perf --size       -> v validation passed
     *
     * The 237 is 209 structural + 26 coupling-ratio + 2 import-count. So
     * `--coupling` reports a PASS over the 28 findings that are its own
     * subject, and `--structural` reports a real number over a silently
     * reduced denominator. `--severity` is here for the same reason by its
     * own documentation: "violations below it are excluded from the report
     * and never fail the gate".
     *
     * This is not hypothetical tidiness. Scoping the gate to `--coupling` is
     * the obvious way to make check-perf blockable on day one — 28 findings
     * is a tractable backlog and 237 is not — and that gate would have been
     * green forever over nothing.
     *
     * `perf-ratchet.mjs` catches `--coupling` and `--size` on its own, via
     * the implausible-collapse guard. It cannot catch `--structural`: 209
     * against a 245 baseline is a perfectly ordinary-looking pass. That gap
     * is the whole reason this assertion exists rather than relying on the
     * ratchet alone.
     */
    const NARROWING_FLAGS = ['--structural', '--coupling', '--size'];

    const quality = allWorkflows().find(
      ([name]) => name === 'harness-quality.yml',
    );

    it('finds harness-quality.yml to check (zero denominator is an abstention)', () => {
      expect(quality, 'harness-quality.yml is missing').toBeDefined();
    });

    const executable = logicalLines(
      runBlocks(quality?.[1] ?? {}).join('\n'),
    ).filter((line) => !line.trimStart().startsWith('#'));

    const perfLines = executable.filter((line) =>
      /harness\s+check-perf\b/.test(line),
    );

    it('wires check-perf at all', () => {
      expect(
        perfLines,
        'check-perf ran in no workflow at all, which is what #717 filed',
      ).not.toEqual([]);
    });

    it.each(NARROWING_FLAGS)(
      'never scopes check-perf with %s',
      (flag: string) => {
        expect(
          perfLines.filter((line) => line.includes(flag)),
          `${flag} silences findings it should report; the gate must call a ` +
            'bare `harness check-perf`',
        ).toEqual([]);
      },
    );

    it('never scopes check-perf with --severity', () => {
      expect(
        perfLines.filter((line) => /--severity\b/.test(line)),
        '--severity excludes lower violations from the report entirely, so ' +
          'the ratchet would compare a filtered count to an unfiltered baseline',
      ).toEqual([]);
    });

    /**
     * `check-perf` exits 1 whenever it has violations, which is always, so
     * its own exit code cannot be the gate — the step has to swallow it and
     * hand the count to the ratchet. That swallow is only safe because the
     * ratchet abstains on an unparseable report; without the ratchet line,
     * `|| true` is just a silenced check.
     */
    it('gates check-perf on the ratchet rather than on its exit code', () => {
      expect(
        executable.filter((line) => line.includes('perf-ratchet.mjs')),
        'check-perf runs with `|| true`, so nothing blocks unless the ratchet ' +
          'reads the report it captured',
      ).not.toEqual([]);
    });

    it('captures the check-perf report to the file the ratchet reads', () => {
      const captured = perfLines.some((line) => STDOUT_TO_FILE.test(line));
      expect(
        captured,
        'the ratchet reads a report file; an uncaptured run leaves it with ' +
          'nothing to parse, which is an abstention every time',
      ).toBe(true);
    });
  });

  describe('#718 — a soft-failing step explains itself or does not exist', () => {
    /**
     * `continue-on-error: true` is the workflow-layer silent abstention: the
     * step goes orange, the JOB goes green, and nobody reads the log. The
     * instance this rule was written for was `harness check-docs`, soft since
     * "we transition" with no end condition, no target and no owner, sitting
     * at 3.0% coverage — which at that number is the steady state, not a
     * transition. It is blocking at a floor as of #718.
     *
     * Soft steps are not banned outright; a genuinely transitional one is
     * legitimate. What is banned is a soft step nobody can see failing. A
     * step is EXPLAINED when a later step annotates on its outcome, which
     * puts the soft failure in the PR's Checks summary rather than only
     * inside an expanded step.
     */
    function softSteps(wf: Workflow): Array<[string, Step, Step[]]> {
      const found: Array<[string, Step, Step[]]> = [];
      for (const [jobId, job] of jobsOf(wf)) {
        const steps = job.steps ?? [];
        for (const step of steps) {
          if (step['continue-on-error'] === true) {
            found.push([jobId, step, steps]);
          }
        }
      }
      return found;
    }

    /** Does any sibling step annotate on this step's outcome? */
    function isExplained(step: Step, siblings: Step[]): boolean {
      if (!step.id) return false;
      const outcomeRef = new RegExp(
        `steps\\.${step.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.outcome`,
      );
      return siblings.some((s) => s !== step && outcomeRef.test(s.if ?? ''));
    }

    /**
     * The repo currently has ZERO `continue-on-error: true` steps, so the
     * assertion below runs over an empty set — and an empty set is exactly
     * the zero denominator this file exists to reject. Proving the detector
     * against a fixture is what makes the real-workflow assertion mean
     * something: without it, `softSteps` could be broken outright and the
     * suite would stay green because it found nothing either way.
     */
    describe('the detector works (so the empty real-world result is a pass)', () => {
      const unexplained = {
        jobs: {
          build: {
            steps: [
              { name: 'soft and silent', run: 'x', 'continue-on-error': true },
              { name: 'unrelated', run: 'y' },
            ],
          },
        },
      } as Workflow;

      const explained = {
        jobs: {
          build: {
            steps: [
              {
                id: 'soft',
                name: 'soft but annotated',
                run: 'x',
                'continue-on-error': true,
              },
              {
                name: 'annotate',
                if: "steps.soft.outcome == 'failure'",
                run: 'echo "::warning::it failed"',
              },
            ],
          },
        },
      } as Workflow;

      it('spots a continue-on-error step', () => {
        expect(softSteps(unexplained)).toHaveLength(1);
      });

      it('calls an unannotated soft step unexplained', () => {
        const [entry] = softSteps(unexplained);
        const [, step, siblings] = entry!;
        expect(isExplained(step, siblings)).toBe(false);
      });

      it('calls an annotated soft step explained', () => {
        const [entry] = softSteps(explained);
        const [, step, siblings] = entry!;
        expect(isExplained(step, siblings)).toBe(true);
      });

      it('does not accept an id with no matching annotation', () => {
        const orphan = {
          jobs: {
            build: {
              steps: [
                { id: 'soft', run: 'x', 'continue-on-error': true },
                { if: "steps.other.outcome == 'failure'", run: 'y' },
              ],
            },
          },
        } as Workflow;
        const [entry] = softSteps(orphan);
        const [, step, siblings] = entry!;
        expect(isExplained(step, siblings)).toBe(false);
      });
    });

    it.each(allWorkflows())(
      '%s has no unexplained continue-on-error step',
      (_name: string, wf: Workflow) => {
        const offenders = softSteps(wf)
          .filter(([, step, siblings]) => !isExplained(step, siblings))
          .map(([jobId, step]) => `${jobId}: ${step.name ?? step.run ?? '?'}`);
        expect(
          offenders,
          'a soft-failing step with no annotation goes orange while the job ' +
            'goes green — give it an `id` and a step that annotates on its ' +
            'outcome, or make it blocking',
        ).toEqual([]);
      },
    );
  });

  /**
   * #1021 — `fleet-health` keeps its history between runs.
   *
   * The job used to start every run from an empty store, so `analyze flaky`
   * read exactly 1 run on every `main` push and could never reach a verdict:
   * a check whose denominator is pinned at 1 is permanently abstaining while
   * looking wired. The store now round-trips through the Actions cache, keyed
   * per branch with `main` as the fallback (proposal 460, D3). These pin the
   * three ways that round-trip goes quietly wrong: restoring after the writer
   * (the new run is overwritten), saving a different path or key than was
   * restored, and a thin window that nobody is told about.
   */
  describe('#1021 — fleet-health keeps its history between runs', () => {
    const STORE = 'test-results/reports/history-v2.jsonl';
    const dogfood = allWorkflows().find(([name]) => name === 'dogfood.yml');
    const steps = dogfood?.[1].jobs?.['fleet-health']?.steps ?? [];
    const indexOf = (pred: (s: Step) => boolean): number =>
      steps.findIndex(pred);
    const restoreAt = indexOf((s) =>
      /^actions\/cache\/restore@/.test(s.uses ?? ''),
    );
    const saveAt = indexOf((s) => /^actions\/cache\/save@/.test(s.uses ?? ''));
    const recordAt = indexOf((s) => /history record\b/.test(s.run ?? ''));
    const restore = steps[restoreAt];
    const save = steps[saveAt];

    it('finds the fleet-health steps (zero denominator is an abstention)', () => {
      expect(steps.length).toBeGreaterThan(0);
      expect(recordAt, 'no step runs `history record`').toBeGreaterThanOrEqual(
        0,
      );
    });

    it('restores the store before recording and saves it after', () => {
      expect(restoreAt, 'no actions/cache/restore step').toBeGreaterThanOrEqual(
        0,
      );
      expect(saveAt, 'no actions/cache/save step').toBeGreaterThan(recordAt);
      expect(restoreAt).toBeLessThan(recordAt);
      expect(restore?.with?.['path']).toBe(STORE);
      expect(save?.with?.['path']).toBe(STORE);
    });

    it('keys the cache per branch and falls back to main', () => {
      const key = String(restore?.with?.['key'] ?? '');
      expect(key).toMatch(/github\.head_ref \|\| github\.ref_name/);
      // Cache entries are immutable: a key that does not change per run is
      // saved once and then never again, which freezes the history.
      expect(key).toContain('github.run_id');
      // A re-run keeps its run_id; without the attempt its save collides with
      // the first attempt's entry and the re-run's record is dropped.
      expect(key).toContain('github.run_attempt');
      expect(String(restore?.with?.['restore-keys'] ?? '')).toMatch(
        /fleet-history-main-/,
      );
      expect(save?.with?.['key']).toBe(key);
    });

    it('saves only a store the record step actually wrote to', () => {
      expect(recordAt >= 0 && steps[recordAt]?.id).toBeTruthy();
      expect(save?.if ?? '').toContain(
        `steps.${steps[recordAt]?.id}.outcome == 'success'`,
      );
    });

    it('states loudly when the window is below the flake-verdict minimum', () => {
      const scripts = steps.map((s) => s.run ?? '').join('\n');
      const executable = logicalLines(scripts).filter(
        (line) => !line.startsWith('#'),
      );
      expect(
        executable.filter(
          (l) =>
            l.includes('::warning') && l.includes('below its history minimum'),
        ),
        'a thin history window must annotate, not just log',
      ).not.toEqual([]);
      expect(
        executable.filter(
          (l) => l.includes('::warning') && l.includes('no history restored'),
        ),
        'a cache miss starts from an empty store and must say so',
      ).not.toEqual([]);
    });

    it('holds the same minimum the flake verdict uses', async () => {
      const { MIN_WINDOW_RUNS } = await import('../src/util/flake-window.js');
      const env = steps
        .map((s) => (s as Step & { env?: Record<string, unknown> }).env)
        .find((e) => e?.['HISTORY_MIN_RUNS'] !== undefined);
      expect(Number(env?.['HISTORY_MIN_RUNS'])).toBe(MIN_WINDOW_RUNS);
    });
  });
  /**
   * #1024 — the cached store is bounded before it is saved.
   *
   * Cache entries are immutable and each run reserves a fresh one holding the
   * WHOLE store, so an append-only store meant an entry that grew with every
   * run (re-measured 2026-09-21: ~0.125 MB gzipped per recorded run of
   * canary's own suite). LRU eviction would eventually take it, and an evicted
   * `main` entry silently restarts the history chain.
   *
   * The ways the fix goes quietly wrong, pinned here: trimming AFTER the save
   * (the entry is still unbounded), trimming BEFORE the record (this run's own
   * row escapes the bound), and a `--keep` cut below a read-side window so the
   * job caches a store no reader can reach a verdict from.
   */
  describe('#1024 — fleet-health bounds the store before caching it', () => {
    const dogfood = allWorkflows().find(([name]) => name === 'dogfood.yml');
    const steps = dogfood?.[1].jobs?.['fleet-health']?.steps ?? [];
    const at = (pred: (s: Step) => boolean): number => steps.findIndex(pred);
    const recordAt = at((s) => /history record\b/.test(s.run ?? ''));
    const trimAt = at((s) => /history trim\b/.test(s.run ?? ''));
    const saveAt = at((s) => /^actions\/cache\/save@/.test(s.uses ?? ''));
    const keep = Number(
      /history trim\b[^\n]*--keep\s+(\d+)/.exec(
        steps.map((s) => s.run ?? '').join('\n'),
      )?.[1],
    );

    it('trims the store between recording it and saving it', () => {
      expect(trimAt, 'no step runs `history trim`').toBeGreaterThanOrEqual(0);
      expect(
        trimAt,
        'trimming before the record lets this run escape the bound',
      ).toBeGreaterThan(recordAt);
      expect(
        saveAt,
        'trimming after the save leaves the cache entry unbounded',
      ).toBeGreaterThan(trimAt);
    });

    it('passes an explicit --keep rather than relying on a default', () => {
      expect(Number.isInteger(keep)).toBe(true);
      expect(keep).toBeGreaterThan(0);
    });

    it('keeps more runs than every read-side window needs', async () => {
      const { MIN_WINDOW_RUNS } = await import('../src/util/flake-window.js');
      // The 30-run default window of `history flaky` / `canary analyze`. A
      // `--keep` below either of these caches a store that can only abstain.
      const ANALYZE_WINDOW = 30;
      expect(keep).toBeGreaterThan(ANALYZE_WINDOW);
      expect(keep).toBeGreaterThan(MIN_WINDOW_RUNS);
    });

    it('does not swallow a failed trim into an unbounded save', () => {
      const trimScript = steps[trimAt]?.run ?? '';
      expect(trimScript).not.toMatch(/history trim[^\n]*\|\|\s*(true|echo)/);
    });
  });
  /**
   * #460 — fleet-health dogfoods `canary order`. The ways this goes quietly
   * wrong: the plan is built after the suite ran, a failed plan is swallowed
   * so the run silently loses its ordering, the diff base is interpolated
   * into the shell, and the TTFF report never runs.
   */
  describe('#460 — fleet-health runs in canary order', () => {
    const dogfood = allWorkflows().find(([name]) => name === 'dogfood.yml');
    const job = dogfood?.[1].jobs?.['fleet-health'];
    const steps = job?.steps ?? [];
    const at = (re: RegExp): number =>
      steps.findIndex((s) => re.test(s.run ?? ''));
    const planAt = at(/canary\.js order --suite/);
    const recordAt = at(/history record\b/);
    const plan = steps[planAt];

    it('plans the order before the suite runs and records with the plan', () => {
      expect(planAt, 'no step runs `canary order`').toBeGreaterThanOrEqual(0);
      expect(planAt).toBeLessThan(recordAt);
      const record = steps[recordAt]?.run ?? '';
      expect(record).toContain('CANARY_ORDER_PLAN');
      expect(record).toContain('--order-plan');
    });

    it('turns a failed plan into a warning, never a swallowed exit', () => {
      const run = plan?.run ?? '';
      expect(run).not.toMatch(/canary\.js order[^\n]*\|\|\s*true/);
      expect(run).toMatch(/rc=\$\?/);
      expect(run).toMatch(/::warning title=canary order failed::/);
      expect(plan?.['continue-on-error']).toBeUndefined();
    });

    it('passes the diff base through env, and fetches the history it needs', () => {
      expect(plan?.run ?? '').not.toContain('${{');
      expect(JSON.stringify(plan)).toContain('BASE_SHA');
      const checkout = steps.find((s) =>
        /^actions\/checkout@/.test(s.uses ?? ''),
      );
      expect(checkout?.with?.['fetch-depth']).toBe(0);
    });

    it('prints the TTFF report', () => {
      expect(at(/order --report --suite ts-engine/)).toBeGreaterThan(recordAt);
    });
  });
});
