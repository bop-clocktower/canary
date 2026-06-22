"""Version-consistency contract for the release surface.

Guards a single invariant: every machine-readable version declaration in the
repo agrees on one version string. The release bump is a manual step
(`chore(release): bump to vX.Y.Z`), and historically it touched only
`npm/package.json` + `pyproject.toml` while the two `.claude-plugin/`
manifests silently drifted (they sat at 4.0.0 through the entire 5.x line).

This test fails the moment the four declarations disagree, so the next manual
bump that forgets a file is caught in CI instead of shipping stale.

Scope note: README / brand-kit shields.io badges are *display* artifacts, not
canonical declarations, so they are intentionally out of scope here.
"""

import json
import re
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).parents[2]

_SEMVER = re.compile(r"^\d+\.\d+\.\d+([.-].+)?$")


def _npm_version() -> str:
    data = json.loads((REPO_ROOT / "npm" / "package.json").read_text(encoding="utf-8"))
    return data["version"]


def _pyproject_version() -> str:
    text = (REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8")
    # Match the [project] version line: version = "X.Y.Z"
    m = re.search(r'^version\s*=\s*"([^"]+)"', text, re.MULTILINE)
    assert m, "no version = \"...\" line found in pyproject.toml"
    return m.group(1)


def _plugin_version() -> str:
    data = json.loads(
        (REPO_ROOT / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8")
    )
    return data["version"]


def _marketplace_version() -> str:
    data = json.loads(
        (REPO_ROOT / ".claude-plugin" / "marketplace.json").read_text(encoding="utf-8")
    )
    canary = next(p for p in data["plugins"] if p["name"] == "canary")
    return canary["version"]


# (label, accessor) — package.json is the reference the others are compared to.
_SOURCES = [
    ("npm/package.json", _npm_version),
    ("pyproject.toml", _pyproject_version),
    (".claude-plugin/plugin.json", _plugin_version),
    (".claude-plugin/marketplace.json", _marketplace_version),
]


class TestVersionConsistency(unittest.TestCase):

    def test_all_versions_are_semver(self):
        for label, accessor in _SOURCES:
            with self.subTest(source=label):
                version = accessor()
                self.assertRegex(
                    version, _SEMVER,
                    f"{label} version '{version}' is not semver-shaped",
                )

    def test_all_versions_match(self):
        reference_label, reference_accessor = _SOURCES[0]
        reference = reference_accessor()
        for label, accessor in _SOURCES[1:]:
            with self.subTest(source=label):
                self.assertEqual(
                    accessor(), reference,
                    f"{label} version '{accessor()}' != {reference_label} "
                    f"version '{reference}' — bump every version declaration "
                    f"together (see chore(release) workflow).",
                )


if __name__ == "__main__":
    unittest.main()
