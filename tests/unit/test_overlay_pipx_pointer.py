"""The Python `canary overlay` command points pipx users at the npm install."""

from __future__ import annotations

import unittest

from typer.testing import CliRunner

from agent.cli import app


class TestOverlayPipxPointer(unittest.TestCase):
    def setUp(self):
        self.runner = CliRunner()

    def test_bare_overlay_points_at_npm_and_exits_nonzero(self):
        result = self.runner.invoke(app, ["overlay"])
        self.assertNotEqual(result.exit_code, 0)
        self.assertIn("npm install -g canary-test-cli", result.output)

    def test_overlay_with_subcommand_and_flags_still_points(self):
        # A pipx user typing the real command must get the pointer, not a
        # Typer "No such command" / unknown-option error.
        result = self.runner.invoke(
            app, ["overlay", "add", "github:example-org/example-overlay", "--ref", "v1"]
        )
        self.assertNotEqual(result.exit_code, 0)
        self.assertIn("npm install -g canary-test-cli", result.output)


if __name__ == "__main__":
    unittest.main()
