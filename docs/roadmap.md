---
project: oracle
version: 1
created: 2026-05-11
updated: 2026-05-21
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
- **Plan:** [docs/changes/multi-provider-llm/plans/2026-05-14-multi-provider-llm-plan.md](changes/multi-provider-llm/plans/2026-05-14-multi-provider-llm-plan.md)

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

### GitHub Action v1.0.0 Release

- **Status:** done
- **Spec:** none
- **Summary:** Tagged `v1.0.0` and floating `v1` on `main` (commit
  bbc8eda). First stable public release of the Oracle GitHub Action.
  Users can now pin `uses: bri-stevenski/oracle-test-ai-agent@v1` for
  automatic non-breaking updates. Release notes published at
  [github.com/bri-stevenski/oracle-test-ai-agent/releases/tag/v1.0.0](https://github.com/bri-stevenski/oracle-test-ai-agent/releases/tag/v1.0.0).
  **Bug fix (post-release):** `OracleOrchestrator.__init__` used
  `Path(__file__).resolve().parents[2]` to locate the output directory.
  When oracle is pip-installed (as the action does), `__file__` resolves
  to site-packages and the subsequent `mkdir` raises `PermissionError`,
  crashing `oracle generate` before any JSON is emitted and leaving the
  PR comment with empty outputs. Fixed by switching to `Path.cwd()`.
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
  param). Each attempt runs `_search_error_context` — extracts
  identifiers from the error message and greps project source files for
  their definitions, injecting relevant snippets into the fix prompt.
  Result dict gains an attempts count. fixed is only True when retry
  actually passes. 15 orchestrator tests cover exhaustion, multi-step
  success, zero-attempts disable, context search caps and filtering.
- **Blockers:** none
- **Plan:** none

### Visual DOM Self-Healing

- **Status:** done
- **Spec:** none
- **Summary:** TICKET-036 — `SelectorHealer` detects selector-related UI
  test failures (TimeoutError, locator, getBy\*, page.click, strict
  mode violations, not-attached/not-visible) and routes them to a DOM-aware
  fix path instead of the generic symbol-grep healer. Extracts the failing
  selector from the error message; reads DOM context from loose HTML snapshots
  or snapshots/\*.html entries inside Playwright trace.zip files (truncated
  at 3 500 chars). Builds a selector-focused prompt that instructs the LLM to
  prefer data-testid and ARIA roles over brittle CSS classes. Wired into
  `OracleOrchestrator`'s heal loop via `_attempt_selector_fix`. 36 new
  tests; 218 total passing.
- **Blockers:** none
- **Plan:** none

## Developer Experience and Onboarding

### Test Suite Maintenance

- **Status:** done
- **Spec:** none
- **Summary:** PR #44 — renamed TestExecutor → `OracleTestExecutor` to
  eliminate PytestCollectionWarning (pytest treats any Test\* class with
  an `__init__` as a candidate test class). Installed missing google-genai
  dependency that was declared in pyproject.toml but absent from the venv,
  restoring 5 Gemini provider tests that had been failing silently. Result:
  182/182 passing, 0 warnings.
- **Blockers:** none
- **Plan:** none

### IDE Plugins

- **Status:** done
- **Spec (VS Code):** [docs/specs/ide-plugins.md](specs/ide-plugins.md)
- **Spec (JetBrains):** [docs/specs/ide-plugins-jetbrains.md](specs/ide-plugins-jetbrains.md)
- **Repo (VS Code):** [bri-stevenski/oracle-vscode](https://github.com/bri-stevenski/oracle-vscode)
- **Repo (JetBrains):** [bri-stevenski/oracle-intellij](https://github.com/bri-stevenski/oracle-intellij)
- **Summary:** VS Code and JetBrains plugins exposing Oracle
  generation/execution. Phase 1 (VS Code, TypeScript) complete.
  Thin-shell design — plugins invoke the installed `oracle` CLI; no LLM
  code lives in the plugin. 5 commands, output channel, status bar,
  CLI resolution, and full error-handling contract specified. PR #50.
  4 planning decisions resolved (D1–D4): no default keybinding, active-editor
  workspace root for migrate, framework inference mirrors CLI probe order,
  one-time version warning via globalState. PR #62.
  All 14 plan tasks implemented in `oracle-vscode` (commits 88b27e4–13eb769)
  — typecheck clean, 16/16 tests passing, CI green on `main`. CommonJS
  and proxyquire chosen for test isolation against Node 24's non-configurable
  built-in exports. JetBrains scaffold complete in `oracle-intellij`: Kotlin,
  Gradle 9.5 + IntelliJ Platform Gradle Plugin 2.16.0, all 5 actions, tool
  window (ConsoleView), status bar widget, settings Configurable, CliRunner
  (GeneralCommandLine + OSProcessHandler, 120 s timeout),
  Task.Backgroundable threading, ProjectActivity startup probe; 35 tests
  passing, CI green on `main`. Action tests (PR #1) extract internal
  companion object helpers (parseOutputFile, buildExtraArgs, nextWidgetState,
  prettyJson) so pure business logic can be exercised without IntelliJ
  Platform bootstrap.
- **Blockers:** none
- **Plan (JetBrains):** [docs/plans/ide-plugins-jetbrains.md](plans/ide-plugins-jetbrains.md)
- **Plan (VS Code):** [docs/plans/ide-plugins-vscode.md](plans/ide-plugins-vscode.md)

#### IDE Plugins — Design Decisions

Soundness review (harness-soundness-review, spec mode) surfaced these before
implementation begins. All 6 resolved.

| # | Issue | Status | Resolution |
| --- | ----- | ------ | ---------- |
| S1-001 | [#52](https://github.com/bri-stevenski/oracle-test-ai-agent/issues/52) | resolved | Option A: filename-only pre-fill; component detection deferred |
| S1-002 | [#53](https://github.com/bri-stevenski/oracle-test-ai-agent/issues/53) | resolved | Batch output; streaming deferred to follow-up |
| S5-001 | [#54](https://github.com/bri-stevenski/oracle-test-ai-agent/issues/54) | resolved | Changed to `oracle version` (subcommand) |
| S5-002 | [#55](https://github.com/bri-stevenski/oracle-test-ai-agent/issues/55) | resolved | Removed `--json` from run invocation |
| S3-002 | [#56](https://github.com/bri-stevenski/oracle-test-ai-agent/issues/56) | resolved | macOS PATH limitation documented in Assumptions |
| S6-001 | [#57](https://github.com/bri-stevenski/oracle-test-ai-agent/issues/57) | resolved | oracle.recommendOnly moved to Out of Scope |

### Interactive Guided Onboarding

- **Status:** done
- **Spec:** [docs/specs/onboarding.md](specs/onboarding.md)
- **Summary:** First-run guided experience for end users who install Oracle
  via pip. `SetupWizard` in `agent/core/setup.py`; Typer `@app.callback()`
  asks permission before any unconfigured command; `oracle setup` is
  re-runnable with `--full` for a sample generation. Config stored in
  `.oracle/config.json` (project-local, no secrets). 12 unit tests.
- **Blockers:** none
- **Plan:** [docs/plans/onboarding.md](plans/onboarding.md)

## Framework Picker

**Sequenced after:** "Migrate all LLM-dependent tasks to keyless slash commands"
above. Framework Picker Stage 1 work does not begin until the keyless migration
is complete.

The picker has two layers that must stay in sync:

1. **Keyless slash-command layer (primary):** `/oracle-pick-framework`
   (`plugins/oracle/commands/oracle-pick-framework.md`) → `oracle-framework-advisor`
   agent (`plugins/oracle/agents/oracle-framework-advisor.md`). Already ships;
   currently covers 7 test needs. No API key required.
2. **Rule-based CLI layer (transitional):** `TestClassifier`
   (`agent/core/classifier.py`) + `FrameworkRecommender`
   (`agent/core/recommender.py`) + `agent/frameworks/registry.json`. Currently
   covers 4 test types. Feeds `oracle generate --recommend-only` during the
   deprecation period; removed with the CLI in a future major version.

Both layers expand together in Stage 1. The agent's recommendation map is the
user-facing surface; the CLI classifier/registry is kept in sync during the
transition so downstream automation that calls `--recommend-only` keeps working.

Research phase complete: 16 tool categories surveyed (May 2026). Routing rules
and enterprise-license guard-rails locked; three delivery stages defined below.
OSS-first is the default throughout — paid or vendor-locked tools surface only
when the project already holds an active license.

**Locked picker decisions (not re-opened without explicit sign-off):**

- **Tricentis (Tosca, NeoLoad, Testim):** no new adoption recommended; Oracle
  works within an active license but never proactively routes users toward
  these tools.
- **LambdaTest / KaneAI / Testμ:** Optum-scoped paid licenses only — do not
  surface for non-Optum projects.
- **OSS-first default:** every picker path prefers an OSS option unless the
  project's existing toolchain makes a paid tool the obvious fit.

### Framework Picker — Stage 1: Expand to 16 Categories

- **Status:** planned — blocked on keyless migration completing first
- **Spec:** none
- **Summary:** Expand both picker layers from their current coverage to 16
  test categories. The 12 additions are: `accessibility`, `security`,
  `visual`, `contract`, `chaos`, `synthetic_data`, `observability`, `mobile`,
  `load`, `mutation`, `static_analysis`, and `integration`.

  **Agent layer** (`oracle-framework-advisor.md`): extend the recommendation
  map table with one row per new category, following the existing format
  (need → tool → why). This is the primary change; the agent is the surface
  users actually invoke.

  **CLI layer** (kept in sync during deprecation period):
  1. **`agent/core/classifier.py`** — add keyword patterns and
     `_FRAMEWORK_HINTS` entries for the 12 new categories.
     Existing `e2e_ui`, `api`, `frontend_unit`, `performance` rules
     are unchanged.
  2. **`agent/frameworks/registry.json`** — add registry entries
     (following the existing schema: `name`, `category`, `languages`,
     `status`, `maturity`, `recommended_for`, `strengths`, `avoid_when`)
     for the OSS default tool in each new category.
  3. **`agent/core/recommender.py`** — change `recommend()` to return a
     ranked list of up to three candidates instead of a single pick,
     exposing `ClassificationResult.confidence` in the output. Existing
     single-pick callers use `result[0]`.
- **Blockers:** sequenced after keyless slash-command migration.
- **Plan:** none

### Framework Picker — Stage 2: Observability Routing

- **Status:** planned
- **Spec:** none
- **Summary:** Wire the new `observability` test type (added in Stage 1) to
  a reporting-sink routing layer inside `FrameworkRecommender`. When
  `classification.test_type == "observability"`, the recommender checks for
  a reporting target signal (env var or `.oracle/config.json` key) and routes
  to: **ReportPortal** (self-hosted OSS) or **QA Intelligence Dashboard**
  (Capillary overlay, `ORACLE_SCOPE=capillary`). No change to the classifier
  or registry schema — this is purely a `recommend()` routing branch. Exact
  scope boundary between ReportPortal and QA Intelligence Dashboard is tracked
  under **OC-001** and must be settled before the routing condition can be
  written.
- **Blockers:** OC-001 — ReportPortal vs QA Intelligence Dashboard scope
  boundary must be settled before Stage 2 routing rules can be written.
- **Plan:** none

### Framework Picker — Stage 3: Enterprise License Awareness

- **Status:** planned
- **Spec:** none
- **Summary:** Add a license-gate layer to `FrameworkRecommender.recommend()`
  that filters the ranked candidate list before it is returned. Tricentis
  entries (added to `registry.json` with `"license": "commercial"`) are
  stripped from results unless `ORACLE_LICENSE_TRICENTIS=1` is set;
  LambdaTest / KaneAI / Testμ entries are stripped unless
  `ORACLE_SCOPE=optum` is set. Without those signals the OSS fallback from
  Stage 1 is always returned — no paid tool is ever surfaced silently.
  Stage 3 also finalises the `synthetic_data` routing path: SDV (Synthetic
  Data Vault) is the preferred registry entry, but its BSL license must be
  reviewed before the entry can be merged — tracked under **OC-002**. If BSL
  is acceptable SDV becomes the `status: preferred` entry; otherwise
  Faker + factory-boy is promoted to preferred and SDV is added as
  `status: conditional` with the license gate.
- **Blockers:** OC-002 — SDV BSL license acceptability review required before
  the `synthetic_data` registry entry can be finalised.
- **Plan:** none

### Spike: Schemathesis API Fuzzing

- **Status:** planned
- **Spec:** none
- **Summary:** Time-boxed spike on branch `spike/schemathesis`. Run
  Schemathesis against one Optum API endpoint in read-only mode; measure
  defects found vs. the existing suite. Decision gate: if the defect-find
  rate justifies adoption, add a Schemathesis registry entry under the `api`
  category (which `TestClassifier` already handles) with
  `recommended_for: ["property-based API testing", "OpenAPI fuzz testing"]`
  so it surfaces alongside pytest in Stage 1 ranked output.
- **Blockers:** none
- **Plan:** none

### Spike: SDV Synthetic Data (OC-002)

- **Status:** planned
- **Spec:** none
- **Summary:** Time-boxed spike on branch `spike/sdv`. Generate a synthetic
  dataset matching one Optum schema using SDV (Synthetic Data Vault). Verify
  output fidelity and confirm BSL license is acceptable under Capillary /
  Optum procurement rules. Result feeds the OC-002 decision that gates the
  `synthetic_data` registry entry in Stage 3.
- **Blockers:** BSL license review required (OC-002).
- **Plan:** none

## Future Work

### Migrate all LLM-dependent tasks to keyless slash commands

- **Status:** next — unblocked, work begins before Framework Picker
- **Spec:** none
- **Summary:** Eliminate the API key requirement from Oracle's user-facing
  surface by moving every LLM-dependent task into Claude Code slash
  commands that use the host's session (no `ANTHROPIC_API_KEY` /
  `OPENAI_API_KEY` / `GEMINI_API_KEY` needed). The oracle-plugin spec
  already commits to "no API key required for plugin users" — this
  closes the loop by deprecating the CLI/Action paths that still
  require keys. The "Decide fate of the generate skill" decision below
  is resolved in favour of this path (option 5).

  **Current keyless coverage (already shipped):**
  - `/oracle-pick-framework` → `oracle-framework-advisor` agent (Read,
    Glob, Grep — no key needed).
  - `/oracle-write-test` → `oracle-test-author` agent.
  - `/oracle-review-test` → `oracle-test-reviewer` agent.
  - `/oracle-debug-flake` → `oracle-flake-hunter` agent.

  **Still keyed (to migrate):**
  - `oracle generate` (CLI) — calls `generate_response()` →
    `agent/llm/*` provider matrix → requires a provider key.
  - GitHub Action wrapping `oracle generate` on every PR — same
    keyed dependency.
  - Orchestrator self-healing loop (`_attempt_fix`,
    `_attempt_selector_fix` in `agent/core/orchestrator.py`) — calls
    `generate_response()` for retry generation.

  **Target end state:**
  - `/oracle-write-test` (already exists) is the canonical replacement
    for `oracle generate`.
  - `/oracle-self-heal` (or equivalent) wraps the self-healing loop.
  - The MCP server (`agent/mcp_server.py`) exposes the deterministic
    pieces (analyze, write, run, init, list-frameworks, migrate) so
    agents can compose them.
  - The CLI's LLM-keyed commands are deprecated, then removed in a
    later major version. Mock provider stays as a CI fixture.
  - `agent/llm/*` providers are kept only if external automation needs
    them; otherwise removed.

  **Phasing:**
  1. Inventory every call site that uses `agent.llm` (orchestrator,
     CLI, action). Document which can move to slash commands and
     which need MCP tool wrappers instead.
  2. Ship parity slash commands under `plugins/oracle/commands/` for
     each retained capability (principally `/oracle-self-heal`).
  3. Print a deprecation warning from the keyed CLI paths pointing
     users at the slash-command equivalent.
  4. Remove the GitHub Action and `oracle generate` from a future
     major release; bump version accordingly.
- **Blockers:** none
- **Plan:** none

### Decide fate of the generate skill + auto-generation Action

- **Status:** decided — option 5 (keyless slash commands)
- **Spec:** none
- **Summary:** The `oracle generate` command and the GitHub Action that
  invokes it on every PR (see "GitHub Action v1.0.0 Release" above)
  together require an LLM provider API key and auto-produce test code
  on each pull request. Decision: move the underlying capability to
  slash commands that use the host Claude Code session (option 5 —
  not in the original list, adopted from "Migrate all LLM-dependent
  tasks" above). `/oracle-write-test` already ships and covers the
  generation use case keylessly. The GitHub Action and `oracle generate`
  CLI will be deprecated and removed in a future major version per the
  phasing plan in that item. The Capillary overlay's `action.yml`
  deletion is correct and does not need to be reversed.
- **Blockers:** none
- **Plan:** none

### Multi-Provider Config

- **Status:** planned
- **Spec:** none
- **Summary:** Allow switching the active provider without re-running full
  setup. `oracle config set provider <name>` updates `.oracle/config.json`;
  `oracle config show` prints current config. Validates the new provider's
  env var is set before writing. Out of scope for the original onboarding
  feature (one active provider per project), now a first-class follow-on.
- **Blockers:** none
- **Plan:** none

### `oracle migrate` Improvements

- **Status:** planned
- **Spec:** none
- **Summary:** Extend the `oracle migrate` command with better framework
  detection, richer dry-run output, and support for additional harness
  config shapes. Specific improvements TBD during planning.
- **Blockers:** none
- **Plan:** none

### Test Quality Scoring

- **Status:** done
- **Spec:** none
- **Summary:** `QualityScorer` in `agent/core/quality_scorer.py` — static
  analysis scorer running automatically after every generation. Three
  dimensions: coverage breadth (test count, error/negative path keywords,
  parametrize bonus), assertion density (framework-aware assertion patterns
  per test function), and flakiness risk (deductions for hardcoded waits,
  `random.*`, timestamp-dependent assertions). Returns a 0–100 composite
  score with letter grade (A–F). Surfaced in CLI text output, `--json`,
  GitHub Action PR comment table row, and SARIF `properties`. 30 unit
  tests; all frameworks covered (pytest, playwright, vitest, k6).
- **Blockers:** none
- **Plan:** none

### Onboarding `--full` Polish

- **Status:** dropped
- **Spec:** none
- **Summary:** Dropped — `oracle setup --full` and the SetupWizard were
  removed in v2.2.0 (#113). Oracle now runs exclusively as a Claude Code
  plugin; no first-run setup flow exists to polish.
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
  CI schema validation via `validate-plugin.yml`. Existing CLI and GitHub
  Action unchanged.
