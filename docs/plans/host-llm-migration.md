# Plan: Host-LLM Migration — Phase 1 (`oracle-test-author`)

**Date:** 2026-05-22 |
**Spec:** [host-llm-migration.md](../specs/host-llm-migration.md) |
**ADR:** [0001-host-llm-generation-for-agents.md][adr0001] |
**Tasks:** 9 | **Time:** ~90 min

> **For agentic workers:** REQUIRED SUB-SKILL: Use the `harness:tdd`
> skill (recommended) or `harness:execution` to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

---

## Goal

Rewrite `agents/oracle-test-author.md` so the agent
generates test code in the host Claude Code session rather than
shelling out to `oracle generate`. Verify against the four shipped
example prompts that the host-LLM output is at least as good as the
CLI output. Update related specs to reflect the new path.

## File Map

| Action | Path | Purpose |
| --- | --- | --- |
| Modify | `agents/oracle-test-author.md` | Drop `oracle generate` delegation; use MCP + host LLM |
| Verify | `commands/oracle-write-test.md` | Confirm no change needed (delegates to agent) |
| Modify | `docs/specs/oracle-plugin.md` | Patch out "Delegate to the Oracle CLI" wording; cross-reference this spec |
| Add | `docs/changes/host-llm-migration/plans/2026-05-22-phase-1-plan.md` | Symlink/copy of this plan for the changes-tracking convention |
| Verify | `docs/adr/README.md` index entry exists for ADR 0001 | Index up-to-date |
| Verify | `docs/roadmap.md` "Migrate all LLM-dependent tasks" item references this plan | Roadmap traceability |

---

### Task 1: Document `oracle__analyze_file` gaps vs. orchestrator context

**Files (read-only):**

- Read: `agent/core/orchestrator.py:_build_prompt()` — list the five
  context blocks it injects (metadata, patterns, domain, fixtures,
  company).
- Read: `agent/mcp_server.py:_analyze_file_impl()` — list what
  `oracle__analyze_file` returns.

- [ ] **Step 1: Produce a coverage matrix** — write a short table in
  a session note (not committed) showing each orchestrator context
  block vs. whether `analyze_file` already returns equivalent info.
- [ ] **Step 2: Identify gaps** — if any orchestrator block has no
  `analyze_file` equivalent, decide: (a) the agent reads it via `Read`
  / `Glob` instead, (b) extend `analyze_file` in a follow-up task, or
  (c) accept the gap as out of scope.
- [ ] **Step 3: Record the matrix in the spec** — append it to the
  spec under "Architecture" so reviewers can see the trade-off.

**Acceptance:** spec has a concrete coverage matrix. Any gap with
decision (a)/(b)/(c) recorded.

**Time estimate:** 15 min.

---

### Task 2: Rewrite Phase 2 of `oracle-test-author.md`

**Files:**

- Modify: `agents/oracle-test-author.md`

- [ ] **Step 1: Replace Phase 2** with the four-step process from
  the spec (call `oracle__analyze_file`, expand prompt, generate
  in-session, self-check).
- [ ] **Step 2: Confirm `tools:` frontmatter** still authorizes
  `Read, Write, Edit, Glob, Grep, Bash`. Drop `Bash` if (and only if)
  nothing else in the agent's instructions calls a shell.
- [ ] **Step 3: Remove the literal `oracle generate` invocation** —
  grep the file to verify zero remaining occurrences.

**Acceptance:** `grep -c "oracle generate" agents/oracle-test-author.md`
returns 0.

**Time estimate:** 15 min.

---

### Task 3: Verify `oracle-write-test.md` is unchanged

**Files (read-only):**

- Read: `commands/oracle-write-test.md`

- [ ] **Step 1: Confirm the command file just delegates** to
  `oracle-test-author` with `$ARGUMENTS`. If it does, no change.
- [ ] **Step 2: If the slash command file needs new arg hints**
  (e.g., the rewrite changes how prompts should be phrased), update
  the `argument-hint` frontmatter.

**Acceptance:** the command file either is byte-identical to before
or has a minimal argument-hint update committed alongside Task 2.

**Time estimate:** 5 min.

---

### Task 4: Side-by-side verify against the four shipped example prompts

**Fixture source:** `examples/` directory (the four prompts:
`playwright-e2e-login`, `pytest-api-checkout`, `vitest-unit-validation`,
`k6-perf-checkout`). Each has a `prompt.txt`.

- [ ] **Step 1: For each example prompt**, run the agent
  end-to-end in a fresh Claude Code session with NO provider key set.
  Use `/oracle-write-test "$(cat examples/<dir>/prompt.txt)"`.
- [ ] **Step 2: Compare the output** to a baseline `oracle generate`
  run (with a key set) on the same prompt. Capture differences in a
  session note.
- [ ] **Step 3: Iterate the agent instructions** if quality is
  noticeably worse — usually means a context block from
  `analyze_file` isn't being utilized in the prompt expansion.

**Acceptance:** for all four prompts, the host-LLM output (a) chooses
the correct framework, (b) writes a runnable test, (c) uses any
project conventions present in the fixture. Differences from CLI
output don't need to be eliminated — only "worse" differences.

**Time estimate:** 30 min (8 minutes per prompt + iteration buffer).

---

### Task 5: Patch `docs/specs/oracle-plugin.md`

**Files:**

- Modify: `docs/specs/oracle-plugin.md`

- [ ] **Step 1: Search for "Delegate to the Oracle CLI"** and
  related wording in `Phase 2 / Generate` sections. Replace with the
  new flow.
- [ ] **Step 2: Update the "Goals" bullet** about "no API key
  required for plugin users" to reference the host-LLM migration —
  it's now true rather than aspirational.
- [ ] **Step 3: Cross-reference this spec** — add a one-line link
  to `docs/specs/host-llm-migration.md` at the bottom of the
  superseded sections.

**Acceptance:** no remaining `oracle generate` references in plugin
agent context within the oracle-plugin spec.

**Time estimate:** 10 min.

---

### Task 6: Update the roadmap item

**Files:**

- Modify: `docs/roadmap.md`

- [ ] **Step 1: Find the "Migrate all LLM-dependent tasks to
  keyless slash commands" item** added in PR #122.
- [ ] **Step 2: Add a "Plan" field** pointing at
  `docs/plans/host-llm-migration.md` and a "Spec" field pointing at
  `docs/specs/host-llm-migration.md`. Change Status from `planned` to
  `in progress`.
- [ ] **Step 3: Note Phase 1 scope** — "Phase 1 (oracle-test-author)
  in progress; phases for self-heal and CLI deprecation are
  separate."

**Acceptance:** roadmap item has Spec + Plan links + accurate Status.

**Time estimate:** 5 min.

---

### Task 7: Mirror the plan under `docs/changes/`

**Files:**

- Add: `docs/changes/host-llm-migration/plans/2026-05-22-phase-1-plan.md`

- [ ] **Step 1: Either symlink** `docs/changes/host-llm-migration/plans/2026-05-22-phase-1-plan.md`
  to `../../../plans/host-llm-migration.md`, **or copy** the contents.
  Match whatever convention exists in `docs/changes/multi-provider-llm/`
  (the only prior precedent).
- [ ] **Step 2: Update ADR 0001 status** from `proposed` to
  `accepted` once the rewrite lands.

**Acceptance:** `docs/changes/host-llm-migration/` exists with a
plan reference; ADR status is `accepted`.

**Time estimate:** 5 min.

---

### Task 8: Open the PR

**Files:**

- All of the above

- [ ] **Step 1: Single PR** with all spec/plan/ADR docs plus the
  agent rewrite. Branch name: `feat/host-llm-migration-phase-1`.
- [ ] **Step 2: PR body** references the ADR + spec + plan, links to
  the roadmap item, and includes the side-by-side verification notes
  from Task 4 as evidence the migration is working.
- [ ] **Step 3: After merge**, update the ADR status from
  `proposed` to `accepted`.

**Acceptance:** PR open with all artifacts; CI green; ADR status
updated post-merge.

**Time estimate:** 5 min.

---

### Task 9 (follow-up tracking, post-merge)

These are explicitly OUT of scope for this plan; the task is just to
file them so they aren't forgotten.

- [ ] **File:** "Migrate self-heal loop to host LLM" — separate ADR +
  spec + plan. Covers `_attempt_fix`, `_attempt_selector_fix` in
  `agent/core/orchestrator.py`.
- [ ] **File:** "Deprecate `oracle generate` CLI" — separate ADR.
- [ ] **File:** "Remove GitHub Action" — separate ADR; coupled to
  the CLI deprecation.

**Acceptance:** three follow-up issues opened on upstream with
references to this plan.

**Time estimate:** 5 min.

---

## Dependencies

- ADR 0001 (this branch) must be accepted before Task 2 lands.
- `oracle__analyze_file` may need extending if Task 1 finds gaps;
  worst case, that's a small PR in `agent/mcp_server.py` ahead of
  the rewrite.

## Risk register

| Risk | Mitigation | Tracked in task |
| --- | --- | --- |
| Host-LLM generation quality worse than CLI | Side-by-side test against four prompts; iterate instructions | Task 4 |
| `oracle__analyze_file` doesn't return enough context | Document gaps in Task 1; extend MCP tool if needed | Task 1 |
| Spec drift between `oracle-plugin.md` and `host-llm-migration.md` | Cross-reference; patch stale sections | Task 5 |
| Downstream overlay users still hit the CLI path somehow | They don't — they only use the overlay; deprecation comes later | n/a |

## Out of scope

- Self-heal loop migration.
- `oracle generate` CLI removal.
- GitHub Action removal.
- Performance benchmarking of host LLM vs. CLI.
- New MCP tools beyond what already exists.

[adr0001]: ../adr/0001-host-llm-generation-for-agents.md
