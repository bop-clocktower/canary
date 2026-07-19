"""Tests for agent/history/supabase_store.py — SupabaseHistoryStore.

Focused on `_parse_project_url`, which derives a safe project URL (host
only, credentials stripped) from a `postgresql://user:pass@host/db`
connection string. The parse-failure path must never fall back to
returning the raw, unredacted connection string — that would leak
embedded credentials to whatever ultimately consumes the return value
(e.g. `create_client`, logs).
"""

from __future__ import annotations

from agent.history.supabase_store import SupabaseHistoryStore

# Deliberately malformed IPv6 host segments — `urllib.parse.urlparse`
# raises ValueError on these rather than silently parsing them, which is
# exactly the parse-failure path under test.
_MALFORMED_URLS = [
    "postgresql://user:supersecretpass@[::1/db",
    "postgresql://user:supersecretpass@[bad::url/db",
    "postgresql://user:supersecretpass@[::gg]:5432/db",
]


def test_parse_project_url_redacts_normal_urls():
    result = SupabaseHistoryStore._parse_project_url(
        "postgresql+asyncpg://user:secretpass@my-project.supabase.co:5432/postgres"
    )
    assert result == "https://my-project.supabase.co"
    assert "secretpass" not in result
    assert "user" not in result


def test_parse_project_url_passes_through_https_urls():
    result = SupabaseHistoryStore._parse_project_url("https://my-project.supabase.co")
    assert result == "https://my-project.supabase.co"


def test_parse_project_url_never_leaks_credentials_on_parse_failure():
    for bad_url in _MALFORMED_URLS:
        result = SupabaseHistoryStore._parse_project_url(bad_url)
        assert "supersecretpass" not in result, (
            f"unredacted credential leaked for input {bad_url!r}: {result!r}"
        )
        assert result != bad_url, "parse-failure path must not fail open with the raw URL"


def test_parse_project_url_failure_placeholder_is_stable():
    # The failure-path value should be a fixed, obviously-non-secret
    # placeholder rather than any transformation of the raw input.
    results = {SupabaseHistoryStore._parse_project_url(u) for u in _MALFORMED_URLS}
    assert results == {"<redacted-unparseable-url>"}
