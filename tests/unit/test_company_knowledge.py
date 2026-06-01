"""Tests for CompanyKnowledge — loading, validation, secret rejection, prompt injection."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from agent.core.company_knowledge import CompanyKnowledge


def _write_company_json(tmp: Path, data: dict) -> Path:
    canary_dir = tmp / ".canary"
    canary_dir.mkdir(parents=True, exist_ok=True)
    path = canary_dir / "company.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


class TestLoadMissingFile(unittest.TestCase):
    def test_returns_empty_when_file_absent(self):
        with tempfile.TemporaryDirectory() as tmp:
            ck = CompanyKnowledge.load(Path(tmp))
        self.assertTrue(ck.is_empty)
        self.assertEqual(ck.error, "")
        self.assertEqual(ck.warnings, [])

    def test_is_empty_true_on_all_empty_fields(self):
        ck = CompanyKnowledge()
        self.assertTrue(ck.is_empty)


class TestLoadMalformedJson(unittest.TestCase):
    def test_returns_empty_on_malformed_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            canary_dir = Path(tmp) / ".canary"
            canary_dir.mkdir()
            (canary_dir / "company.json").write_text("{not valid json", encoding="utf-8")
            ck = CompanyKnowledge.load(Path(tmp))
        self.assertTrue(ck.is_empty)
        self.assertEqual(ck.error, "")

    def test_returns_empty_on_non_object_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            _write_company_json(Path(tmp), [])  # type: ignore[arg-type]
            ck = CompanyKnowledge.load(Path(tmp))
        self.assertTrue(ck.is_empty)


class TestLoadValidFile(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        _write_company_json(
            Path(self.tmp.name),
            {
                "confluence_spaces": ["QA", "ENG", "OPTUM"],
                "jira_projects": ["ORACLE", "OPTUM"],
                "internal_doc_urls": [
                    "https://capillary.atlassian.net/wiki/spaces/QA/pages/1/Test-Conventions",
                ],
                "internal_domains": ["capillarytech.com", "optumengage.com"],
                "mcp_servers": ["plugin_atlassian_atlassian"],
                "claude_code_skills": ["capillary:ui", "capillary:vulcan"],
                "notes": "Use idiomatic Playwright helpers.",
            },
        )
        self.ck = CompanyKnowledge.load(Path(self.tmp.name))

    def tearDown(self):
        self.tmp.cleanup()

    def test_is_not_empty(self):
        self.assertFalse(self.ck.is_empty)

    def test_confluence_spaces_loaded(self):
        self.assertEqual(self.ck.confluence_spaces, ["QA", "ENG", "OPTUM"])

    def test_jira_projects_loaded(self):
        self.assertEqual(self.ck.jira_projects, ["ORACLE", "OPTUM"])

    def test_internal_doc_urls_loaded(self):
        self.assertEqual(len(self.ck.internal_doc_urls), 1)
        self.assertIn("capillary.atlassian.net", self.ck.internal_doc_urls[0])

    def test_internal_domains_loaded(self):
        self.assertIn("capillarytech.com", self.ck.internal_domains)

    def test_mcp_servers_loaded(self):
        self.assertEqual(self.ck.mcp_servers, ["plugin_atlassian_atlassian"])

    def test_claude_code_skills_loaded(self):
        self.assertIn("capillary:ui", self.ck.claude_code_skills)

    def test_notes_loaded(self):
        self.assertIn("Playwright", self.ck.notes)

    def test_no_error(self):
        self.assertEqual(self.ck.error, "")


class TestFieldValidation(unittest.TestCase):
    def _load(self, data: dict) -> CompanyKnowledge:
        with tempfile.TemporaryDirectory() as tmp:
            _write_company_json(Path(tmp), data)
            return CompanyKnowledge.load(Path(tmp))

    def test_confluence_spaces_uppercased(self):
        ck = self._load({"confluence_spaces": ["qa", "eng"]})
        self.assertEqual(ck.confluence_spaces, ["QA", "ENG"])

    def test_confluence_spaces_deduped(self):
        ck = self._load({"confluence_spaces": ["QA", "QA", "ENG"]})
        self.assertEqual(ck.confluence_spaces, ["QA", "ENG"])

    def test_confluence_spaces_invalid_dropped(self):
        ck = self._load({"confluence_spaces": ["QA", "has space", "VALID"]})
        self.assertNotIn("has space", ck.confluence_spaces)
        self.assertIn("QA", ck.confluence_spaces)

    def test_internal_domains_lowercased(self):
        ck = self._load({"internal_domains": ["CAPILLARYTECH.COM"]})
        self.assertEqual(ck.internal_domains, ["capillarytech.com"])

    def test_internal_doc_urls_invalid_scheme_dropped(self):
        ck = self._load({"internal_doc_urls": ["ftp://bad.example.com/page"]})
        self.assertEqual(ck.internal_doc_urls, [])

    def test_internal_doc_urls_http_accepted(self):
        ck = self._load({"internal_doc_urls": ["http://internal.example.com/page"]})
        self.assertEqual(len(ck.internal_doc_urls), 1)

    def test_mcp_server_invalid_chars_dropped(self):
        ck = self._load({"mcp_servers": ["valid_server", "bad server!"]})
        self.assertIn("valid_server", ck.mcp_servers)
        self.assertNotIn("bad server!", ck.mcp_servers)

    def test_skill_bare_slug_accepted(self):
        ck = self._load({"claude_code_skills": ["verify"]})
        self.assertIn("verify", ck.claude_code_skills)

    def test_skill_scoped_slug_accepted(self):
        ck = self._load({"claude_code_skills": ["capillary:ui"]})
        self.assertIn("capillary:ui", ck.claude_code_skills)

    def test_skill_invalid_dropped(self):
        ck = self._load({"claude_code_skills": ["UPPERCASE", "capillary:ui"]})
        self.assertNotIn("UPPERCASE", ck.claude_code_skills)
        self.assertIn("capillary:ui", ck.claude_code_skills)

    def test_notes_capped_at_2048(self):
        ck = self._load({"notes": "x" * 3000})
        self.assertEqual(len(ck.notes), 2048)

    def test_notes_fence_stripped(self):
        ck = self._load({"notes": "context ```rm -rf /``` end"})
        self.assertNotIn("```", ck.notes)

    def test_optum_dashboard_token_env_accepted(self):
        ck = self._load({"optum_dashboard_token_env": "OPTUM_DASHBOARD_TOKEN"})
        self.assertEqual(ck.optum_dashboard_token_env, "OPTUM_DASHBOARD_TOKEN")

    def test_optum_dashboard_token_env_lowercase_dropped(self):
        ck = self._load({"optum_dashboard_token_env": "my_token"})
        self.assertEqual(ck.optum_dashboard_token_env, "")

    def test_unknown_keys_tolerated(self):
        ck = self._load({"unknown_future_field": "ignored", "confluence_spaces": ["QA"]})
        self.assertFalse(ck.is_empty)


class TestSecretRejection(unittest.TestCase):
    def _load(self, data: dict) -> CompanyKnowledge:
        with tempfile.TemporaryDirectory() as tmp:
            _write_company_json(Path(tmp), data)
            return CompanyKnowledge.load(Path(tmp))

    def test_sk_prefix_in_notes_field_not_rejected(self):
        ck = self._load({"notes": "Use sk-pattern selectors for tests."})
        self.assertFalse(ck.error)

    def test_sk_prefix_in_mcp_servers_rejected(self):
        ck = self._load({"mcp_servers": ["sk-live-abc123xyz"]})
        self.assertTrue(ck.is_empty)
        self.assertIn("secret", ck.error)

    def test_api_key_prefix_rejected(self):
        ck = self._load({"confluence_spaces": ["api_key-actual-secret-value"]})
        self.assertTrue(ck.is_empty)
        self.assertTrue(ck.error)

    def test_long_value_in_non_notes_field_rejected(self):
        ck = self._load({"mcp_servers": ["a" * 129]})
        self.assertTrue(ck.is_empty)
        self.assertTrue(ck.error)

    def test_error_set_means_is_empty(self):
        ck = self._load({"mcp_servers": ["sk-secret"]})
        self.assertTrue(ck.is_empty)


class TestPromptBlock(unittest.TestCase):
    def test_empty_returns_empty_string(self):
        self.assertEqual(CompanyKnowledge().prompt_block(), "")

    def test_non_empty_includes_header(self):
        ck = CompanyKnowledge(confluence_spaces=["QA"])
        self.assertIn("--- COMPANY KNOWLEDGE ---", ck.prompt_block())

    def test_confluence_spaces_in_block(self):
        ck = CompanyKnowledge(confluence_spaces=["QA", "ENG"])
        self.assertIn("QA, ENG", ck.prompt_block())

    def test_mcp_servers_appear_in_hint(self):
        ck = CompanyKnowledge(
            confluence_spaces=["QA"],
            mcp_servers=["plugin_atlassian_atlassian"],
        )
        block = ck.prompt_block()
        self.assertIn("plugin_atlassian_atlassian", block)

    def test_skills_formatted_with_slash(self):
        ck = CompanyKnowledge(claude_code_skills=["capillary:ui", "verify"])
        block = ck.prompt_block()
        self.assertIn("/capillary:ui", block)
        self.assertIn("/verify", block)

    def test_notes_included_verbatim(self):
        ck = CompanyKnowledge(notes="Follow our Playwright conventions.")
        self.assertIn("Follow our Playwright conventions.", ck.prompt_block())

    def test_do_not_invent_footer_present(self):
        ck = CompanyKnowledge(confluence_spaces=["QA"])
        self.assertIn("Do not invent", ck.prompt_block())


class TestToDict(unittest.TestCase):
    def test_includes_is_empty(self):
        ck = CompanyKnowledge()
        self.assertIn("is_empty", ck.to_dict())
        self.assertTrue(ck.to_dict()["is_empty"])

    def test_error_key_present_when_set(self):
        ck = CompanyKnowledge(error="something went wrong")
        self.assertIn("error", ck.to_dict())

    def test_error_key_absent_when_clear(self):
        ck = CompanyKnowledge(confluence_spaces=["QA"])
        self.assertNotIn("error", ck.to_dict())


if __name__ == "__main__":
    unittest.main()
