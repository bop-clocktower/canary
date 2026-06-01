# agent/core/ticket_updater.py

from __future__ import annotations

"""
Ticket Updater — posts a structured run comment and optionally transitions
the linked ticket after an Oracle test run.

Oracle never hardcodes Jira status names.  Transition targets are resolved
via the semantic-role mapping persisted by ``WorkflowDiscovery``.

Public surface
--------------
RunSummary      — dataclass describing a completed test run
UpdateResult    — dataclass returned by TicketUpdater.update()
TransitionResult — dataclass describing the outcome of a transition attempt
TicketUpdater   — main class; detect linkage, build comment, post, transition
"""

import json
import os
import re
import subprocess
import urllib.error
import urllib.request
from base64 import b64encode
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, Optional

# ── result types ──────────────────────────────────────────────────────────────


@dataclass
class TransitionResult:
    attempted: bool
    succeeded: bool
    from_status: Optional[str]
    to_status: Optional[str]
    reason: str  # human-readable explanation


@dataclass
class UpdateResult:
    ticket_key: Optional[str]
    project_key: Optional[str]
    linkage_source: str  # "frontmatter" | "tag" | "branch" | "none"
    comment_posted: bool
    transition: TransitionResult
    dry_run: bool
    messages: list[str] = field(default_factory=list)


# ── run summary ───────────────────────────────────────────────────────────────


@dataclass
class RunSummary:
    """Describes a completed Oracle test run."""

    suite_name: str
    env: str
    result: Literal["PASS", "FAIL", "PARTIAL"]
    passed: int
    total: int
    flaky_count: int
    duration_s: float
    test_file: str
    report_url: Optional[str]
    passed_names: list[str]
    failed_names: list[tuple[str, str]]  # (name, failure_category) pairs
    ticket_key: Optional[str] = None
    project_key: Optional[str] = None
    linkage_source: str = "none"


# ── main class ────────────────────────────────────────────────────────────────

# Patterns for ticket linkage detection.
_FRONTMATTER_TICKET = re.compile(r"^#\s*oracle:ticket:\s*(\S+)", re.MULTILINE)
_FRONTMATTER_PROJECT = re.compile(r"^#\s*oracle:project:\s*(\S+)", re.MULTILINE)
_TAG_TICKET = re.compile(r"@(?:ticket|jira):([A-Z][A-Z0-9]*-\d+)", re.MULTILINE)
_BRANCH_TICKET = re.compile(r"(?:feature|fix|chore)/([A-Z][A-Z0-9]*-\d+)")
_TICKET_PROJECT = re.compile(r"^([A-Z][A-Z0-9]*)-\d+$")


class TicketUpdater:
    """
    Posts a run comment and optionally transitions the linked ticket.

    Parameters
    ----------
    canary_dir : Path | str | None
        Directory containing workflow mapping files.  Defaults to
        ``.canary/`` relative to the current working directory.
    """

    def __init__(self, canary_dir: Optional[Path | str] = None) -> None:
        self.canary_dir: Path = (
            Path(canary_dir) if canary_dir is not None else Path.cwd() / ".canary"
        )

    # ── public ────────────────────────────────────────────────────────────────

    def update(
        self,
        summary: RunSummary,
        *,
        dry_run: bool = False,
        comment_only: bool = False,
        transition_only: bool = False,
    ) -> UpdateResult:
        """
        Post a run comment and/or transition the ticket.

        Parameters
        ----------
        summary : RunSummary
            Completed run data.  ``ticket_key`` and ``project_key`` may be
            pre-populated by the caller or left for ``detect_linkage`` to fill.
        dry_run : bool
            Show exactly what would be posted/transitioned without writing.
        comment_only : bool
            Post comment but skip transition.
        transition_only : bool
            Transition only, skip comment.

        Returns
        -------
        UpdateResult
        """
        messages: list[str] = []

        # 1. Resolve linkage if not already set.
        ticket_key = summary.ticket_key
        project_key = summary.project_key
        linkage_source = summary.linkage_source

        if not ticket_key and summary.test_file:
            ticket_key, project_key, linkage_source = self.detect_linkage(
                Path(summary.test_file)
            )

        # 2. Safety gate — no ticket found.
        if not ticket_key:
            messages.append(
                "No ticket linkage found — skipping comment and transition.\n"
                "Add '# oracle:ticket: PROJ-123' to the test file frontmatter, "
                "a '@ticket:PROJ-123' tag, or run from a branch named "
                "feature/PROJ-123."
            )
            return UpdateResult(
                ticket_key=None,
                project_key=None,
                linkage_source=linkage_source,
                comment_posted=False,
                transition=TransitionResult(
                    attempted=False,
                    succeeded=False,
                    from_status=None,
                    to_status=None,
                    reason="no ticket linkage",
                ),
                dry_run=dry_run,
                messages=messages,
            )

        # Infer project_key from ticket_key if not set.
        if not project_key:
            m = _TICKET_PROJECT.match(ticket_key)
            project_key = m.group(1) if m else None

        # 3. Build run comment.
        comment_body = self._build_comment(summary)

        # 4. Post comment.
        comment_posted = False
        if not transition_only:
            # Determine surface: Jira for PROJ-NNN keys, GitHub for owner/repo#NNN.
            if re.match(r"^[A-Z][A-Z0-9]*-\d+$", ticket_key):
                comment_posted = self._post_jira_comment(
                    ticket_key, comment_body, dry_run
                )
            elif re.match(r"^#\d+$", ticket_key) or re.match(r"^\d+$", ticket_key):
                # GitHub issue — needs project_key as "owner/repo".
                issue_ref = f"{project_key}#{ticket_key.lstrip('#')}" if project_key else ticket_key
                comment_posted = self._post_github_comment(
                    issue_ref, comment_body, dry_run
                )
            else:
                messages.append(
                    f"Unrecognised ticket key format: {ticket_key!r}. "
                    "Expected PROJ-NNN (Jira) or #NNN (GitHub Issue)."
                )

            if dry_run:
                messages.append(
                    f"Would post comment to {ticket_key} "
                    f"({'Jira' if '-' in ticket_key else 'GitHub Issue'}):\n"
                    f"{comment_body}"
                )
                comment_posted = True  # flagged as would-post

        # 5. Transition.
        transition_result = TransitionResult(
            attempted=False,
            succeeded=False,
            from_status=None,
            to_status=None,
            reason="skipped (comment-only mode)",
        )

        if not comment_only:
            transition_result = self._transition_jira(
                ticket_key, project_key or "", summary.result, dry_run
            )
            if dry_run and transition_result.attempted:
                messages.append(
                    f"Would transition {ticket_key}:\n"
                    f'  "{transition_result.from_status}" → "{transition_result.to_status}"\n'
                    f"  (resolved via qa_passed role in "
                    f".canary/workflow-{project_key}.json)\n\n"
                    "Re-run without --dry-run to apply."
                )
            elif not transition_result.attempted:
                messages.append(transition_result.reason)

        return UpdateResult(
            ticket_key=ticket_key,
            project_key=project_key,
            linkage_source=linkage_source,
            comment_posted=comment_posted,
            transition=transition_result,
            dry_run=dry_run,
            messages=messages,
        )

    def detect_linkage(
        self, test_file: Path
    ) -> tuple[Optional[str], Optional[str], str]:
        """
        Extract ticket linkage from *test_file*.

        Returns
        -------
        (ticket_key, project_key, linkage_source)
            *linkage_source* is one of ``"frontmatter"``, ``"tag"``,
            ``"branch"``, or ``"none"``.
        """
        if not test_file.exists():
            return _branch_ticket()

        content = test_file.read_text(encoding="utf-8", errors="replace")

        # Priority 1: YAML frontmatter comments.
        m_ticket = _FRONTMATTER_TICKET.search(content)
        if m_ticket:
            ticket_key = m_ticket.group(1)
            m_project = _FRONTMATTER_PROJECT.search(content)
            project_key: Optional[str] = m_project.group(1) if m_project else None
            if project_key is None:
                pm = _TICKET_PROJECT.match(ticket_key)
                project_key = pm.group(1) if pm else None
            return ticket_key, project_key, "frontmatter"

        # Priority 2: @ticket / @jira tag annotations.
        m_tag = _TAG_TICKET.search(content)
        if m_tag:
            ticket_key = m_tag.group(1)
            pm = _TICKET_PROJECT.match(ticket_key)
            project_key = pm.group(1) if pm else None
            return ticket_key, project_key, "tag"

        # Priority 3: branch name (comment only, not for transition).
        return _branch_ticket()

    # ── private: comment building ─────────────────────────────────────────────

    def _build_comment(self, summary: RunSummary) -> str:
        """
        Build the fixed-format run comment string.  Content is never free-form
        LLM text — every field comes directly from *summary*.
        """
        flags = f"--result {summary.result.lower()}"

        lines = [
            f"🧪 Oracle Test Run — {summary.suite_name}",
            "",
            f"Environment: {summary.env}",
            f"Result: {summary.result} ({summary.passed}/{summary.total} tests)",
            f"Flaky: {summary.flaky_count}",
            f"Duration: {summary.duration_s}s",
            f"Run by: oracle report {flags}",
            "",
            f"Test file: {summary.test_file}",
        ]

        if summary.report_url:
            lines.append(f"Report: {summary.report_url}")

        lines += ["", "---"]

        if summary.passed_names:
            lines.append("Passed:")
            for name in summary.passed_names:
                lines.append(f"  ✓ {name}")

        if summary.failed_names:
            lines.append("Failed:")
            for name, category in summary.failed_names:
                lines.append(f"  ✗ {name} — {category}")

        return "\n".join(lines)

    # ── private: Jira ─────────────────────────────────────────────────────────

    def _post_jira_comment(
        self, ticket_key: str, body: str, dry_run: bool
    ) -> bool:
        """
        Post *body* as a plain-text comment on *ticket_key* in Jira.

        Uses Basic auth via ATLASSIAN_URL / ATLASSIAN_USER / ATLASSIAN_TOKEN.
        Returns True on success (or dry_run), False on failure.
        """
        if dry_run:
            return True

        # Infer project key from ticket key to select the right Atlassian URL.
        pm = _TICKET_PROJECT.match(ticket_key)
        project_key = pm.group(1) if pm else None
        base_url, auth_header = _jira_auth(project_key, self.canary_dir)
        if base_url is None:
            return False

        url = f"{base_url}/rest/api/3/issue/{ticket_key}/comment"
        payload = json.dumps(
            {
                "body": {
                    "type": "doc",
                    "version": 1,
                    "content": [
                        {
                            "type": "paragraph",
                            "content": [{"type": "text", "text": body}],
                        }
                    ],
                }
            }
        ).encode("utf-8")

        req = urllib.request.Request(
            url,
            data=payload,
            headers={
                "Authorization": auth_header,
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=10):
                return True
        except (urllib.error.HTTPError, urllib.error.URLError):
            return False

    def _post_github_comment(
        self, issue_ref: str, body: str, dry_run: bool
    ) -> bool:
        """
        Post *body* as a Markdown comment on a GitHub Issue.

        *issue_ref* must be ``"owner/repo#NNN"`` or ``"NNN"``.
        Uses the ``gh`` CLI (must be authenticated).
        Returns True on success (or dry_run), False on failure.
        """
        if dry_run:
            return True

        # Parse owner/repo#NNN or bare NNN.
        m = re.match(r"^([^#]+)#(\d+)$", issue_ref)
        if m:
            repo, number = m.group(1), m.group(2)
        elif re.match(r"^\d+$", issue_ref):
            repo = ""
            number = issue_ref
        else:
            return False

        cmd = ["gh", "issue", "comment", number, "--body", body]
        if repo:
            cmd += ["--repo", repo]

        try:
            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=15
            )
            return result.returncode == 0
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return False

    def _transition_jira(
        self,
        ticket_key: str,
        project_key: str,
        result: str,
        dry_run: bool,
    ) -> TransitionResult:
        """
        Transition *ticket_key* to the ``qa_passed`` status if *result* is
        ``"PASS"``.  Never transitions on ``FAIL`` or ``PARTIAL``.

        Steps:
        1. Resolve ``qa_passed`` role from the workflow mapping.
        2. Fetch the ticket's current status.
        3. Confirm the transition is reachable.
        4. Execute (or dry-run) the Jira transition.
        """
        # Block transition on non-PASS results.
        if result != "PASS":
            return TransitionResult(
                attempted=False,
                succeeded=False,
                from_status=None,
                to_status=None,
                reason=(
                    f"Run result is {result} — ticket NOT transitioned to qa_passed. "
                    "Transition only happens on PASS."
                ),
            )

        # Resolve target status name from workflow mapping.
        from agent.core.workflow_discovery import resolve_role

        target_status = resolve_role(project_key, "qa_passed", self.canary_dir)
        if target_status is None:
            return TransitionResult(
                attempted=False,
                succeeded=False,
                from_status=None,
                to_status=None,
                reason=(
                    f"⚠  No workflow mapping found for project {project_key}.\n"
                    f"   Run `oracle workflow-discover --project {project_key}` first.\n"
                    "   Comment was posted. Transition was NOT attempted."
                ),
            )

        # Need Jira creds to proceed — prefer URL stored in mapping for this project.
        base_url, auth_header = _jira_auth(project_key, self.canary_dir)
        if base_url is None:
            return TransitionResult(
                attempted=False,
                succeeded=False,
                from_status=None,
                to_status=None,
                reason=(
                    "Jira credentials not configured (ATLASSIAN_URL, "
                    "ATLASSIAN_USER, ATLASSIAN_TOKEN). "
                    "Transition was NOT attempted."
                ),
            )

        # Fetch ticket's current status.
        current_status = _jira_current_status(base_url, auth_header, ticket_key)
        if current_status is None:
            return TransitionResult(
                attempted=False,
                succeeded=False,
                from_status=None,
                to_status=target_status,
                reason=f"Could not fetch current status for {ticket_key}.",
            )

        # Find the transition ID that leads to target_status.
        transition_id = _jira_find_transition(
            base_url, auth_header, ticket_key, target_status
        )
        if transition_id is None:
            return TransitionResult(
                attempted=True,
                succeeded=False,
                from_status=current_status,
                to_status=target_status,
                reason=(
                    f'Transition to "{target_status}" is not reachable from '
                    f'"{current_status}" for {ticket_key}. '
                    "No transition attempted."
                ),
            )

        # Dry-run: return what would happen.
        if dry_run:
            return TransitionResult(
                attempted=True,
                succeeded=False,  # not actually done
                from_status=current_status,
                to_status=target_status,
                reason="dry-run",
            )

        # Execute transition.
        ok = _jira_do_transition(base_url, auth_header, ticket_key, transition_id)
        return TransitionResult(
            attempted=True,
            succeeded=ok,
            from_status=current_status,
            to_status=target_status,
            reason="transition executed" if ok else "transition API call failed",
        )


# ── helpers ───────────────────────────────────────────────────────────────────


def _jira_auth(
    project_key: Optional[str] = None,
    canary_dir: Optional[Path] = None,
) -> tuple[Optional[str], Optional[str]]:
    """
    Return (base_url, auth_header) for the given *project_key*, or (None, None)
    if credentials are missing.

    Resolution order for base_url:
    1. ``atlassian_url`` stored in ``.canary/workflow-{project_key}.json``
       (written by ``oracle workflow-discover`` or ``oracle workflow-init``).
    2. ``ATLASSIAN_URL`` environment variable.

    This lets projects on different Atlassian instances each carry their own URL
    in the mapping file without requiring separate env-var management.
    """
    # Prefer the URL stored in the per-project mapping.
    base_url: str = ""
    if project_key:
        from agent.core.workflow_discovery import atlassian_url_for

        stored = atlassian_url_for(project_key, canary_dir)
        if stored:
            base_url = stored.rstrip("/")

    if not base_url:
        base_url = os.environ.get("ATLASSIAN_URL", "").rstrip("/")

    user = os.environ.get("ATLASSIAN_USER", "")
    token = os.environ.get("ATLASSIAN_TOKEN", "")
    if not all([base_url, user, token]):
        return None, None
    auth = b64encode(f"{user}:{token}".encode()).decode()
    return base_url, f"Basic {auth}"


def _jira_current_status(
    base_url: str, auth_header: str, ticket_key: str
) -> Optional[str]:
    """Fetch the current status name of *ticket_key* from Jira."""
    url = f"{base_url}/rest/api/3/issue/{ticket_key}?fields=status"
    req = urllib.request.Request(
        url, headers={"Authorization": auth_header, "Accept": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return (
                data.get("fields", {}).get("status", {}).get("name")
            )
    except (urllib.error.URLError, json.JSONDecodeError):
        return None


def _jira_find_transition(
    base_url: str,
    auth_header: str,
    ticket_key: str,
    target_status: str,
) -> Optional[str]:
    """
    Return the transition ID that moves *ticket_key* to *target_status*, or
    None if no such reachable transition exists.
    """
    url = f"{base_url}/rest/api/3/issue/{ticket_key}/transitions"
    req = urllib.request.Request(
        url, headers={"Authorization": auth_header, "Accept": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, json.JSONDecodeError):
        return None

    for t in data.get("transitions", []):
        to_name = t.get("to", {}).get("name", "")
        if to_name.lower() == target_status.lower():
            return str(t["id"])
    return None


def _jira_do_transition(
    base_url: str,
    auth_header: str,
    ticket_key: str,
    transition_id: str,
) -> bool:
    """Execute the Jira transition *transition_id* on *ticket_key*."""
    url = f"{base_url}/rest/api/3/issue/{ticket_key}/transitions"
    payload = json.dumps({"transition": {"id": transition_id}}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        headers={
            "Authorization": auth_header,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10):
            return True
    except (urllib.error.HTTPError, urllib.error.URLError):
        return False


def _branch_ticket() -> tuple[Optional[str], Optional[str], str]:
    """
    Extract ticket key from the current git branch name.

    Returns (ticket_key, project_key, "branch") or (None, None, "none") if
    the branch does not match the naming convention.
    """
    try:
        result = subprocess.run(
            ["git", "branch", "--show-current"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        branch = result.stdout.strip() if result.returncode == 0 else ""
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None, None, "none"

    m = _BRANCH_TICKET.search(branch)
    if m:
        ticket_key = m.group(1)
        pm = _TICKET_PROJECT.match(ticket_key)
        project_key: Optional[str] = pm.group(1) if pm else None
        return ticket_key, project_key, "branch"

    return None, None, "none"
