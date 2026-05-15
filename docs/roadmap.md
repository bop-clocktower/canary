---
project: oracle
version: 1
created: 2026-05-11
updated: 2026-05-13
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

- **Status:** planned
- **Spec:** none
- **Summary:** TICKET-031 — scan project directories to understand
  available components/APIs and inject domain context into prompts.
- **Blockers:** none
- **Plan:** none

## CI/CD and Ecosystem Integration

### GitHub Action

- **Status:** planned
- **Spec:** none
- **Summary:** TICKET-032 — official Oracle GitHub Action that
  auto-generates tests for new features/bug fixes on PR.
- **Blockers:** none
- **Plan:** none

### Standardized Reporting

- **Status:** planned
- **Spec:** none
- **Summary:** TICKET-033 — export execution results to JSON/SARIF for
  Datadog, SonarQube, and similar dashboards.
- **Blockers:** none
- **Plan:** none

### Headless Optimizations

- **Status:** planned
- **Spec:** none
- **Summary:** TICKET-034 — CI-specific execution flags and
  pipeline-friendly log output.
- **Blockers:** none
- **Plan:** none

## Advanced Self-Healing

### Multi-step Debugging

- **Status:** planned
- **Spec:** none
- **Summary:** TICKET-035 — iterative debugging across multiple fix
  attempts; search local code/docs to resolve complex failures.
- **Blockers:** none
- **Plan:** none

### Visual DOM Self-Healing

- **Status:** planned
- **Spec:** none
- **Summary:** TICKET-036 — use visual snapshots or DOM trees to fix
  brittle UI selectors automatically.
- **Blockers:** none
- **Plan:** none

## Developer Experience and Onboarding

### IDE Plugins

- **Status:** backlog
- **Spec:** none
- **Summary:** VS Code and JetBrains plugins exposing Oracle
  generation/execution.
- **Blockers:** none
- **Plan:** none

### Interactive Guided Onboarding

- **Status:** backlog
- **Spec:** none
- **Summary:** First-run guided experience for installing Oracle and
  configuring providers.
- **Blockers:** none
- **Plan:** none

### Migrate harness:initialize-test-suite Repos to `oracle init`

- **Status:** planned
- **Spec:** none
- **Summary:** `oracle migrate` (or `oracle init --from-harness`) for
  test-suite repos previously scaffolded by the
  `harness:initialize-test-suite-project` skill. Steps: detect the
  harness scaffold (layer model, tags, reporter stack, custom report,
  `harness.config.json` / `.harness/` markers), map them onto Oracle's
  init layout (framework registry entry, `oracle init` outputs,
  reporter wiring), rewrite config without losing existing test
  files, and run `oracle generate --recommend-only` as a smoke check.
  Idempotent and dry-run by default; produces a Markdown migration
  report listing what was moved, what was preserved, and any manual
  follow-ups (e.g., custom reporter shims). Targets all three
  harness test-suite shapes: API, E2E/UI, and shared library.
- **Blockers:** none
- **Plan:** none
