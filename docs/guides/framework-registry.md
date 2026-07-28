# Framework Registry Guide

The Framework Registry is Canary's single source of truth for which testing
frameworks exist, what they're good for, and how to invoke them. It lives in
`ts/src/data/frameworks/registry.json` and is loaded by `FrameworkRegistry`
(`ts/src/core/framework-registry.ts`). Every framework choice in the Canary
pipeline resolves through this registry — no caller hard-codes framework names.

## Core Concepts

### 1. Registry as Contract

The classifier emits a `test_type` string. The recommender asks the registry for
frameworks in that category. The contract: **every `test_type` the classifier
can emit must resolve to at least one framework entry**. A null framework is
treated as a registry bug and raises `ValueError` in the orchestrator — it never
produces a silent fallback.

This is enforced in `tests/unit/test_classifier_stage1_categories.py` —
`TestClassifierRegistryContract` asserts that (a) every `test_type` the
classifier can emit resolves to at least one framework, and (b) every
framework-name **hint** in `_FRAMEWORK_HINTS` routes to a category that resolves
to at least one framework. The second check guards against hint-only tools
degrading to an empty category: a hint that names a tool with no registry entry
(e.g. `cypress`, `jest`, `pa11y`, `percy`, `gatling`) is acceptable **only**
because it routes to a category served by an OSS default
(`cypress → e2e_ui → playwright`, `gatling → load → locust`, etc.).

A framework with **no** classifier routing path — neither a category keyword nor
a name hint — is a **dead entry**. Every registry addition must ship a reachable
path.

### 2. Entry Schema

Each entry in `frameworks[]` is a JSON object with these fields:

- **`name`** — unique identifier (e.g., `playwright`). Used as the key in code.
- **`display_name`** — human-readable name for output.
- **`category`** — primary category (e.g., `e2e_ui`, `api`, `performance`,
  `mobile`, `mutation`, `property`, `llm_eval`). Matches a `test_type` from the
  classifier.
- **`categories`** _(optional)_ — array of additional categories the framework
  also serves. Lookup matches either `category` or membership in `categories`.
  Example: `schemathesis` serves both `api` and `contract`, so the
  `schemathesis → contract` hint resolves.
- **`languages`** — list of programming languages supported.
- **`file_extensions`** — file extensions the generator should emit.
- **`file_patterns`** _(optional)_ — discovery patterns for test runners (e.g.,
  `test_*.py`).
- **`execution_command`** — shell template with `{file}` placeholder.
  `CanaryTestExecutor` substitutes the generated path; quoting is handled so
  paths with spaces are preserved as a single argv element.
- **`ecosystems`** — frameworks/runtimes this fits (e.g., `react`, `node`,
  `vite`).
- **`status`** — `preferred`, `supported`, or `legacy`.
  `get_preferred_by_category` returns the `preferred` entry first.
- **`maturity`**, **`community_size`** — qualitative ranking signals.
- **`recommended_for`**, **`strengths`**, **`avoid_when`** — free-form arrays
  surfaced in the recommender's reasoning string.

### 3. Lookup Surface

`FrameworkRegistry` exposes these lookup methods:

- `get_all_frameworks()` — full list
- `get_by_category(category)` — all matches in `category` or `categories`
- `get_preferred_by_category(category)` — `preferred` if present, else first
  match
- `find_by_name(name)` — exact-name lookup (used by `CanaryTestExecutor`)
- `match_by_language(language)` — all frameworks for a language
- `execution_info(name)` — the `{execution_command, ci_flags}` run-command
  metadata for one framework, or `None`
- `capabilities(name)` — the code-**derived** capability verdict for one
  framework (`{scaffold, execute, tier}`), or `None` (see
  [Capability tiers](#capability-tiers))
- `summaries()` — programmatic dump of every framework's identity + run-command
  fields, plus its `capabilities` and headline `tier`

The recommender uses `get_by_category` followed by an internal selection step;
the executor uses `find_by_name` to resolve the `execution_command`.

#### Run-command exposure (#357)

The registry is the authoritative **framework → run-command** source, surfaced
so downstream tools need not duplicate the map or read `registry.json` directly:

- **`canary recommend "<prompt>" --json`** now includes `execution_command` and
  `ci_flags` for the chosen framework (additive; existing fields unchanged).
- **`canary frameworks [--json]`** dumps every entry (`name`, `category`,
  `languages`, `file_extensions`, `execution_command`, `ci_flags`, `status`)
  plus its code-derived `capabilities` and headline `tier`.
- The MCP `list_frameworks` tool adds a `details` array with the same fields.

In every `execution_command`, **`{file}` is the placeholder for the test-file
path** — substitute it before running (e.g. `npx --yes playwright test {file}` →
`npx --yes playwright test tests/login.spec.ts`).

#### Capability tiers

The registry advertises more frameworks than canary can fully support, so
`capabilities(name)` reports an **honest, code-derived** support level rather
than the subjective `status`/`maturity` prose. Each signal is read from the code
that actually provides it, so the verdict cannot drift from reality:

- **`scaffold`** — a `Scaffolder` template exists
  (`scaffolder.scaffoldable_frameworks()`): canary can bootstrap the suite.
- **`execute`** — the entry carries a command the executor can actually **run**.
  Because `CanaryTestExecutor` substitutes only `{file}`, this is true iff the
  `execution_command` carries `{file}` or has no placeholder at all (a
  whole-suite runner). A command with a different placeholder (e.g. `zap`'s
  `{target}`) would reach the shell unsubstituted, so it is **not** counted as
  executable — the tier never claims more than the code can do.

The headline `tier` collapses these two adopter-facing signals:

| Tier         | Meaning                                                  |
| ------------ | -------------------------------------------------------- |
| `full`       | scaffold **and** execute — canary sets it up and runs it |
| `executable` | execute only — canary runs it, no scaffold boilerplate   |
| `catalog`    | neither — listed for detection/recommendation only       |

As of this writing: 5 `full`, 16 `executable`, 6 `catalog` across 27 entries.
(Static analysis is deliberately **not** a tier signal: the linter's core scans
apply across frameworks rather than being gated per-framework, so it is not a
per-framework differentiator.)

Picking an `executable`/`catalog` framework for `canary init` (or
`canary migrate`) **degrades loudly** — `init`/MCP return actionable guidance
plus the run command, and `migrate` records a manual follow-up instead of
reporting a false "Migration complete" — rather than crashing or silently
no-op'ing. An adopter never hits a silent stub. A framework not in the registry
at all is genuinely invalid input and still raises `ValueError`.

Drift is prevented by `tests/unit/test_framework_capability_tiers.py`: it
derives every tier from the code signals and fails if a scaffold template names
a framework with no registry entry, if any registered framework has no derivable
capability, or if a framework is scaffoldable-but-not-runnable (a quadrant the
tier logic has no name for). The matrix is never hand-maintained.

### 4. Categories Are Stable

Categories form the public contract between classifier and registry. Renaming a
category (e.g., `e2e_ui` → `e2e`) requires a coordinated update in both the
registry and the classifier, plus a test pass to confirm no `test_type` becomes
orphaned.

## Adding a New Framework

### 1. Confirm the Category Exists

Check `get_by_category` against the existing registry. If you're adding a
framework for a category that has no classifier path yet, you need to add the
classifier rule first — frameworks without a routing path are dead entries.

### 2. Author the Entry

Add a new object to `frameworks[]` in `ts/src/data/frameworks/registry.json`.
Required fields: `name`, `display_name`, `category`, `languages`,
`file_extensions`, `execution_command`, `status`. Optional metadata fields are
encouraged — they show up in the recommender's reasoning and help future
maintainers.

### 3. Validate the Execution Command

The `{file}` placeholder is substituted as a single argv element —
`CanaryTestExecutor` tokenizes the template with `shlex.split` _before_
substitution, so paths with spaces are preserved intact. Prefer commands that
don't require additional config files in the project root; if they do, document
the prereq in `recommended_for` or `avoid_when`.

### 4. Update Tests

Add or extend the classifier↔registry contract test to cover the new category if
applicable. The non-null resolution assertion is the gate — every `test_type`
must resolve to at least one entry.

### 5. Sanity-Check the Generator

Run the `/canary-write-test` slash command in Claude Code with a prompt that
routes to the new framework.

Confirm the output has the right extension and the recommender chose your new
entry.

## Failure Modes

- **No framework for `test_type`.** `CanaryOrchestrator.run` raises
  `ValueError`. Fix: add an entry for that category, or change the classifier to
  emit a category that exists.
- **Multiple `preferred` entries in a category.** `get_preferred_by_category`
  returns the first match (registry order). Avoid this — keep at most one
  `preferred` per category.
- **`execution_command` missing `{file}`.** The executor will run with no file
  argument, which usually means the framework runs every test it can discover.
  Lint catches this if you add the corresponding test; otherwise it surfaces at
  first execution. Exception: **mutation runners** (`stryker`, `mutmut`)
  legitimately run against the whole source tree from their own config, so their
  commands carry no `{file}` by design.
- **Stale entries.** A framework whose `status: preferred` is genuinely
  deprecated will be picked over a newer alternative. Demote to `legacy` rather
  than deleting if any generated tests still depend on it.

## Related

- [Orchestrator Guide](./orchestrator.md) — how the registry plugs into the
  pipeline
- [Canary: Add Framework][add-framework-skill] — agent-invokable flow for adding
  a framework end-to-end

[add-framework-skill]:
  ../../agents/skills/claude-code/canary-add-framework/SKILL.md
