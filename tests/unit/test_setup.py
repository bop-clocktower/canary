# tests/unit/test_setup.py
import json
import unittest
from pathlib import Path
from unittest.mock import patch
import tempfile

from agent.core.setup import SetupWizard


class TestIsConfigured(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.root = Path(self.tmp)

    def test_false_when_missing(self):
        self.assertFalse(SetupWizard.is_configured(self.root))

    def test_true_when_valid(self):
        (self.root / ".oracle").mkdir()
        (self.root / ".oracle" / "config.json").write_text(
            json.dumps({"provider": "claude"})
        )
        self.assertTrue(SetupWizard.is_configured(self.root))

    def test_false_when_malformed(self):
        (self.root / ".oracle").mkdir()
        (self.root / ".oracle" / "config.json").write_text("{}")
        self.assertFalse(SetupWizard.is_configured(self.root))


if __name__ == "__main__":
    unittest.main()
