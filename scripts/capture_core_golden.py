#!/usr/bin/env python3
"""Capture golden outputs from the Python core/ recommender-slice modules.

Runs classifier, framework_registry, quality_scorer, pattern_matcher, and
recommender on a fixed set of representative inputs and writes structured JSON
to ts/test/fixtures/core-golden/. The TS parity test (ts/test/core-parity.test.ts)
reads the SAME inputs back out of these files and asserts the TS port produces
identical output.

Run from the repo root:  .venv/bin/python scripts/capture_core_golden.py
Deterministic: clears the env vars the recommender reads (no license unlocks,
no CANARY_SCOPE) so golden output does not depend on the caller's environment.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

# Deterministic environment BEFORE importing the modules that read it.
for _k in list(os.environ):
    if _k.startswith("CANARY_") or _k.startswith("CANARY_LICENSE"):
        os.environ.pop(_k, None)
os.environ.pop("CANARY_SCOPE", None)

from agent.core.classifier import TestClassifier, extract_framework_hint  # noqa: E402
from agent.core.framework_registry import FrameworkRegistry  # noqa: E402
from agent.core.pattern_matcher import PatternMatcher  # noqa: E402
from agent.core.quality_scorer import QualityScorer  # noqa: E402
from agent.core.recommender import FrameworkRecommender  # noqa: E402
from agent.core.classifier import ClassificationResult  # noqa: E402

REPO = Path(__file__).resolve().parents[1]
GOLDEN = REPO / "ts" / "test" / "fixtures" / "core-golden"
SAMPLES = GOLDEN / "samples"
SAMPLE_PROJECT = REPO / "ts" / "test" / "fixtures" / "sample-project"

CLASSIFIER_PROMPTS = [
    "test the performance under heavy traffic",
    "load test the checkout with k6",
    "write a Playwright test for /api/orders/{id}",
    "GET /users returns the user list",
    "POST new records to the queue",
    "accessibility audit with axe",
    "vitest unit test for validateEmail",
    "test the login flow end to end",
    "check the api endpoint responses",
    "render the React component",
    "just test something basic",
    "property-based testing of the parser",
    "contract test between the two services",
]

# (test_type, confidence, framework_hint, metadata_languages)
RECOMMENDER_CASES = [
    ("e2e_ui", 0.9, None, None),
    ("api", 0.85, None, None),
    ("api", 0.85, "pytest", None),
    ("api", 0.9, None, ["python"]),
    ("synthetic_data", 0.88, None, None),
    ("observability", 0.9, None, None),
    ("no_such_category", 0.9, None, None),
]

QUALITY_CASES = [("pytest_sample.txt", "pytest"), ("vitest_sample.txt", "vitest")]

REGISTRY_CATEGORIES = ["e2e_ui", "api", "observability", "synthetic_data"]
REGISTRY_NAMES = ["playwright", "pytest", "opentelemetry", "does-not-exist"]
REGISTRY_LANGUAGES = ["python", "typescript", "javascript"]

PATTERN_CASES = [
    ("pytest", ""),
    ("vitest", ""),
    ("playwright", ""),
    ("", "api"),
]


@dataclass
class _Meta:
    detected_languages: set


def _classifier() -> list:
    clf = TestClassifier()
    out = []
    for prompt in CLASSIFIER_PROMPTS:
        r = clf.classify(prompt)
        out.append(
            {
                "prompt": prompt,
                "result": {"intent": r.intent, "test_type": r.test_type, "confidence": r.confidence},
                "hint": extract_framework_hint(prompt),
            }
        )
    return out


def _recommender() -> list:
    rec = FrameworkRecommender()
    out = []
    for test_type, confidence, hint, langs in RECOMMENDER_CASES:
        cls = ClassificationResult(intent="generate_tests", test_type=test_type, confidence=confidence)
        metadata = _Meta(detected_languages=set(langs)) if langs is not None else None
        result = rec.recommend(cls, metadata=metadata, framework_hint=hint)
        out.append(
            {
                "test_type": test_type,
                "confidence": confidence,
                "framework_hint": hint,
                "metadata_languages": langs,
                "result": result,
            }
        )
    return out


def _quality() -> list:
    scorer = QualityScorer()
    out = []
    for sample, framework in QUALITY_CASES:
        code = (SAMPLES / sample).read_text(encoding="utf-8")
        out.append({"sample": sample, "framework": framework, "score": scorer.score(code, framework)})
    return out


def _registry() -> dict:
    reg = FrameworkRegistry()
    return {
        "summaries": reg.summaries(),
        "byCategory": {c: [f["name"] for f in reg.get_by_category(c)] for c in REGISTRY_CATEGORIES},
        "preferred": {
            c: (reg.get_preferred_by_category(c) or {}).get("name") for c in REGISTRY_CATEGORIES
        },
        "findByName": {n: (reg.find_by_name(n) or {}).get("name") for n in REGISTRY_NAMES},
        "executionInfo": {n: reg.execution_info(n) for n in REGISTRY_NAMES},
        "matchByLanguage": {
            lang: [f["name"] for f in reg.match_by_language(lang)] for lang in REGISTRY_LANGUAGES
        },
    }


def _pattern() -> list:
    pm = PatternMatcher()
    out = []
    for framework, test_type in PATTERN_CASES:
        profile = pm.scan(str(SAMPLE_PROJECT), framework=framework, test_type=test_type)
        out.append(
            {
                "framework": framework,
                "test_type": test_type,
                "profile": {
                    "test_count": profile.test_count,
                    "language": profile.language,
                    "naming_style": profile.naming_style,
                    "assertion_style": profile.assertion_style,
                    "uses_classes": profile.uses_classes,
                    "uses_fixtures": profile.uses_fixtures,
                    "uses_describe": profile.uses_describe,
                    "common_imports": profile.common_imports,
                    "sample_names": profile.sample_names,
                },
            }
        )
    return out


def main() -> None:
    GOLDEN.mkdir(parents=True, exist_ok=True)
    artifacts = {
        "classifier.json": _classifier(),
        "recommender.json": _recommender(),
        "quality.json": _quality(),
        "registry.json": _registry(),
        "pattern.json": _pattern(),
    }
    for name, data in artifacts.items():
        (GOLDEN / name).write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        print(f"wrote {name}")


if __name__ == "__main__":
    main()
