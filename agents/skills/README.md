# Oracle Agent Skills

Agent-invokable workflows for Oracle, written in the harness-engineering SKILL.md format. Each skill is a prescriptive, phase-broken procedure with explicit When-to-Use / NOT-for clauses, success criteria, rationalizations to reject, examples, and escalation paths.

Skills are *prescriptive*. They tell an agent what to do, when to stop, and what to refuse. For *descriptive* documentation (what a component is and how to drive it), see [Guides](../../docs/guides/index.md).

## Structure

```
agents/skills/
├── claude-code/          # Claude Code skills (current)
│   ├── oracle-generate-test/
│   ├── oracle-promote-test/
│   └── oracle-add-framework/
└── README.md             # this file
```

Skills are organized by host platform. As Oracle adds support for additional agent runtimes (Gemini CLI, Cursor, Codex), sibling directories mirror the same skill set with platform-specific tool-list adjustments.

## Available Skills

### Generation

- [`oracle-generate-test`](./claude-code/oracle-generate-test/SKILL.md) — Generate a framework-appropriate test from a natural-language requirement. Routes through classify → recommend → generate, writes the test under `tests/generated/`, and optionally executes it.

### Lifecycle

- [`oracle-promote-test`](./claude-code/oracle-promote-test/SKILL.md) — Move a generated test from `tests/generated/` into the committed test suite. Reviews, relocates, drops generation artifacts, and verifies the test runs in the project's normal flow.

### Maintenance

- [`oracle-add-framework`](./claude-code/oracle-add-framework/SKILL.md) — Add a new testing framework to Oracle's registry end-to-end. Enforces the classifier↔registry contract, authors the registry entry, validates the execution command, and updates docs + state.

## SKILL.md Format

Every skill in this tree follows the same structure:

1. **Tagline** — one sentence, what the skill does
2. **When to Use** — bulleted use-cases plus explicit NOT-for clauses
3. **Process** — broken into numbered phases with numbered steps
4. **Oracle Integration** — files, env vars, and project entry points the skill touches
5. **Success Criteria** — measurable end-state conditions
6. **Rationalizations to Reject** — table of common shortcuts and why they fail
7. **Examples** — concrete walk-throughs (happy path + at least one failure path)
8. **Escalation** — when to stop the skill and surface to the user

This shape comes directly from the harness-engineering skill convention. Skills authored outside this format don't belong here — file them as guides or wiki pages.

## Usage

### Claude Code

Invoke by referencing the skill name in conversation, or via slash command if the host registers one:

```
Use the oracle-generate-test skill to write a load test for /v1/search.
```

### Programmatic

Skills are documentation, not executable artifacts — they describe *how an agent should behave*, not a function to call. To invoke the underlying Oracle pipeline directly, use:

```bash
python -m agent.cli generate "<requirement>"
```

See the [Orchestrator Guide](../../docs/guides/orchestrator.md) for the CLI surface.

## Authoring New Skills

Before adding a skill, confirm:

- The workflow is **prescriptive** (a sequence an agent should follow), not **descriptive** (an explanation of how something works). Descriptive content goes in `docs/guides/`.
- The workflow is **agent-invokable** — there's a clear trigger phrase or context that should make an agent reach for it.
- The workflow has **at least one rationalization worth rejecting** — if no shortcut is tempting, the skill is probably too thin and should be a guide instead.

Then mirror the SKILL.md format above. Use the existing three skills as templates — match section ordering, table style, and example density.

## Related

- [Guides](../../docs/guides/index.md) — descriptive component documentation
- [Architecture Deep-Dive](../../docs/wiki/Architecture-Deep-Dive.md) — internals for skill authors who need to know what they're orchestrating
- [Roadmap](../../docs/roadmap.md) — planned skills and capabilities
