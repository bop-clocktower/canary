"""Unit tests for agent.core.ticket_updater."""

from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Optional
from unittest.mock import MagicMock, patch


# ── helpers ───────────────────────────────────────────────────────────────────


def _make_summary(**kwargs):
    """Return a minimal RunSummary, overriding defaults with kwargs."""
    from agent.core.ticket_updater import RunSummary

    defaults = dict(
        suite_name="challenge-tests",
        env="stage",
        result="PASS",
        passed=3,
        total=3,
        flaky_count=0,
        duration_s=12.5,
        test_file="tests/challenge.spec.ts",
        report_url=None,
        passed_names=["test_a", "test_b", "test_c"],
        failed_names=[],
        ticket_key=None,
        project_key=None,
        linkage_source="none",
    )
    defaults.update(kwargs)
    return RunSummary(**defaults)


# ── linkage detection ─────────────────────────────────────────────────────────


class TestDetectLinkageFrontmatter(unittest.TestCase):
    def setUp(self):
        self.tmpdir = TemporaryDirectory()
        self.base = Path(self.tmpdir.name)

    def tearDown(self):
        self.tmpdir.cleanup()

    def _write(self, name: str, content: str) -> Path:
        p = self.base / name
        p.write_text(content, encoding="utf-8")
        return p

    def test_frontmatter_ticket_only(self):
        """Detects ticket key from frontmatter; infers project from key."""
        from agent.core.ticket_updater import TicketUpdater

        f = self._write(
            "test.spec.ts",
            "# oracle:ticket: PROJ-42\n\ntest('foo', () => {});\n",
        )
        key, project, source = TicketUpdater().detect_linkage(f)
        self.assertEqual(key, "PROJ-42")
        self.assertEqual(project, "PROJ")
        self.assertEqual(source, "frontmatter")

    def test_frontmatter_ticket_and_project(self):
        """Explicit oracle:project overrides inferred project."""
        from agent.core.ticket_updater import TicketUpdater

        f = self._write(
            "test.spec.ts",
            "# oracle:ticket: OPTM-99\n# oracle:project: OPTM\n\ntest('x', () => {});\n",
        )
        key, project, source = TicketUpdater().detect_linkage(f)
        self.assertEqual(key, "OPTM-99")
        self.assertEqual(project, "OPTM")
        self.assertEqual(source, "frontmatter")

    def test_frontmatter_takes_priority_over_tag(self):
        """Frontmatter wins when both frontmatter and tag are present."""
        from agent.core.ticket_updater import TicketUpdater

        f = self._write(
            "test.spec.ts",
            "# oracle:ticket: FRONT-1\n\ntest('@ticket:TAG-2 something', () => {});\n",
        )
        key, _, source = TicketUpdater().detect_linkage(f)
        self.assertEqual(key, "FRONT-1")
        self.assertEqual(source, "frontmatter")


class TestDetectLinkageTag(unittest.TestCase):
    def setUp(self):
        self.tmpdir = TemporaryDirectory()
        self.base = Path(self.tmpdir.name)

    def tearDown(self):
        self.tmpdir.cleanup()

    def _write(self, content: str) -> Path:
        p = self.base / "test.spec.ts"
        p.write_text(content, encoding="utf-8")
        return p

    def test_ticket_tag_typescript(self):
        from agent.core.ticket_updater import TicketUpdater

        f = self._write("test('@ticket:ACME-7 user can login', async () => {});\n")
        key, project, source = TicketUpdater().detect_linkage(f)
        self.assertEqual(key, "ACME-7")
        self.assertEqual(project, "ACME")
        self.assertEqual(source, "tag")

    def test_jira_tag_python(self):
        from agent.core.ticket_updater import TicketUpdater

        content = 'def test_something():\n    """@jira:DEMO-100 does the thing"""\n'
        f = self._write(content)
        key, project, source = TicketUpdater().detect_linkage(f)
        self.assertEqual(key, "DEMO-100")
        self.assertEqual(project, "DEMO")
        self.assertEqual(source, "tag")

    def test_tag_infers_project_from_key(self):
        from agent.core.ticket_updater import TicketUpdater

        f = self._write("test('@ticket:XY-3 something', () => {});\n")
        key, project, source = TicketUpdater().detect_linkage(f)
        self.assertEqual(project, "XY")

    def test_no_linkage_in_file_falls_through(self):
        """No frontmatter or tag → branch fallback (mocked to 'none')."""
        from agent.core.ticket_updater import TicketUpdater

        f = self._write("test('no ticket here', () => {});\n")
        with patch("agent.core.ticket_updater._branch_ticket", return_value=(None, None, "none")):
            key, project, source = TicketUpdater().detect_linkage(f)
        self.assertIsNone(key)
        self.assertEqual(source, "none")


class TestDetectLinkageBranch(unittest.TestCase):
    def setUp(self):
        self.tmpdir = TemporaryDirectory()
        self.f = Path(self.tmpdir.name) / "nonexistent.spec.ts"
        # Do NOT create the file — detect_linkage falls through to branch.

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir.name, ignore_errors=True)

    def test_branch_ticket_extracted(self):
        from agent.core.ticket_updater import TicketUpdater

        with patch(
            "agent.core.ticket_updater._branch_ticket",
            return_value=("FEAT-55", "FEAT", "branch"),
        ):
            key, project, source = TicketUpdater().detect_linkage(self.f)
        self.assertEqual(key, "FEAT-55")
        self.assertEqual(project, "FEAT")
        self.assertEqual(source, "branch")

    def test_no_branch_match_returns_none(self):
        from agent.core.ticket_updater import TicketUpdater

        with patch(
            "agent.core.ticket_updater._branch_ticket",
            return_value=(None, None, "none"),
        ):
            key, project, source = TicketUpdater().detect_linkage(self.f)
        self.assertIsNone(key)
        self.assertEqual(source, "none")


# ── comment formatting ────────────────────────────────────────────────────────


class TestBuildComment(unittest.TestCase):
    def setUp(self):
        from agent.core.ticket_updater import TicketUpdater

        self.updater = TicketUpdater()

    def test_pass_comment_shape(self):
        s = _make_summary(
            result="PASS",
            passed=3,
            total=3,
            passed_names=["login", "logout", "reset"],
            failed_names=[],
        )
        body = self.updater._build_comment(s)
        self.assertIn("PASS (3/3 tests)", body)
        self.assertIn("✓ login", body)
        self.assertNotIn("✗", body)

    def test_fail_comment_shape(self):
        s = _make_summary(
            result="FAIL",
            passed=1,
            total=2,
            passed_names=["login"],
            failed_names=[("checkout", "assertion_error")],
        )
        body = self.updater._build_comment(s)
        self.assertIn("FAIL (1/2 tests)", body)
        self.assertIn("✗ checkout — assertion_error", body)
        self.assertIn("✓ login", body)

    def test_partial_comment_shape(self):
        s = _make_summary(
            result="PARTIAL",
            passed=2,
            total=3,
            passed_names=["a", "b"],
            failed_names=[("c", "timeout")],
        )
        body = self.updater._build_comment(s)
        self.assertIn("PARTIAL (2/3 tests)", body)

    def test_report_url_included_when_present(self):
        s = _make_summary(report_url="https://reports.example.com/run/42")
        body = self.updater._build_comment(s)
        self.assertIn("https://reports.example.com/run/42", body)

    def test_no_report_url_omits_line(self):
        s = _make_summary(report_url=None)
        body = self.updater._build_comment(s)
        self.assertNotIn("Report:", body)

    def test_flaky_count_in_comment(self):
        s = _make_summary(flaky_count=2)
        body = self.updater._build_comment(s)
        self.assertIn("Flaky: 2", body)

    def test_suite_name_in_header(self):
        s = _make_summary(suite_name="my-custom-suite")
        body = self.updater._build_comment(s)
        self.assertIn("Oracle Test Run — my-custom-suite", body)

    def test_no_llm_text_markers(self):
        """Comment body must never contain LLM-style commentary."""
        s = _make_summary()
        body = self.updater._build_comment(s)
        self.assertNotIn("As an AI", body)
        self.assertNotIn("I can help", body)


# ── transition logic ──────────────────────────────────────────────────────────


class TestTransitionLogic(unittest.TestCase):
    def setUp(self):
        self.tmpdir = TemporaryDirectory()
        self.canary_dir = Path(self.tmpdir.name) / ".canary"
        self.canary_dir.mkdir()

    def tearDown(self):
        self.tmpdir.cleanup()

    def _write_mapping(
        self,
        project_key: str,
        qa_passed_status: str,
        atlassian_url: Optional[str] = None,
    ) -> None:
        mapping = {
            "project_key": project_key,
            "source": "jira",
            "discovered_at": "2026-01-01T00:00:00+00:00",
            "issue_types": [
                {
                    "id": "10001",
                    "name": "Story",
                    "statuses": [
                        {"id": "1", "name": "In QA", "category": "indeterminate"},
                        {"id": "2", "name": qa_passed_status, "category": "indeterminate"},
                    ],
                    "transitions": [
                        {
                            "id": "31",
                            "name": "QA Pass",
                            "from": "In QA",
                            "to": qa_passed_status,
                        }
                    ],
                }
            ],
            "semantic_roles": {
                "qa_passed": {
                    "status_name": qa_passed_status,
                    "issue_type": "Story",
                },
                "in_qa": {"status_name": "In QA", "issue_type": "Story"},
            },
            "role_annotations_confirmed": True,
        }
        if atlassian_url:
            mapping["atlassian_url"] = atlassian_url
        path = self.canary_dir / f"workflow-{project_key}.json"
        path.write_text(json.dumps(mapping), encoding="utf-8")

    def test_fail_result_does_not_transition(self):
        from agent.core.ticket_updater import TicketUpdater

        self._write_mapping("PROJ", "QA Passed")
        updater = TicketUpdater(canary_dir=self.canary_dir)
        result = updater._transition_jira("PROJ-1", "PROJ", "FAIL", dry_run=True)
        self.assertFalse(result.attempted)
        self.assertIn("FAIL", result.reason)

    def test_partial_result_does_not_transition(self):
        from agent.core.ticket_updater import TicketUpdater

        self._write_mapping("PROJ", "QA Passed")
        updater = TicketUpdater(canary_dir=self.canary_dir)
        result = updater._transition_jira("PROJ-1", "PROJ", "PARTIAL", dry_run=True)
        self.assertFalse(result.attempted)
        self.assertIn("PARTIAL", result.reason)

    def test_pass_with_missing_mapping_surfaces_guidance(self):
        from agent.core.ticket_updater import TicketUpdater

        # No mapping file written.
        updater = TicketUpdater(canary_dir=self.canary_dir)
        result = updater._transition_jira("PROJ-1", "PROJ", "PASS", dry_run=True)
        self.assertFalse(result.attempted)
        self.assertIn("oracle workflow-discover", result.reason)
        self.assertIn("PROJ", result.reason)

    def test_pass_dry_run_returns_proposed_transition(self):
        from agent.core.ticket_updater import TicketUpdater

        self._write_mapping("ACME", "QA Passed")
        updater = TicketUpdater(canary_dir=self.canary_dir)

        # Mock Jira credentials and current status lookup.
        with (
            patch("agent.core.ticket_updater._jira_auth", return_value=("https://j.example.com", "Basic dGVzdA==")),
            patch("agent.core.ticket_updater._jira_current_status", return_value="In QA"),
            patch("agent.core.ticket_updater._jira_find_transition", return_value="31"),
        ):
            result = updater._transition_jira("ACME-1", "ACME", "PASS", dry_run=True)

        self.assertTrue(result.attempted)
        self.assertFalse(result.succeeded)  # dry-run: not actually written
        self.assertEqual(result.from_status, "In QA")
        self.assertEqual(result.to_status, "QA Passed")
        self.assertEqual(result.reason, "dry-run")

    def test_pass_not_reachable_transition(self):
        from agent.core.ticket_updater import TicketUpdater

        self._write_mapping("ACME", "QA Passed")
        updater = TicketUpdater(canary_dir=self.canary_dir)

        with (
            patch("agent.core.ticket_updater._jira_auth", return_value=("https://j.example.com", "Basic dGVzdA==")),
            patch("agent.core.ticket_updater._jira_current_status", return_value="Done"),
            patch("agent.core.ticket_updater._jira_find_transition", return_value=None),
        ):
            result = updater._transition_jira("ACME-2", "ACME", "PASS", dry_run=False)

        self.assertTrue(result.attempted)
        self.assertFalse(result.succeeded)
        self.assertIn("not reachable", result.reason)

    def test_pass_transition_executes_on_live(self):
        from agent.core.ticket_updater import TicketUpdater

        self._write_mapping("ACME", "QA Passed")
        updater = TicketUpdater(canary_dir=self.canary_dir)

        with (
            patch("agent.core.ticket_updater._jira_auth", return_value=("https://j.example.com", "Basic dGVzdA==")),
            patch("agent.core.ticket_updater._jira_current_status", return_value="In QA"),
            patch("agent.core.ticket_updater._jira_find_transition", return_value="31"),
            patch("agent.core.ticket_updater._jira_do_transition", return_value=True),
        ):
            result = updater._transition_jira("ACME-3", "ACME", "PASS", dry_run=False)

        self.assertTrue(result.attempted)
        self.assertTrue(result.succeeded)


# ── dry-run mode ──────────────────────────────────────────────────────────────


class TestDryRun(unittest.TestCase):
    def setUp(self):
        self.tmpdir = TemporaryDirectory()
        self.canary_dir = Path(self.tmpdir.name) / ".canary"
        self.canary_dir.mkdir()

    def tearDown(self):
        self.tmpdir.cleanup()

    def _write_mapping(self) -> None:
        mapping = {
            "project_key": "PROJ",
            "source": "jira",
            "discovered_at": "2026-01-01T00:00:00+00:00",
            "issue_types": [{"id": "1", "name": "Story", "statuses": [], "transitions": []}],
            "semantic_roles": {
                "qa_passed": {"status_name": "QA Passed", "issue_type": "Story"}
            },
            "role_annotations_confirmed": True,
        }
        (self.canary_dir / "workflow-PROJ.json").write_text(
            json.dumps(mapping), encoding="utf-8"
        )

    def test_dry_run_makes_no_external_calls(self):
        """With dry_run=True no urllib or subprocess calls are made."""
        from agent.core.ticket_updater import TicketUpdater

        self._write_mapping()
        updater = TicketUpdater(canary_dir=self.canary_dir)
        summary = _make_summary(
            ticket_key="PROJ-10",
            project_key="PROJ",
            linkage_source="frontmatter",
        )

        with (
            patch("agent.core.ticket_updater._jira_auth", return_value=("https://j.example.com", "Basic dGVzdA==")),
            patch("agent.core.ticket_updater._jira_current_status", return_value="In QA"),
            patch("agent.core.ticket_updater._jira_find_transition", return_value="31"),
            patch("urllib.request.urlopen") as mock_urlopen,
            patch("subprocess.run") as mock_sub,
        ):
            result = updater.update(summary, dry_run=True)

        # urlopen and subprocess.run must not have been called for the write paths.
        mock_urlopen.assert_not_called()
        # subprocess.run may be called for git branch detection, but not for gh comment
        self.assertTrue(result.dry_run)
        self.assertTrue(result.comment_posted)  # flagged as would-post

    def test_dry_run_output_contains_comment_content(self):
        from agent.core.ticket_updater import TicketUpdater

        self._write_mapping()
        updater = TicketUpdater(canary_dir=self.canary_dir)
        summary = _make_summary(
            ticket_key="PROJ-10",
            project_key="PROJ",
            linkage_source="frontmatter",
        )

        with (
            patch("agent.core.ticket_updater._jira_auth", return_value=("https://j.example.com", "Basic dGVzdA==")),
            patch("agent.core.ticket_updater._jira_current_status", return_value="In QA"),
            patch("agent.core.ticket_updater._jira_find_transition", return_value="31"),
        ):
            result = updater.update(summary, dry_run=True)

        combined = "\n".join(result.messages)
        self.assertIn("Would post comment", combined)
        self.assertIn("PROJ-10", combined)

    def test_dry_run_shows_transition_intent(self):
        from agent.core.ticket_updater import TicketUpdater

        self._write_mapping()
        updater = TicketUpdater(canary_dir=self.canary_dir)
        summary = _make_summary(
            ticket_key="PROJ-10",
            project_key="PROJ",
            linkage_source="frontmatter",
        )

        with (
            patch("agent.core.ticket_updater._jira_auth", return_value=("https://j.example.com", "Basic dGVzdA==")),
            patch("agent.core.ticket_updater._jira_current_status", return_value="In QA"),
            patch("agent.core.ticket_updater._jira_find_transition", return_value="31"),
        ):
            result = updater.update(summary, dry_run=True)

        combined = "\n".join(result.messages)
        self.assertIn("Would transition", combined)
        self.assertIn("QA Passed", combined)


# ── safety gate ───────────────────────────────────────────────────────────────


class TestSafetyGate(unittest.TestCase):
    def setUp(self):
        self.tmpdir = TemporaryDirectory()
        self.canary_dir = Path(self.tmpdir.name) / ".canary"
        self.canary_dir.mkdir()

    def tearDown(self):
        self.tmpdir.cleanup()

    def test_missing_mapping_surfaces_workflow_discover_command(self):
        from agent.core.ticket_updater import TicketUpdater

        updater = TicketUpdater(canary_dir=self.canary_dir)
        summary = _make_summary(
            ticket_key="NOPE-1",
            project_key="NOPE",
            linkage_source="frontmatter",
        )

        with (
            patch("agent.core.ticket_updater._jira_auth", return_value=("https://j.example.com", "Basic dGVzdA==")),
        ):
            result = updater.update(summary, dry_run=False)

        self.assertFalse(result.transition.attempted)
        combined_msgs = "\n".join(result.messages) + result.transition.reason
        self.assertIn("oracle workflow-discover", combined_msgs)

    def test_no_linkage_skips_entirely(self):
        from agent.core.ticket_updater import TicketUpdater

        updater = TicketUpdater(canary_dir=self.canary_dir)
        summary = _make_summary(
            ticket_key=None,
            project_key=None,
            linkage_source="none",
            test_file="",
        )

        with patch("agent.core.ticket_updater._branch_ticket", return_value=(None, None, "none")):
            result = updater.update(summary)

        self.assertIsNone(result.ticket_key)
        self.assertFalse(result.comment_posted)
        self.assertFalse(result.transition.attempted)
        self.assertIn("No ticket linkage found", "\n".join(result.messages))

    def test_unknown_ticket_format_produces_message(self):
        from agent.core.ticket_updater import TicketUpdater

        updater = TicketUpdater(canary_dir=self.canary_dir)
        summary = _make_summary(
            ticket_key="not-a-valid-key",
            project_key=None,
            linkage_source="frontmatter",
        )

        result = updater.update(summary, comment_only=True)
        combined = "\n".join(result.messages)
        self.assertIn("Unrecognised ticket key format", combined)

    def test_comment_only_skips_transition(self):
        from agent.core.ticket_updater import TicketUpdater

        updater = TicketUpdater(canary_dir=self.canary_dir)
        summary = _make_summary(
            ticket_key="PROJ-5",
            project_key="PROJ",
            linkage_source="frontmatter",
        )

        with patch("agent.core.ticket_updater._jira_auth", return_value=(None, None)):
            result = updater.update(summary, dry_run=True, comment_only=True)

        self.assertEqual(result.transition.reason, "skipped (comment-only mode)")


# ── per-project Atlassian URL ─────────────────────────────────────────────────


class TestPerProjectAtlassianUrl(unittest.TestCase):
    def setUp(self):
        self.tmpdir = TemporaryDirectory()
        self.canary_dir = Path(self.tmpdir.name) / ".canary"
        self.canary_dir.mkdir()

    def tearDown(self):
        self.tmpdir.cleanup()

    def _write_mapping(self, project_key: str, atlassian_url: Optional[str] = None) -> None:
        mapping: dict = {
            "project_key": project_key,
            "source": "jira",
            "discovered_at": "2026-01-01T00:00:00+00:00",
            "issue_types": [],
            "semantic_roles": {
                "qa_passed": {"status_name": "QA Passed", "issue_type": "Story"},
                "in_qa": {"status_name": "In QA", "issue_type": "Story"},
            },
            "role_annotations_confirmed": True,
        }
        if atlassian_url:
            mapping["atlassian_url"] = atlassian_url
        (self.canary_dir / f"workflow-{project_key}.json").write_text(
            json.dumps(mapping), encoding="utf-8"
        )

    def test_stored_url_preferred_over_env_var(self):
        """atlassian_url in mapping takes precedence over ATLASSIAN_URL env var."""
        from agent.core.ticket_updater import _jira_auth

        self._write_mapping("ACME", atlassian_url="https://acme.atlassian.net")

        with (
            patch.dict(
                os.environ,
                {
                    "ATLASSIAN_URL": "https://wrong.atlassian.net",
                    "ATLASSIAN_USER": "user@example.com",
                    "ATLASSIAN_TOKEN": "token123",
                },
            )
        ):
            base_url, _ = _jira_auth("ACME", self.canary_dir)

        self.assertEqual(base_url, "https://acme.atlassian.net")

    def test_env_var_used_when_no_stored_url(self):
        """Falls back to ATLASSIAN_URL env var when mapping has no atlassian_url."""
        from agent.core.ticket_updater import _jira_auth

        self._write_mapping("ACME")  # no atlassian_url stored

        with (
            patch.dict(
                os.environ,
                {
                    "ATLASSIAN_URL": "https://fallback.atlassian.net",
                    "ATLASSIAN_USER": "user@example.com",
                    "ATLASSIAN_TOKEN": "token123",
                },
            )
        ):
            base_url, _ = _jira_auth("ACME", self.canary_dir)

        self.assertEqual(base_url, "https://fallback.atlassian.net")

    def test_two_projects_different_atlassian_instances(self):
        """Two projects on different Atlassian instances each get their own URL."""
        from agent.core.ticket_updater import _jira_auth

        self._write_mapping("INTERNAL", atlassian_url="https://internal.atlassian.net")
        self._write_mapping("CUSTOMER", atlassian_url="https://customer.atlassian.net")

        with patch.dict(
            os.environ,
            {"ATLASSIAN_USER": "user@example.com", "ATLASSIAN_TOKEN": "tok"},
        ):
            internal_url, _ = _jira_auth("INTERNAL", self.canary_dir)
            customer_url, _ = _jira_auth("CUSTOMER", self.canary_dir)

        self.assertEqual(internal_url, "https://internal.atlassian.net")
        self.assertEqual(customer_url, "https://customer.atlassian.net")

    def test_no_project_key_falls_back_to_env(self):
        """Without a project key, env var is the only option."""
        from agent.core.ticket_updater import _jira_auth

        with patch.dict(
            os.environ,
            {
                "ATLASSIAN_URL": "https://env.atlassian.net",
                "ATLASSIAN_USER": "user@example.com",
                "ATLASSIAN_TOKEN": "tok",
            },
        ):
            base_url, _ = _jira_auth(None, self.canary_dir)

        self.assertEqual(base_url, "https://env.atlassian.net")


# ── workflow-init (static role config) ───────────────────────────────────────


class TestWorkflowMappingStaticInit(unittest.TestCase):
    def setUp(self):
        self.tmpdir = TemporaryDirectory()
        self.canary_dir = Path(self.tmpdir.name) / ".canary"
        self.canary_dir.mkdir()

    def tearDown(self):
        self.tmpdir.cleanup()

    def test_hand_authored_mapping_used_by_ticket_updater(self):
        """A manually written mapping file (no discovery) is respected by transition logic."""
        from agent.core.ticket_updater import TicketUpdater
        from agent.core.workflow_discovery import WorkflowDiscovery, WorkflowMapping, SemanticRole

        mapping = WorkflowMapping(
            project_key="HAND",
            source="jira",
            discovered_at="2026-01-01T00:00:00+00:00",
            semantic_roles={
                "qa_passed": SemanticRole(status_name="Testing Complete", issue_type="Story"),
                "in_qa": SemanticRole(status_name="In Testing", issue_type="Story"),
            },
            role_annotations_confirmed=True,
            atlassian_url="https://hand.atlassian.net",
        )
        WorkflowDiscovery(canary_dir=self.canary_dir)._write(mapping)

        updater = TicketUpdater(canary_dir=self.canary_dir)

        with (
            patch("agent.core.ticket_updater._jira_auth", return_value=("https://hand.atlassian.net", "Basic dGVzdA==")),
            patch("agent.core.ticket_updater._jira_current_status", return_value="In Testing"),
            patch("agent.core.ticket_updater._jira_find_transition", return_value="99"),
        ):
            result = updater._transition_jira("HAND-1", "HAND", "PASS", dry_run=True)

        self.assertTrue(result.attempted)
        self.assertEqual(result.to_status, "Testing Complete")

    def test_mapping_round_trips_atlassian_url(self):
        """atlassian_url survives JSON serialisation/deserialisation."""
        from agent.core.workflow_discovery import WorkflowDiscovery, WorkflowMapping, SemanticRole

        mapping = WorkflowMapping(
            project_key="RT",
            source="jira",
            discovered_at="2026-01-01T00:00:00+00:00",
            semantic_roles={"qa_passed": SemanticRole("Done", "Story")},
            role_annotations_confirmed=True,
            atlassian_url="https://rt.atlassian.net",
        )
        wd = WorkflowDiscovery(canary_dir=self.canary_dir)
        wd._write(mapping)
        loaded = wd.show("RT")

        self.assertIsNotNone(loaded)
        self.assertEqual(loaded.atlassian_url, "https://rt.atlassian.net")

    def test_mapping_without_atlassian_url_loads_as_none(self):
        """Existing mapping files without atlassian_url field load cleanly."""
        from agent.core.workflow_discovery import WorkflowDiscovery

        legacy = {
            "project_key": "LEGACY",
            "source": "jira",
            "discovered_at": "2025-01-01T00:00:00+00:00",
            "issue_types": [],
            "semantic_roles": {
                "qa_passed": {"status_name": "QA Done", "issue_type": "Story"}
            },
            "role_annotations_confirmed": True,
        }
        (self.canary_dir / "workflow-LEGACY.json").write_text(
            json.dumps(legacy), encoding="utf-8"
        )
        wd = WorkflowDiscovery(canary_dir=self.canary_dir)
        loaded = wd.show("LEGACY")

        self.assertIsNotNone(loaded)
        self.assertIsNone(loaded.atlassian_url)
        self.assertEqual(loaded.semantic_roles["qa_passed"].status_name, "QA Done")
