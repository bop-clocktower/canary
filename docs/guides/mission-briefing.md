# Mission Briefing Guide

`canary briefing` turns a diff into a **test charter** — a short plan for a
person doing manual or exploratory verification of a change.

It is not a gate. It has no pass/fail, it never changes a check's colour, and it
never writes a test file.

## Three surfaces read a diff, and they are not interchangeable

| Surface                   | Output            | Audience       |
| ------------------------- | ----------------- | -------------- |
| `canary-pr-guardian`      | a gate verdict    | CI             |
| `canary-generate-test`    | test code         | the suite      |
| `canary-mission-briefing` | a testing charter | a human tester |

Confusing the first and the third is the specific mistake this command is
designed against, which is why the charter's heading carries its own disclaimer
and its first line disowns being a verdict.

## What ships today

Both halves of a charter ship. `canary briefing` produces the **facts**: what
the diff touched, what coverage could actually say about it, which test files
statically import it, and what was left out. The **judgment** — the mission,
what to verify by hand, and which edge cases this particular diff invites —
comes from the `canary-mission-briefing` skill, which reads those facts and
writes a judgment file. `canary briefing --judgment <file>` renders it, keeping
only items that cite a changed line, and `--comment` posts the result as its own
sticky PR comment.

Without `--judgment`, the charter carries the facts sections only rather than
empty headings.

### Charter sections

1. **Header** — the advisory disclaimer, diff provenance, and which inputs were
   available.
2. **Mission** — one sentence from the skill (judgment only).
3. **Verify by hand** — a checklist, each item citing `path:line` (judgment
   only).
4. **Edge cases this diff invites** — grouped by the six
   `canary-edge-case-discovery` categories, each citing `path:line` (judgment
   only).
5. **Existing tests** — measured execution and static imports, in separate
   columns.
6. **Nothing covers** — measured-unexecuted lines apart from unmeasured ones.
7. **Out of this charter** — filtered files, unavailable inputs, and every
   judgment item that was dropped, with its reason.

## Usage

```bash
# A charter for the working-tree diff
canary briefing

# A charter for an explicit diff, with a real coverage measurement
canary briefing --diff change.diff --coverage coverage/lcov.info

# The same facts as JSON, for a skill or another tool to consume
canary briefing --diff change.diff --json
```

### Flags

| Flag                | Meaning                                                                                                                                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--diff <file>`     | Unified diff to read; `-` reads stdin. Omitted, it resolves the PR diff from the base ref in CI, else the worktree.                                                                                 |
| `--coverage <file>` | Coverage report for the Tier-0 pass (lcov, Cobertura, or coverage JSON). Omitted, coverage reads "unknown".                                                                                         |
| `--root <dir>`      | Repository root, and where `.canary/` is looked for. Default: the current directory.                                                                                                                |
| `--config <file>`   | `harness.config.json` to read the guardian's `skip_globs` from. Default: `harness.config.json`.                                                                                                     |
| `--json`            | Emit `BriefingFacts` JSON instead of Markdown.                                                                                                                                                      |
| `--judgment <file>` | Skill-written judgment JSON. Items not citing an added line go to "Out of this charter"; unreadable input warns and degrades to facts only.                                                         |
| `--comment`         | Upsert a sticky PR comment under `<!-- canary-mission-briefing -->`; never edits the guardian comment. No PR context or a failed write (403 included, with `::warning::`) prints to stdout; exit 0. |

### Exit codes

| Code | Meaning                                                                                                  |
| ---- | -------------------------------------------------------------------------------------------------------- |
| 0    | A charter was written — including one that says "coverage unknown" throughout.                           |
| 3    | **Abstained** (ADR 0009): the diff was empty, unparseable, or scoped to zero units. Nothing was written. |

There is deliberately no failure code. A gap in a charter is content, not a
failure, so `canary briefing` never exits 1.

## Why an empty diff abstains

An empty charter reads as "nothing here needs testing", which is the one thing a
charter must never say by accident. So a diff that scopes to nothing exits 3
with an `Abstained:` line naming the reason, rather than printing a charter with
no rows in it.

The same reasoning drives the `--diff`-omitted path. It reuses the guardian's
own resolution (#369): in CI the PR diff is taken from the base ref, and the
working-tree fallback — which is empty on a clean CI checkout — is warned about
loudly rather than reported as a clean result.

## Where the facts come from

Scoping and coverage are **reused** from the guardian's Tier-0 machinery rather
than re-derived, so the charter and the gate comment cannot disagree about what
changed or what is covered on the same PR:

- **What changed** — `scopeDiff` plus the guardian's own filter chain. A docs
  file, a test, a test-support module, a type-only module, a re-export barrel
  and a non-source file are out of a charter for the same reasons they are out
  of the gate. Every one of them is listed under **Out of this charter** with
  its reason, so the tester can see the edges of the plan.
- **What is covered** — the Tier-0 coverage ladder. Only the coverage-verified
  tier (a real coverage run) yields `covered` / `uncovered`. The graph and
  heuristic tiers are inference, not execution, so a unit judged there reads
  **coverage unknown**.
- **Which tests import it** — `.canary/test-inventory.json`
  (`canary inventory`). This is a **static import match**, kept in its own
  column and never merged with execution, because "a test mentions this module"
  is not "a test ran this line".
- **Risk order** — `.canary/critical-areas.json` `rank_score` when present;
  otherwise diff order, with the missing ranking stated in the header.

## Honesty rules

These are contract, each pinned by a test in `ts/test/briefing-cli.test.ts` or
`ts/test/briefing-judgment*.test.ts`:

1. **No coverage data means "coverage unknown"** — never an implication that
   something is covered, and never a bare absence of findings.
2. **"Nothing covers" distinguishes measured from unmeasured.** A measured unhit
   line and a line nobody measured are different sentences.
3. **An absent inventory reads "inventory unavailable"**, never "none found" —
   including an inventory whose `schema_version` this reader does not know.
4. **No gate vocabulary.** No pass/fail word, no status emoji, and the literal
   phrase "not a gate" in the heading.

## `BriefingFacts` (`--json`)

```json
{
  "schema_version": 1,
  "provenance": "Diff: `abc1234567...def7654321` (2 files, via ci-base)",
  "coverage": { "status": "verified" },
  "risk_ranking": "unavailable",
  "inventory": "available",
  "units": [
    {
      "path": "src/cart/discount.ts",
      "added_ranges": [[12, 30]],
      "coverage": "uncovered",
      "execution_evidence": "lines 12-30: 4 of 19 coverable line(s) uncovered",
      "imported_by": ["tests/cart/discount.test.ts"],
      "uncovered_lines": [25, 26, 27, 28]
    }
  ],
  "skipped": [{ "path": "README.md", "reason": "matched a guardian skip glob" }]
}
```

`execution_evidence` is deliberately not a list of test names: a coverage report
records which **lines** ran, never which test ran them, so naming a test there
would be a guess dressed as evidence. `imported_by` is `null` — not `[]` — when
no inventory was readable, because "read it and nothing imports this" and "could
not read it" are different claims.

## Judgment (`--judgment`)

```json
{
  "mission": "Explore how the discount behaves at its edges.",
  "verify": [
    {
      "text": "Apply a 10% discount to a cart",
      "cite": "src/cart/discount.ts:14"
    }
  ],
  "edge_cases": [
    {
      "category": "Boundary values",
      "text": "0% and 100% discounts",
      "cite": "src/cart/discount.ts:18"
    }
  ]
}
```

A `cite` must be `path:line` naming a scoped unit and a line inside its
`added_ranges`, and an edge case's `category` must be one of Boundary values,
Race conditions, Locale and timezone, Partial network, Unexpected input shapes,
or Accessibility. Anything else is dropped — never rendered as a checklist item
— and listed under "Out of this charter" with its reason. With `--json`, the
output gains an additive `judgment` block (`mission`, `verify`, `edge_cases`,
`dropped`); `schema_version` stays 1.

## Related

- [canary-mission-briefing skill](../../agents/skills/claude-code/canary-mission-briefing/SKILL.md)
  — writes the judgment file.

- [PR Guardian Guide](./pr-guardian.md) — the gate that shares this scoping.
- [Test Inventory Guide](./test-inventory.md) — the `imported_by` input.
