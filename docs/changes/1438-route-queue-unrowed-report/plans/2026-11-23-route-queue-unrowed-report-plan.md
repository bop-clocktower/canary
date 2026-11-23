# Plan: route-queue report counts route:roadmap issues with no roadmap row

Spec: `docs/changes/1438-route-queue-unrowed-report/proposal.md`. Issue #1438.
One phase, complexity low. Integration tier: small.

## Task 1: tests first (red)

**Files:** `ts/test/route-labels.test.ts`

- The `gh` stub answers `repo view` with the fixture's `repo` field.
- `run()` sets `ROUTE_QUEUE_ROADMAP` to a fixture path.
- Pure helper cases for `unrowedRoadmapIssues`: names the one missing issue,
  ignores another repo's row, ignores non-roadmap routes, abstains on `null`
  text, abstains on zero rows, abstains on a missing repo.
- Script cases: a fixture missing one routed issue reports exactly it (JSON and
  text); a row-less roadmap gives `null` and `could not check`; an unreadable
  path gives the same; the exit code stays 0 in all three.
- Run `npx vitest run test/route-labels.test.ts` and record the red output.

## Task 2: helper

**Files:** `scripts/lib/route-labels.mjs`

- Export `unrowedRoadmapIssues({ routed, roadmapText, repo })` with the regex
  from `ts/test/agents-roadmap-counts.test.ts:44`, capturing the slug.

## Task 3: wiring

**Files:** `scripts/route-queue.mjs`

- Read the roadmap (`ROUTE_QUEUE_ROADMAP` or `<repo root>/docs/roadmap.md`); a
  read error becomes `null`.
- Ask `gh repo view --json nameWithOwner` through a non-fatal call; a failure
  becomes an empty slug, which abstains.
- Add `unrowedRoadmap` and `unrowedRoadmapReason` to the JSON, and one text
  line. Leave exit codes alone.

## Task 4: docs

**Files:** `AGENTS.md`, ADR 0043.

- Describe the new line and its abstention in AGENTS.md's route-queue entry.
- Add a note to ADR 0043's "nothing checks the invariant" finding.

## Task 5: verify

- Gates from `ts/`: build, typecheck, format:check, full test.
- Perf ratchet against an origin/main worktree, plus per-file length on the
  three touched source files.
