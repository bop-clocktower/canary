# Plan: No Silent Abstention — Wave 5 (edges + doctrine)

**Date:** 2026-08-03 | **Spec:** `docs/changes/no-silent-abstention/proposal.md`
(Implementation Order item 5) | **Issue:** #508 | **Tasks:** 6

**Branch:** `feat/abstention-wave5-doctrine`, based on `origin/main` after Wave
4a (#530). The final wave: no new gate behavior, only the edges the code waves
deliberately deferred and the durable record of why any of it exists.

## Goal

Close #508. The CI surfaces that _consume_ exit 3 handle it distinctly from exit
1; the workflow-layer version of silent abstention (`continue-on-error`)
annotates instead of going quietly green; and the doctrine outlives the people
who wrote it, as two ADRs plus a checklist a future gate author actually has to
tick.

## Observable Truths (Acceptance Criteria)

1. **[Event-driven]** When `guardian pr-check` exits 3 in `guardian.yml`, the
   job shall emit a `::warning::` annotation and exit 0 — not a pass, but not a
   failure either. Every other non-zero code shall propagate unchanged, so exit
   1 stays red.
2. **[Event-driven]** When a `continue-on-error: true` step fails in
   `harness-quality.yml`, the workflow shall emit a `::warning::` naming the
   step. The steps stay non-blocking (both are deliberately transitional), but a
   soft failure surfaces in the Checks summary rather than only to whoever
   expands the log.
3. **[Ubiquitous]** `AGENTS.md` shall carry the doctrine and a **new-gate
   checklist** covering: the helper, the gate/advisory classification, required
   remediation text, `--json` fields, a registry row, a non-zero-denominator
   control test, and the rule that pins asserting the old green are rewritten
   rather than deleted.
4. **[Ubiquitous]** ADR 0009 shall record the exit-3 reservation (D4) and ADR
   0010 the conformance registry as the canonical gate list (D5), both indexed
   in `docs/knowledge/decisions/README.md`.
5. **[Ubiquitous]** `CHANGELOG.md` shall carry a **"Gates that got louder"**
   section enumerating every surface whose exit behavior changed, with the
   v6.4.0 surfaces backfilled so consumers read one complete table rather than
   three partial ones (the decision recorded on the roadmap row 2026-08-03).
6. **[Unwanted]** No source behavior shall change in this wave. It is workflow,
   docs, and record only.

## Uncertainties

- **[DECISION] Workflow template version bumps are N/A.** The spec's Wave 5 line
  calls for bumping `workflow_template_version` on templates that consume gate
  exit codes. **No skill in this repo declares `install_workflows`** — the
  mechanism exists in `migrator.ts` but ships zero templates today, so there is
  nothing to bump. Recorded rather than silently skipped; the moment a skill
  ships a template that reads an exit code, it inherits the exit-3 handling from
  `guardian.yml` as the reference implementation.
- **[DECISION] The soft steps stay soft.** Making `check-docs` / `cleanup`
  blocking is a separate call with its own backlog; this wave only stops them
  from being _invisible_. Annotating is the honest middle: still non-blocking,
  no longer silent.
- **[DECISION] The `guardian.yml` exit-3 branch is written out longhand rather
  than hidden behind `continue-on-error`.** `continue-on-error: true` would
  swallow exit 1 as well, which would turn the guardian into exactly the
  advisory-nobody-reads shape #413 documented.

## Tasks

| #   | Task                                                            | Verify          |
| --- | --------------------------------------------------------------- | --------------- |
| 1   | `guardian.yml` handles exit 3 distinctly; other codes propagate | YAML parses; CI |
| 2   | `harness-quality.yml` annotates both `continue-on-error` steps  | YAML parses; CI |
| 3   | ADR 0009 (exit 3 reserved) + ADR 0010 (registry as gate list)   | markdownlint    |
| 4   | `AGENTS.md` doctrine section + new-gate checklist               | markdownlint    |
| 5   | CHANGELOG "Gates that got louder", v6.4.0 backfilled            | markdownlint    |
| 6   | Roadmap row -> done; close #508                                 | roadmap guard   |

## Rollback

Docs and workflow only. Reverting restores the previous CI behavior exactly; no
source, no persisted format, no published contract is touched.
