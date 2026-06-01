---
project: oracle
version: 1
created: 2026-05-22
---

# Host-LLM Generation Migration Specification

Move Oracle's LLM-dependent generation tasks out of the keyed CLI path
and into the host Claude Code session. Phase 1 (this spec) covers
`canary-test-author`. Later phases (separate specs) cover self-heal,
the CLI itself, and the GitHub Action.

## Overview

**Goals:**

1. **No API key required to use the plugin** — A user with no
   `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` set can
   install Oracle as a Claude Code plugin and invoke
   `/canary-write-test` end-to-end, producing a runnable test file.
2. **Match CLI output quality** — The host-LLM-generated test is at
   least as good as `canary generate` produces today against the same
   prompt + repo state, where "as good" means: same framework
   detection, same idiom usage, same fixture reuse, same conformance
   to existing test conventions in the repo.
3. **Preserve repo grounding** — All five context signals the CLI
   injects today (project metadata, existing test patterns, domain
   knowledge, fixtures, company knowledge) are available to the host
   agent.
4. **Single edit point** — Future agents added under
   `agents/` follow the same pattern; rewriting one
   skill template doesn't propagate to N agent files.

## Success Criteria

1. `canary-test-author.md` no longer contains the string
   `canary generate` in its Phase 2 process.
2. Invoking `/canary-write-test "Test the login flow"` against a fresh
   playwright project — with NO provider key in the environment —
   produces a `.spec.ts` file at the conventional location.
3. The generated file imports the project's existing helpers when
   present (verified by a smoke test that seeds a project with a
   `tests/helpers/` directory and expects the output to import from it).
4. The generated file matches the project's preferred framework
   (verified by seeding a project with a `playwright.config.ts` and
   expecting playwright output, not pytest).
5. `agent.cli.generate` and `agent.core.orchestrator.OracleOrchestrator.run`
   are untouched by this migration — the CLI path continues to work
   for users who still want it.
6. No new MCP tool is required; the agent uses
   `oracle__analyze_file` for repo context and a write surface
   (decision in Open Questions below) for the output.

## Scope

**In scope:**

- `agents/canary-test-author.md` — rewritten to use
  host-LLM generation.
- `commands/canary-write-test.md` — verified unchanged
  (it just delegates to the agent); update only if the rewrite
  requires a different argument shape.
- `docs/specs/oracle-plugin.md` — sections claiming "no API key
  required" updated to reference this spec; sections describing
  `canary generate` delegation marked superseded.
- Smoke test that the host-LLM path works against a known prompt
  fixture (under `tests/integration/` if such a layout exists, else
  manual verification logged in the plan).
- `docs/adr/0001-host-llm-generation-for-agents.md` accepted as part
  of the merge.

**Out of scope:**

- `_attempt_fix` / `_attempt_selector_fix` in `orchestrator.py` —
  separate phase (and ADR).
- `canary-flake-hunter.md` agent — uses the selector heal loop; pulls
  in orchestrator changes that aren't in scope here.
- `canary generate` CLI deprecation — coupled to the GitHub Action
  removal; separate ADR.
- A new MCP tool for writing reports/artifacts — orthogonal.
- Performance benchmarking of host-LLM vs CLI generation — useful
  but not blocking.

## Assumptions

- The host Claude Code session has access to a working LLM (which is
  what makes "no API key" possible in the first place). If the user is
  running Claude Code, this is true by definition.
- `oracle__analyze_file` returns enough context for the host LLM to
  produce idiomatic output. If gaps are discovered, they're flagged
  in the plan as follow-up work, not blockers for this phase.
- The agent's `Read` and `Glob` tools (already authorized in the
  current `canary-test-author.md` frontmatter) are sufficient to
  read any repo files the LLM needs that aren't covered by
  `oracle__analyze_file`.
- The agent has the `Write` tool authorized (it does today).
- Users who want machine-readable reports (`--report-format sarif`,
  `--json`) continue to use the CLI for those. The slash command is
  optimized for the interactive case.

## Architecture

```text
Before:
  /canary-write-test "<prompt>"
   ↓
  canary-test-author agent (Claude Code host)
   ↓ Bash
  canary generate "<expanded prompt>"
   ↓
  agent/core/orchestrator.py → generate_response() → agent/llm/* → provider API
                                                                   ↑
                                                                   requires API key

After:
  /canary-write-test "<prompt>"
   ↓
  canary-test-author agent (Claude Code host)
   ├─→ oracle__analyze_file (MCP)   ← deterministic repo context
   ├─→ Read / Glob (tools)          ← extra context as needed
   └─→ generation in host session   ← uses Claude Code's own LLM, no API key
        ↓ Write (or oracle__write_test_file)
       tests/<framework-default>/<file>.spec.ts
```

## Agent rewrite outline

The current `canary-test-author.md` has five sections: Role, When to
use, When NOT to use, Process (Phases 1–3), Output expectations.
Only Phase 2 ("Generate") changes substantively.

**Phase 1 (Anchor in the repo)** — unchanged, this is repo discovery.

**Phase 2 (Generate)** — rewritten from:

```text
1. Expand the user's prompt with repo context (target URL, function
   signature, schema, etc.) so the CLI has enough to work with.
2. Delegate to the Oracle CLI when applicable:
       canary generate "<expanded prompt>"
3. Refine the CLI output against repo conventions — fix imports, swap
   selectors to the repo's preferred style, align fixture usage.
```

to:

```text
1. Call oracle__analyze_file on the target source file (or on the
   directory if the prompt is for a new module). Capture the returned
   framework, test_type, imports, functions, existing_tests, and
   context_snippets.
2. Expand the user's prompt with the analyze_file result + any
   additional context surfaced in Phase 1 (test conventions, fixtures,
   domain glossary).
3. Generate the test code directly. The host LLM session has access
   to the full file write tool stack; produce idiomatic code in the
   detected framework, using project conventions verbatim.
4. Self-check: does the output import a fixture that exists in
   existing_tests? Does it match the detected framework's idioms? If
   either fails, refine and regenerate before writing.
```

**Phase 3 (Write)** — unchanged in shape, but the implementation
clarifies: use `Write` for direct authoring; if parity with the CLI's
output shape is needed (telemetry, post-write hooks), use
`oracle__write_test_file` instead. Default to `Write` for simplicity.

## Context coverage matrix

Resolved as Task 1 of the implementation plan. The CLI orchestrator
(`OracleOrchestrator.run`) injects five context blocks into its
generation prompt; `oracle__analyze_file` only partially covers them.
Per-gap decision: (a) agent reads via `Read`/`Glob`, (b) extend
`analyze_file` later, (c) accept gap.

| Orchestrator block | `analyze_file` coverage | Decision |
| --- | --- | --- |
| metadata (`package.json`, `pyproject.toml`, `tsconfig.json`) | scans but doesn't surface fields | (a) agent reads files directly |
| patterns (existing test imports, naming) | only `common_imports` | (a) agent globs `tests/` + reads samples |
| domain (components, functions, modules) | only `functions[:10]` | (a) agent supplements via `Read` |
| fixtures (test helpers) | not called | (b) follow-up; agent globs `tests/helpers/` for now |
| company (`.canary/company.json`) | not loaded | (a) agent reads `.canary/company.json` |

Net: no MCP extension blocks this phase. The fixture gap is the
highest-value follow-up — projects with rich fixture libraries may
see quality differences vs CLI output until `analyze_file` is
extended.

## Plan

See [`docs/plans/host-llm-migration.md`](../plans/host-llm-migration.md)
for the task-by-task implementation.

## Out of Scope

- **Self-heal loop migration** — Phase 2 of this overall direction.
  Separate spec + plan + ADR.
- **CLI deprecation** — Phase 3.
- **GitHub Action removal** — Phase 4. Coupled to CLI deprecation.
- **Generation quality benchmarks** — would help validate Success
  Criterion 2 quantitatively, but the migration is judged subjectively
  on a first pass.
- **New MCP tools** — if `oracle__analyze_file` proves insufficient,
  extending it is preferable to adding new tools.

## Open Questions

1. **Write surface:** `Write` tool (simpler) vs.
   `oracle__write_test_file` MCP tool (consistent output dict shape,
   future hook points). Recommend `Write` for this phase; revisit if
   downstream consumers want the dict shape.
2. **Stale spec sections:** Should `docs/specs/oracle-plugin.md` be
   patched in this PR to remove its "Delegate to the Oracle CLI"
   wording, or should it be marked superseded as a whole and a new
   `oracle-plugin-v2.md` written? Recommend in-place patch — the rest
   of that spec is still accurate.
3. **Phase 1 (Anchor in the repo) parity:** The CLI's
   `OracleOrchestrator.run()` injects five context signals (metadata,
   patterns, domain, fixtures, company knowledge). Does the agent's
   `Phase 1 + oracle__analyze_file` cover all five? If not, the plan
   should add tasks to extend `oracle__analyze_file` or document
   acceptable gaps.

## Risks

- **Quality regression** — host LLM may produce subtly different code
  than the CLI's hand-tuned prompt. Mitigation: side-by-side test
  against the four shipped example prompts; iterate the agent
  instructions until parity.
- **Context shortfall** — `oracle__analyze_file` may not surface
  enough information about the repo. Mitigation: the spec calls for
  the plan to verify before the migration lands; extend the MCP tool
  if needed.
- **User confusion during transition** — `canary generate` CLI
  continues to work; users will have two paths until deprecation.
  Mitigation: README and CLI help text point new users to
  `/canary-write-test`; deprecation comes later.
