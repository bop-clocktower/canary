# ADR 0003 — Deprecate `oracle generate` CLI and the GitHub Action

**Status:** accepted
**Date:** 2026-05-26
**Deciders:** Bri Stevenski (upstream maintainer)
**Supersedes:** none (the original GitHub Action roadmap entry stands
as historical record)
**Related:** [ADR 0001](0001-host-llm-generation-for-agents.md),
[ADR 0002](0002-self-heal-as-slash-command.md), roadmap item _"Migrate
all LLM-dependent tasks to keyless slash commands"_

## Context

Phases 1 and 2 of the host-LLM migration moved test generation (via
`/oracle-write-test`) and test repair (via `/oracle-heal-test`) into
the host Claude Code session — no provider API key required for
plugin users.

What remains in the keyed path:

- **`oracle generate` CLI** (`agent/cli.py:generate`) — calls
  `CanaryOrchestrator.run()` which calls `generate_response()` →
  `agent/llm/*` providers → requires `ANTHROPIC_API_KEY` /
  `OPENAI_API_KEY` / `GEMINI_API_KEY`.
- **GitHub Action** (`action.yml`) — wraps `oracle generate` for
  on-PR auto-generation. Same key requirement, surfaced as the
  `api-key` input.
- **`oracle feedback` CLI** — surfaces the GitHub issue URL for the
  last `oracle generate` run. Tied to the generate command's
  artifact (`.oracle/last_generation.json`); has no analog meaning
  in the plugin path.

These paths are functionally superseded but not yet removed. Leaving
them in indefinitely creates two problems:

1. **Bait-and-switch risk** for new users — `oracle generate` looks
   like the main entry point in the README. Without a clear
   deprecation signal, users invest time configuring keys and writing
   automation around it before discovering the keyless plugin path.
2. **Maintenance debt** — the `agent/llm/*` provider matrix (5
   providers), `CanaryOrchestrator.run()`, the self-heal loop, and
   `SelectorHealer` exist only to serve the keyed CLI path. After
   removal these can all go, dropping ~2,000 LOC + 4 dependency lines
   from `pyproject.toml`.

## Decision

Deprecate `oracle generate`, `oracle feedback`, and the GitHub
Action in this release. Removal happens at the next major version
bump (v3.0).

**This phase adds visible deprecation signals; no code is removed.**

Concretely:

- `oracle generate` prints a deprecation warning to stderr on every
  invocation that uses the LLM (i.e., not `--recommend-only`, which
  stays keyless). Warning points users at `/oracle-write-test`.
- `oracle feedback` prints a deprecation warning. Tied to generate;
  removed at the same time.
- `action.yml`'s `description` field is prefixed with
  `[DEPRECATED — removed in v3.0]` and directs users to the plugin.
- The deprecation warning lands on stderr so `--json` output on
  stdout stays clean for any pipeline still parsing it.
- `--recommend-only` does **not** print the warning — that path
  doesn't call the LLM, has no API key requirement, and remains
  useful as a quick classifier check.

What is **not** in this phase:

- No code deletion from `agent/cli.py`, `agent/core/orchestrator.py`,
  `agent/llm/*`, or `agent/core/selector_healer.py`.
- The Action's `action.yml` still functions; only the description is
  marked.
- No removal of `agent/core/feedback.py`'s module-level functions —
  only the CLI command surface is deprecated.

Removal is staged to a future ADR (0004 or later) once usage telemetry
or a deliberate cutoff justifies the major-version bump.

## Consequences

### Immediate

- Every `oracle generate` invocation (except `--recommend-only`)
  prints a one-line yellow warning on stderr pointing to the
  slash-command alternative.
- Anyone reading `action.yml` in GitHub's Action marketplace listing
  sees `[DEPRECATED — removed in v3.0]` prefixed on the description.
- The plugin path (`/oracle-write-test`, `/oracle-heal-test`) is
  positioned as the supported migration target.

### Follow-on

- **Removal ADR (0004 or later)** when major-version bump is
  approved. Deletes:
  - `agent/cli.py:generate()`, `feedback()`
  - `CanaryOrchestrator` and its self-heal loop
  - `agent/llm/*` (provider matrix)
  - `agent/core/selector_healer.py`
  - `action.yml`
  - All tests targeting the above
- **Dependency pruning** — `pyproject.toml` drops `anthropic`,
  `openai`, `google-genai`. Net reduction ~50 MB on `pipx install`
  closure.

### Risks

- **User confusion during transition** — two paths coexist
  (deprecated CLI + supported slash command). Mitigation: the
  warning explicitly points to the replacement; README still
  describes the keyed path but with a "deprecated" callout (separate
  doc PR, not blocking).
- **CI pipelines using the Action** continue to work; the deprecation
  is informational. Mitigation: deliberate — yanking the Action mid-
  cycle would break consumers. Removal happens at v3.0 with a
  RELEASE_NOTES entry.
- **`--recommend-only` keyless path is now the only keyless CLI
  invocation** — worth preserving even after generate is removed.
  Caller may want to extract it to its own command (`oracle recommend
  "<prompt>"`) in the removal phase. Tracked as an open question.

### Reversibility

High. Three small edits revert cleanly:

- Remove the `Console(stderr=True).print(...)` block from `generate`
- Remove the same from `feedback`
- Restore `action.yml`'s original description

No state migrates, no files move.

## Alternatives Considered

### Alternative 1: Remove immediately in this phase

Tempting given Phases 1–2 already provide keyless replacements.
Rejected because:

- Action consumers' CI workflows would break overnight.
- No major-version bump signal — surprise removal is bad versioning
  hygiene.
- Deprecation warnings give users a transition window they can
  observe in their own logs.

### Alternative 2: Soft-disable (always print warning, exit non-zero)

Forces migration but breaks CI. Rejected — same problem as Alt 1
without the benefit of a clean removal.

### Alternative 3: Hide commands behind a flag

`oracle generate` becomes available only if
`CANARY_ALLOW_DEPRECATED=1` is set. Effective but invasive — touches
the Typer command registration, complicates `--help` output. Rejected
for this phase; reasonable for the removal phase if a long
"deprecated-but-available" window is wanted.

### Alternative 4: Do nothing, let the docs speak

The README already mentions the plugin path. Rejected — runtime
warnings reach users who never re-read the README.

## References

- Code: `agent/cli.py:generate`, `agent/cli.py:feedback`
- Code: `action.yml`
- ADR 0001: `docs/adr/0001-host-llm-generation-for-agents.md`
- ADR 0002: `docs/adr/0002-self-heal-as-slash-command.md`
- Spec: `docs/specs/cli-deprecation.md`
- Plan: `docs/plans/cli-deprecation.md`
- Roadmap: "Migrate all LLM-dependent tasks to keyless slash
  commands"
