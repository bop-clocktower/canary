#!/usr/bin/env python3
"""Capture golden outputs from the Python core/ modules.

Runs the pure/deterministic core modules on a fixed set of representative inputs
and writes structured JSON to ts/test/fixtures/core-golden/. The TS parity test
(ts/test/core-parity.test.ts) reads the SAME inputs back out of these files and
asserts the TS port produces identical output.

Covered: classifier, framework_registry, quality_scorer, pattern_matcher,
recommender, detection, pattern_healer, reporter, scaffolder, feedback,
config_validation, workflow_discovery.

Run from the repo root:  PYTHONPATH=. python3 scripts/capture_core_golden.py
Deterministic: clears the env vars the recommender reads (no license unlocks,
no CANARY_SCOPE) so golden output does not depend on the caller's environment.
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path

# Deterministic environment BEFORE importing the modules that read it.
for _k in list(os.environ):
    if _k.startswith("CANARY_") or _k.startswith("CANARY_LICENSE"):
        os.environ.pop(_k, None)
os.environ.pop("CANARY_SCOPE", None)

from agent.core.classifier import TestClassifier, extract_framework_hint  # noqa: E402
from agent.core.config_validation import read_json_with_warning  # noqa: E402
from agent.core.detection import uncertain_detection_message  # noqa: E402
from agent.core.feedback import build_feedback, build_issue_url  # noqa: E402
from agent.core.framework_registry import FrameworkRegistry  # noqa: E402
from agent.core.pattern_healer import PatternHealer  # noqa: E402
from agent.core.pattern_matcher import PatternMatcher  # noqa: E402
from agent.core.quality_scorer import QualityScorer  # noqa: E402
from agent.core.recommender import FrameworkRecommender  # noqa: E402
from agent.core.reporter import Reporter  # noqa: E402
from agent.core.scaffolder import TEMPLATES, scaffoldable_frameworks  # noqa: E402
from agent.core.workflow_discovery import (  # noqa: E402
    WorkflowDiscovery,
    WorkflowMapping,
)
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

# ── detection ──────────────────────────────────────────────────────────────
# (what, reason, candidates, override_hint). Covers: no optional pieces, all
# pieces, an EMPTY candidate list (must omit the "Known …" clause), and a
# subset.
DETECTION_CASES = [
    {"what": "test framework", "reason": None, "candidates": None, "override_hint": None},
    {
        "what": "test framework",
        "reason": "no config file or dependency matched",
        "candidates": ["pytest", "vitest", "playwright"],
        "override_hint": "--framework <name>",
    },
    {
        "what": "doctor persona",
        "reason": None,
        "candidates": [],  # empty -> "Known …" clause omitted
        "override_hint": "--persona <tag>",
    },
    {
        "what": "doctor persona",
        "reason": "multiple overlays declared personas",
        "candidates": ["backend", "frontend"],
        "override_hint": None,
    },
    {"what": "CI provider", "reason": "ambiguous signals", "candidates": None, "override_hint": None},
]

# ── pattern_healer ─────────────────────────────────────────────────────────
# Representative snippets exercising each rule plus clean / multi-fix / skip.
HEALER_SNIPPETS = {
    "time_sleep": "import time\n\n\ndef test_flow():\n    time.sleep(2)\n    assert True\n",
    "wait_for_timeout": (
        "test('nav', async ({ page }) => {\n"
        "  await page.waitForTimeout(1000);\n"
        "});\n"
    ),
    # Bare action with a non-selector arg (a variable), so ONLY the missing-await
    # rule fires and the brittle-selector skip stays silent.
    "missing_await": (
        "test('go', async ({ page }) => {\n"
        "  page.click(target);\n"
        "});\n"
    ),
    # Brittle selector present but no auto-fixable action -> skip note only.
    "brittle_selector": "const sel = '.submit-button';\nconst id = '#main';\n",
    "clean": "def test_ok():\n    assert 1 + 1 == 2\n",
    # Multiple fixes in one file (sleep + waitForTimeout + missing await). The
    # page.fill line carries a quoted selector, so a skip note is emitted too.
    "multi_fix": (
        "import time\n"
        "\n"
        "async def scenario(page):\n"
        "    time.sleep(3)\n"
        "    await page.waitForTimeout(500)\n"
        "    page.fill('#email', value)\n"
    ),
}

# ── reporter ───────────────────────────────────────────────────────────────
# "Generation result" dicts, with and without an execution result / stderr.
# NOTE: all numbers are INTEGERS on purpose — Python `json.dumps` renders a
# float like 1.0 as "1.0" while JS `JSON.stringify` renders it "1", so a float
# whose value is integral would diverge byte-for-byte. Quality is a small int
# dict rather than a float score for the same reason.
REPORTER_CASES = [
    {
        "name": "gen_only",
        "result": {
            "output_file": "tests/e2e/orders.spec.ts",
            "test_type": "e2e_ui",
            "framework": "playwright",
            "reasoning": ["matched playwright config", "e2e intent"],
            "quality": {"score": 87, "grade": "B"},
        },
    },
    {
        "name": "gen_no_output",
        "result": {"test_type": "api", "framework": "pytest"},
    },
    {
        "name": "exec_pass",
        "result": {
            "output_file": "tests/test_api.py",
            "test_type": "api",
            "framework": "pytest",
            "reasoning": [],
            "execution": {"exit_code": 0},
        },
    },
    {
        "name": "exec_fail_stderr",
        "result": {
            "output_file": "tests/test_api.py",
            "test_type": "api",
            "framework": "pytest",
            "execution": {
                "exit_code": 1,
                "fixed": True,
                "stderr": "AssertionError: expected 200 but got 500",
            },
        },
    },
    {
        "name": "exec_fail_long_stderr",
        "result": {
            "output_file": "tests/test_api.py",
            "test_type": "api",
            "framework": "pytest",
            # >300 chars -> truncated with a trailing ellipsis (U+2026).
            "execution": {"exit_code": 2, "stderr": "E" + ("rror " * 80)},
        },
    },
]

# ── feedback ───────────────────────────────────────────────────────────────
# build_issue_url takes an EXPLICIT context, so the whole URL is deterministic
# and compared byte-for-byte. Inputs avoid `~` and `*`, the only two characters
# where CPython quote_plus and JS URLSearchParams percent-encode differently.
FEEDBACK_URL_CASES = [
    {
        "category": "bug",
        "message": "Crash on startup with a broken config",
        "context": {"version": "5.12.0", "os": "Linux 6.1", "python": "3.11", "install": "pip/npm"},
    },
    {"category": "idea", "message": "Add a dark mode toggle", "context": {}},
    {
        # message > 60 chars -> title truncates to the first 60.
        "category": "docs",
        "message": "The quick brown fox jumps over the lazy dog and then keeps on running",
        "context": {"os": "Darwin 27.0.0"},
    },
]
# build_feedback(message, category) pulls collect_context() internally, whose
# VALUES are runtime-specific (see capture note). Only message/category and the
# context KEY SET are deterministic across runtimes.
FEEDBACK_BUILD_CASES = [
    {"category": "ux", "message": "The --scope flag is confusing"},
    {"category": "bug", "message": "Null pointer in the reporter"},
]

# ── config_validation ──────────────────────────────────────────────────────
# content=None means "no file on disk" (the absent case). Warning TEXT differs
# between runtimes (Python JSONDecodeError vs JS SyntaxError, plus the path), so
# the golden captures the parsed DATA value and only whether the warning is null.
CONFIG_CASES = [
    {"name": "absent", "content": None},
    {"name": "valid_object", "content": '{"a": 1, "b": "two", "nested": {"x": true}}'},
    {"name": "malformed", "content": '{ "a": 1, '},
    {"name": "array_root", "content": "[1, 2, 3]"},
    {"name": "null_root", "content": "null"},
    {"name": "scalar", "content": "42"},
]

# ── workflow_discovery ─────────────────────────────────────────────────────
# Pure schema round-trip (from_dict -> to_json) and apply_heuristics only.
# discovered_at is pinned so the golden has no wall-clock dependency; no Jira /
# GitHub / HTTP / subprocess path is exercised.
WF_TOJSON_CASES = [
    {
        "name": "full",
        "input": {
            "project_key": "ACME",
            "source": "jira",
            "discovered_at": "2026-01-01T00:00:00+00:00",
            "issue_types": [
                {
                    "id": "10001",
                    "name": "Story",
                    "statuses": [
                        {"id": "1", "name": "To Do", "category": "new"},
                        {"id": "2", "name": "In Progress", "category": "indeterminate"},
                        {"id": "3", "name": "Done", "category": "done"},
                    ],
                    "transitions": [
                        {"id": "11", "name": "Start", "from": "To Do", "to": "In Progress"},
                        {"id": "12", "name": "Finish", "from": "In Progress", "to": "Done"},
                    ],
                }
            ],
            "semantic_roles": {
                "in_progress": {"status_name": "In Progress", "issue_type": "Story"}
            },
            "role_annotations_confirmed": True,
            "atlassian_url": "https://acme.atlassian.net",
        },
    },
    {
        "name": "minimal_no_url",
        "input": {
            "project_key": "MIN",
            "source": "github",
            "discovered_at": "2026-01-01T00:00:00+00:00",
            "issue_types": [],
            "semantic_roles": {},
            "role_annotations_confirmed": False,
        },
    },
]
WF_HEURISTIC_CASES = [
    {
        "name": "assign_many",
        "input": {
            "project_key": "HEUR",
            "source": "jira",
            "discovered_at": "2026-01-01T00:00:00+00:00",
            "issue_types": [
                {
                    "id": "1",
                    "name": "Bug",
                    "statuses": [
                        {"id": "a", "name": "Backlog", "category": "new"},
                        {"id": "b", "name": "In Progress", "category": "indeterminate"},
                        {"id": "c", "name": "In Review", "category": "indeterminate"},
                        {"id": "d", "name": "QA Testing", "category": "indeterminate"},
                        {"id": "e", "name": "Verified", "category": "indeterminate"},
                        {"id": "f", "name": "Done", "category": "done"},
                    ],
                    "transitions": [],
                }
            ],
            "semantic_roles": {},
            "role_annotations_confirmed": False,
        },
    },
    {
        "name": "preset_not_overridden",
        "input": {
            "project_key": "PRE",
            "source": "jira",
            "discovered_at": "2026-01-01T00:00:00+00:00",
            "issue_types": [
                {
                    "id": "1",
                    "name": "Task",
                    "statuses": [
                        {"id": "a", "name": "In Progress", "category": "indeterminate"},
                        {"id": "b", "name": "Blocked", "category": "indeterminate"},
                    ],
                    "transitions": [],
                }
            ],
            # Pre-set role must survive; heuristics only fill the gaps.
            "semantic_roles": {
                "in_progress": {"status_name": "Custom WIP", "issue_type": "Task"}
            },
            "role_annotations_confirmed": True,
        },
    },
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


def _detection() -> list:
    out = []
    for c in DETECTION_CASES:
        message = uncertain_detection_message(
            c["what"],
            reason=c["reason"],
            candidates=c["candidates"],
            override_hint=c["override_hint"],
        )
        out.append({**c, "message": message})
    return out


def _pattern_healer() -> list:
    healer = PatternHealer()
    out = []
    with tempfile.TemporaryDirectory() as tmp:
        for name, code in HEALER_SNIPPETS.items():
            fp = Path(tmp) / f"{name}.txt"
            fp.write_text(code, encoding="utf-8")
            result = healer.heal(fp)
            out.append(
                {
                    "name": name,
                    "code": code,
                    "patched_content": result.patched_content,
                    # `result.file` is the temp path — excluded (non-deterministic).
                    "changes": [
                        {
                            "line": ch.line,
                            "rule": ch.rule,
                            "before": ch.before,
                            "after": ch.after,
                            "description": ch.description,
                        }
                        for ch in result.changes
                    ],
                    "skipped": result.skipped,
                }
            )
    return out


def _reporter() -> list:
    reporter = Reporter()
    out = []
    for c in REPORTER_CASES:
        out.append(
            {
                "name": c["name"],
                "result": c["result"],
                "json": reporter.to_json(c["result"]),
                "sarif": reporter.to_sarif(c["result"]),
            }
        )
    return out


def _scaffolder() -> dict:
    return {
        "frameworks": sorted(scaffoldable_frameworks()),
        "templates": TEMPLATES,
    }


def _feedback() -> dict:
    from urllib.parse import parse_qs, urlsplit

    url_cases = []
    for c in FEEDBACK_URL_CASES:
        url = build_issue_url(c["category"], c["message"], c["context"])
        split = urlsplit(url)
        query = parse_qs(split.query, keep_blank_values=True)
        # ACCEPTED DIVERGENCE: CPython quote_plus percent-encodes `*`/`~`
        # (the body hardcodes `**Environment**`) while JS URLSearchParams leaves
        # them literal, so the RAW url bytes differ. The values are decode-
        # invariant, so we assert on the decoded title/body/labels + endpoint.
        url_cases.append(
            {
                "category": c["category"],
                "message": c["message"],
                "context": c["context"],
                "endpoint": f"{split.scheme}://{split.netloc}{split.path}",
                "title": query["title"][0],
                "body": query["body"][0],
                "labels": query["labels"][0],
            }
        )
    build_cases = []
    for c in FEEDBACK_BUILD_CASES:
        fb = build_feedback(c["message"], c["category"])
        # Only the runtime-stable parts are captured. EXCLUDED: context VALUES
        # (version — package-metadata lookup; os — platform strings; python —
        # interpreter/runtime version; install — executable-path probe) and the
        # whole issue_url, which embeds those runtime values. We assert the
        # context KEY SET/order instead.
        build_cases.append(
            {
                "category": fb["category"],
                "message": fb["message"],
                "context_keys": list(fb["context"].keys()),
            }
        )
    return {"issue_url": url_cases, "build": build_cases}


def _config_validation() -> list:
    out = []
    with tempfile.TemporaryDirectory() as tmp:
        for c in CONFIG_CASES:
            if c["content"] is None:
                path = Path(tmp) / "does-not-exist.json"
            else:
                path = Path(tmp) / f"{c['name']}.json"
                path.write_text(c["content"], encoding="utf-8")
            data, warning = read_json_with_warning(path)
            out.append(
                {
                    "name": c["name"],
                    "content": c["content"],
                    "data": data,
                    # Warning TEXT is runtime-specific; capture only its nullness.
                    "warning_is_null": warning is None,
                }
            )
    return out


def _workflow_discovery() -> dict:
    to_json_cases = []
    for c in WF_TOJSON_CASES:
        mapping = WorkflowMapping.from_dict(c["input"])
        to_json_cases.append(
            {"name": c["name"], "input": c["input"], "json": mapping.to_json()}
        )
    heuristic_cases = []
    disc = WorkflowDiscovery()
    for c in WF_HEURISTIC_CASES:
        mapping = WorkflowMapping.from_dict(c["input"])
        applied = disc._apply_heuristics(mapping)
        heuristic_cases.append(
            {"name": c["name"], "input": c["input"], "result": applied.to_json()}
        )
    return {"toJson": to_json_cases, "heuristics": heuristic_cases}


def main() -> None:
    GOLDEN.mkdir(parents=True, exist_ok=True)
    artifacts = {
        "classifier.json": _classifier(),
        "recommender.json": _recommender(),
        "quality.json": _quality(),
        "registry.json": _registry(),
        "pattern.json": _pattern(),
        "detection.json": _detection(),
        "pattern-healer.json": _pattern_healer(),
        "reporter.json": _reporter(),
        "scaffolder.json": _scaffolder(),
        "feedback.json": _feedback(),
        "config-validation.json": _config_validation(),
        "workflow-discovery.json": _workflow_discovery(),
    }
    for name, data in artifacts.items():
        (GOLDEN / name).write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        print(f"wrote {name}")


if __name__ == "__main__":
    main()
