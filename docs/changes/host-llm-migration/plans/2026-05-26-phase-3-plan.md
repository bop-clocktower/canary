# Plan: CLI Deprecation — Phase 3

**Date:** 2026-05-26 |
**Spec:** [cli-deprecation.md](../specs/cli-deprecation.md) |
**ADR:** [0003-deprecate-oracle-generate.md][adr0003] |
**Tasks:** 5 | **Time:** ~40 min

> **For agentic workers:** REQUIRED SUB-SKILL: `harness:tdd` or
> `harness:execution`. Steps use checkbox (`- [ ]`) syntax.

---

## Goal

Mark `oracle generate`, `oracle feedback`, and the GitHub Action as
deprecated. Each affected surface gets a visible signal that names
the supported replacement. No code is removed in this phase.

## File Map

| Action | Path | Purpose |
| --- | --- | --- |
| Modify | `agent/cli.py` | Add deprecation warning to `generate` (skip on `--recommend-only`) and `feedback` |
| Modify | `action.yml` | Prefix `description` with `[DEPRECATED — removed in v3.0]` |
| Add | `docs/adr/0003-deprecate-oracle-generate.md` | Decision record (status accepted) |
| Modify | `docs/adr/README.md` | Index entry for ADR 0003 |
| Add | `docs/specs/cli-deprecation.md` | Spec |
| Add | `docs/plans/cli-deprecation.md` | This plan |
| Add | `docs/changes/host-llm-migration/plans/2026-05-26-phase-3-plan.md` | Plan mirror |
| Modify | `docs/roadmap.md` | Phase 3 progress under the migration item |

---

### Task 1: Add deprecation warning to `oracle generate`

**Files:**

- Modify: `agent/cli.py:generate()`

- [ ] **Step 1:** After parsing args but before the orchestrator
  call, print a yellow stderr warning via
  `Console(stderr=True).print(...)`. Skip when `recommend_only` is
  `True` (that path stays keyless and useful).
- [ ] **Step 2:** Update the function docstring with the
  `DEPRECATED:` callout pointing at `/oracle-write-test` and ADR
  0003.

**Acceptance:** `oracle generate "x"` prints exactly one yellow
warning on stderr. `oracle generate "x" --recommend-only` prints no
warning.

**Time estimate:** 5 min.

---

### Task 2: Add deprecation warning to `oracle feedback`

**Files:**

- Modify: `agent/cli.py:feedback()`

- [ ] **Step 1:** Print a yellow stderr warning at the top of the
  function. Same format as Task 1's warning.
- [ ] **Step 2:** Update docstring with `DEPRECATED:` callout.

**Acceptance:** `oracle feedback` prints the warning whether or not
a last-generation file exists.

**Time estimate:** 3 min.

---

### Task 3: Mark the GitHub Action deprecated

**Files:**

- Modify: `action.yml`

- [ ] **Step 1:** Prefix the top-level `description` field with
  `[DEPRECATED — removed in v3.0]` and append "Migrate to the
  Claude Code plugin (/oracle-write-test slash command)."

**Acceptance:** the marketplace listing renders the prefix; no
functional change.

**Time estimate:** 2 min.

---

### Task 4: Verify existing tests still pass

**Files (read-only):**

- Read: `tests/unit/test_orchestrator.py` and any tests that
  exercise the CLI via `CliRunner`.

- [ ] **Step 1:** `python -m unittest discover tests/unit -q` —
  expect the same pass count as before this PR.
- [ ] **Step 2:** If any test fails because it asserts on exact
  stdout/stderr output, decide:
  - The test's invariant is fine and warnings on stderr don't matter
    → leave the test alone, warnings go to stderr.
  - The test is fragile and needs `mix_stderr=False` to keep
    stderr separate → adjust the test.
  Document the decision in the PR body.

**Acceptance:** test count delta = 0; no regression.

**Time estimate:** 10 min.

---

### Task 5: Planning artifacts + roadmap

**Files:**

- Add: `docs/adr/0003-deprecate-oracle-generate.md`
- Modify: `docs/adr/README.md`
- Add: `docs/specs/cli-deprecation.md`
- Add: `docs/plans/cli-deprecation.md` (this file)
- Add: `docs/changes/host-llm-migration/plans/2026-05-26-phase-3-plan.md`
- Modify: `docs/roadmap.md`

- [ ] **Step 1:** ADR + spec + plan + mirrored plan, cross-referenced
  via reference-style links to keep markdownlint happy.
- [ ] **Step 2:** Roadmap: add Phase 3 entry under the migration
  item; keep Status `in progress` until removal phase lands.
- [ ] **Step 3:** markdownlint clean on all touched markdown.

**Acceptance:** docs pass markdownlint; roadmap reflects Phase 3
state.

**Time estimate:** 10 min.

---

## Dependencies

- Phases 1 + 2 must be merged. ✅ Done (PRs #136, #137).
- No `agent/llm/*` or orchestrator code changes — those wait for the
  removal phase.

## Risk register

| Risk | Mitigation | Tracked in task |
| --- | --- | --- |
| Existing test asserts no warning on stdout | Warning goes to stderr; CliRunner captures stdout by default | Task 4 |
| User confusion (two paths coexist) | Warning explicitly names replacement | Task 1 |
| Action consumers don't see description change | Removal happens at major-version bump (Dependabot triggers re-read) | n/a |

## Out of scope

- Code removal (separate ADR, post-major-version bump).
- README rewrite (separate doc-pass PR).
- Dependency pruning in `pyproject.toml`.
- Telemetry on deprecated invocations.
- Suppressible warnings (env var opt-out).

[adr0003]: ../adr/0003-deprecate-oracle-generate.md
