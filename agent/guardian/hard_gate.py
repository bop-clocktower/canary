"""Promote the guardian gate from soft to hard by registering its status check
as a **required** check in branch protection — the one admin step the operator
guide says the guardian can't do for you.

Structure mirrors :mod:`agent.guardian.pr_comment`: a :class:`BranchProtection`
Protocol, an in-memory fake for network-free tests, and a thin ``urllib`` REST
client. The decision logic (:func:`plan_hard_gate`) is pure. Any barrier — no
admin scope, a plan without branch protection, a bad token, a network error —
surfaces as :class:`HardGateBlocked` carrying a manual playbook, never a silent
no-op and never a crash (the #294/#295 fail-loud contract).

Two hazards this module is built to avoid:

- **Clobbering existing protection.** ``GET .../required_status_checks`` returns
  404 both for an unprotected branch AND a protected branch that simply has no
  required-checks section. Treating the latter as "unprotected" and PUT-ing a
  fresh ruleset would wipe review/admin/restriction protections. We disambiguate
  via the parent ``.../protection`` endpoint and only ever PUT-create when the
  branch is *genuinely* unprotected; otherwise we PATCH the checks sub-resource,
  which leaves every other protection untouched.
- **Registering a phantom check.** A required context that no workflow reports
  stays "Expected" forever and blocks *every* merge — worse than not promoting.
  So before registering we verify the context against the checks a recent commit
  actually reported, and refuse (listing the real ones) unless ``force``.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Protocol

from agent.guardian.pr_comment import GitHubPermissionError


class HardGateBlocked(RuntimeError):
    """A barrier stopped the required-check registration.

    Carries a human-readable ``reason`` and a ``playbook`` of manual steps, so a
    permission/plan/network barrier degrades to actionable guidance rather than
    a crash or a silent skip.
    """

    def __init__(self, reason: str, playbook: str) -> None:
        super().__init__(reason)
        self.reason = reason
        self.playbook = playbook


@dataclass
class HardGatePlan:
    """What promoting the gate would change on ``branch``.

    ``already_required`` — the check is already required (no-op).
    ``creates_protection`` — the branch has NO protection at all, so applying
    would create a minimal ruleset. ``resulting_contexts`` — the required-check
    set after applying.
    """

    check_context: str
    branch: str
    already_required: bool
    creates_protection: bool
    resulting_contexts: list[str]


def plan_hard_gate(
    existing_contexts: list[str] | None, check_context: str, branch: str
) -> HardGatePlan:
    """Decide the change without touching the network.

    ``existing_contexts`` is the branch's current required-check contexts, an
    empty list if the branch is protected but requires no checks yet, or
    ``None`` **only** if the branch has no protection at all. That three-way
    distinction is load-bearing: ``None`` is the only value that permits the
    protection-creating path.
    """
    creates = existing_contexts is None
    current = list(existing_contexts or [])
    already = check_context in current
    resulting = current if already else current + [check_context]
    return HardGatePlan(
        check_context=check_context,
        branch=branch,
        already_required=already,
        creates_protection=creates,
        resulting_contexts=sorted(set(resulting)),
    )


class BranchProtection(Protocol):
    """Read/write a branch's required-status-check contexts."""

    def required_check_contexts(self, branch: str) -> list[str] | None:
        """Current required contexts; ``[]`` if protected-without-checks;
        ``None`` only if the branch is genuinely unprotected. Raises
        :class:`GitHubPermissionError` on 401/403."""

    def observed_check_contexts(self, branch: str) -> list[str]:
        """Check-run names a recent commit on ``branch`` actually reported
        (best-effort; ``[]`` if none/unavailable)."""

    def set_required_checks(
        self, branch: str, contexts: list[str], *, create: bool
    ) -> None:
        """Require ``contexts`` on ``branch``. ``create`` PUTs a fresh minimal
        ruleset (only when genuinely unprotected); otherwise PATCHes the checks
        sub-resource, leaving other protections untouched. Raises
        :class:`GitHubPermissionError` on 401/403."""


@dataclass
class FakeBranchProtectionClient:
    """In-memory :class:`BranchProtection` for tests — no network.

    State model: ``contexts`` is the required-check list; ``None`` means no
    checks section. ``protected`` says whether the branch has protection at all
    (implied True when ``contexts`` is a list). So ``contexts=None,
    protected=True`` models the dangerous protected-without-checks state, and
    ``contexts=None, protected=False`` a genuinely unprotected branch.
    ``admin=False`` → reads/writes raise (no scope); ``plan_supported=False`` →
    writes raise. ``read_error`` injects an arbitrary read failure.
    """

    contexts: list[str] | None = None
    protected: bool = False
    admin: bool = True
    plan_supported: bool = True
    observed: list[str] = field(default_factory=list)
    read_error: Exception | None = None
    write_count: int = 0
    last_create: bool | None = None
    _store: dict[str, list[str]] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.contexts is not None:
            self._store["main"] = list(self.contexts)
            self.protected = True

    def contexts_for(self, branch: str) -> list[str] | None:
        return self._store.get(branch)

    def required_check_contexts(self, branch: str) -> list[str] | None:
        if self.read_error is not None:
            raise self.read_error
        if not self.admin:
            raise GitHubPermissionError(
                "token lacks admin scope for branch protection"
            )
        stored = self._store.get(branch)
        if stored is not None:
            return stored
        return [] if self.protected else None

    def observed_check_contexts(self, branch: str) -> list[str]:
        return list(self.observed)

    def set_required_checks(
        self, branch: str, contexts: list[str], *, create: bool
    ) -> None:
        if not self.admin:
            raise GitHubPermissionError("token lacks admin scope")
        if not self.plan_supported:
            raise GitHubPermissionError(
                "Upgrade your plan to use branch protection on this repository"
            )
        self.write_count += 1
        self.last_create = create
        self._store[branch] = list(contexts)


def render_playbook(repo: str, branch: str, check_context: str) -> str:
    """Manual steps to require the guardian check — the fallback when canary
    can't do it (no admin, unsupported plan, bad token, network error)."""
    return (
        f"Manual steps to require the '{check_context}' check on "
        f"{repo}@{branch}:\n"
        f"  1. Open https://github.com/{repo}/settings/branches\n"
        f"  2. Add or edit a branch protection rule for '{branch}'.\n"
        f"  3. Enable 'Require status checks to pass before merging' and add "
        f"'{check_context}' to the required checks.\n"
        f"Or, with an admin token, run:\n"
        f"  gh api -X PATCH "
        f"repos/{repo}/branches/{branch}/protection/required_status_checks "
        f"-f 'checks[][context]={check_context}'\n"
        f"Confirm '{check_context}' is the exact context a recent PR reported "
        f"(a wrong name registers a gate that never fires — and can block every "
        f"merge)."
    )


def apply_hard_gate(
    client: BranchProtection,
    repo: str,
    branch: str,
    check_context: str,
    *,
    force: bool = False,
) -> HardGatePlan:
    """Register ``check_context`` as required on ``branch``.

    Verifies the context is one a recent commit actually reported (unless
    ``force``) so we never register a phantom check that would block every
    merge. Returns the plan on success (including the idempotent already-required
    no-op). Raises :class:`HardGateBlocked` with a playbook on any barrier.
    """
    playbook = render_playbook(repo, branch, check_context)

    def _blocked(reason: str) -> HardGateBlocked:
        return HardGateBlocked(reason, playbook)

    # --- verify the context is real, before we touch protection ---
    if not force:
        try:
            observed = client.observed_check_contexts(branch)
        except (GitHubPermissionError, OSError):
            observed = []
        if not observed:
            raise _blocked(
                f"could not confirm any check has reported on {repo}@{branch}, "
                f"so cannot verify '{check_context}' is a real context; "
                "requiring an unreported check would block every merge. "
                "Open a PR so the guardian check runs at least once, or pass "
                "--force to register it anyway."
            )
        if check_context not in observed:
            raise _blocked(
                f"'{check_context}' is not among the checks recently reported on "
                f"{repo}@{branch}: {sorted(observed)}. Requiring it would block "
                "every merge. Re-run --check with one of those, or --force to "
                "override."
            )

    # --- read state (disambiguating unprotected vs protected-without-checks) ---
    try:
        existing = client.required_check_contexts(branch)
    except GitHubPermissionError as exc:
        raise _blocked(f"cannot read branch protection for {repo}@{branch}: {exc}") from exc
    except OSError as exc:  # URLError / timeout / non-403 HTTPError
        raise _blocked(f"failed reading branch protection for {repo}@{branch}: {exc}") from exc

    plan = plan_hard_gate(existing, check_context, branch)
    if plan.already_required:
        return plan

    try:
        client.set_required_checks(
            branch, plan.resulting_contexts, create=plan.creates_protection
        )
    except GitHubPermissionError as exc:
        raise _blocked(f"cannot update branch protection for {repo}@{branch}: {exc}") from exc
    except OSError as exc:
        raise _blocked(f"failed updating branch protection for {repo}@{branch}: {exc}") from exc
    return plan


class RestBranchProtectionClient:
    """Thin real :class:`BranchProtection` over the GitHub REST API (urllib)."""

    _API = "https://api.github.com"

    def __init__(self, repo: str, token: str) -> None:
        self.repo = repo
        self.token = token

    def _request(self, method: str, path: str, body: dict | None = None) -> dict:
        url = f"{self._API}/repos/{self.repo}/{path}"
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", f"Bearer {self.token}")
        req.add_header("Accept", "application/vnd.github+json")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req) as resp:  # noqa: S310 - fixed host
                raw = resp.read().decode() or "{}"
            return json.loads(raw)
        except urllib.error.HTTPError as exc:
            # 401 (bad/expired token) and 403 (no admin scope / rate limit) both
            # mean "we can't proceed here" → permission error → playbook.
            if exc.code in (401, 403):
                raise GitHubPermissionError(
                    f"HTTP {exc.code}: {exc.reason or 'forbidden'}"
                ) from exc
            raise  # other codes propagate as HTTPError (an OSError) → fail-loud

    def _branch_is_unprotected(self, branch: str) -> bool:
        """True only if the branch has NO protection object at all (parent 404).
        A protected branch without a checks section returns 200 here."""
        try:
            self._request("GET", f"branches/{branch}/protection")
            return False
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return True
            raise

    def required_check_contexts(self, branch: str) -> list[str] | None:
        try:
            data = self._request(
                "GET", f"branches/{branch}/protection/required_status_checks"
            )
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                # Ambiguous 404: genuinely unprotected, OR protected without a
                # checks section. Only the former may take the create path.
                return None if self._branch_is_unprotected(branch) else []
            raise
        checks = data.get("checks")
        if isinstance(checks, list):
            return [c.get("context", "") for c in checks if c.get("context")]
        return list(data.get("contexts", []))  # legacy shape

    def observed_check_contexts(self, branch: str) -> list[str]:
        try:
            data = self._request("GET", f"commits/{branch}/check-runs")
        except (urllib.error.URLError, GitHubPermissionError):
            return []
        runs = data.get("check_runs")
        if not isinstance(runs, list):
            return []
        return sorted({r.get("name", "") for r in runs if r.get("name")})

    def set_required_checks(
        self, branch: str, contexts: list[str], *, create: bool
    ) -> None:
        checks = [{"context": c} for c in contexts]
        if create:
            # Genuinely unprotected — PUT a minimal ruleset requiring only the
            # checks; other protections stay unset (the operator asked to
            # require a check on an unprotected branch, nothing to preserve).
            self._request(
                "PUT",
                f"branches/{branch}/protection",
                {
                    "required_status_checks": {"strict": False, "checks": checks},
                    "enforce_admins": None,
                    "required_pull_request_reviews": None,
                    "restrictions": None,
                },
            )
        else:
            # Protected already — PATCH the sub-resource (a partial update that
            # touches ONLY required status checks, preserving reviews /
            # restrictions / enforce_admins / the existing `strict` flag).
            self._request(
                "PATCH",
                f"branches/{branch}/protection/required_status_checks",
                {"checks": checks},
            )
