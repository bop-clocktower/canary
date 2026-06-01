# Oracle Specification

Oracle is an AI-powered test automation agent that transforms natural-language
requirements into framework-aware, runnable test code.

## Overview

**Goals:**

1. **NL-to-test generation** — Accept a natural-language requirement and produce
   a syntactically correct, runnable test file targeting the appropriate framework
   and language detected from the project.
2. **Multi-provider LLM support** — Operate with any of the supported LLM
   backends (Anthropic, OpenAI, Gemini, Codex) interchangeably, selected via
   environment variable with no code changes.
3. **Self-healing selectors** — Detect Playwright selector failures in test output
   and automatically issue heal prompts, up to a configurable maximum, without
   user intervention.
4. **Quality-gated output** — Score every generated file on coverage breadth,
   assertion density, and flakiness risk; surface the score in CLI output,
   `--json`, PR comments, and SARIF.
5. **CI/CD integration** — Ship as a reusable GitHub Actions composite action
   that generates tests for changed files on every pull request and posts results
   as a PR comment with a commit CTA.

## Non-goals

- Oracle does not execute tests in production environments.
- Oracle does not manage or migrate test frameworks (migration is a separate
  `canary migrate` command, scoped to harness-scaffolded projects only).
- Oracle does not provide a GUI — all interaction is via CLI or GitHub Actions.

## Success Criteria

1. **Generation completes:** Given a natural-language prompt, `canary generate`
   produces a non-empty test file in `tests/generated/` with exit code 0.
2. **Quality floor:** Every generated file achieves a composite quality score
   ≥70 (grade B) using the formula
   `score = round(0.4×coverage + 0.4×assertion + 0.2×flakiness)`.
3. **Self-heal cap:** The orchestrator retries failing Playwright selectors at
   most 3 times (`_MAX_HEAL_ATTEMPTS = 3`) before surfacing the failure.
4. **Provider parity:** All four first-class providers (Anthropic, OpenAI,
   Gemini, Codex) return a parseable, code-only response when given the same
   generation prompt. The mock provider returns a deterministic stub in CI.
5. **Machine-readable output:** `canary generate --json` returns a JSON object
   containing `file_path`, `framework`, `test_type`, `quality_score`, and
   `provider`.
6. **GitHub Actions smoke:** The composite action (`action.yml`) completes
   without error on a pull request where at least one source file has changed
   and a valid `api-key` input is supplied.

## Assumptions

- **Runtime:** Python >=3.10 (declared in `pyproject.toml`; matches f-string,
  match-statement, and type-union syntax used across source modules).
- **Supported providers:** Anthropic (Claude), OpenAI (GPT), Google Gemini,
  OpenAI Codex — selected via `ORACLE_LLM_PROVIDER` env var. Mock provider is
  used in CI only and is not a production target.
- **Single-process execution:** Oracle runs as a single Python process; no
  worker threads or subprocess pools are used for generation.
- **Filesystem access:** Oracle reads and writes to the local filesystem.
  Network access is limited to LLM API calls.

## Technical Design

### Generation Pipeline

The `OracleOrchestrator.run()` method executes these steps in order:

1. **Metadata scan** — Read `package.json`, `pyproject.toml`, etc. for exact
   dependency versions to inject into the generation prompt.
2. **Classify** — `TestClassifier` maps the prompt to a `test_type`
   (e.g., `e2e`, `unit`, `api`).
3. **Recommend** — `FrameworkRecommender` selects the best framework for the
   detected `test_type` and project metadata.
4. **Pattern scan** — `PatternMatcher` extracts naming conventions and import
   styles from existing test files.
5. **Domain scan** — `DomainScanner` extracts component names and API routes
   from source files to prevent the LLM from inventing symbol names.
6. **Fixture scan** — `FixtureScanner` extracts named exports from test helpers.
7. **Build prompt** — Assembles all context into the LLM generation prompt.
8. **Generate** — LLM call via `agent.llm.generate_response()`; raw response
   stripped of Markdown fences by `CodeExtractor`.
9. **Write file** — Test file written to `tests/generated/`.
10. **Quality score** — `QualityScorer.score()` runs static analysis and
    returns a `QualityScore` dataclass.

### Self-Healing Loop

After step 9, if `execute=True` and the test fails with a `TimeoutError` or
`locator()` failure, `SelectorHealer` builds a DOM-aware heal prompt and
re-generates. This loop runs at most `_MAX_HEAL_ATTEMPTS` (3) times.

### Quality Scoring

Composite score formula:
`round(0.4 × coverage_breadth + 0.4 × assertion_density + 0.2 × flakiness_risk)`

| Score | Grade |
| ----- | ----- |
| ≥85   | A     |
| ≥70   | B     |
| ≥55   | C     |
| ≥40   | D     |
| <40   | F     |

### Error Handling

| Failure | Behavior |
| ------- | -------- |
| No framework matches `test_type` | `ValueError` raised; CLI exits non-zero with message |
| LLM returns unparseable response | `CodeExtractor` returns empty string; orchestrator raises `RuntimeError` |
| Selector heal exhausted | Failure surfaced to user after `_MAX_HEAL_ATTEMPTS` attempts |
| Missing API key | Provider factory raises `EnvironmentError`; setup wizard offered |

## src Reference

- [agent/cli.py](../../agent/cli.py)
- [agent/core/orchestrator.py](../../agent/core/orchestrator.py)
- [agent/core/classifier.py](../../agent/core/classifier.py)
- [agent/core/scaffolder.py](../../agent/core/scaffolder.py)
- [agent/core/executor.py](../../agent/core/executor.py)
- [agent/core/recommender.py](../../agent/core/recommender.py)
- [agent/core/framework_registry.py](../../agent/core/framework_registry.py)
- [agent/llm/client.py](../../agent/llm/client.py)
- [agent/llm/factory.py](../../agent/llm/factory.py)
