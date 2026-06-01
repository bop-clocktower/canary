# ADR 0004 — Remove LLM Abstraction Layer (v3.0)

**Status:** accepted
**Date:** 2026-05-28
**Deciders:** Bri Stevenski (upstream maintainer)
**Supersedes:** ADR 0003 (deprecation phase — removal now complete)

## Context

ADR 0003 deprecated `oracle generate`, `oracle feedback`, and the GitHub Action
and committed to removing them at v3.0. That deprecation has been in place since
v2.x. This ADR records the actual removal.

## Decision

Remove all code that existed solely to serve the keyed CLI generation path:

| Deleted | Why |
| ------- | --- |
| `agent/llm/` (10 files, 5 providers) | Provider matrix — no longer needed |
| `agent/core/orchestrator.py` | LLM generation pipeline |
| `agent/core/selector_healer.py` | DOM-aware selector fix path (used only by orchestrator) |
| `agent/core/feedback.py` | Generate-run artifact recording |
| `action.yml` | GitHub Action that wrapped `oracle generate` |
| `tests/unit/test_factory.py` | 16 tests |
| `tests/unit/test_providers.py` | 12 tests |
| `tests/unit/test_orchestrator.py` | 15 tests |
| `tests/unit/test_selector_healer.py` | 5 tests |
| `tests/unit/test_feedback.py` | n tests |

CLI changes in `agent/cli.py`:

- `generate()` removed. The `--recommend-only` logic is preserved as a
  standalone `oracle recommend "<prompt>"` command — it is keyless, calls only
  the classifier + recommender, and is used as the post-migration smoke check.
- `feedback()` removed.

`agent/core/migrator.py`: smoke-check instruction updated from
`oracle generate --recommend-only` to `oracle recommend "<description>"`.

`pyproject.toml`: `anthropic`, `openai`, `google-genai` removed from
`dependencies`. Version bumped to `3.0.0`.

## Consequences

**Net result:** ~2,000 LOC removed. `pipx install oracle-test-ai` closure
shrinks by ~50 MB (no provider SDKs). 48 tests removed; 460 remaining, all
covering non-LLM commands.

**Generation path:** `/oracle-write-test` slash command (Claude Code plugin) is
the supported replacement. It runs in the host session with no API key.

**Framework recommendation:** `oracle recommend "<prompt>"` replaces
`oracle generate --recommend-only`. Same classifier + recommender output,
now a first-class command rather than a flag on a deprecated command.

**Company knowledge injection:** the `--- COMPANY KNOWLEDGE ---` block that
`CanaryOrchestrator` appended to generation prompts is now the responsibility
of the slash command layer. The `/oracle-write-test` command invokes
`oracle company-knowledge show` and prepends the output to its context.
`agent/core/company_knowledge.py` and `oracle company-knowledge show` are
unaffected — they are not part of the LLM layer.

**GitHub Action:** `action.yml` removed. The Action called `oracle generate`
which no longer exists. Downstream consumers should migrate to the Claude Code
plugin path.

## Reversibility

Low — this is a major version bump. Reverting requires restoring all deleted
files and bumping back to 2.x.
