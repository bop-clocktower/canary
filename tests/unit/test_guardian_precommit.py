"""Unit tests for the git pre-commit surface (hooks/guardian_precommit.py).

The core logic is a **pure, injectable callable** — ``run_precommit_check(config,
diff_text, probe=None)`` — unit-tested directly: no git hook is installed and no
``git commit`` runs. The staged-diff seam and the thin git entrypoint (T4) are
exercised separately via monkeypatch / a temp repo. The hook module is imported
per the repo pattern (``sys.path.insert(0, HOOKS_DIR)``; cf.
``tests/unit/test_hooks.py``).

SC-7 (skip): ``preCommit.enabled == false`` → the hook skips entirely, exit 0.
SC-5 (pre-commit half): an authoring request (tier 2) with no agent runs tier 0
and prints the LOUD degradation notice in its text report.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from agent.guardian.pr_check import GuardianConfig

HOOKS_DIR = Path(__file__).parents[2] / "hooks"
sys.path.insert(0, str(HOOKS_DIR))

import guardian_precommit  # noqa: E402

# A diff adding an untested production unit (heuristic-uncovered → finding).
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

# A docs-only diff — default skip_globs drop it ("nothing to verify").
DIFF_DOCS = """\
diff --git a/docs/x.md b/docs/x.md
index 1111111..2222222 100644
--- a/docs/x.md
+++ b/docs/x.md
@@ -0,0 +1,2 @@
+# Heading
+prose
"""

# The same unit, but line 1 carries an inline `canary:allow-untested` annotation
# so a hard gate is ADDRESSED (suppressed) and exits 0.
DIFF_UNTESTED_SUPPRESSED = """\
diff --git a/pkg/widget.py b/pkg/widget.py
index 1111111..2222222 100644
--- a/pkg/widget.py
+++ b/pkg/widget.py
@@ -0,0 +1,3 @@
+def widget():  # canary:allow-untested covered by integration suite
+    return 42
+
"""


def _seed_graph_node(tmp_path: Path, path: str) -> None:
    """Write a minimal NDJSON graph with a single node for ``path`` and no test
    edge — so ``resolve_from_graph`` reports it GRAPH_VERIFIED *uncovered* (HIGH),
    which a hard gate then blocks on."""
    graph = tmp_path / ".harness" / "graph" / "graph.json"
    graph.parent.mkdir(parents=True, exist_ok=True)
    graph.write_text(
        '{"kind": "node", "id": "n1", "path": "' + path + '"}\n',
        encoding="utf-8",
    )


class TestRunPrecommitCheck:
    """SC-7 skip + SC-5 pre-commit-half + Tier 0 local gate (pure callable)."""

    def test_disabled_skips_entirely(self) -> None:
        config = GuardianConfig(precommit_enabled=False)
        outcome = guardian_precommit.run_precommit_check(config, DIFF_UNTESTED)
        assert outcome.skipped is True
        assert outcome.exit_code == 0
        assert "skipping" in outcome.report.lower()
        assert outcome.degraded_notice is None

    def test_authoring_request_degrades_loudly(self, tmp_path, monkeypatch) -> None:
        # tier 2 (authorTests) with no probe → NoAgentProbe → runs tier 0 loudly.
        monkeypatch.chdir(tmp_path)
        config = GuardianConfig(
            precommit_enabled=True, precommit_author_tests=True, precommit_gate="soft"
        )
        outcome = guardian_precommit.run_precommit_check(config, DIFF_UNTESTED)
        assert outcome.skipped is False
        assert outcome.degraded_notice is not None
        assert "tier 2" in outcome.degraded_notice
        assert "⚠ degraded" in outcome.report  # loud channel = printed report
        assert "widget" in outcome.report  # the untested finding is present

    def test_no_authoring_no_degradation_soft_passes(
        self, tmp_path, monkeypatch
    ) -> None:
        monkeypatch.chdir(tmp_path)
        config = GuardianConfig(
            precommit_enabled=True,
            precommit_author_tests=False,
            precommit_gate="soft",
        )
        outcome = guardian_precommit.run_precommit_check(config, DIFF_UNTESTED)
        assert outcome.exit_code == 0  # soft gate: always 0 even with findings
        assert outcome.degraded_notice is None  # tier 0 requested → no notice

    def test_hard_gate_high_finding_blocks(self, tmp_path, monkeypatch) -> None:
        _seed_graph_node(tmp_path, "pkg/widget.py")
        monkeypatch.chdir(tmp_path)
        config = GuardianConfig(
            precommit_enabled=True,
            precommit_author_tests=False,
            precommit_gate="hard",
        )
        outcome = guardian_precommit.run_precommit_check(config, DIFF_UNTESTED)
        assert outcome.exit_code == 1  # unaddressed HIGH untested-new-code

    def test_hard_gate_suppressed_finding_passes(self, tmp_path, monkeypatch) -> None:
        _seed_graph_node(tmp_path, "pkg/widget.py")
        (tmp_path / "pkg").mkdir()
        (tmp_path / "pkg" / "widget.py").write_text(
            "def widget():  # canary:allow-untested covered by integration suite\n"
            "    return 42\n",
            encoding="utf-8",
        )
        monkeypatch.chdir(tmp_path)
        config = GuardianConfig(
            precommit_enabled=True,
            precommit_author_tests=False,
            precommit_gate="hard",
        )
        outcome = guardian_precommit.run_precommit_check(
            config, DIFF_UNTESTED_SUPPRESSED
        )
        assert outcome.exit_code == 0  # suppression addresses the finding

    def test_docs_only_nothing_to_verify(self, tmp_path, monkeypatch) -> None:
        monkeypatch.chdir(tmp_path)
        config = GuardianConfig(precommit_enabled=True)
        outcome = guardian_precommit.run_precommit_check(config, DIFF_DOCS)
        assert outcome.exit_code == 0
        assert "nothing to verify" in outcome.report

    def test_nothing_to_verify_claims_no_degradation(
        self, tmp_path, monkeypatch
    ) -> None:
        # L1: authorTests=True requests tier 2 (would degrade), but the diff
        # filters to nothing → no check ran, so no degradation is claimed and the
        # dangling ⚠ notice must NOT leak into the plain "nothing to verify" text.
        monkeypatch.chdir(tmp_path)
        config = GuardianConfig(
            precommit_enabled=True,
            precommit_author_tests=True,
            precommit_gate="soft",
        )
        outcome = guardian_precommit.run_precommit_check(config, DIFF_DOCS)
        assert "nothing to verify" in outcome.report
        assert outcome.degraded_notice is None
        assert "⚠" not in outcome.report


_CHECK_PROP_LINE = "python3 /repo/hooks/check-proprietary.py run\n"


class TestSentinelLoopGuard:
    """D4 guard (a), Tier-0 half: a filesystem-only sentinel lets the guardian's
    own authored+staged tests re-commit exactly ONCE.

    ``authored_recommit_passthrough`` is deterministic and imports no agent
    module (SC-11) — it only checks/consumes ``.git/canary-guardian-authored``.
    """

    def _sentinel(self, root: Path) -> Path:
        p = root / ".git" / "canary-guardian-authored"
        p.parent.mkdir(parents=True, exist_ok=True)
        return p

    def test_present_sentinel_is_consumed_once(self, tmp_path: Path) -> None:
        sentinel = self._sentinel(tmp_path)
        sentinel.write_text("", encoding="utf-8")
        # First re-commit: sentinel present → pass once, file consumed.
        assert guardian_precommit.authored_recommit_passthrough(tmp_path) is True
        assert not sentinel.exists()
        # Second re-commit: no sentinel → normal path (no infinite loop).
        assert guardian_precommit.authored_recommit_passthrough(tmp_path) is False

    def test_absent_sentinel_returns_false(self, tmp_path: Path) -> None:
        assert guardian_precommit.authored_recommit_passthrough(tmp_path) is False

    def test_main_passes_once_without_running_pipeline(
        self, tmp_path, monkeypatch, capsys
    ) -> None:
        monkeypatch.setattr(guardian_precommit, "REPO_ROOT", tmp_path)
        self._sentinel(tmp_path).write_text("", encoding="utf-8")

        def _boom() -> str:
            raise AssertionError("pipeline must not run when the sentinel passes")

        monkeypatch.setattr(guardian_precommit, "staged_diff", _boom)
        monkeypatch.setattr(
            guardian_precommit, "harness_hook_present", lambda *a, **k: False
        )
        code = guardian_precommit.main([])
        assert code == 0
        assert "authored tests re-committed" in capsys.readouterr().out
        # Sentinel consumed → a subsequent commit runs the pipeline again.
        assert not (tmp_path / ".git" / "canary-guardian-authored").exists()


def _git_init(root: Path) -> None:
    """Init a throwaway git repo in ``root`` (local, deterministic — no network)."""
    subprocess.run(["git", "init", "-q", str(root)], check=True)


class TestMarkAuthoredProducer:
    """FIX 2: ``canary guardian mark-authored`` is the DETERMINISTIC sentinel
    PRODUCER (a CLI step, not LLM markdown). It writes the guardian loop-guard
    sentinel with the authored test paths (one per line), resolving the sentinel
    location via the real git dir (``git rev-parse --git-dir`` — handles
    ``.git``-as-file worktrees). The passthrough (Tier-0 half) then consumes it."""

    def test_mark_authored_writes_sentinel_with_paths(self, tmp_path, monkeypatch):
        from agent.guardian.cli import guardian_app
        from typer.testing import CliRunner

        _git_init(tmp_path)
        monkeypatch.chdir(tmp_path)
        result = CliRunner().invoke(
            guardian_app, ["mark-authored", "--path", "pkg/test_foo.py"]
        )
        assert result.exit_code == 0
        sentinel = tmp_path / ".git" / "canary-guardian-authored"
        assert sentinel.is_file()
        assert sentinel.read_text(encoding="utf-8").splitlines() == ["pkg/test_foo.py"]

    def test_mark_authored_then_passthrough_round_trip(self, tmp_path, monkeypatch):
        from agent.guardian.cli import guardian_app
        from typer.testing import CliRunner

        _git_init(tmp_path)
        monkeypatch.chdir(tmp_path)
        result = CliRunner().invoke(
            guardian_app, ["mark-authored", "--path", "pkg/test_foo.py"]
        )
        assert result.exit_code == 0
        # Re-commit staging EXACTLY the guardian-authored path → pass once.
        monkeypatch.setattr(
            guardian_precommit, "staged_paths", lambda: ["pkg/test_foo.py"]
        )
        assert guardian_precommit.authored_recommit_passthrough(tmp_path) is True
        assert not (tmp_path / ".git" / "canary-guardian-authored").exists()
        # Second call: sentinel consumed → normal path (no loop).
        assert guardian_precommit.authored_recommit_passthrough(tmp_path) is False

    def test_author_plan_block_then_mark_authored_round_trip(
        self, tmp_path, monkeypatch
    ):
        # End-to-end: author-plan (opt-in on, tier 2) blocks with planned intents →
        # feed each target_path to mark-authored → the passthrough clears once.
        import json as _json

        from agent.guardian.cli import guardian_app
        from typer.testing import CliRunner

        _git_init(tmp_path)
        monkeypatch.chdir(tmp_path)
        monkeypatch.setenv("CANARY_GUARDIAN_AGENT", "2")
        monkeypatch.delenv("CANARY_GUARDIAN_IS_FORK", raising=False)
        cfg = tmp_path / "harness.config.json"
        cfg.write_text(
            _json.dumps(
                {"canary": {"guardian": {"preCommit": {"authorTests": True}}}}
            ),
            encoding="utf-8",
        )
        diff = (
            "diff --git a/pkg/widget.py b/pkg/widget.py\n"
            "index 1111111..2222222 100644\n"
            "--- a/pkg/widget.py\n"
            "+++ b/pkg/widget.py\n"
            "@@ -0,0 +1,3 @@\n"
            "+def widget():\n"
            "+    return 42\n"
            "+\n"
        )
        runner = CliRunner()
        plan = runner.invoke(
            guardian_app,
            ["author-plan", "--diff", "-", "--config", str(cfg)],
            input=diff,
        )
        assert plan.exit_code == 0
        data = _json.loads(plan.stdout)
        assert data["block"]["block"] is True
        targets = [i["target_path"] for i in data["intents"] if i["status"] != "skipped"]
        assert targets
        args = ["mark-authored"]
        for t in targets:
            args += ["--path", t]
        assert runner.invoke(guardian_app, args).exit_code == 0
        monkeypatch.setattr(guardian_precommit, "staged_paths", lambda: targets)
        assert guardian_precommit.authored_recommit_passthrough(tmp_path) is True


class TestInstall:
    """install() CHAINS onto an existing .git/hooks/pre-commit (owned by
    check-proprietary.py) — it never clobbers, and is idempotent via the marker."""

    def _hook(self, tmp_path: Path) -> Path:
        return tmp_path / ".git" / "hooks" / "pre-commit"

    def test_chains_onto_existing_hook(self, tmp_path: Path) -> None:
        hook = self._hook(tmp_path)
        hook.parent.mkdir(parents=True)
        hook.write_text("#!/bin/sh\n" + _CHECK_PROP_LINE, encoding="utf-8")
        guardian_precommit.install(repo_root=tmp_path)
        content = hook.read_text(encoding="utf-8")
        assert _CHECK_PROP_LINE in content  # check-proprietary line preserved
        assert guardian_precommit.GUARDIAN_MARKER in content  # guardian appended

    def test_reinstall_is_idempotent(self, tmp_path: Path) -> None:
        hook = self._hook(tmp_path)
        hook.parent.mkdir(parents=True)
        hook.write_text("#!/bin/sh\n" + _CHECK_PROP_LINE, encoding="utf-8")
        guardian_precommit.install(repo_root=tmp_path)
        first = hook.read_text(encoding="utf-8")
        guardian_precommit.install(repo_root=tmp_path)  # second install: no-op
        assert hook.read_text(encoding="utf-8") == first
        assert first.count(guardian_precommit.GUARDIAN_MARKER) == 1

    def test_creates_fresh_hook_when_absent(self, tmp_path: Path) -> None:
        hook = self._hook(tmp_path)
        guardian_precommit.install(repo_root=tmp_path)
        content = hook.read_text(encoding="utf-8")
        assert content.startswith("#!/bin/sh\n")
        assert guardian_precommit.GUARDIAN_MARKER in content
        assert (hook.stat().st_mode & 0o777) == 0o755


class TestChainExitCode:
    """C1 — chaining onto an existing hook must PRESERVE a prior command's
    non-zero exit (e.g. check-proprietary blocking) instead of masking it with
    the guardian's soft-gate 0. These EXECUTE the assembled script with ``sh``.

    ``_guarded_line(cmd)`` is the exact builder ``install()`` uses; substituting a
    deterministic ``exit N`` stub for the guardian ``python3`` invocation lets us
    prove the guard behaviorally (a guardian crash can't masquerade as the block).
    """

    def test_assembled_script_exits_nonzero_when_prior_blocks(
        self, tmp_path: Path
    ) -> None:
        # Script assembled exactly as install() produces it: shebang, a STUB
        # prior command that BLOCKS (exit 1, like check-proprietary) WITHOUT
        # calling `exit`, then the guard-wrapped guardian line. Guardian is a
        # soft-gate-0 stub — so WITHOUT the guard the block would be masked to 0;
        # WITH it the hook must still exit non-zero.
        hook = tmp_path / ".git" / "hooks" / "pre-commit"
        hook.parent.mkdir(parents=True)
        hook.write_text(
            "#!/bin/sh\nfalse\n" + guardian_precommit._guarded_line("exit 0"),
            encoding="utf-8",
        )
        result = subprocess.run(["sh", str(hook)])
        assert result.returncode != 0  # prior block preserved, guardian short-circuited

    def test_chain_propagates_guardian_failure_when_prior_ok(
        self, tmp_path: Path
    ) -> None:
        hook = tmp_path / "pre-commit"
        hook.write_text(
            "#!/bin/sh\ntrue\n" + guardian_precommit._guarded_line("exit 3"),
            encoding="utf-8",
        )
        result = subprocess.run(["sh", str(hook)])
        assert result.returncode == 3  # guardian's own (hard-gate) exit propagates

    def test_chain_passes_when_prior_ok_and_guardian_ok(self, tmp_path: Path) -> None:
        hook = tmp_path / "pre-commit"
        hook.write_text(
            "#!/bin/sh\ntrue\n" + guardian_precommit._guarded_line("exit 0"),
            encoding="utf-8",
        )
        result = subprocess.run(["sh", str(hook)])
        assert result.returncode == 0

    def test_install_output_short_circuits_prior_block(self, tmp_path: Path) -> None:
        # End-to-end via the real install(): the guard fires on the prior block
        # so the real guardian python line is never reached.
        hook = tmp_path / ".git" / "hooks" / "pre-commit"
        hook.parent.mkdir(parents=True)
        hook.write_text("#!/bin/sh\nfalse\n", encoding="utf-8")
        guardian_precommit.install(repo_root=tmp_path)
        result = subprocess.run(["sh", str(hook)])
        assert result.returncode != 0


class TestStagedDiff:
    """staged_diff() is the single `git diff --staged` seam."""

    def test_returns_stdout_string(self, monkeypatch) -> None:
        class _Result:
            stdout = "diff --git a/x b/x\n"

        monkeypatch.setattr(
            guardian_precommit.subprocess, "run", lambda *a, **k: _Result()
        )
        assert guardian_precommit.staged_diff() == "diff --git a/x b/x\n"

    def test_returns_empty_when_git_missing(self, monkeypatch) -> None:
        # L2: `git` not on PATH → subprocess.run raises FileNotFoundError. An
        # advisory gate must fail OPEN (return "" → "nothing to verify"), not
        # explode with a traceback and spuriously block the commit.
        def _boom(*a, **k):
            raise FileNotFoundError("git")

        monkeypatch.setattr(guardian_precommit.subprocess, "run", _boom)
        assert guardian_precommit.staged_diff() == ""


class TestMain:
    """The thin git-hook entrypoint shells to the pure core."""

    def test_runs_pipeline_and_prints_report(
        self, tmp_path, monkeypatch, capsys
    ) -> None:
        monkeypatch.chdir(tmp_path)
        monkeypatch.setattr(guardian_precommit, "staged_diff", lambda: DIFF_UNTESTED)
        monkeypatch.setattr(
            guardian_precommit, "harness_hook_present", lambda *a, **k: False
        )
        import agent.guardian.pr_check as prc

        monkeypatch.setattr(
            prc,
            "load_guardian_config",
            lambda *a, **k: (
                GuardianConfig(
                    precommit_enabled=True,
                    precommit_author_tests=False,
                    precommit_gate="soft",
                ),
                None,
            ),
        )
        code = guardian_precommit.main([])
        assert code == 0
        assert "widget" in capsys.readouterr().out

    def test_dedup_defers_without_running(self, monkeypatch) -> None:
        monkeypatch.setattr(
            guardian_precommit, "harness_hook_present", lambda *a, **k: True
        )

        def _boom() -> str:
            raise AssertionError("pipeline must not run when dedup defers")

        monkeypatch.setattr(guardian_precommit, "staged_diff", _boom)
        assert guardian_precommit.main([]) == 0

    def test_install_flag_installs(self, tmp_path, monkeypatch) -> None:
        called: dict = {}
        monkeypatch.setattr(
            guardian_precommit, "install", lambda: called.setdefault("did", True)
        )
        assert guardian_precommit.main(["--install"]) == 0
        assert called.get("did") is True
