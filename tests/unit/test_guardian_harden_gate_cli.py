"""Unit tests for `canary guardian harden-gate`.

Dry-run by default (never writes); `--apply` registers the required check via an
injected client (faked here — no network). Exit contract: 0 success/no-op,
1 blocked (no admin / unsupported plan), 2 misuse (no repo, or --apply w/o token).
"""

from __future__ import annotations

import pytest
from typer.testing import CliRunner

from agent.guardian import cli as guardian_cli
from agent.guardian.cli import guardian_app
from agent.guardian.hard_gate import FakeBranchProtectionClient

runner = CliRunner()


def test_dry_run_describes_change_and_does_not_write(monkeypatch) -> None:
    called = {"built": False}
    monkeypatch.setattr(
        guardian_cli, "_branch_protection_client",
        lambda repo, token: called.__setitem__("built", True),
    )
    result = runner.invoke(guardian_app, ["harden-gate", "--repo", "o/r"])
    assert result.exit_code == 0
    assert "guardian" in result.output
    assert called["built"] is False  # dry-run never builds a client / writes


def test_apply_without_token_exits_two(monkeypatch) -> None:
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    result = runner.invoke(guardian_app, ["harden-gate", "--repo", "o/r", "--apply"])
    assert result.exit_code == 2
    assert "token" in result.output.lower()


def test_missing_repo_exits_two(monkeypatch) -> None:
    monkeypatch.delenv("GITHUB_REPOSITORY", raising=False)
    result = runner.invoke(guardian_app, ["harden-gate"])
    assert result.exit_code == 2


def test_apply_success_registers_check(monkeypatch) -> None:
    fake = FakeBranchProtectionClient(
        contexts=["build"], admin=True, observed=["guardian"]
    )
    monkeypatch.setattr(
        guardian_cli, "_branch_protection_client", lambda repo, token: fake
    )
    result = runner.invoke(
        guardian_app,
        ["harden-gate", "--repo", "o/r", "--apply", "--token", "x"],
    )
    assert result.exit_code == 0
    assert "guardian" in fake.contexts_for("main")
    assert "build" in fake.contexts_for("main")  # merged, not clobbered


def test_apply_blocked_exits_one_with_playbook(monkeypatch) -> None:
    fake = FakeBranchProtectionClient(
        contexts=["build"], admin=False, observed=["guardian"]
    )
    monkeypatch.setattr(
        guardian_cli, "_branch_protection_client", lambda repo, token: fake
    )
    result = runner.invoke(
        guardian_app,
        ["harden-gate", "--repo", "o/r", "--apply", "--token", "x"],
    )
    assert result.exit_code == 1
    assert "settings/branches" in result.output
    assert fake.write_count == 0


def test_apply_unverified_context_exits_one(monkeypatch) -> None:
    # 'guardian' not among observed → refuse (would block every merge).
    fake = FakeBranchProtectionClient(contexts=["build"], observed=["build"])
    monkeypatch.setattr(
        guardian_cli, "_branch_protection_client", lambda repo, token: fake
    )
    result = runner.invoke(
        guardian_app,
        ["harden-gate", "--repo", "o/r", "--apply", "--token", "x"],
    )
    assert result.exit_code == 1
    assert fake.write_count == 0


def test_force_bypasses_verification(monkeypatch) -> None:
    fake = FakeBranchProtectionClient(contexts=["build"], observed=[])
    monkeypatch.setattr(
        guardian_cli, "_branch_protection_client", lambda repo, token: fake
    )
    result = runner.invoke(
        guardian_app,
        ["harden-gate", "--repo", "o/r", "--apply", "--token", "x", "--force"],
    )
    assert result.exit_code == 0
    assert "guardian" in fake.contexts_for("main")


def test_apply_already_required_is_noop(monkeypatch) -> None:
    fake = FakeBranchProtectionClient(
        contexts=["guardian"], admin=True, observed=["guardian"]
    )
    monkeypatch.setattr(
        guardian_cli, "_branch_protection_client", lambda repo, token: fake
    )
    result = runner.invoke(
        guardian_app,
        ["harden-gate", "--repo", "o/r", "--apply", "--token", "x"],
    )
    assert result.exit_code == 0
    assert fake.write_count == 0
