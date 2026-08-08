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
  `skills list`, `env-setup` (alias for `setup`), `version`.

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
  `npm/package.json` and `pyproject.toml`. A `chore(release)` bump must touch
  **all four**; `tests/unit/test_version_consistency.py` fails CI if they drift.
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
  history store, and `analysis/`.
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
| `validate`         | `harness-architecture.yml`, `harness-security.yml` |
| `check-deps`       | `harness-architecture.yml`, `harness-security.yml` |
| `check-security`   | `harness-security.yml`                             |
| `check-docs`       | `harness-quality.yml`                              |
| `cleanup`          | `harness-quality.yml`                              |
| `check-phase-gate` | `harness-quality.yml`                              |
| `check-arch`       | `refresh-arch-baseline.yml`                        |
| `snapshot capture` | `arch-snapshot.yml`                                |

**Pinning (#318 A).** Every gate installs the CLI at a **pinned major** via one
workflow-level env var — `HARNESS_CLI: '@harness-engineering/cli@10'` — rather
than an unpinned `@latest`. A harness-major bump (e.g. a subcommand rename) is
therefore a **deliberate PR** that edits that one line per workflow, not a
silent CI break with nothing to roll back to.

Bumping the major is a **three-step sequence**, in this order (#545, #547):

1. **Reconcile `harness.config.json` against the new major's schema first.** Zod
   strips unknown keys silently, so a key at a path the schema stopped reading
   is dead with no error — that is how `entryPoints` left the entropy scan with
   no entry point across every run it ever made. Land the config fix on the
   _old_ pin, verified against both majors, so a later regression has an
   unambiguous blame boundary.
2. **Edit `HARNESS_CLI` in all six workflows** — `harness.yml`,
   `harness-quality.yml`, `harness-architecture.yml`, `harness-security.yml`,
   `arch-snapshot.yml`, `refresh-arch-baseline.yml`.
3. **Re-verify every subcommand in the table above on both majors**, comparing
   exit code _and_ output, not just exit code. The gates run the CLI on a bare
   checkout with no `npm ci`, so a local worktree reproduces CI exactly.

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
  conclude no link field exists. All 50 rows carry one — 47 as of #628, plus the
  three added for #626/#590/#629 — and `Priority`, serialized in that same
  extended group, is populated on every one of them.
- `tracker.labels` in `harness.config.json` filters sync to `harness-managed`.
  Before the linked issues were labelled it examined **2 of 30** — an
  effectively blind gate that reported a real number nobody read. All 50 rows
  now carry an `External-ID` (#596, #601–#619, #628, #626/#590/#629) and sync
  reports `would create 0`. `scripts/roadmap-denominator-check.mjs` now keeps it
  that way: the wrapper runs it before every sync, and it exits 3 unless
  **every** linked row points at a labelled issue — naming the blind ones, not
  counting them. **Adding a row therefore means labelling its issue in the same
  change**, or the check flips a green repo to abstaining. The invariant is
  exact rather than a coverage ratio on purpose (50 of 51 open issues carry the
  label today; the one that does not is #587, an upstream harness defect this
  repo tracks but cannot schedule), so a floor would either sit low enough to
  miss the 2-of-30 case or fire on every new bug report. An unreadable tracker
  exits 3 as well — cannot-verify is a finding, not a skip. `HARNESS_BIN` skips
  the preflight for the offline contract tests, and says so on stderr rather
  than skipping silently.
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

**Every field value is ONE physical line, and `docs/roadmap.md` is therefore
prettier-exempt (#628).** Harness's roadmap parser reads a `- **Key:** value`
field by taking one line. Wrap the value and it keeps the first line and
silently discards the rest — no error on either side. Measured before the fix: a
`shard` + `regen` round-trip took the file from **40,525 bytes to 11,640**, 71%
of it gone, while the file looked maintained the whole time.

Four things keep it correct, and they are not interchangeable:

- `docs/roadmap.md` is listed in `.prettierignore`. This is not tidiness and not
  dead config. `.harness/hooks/quality-warner.js` runs `prettier --check` on
  **every file written in this repo** and blocks on violation, and prettier's
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
- **`docs/roadmap.md` depends on its `markdownlint-disable-file MD013` comment
  to keep a required check green.** No CI job _formats_ `docs/` — the format
  gate covers `ts/` and `agents/skills/` only — but `markdownlint` in
  `docs-lint.yml` _lints_ every markdown file in the repo with no path filter,
  and it is required in `.github/required-checks.json`. Unwrapping the fields
  took the file from 12 long lines to 51, so losing that comment turns a
  required check red and blocks every merge. `harness roadmap promote` is known
  to strip it (#273), which is why the field-contract test asserts the comment
  is present rather than leaving it to the opt-in local pre-commit hook.
- `scripts/roadmap-sync.mjs`, `scripts/roadmap-groom.mjs`, and
  `harness roadmap promote` write the file directly and bypass the hook. Any new
  writer must emit one-line fields.

If sharded output is ever committed, extend the `.prettierignore` entry and that
test's file list **together, in one change** — the exempted set and the guarded
set must stay the same set.

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
[ADR 0009](docs/adr/0009-exit-3-reserved-for-abstained.md) for the exit-code
vocabulary and
[ADR 0010](docs/adr/0010-conformance-registry-as-gate-registry.md) for how it is
enforced.

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
