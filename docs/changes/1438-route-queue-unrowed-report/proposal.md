# route-queue report: route:roadmap issues with no roadmap row

**Keywords:** route-queue, roadmap, External-ID, denominator, abstention,
issue-fleet, ADR-0043

Issue: #1438. Decision record: ADR 0043
(`docs/knowledge/decisions/0043-route-roadmap-issues-get-a-roadmap-row-at-routing.md`).

## Overview and goals

ADR 0043 requires every `route:roadmap` issue to have a `docs/roadmap.md` row
carrying `**External-ID:** github:<owner>/<repo>#N`. Its "Finding: nothing
checks the invariant mechanically yet" (ADR 0043, line ~119) names
`scripts/route-queue.mjs report` as the place the gap should show. Today the
report counts routed / unroutable / untriaged / conflicted issues
(`scripts/route-queue.mjs:114-141`) and nothing else.

Goal: the report prints how many `route:roadmap` issues have no roadmap row, and
which, in both the text and `--json` output.

Out of scope: enforcing the invariant (that is upstream issue-fleet work),
writing the missing rows (Refs #1656), and changing any exit code.

## Decisions made

- **D1. Advisory (human-settled fork F6 (a)).** The new count never changes the
  exit code. Exit codes stay 0 / 2 / 3 exactly as documented at
  `scripts/route-queue.mjs:21-24`.
- **D2. Abstain, never report 0, when the check cannot be made.** If
  `docs/roadmap.md` cannot be read, or it holds zero `External-ID` rows for this
  repo, the text says `could not check (<reason>)` and the JSON field is `null`.
  A row-less roadmap would otherwise make every routed issue look unrowed or,
  worse, a failed read would look like "0 missing".
- **D3. Same row regex as `ts/test/agents-roadmap-counts.test.ts:44`.**
  `/\*\*External-ID:\*\*\s*github:(\S+?)#(\d+)/g` — identical to that test's
  pattern apart from capturing the slug — so the two counts agree.
- **D4. Repo slug from `gh repo view --json nameWithOwner`.** The script never
  names a repo explicitly; `gh issue list` reads whatever repo `gh` resolves.
  Asking `gh` for that same repo keeps the rows matched against the tracker the
  issues came from. A row for another repo does not count. If the lookup fails,
  the field abstains (D2) instead of exiting 2, so D1 holds.
- **D5. Zero rows means zero rows for THIS repo.** A roadmap whose only rows
  name another repo is no evidence about this one, so it abstains as well. This
  is stricter than "zero rows at all" and can only turn a misleading number into
  an abstention.
- **D6. Only `routed` issues whose route is `roadmap` are checked.** A
  conflicted issue carrying `route:roadmap` is already reported as conflicted;
  counting it twice would blur which fix it needs.
- **D7. Pure logic lives in the existing helper module.**
  `scripts/lib/route-labels.mjs` gains `unrowedRoadmapIssues()`; the script does
  the I/O. No new module, so no `entropy.entryPoints` change.
- **D8. Test-only path override.** `ROUTE_QUEUE_ROADMAP` points the script at a
  fixture roadmap, mirroring `ROUTE_QUEUE_GH_STUB`. Default is
  `<repo root>/docs/roadmap.md`, resolved from the script's own location, not
  the cwd.

## Technical design

`scripts/lib/route-labels.mjs`:

```js
export const ROADMAP_ROW = /\*\*External-ID:\*\*\s*github:(\S+?)#(\d+)/g;

/**
 * @returns {{ unrowed: number[] | null, reason: string | null }}
 */
export function unrowedRoadmapIssues({ routed, roadmapText, repo }) { ... }
```

- `roadmapText === null` -> `{ unrowed: null, reason: 'roadmap unreadable' }`
- `!repo` -> `{ unrowed: null, reason: 'repo unknown' }`
- zero rows for `repo` -> `{ unrowed: null, reason: 'zero External-ID rows' }`
- otherwise the sorted numbers of `routed` entries with `route === 'roadmap'`
  whose number has no row.

`scripts/route-queue.mjs report`:

- JSON adds `unrowedRoadmap: number[] | null` and
  `unrowedRoadmapReason: string | null` alongside the existing partition.
- Text adds one line: `route:roadmap without roadmap row: 2 (#5, #9)` or
  `route:roadmap without roadmap row: could not check (<reason>)`.

## Integration points

- **Entry Points:** none new; `node scripts/route-queue.mjs report [--json]`
  gains output.
- **Registrations Required:** none (no new module).
- **Documentation Updates:** the `route-queue.mjs report` description in
  `AGENTS.md` (~line 1246); ADR 0043's "nothing checks the invariant" finding
  gets a note that the report now shows it.
- **Architectural Decisions:** none. ADR 0043 already asks for this.
- **Knowledge Impact:** none beyond the ADR note.

## Success criteria

- When a fixture roadmap has rows for routed issues except one, the report names
  exactly that issue, in text and JSON.
- When the fixture roadmap has no `External-ID` rows, the JSON field is `null`
  and the text says `could not check`; never `0`.
- When the roadmap path cannot be read, the same abstention.
- A row for another repo does not satisfy an issue in this repo.
- The exit code is 0 in every one of those cases (examined >= 1 issue).

## Implementation order

1. Tests first in `ts/test/route-labels.test.ts` (stub learns `repo view`),
   shown red.
2. Helper in `scripts/lib/route-labels.mjs`, wiring in
   `scripts/route-queue.mjs`.
3. Docs (AGENTS.md, ADR 0043 note), gates, perf ratchet.

## Assumptions made

- Run autonomously in a roadmap-fleet lane: every sign-off took the recommended
  option, recorded here as D1-D8.
- Roadmap promotion (brainstorming step 7) is skipped. Adding a #1438 row here
  would collide with PR #1656, which backfills every missing row.
