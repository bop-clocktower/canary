# Plan: canary-pr-guardian — Phase 4 (Agent orchestrator — Tiers 1/2 authoring)

**Date:** 2026-07-19 | **Spec:** `docs/changes/canary-pr-guardian/proposal.md` |
**Tasks:** 9 | **Sitting-sized (≤3 files each)** | **Integration Tier:** large |
**Checkpoint:** 1 (`[checkpoint:human-verify]` after T6, before the
stage-and-block auto-write is wired) | **HUMAN-GATED — plan only; implement
nothing until sign-off.**

> Scope note: **Phase 4 ONLY** — the **at-desk agent tiers** built on the merged
> Tier-0 baseline (Phases 1–3, on `main`). This phase adds: the **`AgentTier`
> capability boundary** + **`InSessionAgentTier`** (a NEW module,
> `agent/guardian/agent_tier.py`, OUTSIDE the Tier-0 engine); a **real
> `AgentCapabilityProbe`** (`InSessionAgentProbe`) that swaps into Phase-3's
> `resolve_tier` unchanged; **Tier 1** (compose `canary-test-reviewer` →
> weak-test `Finding`s, read-only); **Tier 2** (compose `canary-test-author` →
> `GeneratedTest`s); the **pre-commit stage-and-block-once** (D4) with its four
> auto-commit-back safeguards; and the **`canary-pr-guardian` SKILL.md +
> skill.yaml + slash command** that actually drive the agents. Explicitly **out
> of scope**: `--emit-analysis` / harness `pre-merge-brief` consumption (Phase
> 5), the `CiAgentTier` runner and **any CI write-back** (spec Non-Goals, lines
> 66–68 — confirmed NON-GOAL for v1), and the D1/D2 ADRs + guides (Phase 6). The
> Tier-0 engine (`coverage.py`, `pr_check.py`, `tier.py`) is **not modified**
> except where a task says so, and **never** imports the agent tier (SC-11).

## Goal

Deliver **at-desk Tiers 1/2** (SC-6): a Claude-Code **orchestrator skill**
(`canary-pr-guardian`) that runs the deterministic Tier-0 pass, then — where an
agent runtime is present at the desk — **audits** affected tests via
`canary-test-reviewer` (Tier 1, read-only) and **authors** the missing tests via
`canary-test-author` (Tier 2), staging the generated code and **blocking the
commit exactly once** so a human always reviews it before it lands (D4). The
agent orchestration sits behind a single testable Python capability boundary
(`AgentTier` / `InSessionAgentTier`) that **never calls an LLM directly** — it
plans intents, parses/validates agent results, and enforces the write-safety
model — so the whole surface is unit-testable with a **fake** agent tier and the
Tier-0 engine stays agent-free (SC-11).

## Success Criteria This Phase Verifies

| SC    | Criterion (from spec)                                                                                                                                                     | Delivered by tasks   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| SC-6  | Pre-commit with `authorTests: true` invokes `canary-write-test`, stages the generated tests, and blocks the commit once with the review message                           | T5, T7, T8 (SKILL)   |
| SC-11 | The deterministic engine (`pr_check.py`, `coverage.py`, `tier.py`, `guardian_precommit.py`) imports no `AgentTier`/LLM/agent module — the capability boundary holds       | T6 (respected T1–T7) |
| SC-5  | (regression) opting a tier > 0 with a runtime **present** now resolves to that tier instead of degrading — the loud-degradation path from Phase 3 still fires when absent | T3                   |

_Traceability note (SC-6 under Option A):_ SC-6's letter says the **hook**
"invokes `canary-write-test`". A git pre-commit hook runs in a bare shell and
**cannot** invoke a Claude agent (see the ★ invocation-mechanism assumption).
Under the chosen **Option A**, the agent invocation is performed by the
**`canary-pr-guardian` SKILL.md** (host session); the Python boundary plans the
authoring and computes the block decision, and the git hook enforces the
**block-once** deterministically via a sentinel loop-guard. SC-6 is therefore
verified across T5 (author planning), T7 (block-once + CLI seam) and T8 (the
SKILL that drives `canary-test-author`) — the observable outcome ("authored,
staged, blocked once, review message shown") is unchanged; only the layer that
calls the agent moves from hook → skill. Flagged ★ for sign-off.

## Observable Truths (Acceptance Criteria, EARS)

1. **Ubiquitous (SC-11 / D1):** The system shall keep
   `agent/guardian/pr_check.py`, `coverage.py`, `tier.py`, and
   `hooks/guardian_precommit.py` free of any import of `agent_tier`, an
   `AgentTier`, or an LLM SDK; and `agent_tier.py` — the ONE module where agent
   orchestration is allowed — shall itself import no LLM SDK
   (`anthropic`/`openai`/`google.generativeai`), reaching agents only through
   the injected `AgentInvoker` port.
2. **Optional (SC-5 / D6):** Where an agent runtime is signalled available
   (`InSessionAgentProbe` reports a ceiling ≥ the requested tier), the system
   shall resolve to the requested tier with **no** degradation notice; where it
   is absent it shall degrade loudly exactly as Phase 3 does — `resolve_tier`'s
   callers unchanged.
3. **Event-driven (Tier 1, read-only):** When
   `audit_test_quality(affected_tests)` runs with a fake invoker returning a
   review transcript, the system shall parse it into `weak-test` `Finding`s and
   shall write **nothing** to disk.
4. **Event-driven (Tier 2 / D4):** When authoring is planned for an
   `untested-new-code` gap and **every** safety precondition holds (opt-in set,
   not a fork, no file collision, not a re-commit of already-authored tests),
   the system shall emit exactly one `GeneratedTest` authoring intent for that
   gap; if any precondition fails it shall emit a `skipped` record carrying the
   reason and author nothing.
5. **Unwanted (D4 loop-guard):** If the guardian's own previously-authored,
   already-staged tests are the only change on a re-commit, then the pre-commit
   surface shall **not** re-trigger authoring and shall let the commit proceed
   **once** (clearing its sentinel), never looping.
6. **Unwanted (opt-in safety):** If `preCommit.authorTests` is not explicitly
   `true`, then the system shall never produce a write/stage intent — authoring
   is opt-in, default off.
7. **State-driven (SC-6 observable):** While `preCommit.authorTests == true` and
   a runtime is present, the orchestrator shall author the missing tests via
   `canary-test-author`, `git add` them, and block the commit once with a "N
   test(s) authored & staged — review and re-commit" message — never an
   autonomous commit or push.
8. **Ubiquitous (discovery):** The system shall ship `canary-pr-guardian` as a
   discoverable skill (SKILL.md + skill.yaml with non-empty
   `name`/`description`) and slash command, with `.harness/skills-index.json`
   regenerated from that source, passing
   `tests/unit/test_discovery_tree_integrity.py`.

## The invocation mechanism — chosen approach (READ FIRST)

**Chosen: Option A — skill-layer orchestration.** A Python `AgentTier` cannot
call an LLM without shelling to a CLI (Option B) or being driven by the host
session (Option A). We pick **A** for v1.

- **What the Python layer does (`agent_tier.py`):** it is a _capability
  boundary + pure transformation layer_. It (i) turns deterministic Tier-0 gaps
  into structured **authoring intents** (the natural-language requirement string
  the `/canary-write-test` command consumes as `$ARGUMENTS`, plus a target
  path), (ii) **parses/validates** agent results into `Finding`/`GeneratedTest`,
  and (iii) enforces the **write-safety model** (opt-in, loop-guard, fork
  read-only, collision) and computes the **block-once** decision. It **never
  calls an LLM**.
- **What the SKILL does (`SKILL.md`):** the host Claude session, following the
  skill's markdown, runs `canary guardian pr-check --format json` (gaps) and
  `canary guardian author-plan --json` (intents + block decision), then
  **invokes the native agents in-session** — `canary-test-reviewer` for Tier 1,
  `canary-test-author` for Tier 2 — `git add`s the results, and stops
  (block-once).
- **The seam that makes both testable + future-proof:** `InSessionAgentTier`
  takes an injected `AgentInvoker` **port**. Its default production invoker is a
  `RecordingInvoker` that _records the intent and returns a `planned` result
  without calling anything_ (the SKILL fulfils it outside Python). Unit tests
  inject a `FakeInvoker` that returns canned transcripts / authored artifacts. A
  future `CiAgentTier` injects a real subprocess/runner invoker **without
  touching the boundary or `resolve_tier`**.

**Why not Option B (CLI/subprocess drive):** there is no `canary write-test` CLI
today (it is a slash command driving the `canary-test-author` agent), so B needs
a brand-new keyed generation entrypoint; it spends personal quota (the craft
precedent), and it is far harder to unit-test (a real `claude` subprocess). B is
the natural shape for the deferred `CiAgentTier`, not v1 — and the port seam
lets it drop in later. **Rejected for v1.**

## Auto-commit-back safety model (all four, explicit)

All four guards are **pure, deterministic, SC-11-clean** logic in
`agent_tier.py` (planning) plus a filesystem-only sentinel check in the Tier-0
hook (T7):

- **(a) Loop-guard on bot commits.** Authored test files carry a header marker
  (`# canary-guardian: authored`); and when the SKILL stages tests + blocks, it
  writes a sentinel `.git/canary-guardian-authored`. On the next commit the hook
  (deterministic, filesystem-only) sees the sentinel + that the only new changes
  are guardian-authored test paths (which `filter_test_units` already drops as
  test paths anyway) → it passes **once** and deletes the sentinel. Authoring
  never re-triggers on the guardian's own output.
- **(b) Fork-PR read-only degradation.** Authoring context carries an `is_fork`
  flag (reusing the Phase-2 fork/403 detection). On a fork, `plan_authoring`
  emits `skipped(reason="fork: read-only")` for every gap and produces no write
  intents. (CI write-back is a NON-GOAL regardless; this guards the
  at-desk-on-a-fork case.)
- **(c) Concurrent-PR file collisions.** Before intending to author
  `target_path`, `plan_authoring` checks whether that path already exists on
  disk **or** is already staged/modified →
  `skipped(reason="collision: <path> exists")` rather than clobber a test
  another PR/session is writing.
- **(d) Opt-in before writing.** `plan_authoring` produces write intents
  **only** when `authorTests` is explicitly `true` (default `false`) AND the
  resolved tier is 2. Absent the opt-in it returns audit-only/skip records. No
  config opt-in ⇒ no writes, ever.

**CI Tier-2 write-back:** confirmed a **v1 NON-GOAL** against spec Non-Goals
(proposal lines 66–68) and D6-rejected (line 199). This phase is **at-desk
only**.

## File Map

- CREATE `agent/guardian/agent_tier.py` — the ONE agent-orchestration module
  (OUTSIDE the Tier-0 engine): `AgentTier` Protocol, `AgentInvoker` port +
  `RecordingInvoker` default, `GeneratedTest`/`ReviewRequest`/`AuthorPlan`
  types, `InSessionAgentTier` (audit + author), `InSessionAgentProbe` (real
  probe), `plan_authoring` (the four safety guards), `decide_block`
  (block-once). Imports no LLM SDK (SC-11).
- CREATE `tests/unit/test_guardian_agent_tier.py` — boundary + audit + probe +
  safety + author TDD, all with a `FakeInvoker` (never a real
  agent/LLM/network).
- MODIFY `agent/guardian/cli.py` — add the in-session seam
  `canary guardian author-plan --json` (lazy `agent_tier` import; NOT in the
  Tier-0 boundary set).
- MODIFY `tests/unit/test_guardian_cli.py` — `author-plan` CLI TDD (CliRunner,
  fake-invoker-injected, network-free).
- MODIFY `hooks/guardian_precommit.py` — add the **deterministic** sentinel
  loop-guard (filesystem-only; imports no agent module — stays in `_MODULES`).
- MODIFY `tests/unit/test_guardian_precommit.py` — sentinel/block-once TDD.
- MODIFY `tests/unit/test_guardian_capability_boundary.py` — assert the engine
  still excludes `agent_tier`/LLM, and ADD a positive scan that `agent_tier.py`
  imports no LLM SDK while permitting the `AgentInvoker` port.
- CREATE `agents/skills/claude-code/canary-pr-guardian/SKILL.md` — orchestrator
  skill (drives the agents per Option A).
- CREATE `agents/skills/claude-code/canary-pr-guardian/skill.yaml` — discovery
  frontmatter (house style:
  `name`/`version`/`description`/`stability`/`triggers`/
  `platforms`/`type`/`tools`/`tier`/`depends_on`).
- CREATE `commands/canary-pr-guardian.md` — slash-command entry
  (`Use the \`canary-pr-guardian\` skill …`).
- REGENERATE `.harness/skills-index.json` + `agents/commands/**` via
  `harness generate-slash-commands` (T9 — generated, never hand-edited).

## Assumptions & Uncertainties (human: scrutinize the ★ ones)

- **★ [ASSUMPTION — the resolved invocation mechanism] The Python `AgentTier`
  never calls an LLM; the SKILL.md drives the agents (Option A).** See "The
  invocation mechanism" above. This is the load-bearing decision of the whole
  phase. If the human prefers Option B (a real `canary write-test` CLI that
  shells to `claude`), T5/T7/T8 change materially and quota/testing costs rise —
  confirm at sign-off.
- **★ [ASSUMPTION — SC-6 layer shift] The pre-commit "invoke
  `canary-write-test`" is done by the SKILL, not the git hook.** A
  `.git/hooks/pre-commit` shell hook has no agent runtime (the Phase-3 ★
  established guardian pre-commit is a _git_ hook, not a Claude-plugin hook). So
  under Option A the hook stays Tier-0 and only enforces the **block-once**; the
  SKILL authors. The observable SC-6 outcome is preserved. Confirm this reading
  of SC-6 before Phase 6 documents it.
- **★ [ASSUMPTION — opt-in/safety model] `preCommit.authorTests: true` is THE
  write opt-in; authoring never happens without it, on a fork, or into a
  colliding path; the guardian never re-authors its own commits.** All four
  guards are pure and tested (T5). No new config field is introduced (reuses the
  Phase-3 `precommit_author_tests`). If the human wants a _separate_
  `writeEnable` flag distinct from `authorTests`, that is a one-line config
  addition — flag it now.
- **★ [ASSUMPTION — agent-available signal] The real probe detects availability
  via an explicit opt-in env signal `CANARY_GUARDIAN_AGENT` (`0|1|2`), which the
  SKILL exports when running in-session.** It returns an int only — no LLM
  import (SC-11-clean). This keeps CI Tier-0-only (the env is unset there) and
  makes the probe deterministic/testable. Alternative signals (a marker file, a
  `claude` binary probe) are possible; the env flag is the smallest testable
  seam. Confirm.
- **[ASSUMPTION] `GeneratedTest` is the intent+result record, not raw code.** In
  v1 `author_tests` returns `GeneratedTest(status="planned"|"skipped")` from the
  `RecordingInvoker`; the SKILL fulfils each planned intent and (optionally, via
  a follow-up call) marks it `authored` with `written_path`. Tests use a
  `FakeInvoker` that returns `authored` records so parse/stage/block logic is
  fully exercised without an agent.
- **[ASSUMPTION] The `author-plan` CLI seam is the SKILL↔Python contract.** The
  markdown SKILL reaches the Python safety logic deterministically by running
  `canary guardian author-plan --json` (gaps → intents + block decision). This
  keeps the safety model _enforced in Python and unit-tested_, not re-described
  in prose. `cli.py` is NOT in the Tier-0 boundary set, and the `agent_tier`
  import is function-local, so the Tier-0 `pr-check` command stays agent-free at
  import.
- **[ASSUMPTION] `InSessionAgentTier` implements the spec Protocol exactly**
  (`audit_test_quality(affected_tests) -> list[Finding]`,
  `author_tests(gaps) -> list[GeneratedTest]`). The injected `AgentInvoker` is
  how it reaches an agent; the future `CiAgentTier` implements the same
  Protocol.
- **[DEFERRABLE] Exact block-once message + authored-file header marker
  wording.** Pinned canonical forms below; final prose may be tuned as long as
  it names the count and instructs "review and re-commit", and the marker stays
  greppable:

  ```text
  ⛔ canary-guardian: {n} test(s) authored & staged — review the generated code, then re-commit.
  ```

  ```text
  # canary-guardian: authored  (review before landing)
  ```

## Skeleton (produced — 9 tasks; parent house-style match)

1. **`agent_tier.py` foundation** (T1) — `AgentTier` Protocol, `AgentInvoker`
   port + `RecordingInvoker`, `GeneratedTest`/`ReviewRequest` types. Pure, no
   LLM.
2. **Tier-1 audit** (T2) — `InSessionAgentTier.audit_test_quality` → parse
   transcript → `weak-test` `Finding`s (read-only). **← Tier 1.**
3. **Real probe** (T3) — `InSessionAgentProbe` → `resolve_tier` no longer
   degrades when available; still loud when absent. **← SC-5 regression.**
4. **Safety model** (T4) — `plan_authoring`: opt-in / fork / collision / loop
   guards → intents or skip-records. Pure. **← D4 safety (a)–(d).**
5. **Tier-2 author** (T5) — `InSessionAgentTier.author_tests` + `decide_block`
   (block-once decision). **← Tier 2, SC-6 planning.**
6. **Boundary** (T6) — extend SC-11 test: engine excludes `agent_tier`/LLM;
   `agent_tier.py` excludes LLM SDK. **← SC-11.** —
   **`[checkpoint:human-verify]`** (seam + probe + safety confirmed before any
   write is wired) —
7. **Stage-and-block wiring** (T7) — hook sentinel loop-guard (deterministic) +
   `canary guardian author-plan` CLI seam. **← SC-6, D4.**
8. **Orchestrator skill** (T8) — `SKILL.md` + `skill.yaml` driving the agents.
   **← SC-6, discovery.**
9. **Slash command + index** (T9) — `commands/canary-pr-guardian.md` +
   regenerate `skills-index.json`. **← discovery (OT-8).**

_Skeleton approved: pending — this plan is human-gated; approval of the skeleton
direction is part of the sign-off._

## Conventions (apply to every task)

- **TDD, test-first.** Write the test, run it, watch it fail for the intended
  reason, then implement until green. No implementation before a failing test.
- **No real agent/LLM/network in any test.** Every agent interaction goes
  through an injected `FakeInvoker` returning canned data. The
  `RecordingInvoker` default calls nothing.
- **Test command:** `python3 -m pytest tests/unit/<file> -q`
- **Lint (every task):** `ruff check agent tests hooks`
- **Validate (every task, final step):** `harness validate`
- **Commit (every task):** conventional `feat(guardian): …` /
  `test(guardian): …`. We are on `feat/canary-guardian-agent-tier`; commit per
  task. **No AI co-author trailer.**
- **SC-11:** `agent_tier.py` imports no LLM SDK; the Tier-0 engine imports no
  `agent_tier`. Enforced by T6, respected from T1.

---

## Tasks

### Task 1: `agent_tier.py` foundation — Protocol, port, types

**Depends on:** none | **Files:** `agent/guardian/agent_tier.py`,
`tests/unit/test_guardian_agent_tier.py`

**Outputs (signatures to implement):**

```python
# agent/guardian/agent_tier.py — the ONE agent-orchestration module.
# SC-11: imports NO LLM SDK; reaches agents only via the injected AgentInvoker.
from __future__ import annotations
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol, runtime_checkable

from agent.guardian.pr_check import Finding  # Tier-0 type reuse (safe: no cycle)


@dataclass(frozen=True)
class ReviewRequest:
    """What Tier 1 asks canary-test-reviewer to audit."""
    test_paths: list[Path]


@dataclass(frozen=True)
class GeneratedTest:
    """An authoring intent and its (eventual) result.

    v1 status: 'planned' (RecordingInvoker), 'authored' (fake/real invoker wrote
    it), or 'skipped' (a safety guard blocked it)."""
    gap: Finding
    target_path: str
    requirement: str            # NL requirement → /canary-write-test $ARGUMENTS
    status: str = "planned"     # planned | authored | skipped
    written_path: str | None = None
    skip_reason: str | None = None


@runtime_checkable
class AgentInvoker(Protocol):
    """Port to an agent runtime. Production default records; tests fake it."""
    def review(self, request: ReviewRequest) -> str: ...          # transcript
    def author(self, intent: GeneratedTest) -> GeneratedTest: ...  # -> authored


@dataclass(frozen=True)
class RecordingInvoker:
    """Default production invoker: calls NOTHING. Returns a planned intent so the
    SKILL fulfils it in-session (Option A)."""
    def review(self, request: ReviewRequest) -> str:
        return ""  # nothing reviewed in Python; SKILL drives canary-test-reviewer
    def author(self, intent: GeneratedTest) -> GeneratedTest:
        return intent  # status stays 'planned'; SKILL drives canary-test-author


class AgentTier(Protocol):
    """The capability boundary a future CiAgentTier also implements."""
    def audit_test_quality(self, affected_tests: list[Path]) -> list[Finding]: ...
    def author_tests(self, gaps: list[Finding]) -> list[GeneratedTest]: ...
```

**TDD steps:**

1. Write `tests/unit/test_guardian_agent_tier.py::TestFoundation`:
   - `GeneratedTest(gap=<Finding>, target_path="t", requirement="r")` defaults
     `status == "planned"`, `written_path is None`.
   - `RecordingInvoker().review(ReviewRequest([]))` returns `""`; `.author(g)`
     returns a `GeneratedTest` with `status == "planned"` (records, calls
     nothing).
   - `isinstance(RecordingInvoker(), AgentInvoker)` is `True` (runtime_checkable
     port); a local `FakeInvoker` also satisfies it.
2. `python3 -m pytest tests/unit/test_guardian_agent_tier.py -q` → fails (no
   module).
3. Implement `agent_tier.py` per signatures (types + port + RecordingInvoker
   only).
4. Rerun → passes. `ruff check agent tests hooks`. `harness validate`.
5. Commit:
   `feat(guardian): add agent-tier boundary foundation (Protocol, port, types)`

### Task 2: Tier-1 audit — `InSessionAgentTier.audit_test_quality` (read-only)

**Depends on:** T1 | **Files:** `agent/guardian/agent_tier.py`,
`tests/unit/test_guardian_agent_tier.py`

**Context:** Tier 1 composes `canary-test-reviewer`. In Python this means: build
a `ReviewRequest`, call `invoker.review(...)`, and **parse** the returned
transcript into `weak-test` `Finding`s (distinct from Tier-0
`untested-new-code`). Read-only: writes nothing.

**Outputs:**

```python
# agent/guardian/agent_tier.py (append)
@dataclass
class InSessionAgentTier:
    """v1 AgentTier: drives canary-test-reviewer/-author via an injected invoker.
    Calls NO LLM itself (Option A)."""
    invoker: AgentInvoker = field(default_factory=RecordingInvoker)

    def audit_test_quality(self, affected_tests: list[Path]) -> list[Finding]:
        transcript = self.invoker.review(ReviewRequest(list(affected_tests)))
        return _parse_review_findings(transcript)


def _parse_review_findings(transcript: str) -> list[Finding]:
    """Parse canary-test-reviewer's `[severity] path:line` lines into weak-test
    Findings. Empty transcript (RecordingInvoker) → [] (SKILL reports directly)."""
    ...
```

**TDD steps:**

1. Extend the test with `TestAuditTestQuality`:
   - A `FakeInvoker(review_transcript="[Critical] tests/foo_test.py:12\n...")`
     injected → `audit_test_quality([Path("tests/foo_test.py")])` returns ≥1
     `Finding` with `kind == "weak-test"` and the parsed severity/path.
   - Default `InSessionAgentTier()` (RecordingInvoker) → returns `[]` and
     touches no file (assert via a `tmp_path` guard that nothing was written).
   - Malformed transcript line → skipped, not crashing.
2. Run → fail. Implement `InSessionAgentTier` + `_parse_review_findings`.
3. Run → pass. `ruff check agent tests hooks`. `harness validate`.
4. Commit:
   `feat(guardian): add Tier-1 test-quality audit via canary-test-reviewer`

### Task 3: Real capability probe — `InSessionAgentProbe`

**Depends on:** T1 | **Files:** `agent/guardian/agent_tier.py`,
`tests/unit/test_guardian_agent_tier.py`

**Context:** Phase 3 shipped `resolve_tier(requested, probe=None)` defaulting to
`NoAgentProbe` (ceiling 0). This task supplies a **real** probe that reports a
higher ceiling when a runtime is signalled, so `resolve_tier` stops degrading —
**without changing `resolve_tier` or its callers** (drop-in, per Phase-3
design). The probe returns an `int` only and imports no LLM (SC-11).

**Outputs:**

```python
# agent/guardian/agent_tier.py (append)
import os

@dataclass(frozen=True)
class InSessionAgentProbe:
    """Reports the agent tier ceiling from an explicit opt-in signal.

    Reads env `CANARY_GUARDIAN_AGENT` (`0|1|2`), which the SKILL exports when it
    runs in-session. Unset/invalid → 0 (CI stays Tier-0). Returns an int only —
    NO LLM import (SC-11)."""
    def available_tier(self) -> int:
        raw = os.environ.get("CANARY_GUARDIAN_AGENT", "0")
        return int(raw) if raw in {"0", "1", "2"} else 0
```

**TDD steps:**

1. Extend the test with `TestInSessionAgentProbe` (monkeypatch env, never real):
   - env unset → `available_tier() == 0`;
     `resolve_tier(2, InSessionAgentProbe())` → `effective == 0`, loud
     `degraded_notice` (Phase-3 behavior preserved).
   - `CANARY_GUARDIAN_AGENT=2` → `available_tier() == 2`;
     `resolve_tier(2, InSessionAgentProbe())` → `effective == 2`,
     `degraded_notice is None` (SC-5: no false degradation when present).
   - `CANARY_GUARDIAN_AGENT=1` → `resolve_tier(2, …)` degrades to 1 loudly;
     `resolve_tier(1, …)` → `effective == 1`, no notice.
   - garbage value (`"9"`, `"x"`) → `0`.
2. Run → fail. Implement `InSessionAgentProbe`.
3. Run the probe + Phase-3 tier suite together:

   ```bash
   python3 -m pytest tests/unit/test_guardian_agent_tier.py \
     tests/unit/test_guardian_tier.py -q
   ```

   `ruff check agent tests hooks`. `harness validate`.

4. Commit:
   `feat(guardian): add InSessionAgentProbe to lift tier degradation (SC-5)`

### Task 4: Authoring safety model — `plan_authoring` (D4 guards a–d)

**Depends on:** T1 | **Files:** `agent/guardian/agent_tier.py`,
`tests/unit/test_guardian_agent_tier.py`

**Context:** the four auto-commit-back safeguards, as **pure** logic — no
writing, no agent. Produces authoring intents ONLY when every precondition
holds; otherwise a `skipped` record with a reason.

**Outputs:**

```python
# agent/guardian/agent_tier.py (append)
@dataclass(frozen=True)
class AuthoringContext:
    author_tests_optin: bool          # config.precommit_author_tests (default False)
    effective_tier: int               # from resolve_tier (2 == can author)
    is_fork: bool = False             # reuse Phase-2 fork/403 detection
    repo_root: Path = field(default_factory=lambda: Path("."))
    authored_sentinel_present: bool = False  # loop-guard (a)

def _target_test_path(gap: Finding) -> str:
    """Deterministic target path for a gap (mirror peer test layout)."""
    ...

def _requirement_for(gap: Finding) -> str:
    """NL requirement string for /canary-write-test ($ARGUMENTS)."""
    ...

def plan_authoring(gaps: list[Finding], ctx: AuthoringContext) -> list[GeneratedTest]:
    """Apply guards (d) opt-in, (b) fork, (a) loop-guard, (c) collision; emit one
    planned intent per authorable gap, else a skipped record. Writes nothing."""
    ...
```

**TDD steps:**

1. Extend the test with `TestPlanAuthoring` (use `tmp_path` as `repo_root`):
   - **(d) opt-in:** `author_tests_optin=False` → every gap →
     `status=="skipped"`, `skip_reason` mentions "opt-in"; `effective_tier<2` →
     skipped "tier".
   - **(b) fork:** `is_fork=True` (opt-in on, tier 2) → all `skipped`, reason
     contains "fork".
   - **(c) collision:** create `tmp_path/<target>` on disk → that gap `skipped`
     reason contains "collision"/"exists"; a gap whose target does **not** exist
     → `status=="planned"` with a non-empty `requirement` and `target_path`.
   - **(a) loop-guard:** `authored_sentinel_present=True` → all `skipped` reason
     contains "already authored".
   - **happy path:** opt-in on, tier 2, not fork, no sentinel, no collision →
     exactly one `planned` intent per gap.
2. Run → fail. Implement `plan_authoring` + helpers.
3. Run → pass. `ruff check agent tests hooks`. `harness validate`.
4. Commit:
   `feat(guardian): add authoring safety model (opt-in, fork, collision, loop-guard)`

### Task 5: Tier-2 author — `author_tests` + `decide_block`

**Depends on:** T4 | **Files:** `agent/guardian/agent_tier.py`,
`tests/unit/test_guardian_agent_tier.py`

**Context:** wires `plan_authoring` to the injected invoker to produce
`GeneratedTest`s, and computes the **block-once** decision. Still no real
writing — the FakeInvoker returns `authored` records; the actual `git add` +
block is T7/T8.

**Outputs:**

```python
# agent/guardian/agent_tier.py — extend InSessionAgentTier
    def author_tests(self, gaps: list[Finding],
                     ctx: AuthoringContext | None = None) -> list[GeneratedTest]:
        plan = plan_authoring(gaps, ctx or AuthoringContext(False, 0))
        out: list[GeneratedTest] = []
        for intent in plan:
            if intent.status == "planned":
                out.append(self.invoker.author(intent))  # -> authored (fake/real)
            else:
                out.append(intent)                        # skipped, unchanged
        return out


@dataclass(frozen=True)
class BlockDecision:
    block: bool
    message: str
    authored_count: int

def decide_block(results: list[GeneratedTest]) -> BlockDecision:
    """Block ONCE iff ≥1 test was authored & staged this run. Never on an
    all-skipped run (nothing changed)."""
    ...
```

**TDD steps:**

1. Extend the test with `TestAuthorTests` and `TestDecideBlock`:
   - `FakeInvoker` whose `author(intent)` returns `intent` with
     `status="authored", written_path=<target>` → `author_tests(gaps, ctx_ok)`
     yields `authored` records for authorable gaps and `skipped` for guarded
     ones.
   - Default `InSessionAgentTier()` (RecordingInvoker) + `ctx_ok` → planned
     intents stay `status=="planned"` (Python authored nothing — Option A).
   - `decide_block([authored, authored])` → `block is True`,
     `authored_count == 2`, message contains "authored & staged" and
     "re-commit".
   - `decide_block([skipped, skipped])` → `block is False` (nothing to review).
   - **never a real agent/LLM/network call** — assert the FakeInvoker was the
     only invoker used.
2. Run → fail. Implement `author_tests` + `decide_block`.
3. Run → pass. `ruff check agent tests hooks`. `harness validate`.
4. Commit:
   `feat(guardian): add Tier-2 author_tests + block-once decision (SC-6)`

### Task 6: Extend the SC-11 boundary test to the agent tier

**Depends on:** T5 | **Files:**
`tests/unit/test_guardian_capability_boundary.py`

**Context:** the engine must still exclude `agent_tier`/LLM; and per Option A
even the _allowed_ `agent_tier.py` must import no LLM SDK (it reaches agents via
the port). This task adds both assertions. `agent_tier.py` is deliberately
**NOT** added to the Tier-0 `_MODULES` list — it is the one place orchestration
is allowed.

**Outputs:** add a dedicated agent-tier scan; keep `_MODULES` (Tier-0)
unchanged.

```python
# tests/unit/test_guardian_capability_boundary.py (append)
_AGENT_TIER = _REPO_ROOT / "agent" / "guardian" / "agent_tier.py"
_LLM_SDK_DENYLIST = ("anthropic", "openai", "google.generativeai", "agent.llm")

def test_agent_tier_imports_no_llm_sdk() -> None:
    """agent_tier.py MAY define/reference the AgentInvoker port but must not
    import an LLM SDK directly (Option A: the SKILL/host session drives agents)."""
    tree = ast.parse(_AGENT_TIER.read_text(encoding="utf-8"))
    tokens = {t.lower() for t in _import_tokens(tree)}
    for token in tokens:
        for banned in _LLM_SDK_DENYLIST:
            assert banned not in token, (
                f"agent_tier.py imports LLM SDK '{token}' — Option A boundary breach"
            )

def test_engine_still_excludes_agent_tier() -> None:
    """The Tier-0 modules must not import agent_tier (belt-and-braces over the
    parametrized denylist)."""
    for module_path in _MODULES:
        tree = ast.parse(module_path.read_text(encoding="utf-8"))
        tokens = {t.lower() for t in _import_tokens(tree)}
        assert not any("agent_tier" in t for t in tokens), (
            f"{module_path.name} imports agent_tier — SC-11 breach"
        )
```

**TDD steps:**

1. Add the two tests. **RED proof (per the file's convention):** temporarily add
   `import anthropic` to the top of `agent/guardian/agent_tier.py`, run the
   file, watch `test_agent_tier_imports_no_llm_sdk` fail; remove it, watch it go
   green. Then temporarily add `from agent.guardian import agent_tier` to
   `hooks/guardian_precommit.py`, watch `test_engine_still_excludes_agent_tier`
   (and the parametrized `_is_agent_tier_token` scan) fail; remove it, watch
   green. Document the cycle in the module docstring.
2. Run → confirm RED-proof then GREEN:
   `python3 -m pytest tests/unit/test_guardian_capability_boundary.py -q`.
   `ruff check agent tests hooks`. `harness validate`.
3. Commit: `test(guardian): extend SC-11 boundary to agent_tier (no LLM SDK)`

---

### `[checkpoint:human-verify]` — confirm the seam + probe + safety model

**Pause here.** Before ANY test-writing/staging behavior is wired, show the
human:

- the `AgentTier`/`InSessionAgentTier` seam and the **Option A** invocation
  mechanism (Python never calls an LLM; SKILL drives agents; `AgentInvoker`
  port);
- the real `InSessionAgentProbe` + `resolve_tier` drop-in (SC-5 regression
  green);
- the four **safety guards** (`plan_authoring`) and the `decide_block`
  block-once logic — all pure and unit-tested with a fake invoker.

**Ask:** "Confirm the capability seam, the probe/opt-in signal, and the write-
safety model before I wire the actual stage-and-block authoring (T7–T9)?" Wait
for explicit confirmation. If the human wants Option B, a separate `writeEnable`
flag, or a different availability signal, revise T7–T9 before proceeding.

---

### Task 7: Stage-and-block-once wiring — hook sentinel + `author-plan` CLI seam

**Depends on:** T5 (and checkpoint clearance) | **Files:**
`agent/guardian/cli.py`, `hooks/guardian_precommit.py`,
`tests/unit/test_guardian_precommit.py`

**Context:** two deterministic pieces that carry SC-6/D4 without breaching
SC-11: (1) a **filesystem-only** sentinel loop-guard in the Tier-0 hook (imports
no agent module — stays in `_MODULES`); (2) the
**`canary guardian author-plan --json`** CLI seam the SKILL calls to get
intents + block decision (lazy `agent_tier` import; `cli.py` is not in the
Tier-0 boundary set).

**Outputs:**

```python
# hooks/guardian_precommit.py (append) — DETERMINISTIC, no agent import.
_AUTHORED_SENTINEL = ".git/canary-guardian-authored"

def _sentinel_path(root: Path) -> Path:
    return root / _AUTHORED_SENTINEL

def authored_recommit_passthrough(root: Path | None = None) -> bool:
    """Loop-guard (a): if the guardian's sentinel is present, consume it and let
    THIS commit through once (the human is re-committing reviewed, staged,
    guardian-authored tests). Returns True when it consumed the sentinel."""
    p = _sentinel_path(root or REPO_ROOT)
    if p.is_file():
        p.unlink()
        return True
    return False
# main(): call authored_recommit_passthrough() first; if True, print
# "guardian: authored tests re-committed — passing once." and return 0.
```

```python
# agent/guardian/cli.py (append) — in-session seam; lazy agent_tier import.
@guardian_app.command("author-plan")
def author_plan(
    diff: Optional[str] = typer.Option(None, "--diff"),
    config_path: str = typer.Option("harness.config.json", "--config"),
    output_json: bool = typer.Option(True, "--json"),
) -> None:
    """Emit the at-desk authoring plan (intents + block decision) for the SKILL to
    fulfil. In-session only; NOT run by CI. Uses InSessionAgentProbe + the safety
    model; authors nothing itself (Option A)."""
    from agent.guardian.agent_tier import (
        AuthoringContext, InSessionAgentProbe, InSessionAgentTier, decide_block,
    )
    from agent.guardian.tier import resolve_tier
    # ... build gaps via the SAME Tier-0 pipeline as pr_check (scope→filter→cover→
    # build_findings), resolve tier with InSessionAgentProbe, construct
    # AuthoringContext (opt-in=config.precommit_author_tests, is_fork, sentinel),
    # results = InSessionAgentTier().author_tests(gaps, ctx), emit
    # {"intents": [...], "block": decide_block(results).__dict__} as JSON.
```

**TDD steps:**

1. Extend `tests/unit/test_guardian_precommit.py`:
   - `TestSentinelLoopGuard`: create `tmp/.git/canary-guardian-authored` →
     `authored_recommit_passthrough(tmp)` returns `True` and the file is gone; a
     second call returns `False` (consumed once — no infinite loop). `main([])`
     with the sentinel present (monkeypatch `REPO_ROOT`) returns 0 without
     running the pipeline.
2. Extend `tests/unit/test_guardian_cli.py::TestAuthorPlan` (CliRunner,
   network-free, inject a fake invoker via monkeypatching
   `agent_tier.InSessionAgentTier` or its `invoker`):
   - `author-plan --diff -` on a diff adding an untested unit, opt-in off → JSON
     `intents[*].status == "skipped"`, `block.block is False`.
   - opt-in on + `CANARY_GUARDIAN_AGENT=2` + fake author invoker → JSON has ≥1
     `planned`/`authored` intent and `block.block is True` with a message.
3. Run → fail. Implement the sentinel guard + `author-plan`.
4. Run the hook + cli + agent-tier suites:

   ```bash
   python3 -m pytest tests/unit/test_guardian_precommit.py \
     tests/unit/test_guardian_cli.py \
     tests/unit/test_guardian_agent_tier.py -q
   ```

   `ruff check agent tests hooks`. `harness validate`.

5. Commit:
   `feat(guardian): wire stage-and-block-once (sentinel + author-plan seam)`

### Task 8: Orchestrator skill — `SKILL.md` + `skill.yaml`

**Depends on:** T7 | **Files:**
`agents/skills/claude-code/canary-pr-guardian/SKILL.md`,
`agents/skills/claude-code/canary-pr-guardian/skill.yaml`

**Context:** the markdown the host session executes — the actual Option-A
driver. It composes the deterministic CLI and the two native agents, and
enforces block-once. Frontmatter matches the house style (see
`canary-test-pipeline`).

**Outputs (SKILL.md frontmatter + phases):**

```markdown
---
name: canary-pr-guardian
description: >
  PR/pre-commit test-guardian orchestrator: runs the deterministic Tier-0
  diff-coverage pass, audits affected tests via canary-test-reviewer (Tier 1),
  and — at the desk with authorTests opt-in — authors missing tests via
  canary-test-author (Tier 2), staging them and blocking the commit once for
  human review. Use to guard a change's test quality before it lands.
---

# Canary: PR Guardian

## When to Use

## Phases

### Phase 0 — Deterministic scope (`canary guardian pr-check --format json`)

### Phase 1 — Quality audit (`canary-test-reviewer`, read-only) [tier ≥ 1]

### Phase 2 — Authoring plan (`canary guardian author-plan --json`) [tier 2 + opt-in]

### Phase 3 — Author (`canary-test-author` per intent), `git add`, block once
```

Body (concise, imperative) must state: export `CANARY_GUARDIAN_AGENT` so the
probe reports the ceiling; NEVER commit or push (stage + stop); honor every
`skipped` reason from `author-plan` (fork/collision/opt-out) without overriding
it; on `block.block == true` print the block message and leave the staged tests
for the human to review and re-commit.

**skill.yaml (house style):**

```yaml
name: canary-pr-guardian
version: '1.0.0'
description:
  PR/pre-commit test-guardian orchestrator — Tier-0 diff-coverage, Tier-1
  quality audit via canary-test-reviewer, and at-desk Tier-2 authoring via
  canary-test-author with stage-and-block-once review.
stability: static
triggers:
  - manual
platforms:
  - claude-code
type: rigid
tools: []
tier: 1
depends_on:
  - canary-test-reviewer
  - canary-test-author
```

**TDD steps (the discovery tree IS the test):**

1. Write `SKILL.md` + `skill.yaml`.
2. Run the discovery guard:
   `python3 -m pytest tests/unit/test_discovery_tree_integrity.py -q` →
   `TestSkillFrontmatter` must pass (non-empty `name`/`description`, name
   matches directory `canary-pr-guardian`). `depends_on` targets exist as
   agents.
3. `ruff check agent tests hooks`. `harness validate`.
4. Commit:
   `feat(guardian): add canary-pr-guardian orchestrator skill (SKILL.md + skill.yaml)`

### Task 9: Slash command + regenerate skills-index

**Depends on:** T8 | **Files:** `commands/canary-pr-guardian.md` (+ generated
`.harness/skills-index.json`, `agents/commands/**` via the generator) |
**Category:** integration

**Context:** the slash-command entry + the generated discovery artifacts. Per
the issue #308 lesson, author the tracked source and **regenerate** the index —
never hand-edit `.harness/skills-index.json`.

**Outputs (`commands/canary-pr-guardian.md`):**

```markdown
---
description:
  Run the canary PR test-guardian — Tier-0 diff-coverage, Tier-1 quality audit,
  and at-desk Tier-2 authoring with stage-and-block-once review.
argument-hint: '[--diff <file>] [--tier 0|1|2]'
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# canary-pr-guardian

Use the `canary-pr-guardian` skill to guard this change's test quality.

$ARGUMENTS
```

**TDD steps:**

1. Write `commands/canary-pr-guardian.md`.
2. Regenerate discovery artifacts: `harness generate-slash-commands`.
3. Run the discovery guard:
   `python3 -m pytest tests/unit/test_discovery_tree_integrity.py -q` →
   `TestCommandReferences` passes (the command references the existing skill)
   and `TestAgentCommandAtReferences` resolves any generated `@agents/...` refs.
4. `ruff check agent tests hooks`. `harness validate`.
5. Commit:
   `feat(guardian): add /canary-pr-guardian slash command + regenerate skills-index`

---

## Sequencing & Parallelism

- **Critical path:** T1 → T4 → T5 → T6 → **checkpoint** → T7 → T8 → T9.
- **Parallel after T1:** T2 (audit) and T3 (probe) are independent leaves — both
  append to `agent_tier.py`/its test, so serialize their _edits_ but they have
  no logical dependency on each other; T4 also depends only on T1.
- **File-contention note:** T1–T5 all touch `agent/guardian/agent_tier.py` +
  `tests/unit/test_guardian_agent_tier.py` → sequence them (they are additive
  layers). T6 owns only the boundary test. T7 owns `cli.py` + the hook + their
  tests. T8/T9 own the skill/command files. No two concurrently-runnable tasks
  share a file once the critical path is respected.
- **Checkpoint gate:** T7–T9 (all write/stage/skill-driving behavior) must NOT
  start until the human confirms the seam + probe + safety model after T6.

## Post-Phase Verification (Definition of Done)

```bash
python3 -m pytest \
  tests/unit/test_guardian_agent_tier.py \
  tests/unit/test_guardian_tier.py \
  tests/unit/test_guardian_precommit.py \
  tests/unit/test_guardian_cli.py \
  tests/unit/test_guardian_capability_boundary.py \
  tests/unit/test_discovery_tree_integrity.py -q
ruff check agent tests hooks
harness validate
harness generate-slash-commands          # regenerates skills-index.json (T9)
```

All green + SC-6 / SC-11 traced to passing tests, the SC-5 regression (probe
present ⇒ no false degradation) green, and every agent interaction exercised
only through a fake invoker (no real agent/LLM/network in any test) ⇒ Phase 4
code complete. Phase 5 (`--emit-analysis` / harness `pre-merge-brief`) and the
deferred `CiAgentTier` plug into this seam — the future runner implements the
**same** `AgentTier` Protocol with a real subprocess `AgentInvoker`, **without**
changing `resolve_tier`, the Tier-0 engine, or the safety model built here.
