"""TDD for the guardian hard-gate rollout — registering the guardian's status
check as a required check in branch protection (the one admin step the operator
guide says the guardian can't do), with a loud manual-steps fallback.

The core is pure and network-free: `plan_hard_gate` decides what would change,
`apply_hard_gate` drives a `BranchProtectionClient` (faked here), and any
permission/plan barrier surfaces as `HardGateBlocked` carrying a playbook —
never a silent no-op.
"""

from __future__ import annotations

import pytest

from agent.guardian.hard_gate import (
    FakeBranchProtectionClient,
    HardGateBlocked,
    apply_hard_gate,
    plan_hard_gate,
    render_playbook,
)


class TestPlan:
    def test_adds_check_to_existing_protection(self) -> None:
        plan = plan_hard_gate(["build"], "guardian", "main")
        assert plan.already_required is False
        assert plan.creates_protection is False
        assert "guardian" in plan.resulting_contexts
        assert "build" in plan.resulting_contexts  # never clobber existing

    def test_already_required_is_a_noop(self) -> None:
        plan = plan_hard_gate(["guardian", "build"], "guardian", "main")
        assert plan.already_required is True
        assert set(plan.resulting_contexts) == {"guardian", "build"}

    def test_no_protection_flags_creation(self) -> None:
        plan = plan_hard_gate(None, "guardian", "main")
        assert plan.creates_protection is True
        assert plan.resulting_contexts == ["guardian"]


class TestPlaybook:
    def test_playbook_names_repo_branch_and_context(self) -> None:
        text = render_playbook("owner/repo", "main", "guardian")
        assert "owner/repo" in text
        assert "main" in text
        assert "guardian" in text
        # actionable: points at the settings surface and/or a gh command
        assert "branch" in text.lower()


class TestApply:
    # observed seeded so the phantom-context verification passes.
    def _client(self, **kw):
        kw.setdefault("observed", ["guardian"])
        return FakeBranchProtectionClient(**kw)

    def test_apply_adds_check_when_admin(self) -> None:
        client = self._client(contexts=["build"], admin=True)
        plan = apply_hard_gate(client, "owner/repo", "main", "guardian")
        assert plan.already_required is False
        assert "guardian" in client.contexts_for("main")
        assert "build" in client.contexts_for("main")  # merged, not clobbered

    def test_apply_creates_protection_only_when_unprotected(self) -> None:
        client = self._client(contexts=None, protected=False, admin=True)
        plan = apply_hard_gate(client, "owner/repo", "main", "guardian")
        assert plan.creates_protection is True
        assert client.last_create is True
        assert client.contexts_for("main") == ["guardian"]

    def test_protected_without_checks_does_not_clobber(self) -> None:
        # The dangerous state: branch protected (reviews etc.) but no checks
        # section. Must PATCH (create=False), never PUT-create.
        client = self._client(contexts=None, protected=True, admin=True)
        plan = apply_hard_gate(client, "owner/repo", "main", "guardian")
        assert plan.creates_protection is False
        assert client.last_create is False  # would-clobber PUT never used
        assert client.contexts_for("main") == ["guardian"]

    def test_apply_is_idempotent_when_already_required(self) -> None:
        client = self._client(contexts=["guardian"], admin=True)
        plan = apply_hard_gate(client, "owner/repo", "main", "guardian")
        assert plan.already_required is True
        assert client.write_count == 0

    def test_no_admin_raises_blocked_with_playbook(self) -> None:
        client = self._client(contexts=["build"], admin=False)
        with pytest.raises(HardGateBlocked) as exc:
            apply_hard_gate(client, "owner/repo", "main", "guardian")
        assert exc.value.playbook
        assert "guardian" in exc.value.playbook
        assert client.write_count == 0

    def test_plan_unsupported_raises_blocked(self) -> None:
        client = self._client(contexts=["build"], admin=True, plan_supported=False)
        with pytest.raises(HardGateBlocked):
            apply_hard_gate(client, "owner/repo", "main", "guardian")


class TestPhantomContextVerification:
    def test_unobserved_context_is_refused(self) -> None:
        # 'guardian' never reported → requiring it would block every merge.
        client = FakeBranchProtectionClient(contexts=["build"], observed=["build"])
        with pytest.raises(HardGateBlocked) as exc:
            apply_hard_gate(client, "owner/repo", "main", "guardian")
        assert "build" in exc.value.reason  # lists the real contexts
        assert client.write_count == 0

    def test_no_observed_checks_is_refused(self) -> None:
        client = FakeBranchProtectionClient(contexts=["build"], observed=[])
        with pytest.raises(HardGateBlocked):
            apply_hard_gate(client, "owner/repo", "main", "guardian")
        assert client.write_count == 0

    def test_force_bypasses_verification(self) -> None:
        client = FakeBranchProtectionClient(contexts=["build"], observed=[])
        plan = apply_hard_gate(
            client, "owner/repo", "main", "guardian", force=True
        )
        assert plan.already_required is False
        assert "guardian" in client.contexts_for("main")


class TestErrorHandling:
    def test_network_error_on_read_becomes_blocked(self) -> None:
        client = FakeBranchProtectionClient(
            contexts=["build"], observed=["guardian"],
            read_error=OSError("connection reset"),
        )
        with pytest.raises(HardGateBlocked) as exc:
            apply_hard_gate(client, "owner/repo", "main", "guardian")
        assert exc.value.playbook
        assert client.write_count == 0
