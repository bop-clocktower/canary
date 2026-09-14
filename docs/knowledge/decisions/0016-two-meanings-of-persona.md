---
number: 16
title: 'ADR 0016 — "Persona" means two unrelated things, and batwoman uses both'
date: 2026-09-09
status: accepted
source: adr
---

<!-- markdownlint-disable-file MD025 -->

# ADR 0016 — "Persona" means two unrelated things, and batwoman uses both

**Status:** accepted **Date:** 2026-09-09 **Deciders:** Bri Stevenski
(maintainer) **Related:** #749 (canary-batwoman, the first thing here to use
both at once); proposal decisions D7 and D8; ADR 0015 (the same family of
problem — a shared word with no authoritative source)

## Context

Two systems in this repo use the word **persona** for unrelated things.

A **harness persona** (`agents/personas/*.yaml`) binds skills to triggers and
generates surfaces: it says _when_ something runs and _what files describe it_.
A **canary persona** (`ts/src/data/personas/registry.json`) selects an output
register for a human reader: it says _how terse the prose is_ and _whether
rationale is included_.

They share nothing — not a schema, not a loader, not a concept. A harness
persona has `triggers` and `outputs`; a canary persona has `depth`, `formats`
and `reasoning`. Neither knows the other exists.

`canary-batwoman` is the first thing in this repo to use **both at once**: a
canary persona chooses the register its report is written in (D7), and a harness
persona declares when its CI workflow runs (D8). A reader meeting the word twice
in one feature will reasonably assume one mechanism, and then look for the
connection that is not there.

## Decision

**1. The two are named in full whenever both are in scope.** "harness persona"
and "canary persona", never a bare "persona", in any file that touches both.
Batwoman's own modules and its `SKILL.md` follow this.

**2. Neither is renamed.** Both names are load-bearing outside this repo — the
harness one in an upstream CLI whose schema we do not own, the canary one in a
shipped `registry.json` consumed by every skill's output. Renaming either to
resolve a local ambiguity would trade a documentation problem for a
compatibility one.

**3. The collision is recorded here rather than in either subsystem's docs,**
because it belongs to neither and is invisible from inside both.

## Consequence recorded during implementation — amendment BW-C3

D8 said the CI workflow would be **generated** from the harness persona, so the
trigger and the file could not drift. That is not achievable for this skill, and
the attempt is worth recording because the next person will try it too.

`harness persona sync-workflows` emits a job whose only step is
`npx harness <command>`, under a `pnpm` install. Batwoman is a **canary** CLI
subcommand taking `--issue N`, and this repo uses npm for `ts/`. A generated
workflow would invoke a harness command that does not exist, in a package
manager the project does not use there. The generator serves personas that drive
harness's own CLI; batwoman is not one.

Two further facts found the same way:

- The schema has **no `push` event**. Harness personas support exactly `manual`,
  `on_commit`, `on_pr`, `scheduled`. D8's "`push` trigger" is `on_commit` with
  `branches: [main]` under the name the schema uses.
- A persona with `outputs.ci-workflow: true` and **no `commands:` block silently
  generates nothing**, and `sync-workflows --check` then reports
  `OK — 0 persona workflows are up to date`. A zero denominator rendered as a
  pass, which is the shape this repo treats as an abstention rather than a green
  tick.

So the persona declares `outputs.ci-workflow: false`,
`.github/workflows/batwoman.yml` is hand-written, and
`ts/test/batwoman-workflow-drift.test.ts` asserts the committed workflow's
triggers still match the persona's declaration. **D8's requirement survives
without its mechanism**: the trigger is declared once, a drifted workflow fails
a test rather than reading as a formatting difference, and the test compares
trigger semantics rather than bytes so that a comment change is not a failure.

## Consequences

- A reader meeting "persona" twice in batwoman has one document explaining why.
- The harness persona is still the single declaration of when batwoman runs,
  even though it no longer generates the file.
- If `sync-workflows` ever learns to emit a non-harness command, flipping
  `ci-workflow` back to `true` is a contained change — and the drift test
  asserts `false` explicitly, so the two mechanisms cannot both claim authority
  in silence.
