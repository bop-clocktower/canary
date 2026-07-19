"""Structural test for the PR Guardian GitHub Actions workflow (SC-1).

Offline: parses ``.github/workflows/guardian.yml`` with ``yaml.safe_load`` and
asserts the stock-Actions, agentless contract (no secret beyond ``GITHUB_TOKEN``,
``pull_request`` trigger, write permission for commenting, three-dot base-ref
diff, and the ``guardian pr-check --post-comment`` invocation). It never runs the
workflow.
"""

from __future__ import annotations

from pathlib import Path

import yaml

_REPO_ROOT = Path(__file__).resolve().parents[2]
_WORKFLOW = _REPO_ROOT / ".github" / "workflows" / "guardian.yml"


def _load() -> dict:
    return yaml.safe_load(_WORKFLOW.read_text(encoding="utf-8"))


def _run_blocks(wf: dict) -> list[str]:
    blocks: list[str] = []
    for job in wf.get("jobs", {}).values():
        for step in job.get("steps", []):
            run = step.get("run")
            if isinstance(run, str):
                blocks.append(run)
    return blocks


class TestGuardianWorkflow:
    def test_triggers_on_pull_request(self) -> None:
        wf = _load()
        # PyYAML may parse the bare `on:` key as the boolean True.
        triggers = wf.get("on", wf.get(True))
        assert triggers is not None
        assert "pull_request" in triggers

    def test_permissions_comment_write_contents_read(self) -> None:
        wf = _load()
        perms = wf["permissions"]
        assert perms["pull-requests"] == "write"
        assert perms["contents"] == "read"

    def test_checkout_uses_full_fetch_depth(self) -> None:
        wf = _load()
        depths = [
            step.get("with", {}).get("fetch-depth")
            for job in wf["jobs"].values()
            for step in job["steps"]
        ]
        assert 0 in depths

    def test_invokes_pr_check_with_post_comment(self) -> None:
        blocks = _run_blocks(_load())
        assert any(
            "guardian pr-check" in b and "--post-comment" in b for b in blocks
        )

    def test_three_dot_base_ref_diff(self) -> None:
        blocks = _run_blocks(_load())
        assert any("git diff" in b and "origin/" in b and "...HEAD" in b for b in blocks)

    def test_agentless_no_extra_secret(self) -> None:
        # Only GITHUB_TOKEN / github.token may appear — no `secrets.` reference,
        # proving the surface is agentless (no API key, no LLM secret).
        raw = _WORKFLOW.read_text(encoding="utf-8")
        assert "secrets." not in raw
