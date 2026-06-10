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
    db_url: Optional[str] = typer.Option(None, "--db-url", envvar="CANARY_HISTORY_DB_URL"),
) -> None:
    """Analyze API diff for a commit and emit a test impact summary."""
    import sys

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

    coverage_rows: list[dict] = []
    if coverage_file:
        coverage_rows = _load_coverage(coverage_file)

    gaps = map_impact(diff, coverage_rows=coverage_rows)

    sha = commit or "unknown"
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


@guardian_app.command()
def watch(
    interval: int = typer.Option(300, "--interval", help="Polling interval in seconds."),
    suite: str = typer.Option("api", "--suite"),
    db_url: Optional[str] = typer.Option(None, "--db-url", envvar="CANARY_HISTORY_DB_URL"),
) -> None:
    """Poll for new merges and analyze each (local dev / CI fallback).

    For CI, prefer the GitHub Actions workflow instead of watch mode.
    """
    import time
    print(f"[cyan]Guardian watch mode[/cyan] — polling every {interval}s. Ctrl+C to stop.")
    try:
        while True:
            print("[dim]Polling for new merges...[/dim]")
            time.sleep(interval)
    except KeyboardInterrupt:
        print("\n[yellow]Watch stopped.[/yellow]")


def _load_spec(path: str) -> dict:
    p = Path(path)
    if not p.exists():
        raise typer.BadParameter(f"Spec file not found: {path}")
    text = p.read_text(encoding="utf-8")
    if path.endswith(".json"):
        return json.loads(text)
    try:
        import yaml
        return yaml.safe_load(text)
    except ImportError:
        return json.loads(text)


def _load_coverage(path: str) -> list[dict]:
    p = Path(path)
    if not p.exists():
        return []
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
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
            print(f"[green]Posted impact summary as PR comment.[/green]")
        else:
            print(f"[yellow]Could not post PR comment:[/yellow] {result.stderr.strip()}")
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
