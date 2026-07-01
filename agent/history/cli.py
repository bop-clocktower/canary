"""CLI subcommands for `canary history`.

Subapp wired into agent/cli.py as:
  app.add_typer(history_app, name="history")
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

import typer
from rich import print
from rich.console import Console
from rich.table import Table

from agent.history.store import make_store

history_app = typer.Typer(no_args_is_help=True, help="Query and manage test run history.")
console = Console()


@history_app.command()
def push(
    history_file: str = typer.Argument(
        "test-results/reports/history-v2.jsonl",
        help="Path to local history-v2.jsonl to push to remote store.",
    ),
    db_url: Optional[str] = typer.Option(None, "--db-url", envvar="CANARY_HISTORY_DB_URL"),
    dry_run: bool = typer.Option(False, "--dry-run", help="Show what would be pushed without pushing."),
) -> None:
    """Push the most recent run from a local history file to the remote store."""
    path = Path(history_file)
    if not path.exists():
        print(f"[red]Not found:[/red] {path}")
        raise typer.Exit(1)

    store = make_store(db_url=db_url, ndjson_path=path)

    from agent.history.schema import RunRecord, TestResult
    import dataclasses

    records = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            records.append(json.loads(line))

    if not records:
        print("[yellow]No runs found in history file.[/yellow]")
        raise typer.Exit(0)

    latest = records[-1]
    tests_raw = latest.pop("tests", [])

    run_fields = {f.name for f in dataclasses.fields(RunRecord)}
    run = RunRecord(**{k: v for k, v in latest.items() if k in run_fields})

    result_fields = {f.name for f in dataclasses.fields(TestResult)}
    results = [TestResult(**{k: v for k, v in t.items() if k in result_fields}) for t in tests_raw]

    if dry_run:
        print(f"[cyan]dry-run:[/cyan] would push run [bold]{run.run_id}[/bold] ({len(results)} tests)")
        raise typer.Exit(0)

    store.push_run(run, results)
    print(f"[green]Pushed[/green] run [bold]{run.run_id}[/bold] ({len(results)} tests)")


@history_app.command()
def flaky(
    window: int = typer.Option(30, "--window", "-w", help="Rolling window (number of runs)."),
    suite: Optional[str] = typer.Option(None, "--suite", "-s", help="Filter to a specific suite."),
    min_rate: float = typer.Option(10.0, "--min-rate", help="Minimum flake rate % to show."),
    db_url: Optional[str] = typer.Option(None, "--db-url", envvar="CANARY_HISTORY_DB_URL"),
    output_json: bool = typer.Option(False, "--json"),
) -> None:
    """Show tests ranked by flake rate over the rolling window."""
    store = make_store(db_url=db_url)
    results = store.query_flaky(window=window, suite=suite, min_rate=min_rate)

    if output_json:
        print(json.dumps(results, indent=2))
        return

    if not results:
        print(f"[green]No tests above {min_rate}% flake rate in the last {window} runs.[/green]")
        return

    t = Table(title=f"Flaky Tests (window: {window} runs, threshold: ≥ {min_rate}%)")
    t.add_column("Test", style="cyan", no_wrap=False)
    t.add_column("Suite", style="dim")
    t.add_column("Area", style="dim")
    t.add_column("Flake %", justify="right", style="yellow")
    t.add_column("Flake/Total", justify="right")

    for r in results:
        t.add_row(
            r["test_name"],
            r.get("suite", ""),
            r.get("area") or "—",
            f"{r['flake_rate_pct']}%",
            f"{r['flake_count']}/{r['total_runs']}",
        )
    console.print(t)


@history_app.command()
def timeline(
    test_name: str = typer.Argument(..., help="Exact test name to trace."),
    db_url: Optional[str] = typer.Option(None, "--db-url", envvar="CANARY_HISTORY_DB_URL"),
    output_json: bool = typer.Option(False, "--json"),
) -> None:
    """Show the full run history for a specific test."""
    store = make_store(db_url=db_url)
    rows = store.query_timeline(test_name)

    if output_json:
        print(json.dumps(rows, indent=2))
        return

    if not rows:
        print(f"[yellow]No history found for:[/yellow] {test_name}")
        return

    t = Table(title=f"Timeline: {test_name}")
    t.add_column("Run ID", style="dim")
    t.add_column("Commit", style="dim")
    t.add_column("Timestamp", style="dim")
    t.add_column("Status", justify="center")
    t.add_column("Category", style="dim")

    status_colors = {"passed": "green", "failed": "red", "flaky": "yellow", "skipped": "dim"}
    for row in rows:
        status = row.get("status", "")
        color = status_colors.get(status, "white")
        t.add_row(
            row.get("run_id", ""),
            row.get("commit_sha", "")[:8],
            row.get("timestamp", "")[:19],
            f"[{color}]{status}[/{color}]",
            row.get("failure_category") or "—",
        )
    console.print(t)


@history_app.command()
def summary(
    suite: str = typer.Argument(..., help="Suite name (e.g. api, e2e_ui)."),
    runs: int = typer.Option(10, "--runs", "-n", help="Number of most recent runs to summarize."),
    db_url: Optional[str] = typer.Option(None, "--db-url", envvar="CANARY_HISTORY_DB_URL"),
    output_json: bool = typer.Option(False, "--json"),
) -> None:
    """Summarize recent runs for a suite."""
    store = make_store(db_url=db_url)
    result = store.query_summary(suite=suite, runs=runs)

    if output_json:
        print(json.dumps(result, indent=2))
        return

    total = result.get("total_runs", 0)
    avg = result.get("avg_pass_rate", 0.0)
    color = "green" if avg >= 90 else "yellow" if avg >= 70 else "red"
    print(f"Suite [bold]{suite}[/bold] — last {total} runs — avg pass rate: [{color}]{avg}%[/{color}]")


@history_app.command()
def migrate(
    file: str = typer.Argument(..., help="Path to history.jsonl (v1 format) to migrate."),
    suite: str = typer.Option(..., "--suite", help="Suite name for these records."),
    repo: str = typer.Option(..., "--repo", help="GitHub repo slug (e.g. acme-corp/api-service)."),
    db_url: Optional[str] = typer.Option(None, "--db-url", envvar="CANARY_HISTORY_DB_URL"),
    dry_run: bool = typer.Option(False, "--dry-run"),
) -> None:
    """Migrate a v1 history.jsonl (aggregate-only) into the v2 store.

    V1 entries have no per-test data — they migrate as run-level records only.
    """
    from agent.history.schema import RunRecord, make_run_id
    import time as _time

    path = Path(file)
    if not path.exists():
        print(f"[red]Not found:[/red] {path}")
        raise typer.Exit(1)

    store = make_store(db_url=db_url)
    migrated = skipped = 0

    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue

        commit = entry.get("commit_short", "unknown")
        ts_str = entry.get("timestamp", "")
        # Try to parse ISO timestamp to epoch; fallback to 0
        try:
            from datetime import datetime
            ts = int(datetime.fromisoformat(ts_str.replace("Z", "+00:00")).timestamp())
        except (ValueError, AttributeError):
            ts = 0

        run = RunRecord(
            run_id=make_run_id(suite, commit, ts or int(_time.time())),
            suite=suite,
            repo=repo,
            branch=entry.get("branch", "unknown"),
            commit_sha=commit,
            timestamp=ts_str,
            total=entry.get("run", {}).get("total", 0),
            passed=entry.get("run", {}).get("passed", 0),
            failed=entry.get("run", {}).get("failed", 0),
            flaky=entry.get("run", {}).get("flaky", 0),
            skipped=entry.get("run", {}).get("skipped", 0),
        )

        if dry_run:
            print(f"[cyan]dry-run:[/cyan] {run.run_id}")
            migrated += 1
            continue

        store.push_run(run, [])
        migrated += 1

    print(f"[green]Migrated[/green] {migrated} runs, skipped {skipped}")
