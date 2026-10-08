# Plan: weekly Monday crons went dark — re-register, move off :00, self-report absence

Item: `weekly-cron-staleness` (harness `cicd-fleet`, option F1-A) · Pipeline:
`harness:cicd-fleet` → `harness-workflow-audit` → TDD · Date: 2026-10-08 · Base:
`origin/main` @ `ccf6af0`

---

## 1. INVENTORY — what is actually true

Every claim handed over from SELECT was re-measured on 2026-10-08 with
`gh run list --event schedule` and `gh api .../actions/workflows/<id>`.

| Claim                                                                 | Verdict       | Evidence                                                                                                                                                      |
| --------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harness-architecture.yml` (`'0 6 * * 1'`) last schedule run 09-07    | Correct       | Run 34116676696, 2026-09-07T11:27Z, success. None since.                                                                                                      |
| `arch-snapshot.yml` (`'0 7 * * 1'`) last schedule run 09-07           | Correct       | Run 34125362300, 2026-09-07T13:04Z, success. None since.                                                                                                      |
| Both report `state: active`                                           | Correct       | Workflows 274618292 and 316852307, `state: active`.                                                                                                           |
| `guardian-precision.yml` (`'23 6 * * 1'`) still fires                 | Correct       | Runs 35603001365 (09-21), 36434121844 (09-28), 37329147871 (10-05), all success.                                                                              |
| Neither dark file changed between 09-07 and 09-14                     | Correct       | `git log`: `arch-snapshot.yml` last touched 09-04 (`b2de699`); `harness-architecture.yml` 09-03 (`3ec32fe`).                                                  |
| (new) `harness-architecture.yml` was edited **after** going dark      | **Not known** | `7e7675f` (#1164) added a comment on 2026-10-05 19:16 CDT, after that Monday's 06:00 slot. Next slot is 10-12, so whether that edit re-registered is unknown. |
| (new) Guardian precision is a fresh registration, not a long survivor | **Confound**  | Workflow 358291003 was created 2026-09-14; its first schedule run is 09-21. It has never existed alongside the dark crons on a healthy week.                  |

The schedule was degrading before it stopped. Here is how late each run fired
against its nominal slot:

| Monday | `0 6` (validation) | `0 7` (snapshot) | `23 6` (precision)     |
| ------ | ------------------ | ---------------- | ---------------------- |
| 08-03  | +3h35              | +3h30            | —                      |
| 08-10  | +1h23              | +1h18            | —                      |
| 08-17  | +0h43              | +0h40            | —                      |
| 08-24  | +0h48              | +0h46            | —                      |
| 08-31  | +6h32              | +7h30            | —                      |
| 09-07  | +5h27              | +6h04            | —                      |
| 09-14  | **dropped**        | **dropped**      | (created that evening) |
| 09-21  | **dropped**        | **dropped**      | +6h38                  |
| 09-28  | **dropped**        | **dropped**      | +7h48                  |
| 10-05  | **dropped**        | **dropped**      | +8h36                  |

Other observable causes, checked and ruled out:

- Ruleset 16189198 was last updated 2026-09-03, before the last good run.
- The repo is public, not archived, not a fork, default branch `main`, and gets
  pushes daily, so the 60-day inactivity auto-disable does not apply. Both
  workflows are `active`.
- The repo events API shows no transfer, visibility or other non-routine event
  in its window.
- `actionlint` on the three schedule-bearing files is clean.

## 2. Root-cause hypothesis (stated as a hypothesis)

GitHub's scheduler is opaque, so this is a hypothesis with evidence, not a
proven cause.

**Hypothesis.** GitHub's scheduler sheds load at peak, and top-of-hour schedules
are the most-dropped slots. From 2026-09-14 it stopped firing this repo's two
`:00` Monday schedules entirely. The `:23` schedule was degraded too: it ran 6–9
hours late but was not dropped.

Evidence for it:

- The late-firing trend at `:00` (+5–7 h on the last two good weeks) shows heavy
  scheduler backlog right before the drop.
- The surviving `:23` cron fires 6–9 h late, so the backlog is real and ongoing.
- GitHub documents that schedules can be delayed or dropped under high load, and
  that the start of every hour is the most loaded time.

**Competing explanation, which cannot be excluded.** The schedule registration
went stale. The survivor is also the one most recently registered: its file was
created on 09-14, while the dark files were last registered on 09-03 and 09-04.
Editing a workflow file on the default branch re-registers its schedule. From
the outside, "dropped because of `:00`" and "dropped because the registration is
stale" look the same.

**Why the fix does not have to pick one.** Editing both files re-registers them
when the change merges, which covers the stale-registration explanation. Moving
them off `:00` covers the load-shedding explanation. The watchdog makes any
recurrence visible, whatever its cause.

## 3. Workflow audit (harness-workflow-audit), scoped to the schedule-bearing files

```text
WORKFLOW AUDIT: bop-clocktower/canary (scope: harness-architecture.yml, arch-snapshot.yml, guardian-precision.yml)
Workflows audited: 3   Findings: 2 error, 1 warning, 1 info
Gates that never fire: harness-architecture.yml schedule leg, arch-snapshot.yml (whole workflow) — since 2026-09-14
Documented-but-unwired gates: liveness of every weekly schedule (no check notices a missing run)
```

- **[ERROR] gate-never-fires** `.github/workflows/harness-architecture.yml:42`.
  The `'0 6 * * 1'` schedule has not fired since run 34116676696 (2026-09-07).
  The patch moves it to a non-`:00` minute (see §4).
- **[ERROR] gate-never-fires** `.github/workflows/arch-snapshot.yml:12`. The
  `'0 7 * * 1'` schedule has not fired since run 34125362300 (2026-09-07). This
  workflow has no other trigger except manual dispatch, so the arch trend
  surface has been frozen for 4 weeks. The patch moves it to a non-`:00` minute
  (see §4).
- **[WARNING] gate-missing (liveness)**, repo-wide. Nothing turns red when a
  scheduled run does not happen. A cron that never fires shows no failed run, so
  it never shows up as a failure. The patch is the watchdog (see §5).
- **[INFO] stale-reference** `.github/workflows/arch-snapshot.yml:12`. The
  comment says "after refresh-arch-baseline's 06:00", but
  `refresh-arch-baseline.yml` has no schedule. The 06:00 job is
  `harness-architecture.yml`. The patch rewrites the comment.
- Out of scope, recorded only: `harness-architecture.yml` has no top-level
  `permissions:` block (M2 warning, pre-existing).
- Out of scope, recorded only: `actionlint` reports 5 pre-existing shellcheck
  info findings, in `dogfood.yml` (SC2016 ×2) and `harness-quality.yml` (SC2086
  ×3). `actionlint` is not a repo CI gate.

**Escalation per the skill.** Both gates have been dead for 4 weeks. The
validation job also runs on every PR and every push to `main`, so only its
weekly drift sweep was lost. The arch snapshot has nothing else feeding it. Its
first run after merge will append one point after a 5-week gap; no backlog of
findings is expected.

The skill's "do not modify workflow files" gate was overridden by the human at
the fleet CONFIRM step (option F1-A authorises applying the patches).

## 4. Fix — move off the top of the hour, keep the order

| Workflow                   | Before        | After          | Why this minute                                                                          |
| -------------------------- | ------------- | -------------- | ---------------------------------------------------------------------------------------- |
| `harness-architecture.yml` | `'0 6 * * 1'` | `'37 6 * * 1'` | Not `:00`, `:15`, `:30` or `:45`, and not the `:23` already used by Guardian precision.  |
| `arch-snapshot.yml`        | `'0 7 * * 1'` | `'43 7 * * 1'` | Same rule. Lands about an hour after the validation slot, so the documented order holds. |

The order is nominal, not guaranteed. The table in §1 shows multi-hour delays,
and the two workflows have no data dependency (the snapshot does not read the
validation's output). That is no different from before. The new comment says so
instead of implying a hard sequence.

## 5. Watchdog — a missing weekly run turns red

`scripts/schedule-staleness.mjs` asks the GitHub API, for each named workflow
file:

1. **Is the workflow `active`?** A disabled workflow never fires its schedule
   (for example `disabled_inactivity`), and is reported **stale** (exit 1).
2. **When did its last `schedule`-event run start?** If that is older than
   `--max-age-days`, it is reported **stale** (exit 1).

Abstentions follow the repo's denominator rule (ADR 0009, exit 3):

- No `schedule`-event run on record (zero denominator) is **abstain**. It never
  counts as fresh.
- An unreachable or refusing API is **abstain**, with GitHub's message.
- An unreadable run timestamp or response shape is **abstain**.
- Zero workflows checked is **abstain**.

Exit precedence: a stale finding (1) beats an abstention (3), which beats fresh
(0). All non-zero codes turn the job red.

`--max-age-days 8` is one weekly period plus one day of slack, because the worst
observed lateness is 8 h 36 m.

**Where it runs, and why it cannot go dark with the crons it watches.** It runs
in a new workflow, `schedule-watchdog.yml`. Its primary trigger is
`push: branches: [main]`. Push events are delivered by the webhook pipeline, not
by the cron scheduler, so the failure being watched for (dropped schedules) does
not suppress them. This repo merges to `main` several times a day. The workflow
also has `workflow_dispatch` for an on-demand check, and a daily `'19 9 * * *'`
schedule as a second, independent leg for quiet weeks with no merges. If the
scheduler drops that leg too, the push leg still reports.

The watchdog is deliberately **not** attached to a PR trigger. A red caused by
the scheduler would block unrelated PRs and teach people to bypass it. On `main`
it is a visible red commit status. It is not a required check.

It watches all three weekly crons, including Guardian precision, because the
survivor today is not guaranteed to survive tomorrow.

**Expected first state.** After this merges, the push leg goes **red** with
`stale` for both repaired workflows, because their last schedule run is still
2026-09-07. It should turn green after the first Monday slot that fires
(2026-10-12 at 06:37 / 07:43 UTC, plus GitHub's delay). If it is still red on
2026-10-13, the fix did not work. That red is the alarm doing its job.

## 6. Tasks (TDD — test first)

1. **RED:** `ts/test/schedule-staleness.test.ts`. Cover the stale path, the
   fresh path, the no-runs path (abstain, never fresh), the API-error path (both
   an injected throw and a real missing binary), a disabled state, an unparsable
   timestamp, exit precedence, a zero workflow list, and CLI usage (exit 2).
   Also add a workflow-shape test: the watchdog runs on `push: main`, names
   every weekly cron, has no PR trigger, and no watched schedule sits at `:00`.
2. **GREEN:** `scripts/schedule-staleness.mjs`, using the `isMain` entry guard
   and exit codes 0/1/2/3.
3. Register the script in `ts/test/script-entry-guards.test.ts` `CASES` (usage →
   2), and in `harness.config.json` `entropy.entryPoints` /
   `performance.entryPoints`.
4. `.github/workflows/schedule-watchdog.yml` (`contents: read`,
   `actions: read`).
5. Change both crons, fix the stale `arch-snapshot.yml` comment, and record the
   re-registration in a comment in each file.
6. Run the four gates from `ts/` (build, typecheck, format:check, test), the
   skills gates, docs lint (markdownlint), actionlint, and the harness checks.
7. Push, open the PR, and watch CI.

## 7. Remediation actions / assumptions made

- **Root cause is a hypothesis** (see §2). The evidence supports scheduler load
  shedding at `:00`. A stale registration cannot be excluded. The fix covers
  both.
- **Default: the minutes `:37` / `:43`.** I chose them; the human named no
  specific minutes. The rule was: not on a quarter-hour, and not colliding with
  `:23`.
- **Default: an 8-day threshold.** I chose it from the observed delays.
- **Default: the watchdog host** is a new push-to-`main` workflow with a daily
  backup schedule. I preferred it to piggybacking on Guardian precision, which
  is itself a weekly cron and could go dark with the rest.
- **Default: Guardian precision is watched too.**
- **Assumption: the watchdog's token.** `${{ github.token }}` with
  `actions: read` can read workflow runs on this public repo. No new secret is
  needed.
- **Accepted cost:** the watchdog is red on `main` from merge until the first
  Monday run lands (see §5).
- **Not done:** no issue was filed for the pre-existing `actionlint` info
  findings or the missing `permissions:` block on `harness-architecture.yml`.
  The orchestrator forbade side-channel GitHub writes. They are listed as next
  steps in the handoff.
