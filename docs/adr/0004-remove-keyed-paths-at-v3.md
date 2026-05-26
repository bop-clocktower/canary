# ADR 0004 — Remove the keyed CLI surface at v3.0

**Status:** proposed
**Date:** 2026-05-26
**Deciders:** Bri Stevenski (upstream maintainer)
**Supersedes:** Completes the work begun in
[ADR 0003](0003-deprecate-oracle-generate.md)
**Related:** [ADR 0001](0001-host-llm-generation-for-agents.md),
[ADR 0002](0002-self-heal-as-slash-command.md), roadmap item
_"Migrate all LLM-dependent tasks to keyless slash commands"_

> **Pending architecture decision (2026-05-27).** This ADR assumes
> Oracle continues as a standalone repository with its own release
> cadence. The Wednesday architecture meeting will decide whether
> Oracle stays separate or is pulled into Harness as a persona.
>
> - If **stays separate:** this ADR proceeds as written — flip to
>   `accepted`, write the v3 spec + plan, and cut a release branch.
> - If **pulled into Harness:** the _deletions_ listed here still
>   apply (the keyed surface goes regardless), but the framing of
>   "v3.0 release" becomes a Harness persona migration rather than
>   a standalone semver bump. Re-read the "Decision" section in that
>   light; the alternatives and open questions still hold.
>
> Re-evaluate this status field post-meeting before flipping to
> `accepted`.

## Context

ADRs 0001–0003 landed the keyless migration in three phases:

- **Phase 1 (ADR 0001 / PR #136):** `oracle-test-author` agent
  rewritten to generate in-session via the host LLM. No more `oracle
  generate` Bash delegation from the slash-command path.
- **Phase 2 (ADR 0002 / PR #137):** the `/oracle-heal-test` slash
  command and `oracle-test-healer` agent introduced. Covers both
  generic and selector-class repair without an API key.
- **Phase 3 (ADR 0003 / PR #138):** `oracle generate`,
  `oracle feedback`, and the GitHub Action marked deprecated.
  Warnings on every invocation; no functional removal.

After Phase 3, the keyed code paths still exist and still work. Every
release reinforces the deprecation but doesn't act on it. The natural
end-state, signalled in ADRs 0001 and 0003, is a major-version bump
that removes the keyed surface entirely.

This ADR scopes that removal. The intent is to **propose**, not yet
to act — implementation lives in a future PR cut against the v3.0
release branch.

## Decision

At the v3.0 release, delete every keyed surface plus the supporting
machinery. Concretely:

### Code deletions

- `agent/cli.py:generate()` — the deprecated command.
- `agent/cli.py:feedback()` — tied to `generate`.
- `agent/core/orchestrator.py` — `OracleOrchestrator` class and all
  its private helpers (`_attempt_fix`, `_attempt_selector_fix`,
  `_search_error_context`, `_build_prompt`, `_write_test_file`,
  `_sanitize_extension`). The only remaining caller is `oracle
  generate`; both go together.
- `agent/llm/` — entire directory. Five providers (`anthropic`,
  `openai`, `gemini`, `codex`, `mock`), the factory, the client. No
  callers after the orchestrator is gone.
- `agent/core/selector_healer.py` — only used by
  `_attempt_selector_fix`. Goes with the orchestrator.
- `agent/core/feedback.py` — only used by the CLI `feedback`
  command. Goes with it.
- `agent/core/code_extractor.py` — only used by the orchestrator's
  `_build_prompt` → response processing chain. Verify no other
  callers, then delete.

### Tests deletions

- Every test under `tests/unit/` that exercises the above. Audit
  list to confirm at PR time.

### Configuration changes

- `action.yml` — delete the file. Anyone pinning `@v3` no longer
  gets the action; pinning `@v2` or `@v1` still works.
- `pyproject.toml` — remove provider dependencies: `anthropic`,
  `openai`, `google-genai`. Keep `typer`, `rich`, `fastmcp`.
- `pyproject.toml` — bump `version` to `3.0.0`.

### New keyless command (replacement for `--recommend-only`)

`oracle generate --recommend-only` is the one keyless invocation of
the deprecated command. The classifier + recommender pipeline behind
it has no API key requirement. Extract to its own command in v3.0:

```text
oracle recommend "<prompt>"
```

Same behaviour, no deprecation baggage, survives the removal.

### Release artifacts

- Tag `v3.0.0`. Move the floating `v3` tag accordingly.
- Release notes call out the breaking change explicitly: the keyed
  CLI and the GitHub Action are gone; migration path is the Claude
  Code plugin (`/oracle-write-test`, `/oracle-heal-test`); `oracle
  recommend` replaces `--recommend-only`.
- The `v1` and `v2` tags continue to point at their respective
  pre-removal commits. Consumers who can't migrate immediately pin
  to those.

## Consequences

### Immediate

- ~2,000 LOC removed from `agent/`. Repo gets meaningfully smaller.
- `pipx install` closure shrinks by ~50 MB (anthropic + openai +
  google-genai SDKs).
- Test suite shrinks; CI faster.
- New users see a single supported entry point (the plugin).

### Follow-on

- **Docs PR** to rewrite README around the plugin path as the
  canonical surface. Currently the README still leads with the CLI;
  the doc-pass is deferred from Phase 3 and lands with v3.0.
- **Downstream `oracle-capillary`** is unaffected — it never used
  the keyed CLI path. No coordination needed.
- **MCP server** stays (it's keyless). `oracle skills list`,
  `oracle skills run`, `oracle init`, `oracle run`, `oracle migrate`,
  `oracle setup` / `env-setup` all stay.

### Risks

- **Breaking change for Action consumers** — anyone with
  `uses: bri-stevenski/oracle-test-ai-agent@v3` pinned will get
  "action not found" at v3.0. Mitigation: release notes name the
  migration path; consumers can pin `@v2` to keep working.
- **`pyproject.toml` version-pin churn** — downstream installs that
  pin a specific version range may need updating. Mitigation: v3.0
  is a clean major bump; SemVer expectations apply.
- **Migration of in-flight users** — anyone running `oracle generate`
  in CI today already sees the deprecation warning (Phase 3). At
  v3.0 the command fails with `oracle: no such option 'generate'`.
  Migration path is well-signposted; further notice is overkill.
- **Loss of `oracle generate --recommend-only`** — only meaningful
  keyless use of the deprecated command. Mitigation: `oracle
  recommend` ships in the same PR.

### Reversibility

Low at the code level. Restoring the deleted files requires reverting
the v3.0 commit. Tags `v1`/`v2` still work, so consumers have a
fallback; the engine itself doesn't lose data.

The conservative path: ship `v3.0.0-rc.1` first as a release-
candidate tag so anyone affected can test the removal before the
floating `v3` tag moves.

## Alternatives Considered

### Alternative 1: Soft-keep the CLI behind a feature flag

`oracle generate` continues to work if `ORACLE_ALLOW_DEPRECATED=1` is
set in the environment. Useful for organizations that can't migrate
immediately. Rejected as scope creep — same effect achieved by
pinning to `@v2`.

### Alternative 2: Keep `action.yml` as a hard-error shim

Instead of deleting the file, replace its `runs:` section with a
shell step that prints an error explaining the removal and exits 1.
Helps consumers who pin `@v3` — they get a clear message rather than
"action not found". Worth considering at PR time. **Open question.**

### Alternative 3: Remove without bumping major

Could be done as a minor bump if framed as "Phase 3 deprecation
matured into Phase 4 removal." Rejected — SemVer says breaking
changes need a major bump; not negotiable.

### Alternative 4: Remove the LLM providers but keep `oracle generate`

Hypothetically, `oracle generate` could call out to the MCP server
which calls out to a host LLM somehow. Rejected — there's no host
LLM accessible from a CLI subprocess; the whole reason for the
plugin path is that Claude Code provides the session. The CLI has
nowhere to route to.

## Guiding principle (revealed during Phase 3 review)

After Phases 1–3 landed, the implicit shape of Oracle's surface is:

- **Deterministic operations** (file scans, registry lookups, AST
  walks, framework detection, static checks, test execution, report
  generation) live in the keyless `oracle <subcmd>` CLI. They run
  without an LLM and benefit from being scriptable and CI-friendly.
- **Generative operations** (write new test code, repair a failing
  test, critique substance) live in slash commands. They need a
  reasoning loop and run in the host Claude Code session.

This matches the Harness pattern (Harness's CLI does deterministic
work; its slash commands invoke generative agents).

The Phases 1–2 migrations focused only on the _generative_ pieces —
they moved them off the keyed `oracle generate` path onto slash
commands. They did not surface the fact that some of the
slash-command-only agents have a **static-check companion that could
ship as a keyless CLI command**:

| Slash command | Generative bit (stays) | Keyless static bit (could be CLI) |
| --- | --- | --- |
| `/oracle-write-test` | Generate code from a requirement | (none — pure generation) |
| `/oracle-heal-test` | Diagnose novel failures | Pattern-fix (regex-detectable fixes — selector swap from trace, missing await) |
| `/oracle-review-test` | Substantive critique | Static lint (idiom check, brittle-selector flag, missing-assertion flag) |
| `/oracle-debug-flake` | Diagnose a specific failure mode | Pattern detection (`Math.random` in tests, `setTimeout` without `waitFor`, etc.) |
| `/oracle-pick-framework` | (none — already keyless: this is the classifier) | `oracle recommend "<prompt>"` (planned above as the `--recommend-only` replacement) |

**This ADR does not propose implementing those CLI companions.** They
are flagged here so a reader of the v3.0 plan understands that
"removed the keyed path" doesn't mean "removed every CLI surface
adjacent to the slash commands." The keyless CLI companions are
future work, tracked in a follow-up roadmap item.

If Oracle is eventually pulled into Harness (separate decision; see
roadmap item _"Decide whether to pull Oracle into Harness directly"_),
these CLI companions become `harness test:review`, `harness
test:flake-check`, etc. — same underlying static analysis, different
command name.

## Open Questions

1. **`action.yml`: delete vs. hard-error shim** (Alternative 2). The
   shim is friendlier to consumers but adds a file we'd otherwise
   delete cleanly. Recommend: shim, since it costs ~20 lines and
   reduces support load.
2. **`oracle recommend`: separate command vs. flag-only kept on
   another command** — could go under `oracle skills list` as a
   pre-flight hint, or stay its own command. Recommend: own command;
   clearest UX.
3. **Telemetry on v3.0 release** — should there be analytics on how
   many users hit the removed-command error vs. successfully migrate
   to the plugin? Out of scope; no telemetry pipeline exists.
4. **Timing of the v3.0 release** — no specific date proposed.
   Recommend: gather one release cycle of Phase 3 warnings in the
   field (and downstream `oracle-capillary` feedback), then cut.
   Could be as soon as ~2026-06.

## References

- ADR 0001: `docs/adr/0001-host-llm-generation-for-agents.md`
- ADR 0002: `docs/adr/0002-self-heal-as-slash-command.md`
- ADR 0003: `docs/adr/0003-deprecate-oracle-generate.md`
- Code to delete: `agent/cli.py:generate`, `agent/cli.py:feedback`,
  `agent/core/orchestrator.py`, `agent/llm/*`,
  `agent/core/selector_healer.py`, `agent/core/feedback.py`,
  `agent/core/code_extractor.py`, `action.yml`
- Roadmap: "Migrate all LLM-dependent tasks to keyless slash
  commands"
