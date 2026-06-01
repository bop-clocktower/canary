# Voice Discovery Protocol

Shared instructions for prose-generating Canary agents (`canary-test-author`,
`canary-initializer`, `canary-test-generator`). Each agent references this
protocol from its Phase 1 ("Anchor in the repo") step rather than restating it.

## When this applies

Voice applies only to **prose** Canary authors:

- Files it writes that are prose — workspace READMEs, runbook docs.
- Its own end-of-dispatch report.
- Decision logs and scaffolding summaries.

Voice does **not** apply to:

- Test code (`*.spec.ts`, `*.test.py`, fixtures, assertions) — always neutral
  technical style.
- Files the project marks out-of-scope.
- Files outside the project's declared in-scope paths.

## Step 1 — Look for a project voice config

Check these paths in order; use the first that exists:

1. `.canary/voice.md` — project-root, dot-prefixed. Most explicit signal.
2. `docs/<role>/canary-voice.md` — role-scoped (recommended). e.g.
   `docs/sdet/canary-voice.md`, `docs/qa/canary-voice.md`. The folder names the
   team that owns the docs, so it survives tool renames.
3. `docs/canary/voice.md` — tool-scoped fallback.
4. A pointer in `canary.config.json` (or similar project config) for repos that
   centralize tool configuration.

If no config is found, generate prose in the **default neutral voice**. Voice is
opt-in; absence is not an error.

## Step 2 — Resolve the named profile

A project voice config is short. Expected fields:

```yaml
profile: clocktower # which shipped profile to apply
in_scope: # glob paths this voice applies to
  - 'apps/*-e2e/**/*.md'
  - 'docs/sdet/**/*.md'
out_of_scope: # globs that stay neutral even if in-scope matches
  - 'docs/architecture/**' # ADRs stay dry
overrides: # optional: extra vocabulary / house aphorisms
  - '...'
```

Resolve `profile:` against the shipped profiles in
`voice/profiles/<name>.md`.

- **Profile found** → apply its rules (tone, vocabulary, palette, opener/closer,
  anti-patterns) plus any project `overrides`, but only to files matching
  `in_scope` and not `out_of_scope`.
- **Profile reference is unknown** (no matching file under `profiles/`) → **fail
  fast** with a clear error naming the missing profile and listing the available
  ones. Do not silently fall back to neutral voice — a config that names a
  profile is a stated intent, and silently ignoring it hides the mistake.

## Step 3 — Apply when writing prose

- Apply the resolved voice to in-scope prose files and to your dispatch report.
- Keep test code and out-of-scope files neutral.
- Honor the profile's source discipline for any quotes — verified canon only,
  house aphorisms clearly labeled, silence over invention.
