# Plan: canary-pr-guardian — Phase 3 (Pre-commit + toggles)

**Date:** 2026-07-19 | **Spec:** `docs/changes/canary-pr-guardian/proposal.md` |
**Tasks:** 6 | **Sitting-sized (≤3 files each)** | **Integration Tier:** medium

> Scope note: **Phase 3 ONLY** — the local **pre-commit surface**, the full
> **per-surface toggles**, and the **tier-resolution + loud-degradation** seam,
> all **agentless**. Phases 1–2 (Tier 0 engine + PR surface) are **DONE and
> merged to `main`** and are NOT re-planned here. Explicitly **out of scope**:
> the real `AgentTier`/`InSessionAgentTier` and any test **authoring** (Phase
> 4), harness-check/`--emit-analysis` integration (Phase 5), and docs/ADRs
> (Phase 6). The pre-commit hook may _read_ `precommit_author_tests`, but in
> Phase 3 it **authors nothing** — no agent exists, so an authoring request
> degrades loudly like any tier > 0 request.

## Goal

Deliver **Local Tier 0 + full config**: a git **pre-commit hook**
(`hooks/guardian_precommit.py`) that runs the deterministic Tier 0 pipeline on
the **staged** diff (no network, no agent), gated by `precommit_gate`; a shared
**tier-resolution seam** (`agent/guardian/tier.py`) that resolves a _requested_
tier against actually-available capability and emits a **loud** degradation
notice whenever it drops below the request (SC-5); and **independent per-surface
toggles** so `pr.enabled` and `preCommit.enabled` switch on/off separately
(SC-7). The capability probe is a Protocol that deterministically reports "no
agent" in Phase 3 — it imports **no** agent/LLM module (SC-11), and Phase 4
supplies the real probe without changing callers.

## Success Criteria This Phase Verifies

| SC    | Criterion (from spec)                                                                                                                                                                                                         | Delivered by tasks           |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| SC-5  | Opting a tier > 0 with no runtime present runs Tier 0 and emits the degradation notice on **both** the PR findings comment (a `⚠ degraded: tier N unavailable — ran tier 0` line) and the Actions step summary — never silent | T1, T2 (PR), T3 (pre-commit) |
| SC-7  | `pr.enabled: false` skips the PR surface; `preCommit.enabled: false` skips the hook — **independently**                                                                                                                       | T3, T5 (+ Phase-2 PR skip)   |
| SC-11 | The deterministic engine — now incl. `tier.py` and `guardian_precommit.py` — imports no `AgentTier`/LLM/agent module; the capability boundary (D1) holds                                                                      | T6 (respected from T1/T3)    |

_Traceability note (SC-5, D6):_ SC-5 is worded around the **PR** surface (the
comment plus the Actions step summary). Its principle — "any
requested-but-unavailable tier degrades **loudly**, never silently" (D6) —
extends to the **pre-commit** surface, where the loud channel is the hook's
printed text report (there is no Actions step summary at the desk). T3 delivers
the pre-commit half of SC-5; T1/T2 deliver the shared helper + PR half. Flagged
for the human in Assumptions (★ pre-commit loud channel).

## Observable Truths (Acceptance Criteria, EARS)

1. **Unwanted (SC-5 / D6):** If `pr.tier` requests a tier above 0 while no agent
   runtime is available, then the PR surface shall run tier 0 and surface the
   `⚠ degraded: tier N unavailable …` notice on **both** the rendered comment
   footer **and** the Actions `::warning::`/step-summary channel — never a
   silent "tier N" footer with no agent.
2. **Unwanted (SC-5 / D6):** If the pre-commit surface requests authoring
   (`preCommit.authorTests: true` ⇒ tier 2) while no agent runtime is available,
   then it shall run tier 0, author nothing, and print the loud degradation
   notice in its text report.
3. **Event-driven (SC-7 / Tier 0 local):** When the pre-commit hook runs and
   `preCommit.enabled == true`, the system shall scope `git diff --staged`
   through the same deterministic Tier 0 pipeline the PR surface uses (scope →
   skip/test/re-export filters → resolve-coverage → build/suppress findings; see
   Task 3) and exit per `precommit_gate` (soft → 0 always; hard → non-zero on an
   unaddressed critical/high `untested-new-code` finding) — no network, no
   agent.
4. **State-driven (SC-7):** While `preCommit.enabled == false`, the hook shall
   skip entirely (no diff scoped, exit 0); while `pr.enabled == false`, the PR
   surface shall skip — the two toggles are **independent** (either may be on
   while the other is off).
5. **Ubiquitous (SC-11 / D1):** The system shall ensure `agent/guardian/tier.py`
   and `hooks/guardian_precommit.py` import no `AgentTier`, `agent.llm`, or
   LLM-SDK module; the capability probe reports "no agent" deterministically
   **without** importing one, so Phase 4's real probe drops in unchanged.

## File Map

- CREATE `agent/guardian/tier.py` — capability-probe Protocol
  (`AgentCapabilityProbe`), Phase-3 default `NoAgentProbe`, `TierResolution`,
  `resolve_tier` (SC-5 core)
- CREATE `tests/unit/test_guardian_tier.py` — tier-resolution TDD
- CREATE `hooks/guardian_precommit.py` — git pre-commit surface: `staged_diff`,
  `requested_tier`, `run_precommit_check` core callable, `PrecommitOutcome`,
  thin `main`/`run` entrypoint, dedup guard, collision-aware `install`
- CREATE `tests/unit/test_guardian_precommit.py` — pre-commit core + entrypoint
  TDD
- CREATE `tests/unit/test_guardian_toggles.py` — independent per-surface toggle
  matrix (SC-7)
- MODIFY `agent/guardian/cli.py` — resolve `pr_tier` via `resolve_tier`, pass
  `effective`/`degraded_notice` into `render`, and route the tier-degradation to
  the `::warning::`/step-summary channel (SC-5, PR surface)
- MODIFY `tests/unit/test_guardian_cli.py` — tier-degradation TDD on `pr-check`
- MODIFY `tests/unit/test_guardian_capability_boundary.py` — extend the AST
  denylist scan to `tier.py` **and** `hooks/guardian_precommit.py` (SC-11)

## Assumptions & Uncertainties (human: scrutinize the ★ ones)

- **★ [ASSUMPTION] Real git pre-commit wiring = `check-proprietary.py`'s
  `--install` → `.git/hooks/pre-commit`, NOT `.claude-plugin/hooks.json`.**
  Verified: there is **no** `.pre-commit-config.yaml` and **no**
  `core.hooksPath` in this repo. `hooks/check-proprietary.py` is the sole git
  pre-commit precedent — its `install()` writes `.git/hooks/pre-commit` =
  `#!/bin/sh\npython3 <hook> run\n`, and `run()` reads staged files via
  `git diff --cached`. The `.claude-plugin/hooks.json` file wires **Claude-Code
  plugin** events (`PreToolUse`/`PostToolUse`/`PreCompact`) — it has **no**
  git-commit event — so guardian pre-commit is a **git hook**, matching
  check-proprietary, not a plugin hook. (The spec's line "wired via
  `.claude-plugin/hooks.json`" is inconsistent with the plugin event model; the
  parent brief's "git pre-commit hook" governs. Flagged so the human can confirm
  before Phase 4 documents it.)
- **★ [ASSUMPTION] `install()` must CHAIN, not clobber — `.git/hooks/pre-commit`
  is already owned by `check-proprietary.py`.** Both hooks target the same file.
  T4's `install()` is therefore **collision-aware**: if the file exists it
  **appends** a marker-guarded
  `python3 <guardian> run  # canary-guardian-precommit` line (idempotent —
  re-install is a no-op when the marker is present); if absent it writes a fresh
  `#!/bin/sh` + line. It never overwrites check-proprietary's line. If the human
  prefers a single installer that composes both canary git hooks, that is a
  follow-up (a `scripts/install-git-hooks.py`), out of scope now.
- **★ [ASSUMPTION] The `_harness_dedup` guard is inert future-proofing here.**
  The parent brief says "wrap via `_harness_dedup.py` per house pattern".
  `harness_hook_present(js_basename)` only detects a **`.harness/hooks/*.js`**
  counterpart; **no harness `guardian-precommit.js` exists**, so the guard never
  defers in Phase 3 — the hook always runs. It is wired to match the
  quality-gate.py wrapping idiom (guard at the top of `main`) and to defer
  automatically **if** harness ever ships a JS guardian git hook. Note the
  _other_ git hook (`check-proprietary.py`) does **not** use dedup at all; the
  guard is a belt-and-braces addition, not a load-bearing dependency.
- **★ [ASSUMPTION] Pre-commit's loud channel is its printed text report, not an
  Actions step summary.** SC-5's letter names the PR comment + Actions step
  summary; at the desk neither exists, so the pre-commit surface satisfies D6's
  "never silent" by printing the `⚠ degraded …` line via
  `render(fmt="text", degraded_notice=…)`. Tracked against SC-5 + D6 (see
  Traceability note).
- **[ASSUMPTION] `authorTests: true` ⇒ requested tier 2.** Authoring is the
  Tier-2 capability (author + stage). `requested_tier(config)` returns
  `2 if config.precommit_author_tests else 0`. With no agent, tier 2 → 0 loudly.
  `authorTests: false` requests tier 0 → no degradation notice.
- **[ASSUMPTION] The core logic is a pure callable; the git-hook entrypoint is a
  thin shell.** `run_precommit_check(config, diff_text, probe=None)` takes the
  diff text and config **injected**, returns a `PrecommitOutcome`
  (exit_code/report/skipped/degraded_notice), and is unit-tested **directly** —
  no git hook is installed under test. `staged_diff()` (the `git diff --staged`
  seam) and `main()` are exercised separately with a temp repo / monkeypatch.
  Hook-module import in tests follows the repo pattern
  (`sys.path.insert(0, HOOKS_DIR)` then `import guardian_precommit`, per
  `tests/unit/test_hooks.py`).
- **[ASSUMPTION] Pre-commit runs coverage at heuristic/graph fidelity, no report
  path.** `run_precommit_check` calls `resolve_coverage(kept)` with no
  `coverage_path` (local, network-free). Wiring `config.coverage_paths` as a
  local enrichment is a **[DEFERRABLE]** follow-up; the baseline degrades to
  graph/heuristic exactly like the PR surface.
- **[DEFERRABLE] Exact degradation prose.** The canonical string is pinned
  (names the requested tier, stays loud):

  ```text
  ⚠ degraded: tier {requested} unavailable (no agent runtime detected) — ran tier {effective}
  ```

  final wording may be tuned in implementation as long as it names the requested
  tier and stays loud.

## Skeleton (produced — 6 tasks; parent house-style match)

1. **Tier-resolution seam** (T1) — probe Protocol + `NoAgentProbe` +
   `resolve_tier` → `(effective, degraded_notice)`. **← SC-5 core.**
2. **PR-surface wiring** (T2) — `cli.py` resolves `pr_tier`, feeds
   `effective`/`degraded_notice` to `render`, and routes the notice to
   `::warning::`/step-summary. **← SC-5, PR half (fixes the current silent
   tier-N footer).**
3. **Pre-commit core** (T3) — `run_precommit_check` (pure callable): staged
   pipeline + tier resolution + text render + `precommit_gate` exit; honors
   `precommit_enabled`. **← SC-7 (skip) + SC-5 (pre-commit half) + Tier 0
   local.**
4. **Pre-commit entrypoint** (T4) — `staged_diff`, `main`/`run`,
   `_harness_dedup` guard, collision-aware `install`.
5. **Toggle matrix** (T5) — independent `pr.enabled` × `preCommit.enabled`
   (both-on / both-off / mixed). **← SC-7.**
6. **Boundary** (T6) — extend the SC-11 architecture test to `tier.py` +
   `guardian_precommit.py`.

_Skeleton approved: proceeding to full tasks per parent directive (6 < 8
threshold; included for house-style parity with the Phase 1/2 plans)._

## Conventions (apply to every task)

- **TDD, test-first.** Write the test, run it, watch it fail for the intended
  reason, then implement until green. No implementation before a failing test.
- **Test command:** `python3 -m pytest tests/unit/<file> -q`
- **Lint (every task):** `ruff check agent tests hooks`
- **Validate (every task, final step):** `harness validate`
- **Commit (every task):** conventional `feat(guardian): …` /
  `test(guardian): …`. We are on `feat/canary-guardian-precommit`; commit per
  task. **No AI co-author trailer.**
- **No agent/LLM imports** in `tier.py`, `guardian_precommit.py` (or any Tier 0
  module) — SC-11; enforced by T6, respected from T1.
- **No network, no git-hook install under test.** The pre-commit core is a pure
  callable; `staged_diff`/`install` are tested against a temp repo or
  monkeypatch.

---

## Tasks

### Task 1: Tier-resolution seam — probe Protocol + `resolve_tier` (SC-5 core)

**Depends on:** none | **Files:** `agent/guardian/tier.py`,
`tests/unit/test_guardian_tier.py`

**Outputs (signatures to implement):**

```python
# agent/guardian/tier.py — deterministic; NO agent/LLM import (SC-11).
from __future__ import annotations
from dataclasses import dataclass
from typing import Protocol

def _degradation_notice(requested: int, effective: int) -> str:
    # Canonical loud notice (D6 / SC-5). Never emit a tier>0 result without this
    # when the requested tier is unavailable.
    return (
        f"⚠ degraded: tier {requested} unavailable "
        f"(no agent runtime detected) — ran tier {effective}"
    )

class AgentCapabilityProbe(Protocol):
    """Reports the highest tier an agent runtime can serve. Phase 3 has none.
    Phase 4 supplies a real probe (e.g. InSessionAgentProbe) implementing this
    same Protocol — resolve_tier's callers do not change."""
    def available_tier(self) -> int: ...

@dataclass(frozen=True)
class NoAgentProbe:
    """Deterministic Phase-3 probe: no agent runtime, so tier 0 is the ceiling.
    Imports no agent/LLM module (SC-11)."""
    def available_tier(self) -> int:
        return 0

@dataclass(frozen=True)
class TierResolution:
    requested: int
    effective: int
    degraded_notice: str | None

def resolve_tier(
    requested: int, probe: AgentCapabilityProbe | None = None
) -> TierResolution:
    # probe defaults to NoAgentProbe(); effective = min(requested, available);
    # attach the loud notice iff effective < requested (else None).
    ...
```

**TDD steps:**

1. Write `tests/unit/test_guardian_tier.py::TestResolveTier`:
   - `resolve_tier(0)` → `effective == 0`, `degraded_notice is None`.
   - `resolve_tier(1)` → `effective == 0`, notice contains `"tier 1"` and
     `"degraded"` (loud). `resolve_tier(2)` → `effective == 0`, notice contains
     `"tier 2"`.
   - `NoAgentProbe().available_tier() == 0`.
   - **future-proofing:** a local stub
     `class _Probe2: available_tier=lambda self: 2` →
     `resolve_tier(2, _Probe2())` → `effective == 2`, `degraded_notice is None`
     (proves the seam does not hardcode degradation).
2. `python3 -m pytest tests/unit/test_guardian_tier.py -q` → fails (no module).
3. Implement `tier.py` per signatures.
4. Rerun → passes. `ruff check agent tests hooks`. `harness validate`.
5. Commit:
   `feat(guardian): add tier-resolution seam with loud degradation (SC-5)`

### Task 2: Wire tier resolution into the PR surface CLI (SC-5, PR half)

**Depends on:** T1 | **Files:** `agent/guardian/cli.py`,
`tests/unit/test_guardian_cli.py`

**Context:** `pr-check` today calls
`render(findings, fmt="comment", tier=config.pr_tier)` **without** resolving the
tier or passing a `degraded_notice` — so `pr.tier: 1` currently prints a silent
`tier 1` footer with no agent. That is exactly the silent under-delivery SC-5
forbids. This task resolves the tier and routes the notice to **both** channels
(`render` footer + `::warning::`/step-summary). `render(..., degraded_notice=…)`
already exists (Phase 1); `degradation_annotation`/`_append_step_summary`
already exist (Phase 2).

**Outputs:** in `pr_check()`, after `findings` are built and before rendering:

```python
# agent/guardian/cli.py
from agent.guardian.tier import resolve_tier          # top-of-function import
...
resolution = resolve_tier(config.pr_tier)              # Phase 3: NoAgentProbe → tier>0 degrades to 0

# SC-5: route the tier-degradation to the loud Actions channel regardless of
# --post-comment (independent of the fork-403 path already handled below).
if resolution.degraded_notice:
    from agent.guardian.pr_comment import degradation_annotation
    typer.echo(degradation_annotation(resolution.degraded_notice))   # ::warning:: line
    _append_step_summary(resolution.degraded_notice)                 # $GITHUB_STEP_SUMMARY

# then pass effective tier + notice into every render call:
#   post-comment path: body = render(findings, "comment",
#       tier=resolution.effective, degraded_notice=resolution.degraded_notice)
#   local path:        render(findings, fmt=fmt,
#       tier=resolution.effective, degraded_notice=resolution.degraded_notice)
```

**TDD steps (typer `CliRunner`, all network-free):**

1. Extend `tests/unit/test_guardian_cli.py::TestPrCheckTierDegradation`:
   - config `pr.tier: 1` (write a tmp `harness.config.json`, pass `--config`),
     diff via `--diff -` adding an untested unit, **no** `--post-comment`
     (`--format text`) → output contains `::warning::` **and** `tier 1` **and**
     `degraded`; rendered footer shows `tier 0` (effective) with the
     `⚠ degraded` notice; exit 0 (soft).
   - `pr.tier: 0` → output contains **no** `::warning::` from the tier path and
     **no** `degraded` (regression guard against false-positive degradation).
   - `pr.tier: 2` + `--post-comment` (monkeypatch `_build_client` →
     `FakeGitHubClient` as in Phase 2, seed env
     `GITHUB_REPOSITORY`/`GITHUB_REF`, set `GITHUB_STEP_SUMMARY` to a tmp file)
     → the posted comment body contains `⚠ degraded: tier 2`, and the tmp
     step-summary file receives the notice (SC-5 "both channels").
2. Run → fail. Implement the resolution + routing.
3. Run the guardian CLI + pr_check + pr_comment + tier suites:

   ```bash
   python3 -m pytest tests/unit/test_guardian_cli.py \
     tests/unit/test_guardian_tier.py \
     tests/unit/test_guardian_pr_comment.py -q
   ```

   `ruff check agent tests hooks`. `harness validate`.

4. Commit: `feat(guardian): resolve pr.tier and surface loud degradation (SC-5)`

### Task 3: Pre-commit core — `run_precommit_check` (SC-7 skip, SC-5)

**Depends on:** T1 | **Files:** `hooks/guardian_precommit.py`,
`tests/unit/test_guardian_precommit.py`

**Outputs (pure callable — no git hook installed, no network):**

```python
#!/usr/bin/env python3
"""Git pre-commit surface for canary-pr-guardian — deterministic Tier 0 on the
STAGED diff. No network, no agent, no LLM (SC-11). The core logic is a pure
callable (run_precommit_check); the git-hook entrypoint (T4) is a thin shell."""
from __future__ import annotations
import subprocess
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

def requested_tier(config) -> int:
    # Authoring is the Tier-2 capability; no agent in Phase 3 → it degrades to 0.
    return 2 if config.precommit_author_tests else 0

@dataclass
class PrecommitOutcome:
    exit_code: int
    report: str
    skipped: bool
    degraded_notice: str | None

def run_precommit_check(config, diff_text: str, probe=None) -> PrecommitOutcome:
    # Intra-guardian imports only (SC-11 — no agent/LLM):
    from agent.guardian.coverage import resolve_coverage
    from agent.guardian.pr_check import (
        apply_suppressions, build_findings, compute_exit_code, filter_skipped,
        filter_test_units, find_reexport_only, render, scope_diff,
    )
    from agent.guardian.tier import resolve_tier

    # SC-7: preCommit.enabled == false → skip entirely, exit 0.
    if not config.precommit_enabled:
        return PrecommitOutcome(0, "guardian: preCommit.enabled is false — skipping.", True, None)

    # SC-5 (pre-commit half): loud degradation when authoring (tier 2) is asked
    # for but no agent exists.
    resolution = resolve_tier(requested_tier(config), probe)

    # Mirror the PR pipeline exactly (cli.pr_check):
    units = scope_diff(diff_text)
    kept, skipped = filter_skipped(units, config.skip_globs)
    kept, test_units = filter_test_units(kept)
    reexport = find_reexport_only(diff_text)
    barrels = [u for u in kept if u.path in reexport]
    kept = [u for u in kept if u.path not in reexport]
    if not kept:
        n = len(skipped) + len(test_units) + len(barrels)
        return PrecommitOutcome(0, f"guardian: nothing to verify ({n} path(s) skipped).",
                                False, resolution.degraded_notice)

    results = resolve_coverage(kept)                         # heuristic/graph fidelity, no report
    findings = apply_suppressions(build_findings(results))
    report = render(findings, fmt="text",
                    tier=resolution.effective, degraded_notice=resolution.degraded_notice)
    exit_code = compute_exit_code(findings, gate=config.precommit_gate)
    return PrecommitOutcome(exit_code, report, False, resolution.degraded_notice)
```

**TDD steps (import the hook module per the repo pattern:
`sys.path.insert(0, str(Path(__file__).parents[2] / "hooks"))` then
`import guardian_precommit`; build `GuardianConfig` directly, inject
`diff_text`):**

1. Write `tests/unit/test_guardian_precommit.py::TestRunPrecommitCheck`. Use a
   small helper diff string adding an untested `.py` unit (reuse the shape from
   `test_guardian_pr_check.py`), and `GuardianConfig` from
   `agent.guardian.pr_check`:
   - `precommit_enabled=False` → `outcome.skipped is True`, `exit_code == 0`,
     report mentions "skipping" (SC-7 skip). **No pipeline run.**
   - `precommit_enabled=True, precommit_author_tests=True` (tier 2, no probe →
     `NoAgentProbe`) + a diff adding an untested unit →
     `outcome.degraded_notice` contains `"tier 2"`; `outcome.report` contains
     the `⚠ degraded` line (SC-5 pre-commit half) **and** the untested finding.
   - `precommit_enabled=True, precommit_author_tests=False, precommit_gate="soft"`
     → `exit_code == 0` even with findings; `degraded_notice is None`.
   - `precommit_gate="hard"` with a critical/high untested finding →
     `exit_code == 1`; the same diff with a `// canary:allow-untested`
     suppression (or `authorTests` off + soft) → `exit_code == 0` (reuses
     `compute_exit_code`/`apply_suppressions`).
   - a docs-only diff (`docs/x.md`) with default `skip_globs` → report contains
     "nothing to verify", `exit_code == 0`.
2. Run → fail (module missing). Implement `guardian_precommit.py` (this task
   adds `requested_tier`, `PrecommitOutcome`, `run_precommit_check` only;
   `staged_diff`
   - entrypoint land in T4).
3. Run → pass. `ruff check agent tests hooks`. `harness validate`.
4. Commit:
   `feat(guardian): add pre-commit Tier 0 core with loud degradation (SC-5, SC-7)`

### Task 4: Pre-commit entrypoint — `main`, dedup guard, install

**Depends on:** T3 | **Files:** `hooks/guardian_precommit.py`,
`tests/unit/test_guardian_precommit.py`

**Outputs:** the thin git-hook shell around T3's core.

```python
# hooks/guardian_precommit.py (append)
import sys
from _harness_dedup import harness_hook_present   # house dedup guard (see Assumptions)

GUARDIAN_MARKER = "# canary-guardian-precommit"

def staged_diff() -> str:
    """`git diff --staged` text ('' when nothing staged). The only git call."""
    return subprocess.run(
        ["git", "diff", "--staged"], cwd=REPO_ROOT,
        capture_output=True, text=True, check=False,
    ).stdout

def install(repo_root: Path | None = None) -> None:
    """Collision-aware: chains after check-proprietary.py's line rather than
    clobbering .git/hooks/pre-commit. Idempotent via GUARDIAN_MARKER."""
    root = repo_root or REPO_ROOT
    hook = root / ".git" / "hooks" / "pre-commit"
    line = f'python3 "{Path(__file__).resolve()}" run  {GUARDIAN_MARKER}\n'
    if hook.is_file():
        existing = hook.read_text(encoding="utf-8")
        if GUARDIAN_MARKER in existing:
            print("guardian pre-commit already installed."); return
        hook.write_text(existing.rstrip("\n") + "\n" + line, encoding="utf-8")
    else:
        hook.parent.mkdir(parents=True, exist_ok=True)
        hook.write_text("#!/bin/sh\n" + line, encoding="utf-8")
    hook.chmod(0o755)
    print(f"Installed guardian pre-commit hook → {hook}")

def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if "--install" in args:
        install(); return 0
    # Dedup: defer to a harness JS guardian counterpart if one is ever wired
    # (none exists in Phase 3, so this never fires — see plan Assumptions).
    if harness_hook_present("guardian-precommit.js"):
        return 0
    from agent.guardian.pr_check import load_guardian_config
    config, warning = load_guardian_config(REPO_ROOT / "harness.config.json")
    if warning:
        print(f"WARNING: {warning}", file=sys.stderr)
    outcome = run_precommit_check(config, staged_diff())
    if outcome.report:
        print(outcome.report)
    return outcome.exit_code

if __name__ == "__main__":
    sys.exit(main())
```

**TDD steps:**

1. Extend `tests/unit/test_guardian_precommit.py`:
   - `TestInstall`: point `install(repo_root=tmp)` at a temp dir with a
     pre-seeded `.git/hooks/pre-commit` (check-proprietary content) → after
     install, the file **still contains** the check-proprietary line **and** the
     `GUARDIAN_MARKER` line; a **second** `install` is a no-op (idempotent,
     marker present). With **no** existing hook → file created with `#!/bin/sh`
     - guardian line, mode `0o755`.
   - `TestStagedDiff`: `staged_diff()` shells `git diff --staged` — assert it
     returns a `str` (monkeypatch `subprocess.run` to a stub returning a known
     stdout; no real git needed).
   - `TestMain`: monkeypatch `guardian_precommit.staged_diff` → a fixture diff
     and `load_guardian_config` (or point `REPO_ROOT` config) so
     `precommit_enabled=True` → `main([])` returns the expected exit code and
     prints the report; `harness_hook_present` monkeypatched → when it returns
     `True`, `main([])` returns 0 without running the pipeline (dedup defers).
2. Run → fail. Implement `staged_diff`, `install`, `main`.
3. Run → pass. `ruff check agent tests hooks`. `harness validate`.
4. Commit:
   `feat(guardian): add pre-commit git-hook entrypoint + collision-aware install`

### Task 5: Independent per-surface toggle matrix (SC-7)

**Depends on:** T3 | **Files:** `tests/unit/test_guardian_toggles.py`

**Context:** the two surfaces already read independent config fields
(`pr_enabled` wired in `cli.pr_check` from Phase 2; `precommit_enabled` wired in
`run_precommit_check` from T3). This task **proves the independence** across the
full 2×2 with a dedicated behavioral matrix — no new source, test-only.

**Outputs:** `tests/unit/test_guardian_toggles.py::TestSurfaceToggles` — for
each config, load it via `load_guardian_config` (tmp `harness.config.json`) and
assert the **behavior** of each surface:

- PR surface: run `pr-check --post-comment` via `CliRunner` (monkeypatch
  `_build_client` → `FakeGitHubClient`, seed PR env) — `pr.enabled: false` →
  output "skipping PR surface", **no** comment created; `pr.enabled: true` →
  pipeline runs (comment created or "nothing to verify").
- Pre-commit surface: call `run_precommit_check(config, diff_text)` —
  `preCommit.enabled: false` → `outcome.skipped is True`; `true` → not skipped.

Matrix (assert each cell independently):

| #   | `pr.enabled` | `preCommit.enabled` | PR runs? | pre-commit runs? |
| --- | ------------ | ------------------- | -------- | ---------------- |
| 1   | true         | true                | yes      | yes              |
| 2   | false        | false               | no       | no               |
| 3   | true         | false               | yes      | no               |
| 4   | false        | true                | no       | yes              |

**TDD steps:**

1. Write the matrix (parametrized over the 4 rows). Run → fail (file missing).
2. Implement the assertions using the existing surfaces (no source change).
3. Run → pass. `ruff check agent tests hooks`. `harness validate`.
4. Commit: `test(guardian): verify pr/preCommit toggles are independent (SC-7)`

### Task 6: Extend the SC-11 boundary test to the new modules

**Depends on:** T1, T3 | **Files:**
`tests/unit/test_guardian_capability_boundary.py`

**Outputs:** add both new modules to the `_MODULES` AST-scan list so the
denylist (`agenttier`, `agent.llm`, `anthropic`, `openai`,
`google.generativeai`, any `*agent*tier*`) and the `analyze_diff`/`get_impact`
MCP-ref check also cover them.

```python
_MODULES = [
    _REPO_ROOT / "agent" / "guardian" / "pr_check.py",
    _REPO_ROOT / "agent" / "guardian" / "coverage.py",
    _REPO_ROOT / "agent" / "guardian" / "pr_comment.py",
    _REPO_ROOT / "agent" / "guardian" / "tier.py",              # + Phase 3
    _REPO_ROOT / "hooks" / "guardian_precommit.py",             # + Phase 3
]
```

**TDD steps:**

1. Add the two paths to `_MODULES`. **RED proof** (per the file's convention):
   temporarily add `import anthropic` to the top of
   `hooks/guardian_precommit.py`, run the file, watch
   `test_no_forbidden_imports[guardian_precommit.py]` fail; remove it, watch it
   go green. Repeat once for `tier.py`. Document the cycle in the module
   docstring alongside the existing note.
2. Run → confirm RED-proof then GREEN:
   `python3 -m pytest tests/unit/test_guardian_capability_boundary.py -q`.
   `ruff check agent tests hooks`. `harness validate`.
3. Commit:
   `test(guardian): extend Tier 0 boundary to tier.py + guardian_precommit.py (SC-11)`

---

## Sequencing & Parallelism

- **Critical path:** T1 → T3 → (T4, T5, T6). T2 depends only on T1.
- **Independent leaves after their dep lands:** T2 (owns `cli.py` +
  `test_guardian_cli.py`) runs any time after T1. T5 (owns
  `test_guardian_toggles.py`) and T6 (owns the boundary test) run after their
  deps; neither touches source.
- **File-contention note:** T3 and T4 both touch `hooks/guardian_precommit.py` +
  `tests/unit/test_guardian_precommit.py` → sequence them (T3 before T4). T1
  owns `tier.py`; T2 owns `cli.py`; T5 and T6 own their own test files —
  parallelize freely across those once dependencies are satisfied.

## Post-Phase Verification (Definition of Done)

```bash
python3 -m pytest tests/unit/test_guardian_tier.py \
  tests/unit/test_guardian_precommit.py \
  tests/unit/test_guardian_toggles.py \
  tests/unit/test_guardian_cli.py \
  tests/unit/test_guardian_pr_comment.py \
  tests/unit/test_guardian_capability_boundary.py -q
ruff check agent tests hooks
harness validate
python3 hooks/guardian_precommit.py --install   # chains onto .git/hooks/pre-commit (idempotent)
```

All green + SC-5 / SC-7 / SC-11 each traced to a passing test ⇒ Phase 3 code
complete. Phase 4 (agent orchestrator / real `AgentTier` probe + test authoring)
plugs the real probe into `resolve_tier` and swaps the pre-commit surface from
"degrade loudly" to "author, stage, and block once" (D4) — **without** changing
the Tier 0 core, the seam, or the toggles built here.
