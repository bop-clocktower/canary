# Plan: canary-pr-guardian — Phase 5 (Harness-check integration)

**Date:** 2026-07-19 | **Spec:** `docs/changes/canary-pr-guardian/proposal.md`
(Phase 5 row, line 470; **SC-10**, line 449; Integration Points "Harness-check
integration", lines 372–389) | **Tasks:** 5 + 1 checkpoint | **Sitting-sized (≤3
files each)** | **Integration Tier:** medium | **Branch:**
`feat/canary-guardian-harness-check` | **HUMAN-GATED — plan only; implement
nothing until sign-off.**

> **Scope note — Phase 5 ONLY.** This phase builds the **producer** half of the
> harness reverse-handoff (#899): a `--emit-analysis` flag that writes ONE
> guardian finding record to the `.harness/analyses/` channel in a
> **canary-defined, documented, stable JSON schema**, plus the **SC-10
> fallback** — when the channel/harness ingestion is unavailable, the guardian
> degrades to the existing Phase-2 sticky comment and logs the fallback
> **loudly** (never silently drops the record). It also wires the workflow so a
> `gate: hard` non-zero exit can register as a **required status check** (the
> #311 "one gate") and passes `--emit-analysis`.
>
> **Explicitly OUT of scope** (do not build): the **harness-side
> `pre-merge-brief` consumer** itself (upstream #899 — not landed; its "Worth
> your eyes" consumption is "verified once #899 lands", so we document the
> contract but never depend on or integration-test it); Phase 6
> docs/ADRs/rollout (the `docs/guides/pr-guardian.md`, the disambiguation-matrix
> entry, README/ catalog, roadmap `#312 → done` — noted where they touch us but
> authored in Phase 6). The **Tier-0 engine's capability boundary is not
> relaxed**: the new `agent/guardian/analysis_emit.py` is deterministic I/O that
> imports **no** agent/LLM module and is **added to the SC-11 boundary test**
> (`_MODULES`).

## Goal

Make the guardian's deterministic Tier-0 result a **structured canary analysis**
that a future harness gate surface can consume in-flow —
`canary guardian pr-check --emit-analysis` writes one schema-valid finding
record to `.harness/analyses/`; when that channel is unavailable it falls back
**loudly** to the sticky PR comment — so the guardian becomes #899's **first
real producer** without any hard dependency on the upstream consumer landing
first (**SC-10**).

## Success Criteria This Phase Verifies

| SC        | Criterion (from spec, line 449)                                                                                                                                                                                                                                | Delivered by tasks |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| **SC-10** | With `--emit-analysis`, the finding record is written to the analyses channel in a documented schema; when harness ingestion is unavailable it falls back to the sticky comment and logs the fallback (`pre-merge-brief` consumption verified once #899 lands) | T1, T2, T4         |
| SC-11     | (regression + extension) the deterministic engine imports no agent/LLM module — the NEW `analysis_emit.py` is agent-free and is added to `_MODULES`                                                                                                            | T3                 |
| SC-4      | (regression) `gate: hard` still exits non-zero on unaddressed `critical/high` findings — Phase 5 surfaces that exit as a required check but does not change the exit logic                                                                                     | T5 (workflow/docs) |

## Observable Truths (Acceptance Criteria, EARS)

1. **Event-driven (SC-10 emit):** When `pr-check --emit-analysis` runs and the
   analyses channel is available, the system shall write exactly one JSON record
   to `.harness/analyses/canary-pr-guardian-<ref>.json` conforming to the v1.0
   envelope schema below, whose `findings` array is byte-for-byte the same
   finding data `render(fmt="json")` produces.
2. **Unwanted / fallback (SC-10 core):** If the analyses channel is unavailable
   (`.harness/` absent, or the analyses dir is not writable), then the system
   shall **not** silently drop the record — it shall emit a **loud** logged
   notice (`::warning::` annotation + `$GITHUB_STEP_SUMMARY` + stderr) **and**
   fall back to upserting the Phase-2 sticky comment.
3. **State-driven (compose):** While both `--emit-analysis` and `--post-comment`
   are passed and emit succeeds, the system shall write the record **and**
   upsert the sticky comment (findings stay visible while #899 is pending);
   while `--emit-analysis` succeeds without `--post-comment`, the system shall
   write the record and post **no** comment.
4. **Ubiquitous (schema round-trips):** The system shall write a record that a
   stub consumer can `json.loads` and read every documented field from — the
   schema is self-describing (`schemaVersion`, `source`) so a future harness
   consumer (#899) reads it without any canary change.
5. **Ubiquitous (SC-11 / D1):** The system shall keep `analysis_emit.py` free of
   any `AgentTier`/LLM-SDK import;
   `tests/unit/test_guardian_capability_boundary.py` `_MODULES` shall include it
   and pass.
6. **Optional (required-check, #311):** Where `gate: hard` is configured, the
   workflow's guardian job shall exit non-zero on unaddressed findings, and the
   job/check name shall be stable so a repo admin can register it as a
   **required status check** alongside `harness`/`validate`/`enforce`.

## The #899 producer contract — the analyses envelope schema (READ FIRST)

**This schema is the load-bearing decision of the phase — it is a contract with
a future harness consumer.** Confirm it at sign-off (★).

**Filename convention:** `.harness/analyses/canary-pr-guardian-<ref>.json`,
where `<ref>` = `pr-<n>` when a PR number is resolvable from CI env (reuse
`_pr_context_from_env`), else the short HEAD sha, else `local`; sanitized to
`[A-Za-z0-9._-]` (empty → `local`). The `canary-pr-guardian-` **prefix is
load-bearing**: harness's own `AnalysisArchive.list()` reads **every** `*.json`
in `.harness/analyses/` keyed by an internal `issueId`, storing files as
`<issueId>.json`; the prefix + sanitized ref namespaces canary's records so they
never collide with (overwrite) a harness intelligence record and always pass
`AnalysisArchive.safePath` (no traversal).

**Envelope schema (v1.0):**

```jsonc
{
  "schemaVersion": "1.0",
  "source": "canary-pr-guardian", // producer identity (self-describing)
  "ref": "pr-42", // PR number | short sha | "local"
  "gate": "soft", // effective gate at emit time
  "exitCode": 0, // gate result (0 pass / 1 hard-fail) — a
  //   consumer knows pass/fail without recompute
  "tier": 0, // effective tier that ran
  "degradedNotice": null, // tier-degradation string, or null
  "summary": {
    "total": 3,
    "unaddressed": 2, // active (non-suppressed) findings
    "suppressed": 1,
    "byFidelity": {
      "coverage-verified": 0,
      "graph-verified": 1,
      "heuristic": 2,
    },
  },
  "findings": [
    /* verbatim render(fmt="json") finding dicts:
                   path/unit/kind/fidelity/severity/evidence/suggestion/
                   suppressed/suppression_reason */
  ],
  "analyzedAt": "2026-07-19T00:00:00+00:00", // ISO-8601 UTC
}
```

**Why canary defines this (not harness's existing `AnalysisRecord`):** harness's
current `.harness/analyses/` record shape
(`issueId`/`identifier`/`spec`/`score`/ `simulation`/`analyzedAt`/`externalId`,
from `@harness-engineering/orchestrator`'s `AnalysisArchive`) is the
**intelligence-pipeline** shape (SEL/CML/PESL) — it does not model guardian
findings, and **#899 (harness consuming canary findings) has not landed**, so no
harness reader exists for a guardian finding record yet. Canary is therefore
free — and, as #899's first producer, obligated — to define this envelope. It
coexists on disk with harness records via the filename prefix; a future harness
consumer keys on `source == "canary-pr-guardian"`.

## Assumptions & Uncertainties (human: scrutinize the ★ ones)

- **★ [ASSUMPTION — the envelope schema + filename convention]** The v1.0 schema
  and `canary-pr-guardian-<ref>.json` naming above ARE the #899 producer
  contract. This is the big one — it is a cross-project interface. If harness
  (#899) later prefers a different envelope (e.g. reusing its
  `issueId`/`identifier` keys, or a `findings` sub-key under a harness-owned
  wrapper), the schema in T1 changes and the round-trip test in T2 changes with
  it. **Confirm before T1.**
- **★ [ASSUMPTION — the "ingestion available" signal]** The channel is
  **available iff `.harness/` exists at the repo root AND `.harness/analyses/`
  is writable** (created on demand — mirroring harness `AnalysisArchive.save`'s
  recursive `mkdir`). Absent `.harness/` (not a harness project) → unavailable →
  fallback; an `OSError` on mkdir/write (read-only FS, permission) → unavailable
  → fallback. This is deterministic and unit-testable with `tmp_path`
  (create/omit `tmp/.harness`; `chmod 0o555` to force a write failure).
  Rationale: `.harness/` is the harness home; a repo without it runs no harness,
  so there is no consumer and the comment is the right surface. **Alternative**
  signals considered and rejected for v1: an explicit `--no-emit`/env opt-out
  (adds surface with no consumer to gate on), or probing for #899 support
  (undetectable today). **Confirm.**
- **★ [ASSUMPTION — `--emit-analysis` × `--post-comment` composition]**
  `--emit-analysis` writes the record when available; on **unavailable** it
  emits a loud notice AND falls back to the sticky comment (SC-10). When
  `--post-comment` is **also** passed (the CI combo), the sticky comment
  **always** posts in addition to a successful emit — so findings stay visible
  **while #899 is pending** — and the plan documents dropping `--post-comment`
  once harness surfaces the record in `pre-merge-brief`. `--emit-analysis`
  alone + success → record only, no comment (the "one gate" end state).
  **Confirm this is the desired v1 posture** (vs. strictly
  emit-primary-suppress-comment, which would hide findings until #899 lands).
- **★ [ASSUMPTION — hard-gate "required check" mechanism]** The guardian's
  non-zero exit under `gate: hard` **already** fails the job (Phase 1
  `compute_exit_code`); making it a **required status check** "alongside
  `harness`/`validate`/`enforce`" is a **branch-protection registration** keyed
  on the stable check name **`PR Guardian / guardian`** (workflow `name:` + job
  id) — a repo-admin action, not a code change. Phase 5's code deliverable here
  is only: (i) the workflow passes `--emit-analysis`, (ii) the job/check name
  stays stable, (iii) a documented note on registering the required check. The
  full guide and the admin toggle are **Phase 6 / a
  `[checkpoint:human-action]`**. **Confirm.**
- **[ASSUMPTION]** `analysis_emit.build_analysis_record` reuses
  `agent.guardian.pr_check.render(findings, fmt="json")` for the `findings`
  array (the task's "SAME finding data render produces, wrapped in an envelope")
  and computes `summary`/`byFidelity` from the `Finding` objects directly. This
  is an intra-guardian import (agent-free); SC-11 holds.
- **[DEFERRABLE]** Exact wording of the loud fallback notice. Pinned canonical
  form (tune freely as long as it names the cause and says the comment is the
  fallback):

  ```text
  ::warning::guardian: harness analyses channel unavailable (.harness/ absent) — falling back to the sticky comment
  ```

## File Map

- CREATE `agent/guardian/analysis_emit.py` — the deterministic emit module
  (envelope builder, filename, channel-availability check, `emit_analysis`
  writer
  - `EmitResult`). Imports no agent/LLM (SC-11).
- CREATE `tests/unit/test_guardian_analysis_emit.py` —
  envelope/schema/filename + availability/write/fallback + round-trip TDD
  (`tmp_path`, no network).
- MODIFY `tests/unit/test_guardian_capability_boundary.py` — add
  `analysis_emit.py` to `_MODULES` (+ RED-proof note).
- MODIFY `agent/guardian/cli.py` — add `--emit-analysis` (+ hidden
  `--analyses-dir` for tests), `_resolve_analysis_ref`, extract
  `_post_sticky_comment`, wire emit → fallback → comment; compute exit early.
- MODIFY `tests/unit/test_guardian_cli.py` — emit/fallback/compose CLI TDD
  (`CliRunner`, `FakeGitHubClient`, `tmp_path`; network-free).
- MODIFY `.github/workflows/guardian.yml` — pass `--emit-analysis`; document the
  required-check registration.
- MODIFY `tests/unit/test_guardian_workflow.py` — assert `--emit-analysis` in
  the run block; stable job/check name.

## Skeleton (produced — 5 tasks + 1 checkpoint; parent house-style match)

1. **`analysis_emit.py` envelope + filename** (T1) — pure builder, no I/O. **←
   SC-10 schema.**
2. **Channel availability + write + fallback signal** (T2) —
   `channel_available`, `EmitResult`, `emit_analysis`; schema round-trips. **←
   SC-10 emit + fallback.**
3. **SC-11 boundary extension** (T3) — add `analysis_emit.py` to `_MODULES`. **←
   SC-11.** — **`[checkpoint:human-verify]`** (schema + filename + availability
   signal confirmed before any surface is wired) —
4. **CLI wiring** (T4) — `--emit-analysis`, `_resolve_analysis_ref`, extract
   `_post_sticky_comment`, emit→fallback→comment composition. **← SC-10
   surfaces.**
5. **Workflow + required-check** (T5, integration) — `--emit-analysis` in
   `guardian.yml`; stable check name + doc note. **← #311 one-gate, SC-4
   surface.**

_Skeleton approved: pending — this plan is human-gated; approving the skeleton
direction (and especially the ★ schema/availability decisions) is part of
sign-off._

## Conventions (apply to every task)

- **TDD, test-first.** Write the test, run it, watch it fail for the intended
  reason, then implement until green. No implementation before a failing test.
- **No network / no real harness in any test.** `tmp_path` for
  `.harness/analyses/`; `FakeGitHubClient` for the comment fallback; monkeypatch
  env for CI context.
- **Test command:** `python3 -m pytest tests/unit/<file> -q`
- **Lint (every task):** `ruff check agent tests hooks`
- **Validate (every task, final step):** `harness validate`
- **Commit (every task):** conventional `feat(guardian): …` /
  `test(guardian): …`. On `feat/canary-guardian-harness-check`; commit per task.
  **No AI co-author trailer.**
- **SC-11:** `analysis_emit.py` imports no `AgentTier`/LLM SDK; enforced by T3,
  respected from T1.

---

## Tasks

### Task 1: `analysis_emit.py` — envelope builder + filename (pure, no I/O)

**Depends on:** none | **Files:** `agent/guardian/analysis_emit.py`,
`tests/unit/test_guardian_analysis_emit.py`

**Outputs (signatures to implement):**

```python
# agent/guardian/analysis_emit.py
# Deterministic emit for the #899 producer contract. SC-11: imports NO agent/LLM.
from __future__ import annotations

import json
import re
from collections import Counter
from datetime import datetime, timezone

from agent.guardian.pr_check import Finding, render  # intra-guardian, agent-free

SCHEMA_VERSION = "1.0"
SOURCE = "canary-pr-guardian"
_REF_SAFE = re.compile(r"[^A-Za-z0-9._-]")


def analysis_filename(ref: str, source: str = SOURCE) -> str:
    """`<source>-<sanitized-ref>.json`; empty/blank ref → '<source>-local.json'.

    Prefixing namespaces canary records so they never clobber harness's own
    `<issueId>.json` records and always pass AnalysisArchive.safePath."""
    safe = _REF_SAFE.sub("-", ref).strip("-") or "local"
    return f"{source}-{safe}.json"


def build_analysis_record(
    findings: list[Finding],
    *,
    ref: str,
    gate: str,
    effective_tier: int,
    degraded_notice: str | None,
    exit_code: int,
    analyzed_at: str | None = None,
) -> dict:
    """Build the v1.0 envelope. `findings` is exactly render(fmt='json')'s array."""
    inner = json.loads(
        render(findings, fmt="json", tier=effective_tier, degraded_notice=degraded_notice)
    )
    active = [f for f in findings if not f.suppressed]
    suppressed = [f for f in findings if f.suppressed]
    by_fidelity = Counter(f.fidelity.value for f in findings)
    return {
        "schemaVersion": SCHEMA_VERSION,
        "source": SOURCE,
        "ref": ref,
        "gate": gate,
        "exitCode": exit_code,
        "tier": effective_tier,
        "degradedNotice": degraded_notice,
        "summary": {
            "total": len(findings),
            "unaddressed": len(active),
            "suppressed": len(suppressed),
            "byFidelity": dict(by_fidelity),
        },
        "findings": inner["findings"],
        "analyzedAt": analyzed_at or datetime.now(timezone.utc).isoformat(),
    }
```

**TDD steps:**

1. Write `tests/unit/test_guardian_analysis_emit.py::TestEnvelope` &
   `::TestFilename` (build `Finding`s via the real Tier-0 types — reuse
   `agent.guardian.pr_check.Finding`, `agent.guardian.coverage.Fidelity`,
   `agent.guardian.impact_mapper.Severity`; do NOT hand-roll):
   - `build_analysis_record` with `ref="pr-7"`, `gate="hard"`,
     `effective_tier=0`, `degraded_notice=None`, `exit_code=1`,
     `analyzed_at="2026-07-19T00:00:00+00:00"` → `schemaVersion == "1.0"`,
     `source == "canary-pr-guardian"`, `ref == "pr-7"`, `gate == "hard"`,
     `exitCode == 1`, `analyzedAt` echoes the pinned value.
   - `record["findings"] == json.loads(render(findings, fmt="json", tier=0))["findings"]`
     (verbatim reuse — OT-1).
   - `summary.total/unaddressed/suppressed` count correctly when one finding is
     `suppressed=True`; `summary.byFidelity` matches a `Counter` of fidelity
     values.
   - `analysis_filename("pr-42") == "canary-pr-guardian-pr-42.json"`;
     `analysis_filename("feature/x y") == "canary-pr-guardian-feature-x-y.json"`;
     `analysis_filename("") == "canary-pr-guardian-local.json"`; result contains
     no `/` and passes a `[A-Za-z0-9._-]+\.json` fullmatch.
2. `python3 -m pytest tests/unit/test_guardian_analysis_emit.py -q` → fails (no
   module).
3. Implement `analysis_emit.py` per the signatures above (builder + filename
   only).
4. Rerun → passes. `ruff check agent tests hooks`. `harness validate`.
5. Commit:
   `feat(guardian): add analysis envelope builder + filename (#899 producer schema)`

### Task 2: channel availability + write + fallback signal — `emit_analysis`

**Depends on:** T1 | **Files:** `agent/guardian/analysis_emit.py`,
`tests/unit/test_guardian_analysis_emit.py`

**Context:** the I/O half. Availability = `.harness/` exists AND `analyses/` is
writable (created on demand). Unavailable OR write-error → `EmitResult` carrying
a loud notice; the CLII (T4) turns that into the SC-10 fallback.

**Outputs (append to `analysis_emit.py`):**

```python
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class EmitResult:
    """Outcome of an emit attempt. `action` is 'emitted' | 'unavailable'.
    `path` is the written file (None when unavailable); `notice` is the LOUD
    fallback message, set only when unavailable."""
    action: str
    path: str | None
    notice: str | None = None


def channel_available(analyses_dir: Path) -> bool:
    """True iff the harness home (`analyses_dir.parent`, i.e. `.harness/`) exists.
    The analyses dir itself is created on demand by `emit_analysis`."""
    return analyses_dir.parent.is_dir()


def emit_analysis(
    findings: list[Finding],
    *,
    analyses_dir: Path,
    ref: str,
    gate: str,
    effective_tier: int,
    degraded_notice: str | None,
    exit_code: int,
    analyzed_at: str | None = None,
) -> EmitResult:
    """Write one record to `analyses_dir/<filename>`; on absent-channel or OSError
    return an 'unavailable' EmitResult with a loud notice (SC-10 fallback)."""
    if not channel_available(analyses_dir):
        return EmitResult(
            "unavailable", None,
            notice="guardian: harness analyses channel unavailable "
                   "(.harness/ absent) — falling back to the sticky comment",
        )
    record = build_analysis_record(
        findings, ref=ref, gate=gate, effective_tier=effective_tier,
        degraded_notice=degraded_notice, exit_code=exit_code, analyzed_at=analyzed_at,
    )
    target = analyses_dir / analysis_filename(ref)
    try:
        analyses_dir.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(record, indent=2), encoding="utf-8")
    except OSError as exc:
        return EmitResult(
            "unavailable", None,
            notice=f"guardian: analyses write failed ({exc}) — "
                   "falling back to the sticky comment",
        )
    return EmitResult("emitted", str(target), None)
```

**TDD steps:**

1. Extend the test with `TestChannelAvailability`, `TestEmitWrite`,
   `TestEmitFallback`, `TestRoundTrip` (all `tmp_path`):
   - `channel_available(tmp_path/".harness"/"analyses")` is `False` before
     `tmp_path/".harness"` exists; `(tmp_path/".harness").mkdir()` → `True`.
   - **emit available:** with `tmp/.harness` present, call `emit_analysis` with
     `analyses_dir=tmp/".harness"/"analyses"`, `ref="pr-3"`, `gate="soft"`,
     `effective_tier=0`, `degraded_notice=None`, `exit_code=0` →
     `action == "emitted"`, file exists at
     `.../analyses/canary-pr-guardian-pr-3.json`, `notice is None`.
   - **round-trip (OT-4):** a stub consumer
     `json.loads(Path(res.path).read_text())` reads
     `schemaVersion/source/ref/gate/exitCode/summary/findings/analyzedAt`;
     `record["findings"]` equals `render(fmt="json")`'s array.
   - **unavailable (channel absent):** `tmp/.harness` does NOT exist →
     `action == "unavailable"`, `path is None`, `notice` contains "unavailable"
     and "sticky comment"; **no file written** anywhere under `tmp`.
   - **unavailable (write error):** create `tmp/.harness`, `chmod(0o555)` on it
     → `action == "unavailable"`, `notice` contains "write failed" (restore
     perms in a `finally`). Skip on platforms where the chmod does not deny
     writes (e.g. root) via a `pytest.mark.skipif`/write-probe guard.
2. Run → fail. Implement `channel_available`/`EmitResult`/`emit_analysis`.
3. Run → pass. `ruff check agent tests hooks`. `harness validate`.
4. Commit:
   `feat(guardian): add analyses channel write + loud fallback signal (SC-10)`

### Task 3: extend the SC-11 boundary test to `analysis_emit.py`

**Depends on:** T2 | **Files:**
`tests/unit/test_guardian_capability_boundary.py`

**Context:** the new module is deterministic I/O and MUST stay agent-free. Add
it to the Tier-0 `_MODULES` list so both parametrized guards
(`test_no_forbidden_imports`, `test_no_mcp_tool_references`) cover it.

**Outputs:**

```python
# tests/unit/test_guardian_capability_boundary.py — add to _MODULES
_MODULES = [
    _REPO_ROOT / "agent" / "guardian" / "pr_check.py",
    _REPO_ROOT / "agent" / "guardian" / "coverage.py",
    _REPO_ROOT / "agent" / "guardian" / "pr_comment.py",
    _REPO_ROOT / "agent" / "guardian" / "tier.py",
    _REPO_ROOT / "hooks" / "guardian_precommit.py",
    _REPO_ROOT / "agent" / "guardian" / "analysis_emit.py",  # + Phase 5 (SC-11)
]
```

**TDD steps:**

1. Add `analysis_emit.py` to `_MODULES` and extend the module-docstring
   RED-proof note (Phase 5). **RED proof:** temporarily add `import anthropic`
   to the top of `agent/guardian/analysis_emit.py`, run the file, watch
   `test_no_forbidden_imports[analysis_emit.py]` fail; remove it → green.
2. `python3 -m pytest tests/unit/test_guardian_capability_boundary.py -q` →
   green (all modules, incl. the new one). `ruff check agent tests hooks`.
   `harness validate`.
3. Commit:
   `test(guardian): extend SC-11 boundary to analysis_emit (no agent/LLM)`

---

### `[checkpoint:human-verify]` — confirm the #899 contract before wiring surfaces

**Pause here.** Before ANY CLI/workflow surface is wired, show the human:

- the **v1.0 envelope schema** and the `canary-pr-guardian-<ref>.json` filename
  convention (the #899 producer contract — the big decision);
- the **"ingestion available" signal** (`.harness/` exists AND analyses dir
  writable; else fallback) and its `tmp_path` tests;
- that `analysis_emit.py` is deterministic I/O and passes the extended SC-11
  boundary.

**Ask:** "Confirm the envelope schema, the filename convention, and the
availability signal before I wire `--emit-analysis` into the CLI and workflow
(T4–T5)?" Wait for explicit confirmation. If the human wants a different
envelope (e.g. harness-owned keys), a different availability signal, or a
different `--emit-analysis`/`--post-comment` composition, revise T1–T2 and T4
before proceeding.

---

### Task 4: CLI wiring — `--emit-analysis`, ref resolution, emit→fallback→comment

**Depends on:** T2 (and checkpoint clearance) | **Files:**
`agent/guardian/cli.py`, `tests/unit/test_guardian_cli.py`

**Context:** add the flag and compose it with the existing `--post-comment` path
per the ★ composition assumption. Extract the current inline comment-posting
block into a behavior-preserving helper so both the fallback and the explicit
`--post-comment` reuse it. `emit_analysis` is imported **function-locally**
(cli.py is not in the Tier-0 boundary set, but keep the import lazy for
symmetry).

**Outputs (changes to `agent/guardian/cli.py`):**

```python
# new option on pr_check(...)
    emit_analysis_flag: bool = typer.Option(
        False, "--emit-analysis",
        help="Write the finding record to the .harness/analyses/ channel "
             "(harness handoff); falls back to the sticky comment when unavailable.",
    ),
    analyses_dir_opt: Optional[str] = typer.Option(
        None, "--analyses-dir", hidden=True,
        help="Override the analyses dir (tests).",
    ),

# helper: behavior-preserving extraction of the existing post block
def _post_sticky_comment(findings, resolution) -> None:
    from agent.guardian.pr_check import render
    body = render(findings, fmt="comment",
                  tier=resolution.effective, degraded_notice=resolution.degraded_notice)
    ctx = _pr_context_from_env()
    if ctx is None:
        typer.echo("guardian: no PR context in env — printing instead.")
        typer.echo(body)
        return
    from agent.guardian.pr_comment import degradation_annotation, upsert_sticky_comment
    client = _build_client(*ctx)
    res = upsert_sticky_comment(client, body)
    if res.action == "degraded" and res.notice:
        typer.echo(degradation_annotation(res.notice))
        _append_step_summary(res.notice)


def _resolve_analysis_ref() -> str:
    ctx = _pr_context_from_env()
    if ctx is not None:
        return f"pr-{ctx[1]}"
    out = subprocess.run(["git", "rev-parse", "--short", "HEAD"],
                         capture_output=True, text=True, check=False).stdout.strip()
    return out or "local"

# end of pr_check(): replace the post/else + final Exit with —
    exit_code = compute_exit_code(findings, gate=effective_gate)
    comment_posted = False
    if emit_analysis_flag:
        from agent.guardian.analysis_emit import emit_analysis
        analyses_dir = (
            Path(analyses_dir_opt) if analyses_dir_opt
            else _git_toplevel() / ".harness" / "analyses"
        )
        res = emit_analysis(
            findings, analyses_dir=analyses_dir, ref=_resolve_analysis_ref(),
            gate=effective_gate, effective_tier=resolution.effective,
            degraded_notice=resolution.degraded_notice, exit_code=exit_code,
        )
        if res.action == "emitted":
            typer.echo(f"guardian: wrote analysis record → {res.path}")
        else:
            from agent.guardian.pr_comment import degradation_annotation
            typer.echo(degradation_annotation(res.notice))
            _append_step_summary(res.notice)
            typer.echo(res.notice, err=True)
            _post_sticky_comment(findings, resolution)   # SC-10 fallback
            comment_posted = True
    if post_comment and not comment_posted:
        _post_sticky_comment(findings, resolution)
    elif not emit_analysis_flag and not post_comment:
        from agent.guardian.pr_check import render
        typer.echo(render(findings, fmt=fmt,
                          tier=resolution.effective, degraded_notice=resolution.degraded_notice))
    raise typer.Exit(exit_code)
```

> Note: the `pr.enabled is false` early-exit and the tier-degradation echo
> **stay unchanged** above this block. The extraction of `_post_sticky_comment`
> must keep every existing `pr-check` / `--post-comment` test green.

**TDD steps:**

1. Extend `tests/unit/test_guardian_cli.py` (`CliRunner`, monkeypatch
   `_build_client` → `FakeGitHubClient`, monkeypatch env for PR context,
   `tmp_path`):
   - **emit available:**
     `pr-check --diff - --emit-analysis --analyses-dir <tmp/.harness/analyses>`
     (with `tmp/.harness` created) on `DIFF_NEW_UNIT` → exit 0, stdout contains
     "wrote analysis record", the file exists and `json.loads` shows
     `source == "canary-pr-guardian"` and ≥1 finding; **no comment posted**
     (FakeGitHubClient has zero comments).
   - **emit unavailable → fallback comment:** `--emit-analysis` with an
     `--analyses-dir` whose `.harness` parent does NOT exist, PR context in env
     → stdout contains `::warning::` + "falling back", and the
     `FakeGitHubClient` now holds one sticky comment (marker present). Exit code
     respects gate.
   - **compose (both):** `--emit-analysis --post-comment` with an available
     channel + PR context → record file written AND one sticky comment posted.
   - **hard gate exit preserved:** `--emit-analysis --gate hard` on a diff with
     an unaddressed high finding → exit 1 (SC-4 regression) and the record's
     `exitCode == 1`.
   - **regression:** existing `--post-comment`-only and no-flag (local render)
     tests still pass unchanged.
2. Run → fail. Implement the flag, helpers, and the composed block.
3. Run the guardian CLI + emit suites:

   ```bash
   python3 -m pytest tests/unit/test_guardian_cli.py \
     tests/unit/test_guardian_analysis_emit.py -q
   ```

   `ruff check agent tests hooks`. `harness validate`.

4. Commit:
   `feat(guardian): wire --emit-analysis with loud sticky-comment fallback (SC-10)`

### Task 5: workflow `--emit-analysis` + required-check registration (integration)

**Depends on:** T4 | **Files:** `.github/workflows/guardian.yml`,
`tests/unit/test_guardian_workflow.py` | **Category:** integration

**Context:** pass `--emit-analysis` so the record is emitted (with the comment
as the composed/fallback surface while #899 pends), keep the job/check name
stable (`PR Guardian / guardian`), and document registering it as a required
status check. The `gate` stays config-driven (soft default; promoted per-repo).
No exit logic changes — the non-zero hard-gate exit already fails the job.

**Outputs (changes to `.github/workflows/guardian.yml`):**

```yaml
- name: Guardian pr-check
  env:
    GITHUB_TOKEN: ${{ github.token }}
  run: |
    canary guardian pr-check --diff pr.diff --emit-analysis --post-comment

# Required-check (#311, "one gate not two"): under `canary.guardian.pr.gate: hard`
# this job exits non-zero on unaddressed critical/high findings. Register the
# check "PR Guardian / guardian" in branch protection alongside
# harness/validate/enforce. (Repo-admin action; full guide in Phase 6.)
```

**TDD steps:**

1. Extend `tests/unit/test_guardian_workflow.py`:
   - `test_invokes_pr_check_with_emit_analysis`: a run block contains
     `guardian pr-check` and `--emit-analysis`.
   - `test_still_posts_comment_while_899_pending`: the same block still contains
     `--post-comment` (findings visible until harness consumes the record).
   - `test_stable_job_and_workflow_name`: `wf["name"] == "PR Guardian"` and the
     jobs dict contains the `guardian` job id (stable required-check name).
   - Keep the existing agentless/no-extra-secret assertions green.
2. Run → fail. Edit the workflow (add `--emit-analysis`, the doc comment; keep
   `name:`/job id stable).
3. `python3 -m pytest tests/unit/test_guardian_workflow.py -q`.
   `ruff check agent tests hooks`. `harness validate`.
4. Commit:
   `feat(guardian): emit analysis in CI + document hard-gate required check (#311)`

> **`[checkpoint:human-action]` (post-ship, Phase 6-adjacent):** a repo admin
> registers **`PR Guardian / guardian`** as a required status check in branch
> protection once a repo promotes to `gate: hard`. Not a code change — noted
> here, owned by Phase 6's rollout.

---

## Sequencing & Parallelism

- **Critical path:** T1 → T2 → T3 → **checkpoint** → T4 → T5.
- **File contention:** T1 and T2 both edit `agent/guardian/analysis_emit.py` +
  its test (additive layers) → sequence them. T3 owns only the boundary test. T4
  owns `cli.py` + its test. T5 owns the workflow + its test. No two
  concurrently-runnable tasks share a file once the path is respected.
- **Checkpoint gate:** T4–T5 (all surface wiring) must NOT start until the human
  confirms the schema + filename + availability signal after T3.

## Post-Phase Verification (Definition of Done)

```bash
python3 -m pytest \
  tests/unit/test_guardian_analysis_emit.py \
  tests/unit/test_guardian_capability_boundary.py \
  tests/unit/test_guardian_cli.py \
  tests/unit/test_guardian_workflow.py \
  tests/unit/test_guardian_pr_check.py \
  tests/unit/test_guardian_pr_comment.py -q
ruff check agent tests hooks
harness validate
```

All green + **SC-10** traced to passing tests (emit writes a schema-valid
record; unavailable/unwritable channel → loud notice + sticky-comment fallback;
schema round-trips through a stub consumer), **SC-11** holding with
`analysis_emit.py` in `_MODULES`, and **SC-4** unchanged (hard-gate exit
preserved, now surfaced as a required check) ⇒ Phase 5 code complete. The
harness-side `pre-merge-brief` consumer (#899) and the full
disambiguation-matrix/guide (Phase 6) plug onto this producer contract without
further canary changes — a future harness consumer keys on
`source == "canary-pr-guardian"` and reads the documented v1.0 envelope.
