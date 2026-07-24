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

    def execution_info(self, name: str) -> Optional[Dict[str, Any]]:
        """Run-command metadata for a framework: ``execution_command`` (with a
        ``{file}`` placeholder to substitute the test path) and ``ci_flags``
        (#357). Returns None for an unknown framework so callers can distinguish
        "no such framework" from "framework with no command".
        """
        f = self.find_by_name(name)
        if f is None:
            return None
        return {
            "execution_command": f.get("execution_command"),
            "ci_flags": f.get("ci_flags", []),
        }

    @staticmethod
    def _is_runnable(cmd: Optional[str]) -> bool:
        """Whether canary can actually run a framework's command.

        The executor (``CanaryTestExecutor``) substitutes **only** ``{file}``,
        so a command is runnable iff it carries ``{file}`` (the test path is
        injected) or has no placeholder at all (a whole-suite runner like
        ``stryker run``). A command with a *different* placeholder (e.g.
        ``{target}``) would reach the shell unsubstituted and fail — so it is
        NOT counted as executable, however plausible the string looks.
        """
        if not cmd:
            return False
        return "{file}" in cmd or "{" not in cmd

    def capabilities(self, name: str) -> Optional[Dict[str, Any]]:
        """Honest, code-DERIVED support level for a framework — never the
        registry's subjective ``status``/``maturity`` prose.

        Signals (each read from the code that actually provides the capability):

        - ``scaffold``: a Scaffolder template exists (canary can bootstrap it).
        - ``execute``:  the registry carries a command the executor can *run*
          (see :meth:`_is_runnable` — not merely a non-empty string).

        The headline ``tier`` derives from these two adopter-facing signals and
        therefore cannot drift from what the code does: ``full`` (scaffold +
        execute), ``executable`` (execute only), or ``catalog`` (neither —
        listed for detection/recommendation only). Returns ``None`` for an
        unknown framework. Case-insensitive, matching :meth:`Scaffolder.scaffold`.
        """
        if not name:
            return None
        name = name.lower()
        f = self.find_by_name(name)
        if f is None:
            return None

        # Lazy import keeps this module free of a scaffolder import cycle.
        from agent.core.scaffolder import scaffoldable_frameworks

        can_scaffold = name in scaffoldable_frameworks()
        can_execute = self._is_runnable(f.get("execution_command"))

        if can_scaffold and can_execute:
            tier = "full"
        elif can_execute:
            tier = "executable"
        else:
            tier = "catalog"

        return {
            "scaffold": can_scaffold,
            "execute": can_execute,
            "tier": tier,
        }

    def summaries(self) -> List[Dict[str, Any]]:
        """Programmatic dump of every framework's identity + run-command fields
        (#357) — the registry as an authoritative framework→run-command source.
        ``execution_command`` uses a ``{file}`` placeholder for the test path.
        """
        out: List[Dict[str, Any]] = []
        for f in self.get_all_frameworks():
            caps = self.capabilities(f.get("name"))
            out.append(
                {
                    "name": f.get("name"),
                    "category": f.get("category"),
                    "categories": f.get("categories", []),
                    "languages": f.get("languages", []),
                    "file_extensions": f.get("file_extensions", []),
                    "execution_command": f.get("execution_command"),
                    "ci_flags": f.get("ci_flags", []),
                    "status": f.get("status"),
                    "capabilities": caps,
                    "tier": (caps or {}).get("tier"),
                }
            )
        return out

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
