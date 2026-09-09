---
name: canary-ship
version: '1.0.0'
description: >-
  Run the canary ship gate on a finished change: spawn parallel adversarial
  reviewers on the diff, resolve every confirmed finding with a regression test,
  then commit, open a PR, and squash-merge while watching CI to green. Use this
  whenever an implemented, locally-green change on a feature branch should be
  merged — when the user says ship it, or review resolve commit push pr merge,
  or get this merged when it is green, or take it the rest of the way, or right
  after you finish implementing a feature or fix and the next step is
  integration. It bakes in this repo's conventions (no co-author trailer, squash
  merge, prettier, exclude local IDE churn, update the roadmap). NOT for writing
  the implementation itself, and NOT a substitute for finishing the work — the
  change must already exist and pass tests locally before the gate runs.
---

# Canary Ship

The last mile of a change is where quality is won or lost: a plausible-looking
diff merges, and the bug nobody looked for ships with it. This skill is the
**ship gate** — the disciplined path from "the code is written and tests pass"
to "it's merged on `main` with CI green." Its spine is a real adversarial review
_before_ the merge button, not after, because the cheapest place to catch a
defect is the one before it reaches `main`.

It is not a code generator. It assumes the change already exists on a feature
branch and passes the suite locally. Its job is to pressure-test that change,
resolve what the pressure surfaces, and integrate it under this repo's
conventions without you having to re-remember them each time.

## When this fires vs. when it doesn't

Use it when the work is **done and green** and the remaining verb is "ship",
"merge", "PR it", "take it home". Do **not** use it to do the implementation, to
merge something whose tests you haven't run, or to force a merge past a failing
gate. If the change isn't on a branch yet, make the branch first (see
[AGENTS.md](../../../../AGENTS.md) branch hygiene) — never ship from `main`.

## Preconditions (verify before starting)

- On a feature branch, not `main` (`git branch --show-current`).
- The change is implemented and the relevant suite + lint pass locally. If you
  can't confirm that, stop and run them — the gate reviews a _finished_ change.
- `git fetch origin` first, then know your diff base (`origin/main...`). Other
  sessions may be active on this repo; trust the remote, not stale local state.

## The pipeline

Five phases. Do them in order; each depends on the last. Track them as todos so
none is silently skipped.

### 1 · Review — two independent reviewers, in parallel, on the diff

Spawn **two** review subagents in the _same_ turn so they run concurrently, each
scoped to the actual change (not the whole repo):

- a **correctness/design** pass — `harness-code-reviewer` — hunting real bugs,
  broken contracts, and inconsistencies;
- an **adversarial** pass — `harness-adversarial-reviewer` — constructing
  failure scenarios: assumption violations, composition failures across _all_
  callers of anything you changed, and blind spots in new guards or tests.

Give each reviewer the changed-file list, the design intent, and the specific
risk areas you already suspect (a contract change? a new parser? an import
cycle?). Ask for **confirmed findings with a concrete failure scenario**
(specific input/state → bad outcome), ranked by severity — not style nits.

Why two, why adversarial, why before the merge: a single reviewer rubber-stamps;
two independent ones that disagree surface the real seam. The adversarial lens
is the one that asks "who _else_ calls this?" — the question that catches the
regression your own change introduced in a caller you weren't looking at. (This
is not hypothetical; it is the failure mode this gate exists to catch.)

If the `harness-code-review` pipeline (the `/harness code-review` skill) is
available and you prefer it, it can stand in for the correctness pass — but keep
a distinct adversarial pass alongside it. Wait for both to report before editing
anything, so you resolve in one pass and don't edit files a reviewer is still
reading.

### 2 · Resolve — fix confirmed findings, each with a regression test

For every **confirmed** finding, fix it and add a test that would have caught
it. A fix without a regression test is a fix that silently comes back. Rank by
severity and resolve top-down.

You do not have to accept every finding — but rejecting one is a technical
judgment you must be able to defend, not a convenience. When you skip a finding,
say why (e.g. "pre-existing, out of scope"; "the quadrant is empty and pinned by
an invariant test"). When a reviewer independently confirms another reviewer's
finding, treat that convergence as strong signal it's real.

Then re-run the affected suite **and** the full suite + lint. Green here is the
gate for phase 3 — a partial run is not confirmation.

### 3 · Commit — stage the change only, format, no co-author trailer

- **Stage precisely.** Add only the files that belong to this change. This repo
  often carries local IDE/agent churn (`.claude/settings.json`, `.gitignore`,
  editor caches) that is _not_ yours to commit — exclude it explicitly and
  double-check `git status` before committing.
- **Format first.** Run `npx prettier --write` on any changed `*.md` / `*.yaml`
  / `*.ts` _before_ committing. Prettier is a **CI** gate here
  (`npm run format:check` in `harness-quality.yml`), so an unformatted diff
  commits fine but fails CI _after_ you push — format now to avoid the red
  round-trip. (The pre-commit hook itself runs the roadmap-comment guard,
  **markdownlint** on staged `.md`, and the security-ledger refresh — not
  prettier.) Watch for prettier mangling inline code in prose (e.g. `foo(bar)` →
  `foo (bar)`); reword to avoid a paren at a wrap boundary if it does.
- **Doc drift + roadmap.** Before committing, check whether the change made any
  doc stale, and update `docs/roadmap.md` (mark the item done, with a summary of
  what shipped and any reviewed-and-resolved findings). Shipping code with a
  stale roadmap is drift this project specifically tracks.
- **Commit message:** conventional (`feat(scope): …`), imperative subject, body
  explaining the _why_ and the review outcome. **No `Co-Authored-By` trailer** —
  this project's standing preference. Let the pre-commit hooks run.

### 4 · PR — push and open with a structured body

`git push -u origin <branch>`, then `gh pr create --base main` with a body that
states **What / How / Review (findings resolved) / Tests**. The review section
is the honest part — name the findings the gate caught and how they were fixed.
Search for a PR template in `.github/` first and honor it if present.

### 5 · Merge — then watch CI, sync, and prune

`gh pr merge <n> --squash --auto --delete-branch` (this repo squashes).
Repo-level auto-merge is enabled (`allow_auto_merge: true`) and there are 13
required status checks, with `strict_required_status_checks_policy: true` on
ruleset 16189198 — so a PR cannot merge until its branch is up to date with
`main` and every required check is green. `--auto` is therefore the right
default: it lands the PR the moment both hold.

Auto-merge **waits**; it does not update the branch. Whenever `main` moves the
PR goes stale, so run `gh pr update-branch <n>` and let the checks re-run.
`--delete-branch` is still needed explicitly since the repo does not auto-delete
on merge.

Merging immediately means CI runs _post-merge_ — so "merge when green" is on
you: **watch the post-merge CI runs to completion**
(`gh run watch <id> --exit-status`, or poll `gh run list --branch main`) and
confirm every check passes. If one fails, that is a real regression on `main` —
fix it forward immediately, don't leave it red.

Then sync and clean up: `git checkout main && git pull --ff-only`, delete the
merged local branch, and `git fetch --prune`.

## Conventions this gate enforces (the point of packaging it)

| Convention                                       | Why                                                                                                                                     |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| No `Co-Authored-By` trailer                      | Standing user preference for this repo                                                                                                  |
| Squash merge (`--squash --auto --delete-branch`) | Repo squashes; auto-merge is on and `strict` is true, so queue it and update the branch when `main` moves; branches aren't auto-deleted |
| Prettier `--write` before commit                 | Formatting is a CI gate (`format:check`); avoids a red CI round-trip post-push                                                          |
| Exclude local IDE/agent churn from staging       | `settings.json`/caches aren't part of the change                                                                                        |
| Update `docs/roadmap.md` + check doc drift       | Drift this project explicitly tracks                                                                                                    |
| Adversarial review before merge, not after       | Cheapest defect-catch is before `main`                                                                                                  |

## Rationalizations to reject

- _"It's a small change, skip the review."_ Small diffs introduce the caller
  regressions no one looks for — the review is cheapest exactly when the change
  looks trivial.
- _"Tests pass, just merge."_ Passing tests prove the paths you thought of. The
  adversarial pass is for the paths you didn't.
- _"CI has no required checks, so I don't need to watch it."_ Then nothing else
  will — post-merge red on `main` is yours to catch.
- _"I'll fix the doc/roadmap later."_ Later is how drift accumulates; it's one
  edit now.

## Stop conditions

Stop and hand back to the human when: a confirmed finding needs a product
decision you can't make; the review surfaces a design flaw that warrants
re-scoping rather than patching; a merge conflict needs human judgment; or CI
fails for a reason you can't safely fix forward. Never force-merge past a red
gate or an unresolved confirmed finding.
