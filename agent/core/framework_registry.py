# agent/core/framework_registry.py

"""
Framework Registry - Manages the collection of supported testing frameworks.

This module provides a centralized database of framework metadata, including
execution commands, supported languages, and categorization.
"""

import json
from pathlib import Path
from typing import Dict, List, Optional, Any


class FrameworkRegistry:
    """
    Registry for querying testing framework capabilities and configurations.
    """

    def __init__(self, registry_path: str = None):
        """
        Initializes the registry from a JSON file.

        Args:
            registry_path: Path to the registry JSON file.
                Defaults to agent/frameworks/registry.json.
        """
        base_dir = Path(__file__).resolve().parents[1]
        self.registry_path = registry_path or base_dir / "frameworks" / "registry.json"
        self._registry = self._load_registry()

    def _load_registry(self) -> Dict[str, Any]:
        """
        Loads the framework metadata from the filesystem.

        Returns:
            Dict[str, Any]: The parsed JSON registry.
        """
        with open(self.registry_path, "r") as f:
            return json.load(f)

    def get_all_frameworks(self) -> List[Dict]:
        """
        Returns all registered frameworks.

        Returns:
            List[Dict]: A list of framework metadata dictionaries.
        """
        return self._registry.get("frameworks", [])

    def get_by_category(self, category: str) -> List[Dict]:
        """
        Filters frameworks by category (e.g., 'e2e_ui').

        Args:
            category: The category name to filter by.

        Returns:
            List[Dict]: Matching frameworks.
        """
        return [
            f for f in self.get_all_frameworks()
            if f.get("category") == category
            or category in (f.get("categories") or [])
        ]

    def get_preferred_by_category(self, category: str) -> Optional[Dict]:
        """
        Returns the recommended framework for a given category.

        Args:
            category: The category name.

        Returns:
            Optional[Dict]: The preferred framework metadata, or None.
        """
        frameworks = self.get_by_category(category)

        # Prefer explicit "preferred"
        for f in frameworks:
            if f.get("status") == "preferred":
                return f

        return frameworks[0] if frameworks else None

    def find_by_name(self, name: str) -> Optional[Dict]:
        """
        Locates a framework by its unique name.

        Args:
            name: The framework identifier (e.g., 'playwright').

        Returns:
            Optional[Dict]: The framework metadata dictionary.
        """
        for f in self.get_all_frameworks():
            if f.get("name") == name:
                return f
        return None

    def match_by_language(self, language: str) -> List[Dict]:
        """
        Filters frameworks by supported programming language.

        Args:
            language: The language name (e.g., 'typescript').

        Returns:
            List[Dict]: Frameworks supporting the language.
        """
        return [
            f for f in self.get_all_frameworks()
            if language in f.get("languages", [])
        ]
