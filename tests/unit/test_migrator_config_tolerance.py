"""Regression: migrator tolerates new harness.config.json blocks + warns loudly.

Gap 1 of issue #310 (harness↔canary config seam). Two independent guarantees
are characterized here against the CURRENT (post-#307) behavior:

1. **Tolerance.** `harness.config.json` now carries `agent.backends` and
   `craft.llm.backend` blocks (added upstream so the harness craft pipeline
   can pick an LLM backend). Canary's migrator must ignore blocks it does not
   understand and keep reading the fields it does — chiefly `language`, which
   drives the framework-language fallback. A crash or a dropped `language`
   here would silently misroute detection.

2. **Fail-loud, not fail-silent.** A genuinely malformed config must surface a
   warning (via `config_validation.read_json_with_warning`, wired into
   `detect()` by #307) rather than collapsing to a silent empty dict that is
   indistinguishable from "no config at all". That collapse is exactly what
   produced "no harness project detected" on a project that plainly had one.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from agent.core.migrator import HarnessMigrator

_REPO = Path(__file__).resolve().parents[2]

# The exact backend blocks now shipped in the repo's own harness.config.json.
_AGENT_BACKENDS = {"backends": {"craft": {"type": "claude"}}}
_CRAFT_LLM = {"llm": {"backend": "craft"}}


def _harness_project(root: Path, config: dict) -> None:
    (root / "harness.config.json").write_text(json.dumps(config), encoding="utf-8")
    (root / ".harness").mkdir()


class TestConfigToleranceOfBackendBlocks(unittest.TestCase):
    """The agent.backends / craft.llm.backend blocks must not disturb detection."""

    def test_detect_does_not_crash_with_backend_blocks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _harness_project(root, {
                "language": "python",
                "agent": _AGENT_BACKENDS,
                "craft": _CRAFT_LLM,
            })
            # Must not raise.
            ctx = HarnessMigrator().detect(root)
            self.assertTrue(ctx.is_harness_project)

    def test_language_still_read_with_backend_blocks_present(self):
        """The unknown blocks must not shadow the `language` fallback."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _harness_project(root, {
                "language": "python",
                "agent": _AGENT_BACKENDS,
                "craft": _CRAFT_LLM,
            })
            ctx = HarnessMigrator().detect(root)
            # language:python → pytest/api via the language fallback.
            self.assertEqual(ctx.harness_config.get("language"), "python")
            self.assertEqual(ctx.detected_framework, "pytest")
            self.assertEqual(ctx.detected_shape, "api")
            self.assertEqual(ctx.detection_confidence, "language")

    def test_backend_blocks_do_not_emit_a_config_warning(self):
        """Well-formed config with extra blocks is not 'malformed'."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _harness_project(root, {
                "language": "typescript",
                "agent": _AGENT_BACKENDS,
                "craft": _CRAFT_LLM,
            })
            ctx = HarnessMigrator().detect(root)
            self.assertEqual(ctx.config_warnings, [])
            # typescript → playwright/e2e_ui fallback still fires.
            self.assertEqual(ctx.detected_framework, "playwright")

    def test_repo_own_harness_config_is_tolerated(self):
        """The checked-in harness.config.json — whatever optional blocks it
        carries — always parses cleanly and still exposes `language`. A live
        regression anchor: any block upstream adds (agent.backends, craft.llm,
        architecture, …) must never make canary's own config unreadable."""
        cfg = json.loads((_REPO / "harness.config.json").read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _harness_project(root, cfg)
            ctx = HarnessMigrator().detect(root)
            self.assertTrue(ctx.is_harness_project)
            self.assertEqual(ctx.config_warnings, [])
            self.assertEqual(ctx.harness_config.get("language"), cfg.get("language"))

    def test_repo_config_plus_synthetic_backend_blocks_is_tolerated(self):
        """Overlay the #310 blocks onto the real config and confirm tolerance —
        pins the seam even before origin/main ships the blocks itself."""
        cfg = json.loads((_REPO / "harness.config.json").read_text(encoding="utf-8"))
        cfg["agent"] = _AGENT_BACKENDS
        cfg["craft"] = _CRAFT_LLM
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _harness_project(root, cfg)
            ctx = HarnessMigrator().detect(root)
            self.assertTrue(ctx.is_harness_project)
            self.assertEqual(ctx.config_warnings, [])
            self.assertEqual(ctx.harness_config.get("language"), cfg.get("language"))


class TestMalformedConfigSurfacesWarning(unittest.TestCase):
    """A broken config must warn (read_json_with_warning path), not go silent."""

    def test_malformed_json_populates_config_warnings(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "harness.config.json").write_text("{ not valid json", encoding="utf-8")
            (root / ".harness").mkdir()
            ctx = HarnessMigrator().detect(root)
            # Still recognised as a harness project (markers exist)…
            self.assertTrue(ctx.is_harness_project)
            # …but the malformed config is surfaced, not silently swallowed.
            self.assertEqual(len(ctx.config_warnings), 1)
            self.assertIn("not valid JSON", ctx.config_warnings[0])
            # Degrades to an empty config rather than raising.
            self.assertEqual(ctx.harness_config, {})

    def test_warning_is_not_emitted_for_wellformed_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _harness_project(root, {"language": "python"})
            ctx = HarnessMigrator().detect(root)
            self.assertEqual(ctx.config_warnings, [])

    def test_malformed_company_json_also_warns_without_blocking(self):
        """A broken .canary/company.json warns but never blocks detection."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _harness_project(root, {"language": "python"})
            canary = root / ".canary"
            canary.mkdir()
            (canary / "company.json").write_text("{bad", encoding="utf-8")
            ctx = HarnessMigrator().detect(root)
            self.assertTrue(any("company.json" in w for w in ctx.config_warnings))
            # Framework detection still succeeds via the language fallback.
            self.assertEqual(ctx.detected_framework, "pytest")

    def test_config_warning_propagates_into_migration_report(self):
        """The warning must reach the user-facing report, not die in detect()."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "harness.config.json").write_text("}{", encoding="utf-8")
            (root / ".harness").mkdir()
            report = HarnessMigrator().migrate(root, dry_run=True)
            self.assertTrue(report.config_warnings)
            self.assertIn("Config Warnings", report.to_markdown())


if __name__ == "__main__":
    unittest.main()
