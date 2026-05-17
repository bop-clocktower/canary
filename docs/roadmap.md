---
project: oracle
version: 1
created: 2026-05-11
updated: 2026-05-17
---

# Roadmap

## Completed

### Framework Registry

- **Status:** done
- **Spec:** none
- **Summary:** JSON-based framework metadata with multi-extension and
  execution command support.
- **Blockers:** none
- **Plan:** none

### Intelligence Pipeline

- **Status:** done
- **Spec:** none
- **Summary:** Rule-based test classifier plus engineering framework
  recommender.
- **Blockers:** none
- **Plan:** none

### LLM Abstraction

- **Status:** done
- **Spec:** none
- **Summary:** Provider-agnostic factory (OpenAI, Mock) with lazy loading
  and thread-safe singleton client.
- **Blockers:** none
- **Plan:** none

### CLI Interface

- **Status:** done
- **Spec:** none
- **Summary:** `oracle generate` (with `--run`, `--json`,
  `--recommend-only`), `oracle run`, `oracle init`, `oracle version`.
- **Blockers:** none
- **Plan:** none

### Execution Feedback Loop

- **Status:** done
- **Spec:** none
- **Summary:** MVP self-healing with one retry attempt fed by execution
  error output.
- **Blockers:** none
- **Plan:** none

### Harness Integration

- **Status:** done
- **Spec:** none
- **Summary:** Full adoption of Bombshell engineering constraints and
  harness layer rules.
- **Blockers:** none
- **Plan:** none

### Oracle Init Scaffolding

- **Status:** done
- **Spec:** none
- **Summary:** TICKET-037 — `oracle init` command bootstraps
  Playwright/Vitest/Pytest/k6 suites.
- **Blockers:** none
- **Plan:** none

### Quality Gates

- **Status:** done
- **Spec:** none
- **Summary:** Passing security scans, architectural enforcement, and
  mechanical validation in CI.
- **Blockers:** none
- **Plan:** none

### Classifier Registry Contract

- **Status:** done
- **Spec:** none
- **Summary:** Enforce that every classifier `test_type` resolves to a
  registry framework; pytest now covers `api`. Merged in PR #1.
- **Blockers:** none
- **Plan:** none

## Provider Platform

### Gemini SDK Migration

- **Status:** done
- **Spec:** none
- **Summary:** Migrate `GeminiProvider` from the deprecated
  `google-generativeai` package to `google.genai`. Google has ended
  support for `google-generativeai`; it will no longer receive updates
  or bug fixes. Update `pyproject.toml` to replace the dependency and
  adjust `agent/llm/providers/gemini.py` and its tests to use the new
  SDK's API surface.
- **Blockers:** none
- **Plan:** none

### Multi-Provider LLM Support

- **Status:** done
- **Spec:** none
- **Summary:** Bring Oracle's LLM provider matrix to parity with the
  harness toolchain. Add first-class providers for Claude (Anthropic)
  and Gemini (Google) alongside the existing OpenAI and Mock backends,
  plus a Codex provider to match the harness `codex` integration.
  Switch the default provider from OpenAI to Claude. Provider selection
  remains driven by `ORACLE_LLM_PROVIDER`. This is a prerequisite for
  the Project Intelligence work because context-aware prompts will
  exceed OpenAI free-tier context windows.
- **Blockers:** none
- **Plan:** none

## Project Intelligence

### Metadata Scanning

- **Status:** done
- **Spec:** none
- **Summary:** TICKET-029 — detect local `package.json`, `tsconfig.json`,
  `requirements.txt` and align generation with project-specific library
  versions.
- **Blockers:** none
- **Plan:** none

### Pattern Matching

- **Status:** done
- **Spec:** none
- **Summary:** TICKET-030 — analyze existing tests and match
  project-specific coding styles, naming, and helpers.
- **Blockers:** none
- **Plan:** none

### Recursive Domain Knowledge

- **Status:** done
- **Spec:** none
- **Summary:** TICKET-031 — scan project directories to understand
  available components/APIs and inject domain context into prompts.
- **Blockers:** none
- **Plan:** none

## CI/CD and Ecosystem Integration

### GitHub Action

- **Status:** done
- **Spec:** none
- **Summary:** TICKET-032 — official Oracle GitHub Action that
  auto-generates tests for new features/bug fixes on PR.
- **Blockers:** none
- **Plan:** none

### Standardized Reporting

- **Status:** done
- **Spec:** none
- **Summary:** TICKET-033 — export execution results to JSON/SARIF for
  Datadog, SonarQube, and similar dashboards. `Reporter` class with
  `write()`, `to_json()`, `to_sarif()` methods; SARIF 2.1.0 compliant
  with `oracle/test-generation` and `oracle/test-execution` rule IDs;
  `oracle generate --report-format` and `--report-file` CLI flags.
- **Blockers:** none
- **Plan:** none

### Headless Optimizations

- **Status:** done
- **Spec:** none
- **Summary:** TICKET-034 — CI environment detection (`is_ci()` across
  GitHub Actions, CircleCI, Travis, GitLab, Bitbucket, Jenkins,
  TeamCity); per-framework `ci_flags` in registry (playwright
  `--reporter=list`, vitest `--reporter=verbose`, pytest
  `--tb=short -p no:cacheprovider`); executor auto-appends flags in CI;
  CLI auto-enables `--json` output when CI is detected.
- **Blockers:** none
- **Plan:** none

## Advanced Self-Healing

### Multi-step Debugging

- **Status:** done
- **Spec:** none
- **Summary:** TICKET-035 — replaces MVP single-retry with configurable
  multi-step heal loop (default 3 attempts, `max_heal_attempts` ctor
  param). Each attempt runs `_search_error_context()` — extracts
  identifiers from the error message and greps project source files for
  their definitions, injecting relevant snippets into the fix prompt.
  Result dict gains `attempts` count. `fixed` only True when retry
  actually passes. 15 orchestrator tests cover exhaustion, multi-step
  success, zero-attempts disable, context search caps and filtering.
- **Blockers:** none
- **Plan:** none

### Visual DOM Self-Healing

- **Status:** done
- **Spec:** none
- **Summary:** TICKET-036 — `SelectorHealer` detects selector-related UI
  test failures (`TimeoutError`, `locator()`, `getBy*`, `page.click`, strict
  mode violations, not-attached/not-visible) and routes them to a DOM-aware
  fix path instead of the generic symbol-grep healer. Extracts the failing
  selector from the error message; reads DOM context from loose HTML snapshots
  or `snapshots/*.html` entries inside Playwright `trace.zip` files (truncated
  at 3 500 chars). Builds a selector-focused prompt that instructs the LLM to
  prefer `data-testid` and ARIA roles over brittle CSS classes. Wired into
  `OracleOrchestrator`'s heal loop via `_attempt_selector_fix()`. 36 new
  tests; 218 total passing.
- **Blockers:** none
- **Plan:** none

## Developer Experience and Onboarding

### Test Suite Maintenance

- **Status:** done
- **Spec:** none
- **Summary:** PR #44 — renamed `TestExecutor` → `OracleTestExecutor` to
  eliminate `PytestCollectionWarning` (pytest treats any `Test*` class with
  `__init__` as a candidate test class). Installed missing `google-genai`
  dependency that was declared in `pyproject.toml` but absent from the venv,
  restoring 5 Gemini provider tests that had been failing silently. Result:
  182/182 passing, 0 warnings.
- **Blockers:** none
- **Plan:** none

### IDE Plugins

- **Status:** planned
- **Spec:** [docs/specs/ide-plugins.md](specs/ide-plugins.md)
- **Summary:** VS Code and JetBrains plugins exposing Oracle
  generation/execution. Phase 1 (VS Code, TypeScript) ships first.
  Thin-shell design — plugins invoke the installed `oracle` CLI; no LLM
  code lives in the plugin. 5 commands, output channel, status bar,
  CLI resolution, and full error-handling contract specified. PR #50.
  4 planning decisions resolved (D1–D4): no default keybinding, active-editor
  workspace root for migrate, framework inference mirrors CLI probe order,
  one-time version warning via globalState. PR #62.
- **Blockers:** 1 open design decision (see below)
- **Plan:** [docs/plans/ide-plugins-vscode.md](plans/ide-plugins-vscode.md)

#### IDE Plugins — Design Decisions

Soundness review (harness-soundness-review, spec mode) surfaced these before
implementation begins. 5 of 6 resolved in spec PR #59.

| # | Issue | Status | Resolution |
|---|-------|--------|------------|
| S1-001 | [#52](https://github.com/bri-stevenski/oracle-test-ai-agent/issues/52) | **open** | Awaiting decision on component name detection scope |
| S1-002 | [#53](https://github.com/bri-stevenski/oracle-test-ai-agent/issues/53) | resolved | Batch output; streaming deferred to follow-up |
| S5-001 | [#54](https://github.com/bri-stevenski/oracle-test-ai-agent/issues/54) | resolved | Changed to `oracle version` (subcommand) |
| S5-002 | [#55](https://github.com/bri-stevenski/oracle-test-ai-agent/issues/55) | resolved | Removed `--json` from run invocation |
| S3-002 | [#56](https://github.com/bri-stevenski/oracle-test-ai-agent/issues/56) | resolved | macOS PATH limitation documented in Assumptions |
| S6-001 | [#57](https://github.com/bri-stevenski/oracle-test-ai-agent/issues/57) | resolved | `oracle.recommendOnly` moved to Out of Scope |

### Interactive Guided Onboarding

- **Status:** backlog
- **Spec:** none
- **Summary:** First-run guided experience for installing Oracle and
  configuring providers.
- **Blockers:** none
- **Plan:** none

### Migrate harness:initialize-test-suite Repos to `oracle init`

- **Status:** done
- **Spec:** none
- **Summary:** PR #48 — `oracle migrate` command for repos scaffolded by
  `harness:initialize-test-suite-project`. `HarnessMigrator` detects
  `harness.config.json` + `.harness/` markers and auto-detects the framework
  from config files (`playwright.config.ts`, `vitest.config.ts`, `pytest.ini`,
  `pyproject.toml [tool.pytest.ini_options]`, `k6.config.js`) with
  `harness.config.json` language-field fallback. Dry-run by default (`--apply`
  to write). Idempotent. Preserves all existing test files. `--framework`
  override, `--json` output. `MigrationReport.to_markdown()` reports
  created/skipped/preserved files and manual follow-ups. 30 unit tests;
  248 total passing.
- **Blockers:** none
- **Plan:** none
