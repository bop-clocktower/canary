# Canary Agent Skills

Agent-invokable workflows for Canary, written in the harness-engineering
SKILL.md format. Each skill is a prescriptive, phase-broken procedure
with explicit When-to-Use / NOT-for clauses, success criteria,
rationalizations to reject, examples, and escalation paths.

Skills are *prescriptive*. They tell an agent what to do, when to stop,
and what to refuse. For *descriptive* documentation (what a component is
and how to drive it), see [Guides](../../docs/guides/index.md).

## Structure

```text
agents/skills/
├── claude-code/                    # Claude Code skills (current, 12 total)
│   ├── canary-add-framework/
│   ├── canary-ci-ready/
│   ├── canary-critical-areas/
│   ├── canary-edge-case-discovery/
│   ├── canary-fail-fast/
│   ├── canary-failure-impact/
│   ├── canary-generate-test/
│   ├── canary-instrument/
│   ├── canary-promote-test/
│   ├── canary-setup-harness/
│   ├── canary-test-pipeline/
│   └── canary-test-reporter/
└── README.md                       # this file
```

Skills are organized by host platform. As Canary adds support for
additional agent runtimes (Gemini CLI, Cursor, Codex), sibling
directories mirror the same skill set with platform-specific tool-list
adjustments.

## Available Skills

Grouped by what you're trying to do, not alphabetically — see
[README.md's Usage section](../../README.md#-usage) for the CLI and
slash-command entry points into the same 12 skills.

### Generation & lifecycle

- [`canary-generate-test`](./claude-code/canary-generate-test/SKILL.md)
  — Generate a framework-appropriate test from a natural-language
  requirement. Routes through classify → recommend → generate, writes
  the test under `tests/generated/`, and optionally executes it. Invoked
  by `/canary-write-test`.
- [`canary-promote-test`](./claude-code/canary-promote-test/SKILL.md)
  — Move a generated test from `tests/generated/` into the committed
  test suite. Reviews, relocates, drops generation artifacts, and
  verifies the test runs in the project's normal flow.

### Discovery & prioritization

- [`canary-critical-areas`](./claude-code/canary-critical-areas/SKILL.md)
  — Risk-rank codebase areas by git churn, downstream dependents,
  business-critical signals, and existing coverage depth. Invoked by
  `/canary-critical-areas`; also Phase 1 of `canary-test-pipeline`.
- [`canary-edge-case-discovery`](./claude-code/canary-edge-case-discovery/SKILL.md)
  — Surface edge cases worth testing across six categories, for a
  feature description, function signature, or existing test suite.
  Invoked by `/canary-edge-cases`; also Phase 2 of `canary-test-pipeline`.
- [`canary-failure-impact`](./claude-code/canary-failure-impact/SKILL.md)
  — Trace the downstream blast radius of a test, function, or code path
  failing undetected; produces a severity label. Invoked by
  `/canary-failure-impact`; also Phase 3 of `canary-test-pipeline`.

### CI gate & reporting

- [`canary-ci-ready`](./claude-code/canary-ci-ready/SKILL.md) — Analyse
  a suite for CI readiness across five checks (coverage depth,
  flakiness, assertion quality, critical-path coverage, runtime).
  Invoked by `/canary-ci-ready`; also the gate/convergence check of
  `canary-test-pipeline`.
- [`canary-fail-fast`](./claude-code/canary-fail-fast/SKILL.md) —
  Bundled executable skill (`scripts/cli.py`). Audits a Playwright
  config for fail-fast knobs and prints a loud, categorized CI failure
  digest with GitHub `::error` annotations, failing the step so a real
  failure can't be missed.
- [`canary-test-reporter`](./claude-code/canary-test-reporter/SKILL.md)
  — Bundled executable skill (`scripts/cli.py`). Turns Playwright JSON
  results into a Markdown and/or JSON report with pass/fail/flaky/skipped
  counts. Complements `canary-fail-fast` (which aborts early) by
  summarising the full run at the end.

### Orchestration

- [`canary-test-pipeline`](./claude-code/canary-test-pipeline/SKILL.md)
  — Multi-phase orchestrator composing `canary-ci-ready`,
  `canary-critical-areas`, `canary-edge-case-discovery`,
  `canary-failure-impact`, and test generation into a sequential
  pipeline with a convergence loop, looping until CI-ready or the user
  stops. Invoked by `/canary-test-pipeline`.

### Maintenance & instrumentation

- [`canary-add-framework`](./claude-code/canary-add-framework/SKILL.md)
  — Add a new testing framework to Canary's registry end-to-end.
  Enforces the classifier↔registry contract, authors the registry
  entry, validates the execution command, and updates docs + state.
- [`canary-instrument`](./claude-code/canary-instrument/SKILL.md) —
  Bundled executable skill (`scripts/cli.py`). Instruments a Playwright
  run with OpenTelemetry and emits a `run.json` artifact correlating
  every test to the outbound HTTP requests it made, with zero manual
  bookkeeping in test code.

### Setup

- [`canary-setup-harness`](./claude-code/canary-setup-harness/SKILL.md)
  — Configure the Harness Engineering guardrails in a new Canary
  project or fork. Installs the harness CLI, initialises the
  config, wires up CI workflows, and verifies all gates pass.

## SKILL.md Format

Every skill in this tree follows the same structure:

1. **Tagline** — one sentence, what the skill does
2. **When to Use** — bulleted use-cases plus explicit NOT-for clauses
3. **Process** — broken into numbered phases with numbered steps
4. **Canary Integration** — files, env vars, and project entry points
   the skill touches
5. **Success Criteria** — measurable end-state conditions
6. **Rationalizations to Reject** — table of common shortcuts and why
   they fail
7. **Examples** — concrete walk-throughs (happy path + at least one
   failure path)
8. **Escalation** — when to stop the skill and surface to the user

This shape comes directly from the harness-engineering skill convention.
Skills authored outside this format don't belong here — file them as
guides or wiki pages.

## Usage

### Claude Code

Invoke by referencing the skill name in conversation, or via one of the
10 registered slash commands (`commands/*.md`) that wrap a skill or
agent — e.g. `/canary-write-test`, `/canary-ci-ready`,
`/canary-critical-areas`. See
[README.md's Usage section](../../README.md#-usage) for the full
command-to-skill mapping.

```text
Use the canary-generate-test skill to write a load test for /v1/search.
```

### Programmatic

Most skills here are documentation, not executable artifacts — they
describe *how an agent should behave*, not a function to call. Three are
bundled executable skills with their own CLI entry point (`cli:
scripts/cli.py` in frontmatter): `canary-fail-fast`, `canary-instrument`,
and `canary-test-reporter`. Run those directly, e.g.:

```bash
python agents/skills/claude-code/canary-fail-fast/scripts/cli.py --help
```

For the rest — generation, review, healing, and analysis — there is no
standalone `generate`/orchestrator command; that pipeline was removed in
v3.0 and now runs through the Claude Code plugin (`/canary-write-test`
and friends) using your session's own LLM. The deterministic, no-LLM
subset of that work (`recommend`, `init`, `run`, `review-test`,
`flake-check`, `heal-test`, `migrate`, and more) is exposed on the
`canary` CLI — run `canary --help`, or see
[README.md's Usage section](../../README.md#-usage) for the full,
use-case-organized command list.

## Authoring New Skills

Before adding a skill, confirm:

- The workflow is **prescriptive** (a sequence an agent should follow),
  not **descriptive** (an explanation of how something works).
  Descriptive content goes in `docs/guides/`.
- The workflow is **agent-invokable** — there's a clear trigger phrase
  or context that should make an agent reach for it.
- The workflow has **at least one rationalization worth rejecting** — if
  no shortcut is tempting, the skill is probably too thin and should be
  a guide instead.

Then mirror the SKILL.md format above. Use the existing skills in this
catalog as templates — match section ordering, table style, and example
density.

## Related

- [Guides](../../docs/guides/index.md) — descriptive component
  documentation
- [Architecture Deep-Dive][arch-deep-dive] — internals for skill authors
  who need to know what they're orchestrating
- [Roadmap](../../docs/roadmap.md) — planned skills and capabilities

[arch-deep-dive]: ../../docs/wiki/Architecture-Deep-Dive.md
