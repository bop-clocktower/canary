<!-- markdownlint-disable MD024 -->

# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This changelog starts at **v4.0.0**. Earlier releases (v1.0.0–v3.0.0, published
under the project's former name) are documented in the
[GitHub Releases](https://github.com/bop-clocktower/canary/releases) history.

## [Unreleased]

## [5.11.0] - 2026-07-19

> This entry consolidates user-facing changes since the last changelog entry
> (5.7.0). Interim tags 5.8–5.10 were published without changelog entries; the
> `canary-instrument` skill below shipped in that window and is recorded here
> for continuity.

### Added

- **`canary-pr-guardian`** — A PR test-coverage guardian. A deterministic Tier-0
  diff-coverage engine (`canary guardian pr-check`) posts fidelity-labeled
  findings (coverage-verified › graph-verified › heuristic) with no agent,
  secret, or write token. Ships a GitHub Actions workflow with a sticky PR
  comment, a pre-commit hook, an at-desk agent orchestrator
  (`/canary-pr-guardian`), and harness-check analysis emit (`--emit-analysis`).
  The gate defaults to **soft** (advisory); promote to hard per-repo once trust
  is earned. The Tier-0 engine imports no agent/LLM by construction.
- **`canary-init` and `canary-migrate` slash commands** — first-run entry points
  so a brand-new user can initialize or migrate a project without knowing an
  agent by name.
- **`canary-company-knowledge` skill** — bootstraps `.canary/company.json`,
  scaffolding and prompting for the non-inferable org-specific fields.
- **`canary-fleet-health` skill** — compact fleet-wide flake/health summary,
  distinct from single-test diagnosis.
- **`canary-instrument` skill** — Upstreamed the OTel test-instrumentation
  capability to `agents/skills/claude-code/canary-instrument`. Instruments a
  Playwright run with OpenTelemetry and emits a `run.json` v1 artifact
  correlating each test to the outbound HTTP requests it made, via OTel span
  parent/child relationships. Trace-only in this v1; default file-based span
  export needs no OTel collector.

### Changed

- **Fail-loud on uncertain auto-detection** — `canary migrate` framework
  detection and `canary doctor --persona` now surface uncertainty instead of
  silently doing less than expected.
- **Quality-gate hooks now block** — `quality-warner` and `telemetry-reporter`
  no longer unconditionally `exit 0`; a hook that cannot fail is no safety net.
- **Config validation** — malformed `harness.config.json` / `.mcp.json` now warn
  loudly instead of silently falling back to defaults.
- **Classifier confidence** — scores are documented as heuristic priors, not
  calibrated probabilities, so CI users don't over-trust them.
- **Architecture thresholds** — `maxFanOut` / dependency-depth thresholds set
  just above the measured baseline as a regression ratchet.

### Fixed

- History store now fails closed on unparseable Supabase connection URLs.
- npm engine-check validates JSON shape before trusting a registry version.
- Numerous `canary-pr-guardian` robustness fixes (atomic analysis writes,
  git-absent ref resolution, degrade-on-error, per-unit coverage fidelity,
  bounded graph-coverage BFS depth).
- Skill/agent routing and discoverability: backfilled YAML frontmatter for
  headless `SKILL.md` files; canonicalized the three "write a test" paths.

### Security

- Redact-on-parse-failure leak: the history-store redaction path now fails
  closed rather than risk leaking credentials into logs/output.
- Added a JSON shape guard before `JSON.parse` in `npm/src/engine-checks.ts`.

## [5.7.0] - 2026-07-13

Bundled fail-fast CI gate capability, Sentinel scope optimization, PyPI Trusted
Publishing integration, and MCP selection hook.

### Added

- **`canary-fail-fast` skill** — Upstreamed the fail-fast CI gate capability to
  a bundled skill in `agents/skills/claude-code/canary-fail-fast`. It audits
  Playwright configs for `maxFailures`, `forbidOnly`, and `retries`, parses test
  run results, outputs structured digests with GitHub Actions error annotations,
  and fails the build on test failures.
- **First-party MCP hook** — Added a `prefer-first-party-mcp` hook to nudge the
  LLM to use first-party MCP tools (harness, canary) over third-party
  alternatives.
- **PyPI Trusted Publishing** — Configured automated Python packaging and
  publication to PyPI on new tags using keyless OIDC Trusted Publishing.

### Changed

- **Sentinel scope optimization** — Restricted prompt-injection scanning in
  Sentinel to untrusted external sources (WebFetch, WebSearch, third-party
  MCPs). Local tools (Write, Edit, Bash, first-party MCPs) are exempted,
  preventing false-positive injection errors on codebase edits.
- Refactored workspace hooks to split the quality-gate checks and harden
  repository config protection.

### Documentation & Maintenance

- Added a `mise` install section to the README.
- Roadmap updates to mark the fail-fast CI gate complete and reclassify the
  api-signature doc-drift check.

## [5.6.0] - 2026-07-01

Public-readiness de-identification, plus linter tooling.

### Changed

- **`company.json` scalar config fields renamed** to generic names —
  `dashboard_url` and `dashboard_token_env` (previously client-prefixed). A
  config using the old keys no longer populates the dashboard fields; update it
  to the new names. `otel_exporter_endpoint` is unchanged.

### Added

- Unknown-key warning in the `company.json` loader: any unrecognized key emits
  `ignored unknown field: <key>`, so stale configs self-diagnose.
- MIT `license` and `authors` metadata in `pyproject.toml`.

### Tooling

- Adopted `ruff` as the Python linter (`[tool.ruff]` config); removed dead
  imports and unused variables it surfaced.

## [5.4.0] - 2026-06-22

A content and tooling release — no change to the shipped CLI binary's behavior.

### Added

- **Real-world function examples** — a new `examples/realworld-functions/`
  catalog of pure-function, domain-logic scenarios (you start from a function
  signature and let Canary design the coverage). Seven examples across Pytest
  and Vitest: LEGO-collection reconciliation, price normalizer,
  subscription-expiry checker, access-policy (RBAC) evaluator, interval merger,
  semver comparison, and a marginal tax-bracket calculator (#228, #229, #232).
- **Brand refresh ("The Cry")** — new `cry-mark` icon set (gold / dark / outline
  / favicon), a self-contained `docs/branding/brand-system.html` page,
  verdict-colored Slack announcement banners, and three new "flock" voice
  profiles: Black Canary, Huntress, and Batgirl (#233).

### Changed

- **Version-consistency guard** — `tests/unit/test_version_consistency.py`
  asserts all four version declarations (`npm/package.json`, `pyproject.toml`,
  `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`) agree and are
  semver-shaped, so a future release bump that forgets a file fails CI. The
  four-file bump requirement is documented in `AGENTS.md` (#234).
- Spec-craft and naming-craft quality fixes across specs and identifiers (#225,
  #227), and refreshed GitHub issue templates (#230).

### Fixed

- **Plugin manifest version drift** — `.claude-plugin/plugin.json` and the
  `canary` entry in `marketplace.json` sat at `4.0.0` through the entire 5.x
  line (manual release bumps only touched `package.json` + `pyproject.toml`);
  both are now synced (#234).
- **Release `latest`-tag advancement** — the floating `latest` tag is moved by
  `release.yml` directly, instead of a separate release-triggered workflow that
  could miss (#231).

### Removed

- Deleted the legacy `docs/specs/oracle.md` (v1/v2 spec, fully superseded by the
  current specs) (#226).

## [5.3.0] - 2026-06-21

### Fixed

- **npm install on 5.2.0** — GitHub release asset CDN now redirects through
  `release-assets.githubusercontent.com`; added to the trusted-host allowlist so
  `volta install canary-test-cli` succeeds again.

## [5.2.0] - 2026-06-21

### Security

- **npm install redirect host pinning** — binary download now validates every
  HTTP redirect against an allowlist (`github.com`,
  `objects.githubusercontent.com`). Redirects to any other host are rejected
  immediately, preventing a man-in-the-middle from substituting a malicious
  binary during `volta install canary-test-cli`.

## [5.1.0] - 2026-06-21

### Added

- `volta install canary-test-cli` — self-contained native binary distribution
  via npm. No Python required. Binaries built for linux-x64, darwin-arm64,
  win32-x64.

## [5.0.0] - 2026-06-07

> **Breaking change.** The `canary generate`, `canary feedback`, and the GitHub
> Action have been removed. See the migration guide below.

### Migration guide

| Removed surface                                  | Replacement                                                     |
| ------------------------------------------------ | --------------------------------------------------------------- |
| `canary generate "<prompt>"`                     | `/canary-write-test` in Claude Code (no API key)                |
| `canary generate "<prompt>" --recommend-only`    | `canary recommend "<prompt>"`                                   |
| `canary feedback`                                | no replacement — feedback loop is built into the slash commands |
| GitHub Action (`uses: bop-clocktower/canary@vN`) | `/canary-write-test` in Claude Code                             |

Pin to `@v4` or earlier to keep the old action while you migrate. The action
file at this version is a hard-error shim that exits 1 with a migration message.

### Added

- **Test Intelligence Skills** — five new bundled slash commands for suite-level
  analysis (PR #205):
  - **`/canary-ci-ready`** — scores a suite across 5 dimensions: coverage depth,
    flakiness (quarantined tests with linked open issues count as verified),
    assertion quality, critical path coverage, and suite runtime. Looks up a
    `user_catalog_skill` from `.canary/company.json` for user-catalog–aware
    auth-flow checks; absent → constructive degradation message.
  - **`/canary-test-pipeline`** — multi-phase orchestrator (Gate → Assess →
    Discover → Impact → Generate → Verify) that loops until the suite is
    CI-ready or the user stops. Emits a health report on exit. Follows the
    `harness:docs-pipeline` convergence pattern.
  - **`/canary-critical-areas`** — risk-ranked area list using git churn,
    downstream dependents (harness graph → static import fallback), and
    business-critical flags. Writes an optional `critical-areas.json` artifact
    consumed by the other analysis skills.
  - **`/canary-edge-cases`** — surfaces edge cases across 6 categories (boundary
    values, race conditions, locale/timezone, partial network, unexpected input
    shapes, accessibility). Output depth scales with
    `--level sdet|junior|manual`; focuses on critical areas when
    `critical-areas.json` is present.
  - **`/canary-failure-impact`** — traces downstream effects of a test,
    function, or code path failing undetected. Domain heuristics boost severity
    for billing/auth/compliance paths. Produces a Critical/High/Medium/Low label
    with an affected-dependency list and suggested next action.
- **`canary --version` / `canary -V`** — conventional version flag via Typer
  callback, alongside the existing `canary version` subcommand (PR #204).
- **`canary upgrade`** — upgrades to the latest published version using pipx
  (preferred), with a pip fallback for non-pipx installs (PR #204).
- **WebdriverIO (`wdio`) migrate support** — `wdio.conf.ts/.js/.mjs` config
  probe, `wdio` package.json script pattern, and a `wdio.conf.ts` + `tests/`
  scaffold (PR #202).
- **`action.yml` hard-error shim** — consumers who pin `@v5` receive a
  `::error::` message with migration instructions and exit 1, rather than
  "action not found".

### Changed

- `.py` skill CLIs now run under canary's own venv interpreter
  (`sys.executable`) instead of the system Python resolved by their shebang —
  skills that depend on venv packages (e.g. `openpyxl`) no longer require manual
  injection (PR #203).

### Fixed

- Added `openpyxl>=3.1` to `[project.dependencies]` so xlsx-import skills work
  out of the box (PR #203).

### Removed

- **`canary generate`** — deprecated in v4.1.0; removed. Use
  `/canary-write-test`.
- **`canary feedback`** — deprecated in v4.1.0; removed.
- **`agent/llm/`** — entire LLM provider matrix (`anthropic`, `openai`,
  `gemini`, `codex`, `mock`). No callers remain after the orchestrator was
  removed.
- **`agent/core/orchestrator.py`** — `CanaryOrchestrator` and all private
  helpers.
- **`agent/core/selector_healer.py`**, **`agent/core/feedback.py`**,
  **`agent/core/code_extractor.py`** — last stranded modules from the keyed
  path.

## [4.1.0] - 2026-06-01

### Added

- **Company Knowledge** (`canary company-knowledge`) — ground AI generation in
  internal context without committing proprietary content. Three-source merge
  cascade: `~/.canary/company.json` (org defaults) → `.canary/company.json`
  (project-local) → `.canary/company.<env>.json` (env override). Interactive
  scaffolder (`init`), `show --validate-mcp` to verify MCP server registration,
  `show --env <name>` to inspect a specific env layer.
- **Skill deployment via `canary migrate --overlay <path>`** — skills in an
  overlay repo are automatically copied into the target project's
  `.canary/skills/` filtered by a new `deploy_to` frontmatter field. Supports
  shape values `api`, `e2e_ui`, `load`, `frontend_unit`, `all`.
- **Global skill discovery** (`~/.canary/skills/`) — skills installed here are
  available in every Canary session regardless of working directory, including
  from the Claude web extension and scratch directories. Shown as a distinct
  **Global skills** group in `canary skills list`.
- **`hooks/check-proprietary.py`** — installable git pre-commit gate that runs
  the CI proprietary-identifier check locally before every commit. Install with
  `python3 hooks/check-proprietary.py --install`.
- **Company Knowledge guide** (`docs/guides/company-knowledge.md`) — full
  operational guide covering the cascade, schema, secrets, init/show/validate
  commands, org defaults, env overrides, and prompt injection.

### Changed

- `canary migrate` gains `--overlay` / `-o` flag; dry-run and apply reports now
  include a **Skills Deployed** / **Skills (would deploy)** section.
- `canary skills list` output shows three tiers: **Bundled**, **Global**
  (`~/.canary/skills/`), **Local overlay**.
- `docs/specs/skill-discovery.md` updated to v3 (global tier, `deploy_to` field,
  updated precedence table).
- `agents/skills/canary:migrate.md` documents the `--overlay` flag and skill
  deployment behaviour.
- `docs/wiki/For-Manual-Testers.md` adds guidance on global skill install for
  Claude web extension users.

## [4.0.0] - 2026-06-01

First release of the rebranded **Canary** plugin. Continues the existing release
line (descends from v3.0.0); no prior release was modified.

### Changed

- **Rebranded Oracle → Canary** across the project: Python package
  (`canary-test-ai`), CLI (`canary` / `canary-mcp`), plugin name (`canary`),
  slash commands, and branding assets.
- Relocated the plugin to the **repository root** (previously
  `plugins/oracle/`).
- Reconciled the version across all manifests (`pyproject.toml`,
  `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`) to `4.0.0`.
- Bumped `actions/setup-python` from v5 to v6 in CI.

### Removed

- Stale API-key and removed-command references throughout the documentation.

### Security

- Added an open-core proprietary guard and company-leak scrub, enforced by a CI
  guard (removed-symbol / proprietary-denylist checks).

[Unreleased]: https://github.com/bop-clocktower/canary/compare/v5.3.0...HEAD
[5.3.0]: https://github.com/bop-clocktower/canary/compare/v5.2.0...v5.3.0
[5.2.0]: https://github.com/bop-clocktower/canary/compare/v5.1.0...v5.2.0
[5.1.0]: https://github.com/bop-clocktower/canary/compare/v5.0.0...v5.1.0
[5.0.0]: https://github.com/bop-clocktower/canary/compare/v4.1.0...v5.0.0
[4.1.0]: https://github.com/bop-clocktower/canary/compare/v4.0.0...v4.1.0
[4.0.0]: https://github.com/bop-clocktower/canary/compare/v3.0.0...v4.0.0
