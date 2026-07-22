"""Tests for the #340c flexible brand-ingest + report_branding hook."""

from __future__ import annotations

import contextlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from agent.core.company_knowledge import Brand, CompanyKnowledge


def _write(tmp: Path, data: dict, name: str = "company.json") -> None:
    canary = tmp / ".canary"
    canary.mkdir(parents=True, exist_ok=True)
    (canary / name).write_text(json.dumps(data), encoding="utf-8")


@contextlib.contextmanager
def _chdir(path: Path):
    prev = os.getcwd()
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(prev)


_FULL_BRAND = {
    "company_name": "Acme Corp",
    "logo_path": "assets/logo.svg",
    "primary_color": "#26A9E1",
    "secondary_color": "#F4A114",
    "text_color": "#212121",
    "background_color": "#FFF8EC",
    "footer_note": "Acme QA report",
}


class TestBrandParsing(unittest.TestCase):
    def test_recognized_fields_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            _write(Path(tmp), {"brand": _FULL_BRAND})
            ck = CompanyKnowledge.load(Path(tmp))
        a = ck.brand.assets
        self.assertEqual(a["company_name"], "Acme Corp")
        self.assertEqual(a["primary_color"], "#26A9E1")
        self.assertEqual(a["text_color"], "#212121")
        self.assertEqual(a["background_color"], "#FFF8EC")
        self.assertEqual(a["logo_path"], "assets/logo.svg")
        self.assertEqual(ck.warnings, [])

    def test_unknown_key_passes_through(self):
        with tempfile.TemporaryDirectory() as tmp:
            _write(Path(tmp), {"brand": {"tagline": "Trusted testing", "product_hue": "#695189"}})
            ck = CompanyKnowledge.load(Path(tmp))
        # Plain-text extra kept as-is; color-looking extra validated as hex.
        self.assertEqual(ck.brand.assets["tagline"], "Trusted testing")
        self.assertEqual(ck.brand.assets["product_hue"], "#695189")

    def test_extra_that_looks_like_bad_color_is_dropped(self):
        with tempfile.TemporaryDirectory() as tmp:
            _write(Path(tmp), {"brand": {"product_hue": "#zzzz"}})
            ck = CompanyKnowledge.load(Path(tmp))
        self.assertNotIn("product_hue", ck.brand.assets)
        self.assertTrue(any("product_hue" in w for w in ck.warnings))

    def test_invalid_hex_in_recognized_field_dropped_with_warning(self):
        with tempfile.TemporaryDirectory() as tmp:
            _write(Path(tmp), {"brand": {"primary_color": "blue"}})
            ck = CompanyKnowledge.load(Path(tmp))
        self.assertNotIn("primary_color", ck.brand.assets)
        self.assertTrue(any("primary_color" in w for w in ck.warnings))

    def test_accents_list_filters_invalid(self):
        with tempfile.TemporaryDirectory() as tmp:
            _write(Path(tmp), {"brand": {"accents": ["#F4A114", "nope", "#78BD31"]}})
            ck = CompanyKnowledge.load(Path(tmp))
        self.assertEqual(ck.brand.assets["accents"], ["#F4A114", "#78BD31"])

    def test_badge_and_logo_variants(self):
        with tempfile.TemporaryDirectory() as tmp:
            _write(Path(tmp), {"brand": {
                "badge_accent": "#26A9E1",
                "logo_variants": {"horizontal": "logos/horizontal.svg", "stacked": "logos/stacked.svg"},
            }})
            ck = CompanyKnowledge.load(Path(tmp))
        self.assertEqual(ck.brand.assets["badge_accent"], "#26A9E1")
        self.assertEqual(ck.brand.assets["logo_variants"]["horizontal"], "logos/horizontal.svg")

    def test_secret_in_extra_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            _write(Path(tmp), {"brand": {"api_hint": "sk-live-abc123"}})
            ck = CompanyKnowledge.load(Path(tmp))
        self.assertTrue(ck.brand.is_empty)
        self.assertIn("secret", ck.error.lower())

    def test_non_dict_brand_skipped_with_warning(self):
        with tempfile.TemporaryDirectory() as tmp:
            _write(Path(tmp), {"brand": "nope"})
            ck = CompanyKnowledge.load(Path(tmp))
        self.assertTrue(ck.brand.is_empty)
        self.assertTrue(any("brand" in w for w in ck.warnings))


class TestBrandMerge(unittest.TestCase):
    def test_per_key_merge_env_over_project(self):
        with tempfile.TemporaryDirectory() as tmp:
            _write(Path(tmp), {"brand": {"logo_path": "assets/logo.svg", "primary_color": "#111111"}})
            _write(Path(tmp), {"brand": {"primary_color": "#222222", "footer_note": "UAT build"}},
                   name="company.uat.json")
            ck = CompanyKnowledge.load(Path(tmp), env="uat")
        a = ck.brand.assets
        self.assertEqual(a["logo_path"], "assets/logo.svg")   # project-only survives
        self.assertEqual(a["primary_color"], "#222222")       # env overrides
        self.assertEqual(a["footer_note"], "UAT build")       # env-only

    def test_extras_merge_by_key_too(self):
        with tempfile.TemporaryDirectory() as tmp:
            _write(Path(tmp), {"brand": {"tagline": "org tagline"}})
            _write(Path(tmp), {"brand": {"tagline": "project tagline"}}, name="company.uat.json")
            ck = CompanyKnowledge.load(Path(tmp), env="uat")
        self.assertEqual(ck.brand.assets["tagline"], "project tagline")


class TestToDictAndEmptiness(unittest.TestCase):
    def test_to_dict_emits_flat_brand_map(self):
        ck = CompanyKnowledge(brand=Brand({"company_name": "Acme", "tagline": "hi"}))
        self.assertEqual(ck.to_dict()["brand"], {"company_name": "Acme", "tagline": "hi"})

    def test_brand_only_config_is_not_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            _write(Path(tmp), {"brand": {"company_name": "Acme"}})
            ck = CompanyKnowledge.load(Path(tmp))
        self.assertFalse(ck.is_empty)

    def test_empty_brand_keeps_empty_ck_empty(self):
        self.assertTrue(CompanyKnowledge(brand=Brand()).is_empty)


class TestReportBranding(unittest.TestCase):
    def _ck(self) -> CompanyKnowledge:
        return CompanyKnowledge(brand=Brand(dict(_FULL_BRAND)))

    def test_present_assets_pass_through_with_attribution(self):
        b = self._ck().report_branding(flavor=True)
        self.assertEqual(b["company_name"], "Acme Corp")
        self.assertEqual(b["primary_color"], "#26A9E1")
        self.assertEqual(b["attribution"], "made with Canary")
        self.assertTrue(b["flavor"])
        self.assertTrue(b["voice_line"])

    def test_flavor_off_drops_voice_but_keeps_attribution(self):
        b = self._ck().report_branding(flavor=False)
        self.assertEqual(b["voice_line"], "")
        self.assertEqual(b["attribution"], "made with Canary")
        self.assertFalse(b["flavor"])

    def test_logo_path_resolved_against_cwd(self):
        with tempfile.TemporaryDirectory() as tmp:
            with _chdir(Path(tmp)):
                b = self._ck().report_branding(flavor=False)
                expected = str(Path.cwd() / "assets/logo.svg")
            self.assertEqual(b["logo_path_resolved"], expected)

    def test_no_logo_path_no_resolved_key(self):
        ck = CompanyKnowledge(brand=Brand({"company_name": "Acme"}))
        self.assertNotIn("logo_path_resolved", ck.report_branding())

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
