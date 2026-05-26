# Architecture Decision Records

Short, dated decision records for choices that shape Oracle's architecture.
Each ADR captures _what_ was decided, _why_, and _what changes downstream_.

## Format

- Filename: `NNNN-title-in-kebab-case.md`, where `NNNN` is a 4-digit
  sequence (`0001`, `0002`, …).
- Status: `proposed`, `accepted`, `superseded by NNNN`, or `rejected`.
- Sections: Context, Decision, Consequences, Alternatives Considered.

## When to write one

- A change reshapes how a major part of the system works (skill discovery,
  LLM access pattern, plugin layout).
- A decision will be referenced by future PRs as the rationale for
  follow-on work.
- The reasoning is non-obvious from the diff alone.

Not every PR needs an ADR. Day-to-day refactors and bug fixes don't.

## Index

| # | Title | Status |
| --- | --- | --- |
| [0001](0001-host-llm-generation-for-agents.md) | Host-LLM generation for agents (no API key path) | accepted |
| [0002](0002-self-heal-as-slash-command.md) | Self-heal as a slash command (`/oracle-heal-test`) | accepted |
| [0003](0003-deprecate-oracle-generate.md) | Deprecate `oracle generate` CLI + the GitHub Action | accepted |
