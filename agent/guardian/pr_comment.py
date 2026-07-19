"""Deterministic GitHub PR comment poster (Tier 0, agent-free).

This module posts/updates the single sticky guardian findings comment on a pull
request. It is **deterministic HTTP behind a protocol seam** — it imports no
``AgentTier``, ``agent.llm``, or LLM-SDK module (SC-11, enforced by
``test_guardian_capability_boundary.py``).

Design:

- :class:`GitHubClient` is a ``typing.Protocol`` — the seam every consumer talks
  to (``list_comments`` / ``create_comment`` / ``update_comment``).
- :class:`FakeGitHubClient` is the in-memory implementation used by every unit
  test — **no network**. It can simulate a fork read-only token via
  ``deny_writes=True`` (writes raise :class:`GitHubPermissionError`).
- :class:`_RestGitHubClient` is the thin real client. Network (``urllib``) lives
  **only** here and is never exercised in unit tests.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Protocol

# Single source of truth for the sticky-comment marker. `pr_check.render`
# emits the identical literal at the head of a `comment`-format body so
# `find_sticky` (T3) can locate the guardian comment for in-place upsert.
STICKY_MARKER = "<!-- canary-pr-guardian -->"


class GitHubClient(Protocol):
    """The comment-poster seam. Every consumer depends on this, not on HTTP."""

    def list_comments(self) -> list[dict]:
        """Return the PR's issue comments as ``[{"id": int, "body": str}, ...]``."""
        ...

    def create_comment(self, body: str) -> dict:
        """Create a new comment; return ``{"id": int, "body": str}``."""
        ...

    def update_comment(self, comment_id: int, body: str) -> dict:
        """Update an existing comment in place; return the updated row."""
        ...


class GitHubPermissionError(RuntimeError):
    """A client cannot write (fork read-only token → HTTP 403).

    Raised by write methods so :func:`upsert_sticky_comment` (T4) can degrade
    loudly to a ``::warning::`` annotation instead of crashing the job (OT-4).
    """


@dataclass
class FakeGitHubClient:
    """In-memory :class:`GitHubClient` for unit tests — no network.

    Seed ``comments`` to model existing PR comments. Set ``deny_writes=True`` to
    simulate a fork read-only token: ``create_comment``/``update_comment`` then
    raise :class:`GitHubPermissionError`.
    """

    comments: list[dict] = field(default_factory=list)
    deny_writes: bool = False
    _next_id: int = 1000

    def list_comments(self) -> list[dict]:
        return self.comments

    def create_comment(self, body: str) -> dict:
        if self.deny_writes:
            raise GitHubPermissionError("read-only token: cannot create comment")
        self._next_id += 1
        row = {"id": self._next_id, "body": body}
        self.comments.append(row)
        return row

    def update_comment(self, comment_id: int, body: str) -> dict:
        if self.deny_writes:
            raise GitHubPermissionError("read-only token: cannot update comment")
        for row in self.comments:
            if row["id"] == comment_id:
                row["body"] = body
                return row
        raise KeyError(f"no comment with id {comment_id}")


class _RestGitHubClient:
    """Thin real :class:`GitHubClient` over the GitHub REST API (``urllib``).

    Network lives ONLY here; **no unit test exercises this class**. A 403 (fork
    read-only token) is surfaced as :class:`GitHubPermissionError` so the caller
    degrades loudly rather than crashing.

    Comments live on the *issues* endpoint (a PR is an issue):
    ``https://api.github.com/repos/{repo}/issues/{pr}/comments``.
    """

    _API = "https://api.github.com"

    def __init__(self, repo: str, pr_number: int, token: str) -> None:
        self.repo = repo
        self.pr_number = pr_number
        self.token = token

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
            "User-Agent": "canary-pr-guardian",
        }

    def _request(self, method: str, url: str, payload: dict | None = None) -> object:
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        req = urllib.request.Request(
            url, data=data, method=method, headers=self._headers()
        )
        try:
            with urllib.request.urlopen(req) as resp:  # noqa: S310 - trusted api.github.com
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            if exc.code == 403:
                raise GitHubPermissionError(
                    f"GitHub API 403 (read-only token / fork PR?): {url}"
                ) from exc
            raise

    def list_comments(self) -> list[dict]:
        url = f"{self._API}/repos/{self.repo}/issues/{self.pr_number}/comments"
        result = self._request("GET", url)
        return result if isinstance(result, list) else []

    def create_comment(self, body: str) -> dict:
        url = f"{self._API}/repos/{self.repo}/issues/{self.pr_number}/comments"
        result = self._request("POST", url, {"body": body})
        return result if isinstance(result, dict) else {}

    def update_comment(self, comment_id: int, body: str) -> dict:
        url = f"{self._API}/repos/{self.repo}/issues/comments/{comment_id}"
        result = self._request("PATCH", url, {"body": body})
        return result if isinstance(result, dict) else {}
