# agent/core/recommender.py

from typing import Dict, List
from agent.core.classifier import ClassificationResult
from agent.core.framework_registry import FrameworkRegistry


class FrameworkRecommender:

    def __init__(self):
        self.registry = FrameworkRegistry()

    def recommend(self, classification: ClassificationResult) -> Dict:
        frameworks = self.registry.get_by_category(classification.test_type)

        if not frameworks:
            return {
                "framework": None,
                "reason": ["No matching framework found"]
            }

        # Prefer "preferred" status first
        preferred = [
            f for f in frameworks
            if f.get("status") == "preferred"
        ]

        selected = preferred[0] if preferred else frameworks[0]

        # Derive extension with safety
        file_extension = "ts" # Default fallback
        if selected.get("file_extensions"):
            file_extension = selected["file_extensions"][0]
        elif selected.get("languages"):
            lang_map = {"python": "py", "javascript": "js", "typescript": "ts"}
            file_extension = lang_map.get(selected["languages"][0].lower(), "ts")

        return {
            "framework": selected["name"],
            "category": selected["category"],
            "file_extension": file_extension,
            "reason": self._build_reason(selected)
        }

    def _build_reason(self, framework: Dict) -> List[str]:
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