"""Tests for agent/history/schema.py — RunRecord, TestResult, run_id generation."""

from __future__ import annotations

from dataclasses import asdict

from agent.history.schema import RunRecord, TestResult, make_run_id


class TestMakeRunId:
    def test_includes_suite(self):
        rid = make_run_id("api", "abc1234def5", 1717948847)
        assert rid.startswith("api-")

    def test_includes_commit_short(self):
        rid = make_run_id("api", "abc1234def5", 1717948847)
        assert "abc1234" in rid

    def test_includes_timestamp(self):
        rid = make_run_id("api", "abc1234def5", 1717948847)
        assert "1717948847" in rid

    def test_unique_for_different_suites(self):
        ts = 1717948847
        assert make_run_id("api", "abc1234", ts) != make_run_id("e2e_ui", "abc1234", ts)

    def test_commit_truncated_to_8_chars(self):
        rid = make_run_id("api", "abc1234567890", 1717948847)
        # Should use exactly 8 chars of the sha
        parts = rid.split("-")
        assert parts[1] == "abc12345"

    def test_short_commit_not_padded(self):
        rid = make_run_id("api", "abc", 1717948847)
        parts = rid.split("-")
        assert parts[1] == "abc"


class TestRunRecord:
    def test_minimal_construction(self):
        r = RunRecord(
            run_id="api-abc12345-1717948847",
            suite="api",
            repo="acme-corp/api-service",
            branch="main",
            commit_sha="abc1234567890",
            timestamp="2026-06-09T16:00:00Z",
            total=10,
            passed=9,
            failed=1,
            flaky=0,
            skipped=0,
        )
        assert r.env is None
        assert r.duration_ms is None

    def test_serializes_to_dict(self):
        r = RunRecord(
            run_id="api-abc12345-1717948847",
            suite="api",
            repo="acme-corp/api-service",
            branch="main",
            commit_sha="abc1234567890",
            timestamp="2026-06-09T16:00:00Z",
            total=10,
            passed=9,
            failed=1,
            flaky=0,
            skipped=0,
        )
        d = asdict(r)
        assert d["suite"] == "api"
        assert d["total"] == 10

    def test_roundtrip_json(self):
        r = RunRecord(
            run_id="api-abc12345-1717948847",
            suite="api",
            repo="acme-corp/api-service",
            branch="main",
            commit_sha="abc1234567890",
            timestamp="2026-06-09T16:00:00Z",
            total=5,
            passed=4,
            failed=1,
            flaky=0,
            skipped=0,
            env="ci",
            duration_ms=12000,
        )
        d = asdict(r)
        restored = RunRecord(**d)
        assert restored == r


class TestTestResult:
    def test_minimal_construction(self):
        t = TestResult(
            run_id="api-abc12345-1717948847",
            suite="api",
            repo="acme-corp/api-service",
            test_name="GET /v2/members - should list members",
            test_file="tests/members/list.spec.ts",
            status="passed",
        )
        assert t.area is None
        assert t.retry_count == 0
        assert t.tags == []

    def test_status_values(self):
        for status in ("passed", "failed", "flaky", "skipped"):
            t = TestResult(
                run_id="r1",
                suite="api",
                repo="acme-corp/api-service",
                test_name="test",
                test_file="test.spec.ts",
                status=status,
            )
            assert t.status == status

    def test_roundtrip_json(self):
        t = TestResult(
            run_id="api-abc12345-1717948847",
            suite="api",
            repo="acme-corp/api-service",
            test_name="POST /v2/auth/login - should return token",
            test_file="tests/auth/login.spec.ts",
            status="flaky",
            area="auth",
            failure_category="timeout",
            error_text="Timeout exceeded after 30000ms",
            retry_count=2,
            duration_ms=31200,
            tags=["@smoke"],
        )
        d = asdict(t)
        restored = TestResult(**d)
        assert restored == t

    def test_error_text_truncation_is_callers_job(self):
        long_err = "x" * 3000
        t = TestResult(
            run_id="r1",
            suite="api",
            repo="acme-corp/api-service",
            test_name="test",
            test_file="t.spec.ts",
            status="failed",
            error_text=long_err,
        )
        assert len(t.error_text) == 3000
