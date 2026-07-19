"""CLI subcommands for `canary guardian`.

Phase 1 only: analyze a commit diff and emit an impact summary.
Phase 2 (draft PR generation) is behind --phase2 flag and not yet implemented.
"""

from __future__ import annotations

import json
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
        filter_skipped,
        filter_test_units,
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
    if not kept:
        typer.echo(
            f"guardian: nothing to verify "
            f"({len(skipped) + len(test_units)} path(s) skipped)."
        )
        raise typer.Exit(0)

    results = resolve_coverage(
        kept, coverage_path=Path(coverage) if coverage else None
    )
    findings = apply_suppressions(build_findings(results))

    if post_comment:
        # The posted body is always `comment` format so it carries the sticky
        # marker for marker-matched upsert (SC-9); `--format` still governs the
        # non-posting local echo below.
        body = render(findings, fmt="comment", tier=config.pr_tier)
        ctx = _pr_context_from_env()
        if ctx is None:
            typer.echo("guardian: no PR context in env — printing instead.")
            typer.echo(body)
        else:
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
    else:
        typer.echo(render(findings, fmt=fmt, tier=config.pr_tier))

    raise typer.Exit(compute_exit_code(findings, gate=effective_gate))


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
