# Framework Registry Guide

The Framework Registry is Oracle's single source of truth for which testing frameworks exist, what they're good for, and how to invoke them. It lives in `agent/frameworks/registry.json` and is loaded by `FrameworkRegistry` (`agent/core/framework_registry.py`). Every framework choice in the Oracle pipeline resolves through this registry — no caller hard-codes framework names.

## Core Concepts

### 1. Registry as Contract

The classifier emits a `test_type` string. The recommender asks the registry for frameworks in that category. The contract: **every `test_type` the classifier can emit must resolve to at least one framework entry**. A null framework is treated as a registry bug and raises `ValueError` in the orchestrator — it never produces a silent fallback.

This is enforced in `tests/unit/test_orchestrator.py` — cases such as `test_api_prompt_resolves_to_real_framework` assert that an API-classified prompt resolves to a real framework (`pytest`), not silently to `framework=None`.

### 2. Entry Schema

Each entry in `frameworks[]` is a JSON object with these fields:

- **`name`** — unique identifier (e.g., `playwright`). Used as the key in code.
- **`display_name`** — human-readable name for output.
- **`category`** — primary category (e.g., `e2e_ui`, `python_unit`, `api`, `performance`). Matches a `test_type` from the classifier.
- **`categories`** *(optional)* — array of additional categories the framework also serves. Lookup matches either `category` or membership in `categories`.
- **`languages`** — list of programming languages supported.
- **`file_extensions`** — file extensions the generator should emit.
- **`file_patterns`** *(optional)* — discovery patterns for test runners (e.g., `test_*.py`).
- **`execution_command`** — shell template with `{file}` placeholder. `TestExecutor` substitutes the generated path; quoting is handled so paths with spaces are preserved as a single argv element.
- **`ecosystems`** — frameworks/runtimes this fits (e.g., `react`, `node`, `vite`).
- **`status`** — `preferred`, `supported`, or `legacy`. `get_preferred_by_category` returns the `preferred` entry first.
- **`maturity`**, **`community_size`** — qualitative ranking signals.
- **`recommended_for`**, **`strengths`**, **`avoid_when`** — free-form arrays surfaced in the recommender's reasoning string.

### 3. Lookup Surface

`FrameworkRegistry` exposes four lookup methods:

- `get_all_frameworks()` — full list
- `get_by_category(category)` — all matches in `category` or `categories`
- `get_preferred_by_category(category)` — `preferred` if present, else first match
- `find_by_name(name)` — exact-name lookup (used by `TestExecutor`)
- `match_by_language(language)` — all frameworks for a language

The recommender uses `get_by_category` followed by an internal selection step; the executor uses `find_by_name` to resolve the `execution_command`.

### 4. Categories Are Stable

Categories form the public contract between classifier and registry. Renaming a category (e.g., `e2e_ui` → `e2e`) requires a coordinated update in both the registry and the classifier, plus a test pass to confirm no `test_type` becomes orphaned.

## Adding a New Framework

### 1. Confirm the Category Exists

Check `get_by_category` against the existing registry. If you're adding a framework for a category that has no classifier path yet, you need to add the classifier rule first — frameworks without a routing path are dead entries.

### 2. Author the Entry

Add a new object to `frameworks[]` in `agent/frameworks/registry.json`. Required fields: `name`, `display_name`, `category`, `languages`, `file_extensions`, `execution_command`, `status`. Optional metadata fields are encouraged — they show up in the recommender's reasoning and help future maintainers.

### 3. Validate the Execution Command

The `{file}` placeholder is substituted as a single argv element — `TestExecutor` tokenizes the template with `shlex.split` *before* substitution, so paths with spaces are preserved intact. Prefer commands that don't require additional config files in the project root; if they do, document the prereq in `recommended_for` or `avoid_when`.

### 4. Update Tests

Add or extend the classifier↔registry contract test to cover the new category if applicable. The non-null resolution assertion is the gate — every `test_type` must resolve to at least one entry.

### 5. Sanity-Check the Generator

Run `python -m agent.cli generate "<prompt that should route to the new framework>"` and confirm the output has the right extension, the recommender chose your new entry, and `--execute` runs without setup errors.

## Failure Modes

- **No framework for `test_type`.** `OracleOrchestrator.run` raises `ValueError`. Fix: add an entry for that category, or change the classifier to emit a category that exists.
- **Multiple `preferred` entries in a category.** `get_preferred_by_category` returns the first match (registry order). Avoid this — keep at most one `preferred` per category.
- **`execution_command` missing `{file}`.** The executor will run with no file argument, which usually means the framework runs every test it can discover. Lint catches this if you add the corresponding test; otherwise it surfaces at first execution.
- **Stale entries.** A framework whose `status: preferred` is genuinely deprecated will be picked over a newer alternative. Demote to `legacy` rather than deleting if any generated tests still depend on it.

## Related

- [Orchestrator Guide](./orchestrator.md) — how the registry plugs into the pipeline
- [Oracle: Add Framework](../../agents/skills/claude-code/oracle-add-framework/SKILL.md) — agent-invokable flow for adding a framework end-to-end
