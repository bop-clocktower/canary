"""Cross-suite analysis — fleet-wide health signals across all Canary test suites."""

from agent.analysis.reports import build_digest
from agent.analysis.engine import AnalysisEngine

__all__ = ["build_digest", "AnalysisEngine"]
