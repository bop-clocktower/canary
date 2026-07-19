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
    UpsertResult,
    degradation_annotation,
    find_sticky,
    upsert_sticky_comment,
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


def _marked(body: str) -> str:
    return f"{STICKY_MARKER}\n{body}"


class TestUpsert:
    """SC-9: the sticky comment is upserted by marker — never stacked."""

    def test_create_when_absent(self) -> None:
        client = FakeGitHubClient()
        result = upsert_sticky_comment(client, _marked("first"))
        assert result.action == "created"
        marked = [c for c in client.list_comments() if STICKY_MARKER in c["body"]]
        assert len(marked) == 1
        assert result.comment_id == marked[0]["id"]

    def test_second_run_updates_in_place(self) -> None:
        client = FakeGitHubClient()
        upsert_sticky_comment(client, _marked("first"))
        result = upsert_sticky_comment(client, _marked("second"))
        assert result.action == "updated"
        marked = [c for c in client.list_comments() if STICKY_MARKER in c["body"]]
        assert len(marked) == 1  # SC-9: no stacking
        assert marked[0]["body"] == _marked("second")

    def test_find_sticky_ignores_non_marker_comments(self) -> None:
        comments = [
            {"id": 1, "body": "unrelated chatter"},
            {"id": 2, "body": _marked("guardian findings")},
        ]
        found = find_sticky(comments)
        assert found is not None
        assert found["id"] == 2

    def test_find_sticky_returns_none_when_absent(self) -> None:
        assert find_sticky([{"id": 1, "body": "nope"}]) is None

    def test_upsert_result_shape(self) -> None:
        result = UpsertResult(action="created", comment_id=5)
        assert result.action == "created"
        assert result.comment_id == 5
        assert result.notice is None


class TestDegradation:
    """OT-4 / SC-1+D6: a read-only token degrades loudly — never crashes."""

    def test_create_path_degrades_without_raising(self) -> None:
        client = FakeGitHubClient(deny_writes=True)
        result = upsert_sticky_comment(client, _marked("body"))
        assert result.action == "degraded"
        assert result.comment_id is None
        assert result.notice

    def test_update_path_degrades_without_raising(self) -> None:
        # Seed one existing marked comment so the update branch is taken.
        client = FakeGitHubClient(
            comments=[{"id": 1, "body": _marked("old")}], deny_writes=True
        )
        result = upsert_sticky_comment(client, _marked("new"))
        assert result.action == "degraded"
        assert result.comment_id is None
        assert result.notice

    def test_permission_error_is_not_propagated(self) -> None:
        client = FakeGitHubClient(deny_writes=True)
        try:
            upsert_sticky_comment(client, _marked("body"))
        except GitHubPermissionError:  # pragma: no cover - must not happen
            pytest.fail("upsert must swallow GitHubPermissionError (OT-4)")

    def test_degradation_annotation_format(self) -> None:
        assert degradation_annotation("x") == "::warning::x"
