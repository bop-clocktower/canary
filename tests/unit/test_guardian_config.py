"""TDD for agent.guardian.pr_check.load_guardian_config (SC-8).

The loader reads the ``canary.guardian`` block from ``harness.config.json`` via
:func:`agent.core.config_validation.read_json_with_warning`, so a malformed file
surfaces a loud warning instead of silently degrading to defaults.
"""

from __future__ import annotations

import json

from agent.guardian.pr_check import GuardianConfig, load_guardian_config


def _write(path, obj) -> None:
    path.write_text(json.dumps(obj), encoding="utf-8")


class TestLoadGuardianConfig:
    def test_valid_block_parsed(self, tmp_path) -> None:
        cfg = tmp_path / "harness.config.json"
        _write(cfg, {
            "canary": {
                "guardian": {
                    "pr": {"enabled": False, "tier": 2, "gate": "hard"},
                    "preCommit": {
                        "enabled": True,
                        "authorTests": False,
                        "gate": "hard",
                    },
                    "coveragePaths": ["coverage.json"],
                    "skipGlobs": ["docs/**", "*.md"],
                }
            }
        })
        config, warning = load_guardian_config(cfg)
        assert warning is None
        assert isinstance(config, GuardianConfig)
        assert config.pr_enabled is False
        assert config.pr_tier == 2
        assert config.pr_gate == "hard"
        assert config.precommit_enabled is True
        assert config.precommit_author_tests is False
        assert config.precommit_gate == "hard"
        assert config.coverage_paths == ["coverage.json"]
        # skipGlobs is stored but unused in Phase 1 (SC-2 is a later phase).
        assert config.skip_globs == ["docs/**", "*.md"]

    def test_malformed_json_warns_and_defaults(self, tmp_path) -> None:
        cfg = tmp_path / "harness.config.json"
        cfg.write_text("{ this is not json ", encoding="utf-8")
        config, warning = load_guardian_config(cfg)
        assert warning is not None  # SC-8: loud, not silent
        assert config == GuardianConfig()  # falls back to defaults

    def test_absent_file_silent_defaults(self, tmp_path) -> None:
        config, warning = load_guardian_config(tmp_path / "nope.json")
        assert warning is None
        assert config == GuardianConfig()

    def test_valid_file_without_block_silent_defaults(self, tmp_path) -> None:
        cfg = tmp_path / "harness.config.json"
        _write(cfg, {"something": "else"})
        config, warning = load_guardian_config(cfg)
        assert warning is None
        assert config == GuardianConfig()

    def test_defaults(self) -> None:
        c = GuardianConfig()
        assert c.pr_enabled is True
        assert c.pr_tier == 0
        assert c.pr_gate == "soft"
        assert c.precommit_enabled is False
        assert c.coverage_paths == []
        # FIX B + signal-quality: skipGlobs defaults to docs/markdown AND
        # generated/lockfiles (lockfiles, dist/build, minified, snapshots).
        assert c.skip_globs == _DEFAULT_SKIP_GLOBS

    def test_non_int_tier_warns_and_defaults(self, tmp_path) -> None:
        # FIX 4: a non-integer tier must not crash int() — warn loudly (same slot
        # as malformed JSON) and fall back to the default tier.
        cfg = tmp_path / "harness.config.json"
        _write(cfg, {"canary": {"guardian": {"pr": {"tier": "medium"}}}})
        config, warning = load_guardian_config(cfg)
        assert warning is not None  # loud, echoed by the CLI
        assert config.pr_tier == GuardianConfig().pr_tier  # default

    def test_fractional_tier_warns_and_defaults(self, tmp_path) -> None:
        # FIX 4: a fractional tier is not a valid integer tier → warn + default.
        cfg = tmp_path / "harness.config.json"
        _write(cfg, {"canary": {"guardian": {"pr": {"tier": 1.5}}}})
        config, warning = load_guardian_config(cfg)
        assert warning is not None
        assert config.pr_tier == GuardianConfig().pr_tier

    def test_unknown_gate_warns_and_defaults(self, tmp_path) -> None:
        # FIX 4: a gate outside {soft, hard} must warn and fall back to default.
        cfg = tmp_path / "harness.config.json"
        _write(cfg, {"canary": {"guardian": {"pr": {"gate": "banana"}}}})
        config, warning = load_guardian_config(cfg)
        assert warning is not None
        assert config.pr_gate == GuardianConfig().pr_gate  # default "soft"

    def test_list_tier_warns_and_defaults(self, tmp_path) -> None:
        # FIX 4: a non-scalar tier must not crash and falls back to default.
        cfg = tmp_path / "harness.config.json"
        _write(cfg, {"canary": {"guardian": {"pr": {"tier": []}}}})
        config, warning = load_guardian_config(cfg)
        assert warning is not None
        assert config.pr_tier == GuardianConfig().pr_tier


_DEFAULT_SKIP_GLOBS = [
    "docs/**",
    "**/*.md",
    "**/package-lock.json",
    "**/yarn.lock",
    "**/pnpm-lock.yaml",
    "**/poetry.lock",
    "**/Cargo.lock",
    "**/*.lock",
    "dist/**",
    "build/**",
    "**/*.min.js",
    "**/*.snap",
]


class TestSkipGlobsDefault:
    """FIX B + signal-quality: skipGlobs defaults to docs/markdown AND
    generated/lockfiles when the key is ABSENT, but an explicit value (even [])
    overrides — absent must be distinguished from present-and-empty (SC-2)."""

    def test_absent_key_falls_back_to_default_globs(self, tmp_path) -> None:
        # A guardian block that never mentions skipGlobs → default docs/md skip.
        cfg = tmp_path / "harness.config.json"
        _write(cfg, {"canary": {"guardian": {"pr": {"gate": "hard"}}}})
        config, warning = load_guardian_config(cfg)
        assert warning is None
        assert config.skip_globs == _DEFAULT_SKIP_GLOBS

    def test_explicit_empty_list_overrides_default(self, tmp_path) -> None:
        # skipGlobs present as [] means "skip nothing" — honor the empty override.
        cfg = tmp_path / "harness.config.json"
        _write(cfg, {"canary": {"guardian": {"skipGlobs": []}}})
        config, warning = load_guardian_config(cfg)
        assert warning is None
        assert config.skip_globs == []

    def test_explicit_globs_used_verbatim(self, tmp_path) -> None:
        cfg = tmp_path / "harness.config.json"
        _write(cfg, {"canary": {"guardian": {"skipGlobs": ["build/**"]}}})
        config, warning = load_guardian_config(cfg)
        assert warning is None
        assert config.skip_globs == ["build/**"]

    def test_no_block_uses_default_globs(self, tmp_path) -> None:
        # No guardian block at all → defaults, which now include the skip globs.
        cfg = tmp_path / "harness.config.json"
        _write(cfg, {"something": "else"})
        config, _ = load_guardian_config(cfg)
        assert config.skip_globs == _DEFAULT_SKIP_GLOBS
