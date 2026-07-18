"""Supabase-backed HistoryStore.

Requires the optional `supabase` package:
  pip install "canary-test-ai[history]"

Push failures are non-fatal — the local store is always written first.
"""

from __future__ import annotations

from dataclasses import asdict
from typing import Optional

from agent.history.schema import RunRecord, TestResult
from agent.history.store import HistoryStore

_ERROR_TEXT_MAX = 2000


class SupabaseHistoryStore(HistoryStore):
    def __init__(self, db_url: str) -> None:
        try:
            from supabase import create_client
        except ImportError as e:
            raise ImportError(
                "supabase package is required for remote history storage. "
                'Install it with: pip install "canary-test-ai[history]"'
            ) from e

        self._db_url = db_url
        # URL format: postgresql+asyncpg://user:pass@host:port/db
        # Supabase client needs project URL + anon key separately.
        # We accept a postgres URL for local_store compatibility and parse
        # the host as the project URL; anon key via SUPABASE_ANON_KEY env var.
        import os
        anon_key = os.environ.get("SUPABASE_ANON_KEY", "")
        project_url = self._parse_project_url(db_url)
        self._client = create_client(project_url, anon_key)

    @staticmethod
    def _parse_project_url(db_url: str) -> str:
        # Expect https://<project>.supabase.co as the project URL.
        if db_url.startswith("https://"):
            return db_url
        # Try to extract host from postgresql+asyncpg://user:pass@host:port/db
        try:
            from urllib.parse import urlparse
            parsed = urlparse(db_url)
            return f"https://{parsed.hostname}"
        except Exception:
            # Fail closed: never fall back to the raw connection string here,
            # since it embeds credentials (user:pass). A fixed placeholder
            # keeps the return type a plain str without leaking anything.
            return "<redacted-unparseable-url>"

    def push_run(self, run: RunRecord, results: list[TestResult]) -> None:
        run_data = asdict(run)
        self._client.table("canary_runs").upsert(run_data).execute()

        if results:
            result_rows = []
            for t in results:
                row = asdict(t)
                if row.get("error_text") and len(row["error_text"]) > _ERROR_TEXT_MAX:
                    row["error_text"] = row["error_text"][:_ERROR_TEXT_MAX]
                result_rows.append(row)
            self._client.table("canary_test_results").upsert(result_rows).execute()

    def query_flaky(
        self,
        window: int,
        suite: Optional[str],
        min_rate: float,
    ) -> list[dict]:
        query = (
            self._client.table("canary_flake_summary")
            .select("*")
            .gte("flake_rate_pct", min_rate)
            .order("flake_rate_pct", desc=True)
        )
        if suite:
            query = query.eq("suite", suite)
        response = query.execute()
        return response.data or []

    def query_timeline(self, test_name: str) -> list[dict]:
        response = (
            self._client.table("canary_test_results")
            .select(
                "run_id, suite, status, failure_category, error_text, retry_count, "
                "canary_runs!inner(branch, commit_sha, timestamp)"
            )
            .eq("test_name", test_name)
            .order("canary_runs.timestamp")
            .execute()
        )
        rows = []
        for row in (response.data or []):
            run_info = row.pop("canary_runs", {})
            rows.append({**row, **run_info})
        return rows

    def query_summary(self, suite: str, runs: int) -> dict:
        response = (
            self._client.table("canary_runs")
            .select("run_id, branch, timestamp, passed, failed, flaky, total")
            .eq("suite", suite)
            .order("timestamp", desc=True)
            .limit(runs)
            .execute()
        )
        recent = list(reversed(response.data or []))
        if not recent:
            return {"suite": suite, "total_runs": 0, "avg_pass_rate": 0.0}

        rates = [r["passed"] / r["total"] * 100 for r in recent if r.get("total", 0) > 0]
        avg = round(sum(rates) / len(rates), 1) if rates else 0.0
        return {"suite": suite, "total_runs": len(recent), "avg_pass_rate": avg, "runs": recent}
