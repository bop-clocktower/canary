---
project: oracle
version: 1
created: 2026-05-26
---

# CLI Deprecation Specification (Phase 3)

Mark `canary generate`, `oracle feedback`, and the GitHub Action as
deprecated. Removal at v3.0 (separate phase).

## Overview

**Goals:**

1. **Clear runtime signal** — every invocation of a deprecated surface
   prints a warning that names the supported replacement.
2. **Non-breaking** — deprecated commands continue to function.
   Pipelines that currently rely on them keep working until v3.0.
3. **Stdout clean** — warnings land on stderr so `--json` output on
   stdout stays parseable for tooling.
4. **Single-edit-point convention** — future deprecations follow the
   same pattern (stderr `Console` print + ADR entry + spec note).

## Success Criteria

1. `canary generate "smoke" --recommend-only` runs without printing
   the deprecation warning (the recommend-only path stays keyless and
   useful).
2. `canary generate "smoke"` without `--recommend-only` prints
   exactly one yellow warning on stderr, pointing at
   `/canary-write-test`.
3. `oracle feedback` (with or without a prior generation recorded)
   prints exactly one yellow warning on stderr.
4. `action.yml`'s top-level `description` is prefixed with
   `[DEPRECATED — removed in v3.0]`.
5. Existing tests continue to pass — `python -m unittest discover
   tests/unit` reports the same number of passing tests as before
   (warnings go to stderr; CliRunner captures stdout by default).
6. The deprecation surface is documented in
   `docs/adr/0003-deprecate-oracle-generate.md` with status
   `accepted`.

## Scope

**In scope:**

- `agent/cli.py:generate` — add deprecation warning before
  orchestrator call (skip when `--recommend-only`).
- `agent/cli.py:feedback` — add deprecation warning at top of
  command.
- `action.yml` — prefix `description` with `[DEPRECATED — removed in
  v3.0]`.
- `docs/adr/0003-deprecate-oracle-generate.md` — decision.
- `docs/adr/README.md` — index update.
- `docs/specs/cli-deprecation.md` — this spec.
- `docs/plans/cli-deprecation.md` — task-by-task plan.
- `docs/changes/host-llm-migration/plans/<date>-phase-3-plan.md` —
  plan mirror.
- `docs/roadmap.md` — Phase 3 entry under the migration item.

**Out of scope:**

- Removal of any deprecated code, including the orchestrator,
  `agent/llm/*` providers, `selector_healer.py`. Future ADR.
- README rewrite — separate doc-pass PR.
- Dependency pruning in `pyproject.toml` — happens at removal.
- Telemetry collection on deprecated invocations — out of scope; we
  don't have a telemetry pipeline upstream.
- Auto-detection of "user is in Claude Code" to suppress the warning
  — too clever; warning is informational.

## Assumptions

- Stderr is the right channel for deprecation signals; consumers
  parsing `--json` stdout are unaffected.
- `Console(stderr=True).print(...)` from `rich` is the established
  pattern (already used elsewhere in this CLI). Verified by `grep
  -n stderr agent/cli.py`.
- No existing test asserts on stderr being empty for `canary generate`
  — `CliRunner.invoke` captures `stdout` by default and `stderr` only
  when `mix_stderr=False` is passed, which the existing tests don't
  do. Confirmed by inspection of `tests/unit/test_orchestrator.py`
  and related files.
- The Action's `description` field has no functional impact — it's
  marketplace metadata. No workflow `.yml` consumers parse it.

## Architecture

```text
Before:
  $ canary generate "test the login"
  🦇 Oracle Processing Request...
  ✅ Oracle Result
  …

After:
  $ canary generate "test the login"
  ⚠ canary generate is deprecated and will be removed in v3.0.        ← stderr
    Migrate to the /canary-write-test slash command
    (Claude Code plugin) — no API key required. See ADR 0003.
  🦇 Oracle Processing Request...                                       ← stdout
  ✅ Oracle Result
  …

  $ canary generate "test the login" --json 2>/dev/null
  { "status": "success", … }                                           ← stdout, clean

  $ canary generate "smoke" --recommend-only
  ✅ Oracle Recommendation (Draft Mode)                                  ← stdout, no warning
  Test Type: e2e_ui
  Framework: playwright
  …
```

## Plan

See [`docs/plans/cli-deprecation.md`](../plans/cli-deprecation.md) for
the task-by-task implementation.

## Out of Scope

- All code removals (deferred to removal ADR).
- README/AGENTS overhaul (deferred to doc-pass PR).
- New tests beyond a smoke test that the warning fires (existing
  tests must still pass).

## Open Questions

1. **Should `canary generate --recommend-only` get its own command
   (`canary recommend`)** so the keyless classifier check survives
   the `generate` removal? Recommend: yes, but as part of the
   removal phase, not this one.
2. **Should the warning be suppressible** via an env var
   (`ORACLE_SUPPRESS_DEPRECATION=1`) for users who knowingly continue
   to use the CLI through v3.0 in CI? Recommend: no for this phase —
   informational warnings shouldn't be suppressed. If consumers ask,
   add later.

## Risks

- **Action description not visible to existing consumers** — once a
  workflow has `uses: bri-stevenski/canary-test-ai-agent@v1` pinned,
  the consumer doesn't re-read the marketplace listing. Mitigation:
  none feasible — `action.yml` doesn't have a runtime-warning hook.
  The Action will continue to work; removal at v3.0 will be a major-
  version bump that triggers Dependabot etc.
- **Warning fatigue** — printing the same warning on every CLI
  invocation is noisy. Mitigation: not in this phase; revisit only
  if usage continues past one release cycle.
