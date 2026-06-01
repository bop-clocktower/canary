---
project: oracle
version: 1
created: 2026-05-26
---

# Self-Heal Migration Specification (Phase 2)

Add a keyless self-heal surface for test repair via a new
`oracle-test-healer` agent and `/oracle-heal-test` slash command. The
CLI's existing self-heal loop in `orchestrator.py` remains in place —
Phase 3 will deprecate it alongside `oracle generate`.

## Overview

**Goals:**

1. **Keyless test repair** — A user with no provider API key can
   invoke `/oracle-heal-test <failing-test-path>` and get a working
   fix written to the file.
2. **Match CLI self-heal coverage** — Both the generic
   error-context-driven repair (`_attempt_fix`) and the
   selector-specific DOM-aware repair (`_attempt_selector_fix`) are
   reproducible via the slash command.
3. **Reuse existing patterns** — The agent uses the same heuristics
   already encoded in `agent/core/selector_healer.py` (selector
   extraction from error messages, DOM context from Playwright trace
   zips) — by documenting them, not by importing the class.
4. **Single-edit-point convention** — Future heal-class agents follow
   the same shape; rewriting the healer template doesn't propagate to
   N agent files.

## Success Criteria

1. `agents/oracle-test-healer.md` exists with `Read`,
   `Write`, `Edit`, `Glob`, `Grep`, `Bash`, and
   `mcp__oracle__oracle__analyze_file` authorized.
2. `commands/oracle-heal-test.md` exists, delegates
   to the healer agent, takes a test path + optional error output
   argument.
3. Invoking `/oracle-heal-test path/to/failing.spec.ts` against a
   genuinely-failing Playwright test — with NO provider key set —
   produces a fix that addresses the actual failure (verified
   subjectively against a known-bad fixture; not byte-stable).
4. Selector failures specifically: the agent extracts the failing
   selector from the error message and reads any Playwright
   `trace.zip` DOM snapshots before proposing a fix.
5. The CLI path (`oracle generate --run` → self-heal loop) is
   unchanged. `agent.core.orchestrator` continues to import and call
   `generate_response()` from `_attempt_fix` and
   `_attempt_selector_fix`.

## Scope

**In scope:**

- `agents/oracle-test-healer.md` — new agent.
- `commands/oracle-heal-test.md` — new slash command.
- `docs/adr/0002-self-heal-as-slash-command.md` — decision record
  (accepted on merge of this PR).
- `docs/adr/README.md` — index updated.
- `docs/specs/self-heal-migration.md` — this spec.
- `docs/plans/self-heal-migration.md` — task-by-task plan.
- `docs/changes/host-llm-migration/plans/<date>-phase-2-plan.md` —
  plan mirrored under the changes-tracking convention.
- `docs/roadmap.md` — Phase 2 progress noted under the migration
  item.

**Out of scope:**

- Removal of `_attempt_fix` / `_attempt_selector_fix` from
  `agent/core/orchestrator.py` — Phase 3 territory.
- Removal of `agent/core/selector_healer.py` — the slash-command
  agent _references_ the heuristics, not the class. Class stays.
- CI integration of `/oracle-heal-test` (auto-trigger on test
  failure) — separate piece of work, deferred until usage proves
  out.
- Performance benchmarking of host-LLM self-heal vs CLI.

## Assumptions

- The host Claude Code session has access to a working LLM.
- The user invoking `/oracle-heal-test` provides the failing test
  path; the error output is either pasted as an argument or
  retrievable by re-running the test via the agent's `Bash` tool.
- Playwright trace zips, when present, live at the conventional
  `<project>/playwright-report/trace.zip` or
  `<project>/test-results/<test>/trace.zip` path. The agent uses
  `Bash` to `unzip` and `Read` to inspect snapshots.
- The agent never reads provider API keys from the environment.

## Architecture

```text
Before (Phase 1 — keyed CLI only):
  oracle generate --run "<prompt>"
   ↓
  OracleOrchestrator.run() → executes test → fails
   ↓
  _attempt_fix or _attempt_selector_fix
   ↓
  generate_response() → agent/llm/* → provider API ← requires API key

After Phase 2 (keyless slash command added alongside):
  /oracle-heal-test path/to/failing.spec.ts [error]
   ↓
  oracle-test-healer agent (Claude Code host)
   ├─→ oracle__analyze_file (MCP)         ← context
   ├─→ Read failing test + helpers/fixtures
   ├─→ Bash unzip trace.zip if present    ← DOM context for selector fails
   ├─→ classify failure (selector vs generic)
   └─→ generate fix in-session            ← uses Claude Code's own LLM, no key
        ↓ Write
       overwrites the test file

  CLI path unchanged:
  oracle generate --run …  → same self-heal loop as before (keyed)
```

## Agent outline

Five sections, mirroring `oracle-test-author`:

**Frontmatter:** `name: oracle-test-healer`. Description triggers on
phrases like "fix this failing test", "this test fails", "heal the
test". `tools` authorizes `Bash, Read, Write, Edit, Glob, Grep,
mcp__oracle__oracle__analyze_file`.

**Role:** Diagnose a consistently-failing test, propose a
deterministic fix, write it, optionally re-run to verify.

**When to use:** A test fails every run, the user has the error
output or knows where to find it, wants a fix.

**When NOT to use:**

- Test fails intermittently → `oracle-flake-hunter`.
- User wants new tests written → `oracle-test-author`.
- User wants review of passing tests → `oracle-test-reviewer`.

**Process:**

1. **Anchor:** locate the failing test file. If error output wasn't
   provided, run the test once via Bash to capture it.
2. **Diagnose:** classify the failure.
   - Selector-class signals (Playwright `TimeoutError`, `locator`,
     `page.click`, `strict mode violation`, `not attached`/`not
     visible`) → selector-fix path.
   - Everything else → generic-fix path.
3. **Gather DOM context (selector-fix only):** if a `trace.zip`
   exists at `playwright-report/` or `test-results/*/`,
   `Bash unzip -p` the trace, extract HTML snapshots from
   `snapshots/*.html`, truncate to ~3500 chars, pass to the LLM as
   context. (Mirrors `SelectorHealer.dom_context_from_report`.)
4. **Generate fix:** in-session, using the original code + error +
   DOM context (when present) + analyze_file output.
5. **Verify:** re-run the test via Bash. Report pass/fail.
6. **Self-check:** if still failing, surface the root cause to the
   user rather than retry blindly.

## Plan

See [`docs/plans/self-heal-migration.md`](../plans/self-heal-migration.md)
for the task-by-task implementation.

## Out of Scope

- CLI deprecation (Phase 3 territory).
- GitHub Action removal (Phase 4).
- New MCP tools beyond `oracle__analyze_file`.
- Performance benchmarks.
- Auto-trigger of `/oracle-heal-test` from a CI workflow.

## Open Questions

1. **Re-run strategy:** when the agent applies a fix and the test
   still fails, should it retry (capped at N attempts) or surface the
   error to the user? Recommend: surface, don't retry. The CLI's
   3-attempt loop exists because the CLI is non-interactive; the
   slash command runs in a conversation where the user can decide to
   retry with more context.
2. **Trace.zip detection:** the agent currently relies on hard-coded
   paths (`playwright-report/`, `test-results/`). Should it consult
   `playwright.config.*` to find the configured `outputDir` /
   `reportDir`? Recommend: not in Phase 2 — read the conventional
   paths first; only consult config if the conventional path is
   empty.
3. **Selector vs generic dispatch:** the agent's Phase 2 step 2
   classifies using regex-like prose patterns. Should this be a
   helper MCP tool? Recommend: not yet — the patterns are stable and
   short enough to embed in the agent instructions.

## Risks

- **Quality regression** vs. CLI self-heal — same risk as Phase 1.
  Mitigation: side-by-side check against a known-failing fixture.
- **DOM context not extracted** — if the agent skips the `unzip`
  step, selector fixes degrade to guesses. Mitigation: explicit
  step in the agent instructions; reviewer verifies during testing.
- **Fix loop never terminates** — agent applies a fix, test still
  fails, agent applies another, etc. Mitigation: explicit
  no-blind-retry rule in agent instructions.
