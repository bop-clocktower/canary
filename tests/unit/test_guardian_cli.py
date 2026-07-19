"""Unit tests for `canary guardian analyze --emit-diff` and `pr-check` wiring."""

from __future__ import annotations

import json
from dataclasses import replace

import pytest
from typer.testing import CliRunner

from agent.guardian import agent_tier as guardian_agent_tier
from agent.guardian import cli as guardian_cli
from agent.guardian.agent_tier import GeneratedTest
from agent.guardian.cli import guardian_app
from agent.guardian.pr_comment import STICKY_MARKER, FakeGitHubClient

runner = CliRunner()

DIFF_NEW_UNIT = """\
diff --git a/pkg/widget.py b/pkg/widget.py
index 1111111..2222222 100644
--- a/pkg/widget.py
+++ b/pkg/widget.py
@@ -0,0 +1,3 @@
+def widget():
+    return 42
+
"""

DIFF_DOCS_ONLY = """\
diff --git a/docs/x.md b/docs/x.md
index 1111111..2222222 100644
--- a/docs/x.md
+++ b/docs/x.md
@@ -0,0 +1,2 @@
+# Heading
+prose
"""

# A diff that adds BOTH a production unit and its test file. The test file must
# NOT become an "untested new code" finding — a test does not need a test.
DIFF_SRC_AND_TEST = """\
diff --git a/agent/core/foo.py b/agent/core/foo.py
index 1111111..2222222 100644
--- a/agent/core/foo.py
+++ b/agent/core/foo.py
@@ -0,0 +1,3 @@
+def foo():
+    return 1
+
diff --git a/tests/unit/test_foo.py b/tests/unit/test_foo.py
index 3333333..4444444 100644
--- a/tests/unit/test_foo.py
+++ b/tests/unit/test_foo.py
@@ -0,0 +1,3 @@
+def test_foo():
+    assert foo() == 1
+
"""

# A lockfile-only diff. A generated dependency lockfile must never trip a
# coverage gate — it is default-skipped (signal-quality FIX 1).
DIFF_LOCKFILE_ONLY = """\
diff --git a/package-lock.json b/package-lock.json
index 1111111..2222222 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -0,0 +1,3 @@
+{
+  "name": "lego-tracker"
+}
"""

# A built/bundled artifact under dist/ — also default-skipped (FIX 1).
DIFF_DIST_BUNDLE = """\
diff --git a/dist/bundle.js b/dist/bundle.js
index 1111111..2222222 100644
--- a/dist/bundle.js
+++ b/dist/bundle.js
@@ -0,0 +1,2 @@
+function t(){return 42}
+
"""

# A pure re-export barrel (index.ts): only imports/re-exports, no real logic.
# Must NOT be flagged as untested (signal-quality FIX 2).
DIFF_BARREL_INDEX_TS = """\
diff --git a/pkg/index.ts b/pkg/index.ts
index 1111111..2222222 100644
--- a/pkg/index.ts
+++ b/pkg/index.ts
@@ -0,0 +1,2 @@
+export { foo } from './foo';
+export * from './bar';
"""

# A real declaration (not a barrel) — MUST still be flagged.
DIFF_REAL_DECL_TS = """\
diff --git a/pkg/thing.ts b/pkg/thing.ts
index 1111111..2222222 100644
--- a/pkg/thing.ts
+++ b/pkg/thing.ts
@@ -0,0 +1,1 @@
+export function thing() { return 1 }
"""

# A Python barrel (__init__.py) with only a re-export.
DIFF_BARREL_INIT_PY = """\
diff --git a/pkg/__init__.py b/pkg/__init__.py
index 1111111..2222222 100644
--- a/pkg/__init__.py
+++ b/pkg/__init__.py
@@ -0,0 +1,1 @@
+from .x import Y
"""

_BEFORE = {"openapi": "3.0.0", "paths": {"/members": {"get": {"operationId": "list"}}}}
_AFTER = {
    "openapi": "3.0.0",
    "paths": {
        "/members": {"get": {"operationId": "list"}},
        "/members/bulk": {"post": {"operationId": "bulk"}},
    },
}


def _write_specs(tmp_path):
    before = tmp_path / "before.json"
    after = tmp_path / "after.json"
    before.write_text(json.dumps(_BEFORE))
    after.write_text(json.dumps(_AFTER))
    return str(before), str(after)


def test_emit_diff_writes_contract_artifact(tmp_path):
    before, after = _write_specs(tmp_path)
    out = tmp_path / "api-delta.json"
    res = runner.invoke(
        guardian_app,
        ["analyze", "abc1234", "--spec-before", before, "--spec-after", after,
         "--suite", "api", "--emit-diff", str(out), "--dry-run"],
    )
    assert res.exit_code == 0
    assert out.exists()
    delta = json.loads(out.read_text())
    assert delta["schema_version"] == 1
    assert delta["sut"]["suite"] == "api"
    assert delta["summary"]["added"] == 1
    # method upper-cased, path verbatim
    assert delta["endpoints"]["added"][0] == {"method": "POST", "path": "/members/bulk"}


def test_without_emit_diff_no_file_written(tmp_path):
    before, after = _write_specs(tmp_path)
    out = tmp_path / "api-delta.json"
    res = runner.invoke(
        guardian_app,
        ["analyze", "abc1234", "--spec-before", before, "--spec-after", after, "--dry-run"],
    )
    assert res.exit_code == 0
    assert not out.exists()


def _write_config(tmp_path, guardian_block: dict) -> str:
    path = tmp_path / "harness.config.json"
    path.write_text(json.dumps({"canary": {"guardian": guardian_block}}), encoding="utf-8")
    return str(path)


class TestPrContextFromEnv:
    """`_pr_context_from_env` resolves (repo, pr) from Actions env, else None."""

    def test_resolves_repo_and_pr_from_ref(self, monkeypatch) -> None:
        monkeypatch.setenv("GITHUB_REPOSITORY", "o/r")
        monkeypatch.setenv("GITHUB_REF", "refs/pull/7/merge")
        monkeypatch.delenv("GITHUB_EVENT_PATH", raising=False)
        assert guardian_cli._pr_context_from_env() == ("o/r", 7)

    def test_returns_none_when_unset(self, monkeypatch) -> None:
        monkeypatch.delenv("GITHUB_REPOSITORY", raising=False)
        monkeypatch.delenv("GITHUB_REF", raising=False)
        monkeypatch.delenv("GITHUB_EVENT_PATH", raising=False)
        assert guardian_cli._pr_context_from_env() is None

    def test_event_path_fallback_for_pr_number(self, monkeypatch, tmp_path) -> None:
        event = tmp_path / "event.json"
        event.write_text(json.dumps({"pull_request": {"number": 42}}), encoding="utf-8")
        monkeypatch.setenv("GITHUB_REPOSITORY", "o/r")
        monkeypatch.setenv("GITHUB_REF", "refs/heads/main")  # unparseable for PR
        monkeypatch.setenv("GITHUB_EVENT_PATH", str(event))
        assert guardian_cli._pr_context_from_env() == ("o/r", 42)


class TestForkContext:
    """FIX 4: fork detection FAILS CLOSED on ambiguity. Only two safe sentinels
    mean "not a fork" — unset OR exactly ``"0"`` (after strip). ANY other
    non-empty value (``"1"``, ``"true"``, whitespace-wrapped, garbage) is treated
    as a fork so authoring is SKIPPED (guard b) rather than fail-open writing."""

    def test_unset_is_not_fork(self, monkeypatch) -> None:
        monkeypatch.delenv("CANARY_GUARDIAN_IS_FORK", raising=False)
        assert guardian_cli._is_fork_context() is False

    def test_zero_is_not_fork(self, monkeypatch) -> None:
        monkeypatch.setenv("CANARY_GUARDIAN_IS_FORK", "0")
        assert guardian_cli._is_fork_context() is False

    def test_zero_whitespace_wrapped_is_not_fork(self, monkeypatch) -> None:
        monkeypatch.setenv("CANARY_GUARDIAN_IS_FORK", "  0  ")
        assert guardian_cli._is_fork_context() is False

    @pytest.mark.parametrize("value", ["1", "true", "yes", "  1 ", "x"])
    def test_any_other_value_is_fork(self, monkeypatch, value) -> None:
        monkeypatch.setenv("CANARY_GUARDIAN_IS_FORK", value)
        assert guardian_cli._is_fork_context() is True

    def test_author_plan_forks_skip_authoring(self, tmp_path, monkeypatch) -> None:
        # Wire through plan_authoring via author-plan: opt-in on + tier 2 signalled,
        # but IS_FORK armed → every intent is skipped with a "fork" reason, no block.
        monkeypatch.chdir(tmp_path)
        monkeypatch.setenv("CANARY_GUARDIAN_AGENT", "2")
        monkeypatch.setenv("CANARY_GUARDIAN_IS_FORK", "true")
        cfg = _write_config(
            tmp_path, {"preCommit": {"enabled": True, "authorTests": True}}
        )
        result = self.runner.invoke(
            guardian_app,
            ["author-plan", "--diff", "-", "--config", cfg],
            input=DIFF_NEW_UNIT,
        )
        assert result.exit_code == 0
        data = json.loads(result.stdout)
        assert all(i["status"] == "skipped" for i in data["intents"])
        assert "fork" in data["intents"][0]["skip_reason"]
        assert data["block"]["block"] is False

    runner = CliRunner()


class TestPrCheckPost:
    """SC-1/SC-2/OT-4/OT-5: `--post-comment` pipeline (network-free)."""

    runner = CliRunner()

    def _use_env(self, monkeypatch) -> None:
        monkeypatch.setenv("GITHUB_REPOSITORY", "o/r")
        monkeypatch.setenv("GITHUB_REF", "refs/pull/7/merge")
        monkeypatch.delenv("GITHUB_EVENT_PATH", raising=False)

    def test_post_creates_single_sticky_comment(self, tmp_path, monkeypatch) -> None:
        monkeypatch.chdir(tmp_path)
        self._use_env(monkeypatch)
        fake = FakeGitHubClient()
        monkeypatch.setattr(guardian_cli, "_build_client", lambda *_: fake)
        result = self.runner.invoke(
            guardian_app,
            ["pr-check", "--diff", "-", "--post-comment"],
            input=DIFF_NEW_UNIT,
        )
        assert result.exit_code == 0  # soft gate default
        marked = [c for c in fake.list_comments() if STICKY_MARKER in c["body"]]
        assert len(marked) == 1  # SC-1 post path

    def test_docs_only_skips_and_posts_nothing(self, tmp_path, monkeypatch) -> None:
        monkeypatch.chdir(tmp_path)
        self._use_env(monkeypatch)
        fake = FakeGitHubClient()
        monkeypatch.setattr(guardian_cli, "_build_client", lambda *_: fake)
        cfg = _write_config(tmp_path, {"skipGlobs": ["docs/**"]})
        result = self.runner.invoke(
            guardian_app,
            ["pr-check", "--diff", "-", "--config", cfg, "--post-comment"],
            input=DIFF_DOCS_ONLY,
        )
        assert result.exit_code == 0
        assert "nothing to verify" in result.stdout
        assert fake.list_comments() == []  # SC-2: no comment

    def test_test_files_never_become_findings(self, tmp_path, monkeypatch) -> None:
        # FIX A: a diff adding both agent/core/foo.py (untested) and its test
        # tests/unit/test_foo.py must yield a finding ONLY for foo.py — the test
        # file is a test-path unit and must be dropped before findings build.
        (tmp_path / "agent" / "core").mkdir(parents=True)
        (tmp_path / "agent" / "core" / "foo.py").write_text(
            "def foo():\n    return 1\n", encoding="utf-8"
        )
        monkeypatch.chdir(tmp_path)
        result = self.runner.invoke(
            guardian_app,
            ["pr-check", "--diff", "-", "--format", "json", "--gate", "soft"],
            input=DIFF_SRC_AND_TEST,
        )
        assert result.exit_code == 0
        data = json.loads(result.stdout)
        paths = {f["path"] for f in data["findings"]}
        assert "agent/core/foo.py" in paths  # production unit still flagged
        assert "tests/unit/test_foo.py" not in paths  # test file dropped

    def test_docs_only_skips_by_default(self, tmp_path, monkeypatch) -> None:
        # FIX B: with no config (or no skipGlobs key) a docs/markdown-only diff
        # skips by default — the guardian no longer flags SKILLS.md-style paths.
        monkeypatch.chdir(tmp_path)
        self._use_env(monkeypatch)
        fake = FakeGitHubClient()
        monkeypatch.setattr(guardian_cli, "_build_client", lambda *_: fake)
        result = self.runner.invoke(
            guardian_app,
            ["pr-check", "--diff", "-", "--post-comment"],
            input=DIFF_DOCS_ONLY,
        )
        assert result.exit_code == 0
        assert "nothing to verify" in result.stdout
        assert fake.list_comments() == []  # no finding posted

    def test_lockfile_only_skips_by_default(self, tmp_path, monkeypatch) -> None:
        # FIX 1: a generated lockfile (package-lock.json) is default-skipped —
        # no config, no skipGlobs key → "nothing to verify", NO finding.
        monkeypatch.chdir(tmp_path)
        result = self.runner.invoke(
            guardian_app,
            ["pr-check", "--diff", "-", "--format", "json"],
            input=DIFF_LOCKFILE_ONLY,
        )
        assert result.exit_code == 0
        assert "nothing to verify" in result.stdout

    def test_dist_bundle_skips_by_default(self, tmp_path, monkeypatch) -> None:
        # FIX 1: a built artifact under dist/ is default-skipped too.
        monkeypatch.chdir(tmp_path)
        result = self.runner.invoke(
            guardian_app,
            ["pr-check", "--diff", "-", "--format", "json"],
            input=DIFF_DIST_BUNDLE,
        )
        assert result.exit_code == 0
        assert "nothing to verify" in result.stdout

    def test_explicit_empty_skipglobs_disables_default_skip(
        self, tmp_path, monkeypatch
    ) -> None:
        # FIX 1: an explicit `skipGlobs: []` OVERRIDES the default set, so a
        # lockfile is NO LONGER skipped — it flows through to a finding. Proves
        # absent-key (default) is distinguished from present-empty (override).
        monkeypatch.chdir(tmp_path)
        cfg = _write_config(tmp_path, {"skipGlobs": []})
        result = self.runner.invoke(
            guardian_app,
            ["pr-check", "--diff", "-", "--config", cfg, "--format", "json"],
            input=DIFF_LOCKFILE_ONLY,
        )
        assert result.exit_code == 0
        data = json.loads(result.stdout)
        paths = {f["path"] for f in data["findings"]}
        assert "package-lock.json" in paths  # override honored: NOT skipped

    def test_barrel_index_ts_not_flagged(self, tmp_path, monkeypatch) -> None:
        # FIX 2: an index.ts whose added lines are ONLY re-exports is a barrel —
        # "nothing to verify", NO finding.
        monkeypatch.chdir(tmp_path)
        result = self.runner.invoke(
            guardian_app,
            ["pr-check", "--diff", "-", "--format", "json"],
            input=DIFF_BARREL_INDEX_TS,
        )
        assert result.exit_code == 0
        assert "nothing to verify" in result.stdout

    def test_real_declaration_still_flagged(self, tmp_path, monkeypatch) -> None:
        # FIX 2 discrimination: a real exported function is NOT a barrel and MUST
        # remain flagged — a false skip is worse than a false flag.
        (tmp_path / "pkg").mkdir()
        (tmp_path / "pkg" / "thing.ts").write_text(
            "export function thing() { return 1 }\n", encoding="utf-8"
        )
        monkeypatch.chdir(tmp_path)
        result = self.runner.invoke(
            guardian_app,
            ["pr-check", "--diff", "-", "--format", "json"],
            input=DIFF_REAL_DECL_TS,
        )
        assert result.exit_code == 0
        data = json.loads(result.stdout)
        paths = {f["path"] for f in data["findings"]}
        assert "pkg/thing.ts" in paths  # real declaration still flagged

    def test_python_barrel_init_not_flagged(self, tmp_path, monkeypatch) -> None:
        # FIX 2: a Python __init__.py adding only `from .x import Y` is a barrel.
        monkeypatch.chdir(tmp_path)
        result = self.runner.invoke(
            guardian_app,
            ["pr-check", "--diff", "-", "--format", "json"],
            input=DIFF_BARREL_INIT_PY,
        )
        assert result.exit_code == 0
        assert "nothing to verify" in result.stdout

    def test_pr_disabled_skips_surface(self, tmp_path, monkeypatch) -> None:
        monkeypatch.chdir(tmp_path)
        self._use_env(monkeypatch)
        fake = FakeGitHubClient()
        monkeypatch.setattr(guardian_cli, "_build_client", lambda *_: fake)
        cfg = _write_config(tmp_path, {"pr": {"enabled": False}})
        result = self.runner.invoke(
            guardian_app,
            ["pr-check", "--diff", "-", "--config", cfg, "--post-comment"],
            input=DIFF_NEW_UNIT,
        )
        assert result.exit_code == 0
        assert "skipping PR surface" in result.stdout
        assert fake.list_comments() == []  # OT-5

    def test_read_only_token_degrades_to_warning(self, tmp_path, monkeypatch) -> None:
        monkeypatch.chdir(tmp_path)
        self._use_env(monkeypatch)
        fake = FakeGitHubClient(deny_writes=True)
        monkeypatch.setattr(guardian_cli, "_build_client", lambda *_: fake)
        result = self.runner.invoke(
            guardian_app,
            ["pr-check", "--diff", "-", "--post-comment"],
            input=DIFF_NEW_UNIT,
        )
        assert result.exit_code == 0  # OT-4: no crash
        assert "::warning::" in result.stdout

    def test_no_pr_context_prints_instead(self, tmp_path, monkeypatch) -> None:
        monkeypatch.chdir(tmp_path)
        monkeypatch.delenv("GITHUB_REPOSITORY", raising=False)
        monkeypatch.delenv("GITHUB_REF", raising=False)
        monkeypatch.delenv("GITHUB_EVENT_PATH", raising=False)
        result = self.runner.invoke(
            guardian_app,
            ["pr-check", "--diff", "-", "--post-comment"],
            input=DIFF_NEW_UNIT,
        )
        assert result.exit_code == 0
        assert STICKY_MARKER in result.stdout  # printed the comment body


class TestPrCheckTierDegradation:
    """SC-5 (PR half): a requested tier>0 with no agent degrades LOUDLY on both
    the rendered footer AND the Actions `::warning::`/step-summary channel — the
    silent `tier N` footer bug is fixed."""

    runner = CliRunner()

    def _use_env(self, monkeypatch) -> None:
        monkeypatch.setenv("GITHUB_REPOSITORY", "o/r")
        monkeypatch.setenv("GITHUB_REF", "refs/pull/7/merge")
        monkeypatch.delenv("GITHUB_EVENT_PATH", raising=False)

    def test_tier_one_degrades_loudly_local(self, tmp_path, monkeypatch) -> None:
        monkeypatch.chdir(tmp_path)
        cfg = _write_config(tmp_path, {"pr": {"tier": 1}})
        result = self.runner.invoke(
            guardian_app,
            ["pr-check", "--diff", "-", "--config", cfg, "--format", "text"],
            input=DIFF_NEW_UNIT,
        )
        assert result.exit_code == 0  # soft gate default
        # Loud Actions channel:
        assert "::warning::" in result.stdout
        assert "tier 1" in result.stdout
        assert "degraded" in result.stdout
        # Rendered footer shows the EFFECTIVE tier (0) with the degraded notice —
        # never a silent `tier 1` footer with no agent.
        assert "tier 0" in result.stdout

    def test_tier_zero_no_false_degradation(self, tmp_path, monkeypatch) -> None:
        monkeypatch.chdir(tmp_path)
        cfg = _write_config(tmp_path, {"pr": {"tier": 0}})
        result = self.runner.invoke(
            guardian_app,
            ["pr-check", "--diff", "-", "--config", cfg, "--format", "text"],
            input=DIFF_NEW_UNIT,
        )
        assert result.exit_code == 0
        assert "::warning::" not in result.stdout  # no tier-path warning
        assert "degraded" not in result.stdout  # regression guard

    def test_tier_two_degrades_on_both_channels_when_posting(
        self, tmp_path, monkeypatch
    ) -> None:
        monkeypatch.chdir(tmp_path)
        self._use_env(monkeypatch)
        summary = tmp_path / "step_summary.md"
        monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))
        fake = FakeGitHubClient()
        monkeypatch.setattr(guardian_cli, "_build_client", lambda *_: fake)
        cfg = _write_config(tmp_path, {"pr": {"tier": 2}})
        result = self.runner.invoke(
            guardian_app,
            ["pr-check", "--diff", "-", "--config", cfg, "--post-comment"],
            input=DIFF_NEW_UNIT,
        )
        assert result.exit_code == 0
        # Channel 1: the posted comment body carries the degraded notice.
        marked = [c for c in fake.list_comments() if STICKY_MARKER in c["body"]]
        assert len(marked) == 1
        assert "⚠ degraded: tier 2" in marked[0]["body"]
        # Channel 2: the Actions step-summary file receives the notice.
        assert "tier 2" in summary.read_text(encoding="utf-8")
        assert "::warning::" in result.stdout


class _FakeAuthorInvoker:
    """Network-free invoker: ``author`` returns an ``authored`` record so the
    author-plan seam is exercised end-to-end without a real agent/LLM (Option A
    test double). ``review`` is unused here."""

    def review(self, request) -> str:  # pragma: no cover - not exercised
        return ""

    def author(self, intent: GeneratedTest) -> GeneratedTest:
        return replace(intent, status="authored", written_path=intent.target_path)


class TestAuthorPlan:
    """T7: the in-session ``author-plan --json`` seam. Builds gaps via the SAME
    Tier-0 pipeline as pr-check, resolves the tier with ``InSessionAgentProbe``,
    applies the safety model, and emits ``{"intents": [...], "block": {...}}``.
    Every agent interaction goes through an injected fake — no real agent/LLM."""

    runner = CliRunner()

    def test_optin_off_skips_all_intents_no_block(self, tmp_path, monkeypatch) -> None:
        # (d) opt-in default off: an untested new unit yields a skipped intent and
        # no block — authoring never fires without the explicit opt-in.
        monkeypatch.chdir(tmp_path)
        monkeypatch.delenv("CANARY_GUARDIAN_AGENT", raising=False)
        result = self.runner.invoke(
            guardian_app,
            ["author-plan", "--diff", "-"],
            input=DIFF_NEW_UNIT,
        )
        assert result.exit_code == 0
        data = json.loads(result.stdout)
        assert data["intents"], "expected one intent for the untested unit"
        assert all(i["status"] == "skipped" for i in data["intents"])
        assert "opt-in" in data["intents"][0]["skip_reason"]
        assert data["block"]["block"] is False
        assert data["block"]["authored_count"] == 0

    def test_optin_on_with_agent_authors_and_blocks(
        self, tmp_path, monkeypatch
    ) -> None:
        # Opt-in on + a signalled tier-2 runtime + a fake author invoker → the gap
        # is authored & staged (block once). No collision (target does not exist).
        monkeypatch.chdir(tmp_path)
        monkeypatch.setenv("CANARY_GUARDIAN_AGENT", "2")
        cfg = _write_config(
            tmp_path, {"preCommit": {"enabled": True, "authorTests": True}}
        )
        real_cls = guardian_agent_tier.InSessionAgentTier
        monkeypatch.setattr(
            guardian_agent_tier,
            "InSessionAgentTier",
            lambda *a, **k: real_cls(invoker=_FakeAuthorInvoker()),
        )
        result = self.runner.invoke(
            guardian_app,
            ["author-plan", "--diff", "-", "--config", cfg],
            input=DIFF_NEW_UNIT,
        )
        assert result.exit_code == 0
        data = json.loads(result.stdout)
        authored = [i for i in data["intents"] if i["status"] == "authored"]
        assert len(authored) >= 1
        assert authored[0]["written_path"]
        assert data["block"]["block"] is True
        assert data["block"]["authored_count"] >= 1
        assert "re-commit" in data["block"]["message"]

    def test_optin_on_production_path_recording_invoker_blocks(
        self, tmp_path, monkeypatch
    ) -> None:
        # FIX 1 (production path): NO fake author invoker — the DEFAULT
        # RecordingInvoker leaves intents ``planned`` (Option A). With opt-in on
        # and a signalled tier-2 runtime, an untested gap must produce a
        # ``planned`` intent AND block, so the SKILL actually gates. This is the
        # real path that the old ``_FakeAuthorInvoker`` masked.
        monkeypatch.chdir(tmp_path)
        monkeypatch.setenv("CANARY_GUARDIAN_AGENT", "2")
        monkeypatch.delenv("CANARY_GUARDIAN_IS_FORK", raising=False)
        cfg = _write_config(
            tmp_path, {"preCommit": {"enabled": True, "authorTests": True}}
        )
        result = self.runner.invoke(
            guardian_app,
            ["author-plan", "--diff", "-", "--config", cfg],
            input=DIFF_NEW_UNIT,
        )
        assert result.exit_code == 0
        data = json.loads(result.stdout)
        planned = [i for i in data["intents"] if i["status"] == "planned"]
        assert len(planned) >= 1  # RecordingInvoker keeps it planned
        assert data["block"]["block"] is True
        assert data["block"]["authored_count"] >= 1
        assert "review" in data["block"]["message"]
        assert "re-commit" in data["block"]["message"]

    def test_optin_on_without_agent_degrades_to_skip(
        self, tmp_path, monkeypatch
    ) -> None:
        # Opt-in on but NO runtime signalled (env unset) → effective tier 0 →
        # the tier guard skips authoring; nothing is authored, no block.
        monkeypatch.chdir(tmp_path)
        monkeypatch.delenv("CANARY_GUARDIAN_AGENT", raising=False)
        cfg = _write_config(
            tmp_path, {"preCommit": {"enabled": True, "authorTests": True}}
        )
        result = self.runner.invoke(
            guardian_app,
            ["author-plan", "--diff", "-", "--config", cfg],
            input=DIFF_NEW_UNIT,
        )
        assert result.exit_code == 0
        data = json.loads(result.stdout)
        assert all(i["status"] == "skipped" for i in data["intents"])
        assert "tier" in data["intents"][0]["skip_reason"]
        assert data["block"]["block"] is False
