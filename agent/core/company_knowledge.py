# agent/core/company_knowledge.py

"""
CompanyKnowledge — load and validate .canary/company.json.

Stores *pointers only* (Confluence space keys, Jira project keys, internal
URLs, MCP server identifiers, Claude Code skill slugs, free-text notes).
No proprietary content is ever committed here; AI agents retrieve actual
content at runtime via configured MCP servers or authenticated tooling.
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse


# ── secret heuristic ─────────────────────────────────────────────────────────

_SECRET_PREFIX = re.compile(r"(?i)^(sk-|api[_-]?key|token|secret|bearer)")
_MAX_NON_NOTES_LEN = 128


def _looks_like_secret(value: str) -> bool:
    return bool(_SECRET_PREFIX.match(value)) or len(value) > _MAX_NON_NOTES_LEN


# ── field validators ─────────────────────────────────────────────────────────

_SPACE_OR_PROJECT_RE = re.compile(r"^[A-Z0-9]{1,32}$")
_DOMAIN_RE = re.compile(r"^[a-z0-9.-]+\.[a-z]{2,}$")
_MCP_SERVER_RE = re.compile(r"^[A-Za-z0-9_-]+$")
_SKILL_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*(?::[a-z0-9][a-z0-9_-]*)?$")
_ENV_VAR_RE = re.compile(r"^[A-Z][A-Z0-9_]*$")
_NOTES_MAX = 2048
_FENCE_RE = re.compile(r"```[^`]*```", re.DOTALL)


def _validate_strings(
    raw: object,
    field_name: str,
    validate: "Callable[[str], bool]",
    transform: "Callable[[str], str] | None" = None,
    warnings: "list[str] | None" = None,
) -> list[str]:
    if not isinstance(raw, list):
        if warnings is not None:
            warnings.append(f"{field_name}: expected list, got {type(raw).__name__} — skipped")
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, str):
            continue
        val = transform(item) if transform else item
        if _looks_like_secret(val):
            raise _SecretDetected(field_name, val)
        if not validate(val):
            if warnings is not None:
                warnings.append(f"{field_name}: dropped invalid entry {item!r}")
            continue
        if val not in seen:
            seen.add(val)
            out.append(val)
    return out


def _validate_url(raw: object, field_name: str, warnings: list[str]) -> str:
    if not isinstance(raw, str):
        warnings.append(f"{field_name}: expected string, got {type(raw).__name__} — skipped")
        return ""
    if _looks_like_secret(raw):
        raise _SecretDetected(field_name, raw)
    parsed = urlparse(raw)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        warnings.append(f"{field_name}: dropped invalid URL {raw!r}")
        return ""
    return raw


class _SecretDetected(Exception):
    def __init__(self, field_name: str, value: str) -> None:
        self.field_name = field_name
        self.value = value
        super().__init__(f"secret-like value in {field_name!r}")


# ── dataclass ─────────────────────────────────────────────────────────────────


@dataclass
class CompanyKnowledge:
    confluence_spaces: list[str] = field(default_factory=list)
    jira_projects: list[str] = field(default_factory=list)
    internal_doc_urls: list[str] = field(default_factory=list)
    internal_domains: list[str] = field(default_factory=list)
    mcp_servers: list[str] = field(default_factory=list)
    claude_code_skills: list[str] = field(default_factory=list)
    optum_dashboard_url: str = ""
    optum_dashboard_token_env: str = ""
    notes: str = ""
    warnings: list[str] = field(default_factory=list)
    error: str = ""

    @property
    def is_empty(self) -> bool:
        return not any([
            self.confluence_spaces,
            self.jira_projects,
            self.internal_doc_urls,
            self.internal_domains,
            self.mcp_servers,
            self.claude_code_skills,
            self.optum_dashboard_url,
            self.notes,
        ])

    # ── factory ──────────────────────────────────────────────────────────────

    @classmethod
    def load(cls, root: Optional[Path] = None) -> "CompanyKnowledge":
        """Load .canary/company.json from *root* (default: cwd).

        Returns an empty instance when the file is absent or unreadable.
        Returns an instance with .error set when a secret is detected.
        """
        base = root or Path.cwd()
        path = base / ".canary" / "company.json"

        if not path.exists():
            return cls()

        try:
            text = path.read_text(encoding="utf-8")
        except OSError as exc:
            instance = cls()
            instance.warnings.append(f".canary/company.json: {exc}")
            return instance

        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            instance = cls()
            _warn(f".canary/company.json: {exc}")
            return instance

        if not isinstance(data, dict):
            _warn(".canary/company.json: expected JSON object at root")
            return cls()

        warns: list[str] = []

        try:
            confluence_spaces = _validate_strings(
                data.get("confluence_spaces", []),
                "confluence_spaces",
                lambda v: bool(_SPACE_OR_PROJECT_RE.match(v)),
                str.upper,
                warns,
            )
            jira_projects = _validate_strings(
                data.get("jira_projects", []),
                "jira_projects",
                lambda v: bool(_SPACE_OR_PROJECT_RE.match(v)),
                str.upper,
                warns,
            )

            raw_urls = data.get("internal_doc_urls", [])
            internal_doc_urls: list[str] = []
            if isinstance(raw_urls, list):
                for u in raw_urls:
                    if not isinstance(u, str):
                        continue
                    validated = _validate_url(u, "internal_doc_urls", warns)
                    if validated:
                        internal_doc_urls.append(validated)

            internal_domains = _validate_strings(
                data.get("internal_domains", []),
                "internal_domains",
                lambda v: bool(_DOMAIN_RE.match(v)),
                str.lower,
                warns,
            )
            mcp_servers = _validate_strings(
                data.get("mcp_servers", []),
                "mcp_servers",
                lambda v: bool(_MCP_SERVER_RE.match(v)),
                None,
                warns,
            )
            claude_code_skills = _validate_strings(
                data.get("claude_code_skills", []),
                "claude_code_skills",
                lambda v: bool(_SKILL_RE.match(v)),
                str.lower,
                warns,
            )

            optum_dashboard_url = ""
            if "optum_dashboard_url" in data:
                optum_dashboard_url = _validate_url(
                    data["optum_dashboard_url"], "optum_dashboard_url", warns
                )

            optum_dashboard_token_env = ""
            if "optum_dashboard_token_env" in data:
                raw_env = data["optum_dashboard_token_env"]
                if isinstance(raw_env, str):
                    if _looks_like_secret(raw_env):
                        raise _SecretDetected("optum_dashboard_token_env", raw_env)
                    if _ENV_VAR_RE.match(raw_env):
                        optum_dashboard_token_env = raw_env
                    else:
                        warns.append(
                            f"optum_dashboard_token_env: dropped invalid env-var name {raw_env!r}"
                        )

            notes = ""
            if "notes" in data:
                raw_notes = data["notes"]
                if isinstance(raw_notes, str):
                    notes = _FENCE_RE.sub("", raw_notes).strip()[:_NOTES_MAX]

        except _SecretDetected as exc:
            instance = cls()
            msg = (
                f"[red]![/red] .canary/company.json contains a secret-like value in "
                f"{exc.field_name!r} — remove it and store secrets in environment variables"
            )
            _warn(msg)
            instance.error = msg
            return instance

        for w in warns:
            _warn(f"[yellow]![/yellow] .canary/company.json: {w}")

        return cls(
            confluence_spaces=confluence_spaces,
            jira_projects=jira_projects,
            internal_doc_urls=internal_doc_urls,
            internal_domains=internal_domains,
            mcp_servers=mcp_servers,
            claude_code_skills=claude_code_skills,
            optum_dashboard_url=optum_dashboard_url,
            optum_dashboard_token_env=optum_dashboard_token_env,
            notes=notes,
            warnings=warns,
        )

    # ── prompt injection ──────────────────────────────────────────────────────

    def prompt_block(self) -> str:
        """Return the '--- COMPANY KNOWLEDGE ---' section for prompt injection.

        Returns an empty string when is_empty is True.
        """
        if self.is_empty:
            return ""

        lines = ["--- COMPANY KNOWLEDGE ---", "Consult these company-internal sources when generating:"]

        mcp_hint = ""
        if self.mcp_servers:
            mcp_hint = f" (via {', '.join(self.mcp_servers)} MCP)"

        if self.confluence_spaces:
            lines.append(f"- Confluence spaces{mcp_hint}: {', '.join(self.confluence_spaces)}")
        if self.jira_projects:
            lines.append(f"- Jira projects{mcp_hint}: {', '.join(self.jira_projects)}")
        if self.internal_doc_urls:
            lines.append("- Reference docs (fetch via MCP / authenticated tool):")
            for url in self.internal_doc_urls:
                lines.append(f"    - {url}")
        if self.internal_domains:
            lines.append(f"- Internal domains: {', '.join(self.internal_domains)}")
        if self.claude_code_skills:
            skill_list = ", ".join(f"/{s}" for s in self.claude_code_skills)
            lines.append(
                f"- Claude Code skills available for this project: {skill_list}. "
                "Invoke the relevant skill when its scope matches the task."
            )
        if self.notes:
            lines.append(f"- Notes from the project owner: {self.notes}")

        lines.append(
            "Do not invent internal URLs, project keys, or hostnames. If a piece of\n"
            "context isn't covered above, say so in a comment rather than guessing."
        )
        return "\n".join(lines)

    # ── serialisation ─────────────────────────────────────────────────────────

    def to_dict(self) -> dict:
        return {
            "is_empty": self.is_empty,
            "confluence_spaces": self.confluence_spaces,
            "jira_projects": self.jira_projects,
            "internal_doc_urls": self.internal_doc_urls,
            "internal_domains": self.internal_domains,
            "mcp_servers": self.mcp_servers,
            "claude_code_skills": self.claude_code_skills,
            "optum_dashboard_url": self.optum_dashboard_url,
            "optum_dashboard_token_env": self.optum_dashboard_token_env,
            "notes": self.notes,
            "warnings": self.warnings,
            **({"error": self.error} if self.error else {}),
        }


# ── internal helpers ──────────────────────────────────────────────────────────


def _warn(msg: str) -> None:
    from rich import print as rprint
    rprint(msg, file=sys.stderr)
