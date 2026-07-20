"""Contract guard: the impact skills must call harness's purpose-built impact
primitives when the harness MCP is present, while preserving today's
grep / ``git log`` fallbacks when it is absent.

Issue #338, bullet 1 — ``canary-critical-areas`` and ``canary-failure-impact``
historically hand-walked ``get_relationships`` up to 3 hops and re-derived churn
from raw ``git log --stat``. Harness ships purpose-built primitives
(``get_impact``, ``compute_blast_radius``, ``get_critical_paths``, and
hotspot / co-change anomaly detection); the skills should prefer those and only
fall back to the heuristics when the MCP is unavailable.

These skills are prose-only (no backing Python), so the contract is enforced
against the SKILL.md text: the primitive names must appear, and the graceful
degradation language must survive alongside them.
"""

from __future__ import annotations

import unittest
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
_SKILLS_DIR = _REPO / "agents" / "skills" / "claude-code"
_CRITICAL_AREAS = _SKILLS_DIR / "canary-critical-areas" / "SKILL.md"
_FAILURE_IMPACT = _SKILLS_DIR / "canary-failure-impact" / "SKILL.md"


class TestImpactSkillsUseHarnessPrimitives(unittest.TestCase):
    def _read(self, path: Path) -> str:
        self.assertTrue(path.exists(), f"missing skill: {path}")
        return path.read_text(encoding="utf-8")

    def test_critical_areas_calls_impact_primitives(self) -> None:
        text = self._read(_CRITICAL_AREAS)
        # Downstream-dependents signal must prefer the real impact primitive.
        self.assertIn("get_impact", text)
        # Churn / hotspot signal must prefer harness anomaly detection.
        self.assertIn("detect_anomalies", text)
        # Perf/critical-path signal must consult the dedicated primitive.
        self.assertIn("get_critical_paths", text)

    def test_critical_areas_preserves_fallbacks(self) -> None:
        text = self._read(_CRITICAL_AREAS)
        # Graceful degradation: git churn + grep fallbacks must survive.
        self.assertIn("git log", text)
        self.assertIn("grep", text)
        self.assertIn("Fallback", text)
        self.assertIn("harness MCP", text)

    def test_failure_impact_calls_blast_radius_primitive(self) -> None:
        text = self._read(_FAILURE_IMPACT)
        # Blast-radius tracing must prefer the probability-weighted primitive.
        self.assertIn("compute_blast_radius", text)
        # ...and the impact primitive for the affected-node inventory.
        self.assertIn("get_impact", text)

    def test_failure_impact_preserves_fallbacks(self) -> None:
        text = self._read(_FAILURE_IMPACT)
        self.assertIn("grep", text)
        self.assertIn("Fallback", text)
        self.assertIn("harness MCP", text)


if __name__ == "__main__":
    unittest.main()
