# Canary Knowledge Map

## Project Overview

**Canary** is an AI-powered test automation agent that transforms natural
language requirements into high-quality, framework-aware test code. It follows
strict harness engineering practices for layer isolation and architectural
integrity.

## Documentation

- **Wiki Home:** [Home][wiki-home]
- **Architecture Deep Dive:** [Architecture Deep Dive][arch-deep-dive]
- **Harness Integration:** [Harness Integration][harness-int]
- **Harness + Canary Routing & Ownership:**
  [Integration Guide](docs/guides/harness-canary-integration.md)
- **LLM Configuration:** [LLM Providers][llm-config]
- **Self-Healing Loop:** [Self-Healing Loop][self-healing]
- **Main README:** [README.md](README.md)
- **Roadmap:** [docs/roadmap.md](docs/roadmap.md)
- **State:** [CANARY_STATE.md](docs/CANARY_STATE.md)
- **Engineering Learnings:** [CANARY_LEARNINGS.md](docs/CANARY_LEARNINGS.md)

### Diagrams

Architecture and flow diagrams live as **Mermaid fenced blocks inside the wiki
page they document** (`docs/wiki/**`) — never as checked-in images. The GitHub
Wiki renders Mermaid natively, so the source stays diff-reviewable, versioned
with the code it describes, and editable without a drawing tool.

Rules:

- **Put the diagram next to the prose it illustrates.** A diagram in a separate
  file drifts from the text within one release.
- **Update the diagram in the same PR as the behaviour it shows.** A stale
  diagram is worse than none: it is trusted more and checked less.
- **Diagram what exists, not what is planned.** If a component is aspirational,
  say so in prose instead of drawing it.
- **CI renders every chart** (`Docs Lint` → `Wiki diagrams render`). The Wiki
  renders Mermaid natively, which means a malformed chart ships _silently_ — the
  job turns that into a PR-time failure. Preview locally with:

  ```bash
  npx --yes @mermaid-js/mermaid-cli@11 -i docs/wiki/<Page>.md -o /tmp/out.md
  ```

Beware the failure mode this repo has already hit: a doc sweep once refreshed
file _paths_ to the current tree without checking whether the components they
named still existed, leaving a page that looked maintained while describing a
long-deleted architecture. When editing, verify described **behaviour** against
the code, not just the paths.

## Repository Structure

### Conventions

- **Localized Ignores:** `.gitignore` files should be located in the specific
  project/folder they apply to (e.g., `.harness/.gitignore`, `tests/.gitignore`)
  rather than being consolidated into the root `.gitignore`.
- **Deleting a surface = a doc contract.** When you remove a CLI command,
  module, or env var, grep the _entire_ tree (not just `agent/`) for its name
  and update docs/examples in the **same** change. The v3.0 cut removed the
  provider layer, orchestrator, and keyed generate command but left months of
  stale references behind (this drift was the motivation for the guard).
  `scripts/check_removed_symbols.mjs` (run in CI via `docs-lint`) now fails the
  build on that drift — add a row there for each newly-removed surface.
- **Open-core boundary.** This repo is public/open-source. The generic engine
  lives here; **company-specific content** (client names, internal domains,
  proprietary skills, populated `company.json`) lives **only** in a private
  overlay, discovered at runtime via `.canary/skills/`. The same guard enforces
  this: it scans tracked files for internal-hostname patterns plus a
  company-name **denylist** loaded from a gitignored `.proprietary-denylist`
  file (and the `CANARY_PROPRIETARY_DENYLIST` CI secret). The public script
  names no company — keep it that way. Use a neutral placeholder (e.g. `ACME`)
  in public examples.
- **That guard's denominator is the point.** Both halves scan `.md`, `.py`, the
  TS/JS family (`.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`) and the data family
  (`.json`, `.yml`, `.yaml`); the proprietary half adds `.svg`, `.html`, `.txt`
  and `.toml`. Until #578 neither set covered TypeScript, so the gate reported a
  confident green while structurally unable to read the language the repo is
  written in. If you narrow either set, `ts/test/leak-gate-denominator.test.ts`
  fails — it plants a known offender per suffix rather than trusting the
  verdict. Point the gate at a fixture tree with `CANARY_LEAK_SCAN_ROOT`; such a
  run prints a banner saying it does **not** gate the repository.

#### Branch Naming

All branches must follow this pattern: `<prefix>/<kebab-case-slug>`

##### Allowed prefixes

| Prefix      | Use                                        |
| ----------- | ------------------------------------------ |
| `feat/`     | New feature or capability                  |
| `fix/`      | Bug fix                                    |
| `chore/`    | Maintenance, dependencies, tooling         |
| `docs/`     | Documentation only                         |
| `refactor/` | Code restructuring without behavior change |
| `test/`     | Test additions or corrections              |
| `perf/`     | Performance improvements                   |

##### Slug rules

- Separator between prefix and slug: `/` (not `-`)
- Slug format: kebab-case only — lowercase letters, digits, hyphens
- Max slug length: 60 characters
- Ticket/issue IDs are optional but recommended when one exists:
  `feat/42-short-description`

##### Examples

```text
feat/playwright-mcp-integration
fix/23-classifier-timeout
chore/bump-anthropic-sdk
docs/branching-convention
```

##### Special cases (exempt from prefix rule)

- `main` — protected, never pushed to directly
- `release/*` — release branches created by automation
- `dependabot/**` — auto-generated by Dependabot
- `harness/*` — auto-generated by harness agents

### Entry Points

- **CLI:** [ts/src/cli.ts](ts/src/cli.ts) — The primary entry point for the
  agent. Handles command-line arguments and high-level orchestration. Commands:
  `recommend`, `frameworks`, `feedback`, `run`, `init`, `migrate`, `setup`,
  `skills list`, `env-setup` (alias for `setup`), `version`, `review-test`,
  `flake-check`, `heal-test`, `vacuity-check`, `promote-check`.

### Core Services (`ts/src/core/`)

- **Orchestrator:** removed in v3.0 — LLM generation pipeline is now handled by
  the `/canary-write-test` slash command in the host session.
- **Classifier:** [ts/src/core/classifier.ts][classifier] — Identifies
  requirement types and selects target frameworks based on tech stack.
- **Scaffolder:** [ts/src/core/scaffolder.ts][scaffolder] — Generates the
  initial test files, boilerplate, and project structure.
- **Executor:** [ts/src/core/executor.ts][executor] — Runs generated tests and
  captures execution output, logs, and errors.
- **Recommender:** [ts/src/core/recommender.ts][recommender] — Suggests
  frameworks, testing strategies, and LLM providers.
- **Framework Registry:** [ts/src/core/framework-registry.ts][fw-registry] —
  Internal registry for managing supported testing frameworks and their
  capabilities.
- **Metadata Scanner:**
  [ts/src/core/metadata-scanner.ts](ts/src/core/metadata-scanner.ts) — Reads
  `package.json`, `tsconfig.json`, `requirements.txt`, and `pyproject.toml` to
  surface exact dependency versions for the generation prompt. Enables
  version-accurate generated imports.
- **Pattern Matcher:**
  [ts/src/core/pattern-matcher.ts](ts/src/core/pattern-matcher.ts) — Scans
  existing test files to extract naming conventions, common imports, and
  assertion style so generated tests match the project's existing patterns.
- **Domain Scanner:**
  [ts/src/core/domain-scanner.ts](ts/src/core/domain-scanner.ts) — Scans project
  source files (not tests) to extract component names, public functions, and API
  routes for injection into the generation prompt. Prevents the LLM from
  inventing symbol names.
- **Fixture Scanner:**
  [ts/src/core/fixture-scanner.ts](ts/src/core/fixture-scanner.ts) — Scans test
  fixture and helper modules to extract named exports, injected as a "Project
  Symbols" section in the prompt so generated tests import real identifiers.
- **Code Extractor:** removed in v5.0 — stripped LLM response prose; last caller
  was the orchestrator, which was removed with the keyed CLI surface.
- **Selector Healer:** removed in v3.0 — DOM-aware selector fix logic was part
  of the LLM generation pipeline (orchestrator). Replaced by the
  `/canary-debug-flake` slash command.
- **Quality Scorer:**
  [ts/src/core/quality-scorer.ts](ts/src/core/quality-scorer.ts) — Static
  analysis scorer (coverage breadth, assertion density, flakiness risk)
  returning a 0–100 composite score with letter grade. **Vestigial as of v3.0:**
  it was wired into the removed `generate`/orchestrator path and is not
  currently invoked by any live command. Retained pending a decision to re-wire
  it into the plugin flow or remove it.
- **Static Linter:**
  [ts/src/core/static-linter.ts](ts/src/core/static-linter.ts) — File:line
  findings without executing tests; powers `canary review-test` and
  `canary flake-check`. `FLAKE-001..004` (flakiness), `LINT-001..003`
  (selectors), `LINT-004` (missing await), `LINT-005` (magic timing values),
  `LINT-006` (no assertions), and `SOUND-001..003` (#605 — a test that pins a
  value no correct implementation must produce: a non-deterministic value used
  as an expectation, exact equality against an inexact fraction, a ratio pinned
  to an integer). Every rule blanks string literals **including single-line
  template literals** before matching — a fixture carrying the pattern it tests
  is data, not a defect, and on this repo that distinction was half the linter's
  output. Also exports `enumerateTests`, the single "where does this test end"
  implementation shared with the vacuity scanner.
- **Vacuity Scanner:**
  [ts/src/core/vacuity-scanner.ts](ts/src/core/vacuity-scanner.ts) — The
  `canary-cassandra` detection (#612). Finds tests that pass without proving
  anything: `VAC-001` an assertion identical to the value it checks, `VAC-002` a
  target never referenced, `VAC-003` every assertion an absence observed on a
  bystander rather than on the target. `VAC-002`/`VAC-003` carry a fidelity
  ladder (`annotated` via `// @covers <symbol>` over `import-inferred`); a test
  resolvable at neither tier becomes a recorded **skip**, never a pass. Returns
  a `GateResult` whose `checked` counts **tests**, not files. Surfaced as
  `canary vacuity-check`.
- **Promotion Verdict:**
  [ts/src/core/promotion-verdict.ts](ts/src/core/promotion-verdict.ts) — The
  structured verdict `canary-promote-test` gates on (#477). Composes the static
  linter and the vacuity scanner into six axes, four of which gate (`soundness`,
  `assertions`, `flakiness`, `vacuity`) and two of which report (`selectors`,
  `maintainability`). Absence of a verdict is `abstain`/exit 3, never a silently
  looser or stricter promotion. **No LLM judgement can gate:** `VerdictSource`
  is a single-member union, so there is no field an LLM verdict could arrive in
  and acquire authority — `harness:test-craft` stays an optional human audit.
  Surfaced as `canary promote-check`.
- **Reporter:** [ts/src/core/reporter.ts](ts/src/core/reporter.ts) — Exports
  results to JSON or SARIF (Datadog, SonarQube, GitHub Code Scanning).
  **Vestigial as of v3.0:** it was invoked by the removed `canary generate` path
  and is not currently wired into any live command.
- **Migrator:** [ts/src/core/migrator.ts](ts/src/core/migrator.ts) — Detects
  harness-scaffolded test projects (via `harness.config.json` and `.harness/`)
  and migrates them to Canary's layout without touching existing test files.
  Invoked via `canary migrate`. `canary migrate --from <overlay> --check` is a
  no-write **freshness gate** (exit 0 in sync / 1 drift / 2 a deployed skill has
  local edits; `--json` for CI). Deployment is one-way: a per-skill content hash
  in `.canary/skills/.deploy-manifest.json` lets `--apply` refresh only
  unmodified deployed copies, never clobbering local edits.
- **Skill Registry:**
  [ts/src/core/skill-registry.ts](ts/src/core/skill-registry.ts) — Discovers
  bundled default skills and local project overlay skills (from
  `.canary/skills/`) for slash command resolution via `canary skills list`.
- **CI Environment:** [ts/src/core/ci-env.ts](ts/src/core/ci-env.ts) — Detects
  CI environment variables (`CI`, `GITHUB_ACTIONS`, etc.) to enable headless
  optimizations and force JSON output in pipelines.
- **Environment Detection:**
  [ts/src/core/environment-detect.ts](ts/src/core/environment-detect.ts) —
  Context-aware persona/environment detection (#341): `BASE_URL` from `.env` +
  `playwright.config.*`, suite-type hints, and an auditable SDET-vs-manual
  user-level heuristic (cwd + open files). Surfaced additively as the
  `environment` block on the MCP `analyze_file` response. Browser-tab detection
  is deferred to the Chrome Extension MCP Bridge (#343).
- **Personas:** [ts/src/core/persona.ts](ts/src/core/persona.ts) — the audience
  definition skills **consult** instead of hand-rolling "if tester, use simpler
  words" (#462), and the consumer the detection above never had (#341).
  `ts/src/data/personas/registry.json` names each audience with an explanation
  `depth`, preferred `formats`, and a `reasoning` switch; `resolvePersona` picks
  one from an explicit id, then a detected level clearing **both** registry
  floors, then the fallback — always reporting `source`, `reason`, and the
  detector's `signals`. Surfaced additively as the `persona` block on
  `analyze_file`. **Two floors, because one of them cannot work alone:** the
  detector's confidence is `|sdet - manual| / total`, a _margin_ rather than a
  probability, so a single unopposed observation arrives at `1.0` and a
  confidence floor screens ties and nothing else. `minDetectionSignals` (2)
  requires two **independent** signals, counted by _kind_ — the text before the
  first `": "` — so ten open TypeScript files are one observation restated, not
  ten facts. Below the floor the reason says how many signals were found rather
  than "no signal", because "too little evidence" and "no evidence" have
  different fixes. Relatedly, `analyze_file` re-derives the level **without**
  the file it was asked about: that path is the tool's own argument, not an
  observation of the caller, and counting it let any `.ts` file in any project
  with a `package.json` clear the floor. One consequence worth knowing: `manual`
  is no longer inferable through `analyze_file` (a manual artefact was its only
  unopposed signal there), so it is reached by `CANARY_PERSONA=manual`. The
  fallback is explanatory, so that failure is safe. Three further boundaries are
  decisions, not omissions: **voice is not a persona field**
  (`voice/discovery.md` already owns that axis, and collapsing the two would
  make "terse in a given voice" inexpressible); the **fallback is explanatory
  rather than terse**, because most users never configure this and
  under-explaining fails a manual tester silently where over-explaining merely
  annoys an SDET; and the module reads **no** environment variable itself, so
  `CANARY_PERSONA` is read at the call site and the resolver stays pure.
  `CANARY_PERSONA` is unrelated to `canary doctor --audience`, which tags which
  overlay _checks_ run and ships no vocabulary of its own. Overlays extend the
  registry through `.canary/personas.json`, arbitrated by the same `precedence`
  contract as skill-name collisions (#333).
- **Feedback:** [ts/src/core/feedback.ts](ts/src/core/feedback.ts) — Builds a
  pre-filled GitHub issue for `canary feedback` (#345) with non-sensitive
  context (version/OS/Python/install); never env vars or file contents. (New in
  v5.12; unrelated to the removed-in-v3.0 generate-era feedback path.)

### Claude Code Plugin (`.claude-plugin/`)

Canary is also loadable as a Claude Code plugin for in-editor test generation
via slash commands.

- **MCP server:** [ts/src/mcp-server.ts](ts/src/mcp-server.ts) — FastMCP server
  exposing six tools to Claude Code: `canary__analyze_file`,
  `canary__write_test_file`, `canary__run_tests`, `canary__init_suite`,
  `canary__list_frameworks`, `canary__migrate`.
- **Manifest:** [.claude-plugin/plugin.json](.claude-plugin/plugin.json). Its
  `version` (and the `canary` entry's `version` in
  [.claude-plugin/marketplace.json](.claude-plugin/marketplace.json)) must match
  `npm/package.json`. A `chore(release)` bump must touch **all three**, plus the
  README version badge; `scripts/bump-version.mjs <version>` stamps every one of
  them, and `ts/test/version-consistency.test.ts` fails CI if they drift. (There
  is no `pyproject.toml` — the Python engine was retired in the v6.0.0 cutover,
  and the guard is a vitest suite, not pytest.)
- **Agents:** `agents/` — seven agent definitions: `canary-test-generator`,
  `canary-test-author`, `canary-test-reviewer`, `canary-initializer`,
  `canary-migrator`, `canary-framework-advisor`, `canary-flake-hunter`.
- **Skills:** `agents/skills/` — three slash commands: `/canary:generate`,
  `/canary:init`, `/canary:migrate`.
- **Activate:** load the repo root as a Claude Code plugin.

### LLM Layer (removed in v3.0)

Removed in v3.0. The provider matrix (`anthropic`, `openai`, `gemini`, `codex`,
`mock`), factory, and client are deleted. LLM generation now runs through the
host Claude Code session via `/canary-write-test` — no API key required.

### Configuration & Data

- **Framework Metadata:** [ts/src/data/frameworks/registry.json][fw-json] —
  Static definitions for framework capabilities and templates.
- **Harness Config:** [harness.config.json](harness.config.json) — Defines
  architectural layers, dependency constraints, and project metadata. The layers
  describe `ts/src` by role; every pattern is required to match at least one
  git-tracked file and every tracked source file to belong to a layer
  (`ts/test/harness-config-denominator.test.ts`), because a rule that matches
  nothing still reports as configured (#543).

### Generated Artifacts

- **Playwright Tests:** `tests/generated/` — Automated tests generated by the
  agent. These are considered output artifacts and are generally excluded from
  manual review.

### TypeScript engine (`ts/`)

**Migration complete.** `ts/` **is** the engine. The strangler port finished in
the v6 cutover: the Python engine was deleted, and v6.1.0 removed the last
Python from the plugin hooks and maintenance scripts. There is no longer a
"pilot", a shipping Python product, or a cross-language boundary to preserve.

- **Scope:** all of `ts/src/` — `core/` (classify, recommend, scan, adopt),
  `guardian/`, `analysis/`, `history/`, `cli.ts`, `mcp-server.ts`.
- **Toolchain:** TypeScript (strict) + Vitest (v8 coverage gate, lines 90 /
  branches 85) + Prettier. No ESLint (the repo uses none; the `protect-config`
  hook blocks AI-authored linter configs). CI job id `ts-validate` in
  `harness-quality.yml` (displayed as **TS engine (pilot)** — the label is a
  leftover from the migration, not a statement of status).
- **Run history:** `test-results/reports/history-v2.jsonl` (NDJSON, one
  run-record per line) remains the on-disk contract between the executor, the
  history store, and `analysis/`. **`canary history record` is the writer**
  (#538) — before it existed nothing in the product wrote the file, so the whole
  `analyze` / `history` surface had only ever been read against synthetic
  fixtures. New history consumers take the async `AsyncHistoryStore` from
  `makeStore()`, never `NdjsonHistoryStore` directly; see
  [ADR 0013](docs/knowledge/decisions/0013-history-store-async-interface.md).
- **Subprocess contract tests:** spawn through `runCapture()` in
  `ts/test/subprocess-testkit.ts`, never a hand-rolled `execFileSync` try/catch.
  `execFileSync` throws on a non-zero exit — which is the case under test for a
  CLI suite — so each call site used to re-derive the same cast-and-default
  block, and three of them independently tripped the `ts/test` cyclomatic
  threshold of 10 doing it (#622). `runCapture` wraps `spawnSync`, which returns
  the failure instead of throwing.
  `ts/test/subprocess-normalisation-guard.test.ts` fails the build on a fourth
  hand-rolled copy. Note the threshold split (`ts/test` 10, `ts/src` 15) is a
  harness CLI default, not a key in `harness.config.json` — there is nothing
  local to retune.
- **Golden fixtures:** `ts/test/parity.test.ts` compares `AnalysisEngine` output
  against frozen captures in `ts/test/fixtures/golden/`. These began as
  TS↔Python parity captures; with Python gone they are now **regression**
  snapshots. Note the capture script they cite
  (`scripts/capture_analysis_golden.py`) no longer exists, so there is currently
  **no supported way to regenerate them** — treat a mismatch as a TS regression
  to fix, not a fixture to refresh, unless you first restore a capture path.
- **Historical plan:**
  [docs/plans/2026-07-22-ts-migration-pilot-analysis-plan.md](docs/plans/2026-07-22-ts-migration-pilot-analysis-plan.md)
  (describes the migration as it was planned; kept as a record).

### GitHub Actions (`.github/workflows/`)

The composite action (`action.yml`) was removed in v3.0 — it called
`canary generate` which no longer exists. Use the Claude Code plugin
(`/canary-write-test`) instead; generation runs in the developer's own
authenticated session with no API key required.

## Integration with Harness

Canary integrates with the **Harness Engineering Ecosystem** by:

1. **Programmatic Access:** Exposing a `--json` flag for machine-readable
   generation outputs
2. **Layered Architecture:** A role-based layering of the TypeScript engine —
   entry and CLI on top, then feature modules (`guardian`, `analysis`,
   `history`), then `core`, over the `ui` and `util` leaves — enforced by
   `harness.config.json` and gated by `harness check-deps` in CI
3. **Mechanical Verification:** Supporting dry-runs via `--recommend-only` for
   early validation by other harness agents (like `harness-planner`)

### Recommended Composition Pattern

Canary and Harness skills are **complementary, not competing**. The recommended
flow for test development combines both:

```text
harness-tdd         → discipline: write failing test first (RED phase)
/canary-write-test  → generation: AI writes the test from your description
harness:test-craft  → quality: 8-axis audit of the generated test
/canary-review-test → promotion: move from tests/generated/ to committed suite
```

`harness-tdd` owns the TDD discipline — write a failing test, watch it fail,
then implement. `/canary-write-test` can assist the RED phase by generating the
failing test stub from a description. The two entry points serve different
workflows: `harness-tdd` when writing tests yourself, `/canary-write-test` when
generating from a prompt.

One capability can carry different names across its slash-command, agent, and
skill-directory surfaces (e.g. `/canary-write-test` → agent `canary-test-author`
→ skill dir `canary-generate-test`). The **slash command is canonical**; use it
in routing docs and NL routing. The authoritative mapping lives in the
[Integration Guide](docs/guides/harness-canary-integration.md)'s "Canonical
capability names" table (#319).

For the full picture when running **both** tools — the skill disambiguation
matrix (canary-X vs harness-Y for ~10 overlap pairs), the `/canary-X` vs
`harness:canary-X` double-registration and which to prefer, the config-ownership
map (`harness.config.json` vs `.canary/` vs `pyproject.toml`/`package.json`),
the `roadmap.md` ↔ `CANARY_STATE.md` ledger roles, and the "what is the merge
gate" answer — see the
[Harness + Canary Integration Guide](docs/guides/harness-canary-integration.md).

### Harness dependency surface

Canary's **dev-time CI gates** consume the harness CLI
(`@harness-engineering/cli`). The runtime CLI shipped to users (`npm/`) stays
cleanly decoupled and depends on none of this. The consumed subcommands are:

| Subcommand         | Used by (workflow)                                 |
| ------------------ | -------------------------------------------------- |
| `ci check`         | `harness.yml`                                      |
| `graph scan`       | `harness.yml`                                      |
| `traceability`     | `harness.yml`                                      |
| `validate`         | `harness-architecture.yml`, `harness-security.yml` |
| `check-deps`       | `harness-architecture.yml`, `harness-security.yml` |
| `check-security`   | `harness-security.yml`                             |
| `check-docs`       | `harness-quality.yml`                              |
| `cleanup`          | `harness-quality.yml`                              |
| `check-phase-gate` | `harness-quality.yml`                              |
| `check-arch`       | `refresh-arch-baseline.yml`, `harness.yml`         |
| `snapshot capture` | `arch-snapshot.yml`                                |

**Pinning (#318 A).** Every gate installs the CLI at a **pinned major** via one
workflow-level env var — `HARNESS_CLI: '@harness-engineering/cli@12'` — rather
than an unpinned `@latest`. A harness-major bump (e.g. a subcommand rename) is
therefore a **deliberate PR** that edits that one line per workflow, not a
silent CI break with nothing to roll back to.

Bumping the major is a **three-step sequence**, in this order (#545, #547):

1. **Reconcile `harness.config.json` against the new major's schema first.** Zod
   strips unknown keys silently, so a key at a path the schema stopped reading
   is dead with no error — that is how `entryPoints` left the entropy scan with
   no entry point across every run it ever made. Land the config fix on the
   _old_ pin, verified against both majors, so a later regression has an
   unambiguous blame boundary. **Moving a key to the path the schema reads is
   only half the check — the value has to be one the analyzer can act on.** The
   same key then spent its next life pointing at `ts/bin/canary.js`, and `bin`
   and `dist` are both in the analyzer's `DEFAULT_SKIP_DIRS`, so the scan ran
   with an empty root set and called all 175 scanned source files dead (#544,
   ADR 0012). A config key reads as correct the moment it stops erroring; check
   what the tool did with it. **And the same value can be needed at more than
   one path**: the entropy and perf checks build the same analyzer snapshot but
   read its roots from `entropy.entryPoints` and `performance.entryPoints`
   respectively, and only the entropy caller falls back to the other key — so
   declaring one left `harness check-perf` green and `ci check`'s perf step
   warning `Could not resolve entry points` on zero files (#638). Check each
   caller, not the key.
2. **Edit `HARNESS_CLI` in all six workflows** — `harness.yml`,
   `harness-quality.yml`, `harness-architecture.yml`, `harness-security.yml`,
   `arch-snapshot.yml`, `refresh-arch-baseline.yml`.
3. **Re-verify every subcommand in the table above on both majors**, comparing
   exit code _and_ output, not just exit code. The gates run the CLI on a bare
   checkout with no `npm ci`, so a local worktree reproduces CI exactly.

**A MINOR bump is not inert, and nothing above catches it (#694, #744, #745).**
The pin is a floating major, so `@11` silently resolves to whatever `11.x` npm
last published — four releases shipped in the eight days after 11.0.0. Two gates
compare an **absolute count** against a checked-in baseline
(`.harness/entropy-baseline.json`, `.harness/perf-baseline.json`), and that
count is a property of the analyzer as much as of this repo: 11.1.1 → 11.2.0
moved the entropy count 281 → 257 with zero commits here, because an upstream
false positive stopped firing. Both directions bite — a tightened rule blocks a
PR whose diff cannot explain the failure, and a loosened one leaves a ceiling
defending far more than the tree needs.

So both baselines record the **exact** resolved version in `harnessCli`, not the
pinned major. When CI resolves a version that no longer matches, the baseline is
stale: re-measure **in a clean worktree** (the count reads high in the main
working dir, #700) and update `measuredCount`, `measuredAt`, `harnessCli` and
`maxFindings` in the same PR. A count that falls on its own is not automatically
good news — establish whether the tree got cleaner or the detector went quiet
before lowering a ceiling to match it.

**Measuring the entropy ratchet locally — use a worktree, never your working
directory (#700).** The ratchet is a blocking gate, so it has to be runnable
before you push. It is, but only from a clean tree:

```bash
git worktree add ../canary-entropy origin/main --detach
cd ../canary-entropy
npx --yes -p '@harness-engineering/cli@12' harness cleanup --findings-json \
  > /tmp/entropy-report.txt || true
node scripts/entropy-ratchet.mjs --report /tmp/entropy-report.txt \
  --cli-version "$(npx --yes -p '@harness-engineering/cli@12' harness --version)"
```

`--cli-version` is not optional in practice (#744). The pin is a floating major,
so the analyzer behind this absolute count changes with no commit here — it
moved three times, most recently 147 -> 135 on the @11 -> @12 bump — the first
one the abstention caught before it landed — and the ratchet abstains rather
than compare a count to a ceiling calibrated against a different instrument.
Omitting the flag is itself an abstention: "cannot verify" is a finding, not a
skip. If it fires, re-measure and move `measuredCount` and `harnessCli`
together; do not silence it by deleting `harnessCli` from the baseline.

No `npm ci` — the gates run on a bare checkout, and so should you. Verified at
`97bb15f`: CI reported **282** and a fresh worktree reported **282**, an exact
match. The same commands in a long-lived working directory reported **346**.

Every one of those +64 was a local-only artifact, and **gitignore is not what
protects you** — the analyzer's walk sets `dot: true` deliberately and reads no
ignore file at all. What keeps local junk out is upstream's hardcoded
`DEFAULT_SKIP_DIRS` list of directory _basenames_ (`.claude`, `.cursor`,
`.codex`, `.git-worktrees`, …) plus this repo's `entropy.excludePatterns`. That
is why `.claude/worktrees/` is silent and `.kiro/` is not: one basename is on
the list and the other is not, and no amount of gitignoring changes it.

**Upstream limit, measured against CLI 11.1.1.** A path under a dot-directory
upstream does not already skip cannot be excluded by _any_ `excludePatterns`
entry — eight forms were tried, down to the exact literal relative path, and
every one left the count unchanged; the same mechanism excludes non-dot paths
(`tests/generated/**`) correctly. So `.kiro/**` and `.remember/**` are
deliberately **absent** from `harness.config.json`: a pattern that matches
nothing reads as configured and protects nothing, which is the vacuity
`ts/test/entropy-exclude-patterns.test.ts` exists to refuse. The worktree is the
workaround until upstream is fixed.

**Reading a red `Harness Checks` (#588).** The `ci check --json` report is ~162
KB and **is not in the job log** — do not scroll for it. Two limits eat it: the
Actions log truncates at 60 KB, and Node's stdout is async when it is a pipe, so
`process.exit()` drops the ~64 KB still buffered. Neither cut leaves a marker,
so the log reads as a complete report that happens to end early. On PR #584 it
ended after check four of nine, showing `pass/pass/warn/warn` and zero errors on
a job that failed for `arch: fail` — five checks past the cut, and a long
debugging detour before anyone captured the report to a file.

So `harness.yml` writes `harness ci check --json > harness-report.json`, prints
a per-check summary via `node scripts/harness-report-summary.mjs`, and uploads
the full report as the **`harness-report`** artifact on every run including
failures. To diagnose a red run: read the summary step for which check failed,
then `gh run download <run-id> -n harness-report` for the findings. The
summariser caps _warning_ detail at ten per check and always prints the
remainder count; error-severity findings are never capped. It exits **3** if the
report is missing or unparseable, because a summary nobody can produce is this
same condition returning, not a pass. `ts/test/workflow-false-green.test.ts`
holds the invariant for every workflow, not just this one.

**A red `arch` is two different bugs (#626).** `harness check-arch` reports the
**absolute** violation count and exits 1; the ratchet inside `harness ci check`
reports the **delta** and passes when it is zero. On a clean `main` that is
`28 issues, exit 1` sitting next to `{"name":"arch","status":"pass"}` — both
correct, neither wrong. The cost is that the two ways `arch` can go red want
opposite responses and look identical:

| What happened                      | What the CI report shows | What to do                   |
| ---------------------------------- | ------------------------ | ---------------------------- |
| The diff introduced a violation    | `arch fail`, 0 issues    | Fix the code                 |
| The ratchet fired on existing debt | `arch fail`, 0 issues    | Write a per-PR **allowance** |
| A metric grew for a good reason    | `arch fail`, 0 issues    | Write a per-PR **allowance** |

The `arch` entry is `{name, status, issues: [], durationMs}` with **zero**
error-severity issues either way, so the CI report alone cannot tell them apart
— which is how #584, #598 and #621 were each read as a defect in the author's
diff on the same day. Only `check-arch --json` carries the split
(`newViolations`, `regressions`, `preExisting`), so `harness.yml` captures it to
`arch-report.json` and passes it to the summariser, which prints one of three
sentences: `REGRESSION`, `BASELINE TRIP`, or `CANNOT DISAMBIGUATE` when the
detail report is missing.

Locally, run the same classifier rather than `check-arch` on its own:

```bash
harness check-arch --json > arch-report.json
node scripts/arch-verdict.mjs arch-report.json
```

It exits **0** for a clean tree _and_ for a baseline trip, **1** only when the
change introduced something, and **3** when it cannot classify. That is the
difference that makes it worth running: `check-arch` exits 1 on a clean tree, so
nobody runs it and the ratchet's reasoning goes unread. Both paths share one
classifier (`scripts/arch-verdict.mjs`), so CI and the desk cannot drift into
different verdicts on the same report; `ts/test/arch-verdict.test.ts` pins the
classification, the exit codes, and the `harness.yml` wiring.

**Ordinary growth needs no allowance; the tolerance absorbs it (#736).**
`check-arch` compares against the HIGHER of two numbers: the baseline widened by
`architecture.regressionTolerance` (a fraction of the baseline, default **1%**),
and the highest matching per-PR allowance. With the floor tracking `main` that
tolerance is worth ~330 lines, which covers ordinary growth — #731's **+135**
and #735's **+24** would both have passed with no allowance file at all.

Write `.harness/arch/allowances/<slug>.json` only when growth **exceeds** the
tolerance: one file per PR, carrying the absolute value you measured and the
argument for it. Copy the shape of any file already in that directory, or let
`harness check-arch --update-baseline --allow-regress --reason "…"` write one.

This reverses #689's advice, and the reason is worth keeping. #689 was right
that an allowance beat a refresh _at the time_ — but only because the floor had
stopped moving on 2026-08-10 while the ceiling climbed to 32960. A 5995 gap
makes a 1% absorber worth 270, so every PR needed an allowance and the directory
grew to 22 files whose bespoke justifications read as 22 people absorbing one
stale constant. The absorber was never broken; it was measuring a fraction of a
number nobody refreshed. `ts/test/arch-baseline-freshness.test.ts` now fails as
soon as the gap outgrows the tolerance, so this cannot silently recur.

**Two mechanics that make a refresh look broken (measured 2026-08-22).**

- **The baseline is read from the BASE BRANCH, not your worktree.** Editing
  `.harness/arch/baselines.json` on a branch changes nothing about how that
  branch is judged — proven by deleting the file outright and watching
  `check-arch` still report `base=26965`. This is deliberate anti-tamper: a PR
  cannot lower its own bar. The consequence is that a refresh **only takes
  effect once it is on `main`**, so do not expect the PR that performs one to
  show the new number.
- **`--update-baseline` does not update the baseline.** At CLI 11.x **and 12.x**
  (re-verified against 12.1.0 on 2026-08-30) it writes an _allowance_ and says
  so — `Commit it — baselines.json stays byte-identical to the base` — then
  prints `✓ Baseline updated successfully.` anyway. 12.x additionally refuses
  without a `--reason` and states the allowance behaviour up front in that
  refusal, so the trap is easier to notice; the contradictory success line is
  unchanged. No CLI command rewrites `baselines.json`. Use
  `scripts/refresh-arch-baseline.mjs` (#749), which the `refresh-baseline` label
  runs for you:

  ```bash
  harness check-arch --json > arch-report.json || true
  node scripts/refresh-arch-baseline.mjs arch-report.json
  ```

  It moves `metrics["<metric>"].value` and **leaves `violationIds` untouched** —
  that keeps the aggregate ceiling moving without banking a single violation,
  which is the half of a refresh #689 rightly objected to. Verified: 1 new / 69
  pre-existing, identical before and after. It exits **1** when no metric
  regressed (so the label was not needed) and **3** when it cannot read the
  report or would have to invent a value; only **0** means something was
  written.

**`baselines.json` is the FLOOR; the highest allowance is the effective CEILING
(#736).** Nothing in the tooling says this, and not knowing it has now cost two
separate investigations a full evening each, so it is written here rather than
left to be re-derived:

```bash
# the bar your PR is actually measured against
node -e "const fs=require('fs'),p='.harness/arch/allowances/';
  console.log(Math.max(...fs.readdirSync(p)
    .map(f=>JSON.parse(fs.readFileSync(p+f,'utf8')).categories?.['module-size'])
    .filter(Boolean)))"
```

`check-arch` prints the **floor** as its left operand, so its arrow reports the
repo's whole accumulated growth as though your branch caused it:

```text
[module-size] REGRESSION: 32960 > 26965 (delta: 5995)
                          ^^^^^          ^^^^^^^^^^^
                          yours          the FLOOR, not your growth
```

Your real contribution is `currentValue − ceiling`, which in practice is tens of
lines, not thousands: #731 was **+135** and #735 was **+24** against arrows
reading +5971 and +5995. Put the real delta in the allowance's `reason`, never
the printed one. Confirm the ceiling with a **bracketing probe** on a clean
worktree — append N `//` comment lines to one tracked source file and re-measure
until the verdict flips. On `main` at the time of writing, +3 passed and +20
failed, bracketing the ceiling; if the floor were the operand, +3 would have
failed too.

Three traps, each of which produced a confident wrong answer during #731:

- **A branch's total moves with main — compare deltas, never totals.** When #731
  merged, `main` went 32936 and the #735 branch went 32960 with it; its +24
  never changed. Comparing a pre-rebase total to a post-merge ceiling said "no
  allowance needed" and was wrong. Re-measure after every rebase.
- **Pass/fail cannot measure a magnitude.** A probe that only asks "did an error
  appear" is blind to any movement that stays under the ceiling. Parse the JSON
  and read `currentValue`; grepping possibly-empty output for the absence of a
  string is how a false "cleared" reading gets produced. Note `harness ci check`
  omits the metric entirely when it does not regress, so **`main`'s own value is
  not obtainable** from a clean tree — do not spend time trying.
- **Splitting a module cannot reduce `module-size`.** It is a repo-wide line
  count over `ts/src` + `npm/src` with test code excluded, so extracting ~310
  lines of `analysis/cli.ts` into a sibling moved it _up_ (32936 → 32989) — a
  new file brings its own header and imports.

One consequence worth expecting rather than rediscovering: a clean tree
short-circuits the comparison, so a green `arch` on untouched `main` confirms
nothing about how much room is left.

The ledger no longer grows one file per PR. That property held only while an
allowance was the _only_ way to clear growth: each one recorded the branch's
exact value, so `main` ended up equal to the newest allowance with **zero
slack** and the next PR to touch any source file needed its own. With the floor
refreshed, the tolerance provides the slack instead.

Three things about that output are worth knowing before you read it:

- **The regression line is not a delta.** It used to print
  `module-size 26965 -> 28178`, whose **left** operand is `baselines.json`, not
  `main`. Every allowance merged since the baseline was last refreshed sits
  inside that gap, so the implied growth overstates your change by the whole
  accumulated total — and the error grows over the repo's life. In the
  #680/#682/#683/#687 batch the real contributions were **+55** and **+88**
  while the arrow implied ~1200 for both. Measure your own contribution against
  the merge base. `scripts/arch-verdict.mjs` now names both operands and says
  outright that the pair is not your delta.
- **Allowances need harness `@11`.** Under `@10` the file is ignored entirely,
  so a correct allowance looks like a no-op and the mechanism reads as broken.
  Every workflow pins `@11`; a local install can differ silently, so the verdict
  script warns when it detects an older one and says so when it cannot tell.
- **The old advice cost four PRs in one afternoon.** #680, #682, #683 and #687
  all read the `refresh-baseline` annotation, believed it, and stopped at the
  wrong conclusion. #682's author had first verified the failure against a
  pristine `main` worktree — correct methodology, wrong answer, because the
  instrument misnamed its own mechanism.

**A PR-time green now measures the tree that merges (#678, closed).** GitHub's
`strict_required_status_checks_policy` is **true** on ruleset 16189198, so a PR
cannot merge until its branch is up to date with `main`. It was **false** when
issue #660 landed, and that is what #678 is about: `actions/checkout` on
`pull_request` checks out the merge commit computed for that event — head merged
into `main` as of the last push to the **PR branch** — and base movement fires no
check run, so nothing re-measured. #660's `harness` check passed, the identical
commit failed `check-arch` on `main`, and #663 inherited the failure and read as
its cause. The state and the reasoning are recorded in
`.github/required-checks.json` under `mergePolicy`; every workflow behind a
required check also runs on `push: main` (`guardian.yml` excepted, being a
PR-diff reviewer), which stays as defence in depth.

The practical consequence of `strict` is that **every open PR goes stale
whenever `main` moves**. Repo-level auto-merge is enabled, but it waits rather
than updating a branch, so `gh pr update-branch` is how you satisfy the gate —
run it, let the checks re-run, and auto-merge takes it from there.

Related: the **Architecture Enforcer** workflow does not run the architecture
ratchet. Its `enforce` job runs `harness check-deps` and `harness validate`;
neither reads `.harness/arch/baselines.json`. That is why it can be green while
a local `harness check-arch` exits 1 — two different commands, not one gate
disagreeing with itself.

**A metric that silently improves is a finding (#688).** The arch analyzer skips
55 directory names outright (`coverage`, `dist`, `build`, `bin`, `out`,
`target`, `deps`, `obj`, `vendor`, …) plus every dot-directory, so a source
directory whose name collides is never walked. Splitting
`ts/src/guardian/coverage.ts` into `ts/src/guardian/coverage/` dropped the
reported `module-size` by the exact size of the code that had just moved there,
while `ts/.gitignore`'s `coverage/` rule made the files unstageable and
invisible to prettier as well. Unlike the rest of this section that fails
**open**: the gate reports better than reality and the ratchet gains headroom it
did not earn. `scripts/source-visibility.mjs` guards both mechanisms and prints
the exact line count the gate cannot see; it runs against the real tree in
`ts/test/source-visibility.test.ts` and abstains with exit **3** rather than
passing when it enumerates nothing.

```bash
node scripts/source-visibility.mjs          # 0 clean, 1 hidden source, 3 abstain
node scripts/source-visibility.mjs --json   # the report, machine-readable
```

**`traceability` used to abstain in CI and call it `pass` (#729, fixed).** Of
the nine checks `harness ci check` prints, `traceability` was the one whose
verdict did not depend on the commit at all. It is a pure function of
`.harness/graph/graph.json`, which is **gitignored** (`.harness/.gitignore`) and
was built by **no workflow** — the one invocation that would have built it was
commented out in `guardian.yml`, with a note saying graph fidelity was declined
deliberately. Upstream's `runTraceabilityCheck` loads the graph and, when the
load fails, returns an empty issue list; the reporter renders empty as `pass`.

So `pass traceability 0 issue(s)` on every CI run meant the check **did not
run**, and the first `warn` anyone saw was not a regression — it was the check
running for the first time, at a desk. Proven on one commit, two ways:

```bash
harness ci check --json   # graph present  -> warn traceability 1 (988ms)
git clone . /tmp/cisim    # what actions/checkout produces
(cd /tmp/cisim && harness ci check --json)  # no graph -> pass traceability 0 (4ms)
```

The duration was the only tell in the report, and nobody reads a duration.

**What closed it.** `harness.yml` now runs `harness graph scan` before
`ci check` — **deliberately without `|| true` or `continue-on-error`**, because
a build step that silently no-ops puts CI straight back into the same false
green (~5s and ~15MB here, so there is no cost argument for making it optional).
It then captures `harness traceability --json` and hands it to the summariser,
which reads the denominator through `scripts/traceability-verdict.mjs` and
**exits 3** when the report is missing, unreadable, or carries zero
requirements. `pass` over an unknown denominator is no longer a reachable
output. At the desk:

```bash
harness graph scan
harness traceability --json > traceability-report.json
node scripts/traceability-verdict.mjs traceability-report.json  # 0 measured, 3 abstained
```

Note the shape a bare checkout actually produces, since it is what the guard
reads — `harness traceability --json` exits 2 and writes an object, not the
array of specs:

```json
{ "error": "No knowledge graph found. Run `harness graph scan` first." }
```

Two consequences worth knowing before reading the number:

- **A worktree borrows the main worktree's graph.** `resolveGraphDir` falls back
  to the main checkout when the local `.harness/graph` is missing, so a fresh
  worktree can report a verdict computed from a graph built days ago against a
  different tree. `harness graph scan` (~6s) rebuilds it locally first.
- **The `verified_by` half is effectively blind.** On a freshly scanned graph,
  42 of 43 requirement nodes carry `requires` (code) edges and **one** carries a
  `verified_by` (test) edge, so `coveragePercent` is ~2%. Only the default
  `minCoverage: 0` keeps that from failing the repo wholesale — do not set
  `traceability.minCoverage` without first checking what the edges actually say.

The single warn on `main` is spec drift, not a coverage gap: Success Criterion 2
of `docs/changes/canary-instrument/proposal.md` names the Python-era
`span_reader.read_traces()`, while the shipped export is `readTraces()` in
`agents/skills/claude-code/canary-instrument/scripts/span_reader.mjs`, tested in
`agents/skills/test/canary-instrument.test.ts`. `docs/changes/**` is a **dated
record** — the same exclusion `ts/test/harness-config-doc-claims.test.ts` makes
— so it is not rewritten to match today's names. Expect that warning to persist;
it is now the check's one real finding rather than the only sign it ever ran.
`ts/test/traceability-abstention.test.ts` holds the mechanical claims above —
originally that no workflow built the graph, now that exactly one does and that
the summariser abstains without it.

**`roadmap sync` requires `--no-state-change` (#595).** It is deliberately
absent from the table above — no workflow runs it, and none should. Run it only
through `node scripts/roadmap-sync.mjs`, which appends the flag unconditionally;
`ts/test/roadmap-sync-guard.test.ts` fails any executable surface that invokes
the bare command.

The flag is upstream's CI-safe mode: planning fields and labels converge, but no
issue's open/closed state is patched. Without it, `statusMap` maps a roadmap row
of `done` to a **closed** issue, so a hand-edited row that drifts ahead of
reality can close someone's open bug, and `reverseStatusMap` reopens one the
other way. Closure belongs to the PR-merge auto-done path, which is tied to work
actually landing.

Two related facts worth not rediscovering:

- A row links to a ticket through `- **External-ID:** github:owner/repo#N`, an
  _optional extended field_ serialized beside
  `Assignee`/`Priority`/`Updated-At`. It is not one of the five documented
  fields (`Status`, `Spec`, `Summary`, `Blockers`, `Plan`), so it is easy to
  conclude no link field exists. All 51 rows carry one — 47 as of #628, plus the
  three added for #626/#590/#629, then #481/#544/#590 archived and
  #633/#634/#638 filed in their place — and `Priority`, serialized in that same
  extended group, is populated on every one of them.
- `tracker.labels` in `harness.config.json` filters sync to `harness-managed`.
  Before the linked issues were labelled it examined **2 of 30** — an
  effectively blind gate that reported a real number nobody read. All 51 rows
  now carry an `External-ID` (#596, #601–#619, #628, #626/#590/#629) and sync
  reports `would create 0`. `scripts/roadmap-denominator-check.mjs` now keeps it
  that way: the wrapper runs it before every sync, and it exits 3 unless
  **every** linked row points at a labelled issue — naming the blind ones, not
  counting them. **Adding a row therefore means labelling its issue in the same
  change**, or the check flips a green repo to abstaining. The invariant is
  exact rather than a coverage ratio on purpose (51 of 52 open issues carry the
  label today; the one that does not is #587, an upstream harness defect this
  repo tracks but cannot schedule), so a floor would either sit low enough to
  miss the 2-of-30 case or fire on every new bug report. **The invariant runs
  one way only — row → labelled issue — so the two inverse drifts are unguarded
  and have both happened: a row outliving its closed issue (the #481, #544 and
  #590 rows still read `backlog`/`in-progress` hours after the work merged) and
  a labelled issue with no row (#638, filed labelled and rowed only later).
  Neither moves the check off exit 0.** Grooming after a merge is therefore a
  manual step with no gate behind it: run
  `node scripts/roadmap-groom.mjs --apply` once the row's `Status` is `done`. An
  unreadable tracker exits 3 as well — cannot-verify is a finding, not a skip.
  `HARNESS_BIN` skips the preflight for the offline contract tests, and says so
  on stderr rather than skipping silently.
- **`--apply` replaces issue bodies, and no flag disables it.** `updateTicket`
  sets `patch.body` from the row's `Summary`, so patching a linked issue
  overwrites whatever a human wrote there with the roadmap's one paragraph. With
  every row linked, one `--apply` would flatten 47 issue bodies — the evidence
  in #486, the design notes in #591–#594, the provenance in #601–#619.
  `--no-state-change` guards open/closed only. This is why #601–#619 were filed
  directly rather than through sync's create path: the command has no
  create-only mode, so creating 19 would have meant patching 19. The wrapper
  therefore **refuses `--apply` unless `--i-know-this-rewrites-bodies` is also
  passed** — a speed bump rather than a prohibition, since pushing the roadmap
  over the tracker is a legitimate thing to decide once it is decided rather
  than defaulted into. Exits 2 without it, before spawning anything.

**Every field value is ONE physical line, and the roadmap files are therefore
prettier-exempt (#628, #630).** Harness's roadmap parser reads a
`- **Key:** value` field by taking one line. Wrap the value and it keeps the
first line and silently discards the rest — no error on either side. Measured
before the fix: a `shard` + `regen` round-trip took the file from **40,525 bytes
to 11,640**, 71% of it gone, while the file looked maintained the whole time.

The contract covers `docs/roadmap.md` **and `docs/roadmap-archive.md`**, because
`scripts/roadmap-groom.mjs` moves rows between them verbatim. Guarding only the
first left the archive in exactly the broken shape the guard exists to remove —
measured 2026-08-08, 60 of its 63 rows carried a wrapped `Summary` and
`prettier --check` reported the file clean while holding it that way. A row
moved back into `docs/roadmap.md` for reopened work would have returned
truncated (#630).

Five things keep it correct, and they are not interchangeable:

- Both files are listed in `.prettierignore`. This is not tidiness and not dead
  config. `.harness/hooks/quality-warner.js` runs `prettier --check` on **every
  file written in this repo** and blocks on violation, and prettier's
  `proseWrap: "always"` treats a long single-line field as a violation — so
  without that entry the hook makes a correct roadmap literally unwritable, and
  pushes any edit back to the broken shape. That is what kept the file drifting.
  **The exemption is resolved relative to the current working directory** —
  prettier looks for `.prettierignore` in the CWD, so `npx prettier --write`
  from `ts/` reflows the roadmap as if the entry did not exist. Run prettier
  from the repo root, and never point it at this file.
- `ts/test/roadmap-field-contract.test.ts` is the only thing that **fails** on a
  wrapped field, and it asserts its denominator twice over: a scan matching zero
  fields is an abstention rather than a pass, _and_ the number of fields
  inspected must equal the number of field-shaped lines. Non-zero only proves
  the scanner ran; the equality proves it ran over everything, which is what
  catches a demoted `####` row heading, a `*` bullet, or an indented field
  hiding a wrapped value beneath it.
- **The test derives its file list from `.prettierignore` rather than naming
  files (#630).** It globs the `docs/roadmap*` entries there and scans each —
  that prefix, not a broad `docs/`, so exempting an unrelated doc from
  prose-wrap does not enrol it in a guard demanding roadmap grammar. So the
  exempted set and the guarded set are the same set _mechanically_ — a file
  cannot be exempted from prose-wrap without being enrolled in the guard, and
  there is no second list to forget. It additionally fails if a
  `docs/roadmap.d/` shard directory is committed without an ignore entry, which
  is the one way new roadmap markdown could arrive unguarded.
- **A content floor catches truncation, which the wrap check structurally cannot
  (#630).** "Is the next line a continuation?" answers _no_ for a value cut down
  to its first physical line — one line, no continuation, spotless. So a
  `Summary` of ≥60 characters that ends mid-sentence (no sentence-final
  punctuation, no closing delimiter) is a violation naming its row. The floor
  abstains below 60 rather than guess, and applies to `Summary` only: `Spec`,
  `External-ID`, and `Blockers` legitimately end on any character, and a check
  that fires on correct content is a check that gets suppressed. A whole-file
  byte floor was rejected — a normal `roadmap-groom --apply` legitimately
  shrinks `docs/roadmap.md`, so the number would need raising to pass, and a
  floor that gets raised to pass is not a floor.
- **`docs/roadmap.md` depends on its `markdownlint-disable-file MD013` comment
  to keep a required check green.** No CI job _formats_ `docs/` — the format
  gate covers `ts/` and `agents/skills/` only — but `markdownlint` in
  `docs-lint.yml` _lints_ every markdown file in the repo with no path filter,
  and it is required in `.github/required-checks.json`. Unwrapping the fields
  took the file from 12 long lines to 51, so losing that comment turns a
  required check red and blocks every merge. The upstream roadmap serializer is
  known to strip the header block — via `promote` (#273) and via a `shard` +
  `regen` round-trip (#629, reproduced on CLI v10.2.0 and v11.1.1; reported
  upstream as `Intense-Visions/harness-engineering#1328`) — which is why the
  field-contract test asserts the directive is present rather than leaving it to
  the opt-in local pre-commit hook.
- **The comment block's second half is guarded separately, because losing it
  fails nothing.** The MD013 directive turns a required check red, so its loss
  announces itself; the machine-managed note below it is the only in-file record
  of why the file is prettier-exempt and must not be reflowed, and no gate reads
  it. `ts/test/roadmap-comment-guard.test.ts` asserts the note survives in the
  live file, pins the block `scripts/roadmap_comment_guard.mjs` restores to be
  byte-identical to it (a guard that restores a stale header is worse than
  none), and covers the guard's own contract — including the partial strip where
  the directive is pasted back by hand and the note stays gone.
- `scripts/roadmap-sync.mjs`, `scripts/roadmap-groom.mjs`, and
  `harness roadmap promote` write the file directly and bypass the hook. Any new
  writer must emit one-line fields.

If sharded output is ever committed, add `docs/roadmap.d` to `.prettierignore`.
That is the whole change: the guard reads that file, so every shard enrols
automatically and the exempted set and the guarded set cannot drift apart.

**Priority is `P0`–`P3`, populated, and validated on read (#628).** The enum is
fixed by the upstream harness schema, which hard-fails with
`Valid priorities: P0, P1, P2, P3` rather than warning — verified by injecting a
`P9`. Each level is a predicate you can evaluate against a row, not a mood:

| Value | The row qualifies when                                                                                        |
| ----- | ------------------------------------------------------------------------------------------------------------- |
| `P0`  | A check in `.github/required-checks.json` is red, is wrong, or would become wrong on merge.                   |
| `P1`  | Reproducible from a consumer-facing CLI or skill invocation, **or** it has an open PR or worktree.            |
| `P2`  | Enabler: at least two other rows name it as a blocker, or it de-duplicates an implementation across ≥3 sites. |
| `P3`  | Net-new capability; no other row depends on it.                                                               |

Seeded from blast radius — how far a failure reaches — so gate integrity
outranks consumer-facing correctness, which outranks enablers, which outrank
net-new. The seeding is a starting position, not a ranking anyone must defend:
the point of the field existing is that re-prioritising is now a one-line edit
instead of a re-derivation from issue bodies.

**Generated hooks carry local edits (#318 C).** Several hooks under
`.harness/hooks/` are **harness-generated** but hand-edited in canary (commit
`6be522e`): `quality-warner.js` blocks on real violations, `format-check.js`
targets the edited file (else the block is a no-op), and `telemetry-reporter.js`
is kept non-blocking. A `harness init`/regeneration would silently clobber
these. `scripts/check_hook_customizations.py` (run in `harness-quality.yml`, and
as a unit test) turns that into a **loud CI failure** — if it trips, re-apply
the edits from `git show 6be522e`. The durable fix is generator-side
preservation, filed upstream.

**Arch trend surface (#318 C).** `arch-snapshot.yml` runs
`harness snapshot capture` weekly and appends `.harness/arch/timeline.json` —
the architecture time-series that feeds `harness snapshot trends`, alongside the
`.harness/security/timeline.json` ledger refreshed by `harness-security.yml`.

**Ledger updates land on a standing branch, never on `main` directly (#548).**
Both workflows above commit to a fixed branch (`chore/arch-timeline`,
`chore/security-ledger`), force-update it each run, and write a compare link to
the job summary. **Opening the PR is a human step.** Two separate repo settings
force this shape, and both were discovered the hard way:

- Ruleset `16189198` on `main` carries a `pull_request` rule with
  `bypass_actors: []`, so a direct push from any actor — `github-actions[bot]`
  included — is rejected with `GH013`. There are zero bot commits on `main` in
  the repo's history.
- `can_approve_pull_request_reviews` is `false` on this repo, so `gh pr create`
  from a workflow is refused with _"GitHub Actions is not permitted to create or
  approve pull requests"_ (run `30976556644`). Flipping it would also grant
  every workflow the ability to approve PRs, so it stays off.

Both workflows previously pushed straight to `main` and swallowed the rejection
with `|| echo`, reporting success while delivering nothing.
`ts/test/workflow-false-green.test.ts` fails the build if any of those patterns
return, including a side-branch push that does not announce itself.

## Agent Behavior

### Branch Hygiene Before Code Changes

Before making any code changes, check the current branch:

1. Run `git branch --show-current` (or equivalent) to identify the active
   branch.
2. If the current branch is `main`:
   - Do **not** start writing or modifying code yet.
   - Propose a branch name following the [Branch Naming](#branch-naming)
     convention based on what the user is asking for.
   - Ask: _"You're on `main`. Should I create branch `<suggested-name>` for this
     work?"_
   - Wait for confirmation, then create and switch to the branch before
     proceeding.
3. If already on a feature/fix/chore branch, proceed normally.

This applies to code changes. Commits that are purely documentation-only (e.g.,
updating `AGENTS.md`, `README.md`) may be made directly to `main` if the user
has not indicated otherwise.

### No silent abstention (the denominator rule)

**A check that verified zero items has abstained, not passed.** This is the
project's most-violated invariant and the reason for issue #508: canary ran
effectively broken in a consuming repo for ~7 weeks while every surface reported
green.

Every gate, doctor check, and analysis command must:

1. **report its denominator** — how many items it actually verified; and
2. **treat denominator-zero as a distinct, loud outcome** — exit `3` for gates,
   an unmissable warning line for advisory commands.

"Skipped" never aggregates into "passed". See
[ADR 0009](docs/knowledge/decisions/0009-exit-3-reserved-for-abstained.md) for
the exit-code vocabulary and
[ADR 0010](docs/knowledge/decisions/0010-conformance-registry-as-gate-registry.md)
for how it is enforced. The concrete shapes this has taken here — each with the
PR that found it — are catalogued in
[false-green detection](docs/knowledge/gates/false-green-detection.md); the arch
gate's own reading traps are in
[arch baseline semantics](docs/knowledge/gates/arch-baseline-semantics.md).

The two traps, both of which have bitten this repo:

- **The denominator is not the finding count.** Zero flaky tests across 500 runs
  is a genuine clean fleet; zero across zero runs is an absent measurement. If
  you key the abstention off `findings.length`, you will nag on exactly the
  repos doing best — and a tool that nags gets muted.
- **Unknown is not zero.** A surface that _cannot_ determine its denominator
  reports unknown (`precision: null`, an optional `countRuns?()`) and does not
  abstain. Inventing an abstention is its own dishonesty.

#### New-gate checklist

A new gate is **not done** until every box is ticked:

- [ ] The command returns a `GateResult` (`{ checked, findings, skipped? }`) and
      routes its summary line + exit code through `gateOutcome` — the engine
      helper in `ts/src/core/gate-result.ts`. Never re-derive the decision.
- [ ] It is classified **gate** (exit-code contract → exit 3) or **advisory**
      (warn loudly, exit 0), and the classification is defensible out loud.
- [ ] The abstention output names **why** the denominator collapsed and the
      **first fix step**. A bare "abstained" is half a bug report.
- [ ] `--json` carries `checked` and `abstained` additively. If the payload is a
      bare array with nowhere to put them, leave stdout parseable and put the
      notice on **stderr**.
- [ ] It has a **row in the conformance registry** for its layer, whose fixture
      collapses the denominator through the **real command** and asserts both
      the loud outcome and the absence of the old success copy.
- [ ] A **control test** proves a non-zero denominator still renders the normal
      result — otherwise you have traded a false green for a false alarm.
- [ ] Any existing test that asserted the old silent green is **rewritten, not
      deleted**. Those pins are where the bug was ratified; losing them loses
      coverage of the real clean path.

Registry files, one per runtime layer:

| Layer  | Registry                                         |
| ------ | ------------------------------------------------ |
| engine | `ts/test/gate-conformance.test.ts`               |
| npm    | `npm/scripts/__tests__/gate-conformance.test.js` |
| skill  | `agents/skills/test/gate-conformance.test.ts`    |

Skill CLIs are self-contained and cannot import the helper; they mirror its
wording via a local `ABSTAINED_LINE` and are held to it by their registry.

### Three test-design rules (the shape a user hits, not the shape you had in mind)

Three rules, each drawn from a specific shipped bug. They share one theme: the
tests exercised the shape the author was thinking about, and the failure lived
in the shape a user actually hits. All three are cheap reviewer questions; the
third column says which are mechanically enforced today, so nobody assumes a
rule is covered by CI when it is a habit, or re-implements one that already
runs.

| Rule                                         | Came from | Enforcement today                   |
| -------------------------------------------- | --------- | ----------------------------------- |
| 1. Every default needs a test that omits it  | #369      | **Review question.** Not automated. |
| 2. Anything persistent needs a removal test  | #456      | **Review question.** Not automated. |
| 3. Fixtures need one case at realistic scale | #457      | **Partly automated** — see below.   |

#### 1. Every default must have a test that omits the flag

`pr-check --diff` defaulted to a bare `git diff` — working tree vs. index, which
is **empty on a clean CI checkout**. Every existing test passed a diff
explicitly via `--diff -`, so **the default path had no coverage at all**, and
the gate silently scoped zero paths and exited 0 across roughly five downstream
PRs.

For each CLI option with a fallback, write one test that **omits** it and
asserts the fallback's behaviour. Ask it in review even when the suite is green:
this class fails by _silence_ rather than by error, so nothing else surfaces it.

**Why it is still a review question.** It looks mechanical — enumerate options
with `.default(...)`, cross-reference against argv arrays in tests — and the
cross-reference is the part that does not hold up. A test can reach the default
path through a testkit helper, a fixture argv, or a `deps` override, and a
checker that reads argv arrays literally reports the well-tested commands as
uncovered. That is the `LINT-005` outcome (0-for-157 actionable) waiting to
happen, so it stays a question until someone can resolve "did any test take the
default path" without guessing. Tracked for a real answer rather than declared
done.

#### 2. Anything persistent needs a removal test

`mark-authored` wrote a sentinel and had a test proving it. Nothing tested that
it ever went away — so when the clearing half (`guardian_precommit.py`) was
deleted as dead code, a half-deleted contract survived a full language port and
**silently disabled Tier-2 authoring permanently** in any clone that used it.

For every artifact the engine creates on disk, write a test proving it is
removed or expires. The write half is the interesting-looking one to test; the
clear half is the one whose absence is invisible.

#### 3. Where output size scales with input, test one realistic upper bound

The guardian's sticky comment had no size cap. GitHub rejects a body over 65,536
characters and the post path reports that as "could not post", so on a large PR
the gate produced **nothing**. Every fixture had a handful of findings; a
downstream audit found a real 27,316-character comment (141 findings), already
42% of the ceiling.

**Partly automated.** `ts/test/guardian-comment-size-cap.test.ts` holds the
scaled fixture for the surface that was actually bitten. There is no general
checker, and a general one is probably the wrong shape — "output scales with
input" is a property of a specific surface, not a pattern a linter can spot.
When you add a surface whose output grows with its input, add its own scaled
fixture next to that one.

### Trusted MCP hierarchy

When a task can be done through an MCP tool, choose in this order and stop at
the first that fits:

1. **harness** — `mcp__harness__*` tools and harness skills. The first choice
   for any task with a harness equivalent (review, planning, validation,
   context, graph, etc.).
2. **canary** — the canary MCP bundle (`mcp__plugin_mcp-bundle_*`: canary,
   context7, playwright) and the `canary-*` skills. The first choice for
   anything **test-related** (generation, analysis, CI readiness, framework
   migration).
3. **Third-party MCP** — everything else (`gh`/GitHub, Atlassian, Gmail, Vercel,
   Supabase, …). Use **only** when no harness or canary option covers the task.

Before reaching for a third-party MCP, confirm no first-party (harness, then
canary) tool or skill fits. This is enforced advisorily by the
`prefer-first-party-mcp` PreToolUse hook, which injects a reminder when a
third-party MCP tool is invoked (it never blocks). See also the global
instruction to prefer harness-engineering and canary skills.

---

## Development Workflow

### First-time clone setup

Run once after cloning to activate the shared pre-commit hook:

```bash
git config core.hooksPath .githooks
```

The hook (`.githooks/pre-commit`) does two things automatically on every commit:

- Runs `markdownlint` on staged `.md` files — catches MD040 and other violations
  before they reach CI.
- Re-runs `python3 scripts/security_ledger.py` whenever non-ledger files are
  staged — keeps the security ledger fresh without a manual step.

### Quality gates

**The gates run from `ts/`, and there are four of them.** Run each separately —
a chained one-liner hides which link failed, and silence means it did not run:

```bash
cd ts
npm run build         # tsc -p . + copy-data
npm run typecheck     # tsc --noEmit over tsconfig.check.json (src + test)
npm run format:check  # prettier
npm test              # vitest run --coverage
```

The typecheck gate reads `ts/tsconfig.check.json`, not `ts/tsconfig.json`. The
build config is emit-shaped (`rootDir: src`, `outDir: dist`) and so cannot also
cover `test/`; the check config extends it, adds the test tree, and emits
nothing. Only `test/fixtures/` is excluded — those files are deliberately broken
sample input for the scanners. See #759 and
`ts/test/typecheck-denominator.test.ts`, which fails if that exclusion widens.

There is **no `lint` gate** and no linter to run one: the repo uses no ESLint by
decision, and the `protect-config` hook blocks AI-authored linter configs.
Prettier is the formatting gate; markdown is gated separately by `docs-lint.yml`
via `markdownlint-cli`. `agents/skills/` carries its own `test` / `typecheck` /
`format:check` for the skill bundles.

**The repo root is not a gate surface.** There is no root `package.json` in this
repository — `/package.json` and `/package-lock.json` are gitignored as
per-machine markdownlint scratch (issue #244), because CI runs
`npx --yes markdownlint-cli` and never installs a root node project. A root
manifest you find in your checkout is a local file no review or CI job has ever
seen; #672 was one that still ran `ruff check agent tests` long after `agent/`
was deleted in the v6.0.0 cutover, so `npm run lint` at the root reported on
nothing. Ignore any root manifest, or delete it. The invariants are pinned by
`ts/test/root-manifest-not-a-gate.test.ts`.

### Workflow steps

1. **Requirement Analysis:** User provides natural language requirements.
2. **Classification:** Canary identifies the target testing framework and
   language using [ts/src/core/classifier.ts][classifier].
3. **Scaffolding:** Canary generates the initial test structure using
   [ts/src/core/scaffolder.ts][scaffolder].
4. **Execution:** Tests are executed via [ts/src/core/executor.ts][executor].
5. **Iteration:** Based on test results, the orchestrator handles self-healing
   using feedback from the executor.

## Key Agents

- **Canary:** The primary test generator.
- **Harness Sub-agents:** Used for architectural enforcement, planning, and
  verification of Canary's own codebase.

[wiki-home]: docs/wiki/Home.md
[arch-deep-dive]: docs/wiki/Architecture-Deep-Dive.md
[harness-int]: docs/wiki/Harness-Engineering-Integration.md
[llm-config]: docs/wiki/LLM-Providers-and-Configuration.md
[self-healing]: docs/wiki/Self-Healing-and-Feedback-Loop.md
[classifier]: ts/src/core/classifier.ts
[scaffolder]: ts/src/core/scaffolder.ts
[executor]: ts/src/core/executor.ts
[recommender]: ts/src/core/recommender.ts
[fw-registry]: ts/src/core/framework-registry.ts
[fw-json]: ts/src/data/frameworks/registry.json
