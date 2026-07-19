# Plan: canary-pr-guardian — Phase 2 (PR Surface)

**Date:** 2026-07-19 | **Spec:** `docs/changes/canary-pr-guardian/proposal.md` |
**Tasks:** 7 | **Sitting-sized (≤3 files each)** | **Integration Tier:** medium

> Scope note: **Phase 2 ONLY** — the agentless PR surface built on top of the
> Phase 1 Tier 0 engine (`agent/guardian/coverage.py`,
> `agent/guardian/pr_check.py`, `guardian pr-check` CLI). Phase 1 is **DONE on
> `feat/canary-pr-guardian`** and is NOT re-planned here. Phases 3–6 (pre-commit
> hook, agent orchestrator/`AgentTier`, harness-check integration, docs/ADRs)
> are explicitly out of scope.

## Goal

Deliver **agentless findings on every PR** (goal #1): a stock GitHub Actions
workflow that runs `guardian pr-check` on `pull_request` events and posts a
single **sticky, upsert-by-marker** findings comment — with `skipGlobs`
excluding docs/config-only changes, `--post-comment`/`pr.enabled`/`gate` wired,
and a loud **degradation to `::warning::` annotations** when a fork PR's
read-only token cannot comment. No agent, no secret, no LLM — the comment-poster
is deterministic HTTP behind a unit-testable protocol seam.

## Success Criteria This Phase Verifies

| SC    | Criterion (from spec)                                                                                                            | Delivered by tasks |
| ----- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| SC-1  | On a PR adding untested code, Tier 0 posts a fidelity-labeled comment on stock Actions — no agent, secret, or write token needed | T5, T6 (+ T2–T4)   |
| SC-2  | A docs/config-only diff (matches `skipGlobs`) produces no findings and a "nothing to verify" skip                                | T1, T5             |
| SC-9  | Re-running on the same PR upserts the sticky comment (marker-matched), never stacks duplicates                                   | T3                 |
| SC-11 | The deterministic engine (now incl. `pr_comment.py`) imports no `AgentTier`/LLM/agent module — capability boundary holds         | T7                 |

_Note on SC-11:_ Phase 1's boundary test
(`test_guardian_capability_boundary.py`) already covers `pr_check.py` +
`coverage.py`. Phase 2 adds a third deterministic module, `pr_comment.py`, so T7
**extends** that existing test to the new file — the comment-poster is HTTP, not
an agent (parent brief hard constraint).

_Fork-PR / degraded-permissions clarification (parent brief "SC-9"):_ the spec's
**SC-9 is the sticky upsert** (marker-matched, no duplicate stacking). The
**fork-PR degradation** the brief describes is not a separately-numbered SC; it
traces to **SC-1's "no write token"** clause and **D6's loud-degradation**
contract. It is planned here as a first-class observable truth (OT-4) and
verified by T4/T5, but tracked against SC-1 + D6, not a phantom "SC-9 = fork
path". Flagged for the human in Assumptions.

## Observable Truths (Acceptance Criteria, EARS)

1. **Event-driven (SC-1):** When the workflow runs
   `guardian pr-check --post-comment` on a `pull_request` whose diff adds an
   untested unit, the system shall post exactly one comment carrying the sticky
   marker `<!-- canary-pr-guardian -->` and the fidelity-labeled findings, using
   only the default `GITHUB_TOKEN` — no agent runtime, API secret, or LLM.
2. **Event-driven (SC-9):** When `guardian pr-check --post-comment` runs a
   **second** time on the same PR, the system shall locate the existing comment
   by its marker and **update it in place**, never create a duplicate.
3. **Unwanted (SC-2):** If every changed unit's path matches a configured
   `skipGlobs` entry (e.g. `docs/**`, `**/*.md`), then the system shall produce
   **no findings**, emit a "nothing to verify" skip, and exit 0 — the gate shall
   not fire on skipped paths.
4. **Unwanted (SC-1 / D6):** If the comment API rejects the write (fork PR
   read-only token → HTTP 403), then the system shall **not** crash or fail the
   job; it shall emit a loud `::warning::` Actions annotation + step-summary
   degradation notice and exit per the gate.
5. **State-driven (SC-1):** While `canary.guardian.pr.enabled == false`, the
   system shall skip the PR surface entirely (no diff scoped, no comment posted,
   exit 0).
6. **Ubiquitous (SC-11):** The system shall ensure
   `agent/guardian/pr_comment.py` imports no `AgentTier`, `agent.llm`, or
   LLM-SDK module — the poster is deterministic HTTP behind a protocol seam.

## File Map

- CREATE `agent/guardian/pr_comment.py` — GitHub comment client protocol seam +
  `FakeGitHubClient` + thin real client + `upsert_sticky_comment` + fork
  degradation
- CREATE `.github/workflows/guardian.yml` — PR surface (stock Actions, Tier 0)
- MODIFY `agent/guardian/pr_check.py` — add `filter_skipped(units, skip_globs)`
  (SC-2)
- MODIFY `agent/guardian/cli.py` — add `--post-comment` flag; wire `pr.enabled`,
  `skipGlobs`, env PR-context, degradation annotation into the `pr-check`
  pipeline
- MODIFY `agent/guardian/__init__.py` — export `upsert_sticky_comment`,
  `GitHubClient`, `UpsertResult`
- CREATE `tests/unit/test_guardian_pr_comment.py` — poster seam + upsert +
  degradation TDD
- CREATE `tests/unit/test_guardian_workflow.py` — structural test of
  `guardian.yml`
- MODIFY `tests/unit/test_guardian_pr_check.py` — `filter_skipped` TDD (SC-2)
- MODIFY `tests/unit/test_guardian_cli.py` — `--post-comment`/skip/`pr.enabled`
  CLI TDD
- MODIFY `tests/unit/test_guardian_capability_boundary.py` — extend denylist
  scan to `pr_comment.py` (SC-11)

## Assumptions & Uncertainties (human: scrutinize the ★ ones)

- **★ [ASSUMPTION] Stock-CI baseline fidelity is HEURISTIC, not
  graph-verified.** Verified: `.harness/graph/graph.json` is **gitignored**
  (`git check-ignore` confirms) and **no workflow emits a coverage report**
  (only `python3 -m unittest discover`). So on stock Actions the Phase-1
  resolver falls through report → graph → **heuristic**. This still satisfies
  SC-1 ("fidelity-labeled findings on every PR"); it just labels them
  `heuristic`. The workflow (T6) includes an **optional, commented**
  `harness graph` build step to lift fidelity to `graph-verified` where harness
  is installed, but the baseline guarantee does **not** depend on it. If the
  human wants graph-verified as the CI default, that becomes a follow-up (commit
  the graph or add a required build step).
- **★ [ASSUMPTION] Base-ref diff strategy = three-dot merge-base diff.** The
  workflow checks out with `fetch-depth: 0` (house convention — `release.yml`,
  `refresh-arch-baseline.yml`), `git fetch origin "$BASE"`, then
  `git diff "origin/${BASE}...HEAD"` (three-dot = changes on the PR branch since
  the merge base, matching GitHub's PR semantics). `${BASE} = github.base_ref`.
  Flagged because two-dot vs three-dot changes which lines count as "added".
- **★ [ASSUMPTION] Fork degradation is detected reactively, not predicted.**
  Rather than inspecting `github.event.pull_request.head.repo.fork`, the poster
  **attempts** the write and treats an HTTP 403 / permission error as the
  degradation trigger → `::warning::`. This is host-agnostic and needs no
  event-payload plumbing, but means a same-repo PR with a mis-scoped token
  degrades identically (acceptable — it is still loud).
- **[ASSUMPTION] Real client shells the GitHub REST API via `GITHUB_TOKEN`.**
  The thin real client (`_RestGitHubClient`) uses `urllib.request` against
  `https://api.github.com/repos/{repo}/issues/{pr}/comments` with the
  Actions-provided `GITHUB_TOKEN`. `gh` CLI is an alternative (already used by
  `analyze`), but a stdlib HTTP client keeps the seam dependency-free and the
  fork-403 path explicit. Network code lives ONLY in the real client; **all
  tests use `FakeGitHubClient`** — no live GitHub.
- **[ASSUMPTION] PR number + repo come from Actions env.** `GITHUB_REPOSITORY`
  (`owner/repo`) and the PR number (parsed from `GITHUB_REF`
  `refs/pull/<n>/merge`, with `GITHUB_EVENT_PATH` JSON as fallback).
  Absent/unparseable → `--post-comment` degrades to printing the comment (no
  crash).
- **[DEFERRABLE] `::warning::` vs `::error::` wording and step-summary
  markdown.** Structure is pinned (annotation + `$GITHUB_STEP_SUMMARY` append);
  exact prose finalized in implementation.
- **[DEFERRABLE] `**`-glob matcher precision.** T1 uses a small
  `fnmatch`-plus-`**` translator (`docs/**`, `**/*.md`). If richer
  gitignore-style semantics are needed later, swap in `pathspec` — out of scope
  now.

## Skeleton (produced — 7 tasks; parent house-style match)

1. **Skip predicate** (T1) — `filter_skipped` excludes `skipGlobs` paths. **←
   SC-2 core.**
2. **Comment poster seam** (T2–T4) — protocol + fake + thin real client;
   upsert-by-marker; fork/permission degradation to `::warning::`. All
   network-free under test.
3. **CLI wiring** (T5) — `--post-comment`, `pr.enabled` skip, `skipGlobs`
   applied, env PR-context, degradation annotation. **← SC-1/SC-2 wired
   end-to-end.**
4. **Workflow surface** (T6) — `.github/workflows/guardian.yml` + structural
   test.
5. **Boundary** (T7) — extend SC-11 architecture test to `pr_comment.py`.

_Skeleton approved: proceeding to full tasks per parent directive (7 < 8
threshold; included for house-style parity with the Phase 1 plan)._

## Conventions (apply to every task)

- **TDD, test-first.** Write the test, run it, watch it fail for the intended
  reason, then implement until green. No implementation before a failing test.
- **Test command:** `python3 -m pytest tests/unit/<file> -q`
- **Lint (every task):** `ruff check agent tests`
- **Validate (every task, final step):** `harness validate`
- **Commit (every task):** conventional `feat(guardian): …` /
  `test(guardian): …`. We are on `feat/canary-pr-guardian`; commit per task.
  **No AI co-author trailer.**
- **No agent/LLM imports** in `pr_check.py`, `coverage.py`, or the new
  `pr_comment.py` (SC-11; enforced by T7, respected from T2).
- **No live-network tests.** GitHub interaction is exercised only through
  `FakeGitHubClient`.

---

## Tasks

### Task 1: `skipGlobs` skip predicate — `filter_skipped` (SC-2)

**Depends on:** none | **Files:** `agent/guardian/pr_check.py`,
`tests/unit/test_guardian_pr_check.py`

**Outputs (signatures to implement):**

```python
# agent/guardian/pr_check.py
def _glob_matches(path: str, pattern: str) -> bool: ...
    # Translate a glob to a regex supporting '**' (any depth incl. zero dirs) and
    # '*' (within a single path segment). e.g. 'docs/**' matches 'docs/a/b.md' and
    # 'docs/x.md'; '**/*.md' matches 'a/b/c.md' and 'x.md'.

def filter_skipped(
    units: list[ChangedUnit], skip_globs: list[str]
) -> tuple[list[ChangedUnit], list[ChangedUnit]]:
    # Return (kept, skipped). A unit is skipped iff its .path matches ANY skip glob.
    # Order-preserving. Empty skip_globs → (units, []).
```

**TDD steps:**

1. Write `TestFilterSkipped` in `tests/unit/test_guardian_pr_check.py`:
   - units for `docs/guide.md`, `README.md`, `agent/core/foo.py`; globs
     `["docs/**", "**/*.md"]` → `kept == [foo.py unit]`,
     `skipped == [docs/guide.md, README.md]`.
   - empty globs → `(units, [])`.
   - a nested `docs/a/b/c.md` is skipped by `docs/**`.
2. `python3 -m pytest tests/unit/test_guardian_pr_check.py -q` → fails (no
   `filter_skipped`).
3. Implement `_glob_matches` (glob→regex) + `filter_skipped`.
4. Rerun → passes. `ruff check agent tests`. `harness validate`.
5. Commit: `feat(guardian): filter changed units by skipGlobs (SC-2)`

### Task 2: Comment client seam — protocol + fake + thin real client

**Depends on:** none | **Files:** `agent/guardian/pr_comment.py`,
`tests/unit/test_guardian_pr_comment.py`

**Outputs:**

```python
# agent/guardian/pr_comment.py  — deterministic HTTP; NO agent/LLM import (SC-11)
from __future__ import annotations
from dataclasses import dataclass
from typing import Protocol

STICKY_MARKER = "<!-- canary-pr-guardian -->"   # single source; pr_check reuses same literal

class GitHubClient(Protocol):
    def list_comments(self) -> list[dict]: ...            # [{"id": int, "body": str}, ...]
    def create_comment(self, body: str) -> dict: ...      # {"id": int, "body": str}
    def update_comment(self, comment_id: int, body: str) -> dict: ...

class GitHubPermissionError(RuntimeError):
    """Raised by a client when the token cannot write (fork read-only → HTTP 403)."""

@dataclass
class FakeGitHubClient:
    """In-memory client for unit tests — no network. Seed `comments`; optionally
    set `deny_writes=True` to simulate a fork read-only token (raises on write)."""
    comments: list[dict] = field(default_factory=list)
    deny_writes: bool = False
    def list_comments(self) -> list[dict]: ...
    def create_comment(self, body: str) -> dict: ...      # raises GitHubPermissionError if deny_writes
    def update_comment(self, comment_id: int, body: str) -> dict: ...  # ditto

class _RestGitHubClient:
    """Thin real client (urllib) — network lives ONLY here. Constructed with
    (repo, pr_number, token). 403 → GitHubPermissionError. Not exercised in unit tests."""
    def __init__(self, repo: str, pr_number: int, token: str) -> None: ...
    # list/create/update via https://api.github.com/repos/{repo}/issues/{pr}/comments
```

**TDD steps:**

1. Write `tests/unit/test_guardian_pr_comment.py::TestFakeClient`:
   - `FakeGitHubClient(comments=[...])` — `list_comments` returns seeded rows;
     `create_comment("x")` appends and returns a row with a new `id`;
     `update_comment(id, "y")` mutates the matching row.
   - `FakeGitHubClient(deny_writes=True).create_comment("x")` raises
     `GitHubPermissionError`.
2. Run → fail (module missing). Implement the protocol, fake,
   `GitHubPermissionError`, and the `_RestGitHubClient` skeleton (real HTTP; no
   test asserts against it).
3. Run → pass. Lint. Validate.
4. Commit: `feat(guardian): add GitHub comment client seam with in-memory fake`

### Task 3: `upsert_sticky_comment` — find-by-marker → update/create (SC-9)

**Depends on:** T2 | **Files:** `agent/guardian/pr_comment.py`,
`tests/unit/test_guardian_pr_comment.py`

**Outputs:**

```python
@dataclass
class UpsertResult:
    action: str                 # "created" | "updated" | "degraded"
    comment_id: int | None
    notice: str | None = None   # degradation notice (set only when action == "degraded")

def find_sticky(comments: list[dict], marker: str = STICKY_MARKER) -> dict | None: ...
    # first comment whose body contains the marker, else None.

def upsert_sticky_comment(
    client: GitHubClient, body: str, marker: str = STICKY_MARKER
) -> UpsertResult:
    # 1. existing = find_sticky(client.list_comments(), marker)
    # 2. if existing → client.update_comment(existing["id"], body) → action="updated"
    #    else → client.create_comment(body) → action="created"
    # (degradation handled in T4; this task is the happy upsert only.)
```

**TDD steps:**

1. `TestUpsert`:
   - empty client → `upsert_sticky_comment(fake, body)` → `action == "created"`;
     the fake now holds exactly ONE comment with the marker.
   - re-run with the **same fake** and a new body → `action == "updated"`; still
     exactly ONE marked comment (SC-9: no stacking); its body == new body.
   - `find_sticky` ignores non-marker comments and matches the marker substring.
2. Run → fail. Implement `find_sticky` + `upsert_sticky_comment` (happy path).
3. Run → pass. Lint. Validate.
4. Commit: `feat(guardian): upsert sticky PR comment by marker (SC-9)`

### Task 4: Fork/permission degradation → `::warning::` (SC-1 / D6 loud-degrade)

**Depends on:** T3 | **Files:** `agent/guardian/pr_comment.py`,
`tests/unit/test_guardian_pr_comment.py`

**Outputs:**

```python
# extend upsert_sticky_comment: wrap the write in try/except GitHubPermissionError.
# On GitHubPermissionError → return UpsertResult(
#     action="degraded", comment_id=None,
#     notice="guardian: read-only token (fork PR?) — findings not posted as a comment")
# Never re-raise: the job must not crash (OT-4).

def degradation_annotation(notice: str) -> str: ...
    # Return an Actions annotation line: f"::warning::{notice}"
```

**TDD steps:**

1. `TestDegradation`:
   - `FakeGitHubClient(deny_writes=True)` → `upsert_sticky_comment` returns
     `action == "degraded"`, `comment_id is None`, non-empty `notice`; **no
     exception**.
   - `degradation_annotation("x")` == `"::warning::x"`.
   - a create path AND an update path both degrade when `deny_writes=True` (seed
     one marked comment, deny writes → still `degraded`, not crash).
2. Run → fail. Wrap writes in try/except; add `degradation_annotation`.
3. Run → pass. Lint. Validate.
4. Commit:
   `feat(guardian): degrade to ::warning:: when PR comment token is read-only`

### Task 5: CLI wiring — `--post-comment` + `pr.enabled` + `skipGlobs` (SC-1, SC-2)

**Depends on:** T1, T4 | **Files:** `agent/guardian/cli.py`,
`tests/unit/test_guardian_cli.py`

**Outputs:** extend `@guardian_app.command("pr-check")` with a `--post-comment`
flag and a helper for env PR-context; keep the deterministic pipeline
agent-free.

```python
# agent/guardian/cli.py
def _pr_context_from_env() -> tuple[str, int] | None: ...
    # repo from GITHUB_REPOSITORY ("owner/repo"); pr number from GITHUB_REF
    # ("refs/pull/<n>/merge") with GITHUB_EVENT_PATH JSON fallback. None if unresolved.

# new option on pr_check():
#   post_comment: bool = typer.Option(False, "--post-comment",
#       help="Post/update the sticky PR comment via the GitHub API (CI).")
#
# pipeline changes (after load_guardian_config + warning echo):
#   1. if post_comment and not config.pr_enabled:
#          typer.echo("guardian: pr.enabled is false — skipping PR surface."); raise typer.Exit(0)   # OT-5
#   2. units = scope_diff(read_diff(diff))
#   3. kept, skipped = filter_skipped(units, config.skip_globs)
#      if not kept:
#          typer.echo(f"guardian: nothing to verify ({len(skipped)} path(s) skipped).")   # SC-2
#          raise typer.Exit(0)
#   4. results = resolve_coverage(kept, coverage_path=...); findings = apply_suppressions(build_findings(results))
#   5. body = render(findings, fmt="comment", tier=config.pr_tier)
#   6. if post_comment:
#          ctx = _pr_context_from_env()
#          if ctx is None:
#              typer.echo("guardian: no PR context in env — printing instead."); typer.echo(body)
#          else:
#              from agent.guardian.pr_comment import _RestGitHubClient, upsert_sticky_comment, degradation_annotation
#              client = _build_client(*ctx)   # factory, monkeypatched to FakeGitHubClient in tests
#              res = upsert_sticky_comment(client, body)
#              if res.action == "degraded":
#                  typer.echo(degradation_annotation(res.notice))            # ::warning:: to Actions log
#                  _append_step_summary(res.notice)                          # $GITHUB_STEP_SUMMARY if set
#      else:
#          typer.echo(body)
#   7. raise typer.Exit(compute_exit_code(findings, gate=effective_gate))
```

**TDD steps (all network-free — monkeypatch `_build_client` to return
`FakeGitHubClient`):**

1. `TestPrCheckPost` in `tests/unit/test_guardian_cli.py` (typer `CliRunner`),
   set env `GITHUB_REPOSITORY=o/r`, `GITHUB_REF=refs/pull/7/merge`, monkeypatch
   `agent.guardian.cli._build_client` → `lambda *_: fake`:
   - diff via `--diff -` adding an untested unit + `--post-comment` → exit 0
     (soft), fake holds exactly ONE marked comment (SC-1 post path).
   - **skip:** diff touching only `docs/x.md` with config
     `skipGlobs=["docs/**"]` (write a `tmp` `harness.config.json`, pass
     `--config`) + `--post-comment` → output contains "nothing to verify", NO
     comment created (SC-2).
   - **pr.enabled false:** config `pr.enabled=false` + `--post-comment` →
     "skipping PR surface", exit 0, no comment (OT-5).
   - **degraded:** `FakeGitHubClient(deny_writes=True)` → output contains
     `::warning::`, exit 0, no crash (OT-4).
   - `_pr_context_from_env` returns `("o/r", 7)` for the seeded env; `None` when
     unset.
2. Run → fail. Implement `_pr_context_from_env`, `_build_client`,
   `_append_step_summary`, and the pipeline branches.
3. Run the full guardian CLI + pr_check + pr_comment suites:

   ```bash
   python3 -m pytest tests/unit/test_guardian_cli.py \
     tests/unit/test_guardian_pr_check.py \
     tests/unit/test_guardian_pr_comment.py -q
   ```

   Lint. Validate.

4. Commit:
   `feat(guardian): wire --post-comment, pr.enabled, skipGlobs into pr-check CLI`

### Task 6: PR surface workflow — `.github/workflows/guardian.yml` (SC-1)

**Depends on:** T5 | **Files:** `.github/workflows/guardian.yml`,
`tests/unit/test_guardian_workflow.py`

**Outputs:** a stock-Actions workflow (no agent, no secret beyond
`GITHUB_TOKEN`), matching house conventions (`actions/checkout@v7`,
`fetch-depth: 0`, `actions/setup-python@v6`, `pip install -e .`):

```yaml
name: PR Guardian
on:
  pull_request:
permissions:
  contents: read
  pull-requests: write # commenting; fork PRs get read-only → poster degrades
concurrency:
  group: guardian-${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  guardian:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: actions/setup-python@v6
        with:
          python-version: '3.11'
      - name: Install canary
        run: pip install -e .
      # OPTIONAL (commented): lift fidelity to graph-verified where harness is present.
      #   Baseline is heuristic on stock CI (graph.json is gitignored). See plan Assumptions.
      # - run: npx --yes -p @harness-engineering/cli harness graph
      - name: Compute PR diff
        env:
          BASE: ${{ github.base_ref }}
        run: |
          git fetch --no-tags origin "$BASE"
          git diff "origin/${BASE}...HEAD" > pr.diff
      - name: Guardian pr-check
        env:
          GITHUB_TOKEN: ${{ github.token }}
        run: |
          canary guardian pr-check --diff pr.diff --post-comment
```

**TDD steps (structural, offline — pyyaml 6.0.3 is available):**

1. Write `tests/unit/test_guardian_workflow.py::TestGuardianWorkflow` — load
   `.github/workflows/guardian.yml` with `yaml.safe_load` and assert:
   - triggers on `pull_request` (note: `on` may parse as Python `True` key —
     handle both `wf.get("on")` and `wf.get(True)`).
   - `permissions["pull-requests"] == "write"` and
     `permissions["contents"] == "read"`.
   - `fetch-depth: 0` present on the checkout step.
   - a step run-block contains `canary guardian pr-check` **and**
     `--post-comment`.
   - the diff step uses `git diff` with `origin/` and `...HEAD` (three-dot
     base-ref diff).
   - no secret other than `GITHUB_TOKEN`/`github.token` referenced (assert no
     `secrets.` in the file except an allowlist of none — i.e. `"secrets."`
     absent, proving agentless).
2. Run → fail (file missing). Author `guardian.yml`.
3. Run → pass. Lint (`ruff check agent tests` — workflow not linted by ruff; the
   test guards it). Validate.
4. Commit: `feat(guardian): add stock-CI PR guardian workflow (SC-1)`

### Task 7: Extend capability-boundary test to `pr_comment.py` (SC-11)

**Depends on:** T2 | **Files:**
`tests/unit/test_guardian_capability_boundary.py`

**Outputs:** extend the existing SC-11 architecture test so the denylist scan
also covers the new deterministic module.

```python
# add agent/guardian/pr_comment.py to the set of files whose imports are AST-scanned;
# assert NONE match the denylist: AgentTier, agent.llm, anthropic, openai,
# google.generativeai, *agent*tier* / LLM-client patterns, and the
# analyze_diff / get_impact MCP tool names.
```

**TDD steps:**

1. Add a parametrization/assertion covering `agent/guardian/pr_comment.py`.
   RED-proof per the file's existing convention: temporarily add
   `import anthropic` to `pr_comment.py`, watch the boundary test fail, remove
   it, watch it pass (document in the test).
2. Run → confirm RED-proof then GREEN. Lint. Validate.
3. Commit: `test(guardian): extend Tier 0 boundary to pr_comment.py (SC-11)`

---

## Sequencing & Parallelism

- **Critical path:** T2 → T3 → T4 → **T5** → T6. T1 (skip predicate) and T7
  (boundary) are independent leaves.
- **Parallelizable:** T1 (`pr_check.py`) is independent of the poster chain and
  can run any time before T5. T7 depends only on T2 (the file must exist) and
  can run any time after it. T6 depends on T5 (the `--post-comment` behavior it
  invokes).
- **File-contention note:** T2/T3/T4 all touch `pr_comment.py` +
  `test_guardian_pr_comment.py` → sequence them. T1 owns `pr_check.py`; T5 owns
  `cli.py`; T6 owns `guardian.yml`; T7 owns the boundary test — parallelize
  freely across those four files, sequence within the poster trio.

## Post-Phase Verification (Definition of Done)

```bash
python3 -m pytest tests/unit/test_guardian_pr_check.py \
  tests/unit/test_guardian_pr_comment.py \
  tests/unit/test_guardian_cli.py \
  tests/unit/test_guardian_workflow.py \
  tests/unit/test_guardian_capability_boundary.py -q
ruff check agent tests
harness validate
python3 -m agent.cli guardian pr-check --post-comment --help   # flag discoverable
```

All green + SC-1/SC-2/SC-9/SC-11 each traced to a passing test ⇒ Phase 2 code
complete. Then perform the **live-PR checkpoint** below before Phase 3 wires any
authoring.

---

## FINAL CHECKPOINT (spec hard gate — before Phase 3+)

> **[checkpoint:human-verify]** The agentless PR surface is built and
> unit-green. Per the spec's Implementation Order (the `— checkpoint —` row:
> _"Baseline proven on a real PR, soft gate — human review before wiring any
> authoring"_), **STOP here and prove the baseline on a real PR** before any
> Phase 3+ work begins.
>
> **Evidence to show the human (all four):**
>
> 1. **A real open PR** on `bop-clocktower/canary` where the `PR Guardian`
>    workflow ran green on stock Actions (no agent, no added secret).
> 2. **The sticky comment** posted on that PR, leading with
>    `<!-- canary-pr-guardian -->` and showing fidelity-labeled findings
>    (expected `heuristic` on stock CI per the Assumptions — flag this to the
>    human).
> 3. **Idempotent upsert:** re-run the workflow (push an empty commit or
>    re-trigger) and show the **same single comment updated in place** — no
>    duplicate (SC-9).
> 4. **Soft-gate exit 0:** the workflow job succeeded under `gate: soft`
>    (default) even with open findings — demonstrating the guaranteed
>    non-blocking baseline.
>
> Optionally show the **fork-degradation path** (a fork PR or a read-only-token
> run) surfacing a `::warning::` annotation instead of crashing (OT-4 / SC-1).
>
> **Do NOT proceed** to Phase 3 (pre-commit) or Phase 4 (agent orchestrator /
> `AgentTier`) until the human confirms the soft-gate baseline is trustworthy on
> a real PR. Wait for explicit go-ahead.
