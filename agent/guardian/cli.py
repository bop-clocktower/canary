"""CLI subcommands for `canary guardian`.

Phase 1 only: analyze a commit diff and emit an impact summary.
Phase 2 (draft PR generation) is behind --phase2 flag and not yet implemented.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Optional

import typer
from rich import print

guardian_app = typer.Typer(no_args_is_help=True, help="Watch API changes and analyze test impact.")


@guardian_app.command()
def analyze(
    commit: Optional[str] = typer.Argument(None, help="Commit SHA to analyze."),
    pr: Optional[str] = typer.Option(None, "--pr", help="GitHub PR URL to analyze."),
    spec_before: Optional[str] = typer.Option(None, "--spec-before", help="Path to OpenAPI spec before the change."),
    spec_after: Optional[str] = typer.Option(None, "--spec-after", help="Path to OpenAPI spec after the change."),
    suite: str = typer.Option("api", "--suite", "-s", help="Test suite name."),
    coverage_file: Optional[str] = typer.Option(None, "--coverage", help="Path to coverage-report.json."),
    dry_run: bool = typer.Option(False, "--dry-run", help="Print summary to stdout only."),
    output_json: bool = typer.Option(False, "--json"),
    emit_diff: Optional[str] = typer.Option(
        None, "--emit-diff", help="Write a machine-readable api-delta.json to PATH."
    ),
    db_url: Optional[str] = typer.Option(None, "--db-url", envvar="CANARY_HISTORY_DB_URL"),
) -> None:
    """Analyze API diff for a commit and emit a test impact summary."""

    if not spec_before or not spec_after:
        print("[yellow]Tip:[/yellow] pass --spec-before and --spec-after to diff two OpenAPI specs.")
        print("Without spec files, guardian reports no diff (use for testing the pipeline).")
        before_spec: dict = {}
        after_spec: dict = {}
    else:
        before_spec = _load_spec(spec_before)
        after_spec = _load_spec(spec_after)

    from agent.guardian.diff_extractor import extract_api_diff
    from agent.guardian.impact_mapper import map_impact
    from agent.guardian.summary_emitter import build_summary

    diff = extract_api_diff(before_spec, after_spec)

    sha = commit or "unknown"

    if emit_diff:
        from datetime import datetime, timezone

        from agent.guardian.delta_emitter import build_api_delta, write_api_delta

        generated = datetime.now(timezone.utc).isoformat()
        write_api_delta(build_api_delta(diff, sha=sha, suite=suite, generated=generated), emit_diff)
        print(f"[green]Wrote api-delta.json[/green] → {emit_diff}")

    coverage_rows: list[dict] = []
    if coverage_file:
        coverage_rows = _load_coverage(coverage_file)

    gaps = map_impact(diff, coverage_rows=coverage_rows)

    summary = build_summary(gaps=gaps, commit_sha=sha, suite=suite)

    if output_json:
        print(json.dumps({
            "commit": sha,
            "suite": suite,
            "added": len(diff.added),
            "removed": len(diff.removed),
            "changed": len(diff.changed),
            "gaps": [
                {
                    "path": g.path,
                    "method": g.method,
                    "change_type": g.change_type.value,
                    "severity": g.severity.value,
                    "affected_tests": g.affected_tests,
                }
                for g in gaps
            ],
        }, indent=2))
    else:
        print(summary)

    if not dry_run and not output_json:
        _try_post_pr_comment(summary, pr_url=pr)


def _pr_context_from_env() -> "Optional[tuple[str, int]]":
    """Resolve ``(repo, pr_number)`` from GitHub Actions env, else ``None``.

    ``repo`` comes from ``GITHUB_REPOSITORY`` (``owner/repo``). The PR number is
    parsed from ``GITHUB_REF`` (``refs/pull/<n>/merge``); when that is not a PR
    ref, it falls back to the ``pull_request.number`` field of the event JSON at
    ``GITHUB_EVENT_PATH``. Returns ``None`` if either piece cannot be resolved
    (``--post-comment`` then degrades to printing the body — no crash).
    """
    import os
    import re

    repo = os.environ.get("GITHUB_REPOSITORY")
    if not repo or "/" not in repo:
        return None

    ref = os.environ.get("GITHUB_REF", "")
    match = re.match(r"refs/pull/(\d+)/", ref)
    if match:
        return repo, int(match.group(1))

    event_path = os.environ.get("GITHUB_EVENT_PATH")
    if event_path:
        try:
            with open(event_path, encoding="utf-8") as handle:
                event = json.load(handle)
            number = event.get("pull_request", {}).get("number")
            if isinstance(number, int):
                return repo, number
        except (OSError, json.JSONDecodeError, AttributeError):
            return None
    return None


def _build_client(repo: str, pr_number: int):
    """Factory for the real GitHub comment client (monkeypatched in tests).

    Network lives entirely in ``_RestGitHubClient``; unit tests replace this
    factory with one returning a ``FakeGitHubClient``.
    """
    import os

    from agent.guardian.pr_comment import _RestGitHubClient

    token = os.environ.get("GITHUB_TOKEN", "")
    return _RestGitHubClient(repo, pr_number, token)


def _append_step_summary(notice: str) -> None:
    """Append ``notice`` to the ``$GITHUB_STEP_SUMMARY`` file when set (no-op otherwise)."""
    import os

    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not summary_path:
        return
    try:
        with open(summary_path, "a", encoding="utf-8") as handle:
            handle.write(f"\n> {notice}\n")
    except OSError:
        pass


def _post_sticky_comment(findings, resolution) -> None:
    """Upsert the Phase-2 sticky PR comment (behavior-preserving extraction).

    The posted body is always ``comment`` format so it carries the sticky marker
    for marker-matched upsert (SC-9). When no PR context is resolvable from env,
    it prints the body instead of crashing; a read-only-token degradation is
    surfaced LOUDLY (``::warning::`` + step-summary). Reused by both the explicit
    ``--post-comment`` path and the SC-10 emit fallback.
    """
    from agent.guardian.pr_check import render

    body = render(
        findings,
        fmt="comment",
        tier=resolution.effective,
        degraded_notice=resolution.degraded_notice,
    )
    ctx = _pr_context_from_env()
    if ctx is None:
        typer.echo("guardian: no PR context in env — printing instead.")
        typer.echo(body)
        return
    from agent.guardian.pr_comment import (
        degradation_annotation,
        upsert_sticky_comment,
    )

    client = _build_client(*ctx)
    res = upsert_sticky_comment(client, body)
    if res.action == "degraded" and res.notice:
        # OT-4 / SC-1+D6: loud `::warning::` + step-summary, exit per gate.
        typer.echo(degradation_annotation(res.notice))
        _append_step_summary(res.notice)


def _resolve_analysis_ref() -> str:
    """Resolve the analyses record ``<ref>``: PR number (``pr-<n>``) from CI env,
    else the short HEAD sha, else ``"local"``.

    Reuses :func:`_pr_context_from_env` for the CI signal; network-free (only
    shells local ``git``). The final sanitization to ``[A-Za-z0-9._-]`` lives in
    ``analysis_emit.analysis_filename`` (a blank/garbage ref → ``local``).
    """
    ctx = _pr_context_from_env()
    if ctx is not None:
        return f"pr-{ctx[1]}"
    # Mirror `_git_toplevel`: a missing `git` binary raises OSError
    # (FileNotFoundError). Wrap so the emit path fails safe to "local" instead of
    # crashing pr-check and bypassing the fallback + computed exit code.
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True,
            text=True,
            check=False,
        ).stdout.strip()
    except OSError:
        return "local"
    return out or "local"


@guardian_app.command("pr-check")
def pr_check(
    diff: Optional[str] = typer.Option(
        None, "--diff", help="Diff file, '-' for stdin, or omit to use `git diff`."
    ),
    coverage: Optional[str] = typer.Option(
        None, "--coverage", help="Coverage report path (lcov/json)."
    ),
    fmt: str = typer.Option("comment", "--format", help="comment|json|text"),
    config_path: str = typer.Option("harness.config.json", "--config"),
    gate: Optional[str] = typer.Option(
        None, "--gate", help="Override config gate: soft|hard"
    ),
    post_comment: bool = typer.Option(
        False,
        "--post-comment",
        help="Post/update the sticky PR comment via the GitHub API (CI).",
    ),
    emit_analysis_flag: bool = typer.Option(
        False,
        "--emit-analysis",
        help="Write the finding record to the .harness/analyses/ channel "
        "(harness handoff, #899); falls back LOUDLY to the sticky comment "
        "when the channel is unavailable.",
    ),
    analyses_dir_opt: Optional[str] = typer.Option(
        None,
        "--analyses-dir",
        hidden=True,
        help="Override the analyses dir (tests).",
    ),
) -> None:
    """Tier 0 deterministic PR guardian: scope a diff, resolve diff-coverage at
    the highest available fidelity, render findings, and gate the exit code.

    Agent-free (SC-11): imports no LLM/agent module.
    """
    from agent.guardian.coverage import resolve_coverage
    from agent.guardian.pr_check import (
        apply_suppressions,
        build_findings,
        compute_exit_code,
        effective_graph_depth,
        filter_skipped,
        filter_test_units,
        find_reexport_only,
        load_guardian_config,
        read_diff,
        render,
        scope_diff,
    )

    config, warning = load_guardian_config(Path(config_path))
    if warning is not None:
        # SC-8: surface the malformed-config warning loudly, never silently.
        typer.echo(f"WARNING: {warning}", err=True)

    # OT-5: while pr.enabled == false, `--post-comment` skips the PR surface
    # entirely (no diff scoped, no comment posted, exit 0).
    if post_comment and not config.pr_enabled:
        typer.echo("guardian: pr.enabled is false — skipping PR surface.")
        raise typer.Exit(0)

    effective_gate = gate or config.pr_gate

    diff_text = read_diff(diff)
    units = scope_diff(diff_text)

    # SC-2: drop docs/config-only units matching skipGlobs.
    kept, skipped = filter_skipped(units, config.skip_globs)
    # FIX A: drop test-path units — a test does not itself need a test.
    kept, test_units = filter_test_units(kept)
    # FIX 2: drop pure re-export/barrel files (index.ts, __init__.py) — a file
    # that only forwards other modules' symbols carries no logic to test.
    reexport_paths = find_reexport_only(diff_text)
    barrel_units = [u for u in kept if u.path in reexport_paths]
    kept = [u for u in kept if u.path not in reexport_paths]
    if not kept:
        typer.echo(
            f"guardian: nothing to verify "
            f"({len(skipped) + len(test_units) + len(barrel_units)} path(s) skipped)."
        )
        raise typer.Exit(0)

    results = resolve_coverage(
        kept,
        coverage_path=Path(coverage) if coverage else None,
        # #320: under a hard gate the graph tier requires a DIRECT test→source
        # edge (depth 1); soft stays unbounded. An explicit config value wins.
        graph_max_depth=effective_graph_depth(config, effective_gate),
    )
    findings = apply_suppressions(build_findings(results))

    # SC-5 (PR half): resolve the requested tier against actual capability. In
    # Phase 3 no agent runtime exists (NoAgentProbe), so any `pr.tier > 0` drops
    # to tier 0 with a LOUD degradation notice — fixing the prior silent `tier N`
    # footer that rendered a requested tier no agent could ever serve.
    from agent.guardian.tier import resolve_tier

    resolution = resolve_tier(config.pr_tier)
    if resolution.degraded_notice:
        # Route the tier-degradation to the loud Actions channel regardless of
        # `--post-comment` (independent of the fork-403 path handled below).
        from agent.guardian.pr_comment import degradation_annotation

        typer.echo(degradation_annotation(resolution.degraded_notice))
        _append_step_summary(resolution.degraded_notice)

    # Compute the gate result once, up front: the emitted record carries it
    # (`exitCode`) so a consumer knows pass/fail without recompute, and it is the
    # process exit at the end (SC-4 — emit never changes the exit logic).
    exit_code = compute_exit_code(findings, gate=effective_gate)

    comment_posted = False
    if emit_analysis_flag:
        # SC-10 producer half: write ONE record to the analyses channel. On an
        # unavailable channel `emit_analysis` returns a LOUD notice and we fall
        # back to the sticky comment — the record is never silently dropped.
        from agent.guardian.analysis_emit import emit_analysis

        analyses_dir = (
            Path(analyses_dir_opt)
            if analyses_dir_opt
            else _git_toplevel() / ".harness" / "analyses"
        )
        res = emit_analysis(
            findings,
            analyses_dir=analyses_dir,
            ref=_resolve_analysis_ref(),
            gate=effective_gate,
            effective_tier=resolution.effective,
            degraded_notice=resolution.degraded_notice,
            exit_code=exit_code,
        )
        if res.action == "emitted":
            typer.echo(f"guardian: wrote analysis record → {res.path}")
        else:
            # LOUD fallback: `::warning::` + step-summary + stderr, then the
            # Phase-2 sticky comment so findings stay visible (SC-10 fallback).
            from agent.guardian.pr_comment import degradation_annotation

            typer.echo(degradation_annotation(res.notice))
            _append_step_summary(res.notice)
            typer.echo(res.notice, err=True)
            _post_sticky_comment(findings, resolution)
            comment_posted = True

    if post_comment and not comment_posted:
        # Explicit `--post-comment` (the CI combo, or emit-less Phase-2 path):
        # post/upsert unless the SC-10 fallback already posted this run.
        _post_sticky_comment(findings, resolution)
    elif not emit_analysis_flag and not post_comment:
        # Local, non-posting default: render to stdout in `--format`.
        typer.echo(
            render(
                findings,
                fmt=fmt,
                tier=resolution.effective,
                degraded_notice=resolution.degraded_notice,
            )
        )

    raise typer.Exit(exit_code)


def _build_gaps(
    diff_text: str,
    config,
    coverage_path: Optional[Path],
    graph_max_depth: int | None = None,
):
    """Build Tier-0 ``untested-new-code`` findings from ``diff_text`` using the
    SAME pipeline as ``pr-check`` (scope → skip/test/re-export filters → resolve
    coverage → build/suppress findings). Agent-free (SC-11).

    ``graph_max_depth`` bounds the graph tier's reverse-BFS (#320); callers pass
    the gate-derived depth so author-plan mirrors the pre-commit surface."""
    from agent.guardian.coverage import resolve_coverage
    from agent.guardian.pr_check import (
        apply_suppressions,
        build_findings,
        filter_skipped,
        filter_test_units,
        find_reexport_only,
        scope_diff,
    )

    units = scope_diff(diff_text)
    kept, _skipped = filter_skipped(units, config.skip_globs)
    kept, _test_units = filter_test_units(kept)
    reexport_paths = find_reexport_only(diff_text)
    kept = [u for u in kept if u.path not in reexport_paths]
    if not kept:
        return []
    results = resolve_coverage(
        kept, coverage_path=coverage_path, graph_max_depth=graph_max_depth
    )
    return apply_suppressions(build_findings(results))


def _intent_dict(intent) -> dict:
    """Serialize a ``GeneratedTest`` intent for the SKILL (JSON-safe)."""
    return {
        "path": intent.gap.path,
        "unit": intent.gap.unit,
        "target_path": intent.target_path,
        "requirement": intent.requirement,
        "status": intent.status,
        "written_path": intent.written_path,
        "skip_reason": intent.skip_reason,
    }


@guardian_app.command("author-plan")
def author_plan(
    diff: Optional[str] = typer.Option(
        None, "--diff", help="Diff file, '-' for stdin, or omit to use `git diff`."
    ),
    coverage: Optional[str] = typer.Option(
        None, "--coverage", help="Coverage report path (lcov/json)."
    ),
    config_path: str = typer.Option("harness.config.json", "--config"),
    output_json: bool = typer.Option(True, "--json"),
) -> None:
    """Emit the at-desk authoring plan (intents + block decision) for the SKILL to
    fulfil in-session. NOT run by CI.

    Builds gaps via the SAME Tier-0 pipeline as ``pr-check``, resolves the tier
    with :class:`InSessionAgentProbe`, applies the four safety guards, and prints
    ``{"intents": [...], "block": {...}}``. Authors NOTHING itself (Option A): the
    default ``RecordingInvoker`` records planned intents and the SKILL fulfils
    them. ``agent_tier`` is imported LAZILY so the Tier-0 ``pr-check`` command
    stays agent-free at import (SC-11).
    """
    from agent.guardian.agent_tier import (
        AuthoringContext,
        InSessionAgentProbe,
        InSessionAgentTier,
        decide_block,
    )
    from agent.guardian.pr_check import (
        effective_graph_depth,
        load_guardian_config,
        read_diff,
    )
    from agent.guardian.tier import resolve_tier

    config, warning = load_guardian_config(Path(config_path))
    if warning is not None:
        typer.echo(f"WARNING: {warning}", err=True)

    diff_text = read_diff(diff)
    gaps = _build_gaps(
        diff_text,
        config,
        Path(coverage) if coverage else None,
        # #320: author-plan is the pre-commit authoring surface — use the same
        # gate-derived graph depth the pre-commit hook computes (preCommit.gate).
        graph_max_depth=effective_graph_depth(config, config.precommit_gate),
    )

    requested = 2 if config.precommit_author_tests else 0
    effective = resolve_tier(requested, InSessionAgentProbe()).effective

    # FIX 6: resolve the repo root from the git top-level (not Path.cwd()), so the
    # collision check and sentinel lookup stay root-relative when author-plan runs
    # from a subdirectory. Falls back to cwd when not in a git repo.
    repo_root = _git_toplevel()
    ctx = AuthoringContext(
        author_tests_optin=config.precommit_author_tests,
        effective_tier=effective,
        is_fork=_is_fork_context(),
        repo_root=repo_root,
        authored_sentinel_present=_authored_sentinel_path(repo_root).is_file(),
    )
    results = InSessionAgentTier().author_tests(gaps, ctx)
    payload = {
        "intents": [_intent_dict(r) for r in results],
        "block": decide_block(results).__dict__,
    }
    typer.echo(json.dumps(payload, indent=2))


_AUTHORED_SENTINEL_NAME = "canary-guardian-authored"


def _git_toplevel() -> Path:
    """Resolve the repository root via ``git rev-parse --show-toplevel``.

    Falls back to :func:`Path.cwd` when not inside a git repo (FIX 6) — so the
    collision check and sentinel lookup stay root-relative even when the command
    is run from a subdirectory. Network-free; only shells local ``git``.
    """
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            check=False,
        )
        if out.returncode == 0 and out.stdout.strip():
            return Path(out.stdout.strip())
    except OSError:
        pass
    return Path.cwd()


def _git_dir(root: Path) -> Path:
    """Resolve the real git dir for ``root`` via ``git rev-parse --git-dir``.

    Handles ``.git``-as-a-file (worktrees/submodules point at the real gitdir)
    instead of assuming ``root/".git"`` is a directory (FIX 7). Relative results
    are resolved against ``root``; falls back to ``root/".git"`` when ``git`` is
    unavailable or ``root`` is not a repo.
    """
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--git-dir"],
            cwd=root,
            capture_output=True,
            text=True,
            check=False,
        )
        if out.returncode == 0 and out.stdout.strip():
            resolved = Path(out.stdout.strip())
            return resolved if resolved.is_absolute() else (root / resolved)
    except OSError:
        pass
    return root / ".git"


def _authored_sentinel_path(root: Path) -> Path:
    """Absolute path to the guardian's authored-tests sentinel under ``root``."""
    return _git_dir(root) / _AUTHORED_SENTINEL_NAME


@guardian_app.command("mark-authored")
def mark_authored(
    path: list[str] = typer.Option(
        [],
        "--path",
        help="An authored test path (repeatable). Recorded one per line.",
    ),
) -> None:
    """Write the guardian loop-guard sentinel with the authored test paths.

    The DETERMINISTIC producer half of the D4 loop-guard (a): after the SKILL
    authors + ``git add``s the guardian's tests, it calls this so the Tier-0
    pre-commit hook lets the review re-commit through exactly once — SCOPED to
    these recorded paths (:func:`hooks.guardian_precommit.authored_recommit_passthrough`).
    Writes ONLY the sentinel (no test authoring); resolves the location via the
    real git dir so worktrees/submodules work.
    """
    root = _git_toplevel()
    sentinel = _authored_sentinel_path(root)
    sentinel.parent.mkdir(parents=True, exist_ok=True)
    body = "".join(f"{p}\n" for p in path)
    sentinel.write_text(body, encoding="utf-8")
    typer.echo(
        f"guardian: recorded {len(path)} authored path(s) → {sentinel}"
    )


def _is_fork_context() -> bool:
    """At-desk fork signal (guard b), FAIL-CLOSED on ambiguity.

    Only two safe sentinels mean "not a fork": ``CANARY_GUARDIAN_IS_FORK`` UNSET,
    or exactly ``"0"`` (after strip) — the common at-desk default. ANY other
    non-empty value (``"1"``, ``"true"``, ``"yes"``, whitespace-wrapped, or
    garbage) is treated as a fork, so authoring is SKIPPED rather than fail-open
    writing to a fork/untrusted checkout. The SKILL exports this on a fork
    checkout so the guard actually arms. Deterministic and network-free — the CI
    fork/403 path is a separate NON-GOAL."""
    import os

    raw = os.environ.get("CANARY_GUARDIAN_IS_FORK")
    if raw is None:
        return False  # unset → the common at-desk default: not a fork
    return raw.strip() != "0"  # only "0" is the other safe sentinel; else fork


@guardian_app.command()
def watch(
    interval_secs: int = typer.Option(300, "--interval", help="Polling interval in seconds."),
    suite: str = typer.Option("api", "--suite"),
    db_url: Optional[str] = typer.Option(None, "--db-url", envvar="CANARY_HISTORY_DB_URL"),
) -> None:
    """Poll for new merges and analyze each (local dev / CI fallback).

    For CI, prefer the GitHub Actions workflow instead of watch mode.
    """
    import time
    print(f"[cyan]Guardian watch mode[/cyan] — polling every {interval_secs}s. Ctrl+C to stop.")
    try:
        while True:
            print("[dim]Polling for new merges...[/dim]")
            time.sleep(interval_secs)
    except KeyboardInterrupt:
        print("\n[yellow]Watch stopped.[/yellow]")


def _load_spec(path: str) -> dict:
    spec_path = Path(path)
    if not spec_path.exists():
        raise typer.BadParameter(f"Spec file not found: {path}")
    text = spec_path.read_text(encoding="utf-8")
    if path.endswith(".json"):
        return json.loads(text)
    try:
        import yaml
        return yaml.safe_load(text)
    except ImportError:
        return json.loads(text)


def _load_coverage(path: str) -> list[dict]:
    coverage_path = Path(path)
    if not coverage_path.exists():
        return []
    try:
        data = json.loads(coverage_path.read_text(encoding="utf-8"))
        return data.get("endpoints", []) if isinstance(data, dict) else []
    except (json.JSONDecodeError, OSError):
        return []


def _try_post_pr_comment(summary: str, pr_url: Optional[str]) -> None:
    if not pr_url:
        return
    try:
        import subprocess
        result = subprocess.run(
            ["gh", "pr", "comment", pr_url, "--body", summary],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode == 0:
            print("[green]Posted impact summary as PR comment.[/green]")
        else:
            print(f"[yellow]Could not post PR comment:[/yellow] {result.stderr.strip()}")
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
