"""Tests for the #340c brand-assets + report_branding hook on CompanyKnowledge."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from agent.core.company_knowledge import Brand, CompanyKnowledge


def _write(tmp: Path, data: dict, name: str = "company.json") -> None:
    canary = tmp / ".canary"
    canary.mkdir(parents=True, exist_ok=True)
    (canary / name).write_text(json.dumps(data), encoding="utf-8")


_FULL_BRAND = {
    "company_name": "Acme Corp",
    "logo_url": "https://acme.example.com/logo.svg",
    "primary_color": "#0A5FFF",
    "secondary_color": "#0A0A0A",
    "footer_note": "Acme QA report",
}


class TestBrandParsing(unittest.TestCase):
    def test_valid_brand_round_trips(self):
        with tempfile.TemporaryDirectory() as tmp:
            _write(Path(tmp), {"brand": _FULL_BRAND})
            ck = CompanyKnowledge.load(Path(tmp))
        self.assertEqual(ck.brand.company_name, "Acme Corp")
        self.assertEqual(ck.brand.logo_url, "https://acme.example.com/logo.svg")
        self.assertEqual(ck.brand.primary_color, "#0A5FFF")
        self.assertEqual(ck.brand.footer_note, "Acme QA report")
        self.assertEqual(ck.warnings, [])

    def test_short_hex_color_accepted(self):
        with tempfile.TemporaryDirectory() as tmp:
            _write(Path(tmp), {"brand": {"primary_color": "#ABC"}})
            ck = CompanyKnowledge.load(Path(tmp))
        self.assertEqual(ck.brand.primary_color, "#ABC")

    def test_invalid_hex_color_dropped_with_warning(self):
        with tempfile.TemporaryDirectory() as tmp:
            _write(Path(tmp), {"brand": {"primary_color": "blue"}})
            ck = CompanyKnowledge.load(Path(tmp))
        self.assertEqual(ck.brand.primary_color, "")
        self.assertTrue(any("primary_color" in w for w in ck.warnings))

    def test_invalid_logo_url_dropped_with_warning(self):
        with tempfile.TemporaryDirectory() as tmp:
            _write(Path(tmp), {"brand": {"logo_url": "not-a-url"}})
            ck = CompanyKnowledge.load(Path(tmp))
        self.assertEqual(ck.brand.logo_url, "")
        self.assertTrue(any("logo_url" in w for w in ck.warnings))

    def test_secret_in_brand_field_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            _write(Path(tmp), {"brand": {"company_name": "sk-live-abc123"}})
            ck = CompanyKnowledge.load(Path(tmp))
        # The layer is skipped and an error is surfaced; brand stays empty.
        self.assertTrue(ck.brand.is_empty)
        self.assertIn("secret", ck.error.lower())

    def test_non_dict_brand_skipped_with_warning(self):
        with tempfile.TemporaryDirectory() as tmp:
            _write(Path(tmp), {"brand": "nope"})
            ck = CompanyKnowledge.load(Path(tmp))
        self.assertTrue(ck.brand.is_empty)
        self.assertTrue(any("brand" in w for w in ck.warnings))


class TestBrandMerge(unittest.TestCase):
    def test_per_field_merge_env_over_project(self):
        with tempfile.TemporaryDirectory() as tmp:
            # project layer: logo + primary
            _write(Path(tmp), {"brand": {
                "logo_url": "https://acme.example.com/logo.svg",
                "primary_color": "#111111",
            }})
            # env override layer: primary (wins) + footer (new)
            _write(Path(tmp), {"brand": {
                "primary_color": "#222222",
                "footer_note": "UAT build",
            }}, name="company.uat.json")
            ck = CompanyKnowledge.load(Path(tmp), env="uat")
        self.assertEqual(ck.brand.logo_url, "https://acme.example.com/logo.svg")  # project
        self.assertEqual(ck.brand.primary_color, "#222222")  # env wins
        self.assertEqual(ck.brand.footer_note, "UAT build")  # env-only


class TestToDictAndEmptiness(unittest.TestCase):
    def test_to_dict_includes_nested_brand(self):
        ck = CompanyKnowledge(brand=Brand(company_name="Acme"))
        self.assertEqual(ck.to_dict()["brand"]["company_name"], "Acme")

    def test_brand_only_config_is_not_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            _write(Path(tmp), {"brand": {"company_name": "Acme"}})
            ck = CompanyKnowledge.load(Path(tmp))
        self.assertFalse(ck.is_empty)

    def test_empty_brand_keeps_empty_ck_empty(self):
        self.assertTrue(CompanyKnowledge(brand=Brand()).is_empty)


class TestReportBranding(unittest.TestCase):
    def _ck(self) -> CompanyKnowledge:
        return CompanyKnowledge(brand=Brand(**_FULL_BRAND))

    def test_assets_pass_through_and_attribution_always_present(self):
        b = self._ck().report_branding(flavor=True)
        self.assertEqual(b["company_name"], "Acme Corp")
        self.assertEqual(b["primary_color"], "#0A5FFF")
        self.assertEqual(b["attribution"], "made with Canary")
        self.assertTrue(b["flavor"])
        self.assertTrue(b["voice_line"])  # garnish present when flavor on

    def test_flavor_off_drops_voice_but_keeps_attribution(self):
        b = self._ck().report_branding(flavor=False)
        self.assertEqual(b["voice_line"], "")
        self.assertEqual(b["attribution"], "made with Canary")
        self.assertFalse(b["flavor"])

    def test_env_off_switch_disables_flavor(self):
        for var in ("CANARY_NO_FLAVOR", "NO_FLAVOR"):
            with self.subTest(var=var), mock.patch.dict("os.environ", {var: "1"}, clear=False):
                b = self._ck().report_branding()
                self.assertFalse(b["flavor"])
                self.assertEqual(b["voice_line"], "")

    def test_default_flavor_on_when_no_env(self):
        with mock.patch.dict("os.environ", {}, clear=True):
            b = self._ck().report_branding()
        self.assertTrue(b["flavor"])

    def test_falsey_env_value_keeps_flavor_on(self):
        with mock.patch.dict("os.environ", {"CANARY_NO_FLAVOR": "false"}, clear=False):
            b = self._ck().report_branding()
        self.assertTrue(b["flavor"])


if __name__ == "__main__":
    unittest.main()
