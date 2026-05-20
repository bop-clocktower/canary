"""Tests for agent.core.feedback."""

import importlib

import agent.core.feedback as fb


def _payload(**overrides):
    base = dict(
        prompt="Test that login works",
        test_type="e2e_ui",
        framework="playwright",
        provider="anthropic",
        model="claude-3-5-sonnet",
        output_file="tests/generated/playwright_test_1.spec.ts",
    )
    base.update(overrides)
    return fb.FeedbackPayload(**base)


def test_build_issue_url_contains_repo_and_payload_fields():
    url = fb.build_issue_url(_payload())
    assert "github.com/bri-stevenski/oracle-test-ai-agent/issues/new" in url
    for fragment in ("e2e_ui", "playwright", "anthropic", "claude-3-5-sonnet"):
        assert fragment in url


def test_build_issue_url_truncates_long_prompts():
    url = fb.build_issue_url(_payload(prompt="x" * 20000))
    assert len(url) <= 8000
    assert "truncated" in url


def test_build_issue_url_uses_env_override(monkeypatch):
    monkeypatch.setenv("ORACLE_FEEDBACK_REPO", "team/sink")
    importlib.reload(fb)
    url = fb.build_issue_url(_payload())
    assert "team/sink" in url
    monkeypatch.delenv("ORACLE_FEEDBACK_REPO")
    importlib.reload(fb)


def test_record_and_load_last_generation(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    payload = _payload()
    path = fb.record_last_generation(payload)
    assert path.exists()
    loaded = fb.load_last_generation()
    assert loaded == payload


def test_load_last_generation_missing_returns_none(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    assert fb.load_last_generation() is None


def test_feedback_command_prints_url_after_generate(tmp_path, monkeypatch):
    from typer.testing import CliRunner
    from agent.cli import app
    monkeypatch.chdir(tmp_path)
    fb.record_last_generation(_payload())
    runner = CliRunner()
    res = runner.invoke(app, ["feedback"])
    assert res.exit_code == 0
    assert "github.com" in res.stdout


def test_feedback_command_errors_without_state(tmp_path, monkeypatch):
    from typer.testing import CliRunner
    from agent.cli import app
    monkeypatch.chdir(tmp_path)
    runner = CliRunner()
    res = runner.invoke(app, ["feedback"])
    assert res.exit_code != 0
    assert "oracle generate" in res.stdout.lower()


def test_load_last_generation_corrupt_state_returns_none(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    state_dir = tmp_path / ".oracle"
    state_dir.mkdir()
    (state_dir / "last_generation.json").write_text("{not-valid-json")
    assert fb.load_last_generation() is None


def test_load_last_generation_stale_schema_returns_none(tmp_path, monkeypatch):
    """A JSON file missing required fields (old schema) loads as None, not a crash."""
    monkeypatch.chdir(tmp_path)
    state_dir = tmp_path / ".oracle"
    state_dir.mkdir()
    (state_dir / "last_generation.json").write_text('{"prompt": "only field"}')
    assert fb.load_last_generation() is None


def test_record_last_generation_raises_oserror_on_disk_failure(tmp_path, monkeypatch):
    """Contract test: record_last_generation propagates OSError; the CLI is
    responsible for swallowing it so a feedback-state hiccup never crashes
    `oracle generate`."""
    import pytest
    monkeypatch.chdir(tmp_path)
    import agent.core.feedback as fb_mod

    def _boom(self, *_a, **_kw):
        raise OSError("disk full")

    monkeypatch.setattr(fb_mod.Path, "write_text", _boom, raising=True)
    with pytest.raises(OSError):
        fb_mod.record_last_generation(_payload())


def test_build_issue_url_embeds_provider_and_model_in_body():
    """End-to-end: provider/model fragments must land in the URL body, not just the title."""
    from urllib.parse import unquote
    url = fb.build_issue_url(_payload(provider="gemini", model="gemini-1.5-flash"))
    _, _, query = url.partition("?")
    body_q = query.split("&body=", 1)[1]
    body = unquote(body_q)
    assert "**Provider:** gemini" in body
    assert "**Model:** gemini-1.5-flash" in body


def test_build_issue_url_warns_public_in_body():
    body = fb.build_issue_url(_payload())
    from urllib.parse import unquote
    decoded = unquote(body)
    assert "public" in decoded.lower()


def test_build_issue_url_truncation_does_not_break_percent_encoding():
    """Truncation must not slice mid-%XX triplet."""
    url = fb.build_issue_url(_payload(prompt="é" * 5000))  # multi-byte → many %XX
    assert len(url) <= 8000
    # Every '%' must be followed by exactly two hex chars
    i = 0
    while i < len(url):
        if url[i] == "%":
            assert i + 2 < len(url), f"truncated %XX at position {i}"
            assert all(c in "0123456789ABCDEFabcdef" for c in url[i + 1:i + 3])
            i += 3
        else:
            i += 1
