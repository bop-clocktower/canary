"""Tests for the guardian analysis-emit module (Phase 5, #899 producer).

Covers the v1.0 envelope builder + filename convention (T1) and the channel
availability / write / loud-fallback signal (T2). Everything is deterministic:
the envelope is pure and the writer is exercised through ``tmp_path`` — no
network, no real ``.harness/``.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from agent.guardian.coverage import Fidelity
from agent.guardian.impact_mapper import Severity
from agent.guardian.pr_check import Finding, render

from agent.guardian.analysis_emit import (
    analysis_filename,
    build_analysis_record,
    channel_available,
    emit_analysis,
)


def _write_denied(path: Path) -> bool:
    """True iff ``chmod(0o555)`` actually denies writes here (not run as root)."""
    path.mkdir(parents=True, exist_ok=True)
    path.chmod(0o555)
    try:
        probe = path / ".probe"
        probe.write_text("x", encoding="utf-8")
    except OSError:
        return True
    else:
        probe.unlink()
        return False
    finally:
        path.chmod(0o755)


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


class TestChannelAvailability:
    def test_absent_harness_home_is_unavailable(self, tmp_path: Path) -> None:
        analyses_dir = tmp_path / ".harness" / "analyses"
        assert channel_available(analyses_dir) is False

    def test_present_harness_home_is_available(self, tmp_path: Path) -> None:
        (tmp_path / ".harness").mkdir()
        analyses_dir = tmp_path / ".harness" / "analyses"
        assert channel_available(analyses_dir) is True


class TestEmitWrite:
    def test_writes_prefixed_record_when_available(self, tmp_path: Path) -> None:
        (tmp_path / ".harness").mkdir()
        analyses_dir = tmp_path / ".harness" / "analyses"
        res = emit_analysis(
            _findings(),
            analyses_dir=analyses_dir,
            ref="pr-3",
            gate="soft",
            effective_tier=0,
            degraded_notice=None,
            exit_code=0,
        )
        assert res.action == "emitted"
        assert res.notice is None
        expected = analyses_dir / "canary-pr-guardian-pr-3.json"
        assert Path(res.path) == expected
        assert expected.is_file()


class TestAtomicWrite:
    """FIX 1: the record write must be atomic — no torn/partial file for the
    harness consumer (``AnalysisArchive.list()`` re-throws ONE bad record's
    parse error, breaking ALL). Write to a same-dir temp then ``os.replace``."""

    def test_no_torn_file_and_no_leftover_temp(self, tmp_path: Path) -> None:
        (tmp_path / ".harness").mkdir()
        analyses_dir = tmp_path / ".harness" / "analyses"
        res = emit_analysis(
            _findings(),
            analyses_dir=analyses_dir,
            ref="pr-3",
            gate="soft",
            effective_tier=0,
            degraded_notice=None,
            exit_code=0,
        )
        assert res.action == "emitted"
        target = analyses_dir / "canary-pr-guardian-pr-3.json"
        # (a) the final file parses as complete JSON.
        record = json.loads(target.read_text(encoding="utf-8"))
        assert record["source"] == "canary-pr-guardian"
        # (b) the final record is the ONLY file in the dir — no leftover temp.
        assert [p.name for p in analyses_dir.iterdir()] == [target.name]

    def test_uses_os_replace_from_temp_to_target(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Spy on ``os.replace``: the writer renames a *different* temp path in the
        SAME dir onto the final target (atomic rename on one filesystem)."""
        import os as _os

        import agent.guardian.analysis_emit as emit_mod

        (tmp_path / ".harness").mkdir()
        analyses_dir = tmp_path / ".harness" / "analyses"
        target = analyses_dir / "canary-pr-guardian-pr-3.json"
        calls: list[tuple[str, str]] = []
        real_replace = _os.replace

        def _spy(src, dst):
            calls.append((str(src), str(dst)))
            return real_replace(src, dst)

        monkeypatch.setattr(emit_mod.os, "replace", _spy)
        res = emit_analysis(
            _findings(),
            analyses_dir=analyses_dir,
            ref="pr-3",
            gate="soft",
            effective_tier=0,
            degraded_notice=None,
            exit_code=0,
        )
        assert res.action == "emitted"
        assert len(calls) == 1
        src, dst = calls[0]
        assert Path(dst) == target
        assert src != str(target)  # a distinct temp path was renamed
        assert Path(src).parent == analyses_dir  # same-dir temp (atomic rename)

    def test_temp_cleaned_up_when_replace_fails(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """When ``os.replace`` raises, degrade LOUDLY (OSError contract) AND leave
        no leftover temp file behind."""
        import agent.guardian.analysis_emit as emit_mod

        (tmp_path / ".harness").mkdir()
        analyses_dir = tmp_path / ".harness" / "analyses"

        def _boom(src, dst):
            raise OSError("simulated rename failure")

        monkeypatch.setattr(emit_mod.os, "replace", _boom)
        res = emit_analysis(
            _findings(),
            analyses_dir=analyses_dir,
            ref="pr-3",
            gate="soft",
            effective_tier=0,
            degraded_notice=None,
            exit_code=0,
        )
        assert res.action == "unavailable"
        assert res.path is None
        assert "sticky comment" in res.notice
        # No target and no leftover temp file remain.
        assert list(analyses_dir.iterdir()) == []


class TestRoundTrip:
    def test_stub_consumer_reads_documented_fields(self, tmp_path: Path) -> None:
        (tmp_path / ".harness").mkdir()
        analyses_dir = tmp_path / ".harness" / "analyses"
        findings = _findings()
        res = emit_analysis(
            findings,
            analyses_dir=analyses_dir,
            ref="pr-3",
            gate="soft",
            effective_tier=0,
            degraded_notice=None,
            exit_code=0,
        )
        # A future harness consumer just json.loads and reads every field.
        record = json.loads(Path(res.path).read_text(encoding="utf-8"))
        assert record["schemaVersion"] == "1.0"
        assert record["source"] == "canary-pr-guardian"
        assert record["ref"] == "pr-3"
        assert record["gate"] == "soft"
        assert record["exitCode"] == 0
        assert "summary" in record
        assert "analyzedAt" in record
        assert record["findings"] == json.loads(
            render(findings, fmt="json", tier=0)
        )["findings"]


class TestEmitFallback:
    def test_absent_channel_returns_loud_notice_and_writes_nothing(
        self, tmp_path: Path
    ) -> None:
        # No tmp/.harness → channel unavailable.
        analyses_dir = tmp_path / ".harness" / "analyses"
        res = emit_analysis(
            _findings(),
            analyses_dir=analyses_dir,
            ref="pr-3",
            gate="soft",
            effective_tier=0,
            degraded_notice=None,
            exit_code=0,
        )
        assert res.action == "unavailable"
        assert res.path is None
        assert "unavailable" in res.notice
        assert "sticky comment" in res.notice
        # Nothing written anywhere under tmp_path.
        assert not any(p.is_file() for p in tmp_path.rglob("*"))

    def test_write_error_returns_loud_notice(self, tmp_path: Path) -> None:
        harness_home = tmp_path / ".harness"
        if not _write_denied(harness_home):
            pytest.skip("chmod does not deny writes here (running as root?)")
        analyses_dir = harness_home / "analyses"
        try:
            harness_home.chmod(0o555)
            res = emit_analysis(
                _findings(),
                analyses_dir=analyses_dir,
                ref="pr-3",
                gate="soft",
                effective_tier=0,
                degraded_notice=None,
                exit_code=0,
            )
        finally:
            harness_home.chmod(0o755)
        assert res.action == "unavailable"
        assert res.path is None
        assert "write failed" in res.notice
        assert "sticky comment" in res.notice

    def test_build_error_degrades_not_crashes(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """FIX 3: a NON-OSError during record build/render (e.g. ValueError from
        json.dumps/render) must degrade to the fallback, NOT crash pr-check.
        ``build_analysis_record`` runs inside the try and the except is broad."""
        import agent.guardian.analysis_emit as emit_mod

        (tmp_path / ".harness").mkdir()
        analyses_dir = tmp_path / ".harness" / "analyses"

        def _boom(*_args, **_kwargs):
            raise ValueError("simulated build failure")

        monkeypatch.setattr(emit_mod, "build_analysis_record", _boom)
        res = emit_analysis(
            _findings(),
            analyses_dir=analyses_dir,
            ref="pr-3",
            gate="soft",
            effective_tier=0,
            degraded_notice=None,
            exit_code=0,
        )
        assert res.action == "unavailable"
        assert res.path is None
        assert res.notice is not None
        assert "sticky comment" in res.notice
        # Nothing written — the build failed before any file materialized.
        assert not any(p.is_file() for p in analyses_dir.rglob("*"))
