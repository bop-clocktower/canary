# ADR 0001 — Host-LLM generation for agents (no API key path)

**Status:** accepted
**Date:** 2026-05-22 (proposed) / 2026-05-26 (accepted)
**Deciders:** Bri Stevenski (upstream maintainer)
**Related:** roadmap item _"Migrate all LLM-dependent tasks to keyless
slash commands"_; downstream agent memory `feedback_no_api_keys`

## Context

Oracle has two surfaces today that take a natural-language requirement and
produce test code:

1. **CLI**: `oracle generate "<prompt>"` calls `agent.llm.generate_response()`,
   which routes through one of the provider clients
   (`agent/llm/providers/{anthropic,openai,gemini,codex}.py`). Each requires
   a real provider API key (`ANTHROPIC_API_KEY`, etc.).
2. **Plugin slash command**: `/oracle-write-test` (defined under
   `plugins/oracle/commands/`) hands control to the `oracle-test-author`
   agent (defined under `plugins/oracle/agents/`).

The plugin path's documented selling point — restated in the
`docs/specs/oracle-plugin.md` overview — is _"no API key required for
plugin users."_ In practice this is false today. The
`oracle-test-author.md` agent's Phase 2 instructions tell it to:

> Delegate to the Oracle CLI when applicable: `oracle generate "<expanded prompt>"`

That `Bash` call invokes the keyed CLI path. The host LLM session that
Claude Code already provides — which is what the spec language implies
will be used — is bypassed. Users hit the slash command, the agent
shells out to `oracle generate`, and the call fails or charges a key
they didn't expect to need.

The same coupling exists inside the orchestrator's self-healing loop
(`agent/core/orchestrator.py`: `_attempt_fix`, `_attempt_selector_fix`)
which call `generate_response()` for retry generation.

Capillary's downstream overlay maintainer has explicitly asked for a
keyless path (`feedback_no_api_keys` agent memory). Casual contributors
upstream similarly avoid setting up a provider key. The current
architecture forces both groups to either supply a key or skip the
feature entirely.

## Decision

Agents under `plugins/oracle/agents/` will generate test code **in the
host LLM session** rather than delegating to `oracle generate`. This
ADR establishes the pattern for `oracle-test-author` first; future
agents that need an LLM call (`oracle-flake-hunter` for selector heals,
others added later) follow the same shape.

Concretely:

- The agent's instructions read repo context via the
  `oracle__analyze_file` MCP tool (already exposed by the MCP server).
- The agent generates the test code itself, using the host session's
  reasoning loop. No `Bash` shell-out to `oracle generate` and no
  `agent.llm.generate_response()` call.
- The agent writes the output via the `Write` tool (or
  `oracle__write_test_file` MCP tool for parity with the CLI's output
  shape).
- The agent never reads `ANTHROPIC_API_KEY` (or any other provider
  key) from the environment.

The deterministic surfaces — file analysis, controller scanning,
fixture detection, test execution, registry lookups, migration —
remain in the MCP server as before. Only the _generation_ step moves
out of the keyed code path.

## Consequences

### Immediate

- `oracle-test-author.md` rewritten; the `Bash` + `oracle generate`
  step disappears.
- The CLI's `oracle generate` path is unchanged for now (still keyed),
  but no longer the canonical user-facing generation surface.
- A user with no API key configured can install the plugin and invoke
  `/oracle-write-test` end-to-end.

### Follow-on (separate ADRs / plans)

- **Self-healing** in the orchestrator currently calls
  `generate_response()`. Moving that to a slash command (e.g.
  `/oracle-self-heal`) is the natural sequel; tracked in the roadmap
  item but not in scope for this ADR.
- **CLI deprecation** is the eventual end-state — `oracle generate`
  prints a deprecation warning pointing users to `/oracle-write-test`,
  then is removed in a future major version. Separate ADR.
- **GitHub Action removal** is coupled to the CLI deprecation; the
  Action wraps `oracle generate`.

### Risks

- The host LLM's generation quality may diverge from what the CLI
  produces today (different prompt construction, no
  `agent/core/orchestrator.py:_build_prompt` enrichment). The agent
  instructions need to reproduce the relevant context that the
  orchestrator's prompt builder injects (project metadata, existing
  test patterns, domain knowledge, fixtures, company knowledge).
- `oracle__analyze_file` already covers the analysis side; we need to
  verify it returns enough context for the host LLM to match CLI
  quality, or extend it.
- Users who previously relied on `--report-format sarif` / `--json`
  from the CLI lose those in the slash-command path. If we want
  parity, the agent needs to invoke `oracle__write_test_file` and
  optionally a new `oracle__write_report` MCP tool. Out of scope for
  this ADR.

### Reversibility

High. The change is to one agent definition file
(`plugins/oracle/agents/oracle-test-author.md`). If the host-LLM path
proves insufficient, revert the markdown and the previous behavior
(Bash to `oracle generate`) returns. No code in `agent/` is removed
by this ADR.

## Alternatives Considered

### Alternative 1: Keep delegating to `oracle generate`, route via host LLM

The CLI runs as a subprocess outside the Claude Code session. There is
no straightforward way to share the host LLM context with the
subprocess. Would require an IPC channel or a separate Claude API
authentication path. Rejected as too invasive for the value.

### Alternative 2: Add a `--use-host-llm` flag to `oracle generate`

Same fundamental problem as Alternative 1 — the CLI doesn't have
access to the host session. The flag would have to fail back to a
keyed path. Rejected.

### Alternative 3: Move the LLM call into an MCP tool

Possible, but MCP tools are deterministic functions returning typed
dicts — they're not the right shape for "generate prose given prose
plus context." Agents already have generation as their natural
capability. Rejected as forcing a square peg into a round hole.

### Alternative 4: Do nothing

Keep the documented "no API key required" claim aspirational. Users
discover the bait-and-switch on first use. Rejected.

## Open questions

- Should the agent invoke `oracle__write_test_file` (parity with the
  CLI's output path) or the plain `Write` tool? The MCP tool gives a
  consistent output shape (returns `{written_path}` dict) and may add
  hooks later; the `Write` tool is simpler. Lean toward the MCP tool
  for forward compatibility, but the plan should call this out and
  let the user decide.
- Do we update `docs/specs/oracle-plugin.md` to remove the now-stale
  "Delegate to the Oracle CLI" wording, or just supersede those
  sections via the new spec for this migration? Plan should clarify.

## References

- Roadmap: "Migrate all LLM-dependent tasks to keyless slash commands"
  (added in PR #122)
- Spec: `docs/specs/oracle-plugin.md` (claims no API key in plugin path)
- Code: `plugins/oracle/agents/oracle-test-author.md` (Phase 2 contains
  the offending `oracle generate` delegation)
- Code: `agent/core/orchestrator.py` (`_attempt_fix`,
  `_attempt_selector_fix` — out of scope for this ADR)
- Downstream memory: `feedback_no_api_keys`
