# agent/core/company_knowledge.py

"""
CompanyKnowledge — load and validate .canary/company.json.

Stores *pointers only* (Confluence space keys, Jira project keys, internal
URLs, MCP server identifiers, Claude Code skill slugs, free-text notes).
No proprietary content is ever committed here; AI agents retrieve actual
content at runtime via configured MCP servers or authenticated tooling.

## Merge cascade (lowest → highest priority)

1. ~/.canary/company.json          — org-wide defaults
2. .canary/company.json            — project-local config
3. .canary/company.<env>.json      — environment override (CANARY_ENV or explicit)

List fields are unioned across sources; scalar fields (dashboard_url,
dashboard_token_env, notes) are replaced by the highest-priority source
that sets them.
"""

from __future__ import annotations

import json
import os
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

_KNOWN_KEYS = {
    "confluence_spaces",
    "jira_projects",
    "internal_doc_urls",
    "internal_domains",
    "mcp_servers",
    "claude_code_skills",
    "dashboard_url",
    "dashboard_token_env",
    "otel_exporter_endpoint",
    "notes",
    "brand",
}

_HEX_COLOR_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")
_BRAND_TEXT_MAX = 200


def _validate_strings(
    raw: object,
    field_name: str,
    validate,
    transform=None,
    warnings=None,
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


_OTEL_SCHEMES = ("http", "https", "grpc", "grpcs")


def _validate_otel_endpoint(raw: object, field_name: str, warnings: list[str]) -> str:
    """Validate an OTLP exporter endpoint — http/https/grpc/grpcs + a netloc.

    An empty string is the documented "use the file-exporter default" value and
    is accepted silently (no endpoint configured); it is not treated as invalid.
    """
    if not isinstance(raw, str):
        warnings.append(f"{field_name}: expected string, got {type(raw).__name__} — skipped")
        return ""
    if not raw.strip():
        return ""
    if _looks_like_secret(raw):
        raise _SecretDetected(field_name, raw)
    parsed = urlparse(raw)
    if parsed.scheme not in _OTEL_SCHEMES or not parsed.netloc:
        warnings.append(f"{field_name}: dropped invalid endpoint {raw!r}")
        return ""
    return raw


def _validate_hex_color(raw: object, field_name: str, warnings: list[str]) -> str:
    """Accept #RGB / #RRGGBB (any case); drop anything else with a warning."""
    if not isinstance(raw, str) or not raw:
        return ""
    if _HEX_COLOR_RE.match(raw):
        return raw
    warnings.append(f"{field_name}: dropped invalid hex color {raw!r}")
    return ""


def _brand_text(raw: object, field_name: str, warnings: list[str]) -> str:
    """A short free-text brand field. Rejects secret-prefixed values; caps length."""
    if not isinstance(raw, str):
        if raw is not None:
            warnings.append(f"{field_name}: expected string, got {type(raw).__name__} — skipped")
        return ""
    if _SECRET_PREFIX.match(raw):
        raise _SecretDetected(field_name, raw)
    return raw.strip()[:_BRAND_TEXT_MAX]


class _SecretDetected(Exception):
    def __init__(self, field_name: str, value: str) -> None:
        self.field_name = field_name
        self.value = value
        super().__init__(f"secret-like value in {field_name!r}")


# ── brand assets (customer-facing report theming, #340c) ──────────────────────


@dataclass
class Brand:
    """Brand assets a customer-facing report generator may consult.

    Pointers/styling only — a logo URL and colors, never binary assets or
    secrets. The engine surfaces these; the report generator (a skill or a
    downstream overlay) owns the actual HTML/visual skin.
    """
    company_name: str = ""
    logo_url: str = ""
    primary_color: str = ""
    secondary_color: str = ""
    footer_note: str = ""

    @property
    def is_empty(self) -> bool:
        return not any([
            self.company_name,
            self.logo_url,
            self.primary_color,
            self.secondary_color,
            self.footer_note,
        ])

    def to_dict(self) -> dict:
        return {
            "company_name": self.company_name,
            "logo_url": self.logo_url,
            "primary_color": self.primary_color,
            "secondary_color": self.secondary_color,
            "footer_note": self.footer_note,
        }


def _parse_brand(raw: object, warnings: list[str]) -> Brand:
    """Validate a raw ``brand`` object. Absent/non-dict → empty Brand (no error)."""
    if not isinstance(raw, dict):
        if raw is not None:
            warnings.append(f"brand: expected object, got {type(raw).__name__} — skipped")
        return Brand()
    logo_url = _validate_url(raw["logo_url"], "brand.logo_url", warnings) if "logo_url" in raw else ""
    return Brand(
        company_name=_brand_text(raw.get("company_name"), "brand.company_name", warnings),
        logo_url=logo_url,
        primary_color=_validate_hex_color(raw.get("primary_color", ""), "brand.primary_color", warnings),
        secondary_color=_validate_hex_color(raw.get("secondary_color", ""), "brand.secondary_color", warnings),
        footer_note=_brand_text(raw.get("footer_note"), "brand.footer_note", warnings),
    )


def _merge_brand(layers: "list[_Layer]") -> Brand:
    """Merge brand per-field: highest-priority layer that sets a field wins."""
    b = Brand()
    for layer in layers:
        lb = layer.brand
        b.company_name = lb.company_name or b.company_name
        b.logo_url = lb.logo_url or b.logo_url
        b.primary_color = lb.primary_color or b.primary_color
        b.secondary_color = lb.secondary_color or b.secondary_color
        b.footer_note = lb.footer_note or b.footer_note
    return b


# ── raw validated layer ───────────────────────────────────────────────────────


@dataclass
class _Layer:
    """One validated source file's worth of data."""
    confluence_spaces: list[str] = field(default_factory=list)
    jira_projects: list[str] = field(default_factory=list)
    internal_doc_urls: list[str] = field(default_factory=list)
    internal_domains: list[str] = field(default_factory=list)
    mcp_servers: list[str] = field(default_factory=list)
    claude_code_skills: list[str] = field(default_factory=list)
    dashboard_url: str = ""
    dashboard_token_env: str = ""
    otel_exporter_endpoint: str = ""
    notes: str = ""
    brand: Brand = field(default_factory=Brand)
    warnings: list[str] = field(default_factory=list)
    source: str = ""


def _parse_layer(data: dict, source: str) -> _Layer:
    """Validate a raw JSON dict into a _Layer. Raises _SecretDetected on secrets."""
    warns: list[str] = []

    confluence_spaces = _validate_strings(
        data.get("confluence_spaces", []), "confluence_spaces",
        lambda v: bool(_SPACE_OR_PROJECT_RE.match(v)), str.upper, warns,
    )
    jira_projects = _validate_strings(
        data.get("jira_projects", []), "jira_projects",
        lambda v: bool(_SPACE_OR_PROJECT_RE.match(v)), str.upper, warns,
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
        data.get("internal_domains", []), "internal_domains",
        lambda v: bool(_DOMAIN_RE.match(v)), str.lower, warns,
    )
    mcp_servers = _validate_strings(
        data.get("mcp_servers", []), "mcp_servers",
        lambda v: bool(_MCP_SERVER_RE.match(v)), None, warns,
    )
    claude_code_skills = _validate_strings(
        data.get("claude_code_skills", []), "claude_code_skills",
        lambda v: bool(_SKILL_RE.match(v)), str.lower, warns,
    )

    dashboard_url = ""
    if "dashboard_url" in data:
        dashboard_url = _validate_url(data["dashboard_url"], "dashboard_url", warns)

    dashboard_token_env = ""
    if "dashboard_token_env" in data:
        raw_env = data["dashboard_token_env"]
        if isinstance(raw_env, str):
            if _looks_like_secret(raw_env):
                raise _SecretDetected("dashboard_token_env", raw_env)
            if _ENV_VAR_RE.match(raw_env):
                dashboard_token_env = raw_env
            else:
                warns.append(f"dashboard_token_env: dropped invalid env-var name {raw_env!r}")

    otel_exporter_endpoint = ""
    if "otel_exporter_endpoint" in data:
        otel_exporter_endpoint = _validate_otel_endpoint(
            data["otel_exporter_endpoint"], "otel_exporter_endpoint", warns
        )

    notes = ""
    if "notes" in data:
        raw_notes = data["notes"]
        if isinstance(raw_notes, str):
            notes = _FENCE_RE.sub("", raw_notes).strip()[:_NOTES_MAX]

    brand = _parse_brand(data.get("brand"), warns)

    for k in sorted(set(data) - _KNOWN_KEYS):
        warns.append(f"ignored unknown field: {k}")

    return _Layer(
        confluence_spaces=confluence_spaces,
        jira_projects=jira_projects,
        internal_doc_urls=internal_doc_urls,
        internal_domains=internal_domains,
        mcp_servers=mcp_servers,
        claude_code_skills=claude_code_skills,
        dashboard_url=dashboard_url,
        dashboard_token_env=dashboard_token_env,
        otel_exporter_endpoint=otel_exporter_endpoint,
        notes=notes,
        brand=brand,
        warnings=warns,
        source=source,
    )


def _load_layer(path: Path, label: str) -> tuple[Optional[_Layer], str]:
    """Read and parse one source file. Returns (layer, error_msg)."""
    if not path.exists():
        return None, ""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        return None, f"{label}: {exc}"
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        return None, f"{label}: {exc}"
    if not isinstance(data, dict):
        return None, f"{label}: expected JSON object at root"
    try:
        return _parse_layer(data, label), ""
    except _SecretDetected as exc:
        msg = (
            f"[red]![/red] {label} contains a secret-like value in "
            f"{exc.field_name!r} — remove it and store secrets in environment variables"
        )
        return None, msg


def _union(a: list[str], b: list[str]) -> list[str]:
    seen: set[str] = set(a)
    out = list(a)
    for v in b:
        if v not in seen:
            seen.add(v)
            out.append(v)
    return out


def _merge_layers(layers: list[_Layer]) -> dict:
    """Merge ordered layers (lowest → highest priority) into a single field dict."""
    confluence_spaces: list[str] = []
    jira_projects: list[str] = []
    internal_doc_urls: list[str] = []
    internal_domains: list[str] = []
    mcp_servers: list[str] = []
    claude_code_skills: list[str] = []
    dashboard_url = ""
    dashboard_token_env = ""
    otel_exporter_endpoint = ""
    notes = ""
    warns: list[str] = []
    sources: list[str] = []

    for layer in layers:
        confluence_spaces = _union(confluence_spaces, layer.confluence_spaces)
        jira_projects = _union(jira_projects, layer.jira_projects)
        internal_doc_urls = _union(internal_doc_urls, layer.internal_doc_urls)
        internal_domains = _union(internal_domains, layer.internal_domains)
        mcp_servers = _union(mcp_servers, layer.mcp_servers)
        claude_code_skills = _union(claude_code_skills, layer.claude_code_skills)
        if layer.dashboard_url:
            dashboard_url = layer.dashboard_url
        if layer.dashboard_token_env:
            dashboard_token_env = layer.dashboard_token_env
        if layer.otel_exporter_endpoint:
            otel_exporter_endpoint = layer.otel_exporter_endpoint
        if layer.notes:
            notes = layer.notes
        warns.extend(layer.warnings)
        if layer.source:
            sources.append(layer.source)

    return dict(
        confluence_spaces=confluence_spaces,
        jira_projects=jira_projects,
        internal_doc_urls=internal_doc_urls,
        internal_domains=internal_domains,
        mcp_servers=mcp_servers,
        claude_code_skills=claude_code_skills,
        dashboard_url=dashboard_url,
        dashboard_token_env=dashboard_token_env,
        otel_exporter_endpoint=otel_exporter_endpoint,
        notes=notes,
        brand=_merge_brand(layers),
        warnings=warns,
        sources=sources,
    )


# ── public dataclass ──────────────────────────────────────────────────────────


@dataclass
class CompanyKnowledge:
    confluence_spaces: list[str] = field(default_factory=list)
    jira_projects: list[str] = field(default_factory=list)
    internal_doc_urls: list[str] = field(default_factory=list)
    internal_domains: list[str] = field(default_factory=list)
    mcp_servers: list[str] = field(default_factory=list)
    claude_code_skills: list[str] = field(default_factory=list)
    dashboard_url: str = ""
    dashboard_token_env: str = ""
    otel_exporter_endpoint: str = ""
    notes: str = ""
    brand: Brand = field(default_factory=Brand)
    warnings: list[str] = field(default_factory=list)
    sources: list[str] = field(default_factory=list)
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
            self.dashboard_url,
            self.notes,
            not self.brand.is_empty,
        ])

    # ── factory ──────────────────────────────────────────────────────────────

    @classmethod
    def load(
        cls,
        root: Optional[Path] = None,
        env: Optional[str] = None,
    ) -> "CompanyKnowledge":
        """Load and merge the company-knowledge cascade.

        Sources (lowest → highest priority):
          1. ~/.canary/company.json          — org-wide defaults
          2. <root>/.canary/company.json     — project-local
          3. <root>/.canary/company.<env>.json — environment override

        *env* defaults to the ``CANARY_ENV`` environment variable when not
        passed explicitly. If neither is set, the env layer is skipped.

        Returns an empty instance when no source files exist.
        Returns an instance with .error set when a secret is detected in any
        layer (that layer is skipped; earlier layers are still merged).
        """
        base = root or Path.cwd()
        resolved_env = env or os.environ.get("CANARY_ENV", "")

        candidates = [
            (Path.home() / ".canary" / "company.json", "~/.canary/company.json"),
            (base / ".canary" / "company.json", ".canary/company.json"),
        ]
        if resolved_env:
            candidates.append((
                base / ".canary" / f"company.{resolved_env}.json",
                f".canary/company.{resolved_env}.json",
            ))

        layers: list[_Layer] = []
        errors: list[str] = []

        for path, label in candidates:
            layer, err = _load_layer(path, label)
            if err:
                _warn(err)
                errors.append(err)
                continue
            if layer is not None:
                for w in layer.warnings:
                    _warn(f"[yellow]![/yellow] {label}: {w}")
                layers.append(layer)

        if not layers:
            instance = cls()
            if errors:
                instance.error = errors[0]
            return instance

        merged = _merge_layers(layers)
        instance = cls(**merged)
        if errors:
            instance.error = errors[0]
        return instance

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
            "dashboard_url": self.dashboard_url,
            "dashboard_token_env": self.dashboard_token_env,
            "otel_exporter_endpoint": self.otel_exporter_endpoint,
            "notes": self.notes,
            "brand": self.brand.to_dict(),
            "sources": self.sources,
            "warnings": self.warnings,
            **({"error": self.error} if self.error else {}),
        }

    # ── report branding hook (#340c) ───────────────────────────────────────────

    def report_branding(self, flavor: Optional[bool] = None) -> dict:
        """Brand assets + attribution for a customer-facing report generator.

        Report generators (a skill or a downstream overlay) call this when
        producing external/customer-facing output, then apply the assets as
        their own visual skin — the engine supplies the data, the overlay owns
        the pixels.

        ``attribution`` ("made with Canary") is always present. ``voice_line``
        is optional garnish, included only when *flavor* is on. Flavor
        resolution: explicit *flavor* arg wins; otherwise a truthy
        ``CANARY_NO_FLAVOR`` / ``NO_FLAVOR`` env var turns it off; default on.
        """
        on = _resolve_flavor(flavor)
        return {
            "company_name": self.brand.company_name,
            "logo_url": self.brand.logo_url,
            "primary_color": self.brand.primary_color,
            "secondary_color": self.brand.secondary_color,
            "footer_note": self.brand.footer_note,
            "attribution": _ATTRIBUTION,
            "voice_line": _VOICE_LINE if on else "",
            "flavor": on,
        }


# ── internal helpers ──────────────────────────────────────────────────────────

_ATTRIBUTION = "made with Canary"
# Voice is garnish, never load-bearing (#340). One tasteful Oracle line.
_VOICE_LINE = "Oracle: eyes on every test."
_FLAVOR_OFF_ENV = ("CANARY_NO_FLAVOR", "NO_FLAVOR")
_FALSEY = {"", "0", "false", "no", "off"}


def _env_truthy(val: Optional[str]) -> bool:
    return val is not None and val.strip().lower() not in _FALSEY


def _resolve_flavor(flavor: Optional[bool]) -> bool:
    """Explicit arg wins; else a truthy off-switch env var disables; else on."""
    if flavor is not None:
        return flavor
    if any(_env_truthy(os.environ.get(var)) for var in _FLAVOR_OFF_ENV):
        return False
    return True


def _warn(msg: str) -> None:
    from rich import print as rprint
    rprint(msg, file=sys.stderr)
