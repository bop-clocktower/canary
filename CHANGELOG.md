<!-- markdownlint-disable MD024 -->
# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This changelog starts at **v4.0.0**. Earlier releases (v1.0.0–v3.0.0, published
under the project's former name) are documented in the
[GitHub Releases](https://github.com/bop-clocktower/canary/releases) history.

## [Unreleased]

### Added

- **Test Intelligence Skills** — five new bundled slash commands for suite-level
  analysis (PR #205, closes canary-capillary#35–38):
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
    shapes, accessibility). Output depth scales with `--level sdet|junior|manual`;
    focuses on critical areas when `critical-areas.json` is present.
  - **`/canary-failure-impact`** — traces downstream effects of a test, function,
    or code path failing undetected. Domain heuristics boost severity for
    billing/auth/compliance paths. Produces a Critical/High/Medium/Low label
    with an affected-dependency list and suggested next action.
- **`canary --version` / `canary -V`** — conventional version flag via Typer
  callback, alongside the existing `canary version` subcommand (PR #204).
- **`canary upgrade`** — upgrades to the latest published version using pipx
  (preferred), with a pip fallback for non-pipx installs (PR #204).
- **WebdriverIO (`wdio`) migrate support** — `wdio.conf.ts/.js/.mjs` config
  probe, `wdio` package.json script pattern, and a `wdio.conf.ts` + `tests/`
  scaffold (PR #202).

### Changed

- `.py` skill CLIs now run under canary's own venv interpreter (`sys.executable`)
  instead of the system Python resolved by their shebang — skills that depend on
  venv packages (e.g. `openpyxl`) no longer require manual injection (PR #203).

### Fixed

- Added `openpyxl>=3.1` to `[project.dependencies]` so xlsx-import skills work
  out of the box (PR #203).

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

First release of the rebranded **Canary** plugin. Continues the existing
release line (descends from v3.0.0); no prior release was modified.

### Changed

- **Rebranded Oracle → Canary** across the project: Python package
  (`canary-test-ai`), CLI (`canary` / `canary-mcp`), plugin name (`canary`),
  slash commands, and branding assets.
- Relocated the plugin to the **repository root** (previously `plugins/oracle/`).
- Reconciled the version across all manifests (`pyproject.toml`,
  `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`) to `4.0.0`.
- Bumped `actions/setup-python` from v5 to v6 in CI.

### Removed

- Stale API-key and removed-command references throughout the documentation.

### Security

- Added an open-core proprietary guard and company-leak scrub, enforced by a
  CI guard (removed-symbol / proprietary-denylist checks).

[Unreleased]: https://github.com/bop-clocktower/canary/compare/v4.1.0...HEAD
[4.1.0]: https://github.com/bop-clocktower/canary/compare/v4.0.0...v4.1.0
[4.0.0]: https://github.com/bop-clocktower/canary/compare/v3.0.0...v4.0.0
