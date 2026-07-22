"""Node-gated behavioral tests for the .harness/hooks/*.js quality/routing hooks.

Gap 5 of issue #310 (harness↔canary hook seam). These hooks are shipped JS that
CI's Python suite never exercised, so their exit-code policy could silently rot.
Following the node-gated pattern of test_sentinel_source_scope.py (skip when node
is absent) we drive the real hook scripts as subprocesses and assert:

  * ``quality-warner.js`` / ``format-check.js`` — exit 0 on a clean file and on
    a project with no formatter (fail-open), exit 2 on a real lint violation,
    and exit 0 on empty stdin (fail-open);
  * ``prefer-first-party-mcp.js`` — injects the routing reminder for a
    third-party MCP tool but stays silent for first-party prefixes, including
    ``mcp__canary-mcp__`` which it now trusts per #309.

Written as unittest.TestCase so they run under both ``pytest`` and CI's
``python -m unittest discover``.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
_HOOKS = _REPO / ".harness" / "hooks"

_HAVE_NODE = shutil.which("node") is not None
_HAVE_RUFF = shutil.which("ruff") is not None


def _run_hook(hook: str, payload: dict, cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["node", str(_HOOKS / hook)],
        input=json.dumps(payload),
        text=True,
        cwd=str(cwd),
        capture_output=True,
    )


@unittest.skipUnless(_HAVE_NODE, "node required to exercise the JS hooks")
class TestQualityWarnerExitCodes(unittest.TestCase):
    """quality-warner.js wraps format-check.js; its exit code is the policy."""

    def _project(self, files: dict[str, str]) -> Path:
        tmp = tempfile.mkdtemp()
        root = Path(tmp)
        for name, content in files.items():
            (root / name).write_text(content, encoding="utf-8")
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        return root

    def test_no_formatter_config_fails_open(self):
        """No detectable formatter → 'clean' → exit 0 (never wall off an edit)."""
        root = self._project({"whatever.py": "x = 1\n"})
        cp = _run_hook(
            "quality-warner.js",
            {"tool_input": {"file_path": str(root / "whatever.py")}},
            root,
        )
        self.assertEqual(cp.returncode, 0)

    def test_empty_stdin_fails_open(self):
        root = self._project({})
        cp = subprocess.run(
            ["node", str(_HOOKS / "quality-warner.js")],
            input="",
            text=True,
            cwd=str(root),
            capture_output=True,
        )
        self.assertEqual(cp.returncode, 0)

    @unittest.skipUnless(_HAVE_RUFF, "ruff required to trigger a real violation")
    def test_clean_file_with_ruff_passes(self):
        root = self._project({"ruff.toml": "line-length = 100\n", "clean.py": "x = 1\n"})
        cp = _run_hook(
            "quality-warner.js",
            {"tool_input": {"file_path": str(root / "clean.py")}},
            root,
        )
        self.assertEqual(cp.returncode, 0, cp.stderr)

    @unittest.skipUnless(_HAVE_RUFF, "ruff required to trigger a real violation")
    def test_violating_file_blocks_with_exit_2(self):
        # F401: unused import — a deterministic ruff violation.
        root = self._project({"ruff.toml": "line-length = 100\n", "bad.py": "import os\n"})
        cp = _run_hook(
            "quality-warner.js",
            {"tool_input": {"file_path": str(root / "bad.py")}},
            root,
        )
        self.assertEqual(cp.returncode, 2, cp.stdout + cp.stderr)
        self.assertIn("BLOCKED", cp.stderr)


@unittest.skipUnless(_HAVE_NODE, "node required to exercise the JS hooks")
class TestFormatCheckStatusContract(unittest.TestCase):
    """Directly exercise format-check.js's status classification (the core)."""

    def _driver(self) -> tuple[Path, Path]:
        tmp = tempfile.mkdtemp()
        root = Path(tmp)
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        fc_url = (_HOOKS / "format-check.js").as_uri()
        driver = root / "driver.mjs"
        driver.write_text(
            f"import {{ runFormatCheck }} from {json.dumps(fc_url)};\n"
            "const input = JSON.parse(process.argv[2]);\n"
            "const res = runFormatCheck(input, process.argv[3]);\n"
            "process.stdout.write(res.status);\n",
            encoding="utf-8",
        )
        return root, driver

    def _status(self, driver: Path, payload: dict, cwd: Path) -> str:
        cp = subprocess.run(
            ["node", str(driver), json.dumps(payload), str(cwd)],
            text=True,
            capture_output=True,
        )
        return cp.stdout.strip()

    def test_no_formatter_returns_clean(self):
        root, driver = self._driver()
        (root / "f.py").write_text("x = 1\n", encoding="utf-8")
        status = self._status(driver, {"tool_input": {"file_path": str(root / "f.py")}}, root)
        self.assertEqual(status, "clean")

    @unittest.skipUnless(_HAVE_RUFF, "ruff required to trigger a real violation")
    def test_ruff_violation_returns_violations(self):
        root, driver = self._driver()
        (root / "ruff.toml").write_text("line-length = 100\n", encoding="utf-8")
        (root / "bad.py").write_text("import os\n", encoding="utf-8")
        status = self._status(driver, {"tool_input": {"file_path": str(root / "bad.py")}}, root)
        self.assertEqual(status, "violations")

    def test_file_outside_project_root_is_skipped(self):
        """A file outside cwd is skipped ('clean') — the hook only owns files
        inside the project root (e.g. ~/.claude memory / scratchpad writes must
        not be blocked).

        Runs unconditionally: ruff is irrelevant here because the skip branch
        returns 'clean' *before* any formatter is detected or spawned. The
        assertion is still meaningful without ruff — a project config IS present
        (ruff.toml), so if the skip branch were removed the file would be
        detected and either report 'violations' (ruff present) or 'infra-error'
        (ruff absent, ENOENT). Both differ from 'clean', so 'clean' positively
        proves the skip fired regardless of whether ruff is installed.
        """
        root, driver = self._driver()
        (root / "ruff.toml").write_text("line-length = 100\n", encoding="utf-8")
        # A file living OUTSIDE the project root (that would also fail ruff).
        outside = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, outside, ignore_errors=True)
        bad = Path(outside) / "bad.py"
        bad.write_text("import os\n", encoding="utf-8")
        status = self._status(driver, {"tool_input": {"file_path": str(bad)}}, root)
        self.assertEqual(status, "clean")

    @unittest.skipUnless(_HAVE_RUFF, "ruff required to prove the skip beats a real violation")
    def test_skip_beats_a_real_violation(self):
        """Companion to the skip test: the SAME violating content reports
        'violations' when it lives inside the root but 'clean' when outside —
        proving the skip suppresses a genuine, formatter-confirmed violation
        (not merely a file the formatter would have ignored anyway)."""
        root, driver = self._driver()
        (root / "ruff.toml").write_text("line-length = 100\n", encoding="utf-8")
        # F401 unused import — deterministic ruff violation.
        violating = "import os\n"
        (root / "inside.py").write_text(violating, encoding="utf-8")
        inside_status = self._status(
            driver, {"tool_input": {"file_path": str(root / "inside.py")}}, root
        )
        self.assertEqual(inside_status, "violations", "control: file is a real violation inside")

        outside = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, outside, ignore_errors=True)
        (Path(outside) / "outside.py").write_text(violating, encoding="utf-8")
        outside_status = self._status(
            driver, {"tool_input": {"file_path": str(Path(outside) / "outside.py")}}, root
        )
        self.assertEqual(outside_status, "clean", "same violation outside root is skipped")

    @unittest.skipUnless(_HAVE_RUFF, "ruff required to prove the in-repo file is actually linted")
    def test_symlinked_root_still_lints_in_repo_file(self):
        """Highest-value edge case: when the edited file arrives via a symlinked
        path but the project root (Node's process.cwd()) is the real path, an
        in-repo VIOLATION must still be reported — not silently skipped.

        canonicalize() (realpathSync) collapses the symlinked file path and the
        real cwd onto the same tree; without it, ``relative()`` would compute an
        escaping ``../linkroot/...`` and the skip branch would wall off the whole
        repo, failing open on every edit. Asserting 'violations' (not 'clean')
        proves the file is genuinely reached and linted through the symlink."""
        root, driver = self._driver()
        realroot = root / "realroot"
        realroot.mkdir()
        (realroot / "ruff.toml").write_text("line-length = 100\n", encoding="utf-8")
        (realroot / "bad.py").write_text("import os\n", encoding="utf-8")
        linkroot = root / "linkroot"
        os.symlink(realroot, linkroot, target_is_directory=True)
        # cwd = the REAL path (as process.cwd() reports it); file_path arrives
        # via the SYMLINK. Raw relative() would escape; canonicalize() unifies.
        status = self._status(
            driver, {"tool_input": {"file_path": str(linkroot / "bad.py")}}, realroot
        )
        self.assertEqual(status, "violations")

    @unittest.skipUnless(_HAVE_RUFF, "ruff required to prove the normalized-back file is linted")
    def test_dotdot_normalizing_back_inside_still_lints(self):
        """A '..' path that resolves back INSIDE the root is not an escape: the
        in-repo violation must still be reported ('violations'), confirming the
        containment check normalizes rather than string-matching on '..'."""
        root, driver = self._driver()
        (root / "ruff.toml").write_text("line-length = 100\n", encoding="utf-8")
        (root / "sub").mkdir()
        (root / "real.py").write_text("import os\n", encoding="utf-8")
        file_path = f"{root}{os.sep}sub{os.sep}..{os.sep}real.py"
        status = self._status(driver, {"tool_input": {"file_path": file_path}}, root)
        self.assertEqual(status, "violations")

    def test_empty_file_path_falls_through_not_skipped(self):
        """An empty/missing file_path must NOT take the skip branch: it falls
        through to normal handling (here: no formatter → 'clean') without
        crashing. runFormatCheck guards the skip with a truthy-string check, so
        '' bypasses the skip entirely rather than being treated as outside."""
        root, driver = self._driver()  # no formatter config present
        for payload in (
            {"tool_input": {"file_path": ""}},
            {"tool_input": {}},
            {},
        ):
            status = self._status(driver, payload, root)
            self.assertEqual(status, "clean", payload)


@unittest.skipUnless(_HAVE_NODE, "node required to exercise the JS hooks")
class TestIsInsideProjectContainment(unittest.TestCase):
    """Exercise isInsideProject() directly — the containment predicate that
    decides skip-vs-lint. These run everywhere (no formatter needed): they
    assert the boolean the skip branch keys off, so they cover the edge cases
    unconditionally without depending on ruff to make an outcome observable."""

    def _driver(self) -> tuple[Path, Path]:
        tmp = tempfile.mkdtemp()
        root = Path(tmp)
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        fc_url = (_HOOKS / "format-check.js").as_uri()
        driver = root / "inside.mjs"
        driver.write_text(
            f"import {{ isInsideProject }} from {json.dumps(fc_url)};\n"
            "const res = isInsideProject(process.argv[2], process.argv[3]);\n"
            "process.stdout.write(res ? 'inside' : 'outside');\n",
            encoding="utf-8",
        )
        return root, driver

    def _inside(self, driver: Path, file_path: str, cwd, run_cwd=None) -> str:
        cp = subprocess.run(
            ["node", str(driver), file_path, str(cwd)],
            text=True,
            capture_output=True,
            cwd=str(run_cwd) if run_cwd is not None else None,
        )
        return cp.stdout.strip()

    def test_relative_in_repo_path_is_inside(self):
        """A relative file_path resolves against the process cwd. When the node
        process runs *in* the project root, 'bad.py' is inside — not skipped.
        (canonicalize()'s realpathSync/resolve of a relative path keys off
        process.cwd(), so the run_cwd must equal the root for this to hold.)"""
        root, driver = self._driver()
        (root / "bad.py").write_text("x = 1\n", encoding="utf-8")
        self.assertEqual(self._inside(driver, "bad.py", root, run_cwd=root), "inside")

    def test_dotdot_escaping_root_is_outside(self):
        """<root>/../evil.py escapes the root → outside → skipped."""
        root, driver = self._driver()
        file_path = f"{root}{os.sep}..{os.sep}evil.py"
        self.assertEqual(self._inside(driver, file_path, root), "outside")

    def test_dotdot_normalizing_back_inside_is_inside(self):
        """<root>/sub/../real.py normalizes back inside the root → inside."""
        root, driver = self._driver()
        (root / "sub").mkdir()
        (root / "real.py").write_text("x = 1\n", encoding="utf-8")
        file_path = f"{root}{os.sep}sub{os.sep}..{os.sep}real.py"
        self.assertEqual(self._inside(driver, file_path, root), "inside")

    def test_root_itself_is_outside(self):
        """file_path == root gives rel === '' → treated as outside (locks in
        current behavior) and must not crash."""
        root, driver = self._driver()
        self.assertEqual(self._inside(driver, str(root), root), "outside")

    def test_sibling_dir_sharing_name_prefix_is_outside(self):
        """cwd=/x/repo, file=/x/repo-sibling/y.py — a prefix-sharing sibling is
        NOT inside (relative() is path-segment aware, not a string prefix)."""
        parent = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, parent, ignore_errors=True)
        repo = Path(parent) / "repo"
        repo.mkdir()
        sibling = Path(parent) / "repo-sibling"
        sibling.mkdir()
        (sibling / "y.py").write_text("x = 1\n", encoding="utf-8")
        # Use a local driver rooted at repo so the import URL is absolute anyway.
        _, driver = self._driver()
        self.assertEqual(self._inside(driver, str(sibling / "y.py"), repo), "outside")

    def test_empty_file_path_is_inside(self):
        """Empty/missing file_path hits the `!filePath` short-circuit → inside
        (so runFormatCheck never treats a pathless event as a skip)."""
        root, driver = self._driver()
        self.assertEqual(self._inside(driver, "", root), "inside")

    def test_nonexistent_outside_path_is_outside(self):
        """A non-existent absolute path outside the root exercises the catch{}
        fallback (realpathSync throws → resolve()) and is still outside."""
        root, driver = self._driver()
        file_path = f"{os.sep}no-such-dir-xyzzy{os.sep}evil.py"
        self.assertEqual(self._inside(driver, file_path, root), "outside")

    def test_symlinked_root_in_repo_file_is_inside(self):
        """Unconditional counterpart to the ruff-gated symlink test: with cwd as
        the real path and the file arriving via a symlink to that same dir,
        canonicalize() places the file inside. Deleting canonicalize() would
        make relative() escape and return 'outside' here."""
        root, driver = self._driver()
        realroot = root / "realroot"
        realroot.mkdir()
        (realroot / "bad.py").write_text("x = 1\n", encoding="utf-8")
        linkroot = root / "linkroot"
        os.symlink(realroot, linkroot, target_is_directory=True)
        self.assertEqual(
            self._inside(driver, str(linkroot / "bad.py"), realroot), "inside"
        )


@unittest.skipUnless(_HAVE_NODE, "node required to exercise the JS hooks")
class TestClassifyNoParser(unittest.TestCase):
    """#317: Prettier's 'No parser could be inferred' on a .py file is a
    usage/infra error (Prettier can't format Python), NOT a format violation —
    it must classify as infra-error so the blocking hook fails open."""

    def _classify(self, err: dict) -> str:
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        root = Path(tmp)
        fc_url = (_HOOKS / "format-check.js").as_uri()
        driver = root / "driver.mjs"
        driver.write_text(
            f"import {{ classifyError }} from {json.dumps(fc_url)};\n"
            "const err = JSON.parse(process.argv[2]);\n"
            "process.stdout.write(classifyError(err));\n",
            encoding="utf-8",
        )
        cp = subprocess.run(
            ["node", str(driver), json.dumps(err)],
            text=True,
            capture_output=True,
        )
        return cp.stdout.strip()

    def test_no_parser_inferred_is_infra_error(self):
        """The exact Prettier message on a .py edit must fail open, not block."""
        err = {
            "status": 2,
            "stdout": "",
            "stderr": '[error] No parser could be inferred for file "/x/mod.py".',
        }
        self.assertEqual(self._classify(err), "infra-error")

    def test_real_prettier_violation_still_blocks(self):
        """Guard: a genuine style violation (parseable file) stays 'violations'."""
        err = {
            "status": 1,
            "stdout": "app.js\n",
            "stderr": "[warn] Code style issues found in the above file. Run Prettier to fix.",
        }
        self.assertEqual(self._classify(err), "violations")


@unittest.skipUnless(_HAVE_NODE, "node required to exercise the JS hooks")
class TestPreferFirstPartyMcp(unittest.TestCase):
    """The routing nudge fires for third-party MCP, stays silent for first-party."""

    def _out(self, tool_name: str) -> subprocess.CompletedProcess:
        with tempfile.TemporaryDirectory() as tmp:
            return _run_hook("prefer-first-party-mcp.js", {"tool_name": tool_name}, Path(tmp))

    def test_third_party_mcp_gets_reminder(self):
        cp = self._out("mcp__plugin_github_github__get_me")
        self.assertEqual(cp.returncode, 0)
        self.assertIn("Trusted MCP hierarchy", cp.stdout)

    def test_canary_mcp_prefix_is_trusted_silent(self):
        """#309: mcp__canary-mcp__* is first-party — no reminder."""
        cp = self._out("mcp__canary-mcp__analyze_file")
        self.assertEqual(cp.returncode, 0)
        self.assertEqual(cp.stdout.strip(), "")

    def test_harness_prefix_is_trusted_silent(self):
        cp = self._out("mcp__harness__run_skill")
        self.assertEqual(cp.stdout.strip(), "")

    def test_canary_bundle_prefix_is_trusted_silent(self):
        cp = self._out("mcp__plugin_mcp-bundle_context7__query_docs")
        self.assertEqual(cp.stdout.strip(), "")

    def test_non_mcp_tool_is_silent(self):
        cp = self._out("Read")
        self.assertEqual(cp.stdout.strip(), "")

    def test_another_third_party_bundle_gets_reminder(self):
        cp = self._out("mcp__plugin_github_github__search_code")
        self.assertIn("Trusted MCP hierarchy", cp.stdout)


if __name__ == "__main__":
    unittest.main()
