"""Tests for WorkflowDiscovery — heuristics, schema round-trip, error paths."""

from __future__ import annotations

import json
import tempfile
import unittest
import urllib.error
from datetime import timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

from agent.core.workflow_discovery import (
    IssueType,
    SemanticRole,
    StatusEntry,
    TransitionEntry,
    WorkflowDiscovery,
    WorkflowDiscoveryError,
    WorkflowMapping,
    resolve_role,
)


# ── helpers ───────────────────────────────────────────────────────────────────


def _make_mapping(
    project_key: str = "TEST",
    *,
    source: str = "jira",
    statuses: list[tuple[str, str, str]] | None = None,
    transitions: list[tuple[str, str, str, str]] | None = None,
    semantic_roles: dict | None = None,
    confirmed: bool = False,
) -> WorkflowMapping:
    """Build a WorkflowMapping for testing without network calls."""
    statuses = statuses or [
        ("1", "Open",        "new"),
        ("3", "In Progress", "indeterminate"),
        ("5", "QA",          "indeterminate"),
        ("6", "QA Passed",   "indeterminate"),
        ("4", "Done",        "done"),
    ]
    transitions = transitions or []
    issue_types = [
        IssueType(
            id="10001",
            name="Bug",
            statuses=[StatusEntry(id=i, name=n, category=c) for i, n, c in statuses],
            transitions=[
                TransitionEntry(id=i, name=n, from_status=f, to_status=t)
                for i, n, f, t in transitions
            ],
        )
    ]
    roles = {r: SemanticRole(**v) for r, v in (semantic_roles or {}).items()}
    return WorkflowMapping(
        project_key=project_key,
        source=source,
        discovered_at="2026-05-27T00:00:00+00:00",
        issue_types=issue_types,
        semantic_roles=roles,
        role_annotations_confirmed=confirmed,
    )


# ── schema round-trip ─────────────────────────────────────────────────────────


class TestWorkflowMappingSchema(unittest.TestCase):

    def test_to_dict_has_schema_field(self):
        m = _make_mapping()
        d = m.to_dict()
        self.assertIn("$schema", d)
        self.assertIn("workflow-mapping/v1", d["$schema"])

    def test_to_dict_and_from_dict_round_trip(self):
        original = _make_mapping(
            transitions=[("21", "Start", "Open", "In Progress")],
            semantic_roles={"qa_passed": {"status_name": "QA Passed", "issue_type": "Bug"}},
            confirmed=True,
        )
        d = original.to_dict()
        restored = WorkflowMapping.from_dict(d)

        self.assertEqual(restored.project_key, original.project_key)
        self.assertEqual(restored.source, original.source)
        self.assertEqual(len(restored.issue_types), 1)
        self.assertEqual(len(restored.issue_types[0].statuses), 5)
        self.assertEqual(len(restored.issue_types[0].transitions), 1)
        self.assertEqual(restored.issue_types[0].transitions[0].from_status, "Open")
        self.assertEqual(restored.issue_types[0].transitions[0].to_status, "In Progress")
        self.assertTrue(restored.role_annotations_confirmed)
        self.assertIn("qa_passed", restored.semantic_roles)
        self.assertEqual(restored.semantic_roles["qa_passed"].status_name, "QA Passed")

    def test_to_json_is_valid_json(self):
        m = _make_mapping()
        raw = m.to_json()
        parsed = json.loads(raw)
        self.assertEqual(parsed["project_key"], "TEST")

    def test_from_dict_tolerates_missing_transitions(self):
        d = _make_mapping().to_dict()
        d["issue_types"][0]["transitions"] = []
        m = WorkflowMapping.from_dict(d)
        self.assertEqual(m.issue_types[0].transitions, [])

    def test_from_dict_handles_from_to_aliases(self):
        """The 'from'/'to' JSON keys should map to from_status/to_status."""
        d = {
            "project_key": "X",
            "source": "jira",
            "discovered_at": "2026-01-01T00:00:00+00:00",
            "issue_types": [
                {
                    "id": "1",
                    "name": "Bug",
                    "statuses": [],
                    "transitions": [
                        {"id": "11", "name": "Start", "from": "Open", "to": "In Progress"}
                    ],
                }
            ],
            "semantic_roles": {},
            "role_annotations_confirmed": False,
        }
        m = WorkflowMapping.from_dict(d)
        self.assertEqual(m.issue_types[0].transitions[0].from_status, "Open")
        self.assertEqual(m.issue_types[0].transitions[0].to_status, "In Progress")


# ── persistence ───────────────────────────────────────────────────────────────


class TestWorkflowDiscoveryPersistence(unittest.TestCase):

    def test_write_and_load_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            wd = WorkflowDiscovery(canary_dir=tmp)
            mapping = _make_mapping(project_key="PROJ")
            wd._write(mapping)
            path = Path(tmp) / "workflow-PROJ.json"
            self.assertTrue(path.exists())
            loaded = wd._load_cached("PROJ")
            self.assertIsNotNone(loaded)
            self.assertEqual(loaded.project_key, "PROJ")

    def test_load_cached_returns_none_when_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            wd = WorkflowDiscovery(canary_dir=tmp)
            self.assertIsNone(wd._load_cached("NOEXIST"))

    def test_load_cached_returns_none_for_corrupt_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "workflow-BAD.json"
            path.write_text("not valid json", encoding="utf-8")
            wd = WorkflowDiscovery(canary_dir=tmp)
            self.assertIsNone(wd._load_cached("BAD"))

    def test_mapping_path_sanitises_slash_in_key(self):
        with tempfile.TemporaryDirectory() as tmp:
            wd = WorkflowDiscovery(canary_dir=tmp)
            path = wd._mapping_path("owner/repo")
            self.assertNotIn("/owner/", path.name)
            self.assertIn("workflow-", path.name)

    def test_discover_skips_write_in_dry_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            wd = WorkflowDiscovery(canary_dir=tmp)
            # Pre-seed a mapping so no network call happens.
            seed = _make_mapping(project_key="DRY")
            wd._write(seed)
            # A dry-run refresh should not clobber the file.
            original_mtime = wd._mapping_path("DRY").stat().st_mtime
            with patch.object(wd, "_fetch_jira", return_value=_make_mapping(project_key="DRY")):
                wd.discover("DRY", refresh=True, dry_run=True)
            new_mtime = wd._mapping_path("DRY").stat().st_mtime
            self.assertEqual(original_mtime, new_mtime)


# ── heuristics ────────────────────────────────────────────────────────────────


class TestSemanticRoleHeuristics(unittest.TestCase):

    def _discover_fresh(self, statuses: list[tuple[str, str, str]]) -> WorkflowMapping:
        m = _make_mapping(statuses=statuses)
        wd = WorkflowDiscovery.__new__(WorkflowDiscovery)
        return wd._apply_heuristics(m)

    def test_qa_passed_detected_by_name(self):
        m = self._discover_fresh([
            ("1", "Open", "new"),
            ("2", "QA Passed", "indeterminate"),
            ("3", "Done", "done"),
        ])
        self.assertIn("qa_passed", m.semantic_roles)
        self.assertEqual(m.semantic_roles["qa_passed"].status_name, "QA Passed")

    def test_ready_to_deploy_detected_from_done(self):
        m = self._discover_fresh([
            ("1", "Open", "new"),
            ("2", "Done", "done"),
        ])
        self.assertIn("ready_to_deploy", m.semantic_roles)
        self.assertEqual(m.semantic_roles["ready_to_deploy"].status_name, "Done")

    def test_in_review_detected(self):
        m = self._discover_fresh([
            ("1", "Open", "new"),
            ("2", "In Review", "indeterminate"),
        ])
        self.assertIn("in_review", m.semantic_roles)

    def test_in_qa_detected(self):
        m = self._discover_fresh([
            ("1", "QA", "indeterminate"),
        ])
        self.assertIn("in_qa", m.semantic_roles)

    def test_in_progress_detected(self):
        m = self._discover_fresh([
            ("1", "In Progress", "indeterminate"),
        ])
        self.assertIn("in_progress", m.semantic_roles)

    def test_blocked_detected(self):
        m = self._discover_fresh([
            ("1", "Blocked", "indeterminate"),
        ])
        self.assertIn("blocked", m.semantic_roles)

    def test_no_match_leaves_role_unset(self):
        m = self._discover_fresh([
            ("1", "Unicorn Status", "indeterminate"),
        ])
        self.assertNotIn("qa_passed", m.semantic_roles)

    def test_existing_role_not_overwritten(self):
        m = _make_mapping(
            statuses=[("1", "QA Passed", "indeterminate"), ("2", "Done", "done")],
            semantic_roles={"qa_passed": {"status_name": "Custom", "issue_type": "Bug"}},
        )
        wd = WorkflowDiscovery.__new__(WorkflowDiscovery)
        result = wd._apply_heuristics(m)
        # Pre-existing role should be preserved.
        self.assertEqual(result.semantic_roles["qa_passed"].status_name, "Custom")

    def test_case_insensitive_matching(self):
        m = self._discover_fresh([
            ("1", "QA PASSED", "indeterminate"),
        ])
        self.assertIn("qa_passed", m.semantic_roles)

    def test_heuristics_priority_qa_passed_before_ready_to_deploy(self):
        """qa_passed should be set independently of ready_to_deploy."""
        m = self._discover_fresh([
            ("1", "QA Passed", "indeterminate"),
            ("2", "Done", "done"),
        ])
        self.assertEqual(m.semantic_roles["qa_passed"].status_name, "QA Passed")
        self.assertEqual(m.semantic_roles["ready_to_deploy"].status_name, "Done")


# ── resolve_role ──────────────────────────────────────────────────────────────


class TestResolveRole(unittest.TestCase):

    def test_resolve_role_returns_status_name(self):
        with tempfile.TemporaryDirectory() as tmp:
            wd = WorkflowDiscovery(canary_dir=tmp)
            m = _make_mapping(
                project_key="R",
                semantic_roles={"qa_passed": {"status_name": "QA Passed", "issue_type": "Bug"}},
                confirmed=True,
            )
            wd._write(m)
            result = wd.resolve_role("R", "qa_passed")
            self.assertEqual(result, "QA Passed")

    def test_resolve_role_returns_none_when_mapping_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            wd = WorkflowDiscovery(canary_dir=tmp)
            self.assertIsNone(wd.resolve_role("MISSING", "qa_passed"))

    def test_resolve_role_returns_none_for_unset_role(self):
        with tempfile.TemporaryDirectory() as tmp:
            wd = WorkflowDiscovery(canary_dir=tmp)
            m = _make_mapping(project_key="S")
            wd._write(m)
            self.assertIsNone(wd.resolve_role("S", "nonexistent_role"))

    def test_module_level_resolve_role(self):
        with tempfile.TemporaryDirectory() as tmp:
            wd = WorkflowDiscovery(canary_dir=tmp)
            m = _make_mapping(
                project_key="MOD",
                semantic_roles={"ready_to_deploy": {"status_name": "Done", "issue_type": "Bug"}},
            )
            wd._write(m)
            result = resolve_role("MOD", "ready_to_deploy", canary_dir=tmp)
            self.assertEqual(result, "Done")


# ── discover: cache-first behaviour ──────────────────────────────────────────


class TestDiscoverCacheFirst(unittest.TestCase):

    def test_discover_returns_cached_without_network_call(self):
        with tempfile.TemporaryDirectory() as tmp:
            wd = WorkflowDiscovery(canary_dir=tmp)
            seed = _make_mapping(project_key="CACHED")
            wd._write(seed)
            with patch.object(wd, "_fetch_jira") as mock_fetch:
                result = wd.discover("CACHED")
            mock_fetch.assert_not_called()
            self.assertEqual(result.project_key, "CACHED")

    def test_discover_refresh_calls_fetch(self):
        with tempfile.TemporaryDirectory() as tmp:
            wd = WorkflowDiscovery(canary_dir=tmp)
            seed = _make_mapping(project_key="REFRESH")
            wd._write(seed)
            fresh = _make_mapping(project_key="REFRESH")
            with patch.object(wd, "_fetch_jira", return_value=fresh) as mock_fetch:
                wd.discover("REFRESH", refresh=True)
            mock_fetch.assert_called_once_with("REFRESH")

    def test_discover_missing_cache_calls_fetch(self):
        with tempfile.TemporaryDirectory() as tmp:
            wd = WorkflowDiscovery(canary_dir=tmp)
            fresh = _make_mapping(project_key="NEW")
            with patch.object(wd, "_fetch_jira", return_value=fresh):
                result = wd.discover("NEW")
            self.assertEqual(result.project_key, "NEW")
            # Verify it was persisted.
            self.assertIsNotNone(wd._load_cached("NEW"))

    def test_discover_github_repo_routes_to_fetch_github(self):
        with tempfile.TemporaryDirectory() as tmp:
            wd = WorkflowDiscovery(canary_dir=tmp)
            fresh = _make_mapping(project_key="owner/repo", source="github")
            with patch.object(wd, "_fetch_github", return_value=fresh) as mock_gh:
                wd.discover("owner/repo")
            mock_gh.assert_called_once_with("owner/repo")

    def test_discover_refresh_preserves_confirmed_roles(self):
        with tempfile.TemporaryDirectory() as tmp:
            wd = WorkflowDiscovery(canary_dir=tmp)
            confirmed = _make_mapping(
                project_key="PRES",
                semantic_roles={"qa_passed": {"status_name": "Verified", "issue_type": "Bug"}},
                confirmed=True,
            )
            wd._write(confirmed)
            fresh = _make_mapping(project_key="PRES")  # no roles
            with patch.object(wd, "_fetch_jira", return_value=fresh):
                result = wd.discover("PRES", refresh=True)
            # Confirmed role should survive the refresh.
            self.assertEqual(result.semantic_roles["qa_passed"].status_name, "Verified")


# ── Jira error paths ──────────────────────────────────────────────────────────


class TestJiraErrorPaths(unittest.TestCase):

    def test_missing_credentials_raises_error(self):
        import os
        env_backup = {k: os.environ.pop(k, None) for k in ("ATLASSIAN_URL", "ATLASSIAN_USER", "ATLASSIAN_TOKEN")}
        try:
            with tempfile.TemporaryDirectory() as tmp:
                wd = WorkflowDiscovery(canary_dir=tmp)
                with self.assertRaises(WorkflowDiscoveryError) as ctx:
                    wd._fetch_jira("NOENV")
            self.assertIn("ATLASSIAN_URL", str(ctx.exception))
        finally:
            for k, v in env_backup.items():
                if v is not None:
                    os.environ[k] = v

    def test_http_error_raises_workflow_discovery_error(self):
        env_patch = {
            "ATLASSIAN_URL": "https://fake.atlassian.net",
            "ATLASSIAN_USER": "user@example.com",
            "ATLASSIAN_TOKEN": "token123",
        }
        with patch.dict("os.environ", env_patch):
            with tempfile.TemporaryDirectory() as tmp:
                wd = WorkflowDiscovery(canary_dir=tmp)
                http_error = urllib.error.HTTPError(
                    url="https://fake.atlassian.net/rest/api/3/project/BAD/issuetypes",
                    code=404,
                    msg="Not Found",
                    hdrs=None,  # type: ignore[arg-type]
                    fp=None,  # type: ignore[arg-type]
                )
                http_error.read = lambda: b'{"errorMessages": ["Project not found"]}'
                with patch("urllib.request.urlopen", side_effect=http_error):
                    with self.assertRaises(WorkflowDiscoveryError):
                        wd._fetch_jira("BAD")

    def test_network_error_raises_workflow_discovery_error(self):
        env_patch = {
            "ATLASSIAN_URL": "https://fake.atlassian.net",
            "ATLASSIAN_USER": "user@example.com",
            "ATLASSIAN_TOKEN": "token123",
        }
        with patch.dict("os.environ", env_patch):
            with tempfile.TemporaryDirectory() as tmp:
                wd = WorkflowDiscovery(canary_dir=tmp)
                with patch(
                    "urllib.request.urlopen",
                    side_effect=urllib.error.URLError("connection refused"),
                ):
                    with self.assertRaises(WorkflowDiscoveryError):
                        wd._fetch_jira("NET")

    def test_project_not_found_response_raises_error(self):
        env_patch = {
            "ATLASSIAN_URL": "https://fake.atlassian.net",
            "ATLASSIAN_USER": "user@example.com",
            "ATLASSIAN_TOKEN": "token123",
        }
        with patch.dict("os.environ", env_patch):
            with tempfile.TemporaryDirectory() as tmp:
                wd = WorkflowDiscovery(canary_dir=tmp)
                error_body = json.dumps(
                    {"errorMessages": ["No project could be found with key 'X'"]}
                ).encode()
                mock_resp = MagicMock()
                mock_resp.__enter__ = lambda s: s
                mock_resp.__exit__ = MagicMock(return_value=False)
                mock_resp.read.return_value = error_body
                with patch("urllib.request.urlopen", return_value=mock_resp):
                    with self.assertRaises(WorkflowDiscoveryError):
                        wd._fetch_jira("X")


# ── parse_statuses ────────────────────────────────────────────────────────────


class TestParseStatuses(unittest.TestCase):

    def setUp(self):
        self.wd = WorkflowDiscovery.__new__(WorkflowDiscovery)

    def test_parse_statuses_matches_issue_type_by_name(self):
        raw = [
            {
                "name": "Bug",
                "statuses": [
                    {"id": "1", "name": "Open", "statusCategory": {"key": "new"}},
                    {"id": "2", "name": "Done", "statusCategory": {"key": "done"}},
                ],
            },
            {
                "name": "Story",
                "statuses": [
                    {"id": "3", "name": "In Progress", "statusCategory": {"key": "indeterminate"}},
                ],
            },
        ]
        result = self.wd._parse_statuses(raw, "Bug")
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0].name, "Open")
        self.assertEqual(result[0].category, "new")

    def test_parse_statuses_falls_back_to_all_when_no_match(self):
        raw = [
            {
                "name": "OtherType",
                "statuses": [
                    {"id": "1", "name": "Open",   "statusCategory": {"key": "new"}},
                    {"id": "2", "name": "Closed", "statusCategory": {"key": "done"}},
                ],
            }
        ]
        result = self.wd._parse_statuses(raw, "Bug")
        # Should fall back to returning all statuses.
        self.assertEqual(len(result), 2)

    def test_parse_statuses_deduplicates_on_fallback(self):
        raw = [
            {"name": "T1", "statuses": [{"id": "1", "name": "Open", "statusCategory": {"key": "new"}}]},
            {"name": "T2", "statuses": [{"id": "1", "name": "Open", "statusCategory": {"key": "new"}}]},
        ]
        result = self.wd._parse_statuses(raw, "Unmatched")
        names = [s.name for s in result]
        self.assertEqual(len(names), len(set(names)))

    def test_parse_statuses_returns_empty_for_non_list_input(self):
        result = self.wd._parse_statuses({"not": "a list"}, "Bug")
        self.assertEqual(result, [])


# ── show ──────────────────────────────────────────────────────────────────────


class TestShow(unittest.TestCase):

    def test_show_returns_mapping_when_cached(self):
        with tempfile.TemporaryDirectory() as tmp:
            wd = WorkflowDiscovery(canary_dir=tmp)
            seed = _make_mapping(project_key="SHOW")
            wd._write(seed)
            result = wd.show("SHOW")
            self.assertIsNotNone(result)
            self.assertEqual(result.project_key, "SHOW")

    def test_show_returns_none_when_not_cached(self):
        with tempfile.TemporaryDirectory() as tmp:
            wd = WorkflowDiscovery(canary_dir=tmp)
            self.assertIsNone(wd.show("GHOST"))


if __name__ == "__main__":
    unittest.main()
