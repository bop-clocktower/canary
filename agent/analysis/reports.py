"""Markdown report builders for cross-suite analysis.

Pure functions: each builder takes pre-fetched query rows and returns Markdown.
No I/O — the AnalysisEngine handles store queries.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any


# ---------------------------------------------------------------------------
# Flaky report
# ---------------------------------------------------------------------------

def build_flaky_report(
    rows: list[dict],
    window: int,
    min_rate: float,
    limit: int = 20,
) -> str:
    if not rows:
        return f"No tests above {min_rate}% flake rate in the last {window} runs.\n"

    sorted_rows = sorted(rows, key=lambda r: r["flake_rate_pct"], reverse=True)[:limit]
    lines = [
        f"## Fleet-wide Flaky Tests (top {limit}, window: {window} runs, threshold: ≥ {min_rate}%)\n",
        "| Test | Suite | Area | Flake % | Flake/Total |",
        "|------|-------|------|---------|-------------|",
    ]
    for r in sorted_rows:
        rate = r["flake_rate_pct"]
        lines.append(
            f"| {r['test_name']} | {r.get('suite', '')} | {r.get('area') or '—'} "
            f"| {rate}% | {r['flake_count']}/{r['total_runs']} |"
        )
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# Spikes report
# ---------------------------------------------------------------------------

def build_spikes_report(rows: list[dict], delta: float) -> str:
    if not rows:
        return "No run data available for spike detection.\n"

    by_suite: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_suite[r["suite"]].append(r)

    spikes = []
    for suite, suite_rows in by_suite.items():
        suite_rows.sort(key=lambda x: x["timestamp"])
        suite_count = len(suite_rows)
        if suite_count < 4:
            continue
        mid = suite_count // 2
        early = suite_rows[:mid]
        recent = suite_rows[mid:]

        def _fail_rate(rr: list[dict]) -> float:
            total = sum(r["total"] for r in rr if r.get("total", 0) > 0)
            failed = sum(r["failed"] + r.get("flaky", 0) for r in rr)
            return (failed / total * 100) if total > 0 else 0.0

        early_rate = _fail_rate(early)
        recent_rate = _fail_rate(recent)
        increase = recent_rate - early_rate
        if increase >= delta:
            spikes.append({
                "suite": suite,
                "early_fail_rate": round(early_rate, 1),
                "recent_fail_rate": round(recent_rate, 1),
                "increase_pct": round(increase, 1),
                "since": recent[0]["timestamp"][:10],
            })

    if not spikes:
        return f"No spikes detected (threshold: {delta}pp increase in failure rate).\n"

    lines = [
        f"## Failure Spikes (threshold: ≥ {delta}pp increase)\n",
        "| Suite | Early Fail % | Recent Fail % | Increase | Since |",
        "|-------|-------------|--------------|----------|-------|",
    ]
    for s in sorted(spikes, key=lambda x: x["increase_pct"], reverse=True):
        lines.append(
            f"| {s['suite']} | {s['early_fail_rate']}% | {s['recent_fail_rate']}% "
            f"| +{s['increase_pct']}pp | {s['since']} |"
        )
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# Area health report
# ---------------------------------------------------------------------------

def build_area_health_report(rows: list[dict], weeks: int) -> str:
    if not rows:
        return "No area health data available.\n"

    # Group by (area, suite), compute per-week pass rate, find degrading areas
    by_area: dict[tuple, list[dict]] = defaultdict(list)
    for r in rows:
        key = (r["area"], r.get("suite", ""))
        by_area[key].append(r)

    degrading = []
    for (area, suite), area_rows in by_area.items():
        area_rows.sort(key=lambda x: x.get("week", x.get("timestamp", "")))
        rates = [r["pass_rate"] for r in area_rows if r.get("pass_rate") is not None]
        if len(rates) < 2:
            continue
        # Degrading: last week rate is lower than first week rate by ≥ 5pp
        drop = (rates[0] - rates[-1]) * 100
        if drop >= 5:
            degrading.append({
                "area": area,
                "suite": suite,
                "start_rate": round(rates[0] * 100, 1),
                "end_rate": round(rates[-1] * 100, 1),
                "drop_pp": round(drop, 1),
            })

    # Build full area table (all areas), flagging degrading ones
    all_areas = []
    for (area, suite), area_rows in by_area.items():
        area_rows.sort(key=lambda x: x.get("week", x.get("timestamp", "")))
        rates = [r["pass_rate"] for r in area_rows if r.get("pass_rate") is not None]
        if not rates:
            continue
        drop = (rates[0] - rates[-1]) * 100
        all_areas.append({
            "area": area,
            "suite": suite,
            "start_rate": round(rates[0] * 100, 1),
            "end_rate": round(rates[-1] * 100, 1),
            "drop_pp": round(drop, 1),
            "degrading": drop >= 5,
        })

    if not all_areas:
        return "No area health data available.\n"

    lines = [
        f"## Area Health (last {weeks} weeks)\n",
        "| Area | Suite | Start % | Now % | Trend |",
        "|------|-------|---------|-------|-------|",
    ]
    for d in sorted(all_areas, key=lambda x: x["drop_pp"], reverse=True):
        trend = f"↓ {d['drop_pp']}pp" if d["degrading"] else "→ stable"
        lines.append(
            f"| {d['area']} | {d['suite']} | {d['start_rate']}% | {d['end_rate']}% | {trend} |"
        )
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# Common failures report
# ---------------------------------------------------------------------------

def build_common_failures_report(rows: list[dict], min_suites: int) -> str:
    if not rows:
        return "No failure data available.\n"

    # Group by error prefix (first 200 chars) across suites
    by_prefix: dict[str, dict[str, Any]] = {}
    for r in rows:
        err = (r.get("error_text") or "")[:200]
        if not err:
            continue
        if err not in by_prefix:
            by_prefix[err] = {"error_prefix": err, "suites": set(), "tests": [], "category": r.get("failure_category", "other")}
        by_prefix[err]["suites"].add(r["suite"])
        by_prefix[err]["tests"].append(r["test_name"])

    cross_suite = [v for v in by_prefix.values() if len(v["suites"]) >= min_suites]
    if not cross_suite:
        return f"No common failures appearing in ≥ {min_suites} suites.\n"

    lines = [
        f"## Common Failures (appearing in ≥ {min_suites} suites)\n",
    ]
    for entry in sorted(cross_suite, key=lambda x: len(x["suites"]), reverse=True):
        suites_str = ", ".join(sorted(entry["suites"]))
        test_count = len(set(entry["tests"]))
        lines.append(f"### `{entry['error_prefix'][:80]}…`\n")
        lines.append(f"- **Suites:** {suites_str}")
        lines.append(f"- **Category:** {entry['category']}")
        lines.append(f"- **Affected tests:** {test_count}")
        lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Regression candidates report
# ---------------------------------------------------------------------------

def build_regression_candidates_report(rows: list[dict]) -> str:
    if not rows:
        return "No regression candidates detected.\n"

    lines = [
        "## Regression Candidates\n",
        "| Test | Suite | Area | Green Streak | First Failure |",
        "|------|-------|------|-------------|---------------|",
    ]
    for r in rows:
        lines.append(
            f"| {r['test_name']} | {r.get('suite', '')} | {r.get('area') or '—'} "
            f"| {r.get('green_streak', '?')} runs | {r.get('first_failure_commit', '?')[:8]} |"
        )
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# Digest
# ---------------------------------------------------------------------------

def build_digest(
    flaky: list[dict],
    spikes: list[dict],
    area_health: list[dict],
    common_failures: list[dict],
    regression_candidates: list[dict],
    window: int,
    delta: float,
    weeks: int,
    min_suites: int,
) -> str:
    sections = [
        "# Fleet Health Digest\n",
        "## Flaky Tests\n\n" + build_flaky_report(flaky, window=window, min_rate=10.0),
        "## Spikes\n\n" + build_spikes_report(spikes, delta=delta),
        "## Area Health\n\n" + build_area_health_report(area_health, weeks=weeks),
        "## Common Failures\n\n" + build_common_failures_report(common_failures, min_suites=min_suites),
        "## Regression Candidates\n\n" + build_regression_candidates_report(regression_candidates),
    ]
    return "\n---\n".join(sections)
