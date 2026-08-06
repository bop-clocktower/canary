# Seeding `docs/knowledge/` — design

**Date:** 2026-08-05 **Status:** proposed **Related:** PR #563 (false-green
class), issue #564 (domainBlocklist invariant), PR #555, PR #561

## Problem

The harness knowledge pipeline reports `0 documented / 2383 extracted` and a
standing WARN. The obvious reading — "canary has no documented knowledge" — is
wrong. The repo holds 10 substantive ADRs in `docs/adr/`. The graph has never
seen them, because every ingestor is hardcoded to look under `docs/knowledge/`.

The layer is not missing. It is one directory name away from where the tooling
looks.

## Goal

Durable knowledge that a contributor or agent can query to answer "why is it
built this way?" without archaeology. The coverage grade is a thermometer, not
the patient — it moves because real knowledge landed, and is never the target.

Explicitly **not** a goal: raising the grade by bulk-generating entries. An
entry written to move a number is the same shape as a configured rule that
matches nothing (#563) — it reports as knowledge without carrying a fact.

## What the ingestors actually require

Verified by reading the harness CLI (`chunk-WSHNY6XQ.js`), not by assuming.

| Path                        | Parser             | Contract                                                                                                                                                |
| --------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| any ADR dir                 | `parseADRNode`     | `# H1`, `**Date:**`, `**Status:**` — the bold format canary already uses                                                                                |
| `docs/knowledge/decisions/` | decisions ingestor | YAML frontmatter: `number`, `title`, `date`, `status`, `tier`, `source`, `supersedes`. Node `name` comes from `frontmatter.title`                       |
| `docs/knowledge/<domain>/`  | `parseAndAddNode`  | YAML frontmatter with `type` in `BUSINESS_KNOWLEDGE_TYPES`: `business_rule`, `business_process`, `business_concept`, `business_term`, `business_metric` |

Three consequences drive the design:

1. **`parseAndAddNode` returns `null` when frontmatter is absent or `type` is
   not in that set — silently.** No error, no warning. An entry with a wrong
   `type` looks like documentation and is invisible to the graph. This is the
   #563 class one directory down, and it is why this design has a verification
   gate that inspects graph nodes rather than files.
2. **Do not convert the ADRs' bold markers to YAML.** `parseADRNode` matches on
   `**Status:**` and `**Date:**`. Add YAML frontmatter and keep the bold lines,
   so both parsers work and the human-readable header survives.
3. **`linkToCode(content, nodeId, "documents")` builds edges from paths and
   symbols mentioned in the body.** An entry citing `ts/src/guardian/cli.ts`
   links to code; an entry of abstract prose links to nothing.

## Structure

```text
docs/knowledge/
  decisions/                    10 ADRs, git mv from docs/adr/
    0001-...md ... 0010-...md   + YAML frontmatter, bold lines kept
  gates/
    false-green-detection.md    type: business_rule
    arch-baseline-semantics.md  type: business_rule
```

### Relationship to AGENTS.md

AGENTS.md is titled "Canary Knowledge Map" and already states the denominator
doctrine at line 421, linking to ADR 0009 for the vocabulary. That is the
pattern to extend, not compete with:

- **AGENTS.md** — orientation and doctrine. Read first. States rules concisely
  and links out for depth.
- **`docs/knowledge/`** — individually addressable facts and decisions that the
  graph ingests, links to code, and can be queried.

AGENTS.md gains two links and restates nothing. Duplication between the two is
the failure mode to avoid; a second source of truth drifts.

## The two authored entries

Only entries this week's work proved missing, where AGENTS.md gestures at a
doctrine but has no addressable depth.

### `gates/false-green-detection.md`

Not the rule — AGENTS.md:421 owns that. The **detection shapes**:

- an existence check is not a coverage check (#555: `tests/**` matched a
  directory holding 280 untracked `.pyc` files)
- `|| echo` over a failing command converts a hard rejection into a green job
  (#551: GH013 push rejection)
- `continue-on-error` over a step that crashes at startup rather than at its
  assertion (#545: the entropy scan had never once run)
- an advisory claim nothing verifies (#560: `engines.node`)
- a zero denominator in a fresh worktree (#563: `.harness/graph/` is gitignored,
  so the pipeline reports `0/0 code linked` as a plausible D grade)

Cites the PR and the real path for each, which is what builds the code edges.

### `gates/arch-baseline-semantics.md`

- the arch `complexity` metric is a **count of violating symbols**, so
  `--update-baseline` raises a permanent allowance rather than recording a
  measurement
- `harness check-arch` alone returns `passed: false` even on a clean tree,
  because it lists pre-existing `thresholdViolations`
- the CI gate is `harness ci check`, which judges the baseline **delta**
  (`newViolations`, `regressions`)
- each `?` optional marker in an inline type literal costs a branch; hoisting
  the shape to a named interface is the cheap fix

Cites #561 and `ts/src/guardian/cli.ts`.

## Reference updates

`git mv docs/adr docs/knowledge/decisions` breaks 21 files' references. All are
updated, including the historical plan and spec documents under
`docs/changes/**`, `docs/plans/**`, and `docs/specs/**`.

Rationale for touching historical records: a link that 404s serves nobody, and
git history preserves what each document originally said. This is a path rename,
not a rewrite of the record.

## Verification

The seed is **not** done when the files exist. It is done when the graph
contains them. In order:

1. `harness graph scan .` — then assert the graph holds 10 decision nodes for
   the ADRs and 2 `business_rule` nodes for the gate entries. A count of zero
   means the ingestor rejected the frontmatter, regardless of how the files
   read.
2. `harness knowledge-pipeline` — `documented` moves off 0 for the `gates`
   domain. Record the before and after in the same environment, with the real
   graph present (see #563: a fresh worktree has no graph, and its
   `0/0 code linked` reads as a plausible grade rather than as an error).
3. Zero remaining `docs/adr/` references: `git grep -c "docs/adr"` returns
   nothing.
4. markdownlint and prettier pass. Unlike `.harness/`, `docs/**` is matched by
   the `**/*.md` glob the Docs Lint workflow uses, so these entries are gated.

## Scope boundaries

- **No bulk authoring.** Two entries, both earned.
- **`docs/guides/`, `docs/wiki/`, `docs/runbooks/` stay where they are.** They
  are how-to material, a different genre from durable facts. Moving them is a
  separate decision with its own blast radius.
- **No `docs/knowledge/README.md` contribution contract.** Considered and
  deferred; worth adding once the layer has enough entries for the boundary to
  be contested.
- The grade will likely remain a C. That is the expected outcome, not a
  shortfall — most of the 2383 extracted signals are enum, API, and test-name
  signals that are self-describing in code and do not deserve hand-written
  entries.
