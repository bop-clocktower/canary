# Plan: Merge-policy record accounts for every live ruleset rule

**Date:** 2026-09-22 | **Spec:**
`docs/changes/1056-merge-policy-record/proposal.md` | **Tasks:** 5 | **Time:**
~18 min | **Integration Tier:** small

## Goal

`.github/required-checks.json` records all six live rules of ruleset 16189198 —
each with a blocking verdict and a reason — with the effective review
requirement and access posture stated, and an offline test that fails when the
record is gutted.

## Observable Truths (Acceptance Criteria)

1. The system shall record six `rulesetRules.rules` entries whose `rule` values
   are exactly `deletion`, `non_fast_forward`, `pull_request`, `code_quality`,
   `copilot_code_review`, `required_status_checks`.
2. When any entry lacks a boolean `blocking` or a non-empty `reason`, the
   `#1056` describe block in `ts/test/workflow-false-green.test.ts` shall fail.
3. When the recorded rule-type set differs from the pinned set (an entry added
   or deleted), the `#1056` block shall fail.
4. While the repo has a single maintainer, the `reviews` section shall state
   that 1 approval is required for unattributed changes and 0 otherwise.
5. The `reviews` section shall record collaborator shape as aggregate role
   counts only; no account login appears anywhere in the diff.
6. `grep -c "code_quality\|copilot_code_review\|unattributed" .github/required-checks.json`
   returns non-zero (returns 0 today).
7. If a string in `.github/workflows/guardian.yml` names a check context, then
   that string shall be a live context (`guardian`, `deps-and-validate`); the
   strings `PR Guardian / guardian` and `enforce` shall not appear.
8. Four gates green from `ts/`: `build`, `typecheck`, `format:check`, `test`.

## Evidence (verified live, 2026-09-22)

- `gh api repos/bop-clocktower/canary/rulesets/16189198 --jq '.rules'` returns
  the six types above, with
  `pull_request.parameters.require_extra_approval_for_unattributed_changes: true`,
  `required_approving_review_count: 0`, `dismiss_stale_reviews_on_push: false`,
  `require_last_push_approval: false`, `require_code_owner_review: false`,
  `allowed_merge_methods: ["merge","squash","rebase"]`;
  `code_quality.parameters.severity: "errors"`;
  `copilot_code_review.parameters`: `review_draft_pull_requests: false`,
  `review_on_push: true`;
  `required_status_checks.parameters.strict_required_status_checks_policy: true`
  with 13 contexts.
- Collaborator role counts read from
  `gh api repos/bop-clocktower/canary/collaborators`
  (`--jq '[.[].role_name] | group_by(.)'`) return
  `admin: 1, maintain: 1, write: 4`.
- Mirror pattern: `ts/test/workflow-false-green.test.ts:354-409`
  (`#769 — external app statuses are written down`).
- Stale comment: `.github/workflows/guardian.yml:151-157`.
- `harness validate` and `harness check-deps` pass on the current tree.

## Uncertainties

- [ASSUMPTION] The four non-`admin` collaborator seats are apps/bots rather than
  humans. The manifest records counts by ROLE only, so the prose must not claim
  human-vs-bot composition. Task 3 checkpoint confirms wording.
- [DEFERRABLE] Exact prose in each `reason` array. Wording is editorial; the
  test asserts non-emptiness, not content.

## File Map

- MODIFY `ts/test/workflow-false-green.test.ts` (add `#1056` describe block)
- MODIFY `.github/required-checks.json` (add `rulesetRules`; rewrite `reviews`)
- MODIFY `.github/workflows/guardian.yml` (correct stale comment, lines 151-157)

No CREATE. No new module, script, or CLI surface — none of the three new-module
CI ratchets (dead exports, perf complexity, arch allowance) apply.

## Tasks

### Task 1: Add the failing `#1056` test block

**Depends on:** none | **Files:** `ts/test/workflow-false-green.test.ts`

1. Open `ts/test/workflow-false-green.test.ts`. Immediately after the closing
   `});` of the `describe('#769 — external app statuses are written down', …)`
   block (currently line ~409), insert a doc comment and a new describe block.
   Write it in the style of the `#769` block above it — a `/** … */` preamble
   stating why this gap was structurally invisible to the suite, then:

   ```ts
   describe('#1056 — every live ruleset rule has a recorded verdict', () => {
     interface RulesetRule {
       rule: string;
       blocking: boolean;
       parameters?: Record<string, unknown>;
       reason: string[];
     }
     const manifest = JSON.parse(
       readFileSync(
         join(REPO_ROOT, '.github', 'required-checks.json'),
         'utf-8',
       ),
     ) as {
       rulesetRules?: { rules?: RulesetRule[] };
       reviews?: Record<string, unknown>;
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

     it('records at least one (a zero denominator is an abstention)', () => {
       expect(rules.length).toBeGreaterThan(0);
     });

     it('pins the observed rule-type set', () => {
       expect(rules.map((r) => r.rule).sort()).toEqual(OBSERVED_RULE_TYPES);
     });

     it.each(rules.map((r) => [r.rule]))(
       '%s carries a boolean verdict and a non-empty reason',
       (rule) => {
         const entry = rules.find((r) => r.rule === rule)!;
         expect(typeof entry.blocking).toBe('boolean');
         expect(entry.reason.join('').trim()).not.toBe('');
       },
     );

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
       for (const count of Object.values(posture)) {
         expect(typeof count).toBe('number');
       }
     });
   });
   ```

2. Run: `cd ts && npx vitest run test/workflow-false-green.test.ts` — observe
   FAILURE (no `rulesetRules` section; `reviews` has no
   `require_extra_approval_for_unattributed_changes` or `accessPosture`).
   Confirm the failure count is non-zero; a green run here means the block did
   not execute.
3. Run: `npx prettier --write ts/test/workflow-false-green.test.ts` (repo is
   prettier-governed: single quote, 80 col).
4. Run from repo root: `harness validate`
5. Commit: `test(ci): record every live ruleset rule has a verdict (#1056)`

### Task 2: Add the `rulesetRules` section to the manifest

**Depends on:** Task 1 | **Files:** `.github/required-checks.json`

1. Insert a top-level `"rulesetRules"` object after the `"externalStatuses"`
   object and before `"reviews"`. Shape:

   ```json
   "rulesetRules": {
     "$comment": [
       "#1056. This file opens by calling itself the source of truth a human",
       "can read. It accounted for 2 of the 6 rules ruleset 16189198 carries.",
       "Every entry below is an OBSERVATION, not a declaration: it is not",
       "applied from this file, so on a disagreement the ruleset wins and this",
       "section is the wrong one. Same direction of authority as `strict`, and",
       "the same failure mode — observations go stale silently.",
       "",
       "Re-read live with:",
       "  gh api repos/bop-clocktower/canary/rulesets/16189198 --jq '.rules'",
       "Last reconciled 2026-09-22. No offline test can discover a rule nobody",
       "wrote down; that line is the step that can."
     ],
     "rules": [
       { "rule": "deletion", "blocking": true, "parameters": {}, "reason": ["..."] },
       { "rule": "non_fast_forward", "blocking": true, "parameters": {}, "reason": ["..."] },
       { "rule": "pull_request", "blocking": true,
         "parameters": {
           "required_approving_review_count": 0,
           "require_extra_approval_for_unattributed_changes": true,
           "dismiss_stale_reviews_on_push": false,
           "require_last_push_approval": false,
           "require_code_owner_review": false,
           "required_review_thread_resolution": false,
           "allowed_merge_methods": ["merge", "squash", "rebase"]
         },
         "reason": ["... see the `reviews` section below ..."] },
       { "rule": "code_quality", "blocking": true,
         "parameters": { "severity": "errors" }, "reason": ["..."] },
       { "rule": "copilot_code_review", "blocking": false,
         "parameters": { "review_draft_pull_requests": false, "review_on_push": true },
         "reason": ["..."] },
       { "rule": "required_status_checks", "blocking": true,
         "parameters": { "strict_required_status_checks_policy": true, "contexts": 13 },
         "reason": ["The `required` list above IS this rule's context set; the manifest is primary for it (ADR 0011). `strict` is recorded in `mergePolicy`."] }
     ]
   }
   ```

   Replace every `"..."` with real prose stating what the rule prevents and why
   its `blocking` verdict is what it is. Parameters are the live values from the
   Evidence section above — copy them exactly, do not re-derive from memory.

2. Run: `cd ts && npx vitest run test/workflow-false-green.test.ts` — the three
   `rulesetRules` tests now PASS; the two `reviews` tests still FAIL. That split
   is the expected state.
3. Run: `npx prettier --write .github/required-checks.json`
4. Run from repo root: `harness validate`
5. Commit: `docs(ci): record all six live ruleset rules with verdicts (#1056)`

### Task 3: Rewrite the `reviews` section [checkpoint:human-verify]

**Depends on:** Task 2 | **Files:** `.github/required-checks.json`

1. Replace the `"reviews"` object with:

   ```json
   "reviews": {
     "required_approving_review_count": 0,
     "require_extra_approval_for_unattributed_changes": true,
     "accessPosture": { "admin": 1, "maintain": 1, "write": 4 },
     "reason": [
       "EFFECTIVE policy, which the previous one-line version got wrong: 1",
       "approval is required for UNATTRIBUTED (agent- or bot-authored)",
       "changes, 0 otherwise. A large share of what lands here is",
       "unattributed, so the effective requirement for this repo's most",
       "common class of change is 1, not 0.",
       "",
       "The `0` is still deliberate, not a default (#542 step 4).",
       "Single-maintainer repo: a flat requirement of 1 would mean",
       "self-approving every PR, which trains the reflex the gate exists to",
       "prevent. Dropping the unattributed flag to make the old sentence true",
       "would have removed a protection to fix a record; the record was",
       "wrong, not the ruleset. Revisit when a second maintainer joins.",
       "",
       "Access posture (#1056, Decision 3) is recorded here rather than in a",
       "SECURITY.md because a reader who finds a review count of 0 needs the",
       "collaborator shape in the same breath. Aggregate role counts only —",
       "no account is ever enumerated in this file. Read live with:",
       "  gh api repos/bop-clocktower/canary/collaborators --jq '[.[].role_name] | group_by(.) | map({role: .[0], count: length})'",
       "Observed 2026-09-22. This is an OBSERVATION; the repo settings win."
     ]
   }
   ```

2. Run: `cd ts && npx vitest run test/workflow-false-green.test.ts` — all
   `#1056` tests PASS.
3. Run: `npx prettier --write .github/required-checks.json`
4. **[checkpoint:human-verify]** Show the `reviews` diff and confirm: (a) no
   account login, email, or display name appears; (b) the counts do not imply
   human-vs-bot composition, which is unverified. Wait for confirmation.
5. Run from repo root: `harness validate`
6. Commit:
   `docs(ci): state effective review requirement and access posture (#1056)`

### Task 4: Correct the stale guardian.yml check-context comment

**Depends on:** Task 3 | **Files:** `.github/workflows/guardian.yml`

1. Replace the comment at lines 151-157
   (`# Required-check (#311, "one gate not two"): …` through `# Phase 6.`). The
   replacement must name only live contexts and must not contain the strings
   `PR Guardian / guardian` or `enforce`:

   ```yaml
   # Required-check (#311, "one gate not two"): under
   # `canary.guardian.pr.gate: hard` this job exits non-zero on unaddressed
   # critical/high findings. The registered context is the bare job id
   # `guardian` (this job sets no `name:`), and it is already a required
   # context in ruleset 16189198 — see `.github/required-checks.json`.
   # The old note here named `PR Guardian / guardian` and `enforce`; neither
   # string is live (`enforce` was renamed `deps-and-validate` by #698), and
   # registering either would block every PR forever (#1056).
   ```

2. Verify no stale strings remain:
   `grep -n "PR Guardian\|enforce" .github/workflows/guardian.yml` — expect no
   output. An empty grep here is a real zero, not an abstention:
   `grep -c "guardian" .github/workflows/guardian.yml` must be non-zero to prove
   the file was read.
3. Run: `npx prettier --write .github/workflows/guardian.yml`
4. Run from repo root: `harness validate`
5. Commit:
   `docs(ci): correct stale check-context comment in guardian.yml (#1056)`

### Task 5: Success-criteria sweep and four gates

**Depends on:** Task 4 | **Files:** none (verification only)

1. Run:
   `grep -c "code_quality\|copilot_code_review\|unattributed" .github/required-checks.json`
   — expect non-zero (success criterion 1).
2. Run the four gates from `ts/` (there is no `lint` script here):

   ```bash
   cd ts
   npm run build
   npm run typecheck
   npm run format:check
   npm test
   ```

   Run them as separate commands, not piped — a pipe hides the exit code.

3. Falsification probe: temporarily delete one `rulesetRules` entry, run
   `cd ts && npx vitest run test/workflow-false-green.test.ts`, confirm it
   FAILS, then `git checkout -- .github/required-checks.json`. A test that
   cannot be made to fail has not been shown to work (success criterion 4).
4. Run from repo root: `harness validate` and `harness check-deps`.
5. Commit only if step 3 left a change (it should not):
   `chore(ci): verify merge-policy record gates (#1056)`

## Risks

- Prettier reformats JSON arrays of strings; re-add and re-commit if a
  pre-commit hook rewrites the file. Never `--no-verify`.
- The pinned `OBSERVED_RULE_TYPES` array is a deliberate tripwire: a legitimate
  ruleset change will fail this test, and updating it is the intended workflow,
  not a test to loosen.
