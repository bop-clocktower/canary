"""Deterministic emit for the harness reverse-handoff (#899) producer contract.

Phase 5 turns the guardian's Tier-0 result into a **structured canary analysis**
that a future harness gate surface can consume in-flow. This module owns the
producer half:

  * :func:`analysis_filename` — the ``canary-pr-guardian-<ref>.json`` naming
    convention. The ``canary-pr-guardian-`` prefix is load-bearing: harness's own
    ``AnalysisArchive`` stores records as ``<issueId>.json`` and reads *every*
    ``*.json`` in ``.harness/analyses/``, so the prefix + sanitized ref
    namespaces canary's records — they never clobber a harness intelligence
    record and always pass ``AnalysisArchive.safePath`` (no traversal).
  * :func:`build_analysis_record` — the v1.0 envelope wrapping the verbatim
    ``render(fmt="json")`` findings array.

**SC-11 boundary:** this module is deterministic filesystem/JSON only. It imports
**no** ``AgentTier``/LLM-SDK module (only intra-guardian, agent-free helpers) and
is scanned by ``tests/unit/test_guardian_capability_boundary.py`` (``_MODULES``).
"""

from __future__ import annotations

import json
import re
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from agent.guardian.pr_check import Finding, render  # intra-guardian, agent-free

SCHEMA_VERSION = "1.0"
SOURCE = "canary-pr-guardian"
_REF_SAFE = re.compile(r"[^A-Za-z0-9._-]")


def analysis_filename(ref: str, source: str = SOURCE) -> str:
    """``<source>-<sanitized-ref>.json``; empty/blank ref → ``<source>-local.json``.

    Prefixing namespaces canary records so they never clobber harness's own
    ``<issueId>.json`` records and always pass ``AnalysisArchive.safePath``.
    """
    safe = _REF_SAFE.sub("-", ref).strip("-") or "local"
    return f"{source}-{safe}.json"


def build_analysis_record(
    findings: list[Finding],
    *,
    ref: str,
    gate: str,
    effective_tier: int,
    degraded_notice: str | None,
    exit_code: int,
    analyzed_at: str | None = None,
) -> dict:
    """Build the v1.0 envelope. ``findings`` is exactly ``render(fmt='json')``'s array."""
    inner = json.loads(
        render(
            findings,
            fmt="json",
            tier=effective_tier,
            degraded_notice=degraded_notice,
        )
    )
    active = [f for f in findings if not f.suppressed]
    suppressed = [f for f in findings if f.suppressed]
    by_fidelity = Counter(f.fidelity.value for f in findings)
    return {
        "schemaVersion": SCHEMA_VERSION,
        "source": SOURCE,
        "ref": ref,
        "gate": gate,
        "exitCode": exit_code,
        "tier": effective_tier,
        "degradedNotice": degraded_notice,
        "summary": {
            "total": len(findings),
            "unaddressed": len(active),
            "suppressed": len(suppressed),
            "byFidelity": dict(by_fidelity),
        },
        "findings": inner["findings"],
        "analyzedAt": analyzed_at or datetime.now(timezone.utc).isoformat(),
    }


@dataclass(frozen=True)
class EmitResult:
    """Outcome of an emit attempt.

    ``action`` is ``'emitted'`` | ``'unavailable'``. ``path`` is the written file
    (``None`` when unavailable); ``notice`` is the LOUD fallback message, set only
    when unavailable (the CLI turns it into the SC-10 sticky-comment fallback).
    """

    action: str
    path: str | None
    notice: str | None = None


def channel_available(analyses_dir: Path) -> bool:
    """True iff the harness home (``analyses_dir.parent``, i.e. ``.harness/``) exists.

    The analyses dir itself is created on demand by :func:`emit_analysis`
    (mirroring harness ``AnalysisArchive.save``'s recursive ``mkdir``).
    """
    return analyses_dir.parent.is_dir()


def emit_analysis(
    findings: list[Finding],
    *,
    analyses_dir: Path,
    ref: str,
    gate: str,
    effective_tier: int,
    degraded_notice: str | None,
    exit_code: int,
    analyzed_at: str | None = None,
) -> EmitResult:
    """Write one record to ``analyses_dir/<filename>``.

    On an absent channel or an ``OSError`` (read-only FS, permission), return an
    ``'unavailable'`` :class:`EmitResult` carrying a loud notice — never silently
    drop the record (SC-10 fallback).
    """
    if not channel_available(analyses_dir):
        return EmitResult(
            "unavailable",
            None,
            notice="guardian: harness analyses channel unavailable "
            "(.harness/ absent) — falling back to the sticky comment",
        )
    record = build_analysis_record(
        findings,
        ref=ref,
        gate=gate,
        effective_tier=effective_tier,
        degraded_notice=degraded_notice,
        exit_code=exit_code,
        analyzed_at=analyzed_at,
    )
    target = analyses_dir / analysis_filename(ref)
    try:
        analyses_dir.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(record, indent=2), encoding="utf-8")
    except OSError as exc:
        return EmitResult(
            "unavailable",
            None,
            notice=f"guardian: analyses write failed ({exc}) — "
            "falling back to the sticky comment",
        )
    return EmitResult("emitted", str(target), None)
