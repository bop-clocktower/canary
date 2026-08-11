# Roadmap priority and the one-line field contract

All counts, labels, and issue states in this document were measured on
**2026-08-07** against commit `a2fc620d`, with `@harness-engineering/cli`
v10.2.0 locally and the `@harness-engineering/cli@10` pin used by CI
(`.github/workflows/harness-quality.yml`). Where a number is a snapshot rather
than an invariant, it says so.

## Overview

`docs/roadmap.md` cannot answer "what should I work on next", and cannot be
safely written by the tooling that owns it. Two independent defects:

1. **No priority signal.** 36 of 38 rows read `Status: backlog` (2026-08-07).
   Ranking the backlog today means re-deriving it by hand from issue bodies
   every time.
2. **The file has drifted out of its own schema contract.** Field values must be
   a single physical line — the contract is stated in the file's own header
   comment. **43 fields** span more than one line — all 38 `Summary` fields and
   5 `Blockers` fields — so harness's roadmap parser reads only the first line
   of each and silently discards the rest. (An earlier draft said 38; it had
   counted only the obvious field. The detector found the other 5, which is the
   argument for a mechanical check over a hand estimate.)

A third, smaller gap: 10 open issues have no roadmap row, so the roadmap is not
a complete picture of committed work.

### Goals

Each goal is written as a condition someone else can check without asking us
what we meant.

1. **Priority is a field, not a re-derivation.** Every row in `docs/roadmap.md`
   carries a `Priority` whose value is one of `P0`, `P1`, `P2`, `P3` — the enum
   the upstream harness roadmap schema already validates and hard-fails on.
2. **The one-line contract is mechanically enforced, not remembered.**
   `ts/test/roadmap-field-contract.test.ts` fails when any field value in
   `docs/roadmap.md` spans more than one line, and fails as an abstention if it
   inspects zero fields. Detection is this test; the `.prettierignore` entry is
   what makes the corrected file writable at all (D2).
3. **Roadmap coverage of committed work is complete and its denominator is
   stated.** Every open issue that does not carry the GitHub label `bug` has a
   roadmap row linked by `External-ID`, and
   `scripts/roadmap-denominator-check.mjs` exits 0 while printing a non-zero
   linked-row count.

### Non-goals

- **Pushing priority to GitHub** (labels or issue bodies).
  `scripts/roadmap-sync.mjs --apply` replaces issue bodies wholesale, which
  destroys hand-written context, and the script exposes no opt-out. The roadmap
  stays the priority system of record for now. (Same reasoning that closed
  `bop-clocktower/canary#595`, "roadmap sync sees 2 of 30 tracker issues".)
- **Migrating row prose into issues** — the "roadmap as thin index" end state,
  in which each row shrinks to a title plus an issue link and all prose lives in
  the GitHub issue. Structurally correct, a one-way door, and its own decision.
- **Fixing the gate-integrity bugs themselves.** `#481` (coverage gate: branch
  headroom is 0.48pt) is tracked here as a roadmap row because it is planned
  work. The three `bug`-labelled issues are out of scope and stay bugs: `#587`
  (harness `functionLength` measured to EOF), `#590` (review-test LINT-006
  matches `test()` inside string literals), `#626` (check-arch and `ci check`
  disagree on the same data).

## Decisions made

**D1 — Priority lives in `docs/roadmap.md`, not GitHub.** `Priority` is already
a first-class field in the harness roadmap schema; this repo has simply never
populated it. Verified empirically on 2026-08-07 against harness CLI v10.2.0: a
`P2` injected into a copy of the file survived `harness roadmap shard` followed
by `regen`, and an invalid value hard-failed with
`Valid priorities: P0, P1, P2, P3`. So the field is validated on read. Pushing
priority to the tracker would require `roadmap sync --apply`, rejected for the
reason given under Non-goals.

**D2 — The ignore entry and the test do different jobs; both are required.** Not
belt-and-braces. One unblocks writing the correct file, the other detects when
it stops being correct. All three findings below were verified on 2026-08-07:

- **`.prettierignore` is load-bearing for the local write path.**
  `.harness/hooks/quality-warner.js` is a `PostToolUse:Edit|Write` hook that
  runs `prettier --check --ignore-unknown <file>` on **every file written in
  this repo** and exits 2 — a hard block — on any violation. Because prettier's
  `proseWrap: "always"` considers a one-line 200-column `Summary` a violation,
  _an agent physically cannot write the unwrapped roadmap while the file is
  under prettier's governance._ The hook blocks the repair. Verified: with
  `docs/roadmap.md` listed in a root `.prettierignore`, that same command
  exits 0. **So the ignore entry is a precondition for step 1, not a nicety.**
- **No CI job FORMATS it — but one LINTS it, and that one is required.** The CI
  format gate (`harness-quality.yml`) and the `fmt_gate` function in
  `.githooks/pre-commit` both run each package's own `format:check`, scoped to
  `ts/` and `agents/skills/` only, so `docs/roadmap.md` is outside both and the
  ignore entry changes nothing about formatting in CI. **An earlier revision of
  this spec generalised that into "no CI job formats or checks `docs/`", which
  is false and was the more dangerous half of the claim.** `markdownlint` in
  `.github/workflows/docs-lint.yml` globs every markdown file with no path
  filter and is listed in `.github/required-checks.json`. It stays green only
  because `docs/roadmap.md:12` carries `markdownlint-disable-file MD013`;
  unwrapping the fields took the file from 12 long lines to 51, so that comment
  is now load-bearing on a merge gate. `harness roadmap promote` is known to
  strip it (`#273`), and the only thing that restored it was a pre-commit hook
  requiring per-clone `core.hooksPath` opt-in. The field-contract test therefore
  asserts the comment's presence. The harm in the old wording was not the
  inaccuracy — it told the next reader the file had no CI relationship, which is
  exactly the coupling that gets a "redundant-looking" disable comment deleted.
- **The exemption is CWD-scoped.** Prettier resolves `.prettierignore` relative
  to the current working directory, not the repo root and not the file's
  location. From `ts/` — where this repo's four gates run —
  `npx prettier --write ../docs/roadmap.md` reflows every field as if the entry
  did not exist. Recorded in `.prettierignore`'s own header and in `AGENTS.md`,
  because the trap is in the habit, not in the config.
- **Prettier is not the sole author of the current wrapping.** The file is _not
  prettier-clean today_ — `npx prettier --check docs/roadmap.md` reports it —
  which it would be if prettier were the only writer. The provenance is mixed:
  the hook forces prettier-clean (wrapped) output from any agent edit, while
  `scripts/roadmap-sync.mjs` and `scripts/roadmap-groom.mjs` write the file
  directly and bypass the hook entirely.
- **Detection is `ts/test/roadmap-field-contract.test.ts`**, which runs in the
  existing `ts/` vitest suite and is the only thing that _fails_ on a wrapped
  field. It catches a hand-wrapped edit, a script write, an editor reflow, and
  an ad-hoc `prettier --write` alike. The ignore entry cannot detect anything;
  the test cannot unblock anything.

**D3 — This is not an upstream bug.** The one-line-per-field contract is
documented in the roadmap's own header comment. Harness reads exactly what the
schema specifies; our file drifted. What _is_ worth reporting upstream is the
asymmetry: harness errors loudly on an invalid `Priority` value but silently
keeps a wrapped field's first line. A contract violation should fail to parse or
warn, never silently discard. **Status: reported upstream as
[`Intense-Visions/harness-engineering#1328`](https://github.com/Intense-Visions/harness-engineering/issues/1328)
(open); tracked locally as `#629`.** Verifying criterion 4 on 2026-08-08 turned
up a second instance of the same asymmetry: a `shard` + `regen` round-trip
deletes this file's entire 8-line header comment block — the
`markdownlint-disable-file` directive and the note documenting the one-line
contract — and exits 0 both ways. Latent rather than active: no CI workflow or
script in this repo invokes `shard`, `regen`, or `unshard`.

Re-verified on 2026-08-10 against `@harness-engineering/cli` **v10.2.0 → v11.1.1**
(the version this repo's workflows now pin): the header strip still reproduces —
2 HTML comments before, 0 after, exit 0 both ways. The v10 field-truncation half
is genuinely fixed; the file now _grows_ through a round-trip (54,183 → 54,729
bytes) because `regen` adds missing `Assignee` rows. So `#629` narrows to the
comment strip alone, which is covered upstream by `#1328` and locally by the
`roadmap_comment_guard.mjs` step in `.githooks/pre-commit`. Neither blocks this
change.

**D4 — The GitHub `bug` label decides, not the title.** Of the 10 open issues
with no roadmap row, 3 carry the `bug` label and stay bugs — they get fixed and
closed, not tracked as plan. The other 7 are committed work and get rows:

| Issue  | Title                                                         | Row? |
| ------ | ------------------------------------------------------------- | ---- |
| `#390` | ADR: sync vs async history-store interface for the TS cutover | yes  |
| `#479` | Extract a shared skill-CLI arg parser + conformance suite     | yes  |
| `#481` | coverage gate: branch headroom is 0.48pt; ratchet the rest    | yes  |
| `#487` | Execute the documented commands: run SKILL.md examples in CI  | yes  |
| `#488` | Three test-design rules the port would have benefited from    | yes  |
| `#504` | framework detection and scaffold are monorepo-unaware         | yes  |
| `#544` | Entropy scan ran for the first time: triage 718 findings      | yes  |
| `#587` | harness: functionLength measured to EOF                       | no   |
| `#590` | review-test: LINT-006 matches `test()` in string literals     | no   |
| `#626` | check-arch and `ci check` disagree on the same data           | no   |

**The rule is the label, and `#504` is why that has to be said explicitly.** Its
title begins with the string `[bug]`, but it carries no labels at all, so
`label != bug` classifies it as work and it gets a row. Anyone re-deriving this
set by reading titles will get a different answer than the rule gives. The
selecting query is:

```bash
gh issue list --state open --limit 300 --json number,labels \
  -q '.[] | select([.labels[].name] | index("bug") | not) | .number'
```

This makes the labelled count an intentional number rather than an accident,
which is what `scripts/roadmap-denominator-check.mjs` reports on.

**D5 — Seed priorities from blast radius, and record the basis.** "Blast radius"
here means _how far a failure of this item reaches_ — how many other roadmap
rows, gates, or consumer-facing surfaces are affected. Gate integrity outranks
consumer-facing correctness, which outranks enablers, which outrank net-new. The
seeding is a starting position, not a permanent ranking; what matters is that
the field exists and is populated, so a future change is an edit rather than a
re-derivation.

## Technical design

### Priority: the durable contract

The scale is fixed by the upstream harness roadmap schema — `P0 | P1 | P2 | P3`.
There is no local scale to invent. What _is_ local and contestable is what each
level means here, so each is written as a predicate someone can evaluate against
a candidate row rather than a mood:

| Value | Predicate                                                                                                               |
| ----- | ----------------------------------------------------------------------------------------------------------------------- |
| `P0`  | A check listed in `.github/required-checks.json` is red, is wrong, or would become wrong on merge.                      |
| `P1`  | Reproducible from a consumer-facing CLI or skill invocation, **or** has an open PR or worktree today.                   |
| `P2`  | Enabler: at least two other roadmap rows name it as a blocker, or it removes duplicated implementation across ≥3 sites. |
| `P3`  | Net-new capability; no other roadmap row depends on it.                                                                 |

The per-issue seeding roster is a one-time triage snapshot, not part of this
contract, so it lives under Rollout below.

### Why the file leaves prettier's governance

This is the permanent constraint in this change, and it is worth stating as its
own decision rather than as a clause inside the test design.

**The trade-off.** `docs/roadmap.md` gains a machine-parseable field grammar and
gives up auto-wrapping. From this point on, _nothing may reflow this file_ — not
prettier, not an editor's format-on-save, not a future docs tool. That
constraint binds every future writer of the file, human or `manage_roadmap`.

**Scope of the exemption.** `.prettierignore` gains exactly one entry:
`docs/roadmap.md`. An earlier draft also listed `docs/roadmap.d/`; that
directory does not exist — it is transient `harness roadmap shard` output — so
ignoring it would exempt a surface no guard covers. **The exempted set and the
guarded set are the same single file, by construction.** If sharded output is
ever committed, the ignore entry and the test's file list must be extended
together, in one change.

> **Superseded by #630.** Scoping the exemption to one file left
> `docs/roadmap-archive.md` — which `scripts/roadmap-groom.mjs` fills with rows
> moved verbatim out of `docs/roadmap.md` — in exactly the broken shape this
> section describes: 60 of 63 rows with a wrapped `Summary`, held there by a
> `prettier --check` that called the file clean. #630 adds it to both sets and
> replaces the "extend them together, in one change" instruction with a
> derivation: the test now globs the `docs/` entries in `.prettierignore`, so
> the two sets are the same set mechanically and a shard directory needs only an
> ignore entry. #630 also adds the content floor this section's guard cannot
> provide — a value cut to its first physical line is one line, so the wrap
> check reports it clean.

**Dependency between the two halves of this spec.** They can ship independently,
and the ordering is deliberate rather than forced: `Priority` is a short,
single-line field, so it would not itself be wrapped, and adding it does not
require the invariant. The invariant ships first because it is the half that
carries risk, and shipping it first means every later content edit lands under
its guard. Priority is additive and reversible; the one-line invariant plus
prettier exemption is permanent.

### The field grammar

New test, `ts/test/roadmap-field-contract.test.ts`, offline, parses
`docs/roadmap.md` as text. The grammar it enforces:

- A **field line** is `- **Key:** value` at column 0 with a `-` bullet — the
  only shape harness reads. Lines are matched _permissively_ (any bullet, any
  indent) and the wrong shapes are then rejected by name, because a strict match
  would skip them silently, and a skipped line is how a wrapped value hides.
- The line following a field line must be one of: another field-shaped line, a
  blank line, a markdown ATX heading, an HTML comment (`^<!--`), or EOF.
- **Any other non-blank line following a field line is a continuation, and is a
  failure.** Stating the rejection rule positively matters: the field regex
  alone describes what a field looks like, not what a violation looks like, and
  the assertion's precision would otherwise depend on an unwritten reading.
- **Denominator assertion.** The test asserts `fieldsInspected > 0` and prints
  the count on both pass and fail. A run that parses nothing fails as an
  abstention rather than passing vacuously — the failure mode that produced
  `#595`.

Repairing the existing wrapped summaries is mechanical: join continuation lines
back onto their field line. No content is dropped; the file gets longer per
line, not shorter.

## Rollout

One-time migration arithmetic. Everything here is dated and expected to age;
none of it is a durable contract.

### Priority seeding (as of 2026-08-07)

| Value | Rows seeded                                                                                                                                                                                                                                                                                   |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `P0`  | `#481` (coverage-gate branch headroom), `#544` (entropy-scan triage)                                                                                                                                                                                                                          |
| `P1`  | `#504` (monorepo-unaware detection), `#538` (history store), `#523` (no uninstall path), `#522` (stale-plugin check), `#603` (TestTracker ingest), `#341` (environment/user-context consumption)                                                                                              |
| `P2`  | `#479` (shared skill-CLI arg parser), `#550` (company-knowledge package), `#462` (personas), `#487` (run SKILL.md examples), `#486` (diff-scoped mutation testing), `#390` (history-store ADR), `#488` (test-design rules), `#601` (api-signature drift), `#564` (harness-config denominator) |
| `P3`  | The remaining rows — those in the _Skills_ and _Engine_ sections of `docs/roadmap.md` with no other row naming them as a blocker (29 rows)                                                                                                                                                    |

Two of those entries were decided _during_ this change rather than in the
2026-08-07 triage, and D5 requires the basis be recorded somewhere more durable
than a commit message:

- **`#341` moved P3 → P1.** It is product-lies in its purest form and is
  reproducible from a consumer-facing invocation, which is the P1 predicate.
- **`#564` was missing from the D4 table entirely** and is seeded `P2`. Review
  of this change found it: open, `harness-managed`-labelled, created 2026-08-06
  — before the baseline, so its absence was a triage miss rather than aging. It
  is the same denominator class as `#481` and `#544` (a configured rule that
  matches nothing still reports as configured), but it does not meet the P0
  predicate because no required check is red or wrong today. See the Goal 3 note
  under Verification.

A third row, `#630`, was added for the work this review deferred (see
Verification). Distribution across the resulting 47 rows: `P0`=2, `P1`=6,
`P2`=10, `P3`=29.

All issue numbers are in `bop-clocktower/canary`; the URL form is
`https://github.com/bop-clocktower/canary/issues/<n>`.

### The 7 new rows

Added via the harness MCP tool `manage_roadmap` (action `add`, from
`@harness-engineering/cli` v10) or hand-written to the same shape, each carrying
`Status`, `Priority`, `Summary`, and an `External-ID` linking the existing
issue.

Each of those 7 issues also needs the GitHub label `harness-managed` — the label
`scripts/roadmap-sync.mjs` enumerates by, so an unlabelled issue is invisible to
sync and its row is reported as unlinked (root-caused in `#595`):

```bash
for n in 390 479 481 487 488 504 544; do
  gh issue edit "$n" --add-label harness-managed
done
gh issue list --state open --limit 300 --label harness-managed --json number \
  -q 'length'   # expect 46
```

### Expected end state

Measured baseline on 2026-08-07 at `a2fc620d`: 38 linked rows, 39 of 49 open
issues labelled, `roadmap-denominator-check.mjs` exit 0. After this change: 45
linked rows, 46 of 49 labelled, the 3 remaining being the `bug`-labelled ones by
D4. **These absolute numbers will grow as rows are added; the invariant is that
every linked row is visible to sync and the denominator is non-zero.** A
mismatch against 45/46/49 later is only a failure if the script's exit code is
non-zero.

## Integration points

**Entry points.** No new CLI command, MCP tool, or skill.

- **New file:** `ts/test/roadmap-field-contract.test.ts` — asserts every field
  value in `docs/roadmap.md` is a single physical line, that every row carries a
  `P0`–`P3` `Priority`, that the number of fields inspected is both non-zero and
  equal to the number of field-shaped lines, that every inspected field belongs
  to a row, and that the two out-of-band guards the file leans on are still in
  place (the `.prettierignore` exemption and the `MD013` directive).
- **Modified:** `.prettierignore` gains the single line `docs/roadmap.md`.
- **Modified:** `scripts/roadmap-sync.mjs` and
  `ts/test/roadmap-sync-wrapper.test.ts` — the `--apply` refusal message
  hard-coded "38 rows", a literal this change invalidated by adding rows. It now
  derives the count from the file, matches the `External-ID` _value_ rather than
  its prefix (so a serializer's em-dash placeholder does not read as linked),
  and degrades to "an unknown number" rather than a confident zero when the
  roadmap cannot be read. In scope because a safety message this change silently
  falsified is this change's to fix.
- **Content edits** to `docs/roadmap.md`: adds a `Priority` field to all 38
  existing rows and adds 8 new rows (the 7 in D4, plus `#564`, found during
  review of this change); unwraps the 38 wrapped `Summary` fields. No existing
  row is removed.

**Registrations required.** The seven issues enumerated in D4 — `#390`, `#479`,
`#481`, `#487`, `#488`, `#504`, `#544` — need the `harness-managed` GitHub
label, applied with the loop under Rollout. No barrel export or route
registration.

**Documentation updates.** `AGENTS.md` — the roadmap section gains:

1. The field contract: field values are one physical line, because harness's
   roadmap parser reads only the first physical line of a `- **Key:** value`
   field and discards everything after a wrap point, with no error on either
   side. Hence the `.prettierignore` entry.
2. The `P0`–`P3` scale with the predicates from Technical design.

Without note 1 the `.prettierignore` entry reads as an arbitrary exclusion and
gets removed by a future cleanup.

**Architectural decisions.** None warrant a standalone ADR: neither D1 (priority
lives in the roadmap file, not GitHub) nor D4 (the `bug` label decides which
issues get rows) changes a module boundary or a public interface, which is this
repo's ADR threshold. Both are recorded here and referenced from `AGENTS.md`.

**Knowledge impact.** One durable fact worth capturing: a machine-managed
markdown file under a prose formatter is a data-loss hazard, and the failure is
silent in both directions — the file looks maintained, the tool reports no
error. That generalises past the roadmap to any schema-bearing doc in the repo.

## Success criteria

Gates run from `ts/`; there is no root `package.json`, so `npm run build` at the
repo root exits 0 having done nothing.

1. **Field invariant, with a denominator that is complete, not merely
   non-zero.** On input containing a wrapped field,
   `ts/test/roadmap-field-contract.test.ts` fails and its message names the
   offending row, the field, and the text harness would discard. A run that
   inspects **zero** fields fails as an abstention rather than passing. And a
   run that inspects _some_ fields fails too, unless the number inspected equals
   the number of field-shaped lines and every inspected field belongs to a row.

   The completeness half was added after review: `fieldsInspected > 0` counts
   what the parser matched, and nothing counted what it _should_ have matched,
   so a demoted `####` row heading, a `*` bullet, or an indented field each hid
   a schema-invalid `Priority` behind a non-zero count. The counts appear in the
   failure messages; on a pass the assertions are silent, which is the ordinary
   vitest contract and is what "reporting" means here.

2. **Formatter exemption — the write path, not the file state.** _Verify by:_
   apply an Edit to `docs/roadmap.md` that leaves a `Summary` unwrapped and
   longer than 80 columns; the edit completes and
   `.harness/hooks/quality-warner.js` does not exit 2. That single observable is
   the criterion. _Mechanism, which is not itself the criterion:_
   `docs/roadmap.md` is listed in `.prettierignore`, so the hook's
   `npx prettier --check --ignore-unknown docs/roadmap.md` exits 0 — the file is
   excluded rather than reformatted, because reflowing it re-wraps the fields
   criterion 1 forbids wrapping. The ignore entry being present is necessary but
   not sufficient: the hook could still block for an unrelated reason (another
   rule, a stale hook build), so grepping `.prettierignore` is not evidence for
   this criterion. _Run it from the repo root_ — prettier resolves
   `.prettierignore` relative to CWD, so the same command from `ts/` exits 1 and
   would read as the exemption having broken. _Scope:_ local write path only. No
   CI job runs prettier over `docs/`, so a green CI run is not evidence either —
   though `markdownlint` does lint the file, and its own guard is criterion 7.
3. **Priority populated.** Every row in `docs/roadmap.md` carries a `Priority`
   field whose value is one of `P0`–`P3`; zero rows have an empty or `—`
   `Priority` value. Check: `grep -c '^- \*\*Priority:\*\* P[0-3]$'` equals the
   row count from `grep -c '^### '`.
4. **Round-trip, byte-exact.** With harness CLI v10 (the
   `@harness-engineering/cli@10` pin in `.github/workflows/`): copy
   `docs/roadmap.md` to a temp path, run `harness roadmap shard` against the
   copy, and `diff` the `Summary` field values extracted from the shards against
   those extracted from the source — the diff is empty. This is the check that
   the ~71% byte loss measured on 2026-08-07 (40,525 bytes → 11,640 through
   `shard` + `regen`) no longer occurs.
5. **Denominator check green.** `node scripts/roadmap-denominator-check.mjs`
   exits 0 with a non-zero linked-row count. As of 2026-08-07 that means 45
   linked rows and 46 of 49 labelled; the script asserts the invariant (every
   linked row visible to sync, denominator non-zero), not these specific counts,
   so the numbers may grow without the criterion failing.
6. **Gates pass, from `ts/`:** `npm run build`, `npm run typecheck`,
   `npm run format:check`, `npm test`.

   An earlier revision of this criterion named `npm run lint` as the third gate,
   on the general principle that lint and format are distinct concerns. **That
   script does not exist here** — `ts/package.json` defines exactly `build`,
   `typecheck`, `format:check`, and `test`, and
   `.github/workflows/harness-quality.yml` runs those same three plus the
   coverage gate. `format:check` _is_ this package's third gate, not an addition
   to it. Verified 2026-08-07: `npm run lint` exits 1 with
   `Missing script: "lint"`.

7. **The markdownlint directive survives.** `docs/roadmap.md` still contains
   `<!-- markdownlint-disable-file MD013 -->`, asserted by
   `ts/test/roadmap-field-contract.test.ts`. Added after review found that
   `markdownlint` is a _required_ check that lints this file with no path
   filter, and that unwrapping the fields took it from 12 long lines to 51 — so
   losing a comment `harness roadmap promote` is known to strip (`#273`) turns a
   merge gate red. _Verify by:_ deleting the directive from a scratch copy and
   running `npx markdownlint-cli` against it — 51 MD013 errors.

## Implementation order

1. **Contract first.** Add `docs/roadmap.md` to `.prettierignore`; then write
   `ts/test/roadmap-field-contract.test.ts`, which is red on first run because
   43 fields in `docs/roadmap.md` are currently prose-wrapped (38 `Summary`, 5
   `Blockers`); then unwrap them to green.

   The `.prettierignore` entry must land **first within this step**, and the
   reason is mechanical rather than stylistic: until it does,
   `.harness/hooks/quality-warner.js` blocks every write of an unwrapped field
   with exit 2, so the repair cannot be committed at all (D2). Doing the whole
   step before anything else then means every later edit lands under the guard —
   specifically, the step-1 test fails if any field is re-wrapped by a later
   step.

2. **Populate `Priority`** on every existing row (38 as of 2026-08-07) from the
   seeding roster under Rollout. Verify with criterion 3's `grep` equality.
3. **Add the 7 rows** enumerated in D4 and apply `harness-managed` to their
   issues with the loop under Rollout; verify the label count is 46.
4. **Docs** — in `AGENTS.md`'s roadmap section, add the field contract (one
   physical line per field, why the file is prettier-exempt, what harness
   silently discards) and the `P0`–`P3` predicate table.
5. **Verify** — all six success criteria above, including the round-trip byte
   check in criterion 4.

Step 1 is independently shippable and carries all of the risk; steps 2–4 are
content edits under its guard, and step 5 is the closing gate rather than a
phase of its own.

## Verification (step 5, re-run 2026-08-08 after review)

All seven criteria pass. Harness CLI v10.2.0; gates run from `ts/`, everything
else from the repo root.

| #   | Criterion                       | Result                                                                                                                                                                                                                              |
| --- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Field invariant + denominator   | `ts/test/roadmap-field-contract.test.ts` — 33/33 pass. 316 fields inspected, 316 field-shaped, 316 attached to a row: the denominator is complete, not merely non-zero.                                                             |
| 2   | Formatter exemption, write path | An Edit adding an unwrapped 200-column `Summary` completed; `.harness/hooks/quality-warner.js` did not exit 2. Mechanism, from the repo root: `npx prettier --check docs/roadmap.md` exits 0. Now also asserted by the test itself. |
| 3   | Priority populated              | `grep -c '^### '` = 47 and `grep -c '^- \*\*Priority:\*\* P[0-3]$'` = 47. Distribution `P0`=2, `P1`=6, `P2`=10, `P3`=29.                                                                                                            |
| 4   | Round-trip                      | `shard` on a temp copy → 47 shards; all 47 `Summary` values byte-identical to source. The ~71% loss (40,525 → 11,640) is gone. Header-comment strip filed as `#629` (D3) / upstream harness#1328; still live on v11.1.1.            |
| 5   | Denominator check               | `node scripts/roadmap-denominator-check.mjs` exit 0 — 47 linked rows, 47/51 open issues labelled. The 4 unlabelled are `bug`-labelled by D4: `#587`, `#590`, `#626`, `#629`.                                                        |
| 6   | Gates from `ts/`                | `build`, `typecheck`, `format:check` clean; `npm test` 2293 passed across 111 files.                                                                                                                                                |
| 7   | markdownlint directive          | `npx markdownlint-cli docs/roadmap.md` exits 0. Counter-test: with the directive stripped from a scratch copy, 51 MD013 errors — the guard is load-bearing, not decorative.                                                         |

**Goal 3 was not met on the first pass, and this is how it failed.** Review
found `#564` — open, `harness-managed`-labelled, created 2026-08-06, before the
baseline — with no roadmap row. D4's table enumerated "the 10 open issues with
no roadmap row" and omitted it, so the miss was in the triage rather than the
implementation. Criterion 5 could not catch it: the denominator script asserts
only _linked row → labelled issue_, never the reverse, so it exits 0 on a
roadmap missing rows entirely. Partial coverage reading as full coverage — the
same shape as the defect this change exists to remove, one level up. A row for
`#564` was added, and the direction the script does not check is now verified
explicitly:

```bash
comm -23 <(gh issue list --state open --limit 300 --json number,labels \
             -q '.[] | select([.labels[].name] | index("bug") | not) | .number' | sort -n) \
         <(grep -o 'canary#[0-9]*' docs/roadmap.md | sed 's/.*#//' | sort -n)
# empty — every non-bug open issue has a row
```

**What review changed in the guard itself.** The first implementation asserted
`fieldsInspected > 0` and stopped there. Five independently-reproduced inputs
passed that assertion with a schema-invalid `Priority` sitting in the file: a
`####` demoted row heading, a `###Foo` heading missing its space (which also
merged two rows and overwrote the first row's fields), a `*` bullet, an indented
field, and a duplicate field. Each was invisible because the scanner counted
what it matched and nothing counted what it should have matched. The scan now
compares strict against permissive and requires equality, reports the wrong
shapes by name instead of skipping them, handles CRLF and fenced blocks, and
asserts the two out-of-band guards (`.prettierignore`, `MD013`) the file leans
on. The suite went from 9 tests to 33.

Row and label counts moved from the 2026-08-07 baseline (45/46/49 → 47/47/51)
because filing `#629` and `#630` opened issues, and `#564` and `#630` gained
rows. Per criterion 5 that is not a failure: the script asserts the invariant,
not the absolute numbers.

### Deferred to a follow-up issue

Three review findings are real and out of scope here, so they are tracked rather
than half-done:

- `docs/roadmap-archive.md` carries the identical defect — 60 wrapped `Summary`
  fields, no `Priority`, still prettier-governed — and `roadmap-groom.mjs` moves
  rows into it verbatim.
- The guarded set is a hardcoded single path, so committed shard output would go
  unscanned while both denominators stayed non-zero.
- The test detects wrapping but not _truncation_: a file already flattened by a
  `shard` + `regen` round-trip is one-line-clean and passes.

Filed as `#630`, which carries its own roadmap row — Goal 3 applies to it like
any other non-bug issue, and the treadmill is the invariant working.

**Keywords** (free-text search aid for `harness roadmap` and repo grep; not
consumed by any tool): roadmap, priority, schema-contract, prose-wrap,
data-loss, denominator, harness-managed, roadmap-sync.
