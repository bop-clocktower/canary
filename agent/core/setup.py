# agent/core/setup.py
"""Interactive setup wizard for first-run Oracle configuration."""

import json
from pathlib import Path
from typing import Optional

_CONFIG_FILE = Path(".oracle") / "config.json"


class SetupWizard:

    @classmethod
    def is_configured(cls, path: Optional[Path] = None) -> bool:
        """Return True if .oracle/config.json exists with a valid provider."""
        config = (path or Path.cwd()) / _CONFIG_FILE
        if not config.exists():
            return False
        try:
            data = json.loads(config.read_text())
            return bool(data.get("provider"))
        except (json.JSONDecodeError, OSError):
            return False
