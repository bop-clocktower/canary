# agent/core/recommender.py

"""
Framework Recommender - Selects the optimal testing tool based on requirements.

This module uses classification data and the framework registry to suggest
the most appropriate testing framework and file configuration for a given task.
"""

import os
from typing import Dict, List, Optional
from agent.core.classifier import ClassificationResult
from agent.core.framework_registry import FrameworkRegistry


class FrameworkRecommender:
    """
    Logic engine for selecting testing frameworks based on test intent.
    """

    def __init__(self):
        """
        Initializes the recommender with the framework registry.
        """
        self.registry = FrameworkRegistry()

    # Cap the ranked candidate list so the output stays scannable.
    _MAX_CANDIDATES = 3

    def recommend(
        self,
        classification: ClassificationResult,
        metadata=None,
        framework_hint: Optional[str] = None,
    ) -> List[Dict]:
        """
        Recommend frameworks for a classification, ranked best-first.

        Args:
            classification: The result from the TestClassifier.
            metadata: Optional ProjectMetadata. When provided, candidates are
                filtered to those whose languages intersect with the project's
                detected languages. Falls back to unfiltered if no match.
            framework_hint: Optional explicit framework name (lowercase, e.g.
                "pytest"). When the hint matches a candidate within the
                language-filtered set it is ranked first.

        Returns:
            List[Dict]: Up to three candidates, ranked best-first. Each entry
                carries ``framework``, ``category``, ``file_extension``,
                ``reason``, and ``confidence`` (echoing the classification
                confidence). Empty list when no framework matches —
                single-pick callers should read ``result[0]`` after guarding
                for emptiness.
        """
        # Observability has a dedicated reporting-sink routing branch (Stage 2):
        # where results/telemetry go is a config decision, not a registry pick.
        if classification.test_type == "observability":
            return self._recommend_observability(classification)

        frameworks = self.registry.get_by_category(classification.test_type)
        if not frameworks:
            return []

        # License gate (Stage 3): strip commercially-licensed entries unless
        # the unlocking signal is present. OSS-first — paid tools never
        # surface silently; the OSS default for the category always remains.
        frameworks = [f for f in frameworks if self._license_allowed(f)]
        if not frameworks:
            return []

        # Apply language filter when project languages are known.
        candidates = frameworks
        if metadata is not None:
            detected = metadata.detected_languages
            if detected:
                filtered = [
                    f for f in frameworks
                    if set(f.get("languages", [])) & detected
                ]
                candidates = filtered if filtered else frameworks

        # An explicit framework name in the prompt outranks the registry's
        # preferred-default — resolves the ambiguity when two frameworks
        # (e.g. playwright, pytest) both claim ``api`` and no project metadata
        # is available to break the tie.
        hinted = None
        if framework_hint:
            hinted = next(
                (f for f in candidates if f.get("name") == framework_hint.lower()),
                None,
            )

        # Rank: hinted first, then preferred-status, then the rest — each tier
        # preserving registry order. De-dupe while preserving that ranking.
        preferred = [f for f in candidates if f.get("status") == "preferred"]
        rest = [f for f in candidates if f.get("status") != "preferred"]
        ranked_pool = ([hinted] if hinted is not None else []) + preferred + rest

        ranked: List[Dict] = []
        seen = set()
        for fw in ranked_pool:
            name = fw.get("name")
            if name in seen:
                continue
            seen.add(name)
            entry = self._format_candidate(fw, classification.confidence)
            if fw is hinted:
                entry["reason"].insert(0, f"prompt-named framework ({name})")
            ranked.append(entry)
            if len(ranked) >= self._MAX_CANDIDATES:
                break
        return ranked

    @staticmethod
    def _license_allowed(framework: Dict) -> bool:
        """Whether a framework may surface given the current license signals.

        OSS / ungated entries (no ``license_gate``) always pass. Gated entries
        require their ``license_gate`` env var to be set:

        - A truthy value (e.g. ``CANARY_LICENSE_TRICENTIS=1``) unlocks a
          ``commercial`` tool.
        - For ``commercial-org`` tools gated on ``CANARY_SCOPE``, any non-empty
          scope unlocks it; if the entry lists ``license_scopes``, the scope
          value must be one of them.
        """
        gate = framework.get("license_gate")
        if not gate:
            return True
        value = os.environ.get(gate, "").strip()
        if not value or value.lower() in ("0", "false", "no", "off"):
            return False
        scopes = framework.get("license_scopes")
        if scopes:
            return value in scopes
        return True

    def _recommend_observability(self, classification: ClassificationResult) -> List[Dict]:
        """Reporting-sink routing for the observability test type (Stage 2).

        Per OC-001: ReportPortal is the always-on OSS default sink; a
        downstream aggregation dashboard is an opt-in *additional* sink,
        surfaced when ``CANARY_SCOPE=<overlay-id>`` is set (the
        upstream-neutral equivalent of the overlay's dashboard config). The
        sinks are complementary to OpenTelemetry, which instruments the
        telemetry the sinks collect — so it is included as well.
        """
        confidence = classification.confidence
        candidates: List[Dict] = []

        # Opt-in overlay dashboard sink, ranked first when configured.
        scope = os.environ.get("CANARY_SCOPE", "").strip()
        if scope:
            candidates.append({
                "framework": f"{scope}-dashboard",
                "category": "observability",
                "file_extension": "",
                "reason": [
                    f"configured aggregation dashboard (CANARY_SCOPE={scope})",
                    "overlay reporting sink — receives results in addition to ReportPortal",
                ],
                "confidence": confidence,
                "kind": "reporting-sink",
            })

        # ReportPortal — always-on OSS default sink.
        candidates.append({
            "framework": "reportportal",
            "category": "observability",
            "file_extension": "",
            "reason": ["self-hosted OSS reporting sink — default for observability output"],
            "confidence": confidence,
            "kind": "reporting-sink",
        })

        # OpenTelemetry — instrumentation framework (from the Stage 1 registry).
        otel = next(
            (f for f in self.registry.get_by_category("observability")
             if f.get("name") == "opentelemetry"),
            None,
        )
        if otel is not None:
            otel_candidate = self._format_candidate(otel, confidence)
            otel_candidate["kind"] = "instrumentation"
            candidates.append(otel_candidate)

        return candidates[:self._MAX_CANDIDATES]

    def _format_candidate(self, framework: Dict, confidence: float) -> Dict:
        """Shape a single registry entry into a recommendation candidate."""
        file_extension = "ts"  # Default fallback
        if framework.get("file_extensions"):
            file_extension = framework["file_extensions"][0]
        elif framework.get("languages"):
            lang_map = {"python": "py", "javascript": "js", "typescript": "ts"}
            file_extension = lang_map.get(
                framework["languages"][0].lower(), "ts"
            )

        candidate = {
            "framework": framework["name"],
            "category": framework["category"],
            "file_extension": file_extension,
            "reason": self._build_reason(framework),
            "confidence": confidence,
        }
        # Surface a license caveat (e.g. source-available BSL tools) so
        # downstream adopters see the review requirement before relying on
        # the pick. Carried as a structured field and echoed into the reason.
        if framework.get("license_note"):
            candidate["license"] = framework.get("license")
            candidate["warning"] = framework["license_note"]
            license_label = framework.get("license", "non-OSI license")
            candidate["reason"].insert(
                0, f"⚠ {license_label}: review against your license policy"
            )
        return candidate

    def _build_reason(self, framework: Dict) -> List[str]:
        """
        Generates a list of human-readable justifications for a recommendation.

        Args:
            framework: The framework metadata dictionary.

        Returns:
            List[str]: A list of reasoning strings.
        """
        reasons = []

        # Add explicit reasoning fields
        if framework.get("recommended_for"):
            reasons.extend(framework["recommended_for"])

        if framework.get("strengths"):
            reasons.extend(framework["strengths"][:2])  # keep it concise

        # Add maturity signal
        if framework.get("maturity"):
            reasons.append(f"Maturity level: {framework['maturity']}")

        return reasons
