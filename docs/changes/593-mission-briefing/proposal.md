# canary-mission-briefing: turn a PR diff into a test charter for a person (#593)

**Keywords:** exploratory-testing, test-charter, diff-scope, tier-0,
diff-coverage, test-inventory, edge-cases, abstention, sticky-comment

> **Status: signed off 2026-09-15.** A human reviewed this proposal and accepted
> its decisions H1-H6 as written, so the recommended defaults stand and a build
> round may proceed from it (sign-off recorded on #593). The document itself is
> still spec only: it contains no code, no skill files and no CLI wiring, and
> the defaults marked _assumption_ were chosen by the authoring lane rather than
> asked. Implementation is three PRs: the facts CLI, then the skill, then the
> opt-in PR comment. #593 stays open until all three land.

## Overview

Three canary surfaces read a diff, and they are not interchangeable:

| Surface                   | Output            | Audience       |
| ------------------------- | ----------------- | -------------- |
| `canary-pr-guardian`      | a gate verdict    | CI             |
| `canary-generate-test`    | test code         | the suite      |
| `canary-mission-briefing` | a testing charter | a human tester |

A charter is a short plan for a person doing manual or exploratory verification.
It says what to verify by hand, which edge cases this particular diff invites,
which existing tests already touch the changed code, and which changed lines
nothing touches. It is **not a gate**: it has no pass or fail and never changes
a check's colour. It is **not generated code**: it never writes a test file.

### Goals

1. Given a diff, produce a charter a tester can work through top to bottom.
2. Reuse the guardian's diff scoping and Tier-0 coverage result instead of
   re-reading coverage a second way.
3. Compose `canary-edge-case-discovery`, `canary-critical-areas` and
   `canary inventory` rather than re-deriving what they already produce.
4. Never imply coverage it did not measure. Missing data reads "coverage
   unknown", and an empty or unparseable diff abstains (ADR 0009).
5. Never be mistaken for the guardian's gate comment.

### Out of scope

- Any verdict, exit code that fails CI, or required check.
- Writing, editing or promoting tests (that is `canary-generate-test` and
  `canary-promote-test`).
- Tracking whether a tester actually ran the charter. See Decision H5.
- Non-GitHub hosts for the comment surface.

## Decisions made

| #   | Decision                   | Choice                                                                                                                                                                                                                                               | Rationale                                                                                                                                                                                                                                                                                 |
| --- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Coverage source (open q 1) | **Reuse Tier-0.** Consume `scopeDiff()` (`ts/src/guardian/pr-check.ts:94`), the same skip, test-file and type-only filters, and the coverage ladder's `CoverageInputState` / `coverageStatus()` (`ts/src/guardian/diff-coverage/orchestrator.ts:90`) | One definition of "what changed" and "what is covered". A second coverage read could disagree with the guardian comment on the same PR, and a tester would have no way to know which one is right. _Assumption._                                                                          |
| D2  | Output surface (open q 2)  | **Both, stdout first.** Markdown to stdout is the default. `--comment` upserts a separate sticky PR comment, opt-in only                                                                                                                             | A charter is read by the person who asked for it; posting on every PR adds noise nobody requested. The comment is available for teams who hand PRs to a tester. _Assumption._                                                                                                             |
| D3  | Comment marking            | Own marker `<!-- canary-mission-briefing -->`, heading `Test charter (advisory, not a gate)`, first line states "This is not a verdict; the guardian comment is the gate", no status emoji                                                           | `findSticky()` (`ts/src/guardian/pr-comment.ts:135`) matches on a body that STARTS WITH the marker, so a distinct marker can never overwrite or be overwritten by the guardian sticky. Adjudication (`adjudication.ts:101`) keys on `STICKY_MARKER`, so the charter is never adjudicated. |
| D4  | Surface split              | **Both:** a deterministic CLI subcommand `canary briefing` for the facts (scope, coverage, inventory matches, abstention) and a skill `canary-mission-briefing` that adds the judgment sections (manual checks, edge cases)                          | Matches existing splits: `canary batwoman` (`ts/src/batwoman-cli.ts`) plus its skill, and `canary guardian pr-check` plus `canary-pr-guardian`. Facts stay testable without an LLM; judgment stays in the skill.                                                                          |
| D5  | Edge cases                 | The skill calls `canary-edge-case-discovery` per changed unit and keeps only cases tied to a changed line, labelled with the six categories                                                                                                          | Composition, not re-derivation. Cases that do not cite a changed line are dropped, so the charter stays diff-shaped.                                                                                                                                                                      |
| D6  | Risk ordering              | Order charter items by `.canary/critical-areas.json` `rank_score` when present; otherwise diff order with a line saying "risk ranking unavailable"                                                                                                   | Reuses `canary-critical-areas`; `canary-failure-impact` is referenced only for the top item, to keep cost bounded. Missing ranking is stated, not hidden.                                                                                                                                 |
| D7  | "Which tests cover it"     | Two separate columns: **executed** (from Tier-0 coverage, when verified) and **imports the module** (from `.canary/test-inventory.json` `files[].targets`)                                                                                           | Inventory targets are a static import match, not execution. Merging them would present a guess as coverage.                                                                                                                                                                               |
| D8  | Exit codes                 | 0 charter written (including "coverage unknown"); 3 (`EXIT_ABSTAINED`) empty diff, unparseable diff, or zero scoped units after filtering; never 1 for findings                                                                                      | CLI-wide gate contract as used by `canary inventory` (`ts/src/inventory/inventory-cli.ts`). Gaps in the charter are content, not failure.                                                                                                                                                 |

### Approaches considered

1. **Own coverage read inside the briefing.** Independent of guardian, but a
   second diff and coverage path that can drift from the gate comment on the
   same PR. Rejected (D1).
2. **A section appended to the guardian sticky.** No new comment, but mixes an
   advisory charter into a gate verdict — the exact confusion the issue forbids.
   Rejected (D3).
3. **CLI facts plus skill judgment, separate marker (chosen).** Slightly more
   surface, but each part has one audience and the deterministic half is unit
   testable.

## Technical design

### Data flow

```text
diff (stdin | --diff file | --base ref)
  -> scopeDiff + guardian filters           (reuse, pr-check.ts)
  -> abstain if 0 units                      (exit 3)
  -> coverage ladder -> CoverageInputState   (reuse, diff-coverage/)
  -> inventory lookup by module              (.canary/test-inventory.json)
  -> critical-areas lookup                   (.canary/critical-areas.json)
  -> BriefingFacts JSON  (canary briefing --json)
  -> skill: manual checks + edge cases (per unit, cited to lines)
  -> Markdown charter  -> stdout  | --comment -> sticky upsert (own marker)
```

### `BriefingFacts` (CLI JSON, sketch)

```json
{
  "schema_version": 1,
  "provenance": "Diff: `abc1234567...def7654321` (2 files, via ci-base)",
  "coverage": { "status": "verified | partial | unavailable" },
  "risk_ranking": "available | unavailable",
  "inventory": "available | unavailable",
  "units": [
    {
      "path": "src/cart/discount.ts",
      "added_ranges": [[12, 30]],
      "coverage": "covered | uncovered | unknown",
      "executed_by": ["tests/cart/discount.test.ts"],
      "imported_by": ["tests/cart/discount.test.ts"],
      "rank_score": 0.72
    }
  ]
}
```

`provenance` reuses `provenanceLine()` (`pr-check.ts:1100`), so a merge-ref diff
carries the same warning the guardian shows.

### Charter structure

Sections a tester works through, in order:

1. **Header** — advisory banner, diff provenance, data availability line
   (coverage / inventory / risk ranking: available or unknown).
2. **Mission** — one or two sentences: what changed, from the tester's side.
3. **Verify by hand** — a checklist, highest risk first, each item citing
   `path:line`.
4. **Edge cases this diff invites** — grouped by the six categories, only
   categories with a case tied to a changed line.
5. **Existing tests** — table: unit, executed by, imports the module.
6. **Nothing covers** — changed ranges with no executing test, or "coverage
   unknown" for every unit when coverage was unavailable.
7. **Out of this charter** — what was skipped (filtered files, skipped inventory
   entries), so the tester knows the edges of the plan.

### Synthetic example

For a made-up diff adding a percentage discount to `src/cart/discount.ts` (lines
12-30) and a label in `src/cart/summary.tsx` (lines 40-44):

```markdown
<!-- canary-mission-briefing -->

## Test charter (advisory, not a gate)

This is not a verdict; the guardian comment is the gate. Diff:
`abc1234567...def7654321` (2 files, via ci-base). Coverage: partial · Inventory:
available · Risk ranking: unavailable (diff order).

**Mission:** explore the new percentage discount at checkout and how the cart
summary shows it.

### Verify by hand

- [ ] Apply a 10% discount to a two-item cart; total and label agree
      (`src/cart/discount.ts:18`)
- [ ] Remove the discount; label disappears (`src/cart/summary.tsx:42`)

### Edge cases this diff invites

- Boundary values: 0%, 100%, 100.5% (`discount.ts:21` has no upper clamp)
- Locale and timezone: label in a locale using a decimal comma
  (`summary.tsx:43`)

### Existing tests

| Unit          | Executed by                   | Imports the module            |
| ------------- | ----------------------------- | ----------------------------- |
| `discount.ts` | `tests/cart/discount.test.ts` | `tests/cart/discount.test.ts` |
| `summary.tsx` | coverage unknown              | none found                    |

### Nothing covers

- `src/cart/discount.ts:25-30` (rounding branch)
- `src/cart/summary.tsx:40-44` — coverage unknown, not "uncovered"
```

## Integration points

### Entry points

- New CLI subcommand
  `canary briefing [--diff <file> | --base <ref>] [--json] [--comment]`.
- New skill `agents/skills/claude-code/canary-mission-briefing/` (SKILL.md +
  skill.yaml) and a `/canary-mission-briefing` command.

### Registrations required

- Register the command in `ts/src/cli.ts`; add the module to both
  `entropy.entryPoints` arrays; architecture layer assignment for the new module
  (it may import guardian scoping, never the reverse).
- Skill plugin manifest and `canary doctor` `requires:` frontmatter.

### Documentation updates

- `AGENTS.md` skill list; a guide `docs/guides/mission-briefing.md` that
  includes the three-surface table from this spec; guardian skill doc gets a
  one-line pointer that the charter comment is not its output.

### Architectural decisions

- D1 (shared Tier-0 scoping between a gate and a non-gate consumer) may warrant
  an ADR, because it makes `scopeDiff` and the filters a public seam.

### Knowledge impact

- Concept: "test charter" as a distinct output class from verdict and generated
  test. Relationship: briefing consumes guardian scope, inventory and
  critical-areas.

## Success criteria

1. When given a diff with at least one scoped unit, `canary briefing --json`
   shall emit `BriefingFacts` with `schema_version: 1` and exit 0.
2. **(abstention)** When the diff is empty, cannot be parsed, or has zero units
   after the guardian filters, `canary briefing` shall print `Abstained:` with
   the reason, write no charter and no comment, and exit 3.
3. If coverage status is `unavailable`, then the charter shall label every unit
   "coverage unknown" and shall not list any unit under an "uncovered" or
   "covered" label.
4. If `.canary/test-inventory.json` is absent or has an unknown
   `schema_version`, then the charter shall state "inventory unavailable" and
   the "Imports the module" column shall not read "none found".
5. When a unit's coverage is verified, the "Executed by" and "Nothing covers"
   sections shall agree with the guardian's Tier-0 result for the same diff
   (asserted by a test running both on one fixture).
6. When `--comment` is used, the posted body shall start with
   `<!-- canary-mission-briefing -->`, and a run shall never update a comment
   whose body starts with `<!-- canary-pr-guardian -->` (fake-client test with
   both present).
7. The charter shall contain no pass/fail word in its heading, no status emoji,
   and the literal "not a gate".
8. `canary briefing` shall never exit 1, and shall write no file under `tests/`.
9. Every "Verify by hand" and edge-case item produced by the skill shall cite a
   `path:line` inside the diff's added ranges (skill eval checks citations).
10. If a PR comment write returns 403, the command shall print the charter to
    stdout with a `::warning::` and exit 0.

## Implementation order

1. **PR 1 — facts CLI:** `canary briefing` with scoping reuse, coverage status,
   inventory and critical-areas lookup, JSON and plain Markdown sections 1, 5,
   6, 7; criteria 1-5, 7, 8.
2. **PR 2 — skill:** `canary-mission-briefing` skill adding sections 2-4 by
   composing edge-case-discovery and critical-areas; criterion 9.
3. **PR 3 — comment surface:** `--comment` with its own marker; criteria 6, 10.

## Assumptions

- Tier-0 reuse is possible without changing guardian behaviour (read-only use of
  exported functions).
- Stdout default; comment opt-in.
- Command name `canary briefing`; skill name `canary-mission-briefing`.
- Inventory import matches are shown separately from executed coverage.
- Risk ranking is optional input, never computed inline by the CLI.
- GitHub is the only comment host in v1.

## Accepted risks

- LLM-written manual checks may be generic; criterion 9 (line citation) is the
  only mechanical guard.
- Inventory `targets` miss dynamic imports, so "none found" can be wrong; the
  column name says "imports", not "covers".
- Making `scopeDiff` a shared seam couples the briefing to guardian refactors.

## Decisions for the human

| #   | Decision                                   | Recommended default                                          |
| --- | ------------------------------------------ | ------------------------------------------------------------ |
| H1  | Reuse guardian Tier-0 or own coverage read | Reuse Tier-0 (D1)                                            |
| H2  | Output surface                             | Stdout Markdown by default, sticky comment opt-in (D2)       |
| H3  | Skill, CLI, or both                        | Both: CLI facts, skill judgment (D4)                         |
| H4  | Ship as three PRs or one                   | Three PRs, in the order above                                |
| H5  | Record whether a charter was worked        | No in v1; revisit after use (no reactions, per repo history) |
| H6  | Name (`briefing` subcommand)               | `canary briefing` / `canary-mission-briefing`                |
