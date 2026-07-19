"""SC-7: the PR and pre-commit surfaces toggle ON/OFF INDEPENDENTLY.

`pr.enabled` gates the PR surface (`cli.pr_check`, Phase 2) and
`preCommit.enabled` gates the pre-commit surface (`run_precommit_check`, T3).
This is a behavioral 2x2 matrix — test-only, no new source — proving either
toggle may be on while the other is off. Both surfaces read the SAME config file,
so the matrix demonstrates the fields are wired independently.

| # | pr.enabled | preCommit.enabled | PR runs? | pre-commit runs? |
| 1 | true       | true              | yes      | yes              |
| 2 | false      | false             | no       | no               |
| 3 | true       | false             | yes      | no               |
| 4 | false      | true              | no       | yes              |
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from typer.testing import CliRunner

from agent.guardian import cli as guardian_cli
from agent.guardian.cli import guardian_app
from agent.guardian.pr_check import load_guardian_config
from agent.guardian.pr_comment import FakeGitHubClient

HOOKS_DIR = Path(__file__).parents[2] / "hooks"
sys.path.insert(0, str(HOOKS_DIR))

import guardian_precommit  # noqa: E402

DIFF_UNTESTED = """\
diff --git a/pkg/widget.py b/pkg/widget.py
index 1111111..2222222 100644
--- a/pkg/widget.py
+++ b/pkg/widget.py
@@ -0,0 +1,3 @@
+def widget():
+    return 42
+
"""


def _write_config(tmp_path: Path, pr_enabled: bool, precommit_enabled: bool) -> Path:
    path = tmp_path / "harness.config.json"
    path.write_text(
        json.dumps(
            {
                "canary": {
                    "guardian": {
                        "pr": {"enabled": pr_enabled},
                        "preCommit": {"enabled": precommit_enabled},
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    return path


class TestSurfaceToggles:
    """Each 2x2 cell asserts each surface's behavior independently (SC-7)."""

    runner = CliRunner()

    @pytest.mark.parametrize(
        "pr_enabled,precommit_enabled",
        [(True, True), (False, False), (True, False), (False, True)],
    )
    def test_toggles_are_independent(
        self, tmp_path, monkeypatch, pr_enabled, precommit_enabled
    ) -> None:
        cfg = _write_config(tmp_path, pr_enabled, precommit_enabled)
        config, warning = load_guardian_config(cfg)
        assert warning is None
        assert config.pr_enabled is pr_enabled
        assert config.precommit_enabled is precommit_enabled

        # --- PR surface: --post-comment run (network-free FakeGitHubClient) ---
        monkeypatch.chdir(tmp_path)
        monkeypatch.setenv("GITHUB_REPOSITORY", "o/r")
        monkeypatch.setenv("GITHUB_REF", "refs/pull/7/merge")
        monkeypatch.delenv("GITHUB_EVENT_PATH", raising=False)
        fake = FakeGitHubClient()
        monkeypatch.setattr(guardian_cli, "_build_client", lambda *_: fake)
        result = self.runner.invoke(
            guardian_app,
            ["pr-check", "--diff", "-", "--config", str(cfg), "--post-comment"],
            input=DIFF_UNTESTED,
        )
        assert result.exit_code == 0
        if pr_enabled:
            assert "skipping PR surface" not in result.stdout
            assert len(fake.list_comments()) == 1  # pipeline ran → comment posted
        else:
            assert "skipping PR surface" in result.stdout
            assert fake.list_comments() == []  # PR surface skipped

        # --- Pre-commit surface: pure-core call ---
        outcome = guardian_precommit.run_precommit_check(config, DIFF_UNTESTED)
        if precommit_enabled:
            assert outcome.skipped is False  # pipeline ran
        else:
            assert outcome.skipped is True  # hook skipped
