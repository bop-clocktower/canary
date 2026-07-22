# ![Canary](docs/assets/icon-gold.svg) Canary

![version](https://img.shields.io/badge/version-5.14.0-F0C040?style=flat-square&labelColor=0A0A0A&color=F0C040)
![python](https://img.shields.io/badge/python-3.11+-F5F5F5?style=flat-square&labelColor=1C1C1C&color=2E2E2E)
![tests](https://img.shields.io/badge/tests-passing-28C840?style=flat-square&labelColor=1C1C1C&color=1C1C1C&logoColor=28C840)
![frameworks](https://img.shields.io/badge/playwright_·_vitest_·_pytest-F0C040?style=flat-square&labelColor=C09018&color=F0C040)
![license](https://img.shields.io/badge/license-MIT-555?style=flat-square&labelColor=1C1C1C&color=2E2E2E)

**Canary** is an AI-powered test automation agent that transforms natural
language requirements into high-quality, framework-aware test code.

## 🚀 Features

- **Intent Classification:** Automatically detects if you need E2E, API, Unit,
  or Performance tests.
- **Framework Recommendation:** Suggests the best-in-class tool (Playwright,
  Vitest, Pytest, k6) based on your needs.
- **Code Generation:** Produces production-ready test scripts following industry
  best practices.
- **Test Intelligence:** CI-readiness scoring, risk-based prioritization,
  edge-case discovery, flake detection/healing, and fleet-wide health analytics
  across suites — see [Usage](#-usage) for the full catalog.
- **CLI-First:** Simple terminal interface for seamless developer workflow.

## 🛠 Installation

> Package names differ by registry: npm/Volta package is `canary-test-cli` ·
> PyPI package is `canary-test-ai`.

### Volta (recommended)

```bash
volta install canary-test-cli@latest
```

Installs a self-contained `canary` binary — no Python or pipx required. Volta
handles version pinning and per-project switching automatically.

> **Supported:** linux-x64, darwin-arm64 (Apple Silicon), win32-x64. Intel Mac
> (darwin-x64) is not yet supported.

### mise

```bash
mise use -g npm:canary-test-cli@latest
```

Adds `canary` to your global `mise` tool manifest alongside things like `node` —
`mise up` will then keep it current the same way it updates any other
mise-managed tool.

### npm / npx

```bash
npm install -g canary-test-cli@latest
# or one-shot:
npx canary-test-cli recommend "a login page"
```

### pipx (Python users)

```bash
pipx install git+https://github.com/bop-clocktower/canary@latest
```

### From source

```bash
git clone https://github.com/bop-clocktower/canary.git
cd canary
pip install -e .
```

### Claude Code plugin

Canary ships as a Claude Code plugin: 8 agents, 12 skills, and 10 slash
commands, plus the `harness` MCP server. See [Usage](#-usage) below for the full
surface organized by use case, or the exhaustive catalog in
[agents/skills/README.md](agents/skills/README.md). Add it as a local
marketplace:

```bash
/plugin marketplace add https://github.com/bop-clocktower/canary
/plugin install canary@bop-clocktower
```

Or, if you've already cloned the repo:

```bash
/plugin marketplace add /path/to/canary
/plugin install canary@bop-clocktower
```

> **Note:** the install syntax is `<plugin-name>@<marketplace-name>`. The
> `canary` plugin ships from the `bop-clocktower` marketplace, so the `@`
> qualifier reads as `canary@bop-clocktower`.

No separate API key is required. The plugin runs through Claude Code's own
session authentication.

## 📖 Usage

Every top-level CLI command supports `--help`; run `canary --help` for the full
tree. The tables below group the real surface — CLI, Claude Code slash commands,
and bundled skills — by what you're trying to do. Full per-skill detail (When to
Use, process, escalation) lives in
[agents/skills/README.md](agents/skills/README.md).

### I want to write a test

| Tool                               | What it does                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| `/canary-write-test <requirement>` | Claude Code — `canary-test-author` agent generates the test in your session (no API key).      |
| `canary-generate-test` skill       | Classify → recommend → generate pipeline; writes to `tests/generated/` and optionally runs it. |
| `canary recommend "<requirement>"` | CLI, deterministic — framework + reasoning, no key.                                            |
| `canary init <framework>`          | CLI — scaffold a suite (`playwright`, `vitest`, `pytest`, `k6`).                               |
| `canary run <file> <framework>`    | CLI — execute a generated or existing test file.                                               |
| `canary-promote-test` skill        | Once validated, move a test out of `tests/generated/` into the committed suite.                |

### I want to pick a framework

| Tool                            | What it does                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| `/canary-pick-framework <need>` | Claude Code — `canary-framework-advisor` agent; recommends only, doesn't write tests. |
| `canary recommend "<need>"`     | CLI, deterministic — same classifier/recommender, no key.                             |

### I want to check CI readiness

| Tool                                              | What it does                                                                                 |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `/canary-ci-ready [--threshold <depth>]`          | Claude Code — coverage depth, flakiness, assertion quality, critical-path coverage, runtime. |
| `canary-fail-fast` skill                          | Audits Playwright fail-fast config knobs and prints a loud, categorized CI failure digest.   |
| `canary-test-reporter` skill                      | Playwright JSON results → Markdown + JSON report with pass/fail/flaky/skipped counts.        |
| `canary history summary` / `canary history flaky` | CLI — recent-run summary / flake-rate leaderboard for one suite.                             |

### I want to find what to test

| Tool                                              | What it does                                                                       |
| ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `/canary-critical-areas [--diff <diff>] [--save]` | Claude Code — risk-rank areas by churn, dependents, and business-critical signals. |
| `/canary-edge-cases <feature\|fn\|test file>`     | Claude Code — surfaces edge cases across six categories, scaled to skill level.    |
| `/canary-failure-impact <test\|fn\|path>`         | Claude Code — traces downstream blast radius of an undetected failure.             |

### I want to fix a failing or flaky test

| Tool                                           | What it does                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------ |
| `/canary-debug-flake <test\|log\|description>` | Claude Code — `canary-flake-hunter`; intermittent failures only.               |
| `/canary-heal-test <file> [error output]`      | Claude Code — `canary-test-healer`; consistently-failing tests only.           |
| `canary flake-check <path>`                    | CLI, deterministic — flags sleeps, random values, timestamp deps, no LLM.      |
| `canary heal-test <path>`                      | CLI, deterministic — auto-fixes sleeps/missing-awaits; selectors flagged only. |

### I want to review test quality

| Tool                                      | What it does                                                                     |
| ----------------------------------------- | -------------------------------------------------------------------------------- |
| `/canary-review-test <file\|description>` | Claude Code — `canary-test-reviewer`; brittleness, anti-patterns, coverage gaps. |
| `canary review-test <path>`               | CLI, deterministic — static lint only, no LLM.                                   |

### I want to run the full pipeline

| Tool                                                       | What it does                                                                                                    |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `/canary-test-pipeline [--continue] [--threshold <depth>]` | Claude Code — chains critical-areas → edge-cases → failure-impact → write-test → ci-ready, looping until green. |

### I want a per-change PR gate

| Tool                  | What it does                                                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/canary-pr-guardian` | Claude Code — per-diff test-guardian: fidelity-labeled diff-coverage → sticky PR comment (+ pre-commit), agentless Tier 0 on stock CI, authors missing tests at the desk. See [PR guardian guide](docs/guides/pr-guardian.md). |

### I want fleet-wide health, not a single suite

| Tool                                                                                          | What it does                                                        |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `canary analyze {flaky\|spikes\|area-health\|common-failures\|regression-candidates\|digest}` | CLI — cross-suite fleet health reports; `digest` combines all five. |
| `canary history {push\|flaky\|timeline\|summary\|migrate}`                                    | CLI — query and manage the per-suite run-history store.             |

### I want to watch API changes for test impact

| Tool                      | What it does                                                          |
| ------------------------- | --------------------------------------------------------------------- |
| `canary guardian analyze` | CLI — one-shot API diff for a commit → test impact summary.           |
| `canary guardian watch`   | CLI — poll for new merges and analyze each (local dev / CI fallback). |

### I want to set up or migrate a project

| Tool                                         | What it does                                                                                                               |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `canary setup`                               | CLI — **first step in a new repo**: interactive `.canary/company.json` wizard (alias for `canary company-knowledge init`). |
| `canary init <framework>`                    | CLI — scaffold a new suite with Gold Standard config. Run bare `canary init` for a setup-vs-scaffold signpost.             |
| `canary migrate [--apply]`                   | CLI — adopt a harness-scaffolded project; dry-run by default.                                                              |
| `canary-setup-harness` skill                 | Wire up Harness Engineering guardrails + CI workflows in a new project or fork.                                            |
| `canary doctor`                              | CLI — diagnose your Canary setup (npm install required).                                                                   |
| `canary upgrade`                             | CLI — upgrade Canary to the latest published version.                                                                      |
| `canary overlay {add\|list\|update\|remove}` | CLI — manage tracked overlay skill sources (npm install required).                                                         |

### I want to add a framework, or trace test-to-request calls

| Tool                         | What it does                                                                                               |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `canary-add-framework` skill | Add a framework to Canary's own classifier↔registry, end-to-end.                                           |
| `canary-instrument` skill    | Instrument a Playwright run with OpenTelemetry; emits `run.json` correlating tests to outbound HTTP calls. |

### Ticket, workflow, and company-knowledge integration

| Tool                                     | What it does                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| `canary ticket-update`                   | CLI — post a run comment and/or transition the linked ticket after a run. |
| `canary workflow {discover\|show\|init}` | CLI — discover/inspect the Jira or GitHub workflow mapping for a project. |
| `canary company-knowledge {show\|init}`  | CLI — manage pointers in `.canary/company.json`.                          |

### Other

| Tool                        | What it does                                                                |
| --------------------------- | --------------------------------------------------------------------------- |
| `canary version`            | CLI — show Canary version info.                                             |
| `canary skills {list\|run}` | CLI — list discoverable skills / invoke a code-bearing skill's entry point. |

## ⚙️ Configuration

**No API key is required.** Canary runs as a Claude Code plugin and uses your
Claude Code session for any LLM work — there is no separate provider key to set.
Most CLI commands (`recommend`, `init`, `run`, `migrate`, `review-test`,
`flake-check`, `heal-test`) are fully deterministic and make no LLM calls;
they're documented as such above and in each command's own `--help`.

## 📝 Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history. Per-release notes are also
published on
[GitHub Releases](https://github.com/bop-clocktower/canary/releases).

## 🏗 Architecture

Canary follows a modular pipeline: **User Prompt** → **Classifier** →
**Recommender** → **host LLM (your Claude Code session)** → **Generated Test**

_Generated by Canary — The future of autonomous test engineering._
