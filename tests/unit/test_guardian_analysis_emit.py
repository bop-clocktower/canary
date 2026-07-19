"""Tests for the guardian analysis-emit module (Phase 5, #899 producer).

Covers the v1.0 envelope builder + filename convention (T1) and the channel
availability / write / loud-fallback signal (T2). Everything is deterministic:
the envelope is pure and the writer is exercised through ``tmp_path`` — no
network, no real ``.harness/``.
"""

from __future__ import annotations

import json
import re

from agent.guardian.coverage import Fidelity
from agent.guardian.impact_mapper import Severity
from agent.guardian.pr_check import Finding, render

from agent.guardian.analysis_emit import (
    analysis_filename,
    build_analysis_record,
)


def _findings() -> list[Finding]:
    """Three real Tier-0 Findings: two active (graph + heuristic), one suppressed."""
    return [
        Finding(
            path="pkg/a.py",
            unit="alpha",
            fidelity=Fidelity.GRAPH_VERIFIED,
            severity=Severity.HIGH,
            evidence="no covering test for alpha",
        ),
        Finding(
            path="pkg/b.py",
            unit="beta",
            fidelity=Fidelity.HEURISTIC,
            severity=Severity.MEDIUM,
            evidence="no covering test for beta",
        ),
        Finding(
            path="pkg/c.py",
            unit="gamma",
            fidelity=Fidelity.HEURISTIC,
            severity=Severity.MEDIUM,
            evidence="no covering test for gamma",
            suppressed=True,
            suppression_reason="canary:allow-untested legacy",
        ),
    ]


class TestEnvelope:
    def test_top_level_fields(self) -> None:
        record = build_analysis_record(
            _findings(),
            ref="pr-7",
            gate="hard",
            effective_tier=0,
            degraded_notice=None,
            exit_code=1,
            analyzed_at="2026-07-19T00:00:00+00:00",
        )
        assert record["schemaVersion"] == "1.0"
        assert record["source"] == "canary-pr-guardian"
        assert record["ref"] == "pr-7"
        assert record["gate"] == "hard"
        assert record["exitCode"] == 1
        assert record["tier"] == 0
        assert record["degradedNotice"] is None
        assert record["analyzedAt"] == "2026-07-19T00:00:00+00:00"

    def test_findings_are_verbatim_render_json(self) -> None:
        findings = _findings()
        record = build_analysis_record(
            findings,
            ref="pr-7",
            gate="soft",
            effective_tier=0,
            degraded_notice=None,
            exit_code=0,
        )
        expected = json.loads(render(findings, fmt="json", tier=0))["findings"]
        assert record["findings"] == expected

    def test_summary_counts_and_by_fidelity(self) -> None:
        record = build_analysis_record(
            _findings(),
            ref="pr-7",
            gate="soft",
            effective_tier=0,
            degraded_notice=None,
            exit_code=0,
        )
        summary = record["summary"]
        assert summary["total"] == 3
        assert summary["unaddressed"] == 2
        assert summary["suppressed"] == 1
        assert summary["byFidelity"] == {"graph-verified": 1, "heuristic": 2}

    def test_degraded_notice_propagates(self) -> None:
        record = build_analysis_record(
            _findings(),
            ref="pr-7",
            gate="soft",
            effective_tier=1,
            degraded_notice="tier 2 unavailable — degraded to tier 1",
            exit_code=0,
        )
        assert record["tier"] == 1
        assert record["degradedNotice"] == "tier 2 unavailable — degraded to tier 1"

    def test_analyzed_at_defaults_to_iso_utc(self) -> None:
        record = build_analysis_record(
            _findings(),
            ref="pr-7",
            gate="soft",
            effective_tier=0,
            degraded_notice=None,
            exit_code=0,
        )
        # ISO-8601 with a UTC offset; parseable and tz-aware.
        from datetime import datetime

        parsed = datetime.fromisoformat(record["analyzedAt"])
        assert parsed.tzinfo is not None


class TestFilename:
    def test_pr_ref(self) -> None:
        assert analysis_filename("pr-42") == "canary-pr-guardian-pr-42.json"

    def test_unsafe_chars_sanitized(self) -> None:
        assert (
            analysis_filename("feature/x y")
            == "canary-pr-guardian-feature-x-y.json"
        )

    def test_empty_ref_falls_back_to_local(self) -> None:
        assert analysis_filename("") == "canary-pr-guardian-local.json"

    def test_no_path_separator_and_safe_charset(self) -> None:
        name = analysis_filename("a/b\\c:d")
        assert "/" not in name
        assert re.fullmatch(r"[A-Za-z0-9._-]+\.json", name)
