---
project: oracle
version: 1
created: 2026-05-11
updated: 2026-05-26
---

# Roadmap

## Completed

### Framework Registry

- **Status:** done
- **Spec:** none
- **Summary:** JSON-based framework metadata with multi-extension and execution
  command support.
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
- **Summary:** Provider-agnostic factory (OpenAI, Mock) with lazy loading and
  thread-safe singleton client.
- **Blockers:** none
- **Plan:** none

### CLI Interface

- **Status:** done
- **Spec:** none
- **Summary:** `oracle generate` (with `--run`, `--json`, `--recommend-only`),
  `oracle run`, `oracle init`, `oracle version`.
- **Blockers:** none
- **Plan:** none

### Execution Feedback Loop

- **Status:** done
- **Spec:** none
- **Summary:** MVP self-healing with one retry attempt fed by execution error
  output.
- **Blockers:** none
- **Plan:** none

### Harness Integration

- **Status:** done
- **Spec:** none
- **Summary:** Full adoption of Bombshell engineering constraints and harness
  layer rules.
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
- **Summary:** Passing security scans, architectural enforcement, and mechanical
  validation in CI.
- **Blockers:** none
- **Plan:** none

### Classifier Registry Contract

- **Status:** done
- **Spec:** none
- **Summary:** Enforce that every classifier `test_type` resolves to a registry
  framework; pytest now covers `api`. Merged in PR #1.
- **Blockers:** none
- **Plan:** none

## Provider Platform

### Gemini SDK Migration

- **Status:** done
- **Spec:** none
- **Summary:** Migrate `GeminiProvider` from the deprecated
  `google-generativeai` package to `google.genai`. Google has ended support for
  `google-generativeai`; it will no longer receive updates or bug fixes. Update
  `pyproject.toml` to replace the dependency and adjust
  `agent/llm/providers/gemini.py` and its tests to use the new SDK's API
  surface.
- **Blockers:** none
- **Plan:** none

### Multi-Provider LLM Support

- **Status:** done
- **Spec:** none
- **Summary:** Bring Oracle's LLM provider matrix to parity with the harness
  toolchain. Add first-class providers for Claude (Anthropic) and Gemini
  (Google) alongside the existing OpenAI and Mock backends, plus a Codex
  provider to match the harness `codex` integration. Switch the default provider
  from OpenAI to Claude. Provider selection remains driven by
  `ORACLE_LLM_PROVIDER`. This is a prerequisite for the Project Intelligence
  work because context-aware prompts will exceed OpenAI free-tier context
  windows.
- **Blockers:** none
- **Plan:**
  [docs/changes/multi-provider-llm/plans/2026-05-14-multi-provider-llm-plan.md](changes/multi-provider-llm/plans/2026-05-14-multi-provider-llm-plan.md)

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
- **Summary:** TICKET-030 — analyze existing tests and match project-specific
  coding styles, naming, and helpers.
- **Blockers:** none
- **Plan:** none

### Recursive Domain Knowledge

- **Status:** done
- **Spec:** none
- **Summary:** TICKET-031 — scan project directories to understand available
  components/APIs and inject domain context into prompts.
- **Blockers:** none
- **Plan:** none

## CI/CD and Ecosystem Integration

### GitHub Action

- **Status:** done
- **Spec:** none
- **Summary:** TICKET-032 — official Oracle GitHub Action that auto-generates
  tests for new features/bug fixes on PR.
- **Blockers:** none
- **Plan:** none

### GitHub Action v1.0.0 Release

- **Status:** done
- **Spec:** none
- **Summary:** Tagged `v1.0.0` and floating `v1` on `main` (commit bbc8eda).
  First stable public release of the Oracle GitHub Action. Users can now pin
  `uses: bri-stevenski/oracle-test-ai-agent@v1` for automatic non-breaking
  updates. Release notes published at
  [github.com/bri-stevenski/oracle-test-ai-agent/releases/tag/v1.0.0](https://github.com/bri-stevenski/oracle-test-ai-agent/releases/tag/v1.0.0).
  **Bug fix (post-release):** `OracleOrchestrator.__init__` used
  `Path(__file__).resolve().parents[2]` to locate the output directory. When
  oracle is pip-installed (as the action does), `__file__` resolves to
  site-packages and the subsequent `mkdir` raises `PermissionError`, crashing
  `oracle generate` before any JSON is emitted and leaving the PR comment with
  empty outputs. Fixed by switching to `Path.cwd()`.
- **Blockers:** none
- **Plan:** none

### Standardized Reporting

- **Status:** done
- **Spec:** none
- **Summary:** TICKET-033 — export execution results to JSON/SARIF for Datadog,
  SonarQube, and similar dashboards. `Reporter` class with `write()`,
  `to_json()`, `to_sarif()` methods; SARIF 2.1.0 compliant with
  `oracle/test-generation` and `oracle/test-execution` rule IDs;
  `oracle generate --report-format` and `--report-file` CLI flags.
- **Blockers:** none
- **Plan:** none

### Headless Optimizations

- **Status:** done
- **Spec:** none
- **Summary:** TICKET-034 — CI environment detection (`is_ci()` across GitHub
  Actions, CircleCI, Travis, GitLab, Bitbucket, Jenkins, TeamCity);
  per-framework `ci_flags` in registry (playwright `--reporter=list`, vitest
  `--reporter=verbose`, pytest `--tb=short -p no:cacheprovider`); executor
  auto-appends flags in CI; CLI auto-enables `--json` output when CI is
  detected.
- **Blockers:** none
- **Plan:** none

## Advanced Self-Healing

### Multi-step Debugging

- **Status:** done
- **Spec:** none
- **Summary:** TICKET-035 — replaces MVP single-retry with configurable
  multi-step heal loop (default 3 attempts, `max_heal_attempts` ctor param).
  Each attempt runs `_search_error_context` — extracts identifiers from the
  error message and greps project source files for their definitions, injecting
  relevant snippets into the fix prompt. Result dict gains an attempts count.
  fixed is only True when retry actually passes. 15 orchestrator tests cover
  exhaustion, multi-step success, zero-attempts disable, context search caps and
  filtering.
- **Blockers:** none
- **Plan:** none

### Visual DOM Self-Healing

- **Status:** done
- **Spec:** none
- **Summary:** TICKET-036 — `SelectorHealer` detects selector-related UI test
  failures (TimeoutError, locator, getBy\*, page.click, strict mode violations,
  not-attached/not-visible) and routes them to a DOM-aware fix path instead of
  the generic symbol-grep healer. Extracts the failing selector from the error
  message; reads DOM context from loose HTML snapshots or snapshots/\*.html
  entries inside Playwright trace.zip files (truncated at 3 500 chars). Builds a
  selector-focused prompt that instructs the LLM to prefer data-testid and ARIA
  roles over brittle CSS classes. Wired into `OracleOrchestrator`'s heal loop
  via `_attempt_selector_fix`. 36 new tests; 218 total passing.
- **Blockers:** none
- **Plan:** none

## Developer Experience and Onboarding

### Test Suite Maintenance

- **Status:** done
- **Spec:** none
- **Summary:** PR #44 — renamed TestExecutor → `OracleTestExecutor` to eliminate
  PytestCollectionWarning (pytest treats any Test\* class with an `__init__` as
  a candidate test class). Installed missing google-genai dependency that was
  declared in pyproject.toml but absent from the venv, restoring 5 Gemini
  provider tests that had been failing silently. Result: 182/182 passing, 0
  warnings.
- **Blockers:** none
- **Plan:** none

### IDE Plugins

- **Status:** done
- **Spec (VS Code):** [docs/specs/ide-plugins.md](specs/ide-plugins.md)
- **Spec (JetBrains):**
  [docs/specs/ide-plugins-jetbrains.md](specs/ide-plugins-jetbrains.md)
- **Repo (VS Code):**
  [bri-stevenski/oracle-vscode](https://github.com/bri-stevenski/oracle-vscode)
- **Repo (JetBrains):**
  [bri-stevenski/oracle-intellij](https://github.com/bri-stevenski/oracle-intellij)
- **Summary:** VS Code and JetBrains plugins exposing Oracle
  generation/execution. Phase 1 (VS Code, TypeScript) complete. Thin-shell
  design — plugins invoke the installed `oracle` CLI; no LLM code lives in the
  plugin. 5 commands, output channel, status bar, CLI resolution, and full
  error-handling contract specified. PR #50. 4 planning decisions resolved
  (D1–D4): no default keybinding, active-editor workspace root for migrate,
  framework inference mirrors CLI probe order, one-time version warning via
  globalState. PR #62. All 14 plan tasks implemented in `oracle-vscode` (commits
  88b27e4–13eb769) — typecheck clean, 16/16 tests passing, CI green on `main`.
  CommonJS and proxyquire chosen for test isolation against Node 24's
  non-configurable built-in exports. JetBrains scaffold complete in
  `oracle-intellij`: Kotlin, Gradle 9.5 + IntelliJ Platform Gradle Plugin
  2.16.0, all 5 actions, tool window (ConsoleView), status bar widget, settings
  Configurable, CliRunner (GeneralCommandLine + OSProcessHandler, 120 s
  timeout), Task.Backgroundable threading, ProjectActivity startup probe; 35
  tests passing, CI green on `main`. Action tests (PR #1) extract internal
  companion object helpers (parseOutputFile, buildExtraArgs, nextWidgetState,
  prettyJson) so pure business logic can be exercised without IntelliJ Platform
  bootstrap.
- **Blockers:** none
- **Plan (JetBrains):**
  [docs/plans/ide-plugins-jetbrains.md](plans/ide-plugins-jetbrains.md)
- **Plan (VS Code):**
  [docs/plans/ide-plugins-vscode.md](plans/ide-plugins-vscode.md)

#### IDE Plugins — Design Decisions

Soundness review (harness-soundness-review, spec mode) surfaced these before
implementation begins. All 6 resolved.

| #      | Issue                                                                  | Status   | Resolution                                                     |
| ------ | ---------------------------------------------------------------------- | -------- | -------------------------------------------------------------- |
| S1-001 | [#52](https://github.com/bri-stevenski/oracle-test-ai-agent/issues/52) | resolved | Option A: filename-only pre-fill; component detection deferred |
| S1-002 | [#53](https://github.com/bri-stevenski/oracle-test-ai-agent/issues/53) | resolved | Batch output; streaming deferred to follow-up                  |
| S5-001 | [#54](https://github.com/bri-stevenski/oracle-test-ai-agent/issues/54) | resolved | Changed to `oracle version` (subcommand)                       |
| S5-002 | [#55](https://github.com/bri-stevenski/oracle-test-ai-agent/issues/55) | resolved | Removed `--json` from run invocation                           |
| S3-002 | [#56](https://github.com/bri-stevenski/oracle-test-ai-agent/issues/56) | resolved | macOS PATH limitation documented in Assumptions                |
| S6-001 | [#57](https://github.com/bri-stevenski/oracle-test-ai-agent/issues/57) | resolved | oracle.recommendOnly moved to Out of Scope                     |

### Interactive Guided Onboarding

- **Status:** done
- **Spec:** [docs/specs/onboarding.md](specs/onboarding.md)
- **Summary:** First-run guided experience for end users who install Oracle via
  pip. `SetupWizard` in `agent/core/setup.py`; Typer `@app.callback()` asks
  permission before any unconfigured command; `oracle setup` is re-runnable with
  `--full` for a sample generation. Config stored in `.oracle/config.json`
  (project-local, no secrets). 12 unit tests.
- **Blockers:** none
- **Plan:** [docs/plans/onboarding.md](plans/onboarding.md)

## Agent Quality and Voice

### MCP analyze_file Output Contract

- **Status:** done — PR #146
- **Issue:** findings F1/F3 from the host-LLM verification report (PR #145)
- **Summary:** Tightened `oracle__analyze_file` to match what the keyless
  agents' instructions claim they receive. `framework` is detected from project
  config files (walking to the `.git` boundary) with a new `framework_source`
  field (`config`/`suffix`/`unknown`); `existing_tests` is now actually
  populated; new `file_functions` returns file-local defs. Fixed a
  `project_root` bug that broke discovery for nested files.
- **Blockers:** none
- **Plan:** none

### Scaffolding Guardrails

- **Status:** done — PR #150
- **Issue:**
  [#140](https://github.com/bri-stevenski/oracle-test-ai-agent/issues/140),
  [#141](https://github.com/bri-stevenski/oracle-test-ai-agent/issues/141) (both
  closed)
- **Summary:** Two prompt-layer guardrails for the scaffolding agents. #140 —
  agents must not scaffold env-guard wrapper scripts; hard-vs-soft CI gating
  belongs in workflow `needs:` topology, not workspace code. #141 — scaffolding
  reports separate brief-inherited decisions from autonomous ones (the latter
  flagged "please verify"). Applied to `oracle-test-author`,
  `oracle-initializer`, `oracle-test-generator`.
- **Blockers:** none
- **Plan:** none

### Voice Profiles and Project Voice Config

- **Status:** done — PR #151
- **Issue:**
  [#142](https://github.com/bri-stevenski/oracle-test-ai-agent/issues/142),
  [#144](https://github.com/bri-stevenski/oracle-test-ai-agent/issues/144) (both
  closed)
- **Summary:** Markdown-only voice subsystem under `plugins/oracle/voice/`.
  Reusable named profiles (`profiles/clocktower.md` ships first), a verified
  canon quote pool (`quotes/birds-of-prey.md`, shipped empty with strict
  primary-source citation rules), house aphorisms, and a shared `discovery.md`
  protocol. Prose-generating agents look up a project voice config and apply the
  resolved profile to authored prose only — never test code. No engine changes;
  discovery/resolution is agent behavior reading shipped files.
- **Blockers:** none
- **Plan:** none

## Framework Picker

**Sequencing note (2026-05-26):** all three stages shipped. Stage 1 (PRs #152
and #153); Stage 2 (PR #159, after OC-001 settled); Stage 3 (PRs #160 and #155,
after OC-002 settled). The picker now covers 16 categories with ranked output,
observability sink routing, and an OSS-first commercial-license gate.

The picker has two layers that must stay in sync:

1. **Keyless slash-command layer (primary):** `/oracle-pick-framework`
   (`plugins/oracle/commands/oracle-pick-framework.md`) →
   `oracle-framework-advisor` agent
   (`plugins/oracle/agents/oracle-framework-advisor.md`). No API key required.
   Recommendation map covers 16 categories as of Stage 1.
2. **Rule-based CLI layer (survives v3.0):** `TestClassifier`
   (`agent/core/classifier.py`) + `FrameworkRecommender`
   (`agent/core/recommender.py`) + `agent/frameworks/registry.json`. Covers 16
   categories. Per ADR 0004 this pipeline survives the v3.0 cut — it needs no
   API key and powers the planned keyless `oracle recommend`. `recommend()`
   returns a ranked ≤3 candidate list with confidence.

Both layers expand together in Stage 1. The agent's recommendation map is the
user-facing surface; the CLI classifier/registry is kept in sync during the
transition so downstream automation that calls `--recommend-only` keeps working.

Research phase complete: 16 tool categories surveyed (May 2026). Routing rules
and enterprise-license guard-rails locked; three delivery stages defined below.
OSS-first is the default throughout — paid or vendor-locked tools surface only
when the project already holds an active license.

**Locked picker decisions (not re-opened without explicit sign-off):**

- **Tricentis (Tosca, NeoLoad, Testim):** no new adoption recommended; Oracle
  works within an active license but never proactively routes users toward these
  tools.
- **LambdaTest / KaneAI / Testμ:** org-scoped paid licenses only — do not
  surface outside the specific org deployment that holds the license.
- **OSS-first default:** every picker path prefers an OSS option unless the
  project's existing toolchain makes a paid tool the obvious fit.

### Framework Picker — Stage 1: Expand to 16 Categories

- **Status:** done — PRs #152 (foundation) + #153 (ranked recommender)
- **Issue:**
  [#128](https://github.com/bri-stevenski/oracle-test-ai-agent/issues/128)
  (closed)
- **Spec:** none
- **Summary:** Expanded both picker layers to 16 test categories. The 12
  additions: `accessibility` (axe-core), `security` (OWASP ZAP), `visual`
  (BackstopJS), `contract` (Pact), `chaos` (Chaos Toolkit), `synthetic_data`
  (Faker; SDV pending OC-002), `observability` (OpenTelemetry), `mobile`
  (Maestro), `load` (Locust), `mutation` (Stryker), `static_analysis` (Semgrep),
  `integration` (Testcontainers).
  - **Agent layer** (`oracle-framework-advisor.md`): recommendation map extended
    with one row per category.
  - **`classifier.py`**: `_CATEGORY_KEYWORDS` block + `_FRAMEWORK_HINTS`
    entries; existing `e2e_ui`/`api`/`frontend_unit`/`performance` rules
    unchanged (`load test` still routes to performance).
  - **`registry.json`**: 12 new entries (`status: supported`).
  - **`recommender.py`**: `recommend()` now returns a ranked ≤3 candidate list
    with `confidence`; callers read `result[0]`. Fixed a latent
    `result['reasoning']` KeyError in the `--recommend-only` path.

  Locked the classifier↔registry contract in tests: every test_type resolves to
  a framework.

- **Blockers:** none (was sequenced after #127, now complete).
- **Plan:** none

### Framework Picker — Stage 2: Observability Routing

- **Status:** done — PR #159
- **Issue:**
  [#129](https://github.com/bri-stevenski/oracle-test-ai-agent/issues/129)
  (closed)
- **Spec:** none
- **Summary:** Reporting-sink routing branch in `FrameworkRecommender` for
  `test_type == "observability"`, implementing the OC-001 decision: ReportPortal
  is the always-on OSS default sink; a downstream aggregation dashboard is an
  opt-in _additional_ sink, surfaced and ranked first when
  `ORACLE_SCOPE=<overlay-id>` is set. OpenTelemetry (Stage 1 registry entry) is
  included as the instrumentation framework. Sink candidates carry
  `kind: reporting-sink`, OTel `kind: instrumentation`. Routing branch only — no
  classifier or registry-schema change.
- **Blockers:** none (OC-001 settled, #125).
- **Plan:** none

### Framework Picker — Stage 3: Enterprise License Awareness

- **Status:** done — PR #160 (license gate) + PR #155 (synthetic_data)
- **Issue:**
  [#130](https://github.com/bri-stevenski/oracle-test-ai-agent/issues/130)
  (closed)
- **Spec:** none
- **Summary:** OSS-first license gate in `FrameworkRecommender`. Commercial
  registry entries carry `license` + `license_gate`: Tricentis Tosca (e2e_ui)
  and NeoLoad (performance) gated on `ORACLE_LICENSE_TRICENTIS`; LambdaTest
  (e2e_ui) gated on `ORACLE_SCOPE`. `_license_allowed()` strips gated entries
  unless the signal is set, before ranking; OSS entries always pass so the
  category's OSS default always remains. Commercial entries are
  `status: commercial`, so even when unlocked they rank below the OSS option —
  Oracle works within a license but never proactively routes to paid. The
  `synthetic_data` path was finalized separately when OC-002 resolved: SDV is
  `status: preferred` with a surfaced BSL review warning, Faker the MIT fallback
  (PR #155).
- **Blockers:** none (OC-002 settled, #126).
- **Plan:** none

### Spike: Schemathesis API Fuzzing

- **Status:** planned
- **Issue:**
  [#131](https://github.com/bri-stevenski/oracle-test-ai-agent/issues/131)
- **Spec:** none
- **Summary:** Time-boxed spike on branch `spike/schemathesis`. Run Schemathesis
  against one sample API endpoint in read-only mode; measure defects found vs.
  the existing suite. Decision gate: if the defect-find rate justifies adoption,
  add a Schemathesis registry entry under the `api` category (which
  `TestClassifier` already handles) with
  `recommended_for: ["property-based API testing", "OpenAPI fuzz testing"]` so
  it surfaces alongside pytest in Stage 1 ranked output.
- **Blockers:** none
- **Plan:** none

### Spike: SDV Synthetic Data (OC-002)

- **Status:** planned
- **Issue:**
  [#132](https://github.com/bri-stevenski/oracle-test-ai-agent/issues/132)
- **Spec:** none
- **Summary:** Time-boxed spike on branch `spike/sdv`. Generate a synthetic
  dataset matching one sample schema using SDV (Synthetic Data Vault). Verify
  output fidelity and confirm BSL license is acceptable under your org's
  procurement rules. Result feeds the OC-002 decision that gates the
  `synthetic_data` registry entry in Stage 3.
- **Blockers:** OC-002 —
  [#126](https://github.com/bri-stevenski/oracle-test-ai-agent/issues/126) — BSL
  license review required.
- **Plan:** none

## Future Work

### Decide whether to pull Oracle into Harness directly

- **Status:** decision pending — team discussion scheduled
- **Spec:** none
- **Summary:** Oracle's current shape (separate `oracle` CLI, plugin, and MCP
  server) parallels Harness's pattern (CLI for deterministic work, slash
  commands for generative work) but maintains its own install path, brand, and
  release cadence. Alternative: pull Oracle into Harness directly — its
  capabilities become `harness:test-*` skills, the `oracle` CLI becomes
  `harness test:<subcmd>`, the MCP tools either fold into Harness's MCP surface
  or get reimplemented. Cost: ~20–25% of the in-flight host-LLM migration work
  is throwaway under "pull in"; the remaining 75%+ (slash command markdown,
  agent definitions, deterministic modules) ports cleanly. Holding the v3.0 cut
  and any new keyless CLI commands (see related item below) until this decision
  lands so they don't ship in the wrong shape.
- **Blockers:** team discussion.
- **Plan:** none

### Add keyless CLI companions for static-analysis-only operations

- **Status:** planned (paused pending Harness-pull decision above)
- **Spec:** none
- **Summary:** Several slash-command agents have a static-analysis dimension
  that could ship as keyless CLI commands alongside the generative slash
  command. See the "Guiding principle" section of
  [ADR 0004](adr/0004-remove-keyed-paths-at-v3.md) for the full table.
  Candidates: `oracle review-test --static` (lint-style static checks for
  tests), `oracle flake-check` (pattern detection for known flake causes —
  `Math.random`, `setTimeout` without `waitFor`, etc.),
  `oracle heal-test --pattern` (regex-detectable fixes like selector swaps from
  trace). Aligns Oracle with Harness's shape: deterministic → CLI, generative →
  slash command. **Paused** because the "pull into Harness" decision changes
  where these commands live (`oracle` vs `harness test:`).
- **Blockers:** decision on Harness-pull.
- **Plan:** none

### Migrate all LLM-dependent tasks to keyless slash commands

- **Status:** done — Phases 1–3 shipped; Phase 4 (keyed-path removal at v3.0) is
  planned in [ADR 0004](adr/0004-remove-keyed-paths-at-v3.md) and gated on the
  Harness-pull decision. Issue #127 closed 2026-05-26 (migration complete;
  removal tracked separately).
- **Issue:**
  [#127](https://github.com/bri-stevenski/oracle-test-ai-agent/issues/127)
  (closed)
- **Phase 1 (generation, done):** spec
  [host-llm-migration.md](specs/host-llm-migration.md) · plan
  [host-llm-migration.md](plans/host-llm-migration.md) ·
  [ADR 0001](adr/0001-host-llm-generation-for-agents.md)
- **Phase 2 (self-heal, done):** spec
  [self-heal-migration.md](specs/self-heal-migration.md) · plan
  [self-heal-migration.md](plans/self-heal-migration.md) ·
  [ADR 0002](adr/0002-self-heal-as-slash-command.md)
- **Phase 3 (CLI + Action deprecation, done):** spec
  [cli-deprecation.md](specs/cli-deprecation.md) · plan
  [cli-deprecation.md](plans/cli-deprecation.md) ·
  [ADR 0003](adr/0003-deprecate-oracle-generate.md)
- **Summary:** Eliminate the API key requirement from Oracle's user-facing
  surface by moving every LLM-dependent task into Claude Code slash commands
  that use the host's session (no `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` /
  `GEMINI_API_KEY` needed). The oracle-plugin spec already commits to "no API
  key required for plugin users" — this closes the loop by deprecating the
  CLI/Action paths that still require keys. The "Decide fate of the generate
  skill" decision below is resolved in favour of this path (option 5).

  **Current keyless coverage (already shipped):**
  - `/oracle-pick-framework` → `oracle-framework-advisor` agent (Read, Glob,
    Grep — no key needed).
  - `/oracle-write-test` → `oracle-test-author` agent.
  - `/oracle-review-test` → `oracle-test-reviewer` agent.
  - `/oracle-debug-flake` → `oracle-flake-hunter` agent.

  **Still keyed (to migrate):**
  - `oracle generate` (CLI) — calls `generate_response()` → `agent/llm/*`
    provider matrix → requires a provider key.
  - GitHub Action wrapping `oracle generate` on every PR — same keyed
    dependency.
  - Orchestrator self-healing loop (`_attempt_fix`, `_attempt_selector_fix` in
    `agent/core/orchestrator.py`) — calls `generate_response()` for retry
    generation.

  **Target end state:**
  - `/oracle-write-test` (already exists) is the canonical replacement for
    `oracle generate`.
  - `/oracle-self-heal` (or equivalent) wraps the self-healing loop.
  - The MCP server (`agent/mcp_server.py`) exposes the deterministic pieces
    (analyze, write, run, init, list-frameworks, migrate) so agents can compose
    them.
  - The CLI's LLM-keyed commands are deprecated, then removed in a later major
    version. Mock provider stays as a CI fixture.
  - `agent/llm/*` providers are kept only if external automation needs them;
    otherwise removed.

  **Phasing:**
  1. Inventory every call site that uses `agent.llm` (orchestrator, CLI,
     action). Document which can move to slash commands and which need MCP tool
     wrappers instead.
  2. Ship parity slash commands under `plugins/oracle/commands/` for each
     retained capability (principally `/oracle-self-heal`).
  3. Print a deprecation warning from the keyed CLI paths pointing users at the
     slash-command equivalent.
  4. Remove the GitHub Action and `oracle generate` from a future major release;
     bump version accordingly.

- **Blockers:** none
- **Plan:** none

### Decide fate of the generate skill + auto-generation Action

- **Status:** decided — option 5 (keyless slash commands)
- **Issue:**
  [#127](https://github.com/bri-stevenski/oracle-test-ai-agent/issues/127)
- **Spec:** none
- **Summary:** The `oracle generate` command and the GitHub Action that invokes
  it on every PR (see "GitHub Action v1.0.0 Release" above) together require an
  LLM provider API key and auto-produce test code on each pull request.
  Decision: move the underlying capability to slash commands that use the host
  Claude Code session (option 5 — not in the original list, adopted from
  "Migrate all LLM-dependent tasks" above). `/oracle-write-test` already ships
  and covers the generation use case keylessly. The GitHub Action and
  `oracle generate` CLI will be deprecated and removed in a future major version
  per the phasing plan in that item. Any downstream overlay's `action.yml`
  deletion is correct and does not need to be reversed.
- **Blockers:** none
- **Plan:** none

### Multi-Provider Config

- **Status:** dropped (won't-do) — Issue #133 closed 2026-05-26
- **Issue:**
  [#133](https://github.com/bri-stevenski/oracle-test-ai-agent/issues/133)
  (closed)
- **Spec:** none
- **Summary:** Would have added `oracle config set/show provider` to switch the
  active LLM provider. Dropped: it builds out the keyed `agent/llm/*` provider
  surface that the keyless migration (#127) moved away from and that ADR 0004
  plans to delete at v3.0. Building a provider-switching CLI would invest in the
  surface being removed. If the v3.0 architecture decision retains a keyed
  provider path, this can be reopened and re-scoped.
- **Blockers:** none
- **Plan:** none

### `oracle migrate` Improvements

- **Status:** planned
- **Issue:**
  [#134](https://github.com/bri-stevenski/oracle-test-ai-agent/issues/134)
- **Spec:** none
- **Summary:** Extend the `oracle migrate` command with better framework
  detection, richer dry-run output, and support for additional harness config
  shapes. Specific improvements TBD during planning.
- **Blockers:** none
- **Plan:** none

### Test Quality Scoring

- **Status:** done
- **Spec:** none
- **Summary:** `QualityScorer` in `agent/core/quality_scorer.py` — static
  analysis scorer running automatically after every generation. Three
  dimensions: coverage breadth (test count, error/negative path keywords,
  parametrize bonus), assertion density (framework-aware assertion patterns per
  test function), and flakiness risk (deductions for hardcoded waits,
  `random.*`, timestamp-dependent assertions). Returns a 0–100 composite score
  with letter grade (A–F). Surfaced in CLI text output, `--json`, GitHub Action
  PR comment table row, and SARIF `properties`. 30 unit tests; all frameworks
  covered (pytest, playwright, vitest, k6).
- **Blockers:** none
- **Plan:** none

### Onboarding `--full` Polish

- **Status:** dropped
- **Spec:** none
- **Summary:** Dropped — `oracle setup --full` and the SetupWizard were removed
  in v2.2.0 (#113). Oracle now runs exclusively as a Claude Code plugin; no
  first-run setup flow exists to polish.
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
  created/skipped/preserved files and manual follow-ups. 30 unit tests; 248
  total passing.
- **Blockers:** none
- **Plan:** none

## Ecosystem

### Skill Discovery and pipx Distribution

- **Status:** done
- **Spec:** [docs/specs/skill-discovery.md](specs/skill-discovery.md)
- **PR:** #81
- **Summary:** Downstream overlay repositories can extend Oracle with zero
  application code — just `.oracle/skills/<name>/SKILL.md` directories.
  `SkillRegistry` discovers bundled skills (flat `oracle:*.md` slash commands +
  nested harness `claude-code/<name>/SKILL.md`) and local overlays, walking from
  CWD up to the git root. Local skills override bundled skills of the same name.
  `oracle skills list [--verbose]` surfaces all discoverable skills. Package
  renamed to `oracle-test-ai` (v0.2.0); `pipx install git+...@v0.2.0` is the
  documented install path. 17 new tests; 294 total passing.

### Oracle Claude Code Plugin

- **Status:** done
- **Spec:** [docs/specs/oracle-plugin.md](specs/oracle-plugin.md)
- **Plan:** [docs/plans/oracle-plugin.md](plans/oracle-plugin.md)
- **PR:** #78
- **Summary:** Oracle as a Claude Code plugin: FastMCP server
  (`agent/mcp_server.py`) exposing six tools (`oracle__analyze_file`,
  `oracle__write_test_file`, `oracle__run_tests`, `oracle__init_suite`,
  `oracle__list_frameworks`, `oracle__migrate`), three slash-command skills
  (`/oracle:generate`, `/oracle:init`, `/oracle:migrate`), and three agent
  definitions. Plugin manifest at `.claude-plugin/plugin.json`. 12 unit tests,
  CI schema validation via `validate-plugin.yml`. Existing CLI and GitHub Action
  unchanged.
