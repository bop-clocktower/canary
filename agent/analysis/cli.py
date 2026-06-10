"""CLI subcommands for `canary analyze`.

Subapp wired into agent/cli.py as:
  app.add_typer(analyze_app, name="analyze")
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

import typer
from rich import print

analyze_app = typer.Typer(no_args_is_help=True, help="Cross-suite fleet health analysis.")


def _engine(db_url: Optional[str], output_dir: Optional[str]):
    from agent.analysis.engine import AnalysisEngine
    return AnalysisEngine(db_url=db_url)


def _write_artifacts(artifacts: dict[str, str], output: str) -> None:
    out = Path(output)
    out.mkdir(parents=True, exist_ok=True)
    for name, content in artifacts.items():
        (out / name).write_text(content, encoding="utf-8")


@analyze_app.command()
def flaky(
    window: int = typer.Option(30, "--window", "-w"),
    suite: Optional[str] = typer.Option(None, "--suite", "-s"),
    min_rate: float = typer.Option(10.0, "--min-rate"),
    db_url: Optional[str] = typer.Option(None, "--db-url", envvar="CANARY_HISTORY_DB_URL"),
    output_json: bool = typer.Option(False, "--json"),
) -> None:
    """Fleet-wide flake leaderboard."""
    from agent.history.store import make_store
    from agent.analysis.reports import build_flaky_report
    store = make_store(db_url=db_url)
    rows = store.query_flaky(window=window, suite=suite, min_rate=min_rate)
    if output_json:
        print(json.dumps(rows, indent=2))
    else:
        print(build_flaky_report(rows, window=window, min_rate=min_rate))


@analyze_app.command()
def spikes(
    since: Optional[str] = typer.Option(None, "--since", help="ISO date filter, e.g. 2026-06-01"),
    delta: float = typer.Option(20.0, "--delta"),
    db_url: Optional[str] = typer.Option(None, "--db-url", envvar="CANARY_HISTORY_DB_URL"),
    output_json: bool = typer.Option(False, "--json"),
) -> None:
    """Recent failure spikes across suites."""
    from agent.history.store import make_store
    from agent.analysis.reports import build_spikes_report
    store = make_store(db_url=db_url)
    # Collect run rows from all known suites
    from agent.history.local_store import LocalHistoryStore
    rows: list[dict] = []
    if isinstance(store, LocalHistoryStore):
        records = store._read_all()
        for r in records:
            if since and r.get("timestamp", "") < since:
                continue
            rows.append({
                "suite": r.get("suite", ""),
                "timestamp": r.get("timestamp", ""),
                "passed": r.get("passed", 0),
                "failed": r.get("failed", 0),
                "flaky": r.get("flaky", 0),
                "total": r.get("total", 0),
            })
    if output_json:
        print(json.dumps(rows, indent=2))
    else:
        print(build_spikes_report(rows, delta=delta))


@analyze_app.command("area-health")
def area_health(
    weeks: int = typer.Option(4, "--weeks"),
    db_url: Optional[str] = typer.Option(None, "--db-url", envvar="CANARY_HISTORY_DB_URL"),
    output_json: bool = typer.Option(False, "--json"),
) -> None:
    """Area degradation trends over time."""
    from agent.analysis.reports import build_area_health_report
    print(build_area_health_report([], weeks=weeks))


@analyze_app.command("common-failures")
def common_failures(
    since: Optional[str] = typer.Option(None, "--since"),
    min_suites: int = typer.Option(2, "--min-suites"),
    db_url: Optional[str] = typer.Option(None, "--db-url", envvar="CANARY_HISTORY_DB_URL"),
    output_json: bool = typer.Option(False, "--json"),
) -> None:
    """Cross-suite failure fingerprinting."""
    from agent.history.store import make_store
    from agent.history.local_store import LocalHistoryStore
    from agent.analysis.reports import build_common_failures_report
    store = make_store(db_url=db_url)
    rows: list[dict] = []
    if isinstance(store, LocalHistoryStore):
        for record in store._read_all():
            if since and record.get("timestamp", "") < since:
                continue
            for t in record.get("tests", []):
                if t.get("status") in ("failed", "flaky") and t.get("error_text"):
                    rows.append({
                        "test_name": t["test_name"],
                        "suite": record.get("suite", ""),
                        "failure_category": t.get("failure_category", "other"),
                        "error_text": t.get("error_text", ""),
                        "run_count": 1,
                    })
    if output_json:
        print(json.dumps(rows, indent=2))
    else:
        print(build_common_failures_report(rows, min_suites=min_suites))


@analyze_app.command("regression-candidates")
def regression_candidates(
    min_green: int = typer.Option(5, "--min-green"),
    recent_failures: int = typer.Option(3, "--recent-failures"),
    db_url: Optional[str] = typer.Option(None, "--db-url", envvar="CANARY_HISTORY_DB_URL"),
    output_json: bool = typer.Option(False, "--json"),
) -> None:
    """Tests newly and consistently broken after a green streak."""
    from agent.analysis.engine import AnalysisEngine
    engine = AnalysisEngine(db_url=db_url)
    candidates = engine._detect_regressions(suite=None, min_green=min_green, recent_failures=recent_failures)
    from agent.analysis.reports import build_regression_candidates_report
    if output_json:
        print(json.dumps(candidates, indent=2))
    else:
        print(build_regression_candidates_report(candidates))


@analyze_app.command()
def digest(
    window: int = typer.Option(30, "--window"),
    delta: float = typer.Option(20.0, "--delta"),
    weeks: int = typer.Option(4, "--weeks"),
    min_suites: int = typer.Option(2, "--min-suites"),
    suite: Optional[str] = typer.Option(None, "--suite"),
    output: str = typer.Option("test-results/analysis", "--output"),
    output_json: bool = typer.Option(False, "--json"),
    slack: bool = typer.Option(False, "--slack"),
    db_url: Optional[str] = typer.Option(None, "--db-url", envvar="CANARY_HISTORY_DB_URL"),
) -> None:
    """Combined digest of all five report types."""
    from agent.analysis.engine import AnalysisEngine
    engine = AnalysisEngine(db_url=db_url)
    result = engine.run(window=window, delta=delta, weeks=weeks, min_suites=min_suites, suite=suite)
    _write_artifacts(result.artifacts, output)

    if output_json:
        print(json.dumps({
            "flaky_count": len(result.flaky),
            "spike_count": len(result.spikes),
            "regression_count": len(result.regression_candidates),
        }, indent=2))
    elif slack:
        _print_slack(result)
    else:
        print(result.digest_md)
        print(f"\n[dim]Artifacts written to {output}/[/dim]")


def _print_slack(result) -> None:
    flaky_count = len(result.flaky)
    reg_count = len(result.regression_candidates)
    lines = ["*Fleet Health Digest*"]
    lines.append(f"• Flakeys ≥ 10%: {flaky_count}")
    lines.append(f"• Regression candidates: {reg_count}")
    print("\n".join(lines))
