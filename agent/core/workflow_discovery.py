# agent/core/workflow_discovery.py

from __future__ import annotations

"""
Workflow Discovery — discovers per-project Jira / GitHub issue workflows
and persists the mapping to `.oracle/workflow-<key>.json`.

Oracle never hardcodes Jira status names or GitHub board columns.  Instead, it
calls `resolve_role()` which looks up the persisted mapping.  If the mapping is
missing, `WorkflowDiscovery.discover()` must be called first (either explicitly
or via `oracle workflow-discover`).

Jira REST API is called directly using credentials from the environment
(``ATLASSIAN_URL``, ``ATLASSIAN_USER``, ``ATLASSIAN_TOKEN``).  GitHub Projects
v2 is called via the ``gh`` CLI.  Both are optional — if neither is configured
the command prints a guidance message and exits without crashing downstream
consumers.

Public surface
--------------
WorkflowDiscovery      — main class; discover / show / resolve
WorkflowMapping        — dataclass for the persisted schema
IssueType, StatusEntry, TransitionEntry, SemanticRole  — schema types
WorkflowDiscoveryError — raised on unrecoverable configuration issues
resolve_role()         — module-level shortcut used by downstream code
"""

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from base64 import b64encode
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

# ── schema ────────────────────────────────────────────────────────────────────

SCHEMA_VERSION = "https://oracle.capillary.internal/schemas/workflow-mapping/v1"

# Word-list used for automatic semantic-role heuristics.
_ROLE_TRIGGERS: dict[str, list[str]] = {
    "qa_passed": ["qa pass", "qa passed", "qa done", "tested", "verified"],
    "ready_to_deploy": ["deploy", "release", "ship", "done", "closed", "merged"],
    "in_review": ["review", "pr open", "code review", "awaiting review"],
    "in_qa": ["qa", "testing", "in test", "in qa"],
    "in_progress": ["progress", "active", "started", "in development"],
    "blocked": ["blocked", "on hold", "waiting"],
}

# Priority order when resolving ambiguous matches (earlier = higher priority).
_ROLE_PRIORITY = [
    "qa_passed",
    "ready_to_deploy",
    "in_qa",
    "in_review",
    "in_progress",
    "blocked",
]


@dataclass
class StatusEntry:
    id: str
    name: str
    category: str  # "new" | "indeterminate" | "done"


@dataclass
class TransitionEntry:
    id: str
    name: str
    from_status: str
    to_status: str


@dataclass
class IssueType:
    id: str
    name: str
    statuses: list[StatusEntry] = field(default_factory=list)
    transitions: list[TransitionEntry] = field(default_factory=list)


@dataclass
class SemanticRole:
    status_name: str
    issue_type: str


@dataclass
class WorkflowMapping:
    project_key: str
    source: str  # "jira" | "github"
    discovered_at: str
    issue_types: list[IssueType] = field(default_factory=list)
    semantic_roles: dict[str, SemanticRole] = field(default_factory=dict)
    role_annotations_confirmed: bool = False
    atlassian_url: Optional[str] = None  # per-project Jira base URL; overrides ATLASSIAN_URL

    # ── serialisation ─────────────────────────────────────────────────────────

    def to_dict(self) -> dict:
        d: dict = {
            "$schema": SCHEMA_VERSION,
            "project_key": self.project_key,
            "source": self.source,
            "discovered_at": self.discovered_at,
            "issue_types": [],
            "semantic_roles": {},
            "role_annotations_confirmed": self.role_annotations_confirmed,
        }
        if self.atlassian_url:
            d["atlassian_url"] = self.atlassian_url
        for it in self.issue_types:
            it_d: dict = {
                "id": it.id,
                "name": it.name,
                "statuses": [asdict(s) for s in it.statuses],
                "transitions": [
                    {
                        "id": t.id,
                        "name": t.name,
                        "from": t.from_status,
                        "to": t.to_status,
                    }
                    for t in it.transitions
                ],
            }
            d["issue_types"].append(it_d)
        for role, sr in self.semantic_roles.items():
            d["semantic_roles"][role] = asdict(sr)
        return d

    def to_json(self, indent: int = 2) -> str:
        return json.dumps(self.to_dict(), indent=indent)

    @classmethod
    def from_dict(cls, data: dict) -> "WorkflowMapping":
        issue_types = []
        for it_d in data.get("issue_types", []):
            statuses = [StatusEntry(**s) for s in it_d.get("statuses", [])]
            transitions = [
                TransitionEntry(
                    id=t["id"],
                    name=t["name"],
                    from_status=t.get("from", t.get("from_status", "")),
                    to_status=t.get("to", t.get("to_status", "")),
                )
                for t in it_d.get("transitions", [])
            ]
            issue_types.append(
                IssueType(
                    id=it_d["id"],
                    name=it_d["name"],
                    statuses=statuses,
                    transitions=transitions,
                )
            )
        semantic_roles = {
            role: SemanticRole(**sr_d)
            for role, sr_d in data.get("semantic_roles", {}).items()
        }
        return cls(
            project_key=data["project_key"],
            source=data.get("source", "jira"),
            discovered_at=data.get("discovered_at", ""),
            issue_types=issue_types,
            semantic_roles=semantic_roles,
            role_annotations_confirmed=data.get("role_annotations_confirmed", False),
            atlassian_url=data.get("atlassian_url"),
        )


# ── errors ────────────────────────────────────────────────────────────────────


class WorkflowDiscoveryError(Exception):
    """Raised when discovery cannot proceed due to a configuration problem."""


# ── main class ────────────────────────────────────────────────────────────────


class WorkflowDiscovery:
    """
    Discovers and caches per-project issue-workflow mappings.

    Parameters
    ----------
    oracle_dir : Path | str | None
        Directory where mapping files are persisted.  Defaults to
        ``.oracle/`` relative to the current working directory.
    """

    def __init__(self, oracle_dir: Optional[Path | str] = None) -> None:
        self.oracle_dir: Path = (
            Path(oracle_dir) if oracle_dir is not None else Path.cwd() / ".oracle"
        )

    # ── public ────────────────────────────────────────────────────────────────

    def discover(
        self,
        project_key: str,
        *,
        refresh: bool = False,
        dry_run: bool = False,
    ) -> WorkflowMapping:
        """
        Discover the workflow for *project_key* and persist the result.

        Parameters
        ----------
        project_key : str
            Jira project key (e.g. ``"OPTUM"``) or GitHub repo slug
            (``"owner/repo"``).
        refresh : bool
            Re-discover even if a cached mapping exists.  Preserves existing
            ``semantic_roles`` unless status names changed.
        dry_run : bool
            Compute and return the mapping without writing it to disk.

        Returns
        -------
        WorkflowMapping
        """
        cached = None if refresh else self._load_cached(project_key)
        if cached is not None:
            return cached

        if "/" in project_key:
            mapping = self._fetch_github(project_key)
        else:
            mapping = self._fetch_jira(project_key)

        # Preserve user-confirmed semantic roles from any previous mapping.
        if refresh:
            prev = self._load_cached(project_key)
            if prev and prev.role_annotations_confirmed:
                # Keep confirmed roles; only update unconfirmed ones via heuristics.
                for role, sr in prev.semantic_roles.items():
                    mapping.semantic_roles.setdefault(role, sr)
                mapping.role_annotations_confirmed = True

        mapping = self._apply_heuristics(mapping)

        if not dry_run:
            self._write(mapping)

        return mapping

    def show(self, project_key: str) -> Optional[WorkflowMapping]:
        """Return the persisted mapping for *project_key*, or None if absent."""
        return self._load_cached(project_key)

    def resolve_role(self, project_key: str, role: str) -> Optional[str]:
        """
        Return the status name that corresponds to *role* in *project_key*.

        Returns ``None`` if the mapping is missing or the role is not set.
        Does NOT trigger auto-discovery — callers must handle ``None``.
        """
        mapping = self._load_cached(project_key)
        if mapping is None:
            return None
        sr = mapping.semantic_roles.get(role)
        return sr.status_name if sr else None

    # ── private: persistence ──────────────────────────────────────────────────

    def _mapping_path(self, project_key: str) -> Path:
        safe_key = re.sub(r"[^A-Za-z0-9_\-]", "_", project_key)
        return self.oracle_dir / f"workflow-{safe_key}.json"

    def _load_cached(self, project_key: str) -> Optional[WorkflowMapping]:
        path = self._mapping_path(project_key)
        if not path.exists():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return WorkflowMapping.from_dict(data)
        except (json.JSONDecodeError, KeyError, TypeError):
            return None

    def _write(self, mapping: WorkflowMapping) -> None:
        self.oracle_dir.mkdir(parents=True, exist_ok=True)
        path = self._mapping_path(mapping.project_key)
        path.write_text(mapping.to_json(), encoding="utf-8")

    # ── private: Jira ─────────────────────────────────────────────────────────

    def _fetch_jira(self, project_key: str) -> WorkflowMapping:
        """
        Fetch issue types and transitions for *project_key* from the Jira
        REST API.

        Requires env vars:
          ATLASSIAN_URL   — e.g. https://acme.atlassian.net
          ATLASSIAN_USER  — email address
          ATLASSIAN_TOKEN — API token (not password)
        """
        base_url = os.environ.get("ATLASSIAN_URL", "").rstrip("/")
        user = os.environ.get("ATLASSIAN_USER", "")
        token = os.environ.get("ATLASSIAN_TOKEN", "")

        if not all([base_url, user, token]):
            raise WorkflowDiscoveryError(
                "Jira credentials not configured.  Set ATLASSIAN_URL, "
                "ATLASSIAN_USER, and ATLASSIAN_TOKEN environment variables.\n"
                "Tip: add them to .oracle/company.local.json or your shell profile."
            )

        auth = b64encode(f"{user}:{token}".encode()).decode()
        headers = {
            "Authorization": f"Basic {auth}",
            "Accept": "application/json",
        }
        # Capture the URL so ticket_updater can use it without requiring the env var.
        discovered_base_url = base_url

        # 1. Get issue types for this project.
        issue_types_raw = self._jira_get(
            f"{base_url}/rest/api/3/project/{project_key}/issuetypes", headers
        )
        if isinstance(issue_types_raw, dict) and "errorMessages" in issue_types_raw:
            raise WorkflowDiscoveryError(
                f"Jira project {project_key!r} not found or access denied: "
                f"{issue_types_raw['errorMessages']}"
            )

        issue_types: list[IssueType] = []
        for it_raw in issue_types_raw if isinstance(issue_types_raw, list) else []:
            it_id = str(it_raw.get("id", ""))
            it_name = str(it_raw.get("name", ""))
            if not it_name:
                continue

            # 2. Get statuses for this issue type.
            statuses_raw = self._jira_get(
                f"{base_url}/rest/api/3/project/{project_key}/statuses",
                headers,
            )
            statuses = self._parse_statuses(statuses_raw, it_name)

            # 3. Try to get transitions by sampling one issue of this type.
            transitions = self._sample_transitions(
                base_url, headers, project_key, it_name
            )

            issue_types.append(
                IssueType(id=it_id, name=it_name, statuses=statuses, transitions=transitions)
            )

        return WorkflowMapping(
            project_key=project_key,
            source="jira",
            discovered_at=_now_iso(),
            issue_types=issue_types,
            atlassian_url=discovered_base_url,
        )

    def _parse_statuses(
        self, statuses_raw: list | dict, issue_type_name: str
    ) -> list[StatusEntry]:
        """Extract StatusEntry list from the /project/{key}/statuses response."""
        if not isinstance(statuses_raw, list):
            return []
        for entry in statuses_raw:
            if entry.get("name", "").lower() == issue_type_name.lower():
                return [
                    StatusEntry(
                        id=str(s.get("id", "")),
                        name=s.get("name", ""),
                        category=s.get("statusCategory", {}).get("key", "indeterminate"),
                    )
                    for s in entry.get("statuses", [])
                ]
        # Fallback: return all statuses from all types (deduplicated by name).
        seen: set[str] = set()
        result: list[StatusEntry] = []
        for entry in statuses_raw:
            for s in entry.get("statuses", []):
                name = s.get("name", "")
                if name and name not in seen:
                    seen.add(name)
                    result.append(
                        StatusEntry(
                            id=str(s.get("id", "")),
                            name=name,
                            category=s.get("statusCategory", {}).get(
                                "key", "indeterminate"
                            ),
                        )
                    )
        return result

    def _sample_transitions(
        self,
        base_url: str,
        headers: dict,
        project_key: str,
        issue_type_name: str,
    ) -> list[TransitionEntry]:
        """
        Get transitions by finding one open issue of the given type and calling
        GET /rest/api/3/issue/{key}/transitions.

        Returns an empty list if no matching issue is found or the call fails.
        """
        jql = (
            f"project = {project_key} AND issuetype = \"{issue_type_name}\" "
            f"AND statusCategory != Done ORDER BY created DESC"
        )
        params = urllib.parse.urlencode({"jql": jql, "maxResults": 1, "fields": "id"})
        try:
            search_result = self._jira_get(
                f"{base_url}/rest/api/3/issue/search?{params}", headers
            )
        except (WorkflowDiscoveryError, urllib.error.URLError):
            return []

        issues = search_result.get("issues", []) if isinstance(search_result, dict) else []
        if not issues:
            return []

        issue_key = issues[0].get("key", "")
        if not issue_key:
            return []

        try:
            transitions_raw = self._jira_get(
                f"{base_url}/rest/api/3/issue/{issue_key}/transitions", headers
            )
        except (WorkflowDiscoveryError, urllib.error.URLError):
            return []

        return [
            TransitionEntry(
                id=str(t.get("id", "")),
                name=t.get("name", ""),
                from_status=t.get("from", {}).get("name", "") if isinstance(t.get("from"), dict) else "",
                to_status=t.get("to", {}).get("name", "") if isinstance(t.get("to"), dict) else "",
            )
            for t in transitions_raw.get("transitions", [])
            if isinstance(transitions_raw, dict)
        ]

    def _jira_get(self, url: str, headers: dict) -> list | dict:
        """Perform a GET request and return the parsed JSON body."""
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise WorkflowDiscoveryError(
                f"Jira API error {exc.code} for {url}: {body[:200]}"
            ) from exc
        except urllib.error.URLError as exc:
            raise WorkflowDiscoveryError(
                f"Network error calling Jira API: {exc.reason}"
            ) from exc

    # ── private: GitHub ───────────────────────────────────────────────────────

    def _fetch_github(self, repo_slug: str) -> WorkflowMapping:
        """
        Fetch project board columns for *repo_slug* (``"owner/repo"``) via the
        ``gh`` CLI.

        Falls back to a synthetic single-column mapping if no project board is
        configured.
        """
        import subprocess  # noqa: PLC0415 — lazy import to keep startup fast

        try:
            result = subprocess.run(
                [
                    "gh", "api",
                    f"repos/{repo_slug}/projects",
                    "--jq", ".[0].columns_url // empty",
                ],
                capture_output=True,
                text=True,
                timeout=10,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
            raise WorkflowDiscoveryError(
                "GitHub CLI (gh) is not installed or timed out.  "
                "Install gh and run `gh auth login` before discovering GitHub workflows."
            ) from exc

        if result.returncode != 0 or not result.stdout.strip():
            # No project board found — synthesize a minimal "open / closed" mapping.
            return WorkflowMapping(
                project_key=repo_slug,
                source="github",
                discovered_at=_now_iso(),
                issue_types=[
                    IssueType(
                        id="github_issue",
                        name="GitHub Issue",
                        statuses=[
                            StatusEntry(id="open",   name="Open",   category="new"),
                            StatusEntry(id="closed", name="Closed", category="done"),
                        ],
                    )
                ],
            )

        columns_url = result.stdout.strip()
        try:
            col_result = subprocess.run(
                ["gh", "api", columns_url, "--jq", "[.[] | {id: .id|tostring, name: .name}]"],
                capture_output=True,
                text=True,
                timeout=10,
            )
        except subprocess.TimeoutExpired as exc:
            raise WorkflowDiscoveryError("gh API timed out fetching project columns") from exc

        columns: list[dict] = json.loads(col_result.stdout) if col_result.returncode == 0 else []

        statuses = [
            StatusEntry(
                id=col["id"],
                name=col["name"],
                category="done" if re.search(r"done|closed|merged|shipped", col["name"], re.I) else "indeterminate",
            )
            for col in columns
        ]

        return WorkflowMapping(
            project_key=repo_slug,
            source="github",
            discovered_at=_now_iso(),
            issue_types=[
                IssueType(id="github_issue", name="GitHub Issue", statuses=statuses)
            ],
        )

    # ── private: heuristics ───────────────────────────────────────────────────

    def _apply_heuristics(self, mapping: WorkflowMapping) -> WorkflowMapping:
        """
        Assign semantic roles by matching status names against *_ROLE_TRIGGERS*.

        Iterates roles in priority order.  Each role is set at most once,
        using the first matching status found across all issue types.
        """
        # Collect all (issue_type_name, status_name) pairs.
        candidates: list[tuple[str, str]] = [
            (it.name, s.name)
            for it in mapping.issue_types
            for s in it.statuses
        ]

        assigned: dict[str, SemanticRole] = {}
        for role in _ROLE_PRIORITY:
            if role in mapping.semantic_roles:
                # Already set (e.g. from a previous confirmed mapping).
                continue
            triggers = _ROLE_TRIGGERS.get(role, [])
            for it_name, status_name in candidates:
                low = status_name.lower()
                if any(trigger in low for trigger in triggers):
                    assigned[role] = SemanticRole(
                        status_name=status_name, issue_type=it_name
                    )
                    break  # first match wins for this role

        mapping.semantic_roles = {**assigned, **mapping.semantic_roles}
        return mapping


# ── module-level convenience ──────────────────────────────────────────────────


def resolve_role(
    project_key: str,
    role: str,
    oracle_dir: Optional[Path | str] = None,
) -> Optional[str]:
    """
    Return the Jira status name (or GitHub board column) that corresponds to
    *role* in the persisted workflow mapping for *project_key*.

    Returns ``None`` if the mapping file is missing or the role is unset.
    Callers must not hardcode a default — surface the ``None`` to the user.

    Example
    -------
    >>> from agent.core.workflow_discovery import resolve_role
    >>> transition_name = resolve_role("OPTUM", "qa_passed")
    >>> if transition_name is None:
    ...     raise RuntimeError("Run oracle workflow-discover --project OPTUM first")
    """
    return WorkflowDiscovery(oracle_dir=oracle_dir).resolve_role(project_key, role)


def atlassian_url_for(
    project_key: str,
    oracle_dir: Optional[Path | str] = None,
) -> Optional[str]:
    """
    Return the Atlassian base URL for *project_key* from the persisted mapping,
    or ``None`` if the mapping is missing or has no stored URL.

    Used by ``ticket_updater`` so each project can point at a different Atlassian
    instance.  Falls back to the ``ATLASSIAN_URL`` environment variable at the
    call site when this returns ``None``.
    """
    mapping = WorkflowDiscovery(oracle_dir=oracle_dir).show(project_key)
    return mapping.atlassian_url if mapping else None


# ── helpers ───────────────────────────────────────────────────────────────────


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat(timespec="seconds")
