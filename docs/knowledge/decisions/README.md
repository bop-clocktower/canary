# Architecture Decision Records

Short, dated decision records for choices that shape Canary's architecture. Each
ADR captures _what_ was decided, _why_, and _what changes downstream_.

These files live at `docs/knowledge/decisions/` because that is the only path
the harness knowledge pipeline reads decisions from — it is hardcoded and does
not consult `docsDir`. While they sat in `docs/adr/` the graph never saw them
and the pipeline reported `0 decisions`, which reads as _this repo records no
decisions_ rather than as _the extractor looked elsewhere_. Filed upstream as
[harness-engineering#1330](https://github.com/Intense-Visions/harness-engineering/issues/1330);
the move is the local fix.

## Format

- Filename: `NNNN-title-in-kebab-case.md`, where `NNNN` is a 4-digit sequence
  (`0001`, `0002`, …).
- Status: `proposed`, `accepted`, `superseded by NNNN`, or `rejected`.
- Sections: Context, Decision, Consequences, Alternatives Considered.
- **YAML frontmatter with `number` and `title`.** The ingestor requires both and
  skips the file **silently** when either is missing — no error, no warning, and
  the ADR simply never appears in the graph. `date`, `status`, and `source` are
  optional and carried as metadata.
- The `**Status:**` / `**Date:**` bold lines stay. A second parser matches on
  them, and they are what a human reads first.

Each file also carries `<!-- markdownlint-disable-next-line MD025 -->` above its
`# ADR NNNN` heading. markdownlint treats a frontmatter `title:` as a top-level
heading, so without it the real heading is reported as a duplicate H1. The
directive is per-file and per-rule deliberately — the repo's `protect-config.js`
hook forbids weakening `.markdownlint.json`, and this is metadata colliding with
a heading heuristic, not a rule worth relaxing repo-wide.

## Verifying an ADR actually landed

Adding the file is not the same as adding the node:

```bash
harness graph scan .
harness knowledge-pipeline        # `decisions` count must move
```

A count that does not move means the frontmatter was rejected, however well the
file reads.

## When to write one

- A change reshapes how a major part of the system works (skill discovery, LLM
  access pattern, plugin layout).
- A decision will be referenced by future PRs as the rationale for follow-on
  work.
- The reasoning is non-obvious from the diff alone.

Not every PR needs an ADR. Day-to-day refactors and bug fixes don't.

## Index

| #                                                     | Title                                                               | Status   |
| ----------------------------------------------------- | ------------------------------------------------------------------- | -------- |
| [0001](0001-host-llm-generation-for-agents.md)        | Host-LLM generation for agents (no API key path)                    | accepted |
| [0002](0002-self-heal-as-slash-command.md)            | Self-heal as a slash command (`/oracle-heal-test`)                  | accepted |
| [0003](0003-deprecate-oracle-generate.md)             | Deprecate `oracle generate` CLI + the GitHub Action                 | accepted |
| [0004](0004-remove-keyed-paths-at-v3.md)              | Remove the keyed CLI surface at v5.0.0                              | accepted |
| [0005](0005-remove-llm-abstraction-layer.md)          | Remove LLM abstraction layer — implementation record (v5.0.0)       | accepted |
| [0006](0006-otel-test-side-tracing.md)                | Test-side-only OTel tracing (Phase 1, SUT-side deferred)            | accepted |
| [0007](0007-guardian-agent-capability-boundary.md)    | Guardian agent capability boundary (agentless-in-CI, agent-at-desk) | accepted |
| [0008](0008-guardian-canary-owned.md)                 | Guardian ownership — a canary skill that harness leverages          | accepted |
| [0009](0009-exit-3-reserved-for-abstained.md)         | Exit 3 is reserved CLI-wide for "abstained"                         | accepted |
| [0010](0010-conformance-registry-as-gate-registry.md) | The conformance registry is the canonical gate list                 | accepted |
| [0011](0011-required-status-checks.md)                | Required status checks are declared in the repository               | accepted |
| [0012](0012-entropy-ratchet.md)                       | The entropy scan is ratcheted against a triaged baseline            | accepted |
| [0013](0013-history-store-async-interface.md)         | The history store presents one async contract                       | proposed |
