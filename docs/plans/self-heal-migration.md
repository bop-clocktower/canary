# Plan: Self-Heal Migration — Phase 2 (`oracle-test-healer`)

**Date:** 2026-05-26 |
**Spec:** [self-heal-migration.md](../specs/self-heal-migration.md) |
**ADR:** [0002-self-heal-as-slash-command.md][adr0002] |
**Tasks:** 6 | **Time:** ~60 min

> **For agentic workers:** REQUIRED SUB-SKILL: Use `harness:tdd`
> (recommended) or `harness:execution`. Steps use checkbox (`- [ ]`)
> syntax for tracking.

---

## Goal

Add `oracle-test-healer` agent + `/oracle-heal-test` slash command to
provide a keyless test-repair surface. The CLI's existing self-heal
loop in `agent/core/orchestrator.py` stays in place — Phase 3 will
remove it alongside `oracle generate`.

## File Map

| Action | Path | Purpose |
| --- | --- | --- |
| Add | `agents/oracle-test-healer.md` | New agent for test repair |
| Add | `commands/oracle-heal-test.md` | Slash command delegating to the agent |
| Add | `docs/adr/0002-self-heal-as-slash-command.md` | Decision record |
| Modify | `docs/adr/README.md` | Index entry for ADR 0002 |
| Add | `docs/specs/self-heal-migration.md` | Spec |
| Add | `docs/plans/self-heal-migration.md` | This plan |
| Add | `docs/changes/host-llm-migration/plans/2026-05-26-phase-2-plan.md` | Plan mirror |
| Modify | `docs/roadmap.md` | Note Phase 2 progress under the migration item |

---

### Task 1: Write the `oracle-test-healer` agent

**Files:**

- Add: `agents/oracle-test-healer.md`

- [ ] **Step 1: Frontmatter** — `name: oracle-test-healer`,
  `description` keyed on "fix this failing test"-style phrases,
  `tools: Bash, Read, Write, Edit, Glob, Grep, mcp__oracle__oracle__analyze_file`.
- [ ] **Step 2: Process section** — five phases per the spec:
  Anchor, Diagnose, Gather DOM context (selector-fix only), Generate
  fix, Verify.
- [ ] **Step 3: When NOT to use** — explicit redirects to
  `oracle-flake-hunter` for intermittent failures and to
  `oracle-test-author` for new tests.
- [ ] **Step 4: Embed selector heuristics** — the agent reproduces
  what `SelectorHealer.is_selector_failure` and
  `SelectorHealer.dom_context_from_report` do, in prose form.

**Acceptance:** the agent file passes markdownlint and embeds both
the generic-fix and selector-fix paths.

**Time estimate:** 20 min.

---

### Task 2: Write the `oracle-heal-test` slash command

**Files:**

- Add: `commands/oracle-heal-test.md`

- [ ] **Step 1: Frontmatter** — `description`, `argument-hint`,
  `allowed-tools` including `mcp__oracle__oracle__analyze_file`.
- [ ] **Step 2: Body** — minimal delegation to the healer agent
  with `$ARGUMENTS`.

**Acceptance:** command file mirrors `oracle-write-test.md` shape;
markdownlint clean.

**Time estimate:** 5 min.

---

### Task 3: Verify against a known-bad fixture

**Setup:** create a deliberately broken Playwright test in a temp
directory — e.g., a selector that doesn't exist (`page.click("#nope")`).
Generate a Playwright report (with `trace.zip`) by running it once.

- [ ] **Step 1: Invoke the slash command** in a fresh Claude Code
  session with NO provider key set:
  `/oracle-heal-test /tmp/broken.spec.ts`.
- [ ] **Step 2: Confirm the agent extracts the failing selector**
  from the error before proposing a fix.
- [ ] **Step 3: Confirm the agent reads the trace.zip** (or notes
  its absence) before generating the fix.
- [ ] **Step 4: Confirm the fix is applied** to the file via
  `Write` and the agent reports the verification result.

**Acceptance:** the slash command produces a non-trivially-better
test (selector swapped to a real one, or root cause surfaced to the
user). Subjective; reviewer judges.

**Time estimate:** 20 min.

---

### Task 4: Update planning docs + roadmap

**Files:**

- Add: `docs/adr/0002-self-heal-as-slash-command.md`
- Modify: `docs/adr/README.md`
- Add: `docs/specs/self-heal-migration.md`
- Add: `docs/plans/self-heal-migration.md` (this file)
- Modify: `docs/roadmap.md`

- [ ] **Step 1: ADR 0002** — Status `accepted` immediately (Phase 1
  established the convention; the decision is uncontroversial). Index
  in `docs/adr/README.md` updated.
- [ ] **Step 2: Spec + plan** linked in the relevant cross-references
  (ADR points at spec + plan, spec points at plan, plan points at ADR
  via reference-style link to avoid MD013 violations).
- [ ] **Step 3: Roadmap** — under the "Migrate all LLM-dependent
  tasks" item, note Phase 2 completion; keep Status `in progress`
  until Phase 3 (CLI deprecation) is decided.

**Acceptance:** all cross-refs resolve, markdownlint clean.

**Time estimate:** 10 min.

---

### Task 5: Mirror plan under `docs/changes/`

**Files:**

- Add: `docs/changes/host-llm-migration/plans/2026-05-26-phase-2-plan.md`

- [ ] **Step 1: Copy this plan** to the changes-tracking convention
  directory.

**Acceptance:** mirrored plan exists.

**Time estimate:** 2 min.

---

### Task 6: Open the PR

**Files:**

- All of the above.

- [ ] **Step 1: Single PR** combining planning artifacts +
  implementation (agent + command). Branch:
  `feat/host-llm-migration-phase-2`.
- [ ] **Step 2: PR body** references ADR + spec + plan, links to the
  roadmap item, lists what's in/out of scope per the spec's Scope
  section.
- [ ] **Step 3: Reviewer Task 3** explicitly called out as a
  verification step — the side-by-side fixture test happens in
  review, not in CI.

**Acceptance:** PR open, CI green, ADR status reads `accepted`.

**Time estimate:** 5 min.

---

## Dependencies

- Phase 1 (ADR 0001 + the `oracle-test-author` rewrite) must be
  merged — establishes the pattern this phase follows. ✅ Done in
  PR #136.
- No code in `agent/core/` changes; no MCP extensions needed.

## Risk register

| Risk | Mitigation | Tracked in task |
| --- | --- | --- |
| Quality regression vs CLI self-heal | Side-by-side against a known-bad fixture | Task 3 |
| Agent skips trace.zip extraction | Explicit step in agent instructions | Task 1 |
| Agent enters retry loop | Explicit no-blind-retry rule in agent | Task 1 |

## Out of scope

- CLI self-heal removal (Phase 3).
- `agent/core/selector_healer.py` removal (still used by CLI path).
- New MCP tools.
- Auto-trigger from CI on test failure.

[adr0002]: ../adr/0002-self-heal-as-slash-command.md
