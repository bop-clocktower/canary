# ADR 0002 — Self-heal as a slash command (`/oracle-heal-test`)

**Status:** accepted
**Date:** 2026-05-26
**Deciders:** Bri Stevenski (upstream maintainer)
**Supersedes:** none
**Related:** [ADR 0001](0001-host-llm-generation-for-agents.md), roadmap
item _"Migrate all LLM-dependent tasks to keyless slash commands"_

## Context

ADR 0001 moved test _generation_ from the keyed CLI to the host LLM
session. It explicitly listed _self-healing_ as the natural sequel:

> The self-healing loop in `agent/core/orchestrator.py` (`_attempt_fix`,
> `_attempt_selector_fix`) still calls `generate_response()`. Moving
> that to a slash command (e.g. `/oracle-self-heal`) is the natural
> sequel; tracked in the roadmap item but not in scope for [ADR 0001].

That work is this ADR.

Today's behaviour: `oracle generate --run` executes the freshly
generated test. If the test fails, `OracleOrchestrator.run()` enters a
self-heal loop (`max_heal_attempts`, default 3). Each iteration either
routes to `_attempt_selector_fix` (DOM-aware repair for Playwright
selector failures) or `_attempt_fix` (generic error-context-enriched
repair). Both call `generate_response()`, which routes through
`agent/llm/*` providers and needs `ANTHROPIC_API_KEY` (or equivalent).

The user-facing surface for this is hidden — there's no `oracle heal`
CLI command, just an internal loop invoked by `generate --run`. As a
result, today's only way to use the self-heal capability requires the
keyed CLI path entirely.

Downstream overlay users and casual contributors who want a keyless path
have no analog for "this test fails, fix it".

## Decision

Add a new agent `oracle-test-healer` and a `/oracle-heal-test` slash
command. The agent generates fixes in the host LLM session, mirroring
the Phase 1 pattern from ADR 0001.

Concretely:

- Agent file: `plugins/oracle/agents/oracle-test-healer.md`.
  Mirrors `oracle-test-author` shape — Phase 1 (analyze the failure),
  Phase 2 (propose a fix in-session), Phase 3 (write + verify).
- Command file: `plugins/oracle/commands/oracle-heal-test.md`.
  Takes a test file path + (optionally) the failing error output as
  argument; delegates to the healer agent.
- Reuses `oracle__analyze_file` and the existing MCP toolset; no new
  MCP tools required for this phase.
- Reuses repo-side `SelectorHealer` heuristics (extract failing
  selector from error, locate Playwright trace DOM context) by
  documenting the same patterns in the healer agent's instructions —
  the agent does the same work without invoking the Python class.
- The CLI's `_attempt_fix` / `_attempt_selector_fix` paths in
  `agent/core/orchestrator.py` are **left in place** for users on the
  keyed CLI. Deprecation happens in Phase 3 (ADR 0003+) alongside
  `oracle generate` itself.

## Consequences

### Immediate

- New keyless surface for test repair: install the plugin → invoke
  `/oracle-heal-test <path>` → fix is proposed and written. No
  provider key required.
- The orchestrator code path is unchanged. Users who run
  `oracle generate --run` continue to get the auto-heal loop with the
  same keyed behaviour.

### Follow-on

- **Phase 3 / CLI deprecation:** once `oracle generate` is removed,
  the `_attempt_fix` / `_attempt_selector_fix` methods + the
  `generate_response()` calls inside them can be deleted with it.
  Tracked under the Phase 3 ADR.
- **Selector context fidelity:** the CLI's `SelectorHealer` reads
  Playwright trace.zip snapshots to give the LLM real DOM context.
  The slash-command path documents this same extraction but relies
  on the agent's `Read` + `Bash` (for `unzip`) to surface the
  context. Quality may differ if the agent doesn't bother extracting;
  the agent instructions need to make this explicit.

### Risks

- **Quality regression** vs. CLI self-heal — same risk as Phase 1's
  generation regression. Mitigation: keep the CLI path live;
  side-by-side check before claiming parity.
- **Selector-fix DOM context** is the trickier piece. If the agent
  doesn't extract `trace.zip`, fixes for selector failures may
  hallucinate. Mitigation: the agent's Phase 1 explicitly walks
  through extracting DOM context when a Playwright trace exists.
- **No CI auto-heal** in the slash-command path — `oracle generate
  --run` auto-heals as part of one CLI invocation; a user would need
  to invoke the slash command manually after seeing a failure. Not a
  regression for users who never used `--run` to begin with.

### Reversibility

High. Pure additive — two new files (`oracle-test-healer.md` +
`oracle-heal-test.md`), no changes to existing CLI/orchestrator code.
If the slash command proves insufficient, deleting the two files
restores the prior state without consequence.

## Alternatives Considered

### Alternative 1: Expand `oracle-flake-hunter` to also cover consistent failures

`oracle-flake-hunter`'s scope is explicitly "intermittent failures
only — consistent failures are bugs, not flakes". Conflating them
would confuse the agent selection at use time. Rejected as scope
creep on an agent that's intentionally narrow.

### Alternative 2: Single `/oracle-fix-test` slash command without a new agent

Could route a "fix this test" prompt straight to `oracle-test-author`
(which already writes test code). Rejected — `oracle-test-author`
generates from a requirement; healing operates from a failing test
plus its error output. The inputs and the reasoning are different
enough that a separate agent is clearer for users and easier to
instruct precisely.

### Alternative 3: Wait for Phase 3 and remove self-heal entirely

If `oracle generate` is deprecated and removed, the in-CLI self-heal
disappears too. Skipping Phase 2 means there's a gap between
"`oracle generate` removed" and "self-heal available again as a
slash command". Rejected — better to land the keyless path first,
then deprecate the keyed one.

### Alternative 4: Expose `_attempt_fix` as an MCP tool

Like ADR 0001's reasoning: MCP tools are deterministic functions
returning typed dicts. Self-healing is inherently generative.
Rejected as the wrong shape.

## References

- Code: `agent/core/orchestrator.py:_attempt_fix`,
  `_attempt_selector_fix`
- Code: `agent/core/selector_healer.py` (heuristics for selector
  extraction + DOM context — referenced by the agent docs, not
  imported by the slash command path)
- ADR 0001: `docs/adr/0001-host-llm-generation-for-agents.md`
- Phase 2 spec: `docs/specs/self-heal-migration.md`
- Phase 2 plan: `docs/plans/self-heal-migration.md`
- Roadmap item: "Migrate all LLM-dependent tasks to keyless slash
  commands" — Phase 1 done; this PR completes Phase 2
