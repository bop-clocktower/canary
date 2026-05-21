# Test Suite Specification

This document defines the test strategy, coverage requirements, and organization
for Oracle's automated test suite.

## Overview

**Goals:**

1. **Module-level unit coverage** — Every `agent/core/` and `agent/llm/` module
   has a dedicated unit test file that covers its public API, error paths, and
   edge cases using mocked dependencies.
2. **Provider-neutral CI** — Tests run without live LLM API calls; the mock
   provider (`agent/llm/providers/mock.py`) is the exclusive test-time LLM
   backend.
3. **Regression safety** — Each bug fix or new feature is accompanied by a test
   that would have caught the regression, preventing future regressions without
   requiring manual re-verification.
4. **Maintainable test organization** — Test files mirror the source module
   structure; each test file covers exactly one module.

## Success Criteria

1. **Coverage breadth:** `tests/unit/` contains one test file per `agent/core/`
   and `agent/llm/` module. No public module is left uncovered.
2. **CI green:** All tests pass with `pytest tests/unit/` and zero failures or
   errors. No test is skipped except with a documented reason.
3. **No network calls:** No test makes a real LLM API call. All provider
   interactions use the mock provider or `unittest.mock`.
4. **Test count floor:** The suite contains ≥350 tests in total (current
   baseline: 456 as of v2.1.0); additions must not reduce this count.
5. **Self-contained:** Tests run from the repo root with no additional setup
   beyond `pip install -e .[dev]`.

## Assumptions

- **Runtime:** Python >=3.10 (inherits from Oracle runtime requirement).
- **Test runner:** `pytest` (declared in `pyproject.toml` dev dependencies).
- **Isolation:** Each test uses mocking or the mock provider; no test depends
  on another test's side effects or execution order.

## Test Organization

```text
tests/
  unit/
    test_ci_env.py          — CIEnv detection logic
    test_classifier_*.py    — TestClassifier (framework hints, HTTP signals)
    test_code_extractor.py  — CodeExtractor strip logic
    test_domain_scanner.py  — DomainScanner symbol extraction
    test_executor.py        — OracleTestExecutor run/parse
    test_factory.py         — LLM provider factory selection
    test_feedback.py        — Feedback capture
    test_fixture_scanner.py — FixtureScanner named export extraction
    test_mcp_server.py      — All six MCP tools (mocked I/O)
    test_metadata_scanner.py— MetadataScanner version detection
    test_migrator.py        — HarnessMigrator dry-run and apply
    test_orchestrator.py    — OracleOrchestrator full pipeline (mocked LLM)
    test_pattern_matcher.py — PatternMatcher convention extraction
    test_providers.py       — Provider implementations (mock backend)
    test_quality_scorer.py  — QualityScorer dimension scoring and grading
    test_recommender_*.py   — FrameworkRecommender (language-aware, hints)
    test_reporter.py        — JSON/SARIF reporter output
    test_scaffolder.py      — OracleScaffolder file generation
    test_selector_healer.py — SelectorHealer prompt construction
    test_setup.py           — SetupWizard configuration wizard
    test_skill_registry.py  — SkillRegistry discovery and frontmatter parsing
  generated/                — Oracle-generated tests (gitignored)
```

## Error Handling in Tests

- Tests that verify error paths must assert the exact exception type and
  message fragment, not just that any exception is raised.
- Tests for CLI-facing errors (non-zero exit codes, error notifications) must
  mock at the process boundary, not inside Oracle internals.

## src Reference

- [tests/unit/test_executor.py](../../tests/unit/test_executor.py)
- [tests/unit/test_factory.py](../../tests/unit/test_factory.py)
- [tests/unit/test_orchestrator.py](../../tests/unit/test_orchestrator.py)
- [tests/unit/test_scaffolder.py](../../tests/unit/test_scaffolder.py)

## project Reference

Generated tests are written to `tests/generated/` (gitignored) and
promoted to `tests/` when ready to commit.
