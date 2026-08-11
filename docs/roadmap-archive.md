---
project: canary
version: 1
last_synced: 2026-06-30T01:18:39.592Z
last_manual_edit: 2026-06-30T01:18:39.592Z
---

# Roadmap

<!-- markdownlint-disable-file MD013 -->
<!-- Archive of completed roadmap features, appended by scripts/roadmap-groom.mjs
     (there is no `harness roadmap groom` — see #595). Single-line fields are a
     schema contract, so MD013 line-length does not apply. -->

## Shipped

### Public-readiness de-identification

- **Status:** done
- **Spec:** docs/changes/public-readiness-deident/proposal.md
- **Summary:** Removed employer/client identifiers from the public surface (Issue #248): renamed client-named `CompanyKnowledge` config fields to generic `dashboard_url`/`dashboard_token_env` + generic unknown-key warning across core/CLI/docs/tests, genericized a client token example, and polish (pyproject license/authors, README badge + npm-vs-PyPI note, hardcoded paths, de-id naming convention). Shipped in PR #250. The committer-email git-history scrub (blocker #2) was evaluated and **deferred as best-effort/won't-do** — the repo is public so forks/caches retain it and it needs a branch-protection lift; documented in docs/runbooks/scrub-committer-email.md. (refs: Issue #248)
- **Blockers:** —
- **Plan:** —

### Framework Registry

- **Status:** done
- **Spec:** —
- **Summary:** JSON-based framework metadata with multi-extension and execution command support.
- **Blockers:** —
- **Plan:** —

### Intelligence Pipeline

- **Status:** done
- **Spec:** —
- **Summary:** Rule-based test classifier plus engineering framework recommender.
- **Blockers:** —
- **Plan:** —

### LLM Abstraction

- **Status:** done
- **Spec:** —
- **Summary:** Provider-agnostic factory (OpenAI, Mock) with lazy loading and thread-safe singleton client.
- **Blockers:** —
- **Plan:** —

### CLI Interface

- **Status:** done
- **Spec:** —
- **Summary:** `canary generate` (with `--run`, `--json`, `--recommend-only`), `oracle run`, `canary init`, `canary version`.
- **Blockers:** —
- **Plan:** —

### Execution Feedback Loop

- **Status:** done
- **Spec:** —
- **Summary:** MVP self-healing with one retry attempt fed by execution error output.
- **Blockers:** —
- **Plan:** —

### Harness Integration

- **Status:** done
- **Spec:** —
- **Summary:** Full adoption of Bombshell engineering constraints and harness layer rules.
- **Blockers:** —
- **Plan:** —

### Oracle Init Scaffolding

- **Status:** done
- **Spec:** —
- **Summary:** TICKET-037 — `canary init` command bootstraps Playwright/Vitest/Pytest/k6 suites.
- **Blockers:** —
- **Plan:** —

### Quality Gates

- **Status:** done
- **Spec:** —
- **Summary:** Passing security scans, architectural enforcement, and mechanical validation in CI.
- **Blockers:** —
- **Plan:** —

### Classifier Registry Contract

- **Status:** done
- **Spec:** —
- **Summary:** Enforce that every classifier `test_type` resolves to a registry framework; pytest now covers `api`. Merged in PR #1.
- **Blockers:** —
- **Plan:** —

### Gemini SDK Migration

- **Status:** done
- **Spec:** —
- **Summary:** Migrate `GeminiProvider` from the deprecated `google-generativeai` package to `google.genai`. Google has ended support for `google-generativeai`; it will no longer receive updates or bug fixes. Update `pyproject.toml` to replace the dependency and adjust `agent/llm/providers/gemini.py` and its tests to use the new SDK's API surface.
- **Blockers:** —
- **Plan:** —

### Multi-Provider LLM Support

- **Status:** done
- **Spec:** —
- **Summary:** Bring Oracle's LLM provider matrix to parity with the harness toolchain. Add first-class providers for Claude (Anthropic) and Gemini (Google) alongside the existing OpenAI and Mock backends, plus a Codex provider to match the harness `codex` integration. Switch the default provider from OpenAI to Claude. Provider selection remains driven by `CANARY_LLM_PROVIDER`. This is a prerequisite for the Project Intelligence work because context-aware prompts will exceed OpenAI free-tier context windows.
- **Blockers:** —
- **Plan:** [docs/changes/multi-provider-llm/plans/2026-05-14-multi-provider-llm-plan.md](changes/multi-provider-llm/plans/2026-05-14-multi-provider-llm-plan.md)

### Metadata Scanning

- **Status:** done
- **Spec:** —
- **Summary:** TICKET-029 — detect local `package.json`, `tsconfig.json`, `requirements.txt` and align generation with project-specific library versions.
- **Blockers:** —
- **Plan:** —

### Pattern Matching

- **Status:** done
- **Spec:** —
- **Summary:** TICKET-030 — analyze existing tests and match project-specific coding styles, naming, and helpers.
- **Blockers:** —
- **Plan:** —

### Recursive Domain Knowledge

- **Status:** done
- **Spec:** —
- **Summary:** TICKET-031 — scan project directories to understand available components/APIs and inject domain context into prompts.
- **Blockers:** —
- **Plan:** —

### GitHub Action

- **Status:** done
- **Spec:** —
- **Summary:** TICKET-032 — official Oracle GitHub Action that auto-generates tests for new features/bug fixes on PR.
- **Blockers:** —
- **Plan:** —

### GitHub Action v1.0.0 Release

- **Status:** done
- **Spec:** —
- **Summary:** Tagged `v1.0.0` and floating `v1` on `main` (commit bbc8eda). First stable public release of the Oracle GitHub Action. Users can now pin `uses: bop-clocktower/canary@v1` for automatic non-breaking updates. Release notes published at [github.com/bop-clocktower/canary/releases/tag/v1.0.0](https://github.com/bop-clocktower/canary/releases/tag/v1.0.0). **Bug fix (post-release):** `CanaryOrchestrator.__init__` used `Path(__file__).resolve().parents[2]` to locate the output directory. When oracle is pip-installed (as the action does), `__file__` resolves to site-packages and the subsequent `mkdir` raises `PermissionError`, crashing `canary generate` before any JSON is emitted and leaving the PR comment with empty outputs. Fixed by switching to `Path.cwd()`.
- **Blockers:** —
- **Plan:** —

### Standardized Reporting

- **Status:** done
- **Spec:** —
- **Summary:** TICKET-033 — export execution results to JSON/SARIF for Datadog, SonarQube, and similar dashboards. `Reporter` class with `write()`, `to_json()`, `to_sarif()` methods; SARIF 2.1.0 compliant with `oracle/test-generation` and `oracle/test-execution` rule IDs; `canary generate --report-format` and `--report-file` CLI flags.
- **Blockers:** —
- **Plan:** —

### Headless Optimizations

- **Status:** done
- **Spec:** —
- **Summary:** TICKET-034 — CI environment detection (`is_ci()` across GitHub Actions, CircleCI, Travis, GitLab, Bitbucket, Jenkins, TeamCity); per-framework `ci_flags` in registry (playwright `--reporter=list`, vitest `--reporter=verbose`, pytest `--tb=short -p no:cacheprovider`); executor auto-appends flags in CI; CLI auto-enables `--json` output when CI is detected.
- **Blockers:** —
- **Plan:** —

### Multi-step Debugging

- **Status:** done
- **Spec:** —
- **Summary:** TICKET-035 — replaces MVP single-retry with configurable multi-step heal loop (default 3 attempts, `max_heal_attempts` ctor param). Each attempt runs `_search_error_context` — extracts identifiers from the error message and greps project source files for their definitions, injecting relevant snippets into the fix prompt. Result dict gains an attempts count. fixed is only True when retry actually passes. 15 orchestrator tests cover exhaustion, multi-step success, zero-attempts disable, context search caps and filtering.
- **Blockers:** —
- **Plan:** —

### Visual DOM Self-Healing

- **Status:** done
- **Spec:** —
- **Summary:** TICKET-036 — `SelectorHealer` detects selector-related UI test failures (TimeoutError, locator, getBy\*, page.click, strict mode violations, not-attached/not-visible) and routes them to a DOM-aware fix path instead of the generic symbol-grep healer. Extracts the failing selector from the error message; reads DOM context from loose HTML snapshots or snapshots/\*.html entries inside Playwright trace.zip files (truncated at 3 500 chars). Builds a selector-focused prompt that instructs the LLM to prefer data-testid and ARIA roles over brittle CSS classes. Wired into `CanaryOrchestrator`'s heal loop via `_attempt_selector_fix`. 36 new tests; 218 total passing.
- **Blockers:** —
- **Plan:** —

### Test Suite Maintenance

- **Status:** done
- **Spec:** —
- **Summary:** PR #44 — renamed TestExecutor → `CanaryTestExecutor` to eliminate PytestCollectionWarning (pytest treats any Test\* class with an `__init__` as a candidate test class). Installed missing google-genai dependency that was declared in pyproject.toml but absent from the venv, restoring 5 Gemini provider tests that had been failing silently. Result: 182/182 passing, 0 warnings.
- **Blockers:** —
- **Plan:** —

### IDE Plugins (archived)

- **Status:** done
- **Spec:** —
- **Summary:** [ARCHIVED] VS Code and JetBrains plugins were built against the Oracle POC (separate `oracle-vscode` and `oracle-intellij` repos, thin shells over the `oracle` CLI). They are not part of the Canary v1.0 product line. The original spec and plan documents are preserved under [`docs/archive/`](archive/) (`spec-ide-plugins-vscode.md`, `spec-ide-plugins-jetbrains.md`, `plan-ide-plugins-vscode.md`, `plan-ide-plugins-jetbrains.md`) for historical reference. If IDE integration is revived for Canary, it will be re-scoped from scratch under the new brand. (Oracle-era POC, not carried into Canary v1.0)
- **Blockers:** —
- **Plan:** —

### Interactive Guided Onboarding

- **Status:** done
- **Spec:** [docs/specs/onboarding.md](specs/onboarding.md)
- **Summary:** First-run guided experience for end users who install Oracle via pip. `SetupWizard` in `agent/core/setup.py`; Typer `@app.callback()` asks permission before any unconfigured command; `oracle setup` is re-runnable with `--full` for a sample generation. Config stored in `.canary/config.json` (project-local, no secrets). 12 unit tests.
- **Blockers:** —
- **Plan:** [docs/plans/onboarding.md](plans/onboarding.md)

### Test Intelligence Skills

- **Status:** done
- **Spec:** private overlay (internal proposal doc)
- **Summary:** Five bundled slash commands for suite-level analysis. `/canary-ci-ready` scores across 5 dimensions (coverage depth, flakiness with quarantine-aware acceptance, assertion quality, critical path coverage, runtime); looks up `user_catalog_skill` from `.canary/company.json` for user-catalog–aware checks. `/canary-test-pipeline` multi-phase orchestrator (Gate → Assess → Discover → Impact → Generate → Verify) with convergence loop and health report, following the `harness:docs-pipeline` pattern. `/canary-critical-areas` risk-ranks areas via git churn + harness graph + business-critical flags; writes optional `critical-areas.json` for downstream skills. `/canary-edge-cases` surfaces 6 edge-case categories with `--level sdet|junior|manual` depth scaling. `/canary-failure-impact` traces downstream severity (Critical/High/Medium/Low) with billing/auth/compliance domain boosts. (PR #205)
- **Blockers:** —
- **Plan:** —

### MCP analyze_file Output Contract

- **Status:** done
- **Spec:** —
- **Summary:** Tightened `oracle__analyze_file` to match what the keyless agents' instructions claim they receive. `framework` is detected from project config files (walking to the `.git` boundary) with a new `framework_source` field (`config`/`suffix`/`unknown`); `existing_tests` is now actually populated; new `file_functions` returns file-local defs. Fixed a `project_root` bug that broke discovery for nested files. (PR #146; Issue: findings F1/F3 from the host-LLM verification report (PR #145))
- **Blockers:** —
- **Plan:** —

### Scaffolding Guardrails

- **Status:** done
- **Spec:** —
- **Summary:** Two prompt-layer guardrails for the scaffolding agents. #140 — agents must not scaffold env-guard wrapper scripts; hard-vs-soft CI gating belongs in workflow `needs:` topology, not workspace code. #141 — scaffolding reports separate brief-inherited decisions from autonomous ones (the latter flagged "please verify"). Applied to `canary-test-author`, `canary-initializer`, `canary-test-generator`. (PR #150; Issue: [#140](https://github.com/bop-clocktower/canary/issues/140), [#141](https://github.com/bop-clocktower/canary/issues/141) (both closed))
- **Blockers:** —
- **Plan:** —

### Voice Profiles and Project Voice Config

- **Status:** done
- **Spec:** —
- **Summary:** Markdown-only voice subsystem under `voice/`. Reusable named profiles (`profiles/clocktower.md` ships first), a verified canon quote pool (`quotes/birds-of-prey.md`, shipped empty with strict primary-source citation rules), house aphorisms, and a shared `discovery.md` protocol. Prose-generating agents look up a project voice config and apply the resolved profile to authored prose only — never test code. No engine changes; discovery/resolution is agent behavior reading shipped files. (PR #151; Issue: [#142](https://github.com/bop-clocktower/canary/issues/142), [#144](https://github.com/bop-clocktower/canary/issues/144) (both closed))
- **Blockers:** —
- **Plan:** —

### Framework Picker — Stage 1: Expand to 16 Categories

- **Status:** done
- **Spec:** —
- **Summary:** Expanded both picker layers to 16 test categories. The 12 additions: `accessibility` (axe-core), `security` (OWASP ZAP), `visual` (BackstopJS), `contract` (Pact), `chaos` (Chaos Toolkit), `synthetic_data` (Faker; SDV pending OC-002), `observability` (OpenTelemetry), `mobile` (Maestro), `load` (Locust), `mutation` (Stryker), `static_analysis` (Semgrep), `integration` (Testcontainers). - **Agent layer** (`canary-framework-advisor.md`): recommendation map extended with one row per category. - **`classifier.py`**: `_CATEGORY_KEYWORDS` block + `_FRAMEWORK_HINTS` entries; existing `e2e_ui`/`api`/`frontend_unit`/`performance` rules unchanged (`load test` still routes to performance). - **`registry.json`**: 12 new entries (`status: supported`). - **`recommender.py`**: `recommend()` now returns a ranked ≤3 candidate list with `confidence`; callers read `result[0]`. Fixed a latent `result['reasoning']` KeyError in the `--recommend-only` path. Locked the classifier↔registry contract in tests: every test_type resolves to a framework. (PRs #152 (foundation) + #153 (ranked recommender); Issue: [#128](https://github.com/bop-clocktower/canary/issues/128) (closed))
- **Blockers:** —
- **Plan:** —

### Framework Picker — Stage 2: Observability Routing

- **Status:** done
- **Spec:** —
- **Summary:** Reporting-sink routing branch in `FrameworkRecommender` for `test_type == "observability"`, implementing the OC-001 decision: ReportPortal is the always-on OSS default sink; a downstream aggregation dashboard is an opt-in _additional_ sink, surfaced and ranked first when `CANARY_SCOPE=<overlay-id>` is set. OpenTelemetry (Stage 1 registry entry) is included as the instrumentation framework. Sink candidates carry `kind: reporting-sink`, OTel `kind: instrumentation`. Routing branch only — no classifier or registry-schema change. (PR #159; Issue: [#129](https://github.com/bop-clocktower/canary/issues/129) (closed))
- **Blockers:** —
- **Plan:** —

### Framework Picker — Stage 3: Enterprise License Awareness

- **Status:** done
- **Spec:** —
- **Summary:** OSS-first license gate in `FrameworkRecommender`. Commercial registry entries carry `license` + `license_gate`: Tricentis Tosca (e2e_ui) and NeoLoad (performance) gated on `CANARY_LICENSE_TRICENTIS`; LambdaTest (e2e_ui) gated on `CANARY_SCOPE`. `_license_allowed()` strips gated entries unless the signal is set, before ranking; OSS entries always pass so the category's OSS default always remains. Commercial entries are `status: commercial`, so even when unlocked they rank below the OSS option — Oracle works within a license but never proactively routes to paid. The `synthetic_data` path was finalized separately when OC-002 resolved: SDV is `status: preferred` with a surfaced BSL review warning, Faker the MIT fallback (PR #155). (PR #160 (license gate) + PR #155 (synthetic_data); Issue: [#130](https://github.com/bop-clocktower/canary/issues/130) (closed))
- **Blockers:** —
- **Plan:** —

### Spike: Schemathesis API Fuzzing

- **Status:** done
- **Spec:** —
- **Summary:** Spike run against `POST /v1/checkout` (from `examples/pytest-api-checkout`). Schemathesis v4.21.0 generated 36 test cases in 1.08s and found 3 unique failures — 2 missed by the hand-written suite: a `qty=false` coercion bug (boolean accepted as integer, processed as qty=0) and a schema/implementation mismatch (400 response undocumented, `minItems` not enforced in schema). Decision: **adopt**. Schemathesis added to `registry.json` under `api` category (MIT license, no API key required). Full findings in `spike/schemathesis/SPIKE_REPORT.md`. (PR #194 (spike adopted); Issue: [#131](https://github.com/bop-clocktower/canary/issues/131))
- **Blockers:** —
- **Plan:** —

### Spike: SDV Synthetic Data (OC-002)

- **Status:** done
- **Spec:** —
- **Summary:** [SUPERSEDED] The spike's goal was to feed the OC-002 license decision that gated the `synthetic_data` registry entry. OC-002 was resolved (Issue #126 closed) and SDV was added to `registry.json` as `status: preferred` with a BSL warning and Faker as the MIT fallback, all in PR #155. No further work needed. (spike never ran as a standalone deliverable; OC-002 resolved via team decision and SDV shipped directly in Stage 3 (PR #155).; Issue: [#132](https://github.com/bop-clocktower/canary/issues/132))
- **Blockers:** —
- **Plan:** —

### Rename oracle → canary

- **Status:** done
- **Spec:** —
- **Summary:** Renamed the tool from Oracle to Canary. Package is `canary-test-ai`; CLI entry point is `canary`; MCP server is `FastMCP("canary")` with tool names `canary__*`; all agent/command/skill files use `canary-*` names. Voice files (Clocktower profile, Birds of Prey quotes, house aphorisms) are **unchanged** — the Clocktower/Barbara Gordon persona is intentional and does not depend on the tool name. (Issue: none)
- **Blockers:** —
- **Plan:** —

### Decide whether to pull Oracle into Harness directly

- **Status:** done
- **Spec:** —
- **Summary:** [DECIDED] **Oracle and Harness stay complementary, not merged.** Rather than a big-bang integration, each Oracle skill will be evaluated against the Harness catalog one at a time; skills that fill genuine gaps get folded in, skills Harness already covers well stay where they are. Rationale: Harness is strong at code quality, architecture enforcement, and unit-level testing; Oracle's edge is integration tests, E2E, API contract tests, and cross-service flows — exactly where the team's testing lives. This decision unblocks the keyless CLI companions work below. (2026-05-28 team meeting)
- **Blockers:** —
- **Plan:** —

### `canary upgrade` and `--version` flag

- **Status:** done
- **Spec:** —
- **Summary:** `canary --version` / `canary -V` added via Typer callback (works alongside the existing `canary version` subcommand). `canary upgrade` upgrades to the latest published version using pipx (preferred) with a pip fallback for non-pipx installs. (PR #204)
- **Blockers:** —
- **Plan:** —

### WebdriverIO migrate support

- **Status:** done
- **Spec:** —
- **Summary:** `wdio.conf.ts/.js/.mjs` config file probes (shape: `mobile`), `wdio` package.json script pattern, and a full Scaffolder entry generating `wdio.conf.ts` (local runner, Mocha, spec reporter) and `tests/` directory. (PR #202)
- **Blockers:** —
- **Plan:** —

### Add keyless CLI companions for static-analysis-only operations

- **Status:** done
- **Spec:** —
- **Summary:** Shipped three deterministic CLI commands (no LLM, no API key): `canary review-test PATH --static` (file:line findings across 8 quality dimensions — brittle selectors, hardcoded sleeps, missing assertions, randomness, timestamps, missing awaits, magic numbers); `canary flake-check PATH` (flakiness-only subset, exits 1 in CI if patterns found); `canary heal-test PATH --pattern` (auto-fixes sleep→TODO comment, waitForTimeout→TODO comment, missing await; brittle selectors flagged but not auto-fixed without DOM context). All three support `--json`. 35 unit tests. New modules: `agent/core/static_linter.py`, `agent/core/pattern_healer.py`. (PR #190)
- **Blockers:** —
- **Plan:** —

### Migrate all LLM-dependent tasks to keyless slash commands

- **Status:** done
- **Spec:** specs/host-llm-migration.md
- **Summary:** All four phases shipped (Issue #127, closed 2026-05-26): every LLM-dependent task moved into keyless Claude Code slash commands so no provider API key (`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`GEMINI_API_KEY`) is needed. Phase 1 generation (ADR 0001), Phase 2 self-heal (ADR 0002), Phase 3 CLI + Action deprecation (ADR 0003), Phase 4 keyed-path removal at v5.0.0 (ADR 0004). `/canary-write-test` is the canonical keyless replacement for `canary generate`; the deterministic pieces are exposed via the MCP server. Full detail in the linked specs/plans/ADRs.
- **Blockers:** —
- **Plan:** plans/host-llm-migration.md, plans/self-heal-migration.md, plans/cli-deprecation.md

### Decide fate of the generate skill + auto-generation Action

- **Status:** done
- **Spec:** —
- **Summary:** [DECIDED] The `canary generate` command and the GitHub Action that invokes it on every PR (see "GitHub Action v1.0.0 Release" above) together require an LLM provider API key and auto-produce test code on each pull request. Decision: move the underlying capability to slash commands that use the host Claude Code session (option 5 — not in the original list, adopted from "Migrate all LLM-dependent tasks" above). `/canary-write-test` already ships and covers the generation use case keylessly. The GitHub Action and `canary generate` CLI will be deprecated and removed in a future major version per the phasing plan in that item. Any downstream overlay's `action.yml` deletion is correct and does not need to be reversed. (refs: option 5 — keyless slash commands; Issue #127)
- **Blockers:** —
- **Plan:** —

### Multi-Provider Config

- **Status:** done
- **Spec:** —
- **Summary:** [DROPPED — won’t-do] Would have added `oracle config set/show provider` to switch the active LLM provider. Dropped: it builds out the keyed `agent/llm/*` provider surface that the keyless migration (#127) moved away from and that ADR 0004 plans to delete at v3.0. Building a provider-switching CLI would invest in the surface being removed. If a keyed provider path is retained at v3.0, this can be reopened and re-scoped. (Issue #133, closed 2026-05-26)
- **Blockers:** —
- **Plan:** —

### `canary migrate` Improvements

- **Status:** done
- **Spec:** —
- **Summary:** Three improvements shipped together: (1) **Extended framework detection** — added jest, cypress, vitest.config.mts, locust, backstopjs, stryker, pact, axe-core config file probes; package.json `scripts.test` scan; requirements.txt / requirements-dev.txt / pyproject.toml dependency scan. (2) **Richer dry-run output** — `MigrationContext` and `MigrationReport` now carry `detection_source` and `detection_confidence` (`config` / `content` / `language`); dry-run markdown shows what triggered detection, confidence level, and an "Already Present" section for files that won't be touched. (3) **New config shapes** — `accessibility`, `visual`, `contract`, `mutation`, `load`, `synthetic_data`, `integration` now detected and mapped. 33 new tests (61 total). (PR #192; Issue: [#134](https://github.com/bop-clocktower/canary/issues/134))
- **Blockers:** —
- **Plan:** —

### Test Quality Scoring

- **Status:** done
- **Spec:** —
- **Summary:** `QualityScorer` in `agent/core/quality_scorer.py` — static analysis scorer running automatically after every generation. Three dimensions: coverage breadth (test count, error/negative path keywords, parametrize bonus), assertion density (framework-aware assertion patterns per test function), and flakiness risk (deductions for hardcoded waits, `random.*`, timestamp-dependent assertions). Returns a 0–100 composite score with letter grade (A–F). Surfaced in CLI text output, `--json`, GitHub Action PR comment table row, and SARIF `properties`. 30 unit tests; all frameworks covered (pytest, playwright, vitest, k6).
- **Blockers:** —
- **Plan:** —

### Onboarding `--full` Polish

- **Status:** done
- **Spec:** —
- **Summary:** [DROPPED — won’t-do] Dropped — `oracle setup --full` and the SetupWizard were removed in v2.2.0 (#113). Oracle now runs exclusively as a Claude Code plugin; no first-run setup flow exists to polish.
- **Blockers:** —
- **Plan:** —

### Migrate harness:initialize-test-suite Repos to `canary init`

- **Status:** done
- **Spec:** —
- **Summary:** PR #48 — `canary migrate` command for repos scaffolded by `harness:initialize-test-suite-project`. `HarnessMigrator` detects `harness.config.json` + `.harness/` markers and auto-detects the framework from config files (`playwright.config.ts`, `vitest.config.ts`, `pytest.ini`, `pyproject.toml [tool.pytest.ini_options]`, `k6.config.js`) with `harness.config.json` language-field fallback. Dry-run by default (`--apply` to write). Idempotent. Preserves all existing test files. `--framework` override, `--json` output. `MigrationReport.to_markdown()` reports created/skipped/preserved files and manual follow-ups. 30 unit tests; 248 total passing.
- **Blockers:** —
- **Plan:** —

### Skill Discovery and pipx Distribution

- **Status:** done
- **Spec:** [docs/specs/skill-discovery.md](specs/skill-discovery.md)
- **Summary:** Downstream overlay repositories can extend Oracle with zero application code — just `.canary/skills/<name>/SKILL.md` directories. `SkillRegistry` discovers bundled skills (flat `oracle:*.md` slash commands + nested harness `claude-code/<name>/SKILL.md`) and local overlays, walking from CWD up to the git root. Local skills override bundled skills of the same name. `oracle skills list [--verbose]` surfaces all discoverable skills. Package renamed to `canary-test-ai` (v0.2.0); `pipx install git+...@v0.2.0` is the documented install path. 17 new tests; 294 total passing. (PR: #81)
- **Blockers:** —
- **Plan:** —

### Oracle Claude Code Plugin

- **Status:** done
- **Spec:** [docs/specs/oracle-plugin.md](specs/oracle-plugin.md)
- **Summary:** Oracle as a Claude Code plugin: FastMCP server (`agent/mcp_server.py`) exposing six tools (`oracle__analyze_file`, `oracle__write_test_file`, `oracle__run_tests`, `oracle__init_suite`, `oracle__list_frameworks`, `oracle__migrate`), three slash-command skills (`/canary:generate`, `/canary:init`, `/canary:migrate`), and three agent definitions. Plugin manifest at `.claude-plugin/plugin.json`. 12 unit tests, CI schema validation via `validate-plugin.yml`. Existing CLI and GitHub Action unchanged. (PR: #78)
- **Blockers:** —
- **Plan:** [docs/plans/oracle-plugin.md](plans/oracle-plugin.md)

### Generic test reporter

- **Status:** done
- **Spec:** docs/superpowers/specs/2026-07-13-canary-test-reporter-design.md
- **Summary:** DONE — shipped as the bundled executable skill `canary-test-reporter` at `agents/skills/claude-code/canary-test-reporter/`. Reads a Playwright JSON results file and emits a Markdown report (stdout or file via `--markdown-out`) and/or a JSON artifact (`--json-out`). Classifies all tests as passed/failed/flaky/skipped. Exits non-zero on any real failure; flakes do not affect exit code. Self-contained (bundles its own full-fidelity parser). Fully de-id'd. ~39 dedicated tests. JSON contract (`version: 1`) designed for future TCM integration. (refs: docs/superpowers/specs/2026-07-13-canary-test-reporter-design.md)
- **Blockers:** —
- **Plan:** docs/superpowers/plans/2026-07-13-canary-test-reporter.md

### Fail-fast CI gate

- **Status:** done
- **Spec:** docs/changes/canary-fail-fast/proposal.md
- **Summary:** DONE — shipped as the bundled executable skill `canary-fail-fast` at `agents/skills/claude-code/canary-fail-fast/`. Audits Playwright's own fail-fast config knobs (maxFailures, forbidOnly, retries — Playwright's field names, not Canary symbols) and emits a categorized CI failure digest with GitHub `::error` annotations (non-zero exit on real failures; flakes excluded). Self-contained: bundles its own minimal Playwright JSON parser + failure categorizer (decoupled from the overlay's shared parser). Fully de-id'd (a test greps for residual client strings). 34 dedicated tests. [Note: Playwright field names intentionally left unbackticked so the drift-tracking row does not itself register as drift.] (refs: docs/changes/canary-fail-fast/)
- **Blockers:** —
- **Plan:** docs/changes/canary-fail-fast/plans/2026-07-02-canary-fail-fast-plan.md

### OTel instrumentation bootstrap

- **Status:** done
- **Spec:** docs/changes/canary-instrument/proposal.md
- **Summary:** DONE — shipped as the bundled executable skill `canary-instrument` at `agents/skills/claude-code/canary-instrument/`. Instruments a Playwright run with OpenTelemetry and emits a `run.json` v1 artifact correlating each test to the outbound HTTP requests it made, via OTel span parent/child relationships — no manual bookkeeping in test code. Trace-only v1 (Playwright/Node only; a coverage block and a canary_run_id field were scoped out, YAGNI — never implemented, so neither exists in code today); contract left additive-safe for future pytest/k6/node producers. Default file-based span export needs no OTel collector; opt-in OTLP via the existing `otel_exporter_endpoint` company-knowledge field. Fully de-id'd (dedicated test scans `.py/.md/.mjs/.ts`). 23 dedicated tests. Last item in the "Overlay Upstreaming" milestone — all three items now shipped. [Note: the cut field names above are intentionally left unbackticked so the drift-tracking row does not itself register as drift.] (refs: docs/changes/canary-instrument/, docs/knowledge/decisions/0006-otel-test-side-tracing.md, PR #265)
- **Blockers:** —
- **Plan:** docs/changes/canary-instrument/plans/2026-07-15-canary-instrument-plan.md

### no-silent-abstention

- **Status:** done
- **Spec:** docs/changes/no-silent-abstention/proposal.md
- **Summary:** No Silent Abstention doctrine (#508): every gate reports its denominator; zero-verified is a loud, distinct outcome (exit 3 = abstained, reserved CLI-wide). Engine `gate-result.ts` helper for ts commands + npm scripts, convention + table-driven conformance suite (the canonical gate registry) for self-contained skill CLIs. Gates exit 3; advisory commands warn loudly with `abstained: true` but exit 0. Five waves, each shippable. WAVE 1 SHIPPED in v6.4.0 (PR #518): `ts/src/core/gate-result.ts`, the conformance registry, the #503 `FreshnessReport` retrofit, and the #504 dry-run abstention half. WAVE 2 SHIPPED in v6.4.0 (PR #526): guardian `pr-check` / `harden-gate` exit 3, `analyze` / `validate-coverage` warn. WAVE 3 (PR #529): doctor denominator + exit 3 + D7 summary, `overlay lint` zero-skill abstention, the npm registry, and the `npm package` CI job that had never existed. WAVE 4a (PR #530): `review-test` / `flake-check` exit 3 on zero collected files; `analyze` and `history` abstain on zero RUNS (not zero rows) via a new `countRuns()` probe; `history summary`'s fabricated `0.0%` fixed; `heal-test` / `skills run` audited and pinned unchanged. WAVE 4b (PR #531): blackhawk / savant / katana abstain, `--strict` inherits exit 3, skill-layer registry. WAVE 5: `guardian.yml` handles exit 3 distinctly from exit 1, `continue-on-error` steps annotate, ADRs 0009/0010, the AGENTS.md doctrine + new-gate checklist, and the CHANGELOG "Gates that got louder" table with the v6.4.0 surfaces backfilled. Conformance registries: engine 13 rows, npm 3, skill 6. Workflow-template version bumps were N/A — no skill declares `install_workflows`. (refs: docs/changes/no-silent-abstention/plans/)
- **Blockers:** —
- **Plan:** docs/changes/no-silent-abstention/plans/

### canary-pr-guardian

- **Status:** done
- **Spec:** docs/changes/canary-pr-guardian/proposal.md
- **Summary:** DONE (#312) — shipped as the PR test-guardian: a deterministic Tier-0 diff-coverage engine (`agent/guardian/pr_check.py` + `coverage.py`, CLI `canary guardian pr-check`) that posts fidelity-labeled findings (coverage-verified › graph-verified › heuristic) with no agent/secret/write-token, plus a PR surface (`.github/workflows/guardian.yml` + sticky comment), a pre-commit hook (`hooks/guardian_precommit.py`), an at-desk agent orchestrator (`agent/guardian/agent_tier.py` + `agents/skills/claude-code/canary-pr-guardian/` + `/canary-pr-guardian`), and harness-check emit (`agent/guardian/analysis_emit.py`, `--emit-analysis`). Gate defaults to soft; promote to hard per-repo once trust is earned. Capability boundary (SC-11): the Tier-0 engine imports no agent/LLM. Phases 1–6 all shipped. (refs: docs/changes/canary-pr-guardian/, docs/knowledge/decisions/0007-guardian-agent-capability-boundary.md, docs/knowledge/decisions/0008-guardian-canary-owned.md, docs/guides/pr-guardian.md)
- **Blockers:** —
- **Plan:** docs/changes/canary-pr-guardian/plans/

### Cobertura XML coverage parser for guardian

- **Status:** done
- **Spec:** —
- **Summary:** DONE — `_parse_cobertura` added to agent/guardian/coverage.py (dispatched from `resolve_from_report` on `.xml`), broadening the coverage-verified tier to Cobertura `coverage.xml` and thus Java/.NET/JS- Istanbul pipelines that previously fell through to graph/heuristic. Pinned to the canonical line-level shape (`<class filename><line number hits>`) emitted by coverage.py/Istanbul/SimpleCov/Jacoco→Cobertura converters; branch/ condition data intentionally deferred (downstream index is line-hits). Windows `\` paths normalized so .NET/coverlet reports resolve. Non-Cobertura XML is rejected (returns None → falls through) rather than guessed at, honoring the absence-never-blocks contract. Security (adversarially reviewed): stdlib ElementTree kept (Tier-0 no-deps posture preserved — no defusedxml) with a full-text (not windowed) guard rejecting DOCTYPE `<!ENTITY>` declarations + oversize input, `(OSError, UnicodeDecodeError)`→None on the read path, and ParseError→None on malformed input; legit SYSTEM DOCTYPEs still parse. 11 new TDD tests (43 in test_guardian_coverage). Original ideation: top pick (score 6.00) from docs/ideation/deepen-core-test-intelligence-2026-07-19.md. (refs: agent/guardian/coverage.py; docs/guides/pr-guardian.md fidelity table)
- **Blockers:** —
- **Plan:** —

### Framework-registry depth audit + capability tiers

- **Status:** done
- **Summary:** DONE (adversarially reviewed) — a new `FrameworkRegistry.capabilities` method derives an honest per-framework support level from CODE signals, never the subjective status/maturity prose. `scaffold` = a scaffolder template exists (scaffoldable_frameworks). `execute` = a command the executor can actually RUN — since the executor substitutes only `{file}`, this requires `{file}` present OR no placeholder (suite runner); a stray `{target}` (zap, semgrep) that would reach the shell unsubstituted is NOT counted, so the tier never overpromises. Headline `tier`: full (scaffold+execute) / executable / catalog. Case-insensitive. Audit of the 27 (not 21) advertised frameworks: 5 full, 16 executable, 6 catalog (zap/semgrep demoted to catalog for the broken placeholder). Static analysis deliberately excluded as a tier signal — the linter's scans are largely framework-agnostic, not a per-framework differentiator (avoids re-creating the hand-maintained matrix the roadmap warned against). Exposed via summaries() → `canary frameworks` (tier column) + MCP list_frameworks. Adopter-hits-a-stub fixed across ALL callers: scaffold() degrades loudly (status=unsupported + guidance + run command) for a known-no- template framework; `canary init`/MCP surface it; `canary migrate` records a manual follow-up instead of a false "Migration complete" (review caught this silent-success regression); unknown frameworks still raise. Anti-drift: test_framework_capability_tiers.py derives tiers from code and fails on orphan templates, un-tierable entries, or a scaffoldable-but-unrunnable quadrant. ~19 new tests, full suite green. Ideation pick (score 6.00) from docs/ideation/deepen-core-test-intelligence-2026-07-19.md. (refs: agent/core/framework_registry.py, scaffolder.py, migrator.py; docs/guides/framework-registry.md capability-tiers section)
- **Spec:** —
- **Blockers:** —
- **Plan:** —

### Coverage-json producer contract doc + validator

- **Status:** done
- **Spec:** docs/specs/coverage-json-contract.md
- **Summary:** DONE — documented the coverage-json format agent/guardian/coverage.py consumes as a frozen v1 contract (docs/specs/coverage-json-contract.md, mirroring the api-delta-contract style) so third-party tools can emit canary-consumable coverage. Shape review first surfaced the warts and froze them deliberately: `line_hits` is authoritative (only it expresses hits=0 = instrumented-but-unhit), `covered_lines` documented as a shorthand for hits>=1, optional `schema_version` (absent ⇒ 1 so today's producers stay valid; additive-safe, unknown keys ignored). Added `validate_coverage_json()` in coverage.py (co-located with the parser so they can't drift) + `canary guardian validate-coverage <file>` — LOUD where the parser is silent, two-tier: error = parser drops it (coverage lost, exit 1) vs warning = sub-part ignored (degraded, exit 0 / 1 under --strict); missing/non-JSON exits 2. A binding test asserts the validator's verdict matches what the parser actually does. 26 new tests, full suite green. Ideation pick (score 6.00) from docs/ideation/deepen-core-test-intelligence-2026-07-19.md. (refs: agent/guardian/coverage.py, agent/guardian/cli.py; docs/guides/pr-guardian.md formats note)
- **Blockers:** —
- **Plan:** —

### Guardian hard-gate rollout automation

- **Status:** done
- **Spec:** —
- **Summary:** DONE (adversarially reviewed) — `canary guardian harden-gate` automates the admin step the operator guide said the guardian couldn't do: registering the guardian status check (`guardian` job, `--check` overridable) as a REQUIRED check in branch protection, which is what makes a `gate: hard` finding block the merge button. Dry-run by default (shows plan + manual steps); `--apply` PATCHes branch protection MERGING into existing rules (never clobbers), or PUTs minimal protection if none exists. Fail-loud per #294/#295: no admin scope / unsupported plan / missing token → prints a manual playbook (Settings URL + ready-to-paste `gh api`) and exits non-zero, never a silent no-op. Structure mirrors pr_comment (BranchProtection Protocol + FakeBranchProtectionClient + urllib RestBranchProtectionClient), so the pure planner (plan_hard_gate) and apply path are fully network-free-testable. Adversarial review caught two CRITICALs, both fixed: (1) a 404 on the required_status_checks sub-resource is ambiguous (unprotected vs protected-without-checks) — collapsing both to create/PUT would have WIPED existing reviews/enforce_admins/restrictions, so apply now disambiguates via the parent /protection endpoint and only PUT-creates when genuinely unprotected (else PATCHes the sub-resource, preserving other protection); (2) a wrong check-context registers a phantom required check that blocks EVERY merge — so apply now verifies the context against a recent commit's actually- reported check runs and refuses (listing the real ones) unless --force. Also hardened error handling (401/network/5xx/nonexistent-branch → HardGateBlocked playbook, never a traceback). Docs: guide Soft→hard section walks the command - both safety rails. 22 new tests, full suite green. (refs: agent/guardian/hard_gate.py, cli.py; docs/guides/pr-guardian.md)
- **Blockers:** —
- **Plan:** —

### Wire quality_scorer into the guardian gate

- **Status:** done
- **Spec:** —
- **Summary:** DONE (adversarially reviewed) — the guardian now emits an advisory `weak-test` finding for an added test that defines a test function but asserts nothing (the "asserts-nothing passes green" gap). New quality_scorer.is_assertion_free_test(code, framework) predicate — co-located with the assertion/test-fn patterns so it can't drift — requires BOTH a test function AND zero assertions (high precision: a snapshot/table-driven test matches an assertion pattern and is NOT flagged, per the roadmap's trust-erosion risk). pr_check.build_weak_test_findings consumes the test-path units filter_test_units already sets aside, scoring only the diff's ADDED lines. The finding is LOW/`weak-test` and NEVER gates — compute_exit_code gates only `untested-new-code`, so it's advisory by construction (advisory first, before any gate promotion). A weak-test-only diff no longer short-circuits at "nothing to verify". Config toggle canary.guardian.pr.weakTests (default true; non-blocking so on by default). Adversarial review confirmed the non-gating guarantee airtight but caught precision gaps (the roadmap's trust risk); fixed by broadening assertion patterns (chai `.should` / node `assert.equal` / `assert_*` helpers now count as asserting) and skipping a rename that adds only a signature line (no added body to judge). Residual lexical limits (per-file-blob granularity; a non-`assert`-named helper) documented in the guide; advisory-only so the escape hatch is the toggle. ~28 new tests, full suite green. Ideation pick (score 3.00) from docs/ideation/deepen-core-test-intelligence-2026-07-19.md. (refs: agent/core/quality_scorer.py, agent/guardian/pr_check.py, cli.py; docs/guides/pr-guardian.md)
- **Blockers:** —
- **Plan:** —

### canary-katana — deleted-test quarantine

- **Status:** done
- **Spec:** —
- **Summary:** DONE (#381) — shipped as agents/skills/claude-code/canary-katana/ (SKILL.md + Tier-0 scripts diffscan/ledger/alarm/cli, 66 unit tests). Silent-by-default: records every deleted/skipped test to an append-only, deduped provenance ledger and alarms only on last-coverage loss of a critical-area symbol; degrades to recording-only (never fails, even under --strict) when critical-area data is absent. Original ideation: rank 1 (score 6.75) from docs/ideation/bop-themed-canary-skills-2026-07-21.md. Capture every deleted or skipped test with provenance (who, when, what it covered) instead of letting it vanish silently, and alarm when a deletion drops the LAST coverage on a critical-area symbol. Test deletion is an untracked coverage-regression vector. Accepted risk to handle in spec: most deletions are legitimate (dead feature removal, genuine dedup), so alarming on every one becomes nag fatigue and a muted gate is worse than no gate - ship silent-by-default, firing only on last-coverage-of-critical-area. Deterministic/Tier-0 (git diff + coverage set math, no LLM). Low effort / high confidence. Next: /harness:brainstorming to spec.
- **Blockers:** —
- **Plan:** —

### canary-savant — test order-dependence and isolation detector

- **Status:** done
- **Spec:** docs/changes/canary-savant/proposal.md
- **Summary:** DONE (PRs #405-#408 + Phase 5) — shipped as the FIRST JS/Node skill (agents/skills/claude-code/canary-savant/, cli.mjs, requires node>=20), establishing the agents/skills vitest test harness + `Skills (JS)` CI job that future JS skills reuse (canary mirrors harness, which is Node/TS; see the js/ts-going-forward decision). Ideation rank 2 (score 6.75). Two tiers: Tier 1 static suspect scan (SV001-SV004, always-on, advisory) and Tier 2 opt-in dynamic confirmer (`--confirm`) that runs baseline -> shuffle-under-pinned-seed -> classify, then for pytest isolates each victim and BISECTS the prefix to name the polluter (not just the victim), with a reproduce command. pytest + vitest classify; polluter bisect is pytest-only (vitest lacks CLI-driven ordered per-test execution). Dogfooded advisory on canary's own suite in CI; rule tuning cut the backlog 37 -> 6 (SV002 narrowed to class/all-scoped setup, SV004 ordinals must be terminal). Remaining: flip the advisory gate to `--strict` once the 6 suspects are triaged. (refs: docs/changes/canary-savant/proposal.md; the Python Phase-1 #405 was superseded by the JS port #406.)
- **Blockers:** —
- **Plan:** —

### canary-blackhawk — temporal-dependency linter

- **Status:** done
- **Spec:** —
- **Summary:** DONE (#381) — shipped as agents/skills/claude-code/canary-blackhawk/ (SKILL.md + Tier-0 scripts rules/scanner/cli). Original ideation: rank 3 (score 6.75) from docs/ideation/bop-themed-canary-skills-2026-07-21.md. Statically flag tests depending on wall-clock, timezone, or DST - the ones that pass all day and fail at midnight, across a DST boundary, or on a leap day. Accepted risk to handle in spec: frozen-clock idioms differ per framework (vi.useFakeTimers, freezegun, jest.setSystemTime), so a naive AST rule false-positives on tests that already handle time correctly - condition the rule on the detected framework via agent/frameworks/registry.json rather than applying it universally. Deterministic/Tier-0. Low effort / high confidence. Next: /harness:brainstorming to spec.
- **Blockers:** —
- **Plan:** —

### Coverage gate — raise branch coverage before the floor bites

- **Status:** done
- **Assignee:** <brianna.stevenski@example.com>
- **Spec:** —
- **Summary:** Branch coverage had 0.48pt of headroom against its 85 floor, where lines/statements/functions each had 4–5pt, so one PR adding a handful of uncovered branches tripped a gate its author never touched. Fixed the stated way — raise the coverage, not lower the floor: 106 tests across the history/analyze report renderers, the company-knowledge show/init ladders, the skills run refusal ladder, the overlay registry's malformed-shape degradations, and the production defaultMainDeps seams took branches 85.48% → 88.51%. Floors then ratcheted to lines 95 / statements 94 / functions 96 / branches 87, each ~1–1.5pt under measured. Split out of #385 (closed obsolete — its subject was the retired Python engine).
- **Blockers:** —
- **Plan:** —
- **Priority:** P0
- **External-ID:** github:bop-clocktower/canary#481

### Entropy scan — fix the entry-point model, then ratchet the gate

- **Status:** done
- **Assignee:** <brianna.stevenski@example.com>
- **Spec:** —
- **Summary:** The Harness Cleanup (Entropy Scan) step in harness-quality.yml never ran its analysis: it failed at startup with "Could not resolve entry points" under continue-on-error, so the step went orange, the job went green, and the failure was never a finding. Identical on the pinned @harness-engineering/cli@9 and @10.1.0 — not a version regression, dark the whole time. Moving the key to `entropy.entryPoints` made it execute, and the value there was wrong too, which was worse because it produced a number instead of an error: the only declared entry point was `ts/bin/canary.js`, and `bin`/`dist` are both in the analyzer's DEFAULT_SKIP_DIRS, so the reachability walk started from an empty root set and reported 175 of 175 non-test source files dead. Every previously recorded figure (718, 603, 770) was measuring that abstention. Corrected count is 330, ratcheted by scripts/entropy-ratchet.mjs against a 340 baseline with continue-on-error removed and a missing count exiting 3 rather than passing. 16 provably-dead exports unexported; 5 test-only ts/src modules deliberately kept and recorded in the ADR. Shipped in #637.
- **Blockers:** —
- **Plan:** —
- **Priority:** P0
- **External-ID:** github:bop-clocktower/canary#544

### review-test LINT-006 matches test() inside string literals

- **Status:** done
- **Spec:** —
- **Summary:** Issue #590. LINT-006 ("this test contains no assertions") matches `test(` and `it(` occurrences inside string literals, template literals, and comments, so a file whose tests all assert is reported as assertion-free. Consumer-facing and directly damaging: a test-quality tool that lies about test quality undercuts the claim the product is sold on, and the false finding lands in the surface a new user judges canary by first. The fix already exists in-repo twice — canary-savant carries a string-literal guard and canary-blackhawk had the same bug ported back to it in #499 — so this is applying a known guard to a third detector rather than inventing one. Same false-positive class as #493 and #496. Shipped in #632 as a shared string-literals module that blanks literals, template literals, and comments before matching, rather than a fourth hand-rolled guard; it surfaced #633, where the same detector reports the line number one too low for any test not starting on line 1.
- **Blockers:** —
- **Plan:** —
- **Priority:** P1
- **External-ID:** github:bop-clocktower/canary#590
