"""TDD for agent.guardian.pr_comment — deterministic GitHub comment poster.

The poster is HTTP behind a :class:`GitHubClient` protocol seam (SC-11: no
agent/LLM import). Every test drives the in-memory :class:`FakeGitHubClient`;
the real ``_RestGitHubClient`` (network) is NEVER exercised here.
"""

from __future__ import annotations

import pytest

from agent.guardian.pr_comment import (
    FakeGitHubClient,
    GitHubPermissionError,
    STICKY_MARKER,
)


class TestFakeClient:
    """The in-memory client models list/create/update with no network."""

    def test_list_returns_seeded_rows(self) -> None:
        seeded = [{"id": 1, "body": "hello"}]
        client = FakeGitHubClient(comments=seeded)
        assert client.list_comments() == seeded

    def test_create_appends_with_new_id(self) -> None:
        client = FakeGitHubClient()
        row = client.create_comment("x")
        assert row["body"] == "x"
        assert isinstance(row["id"], int)
        assert client.list_comments()[-1] == row

    def test_create_ids_are_unique(self) -> None:
        client = FakeGitHubClient()
        first = client.create_comment("a")
        second = client.create_comment("b")
        assert first["id"] != second["id"]

    def test_update_mutates_matching_row(self) -> None:
        client = FakeGitHubClient(comments=[{"id": 7, "body": "old"}])
        updated = client.update_comment(7, "new")
        assert updated["body"] == "new"
        assert client.list_comments()[0]["body"] == "new"

    def test_create_denied_raises_permission_error(self) -> None:
        client = FakeGitHubClient(deny_writes=True)
        with pytest.raises(GitHubPermissionError):
            client.create_comment("x")

    def test_update_denied_raises_permission_error(self) -> None:
        client = FakeGitHubClient(comments=[{"id": 1, "body": "old"}], deny_writes=True)
        with pytest.raises(GitHubPermissionError):
            client.update_comment(1, "new")

    def test_sticky_marker_constant(self) -> None:
        assert STICKY_MARKER == "<!-- canary-pr-guardian -->"
