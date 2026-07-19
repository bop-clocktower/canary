"""API Change Guardian — watch SUT main branch and analyze test impact."""

from agent.guardian.coverage import ChangedUnit, CoverageResult, Fidelity
from agent.guardian.diff_extractor import extract_api_diff, ApiDiff, EndpointChange, ChangeType
from agent.guardian.impact_mapper import map_impact, ImpactGap, Severity
from agent.guardian.pr_check import Finding
from agent.guardian.summary_emitter import build_summary

__all__ = [
    "extract_api_diff", "ApiDiff", "EndpointChange", "ChangeType",
    "map_impact", "ImpactGap", "Severity",
    "build_summary",
    "Fidelity", "Finding", "CoverageResult", "ChangedUnit",
]
