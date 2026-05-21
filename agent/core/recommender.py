# agent/core/recommender.py

"""
Framework Recommender - Selects the optimal testing tool based on requirements.

This module uses classification data and the framework registry to suggest
the most appropriate testing framework and file configuration for a given task.
"""

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

    def recommend(
        self,
        classification: ClassificationResult,
        metadata=None,
        framework_hint: Optional[str] = None,
    ) -> Dict:
        """
        Recommends a framework based on the classification result.

        Args:
            classification: The result from the TestClassifier.
            metadata: Optional ProjectMetadata. When provided, candidates are
                filtered to those whose languages intersect with the project's
                detected languages. Falls back to unfiltered if no match.
            framework_hint: Optional explicit framework name (lowercase, e.g.
                "pytest"). When the hint matches a candidate within the
                language-filtered set it wins over registry preferred-default.
                Used to break ties when two frameworks claim the same test_type
                and no project metadata narrows the set.

        Returns:
            Dict: A dictionary containing the recommended framework,
                category, file extension, and reasoning.
        """
        frameworks = self.registry.get_by_category(classification.test_type)

        if not frameworks:
            return {
                "framework": None,
                "reason": ["No matching framework found"]
            }

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

        if hinted is not None:
            selected = hinted
        else:
            # Prefer "preferred" status first
            preferred = [
                f for f in candidates
                if f.get("status") == "preferred"
            ]
            selected = preferred[0] if preferred else candidates[0]

        # Derive extension with safety
        file_extension = "ts" # Default fallback
        if selected.get("file_extensions"):
            file_extension = selected["file_extensions"][0]
        elif selected.get("languages"):
            lang_map = {"python": "py", "javascript": "js", "typescript": "ts"}
            file_extension = lang_map.get(selected["languages"][0].lower(), "ts")

        reason = self._build_reason(selected)
        if hinted is not None:
            reason.insert(0, f"prompt-named framework ({selected['name']})")

        return {
            "framework": selected["name"],
            "category": selected["category"],
            "file_extension": file_extension,
            "reason": reason,
        }

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
