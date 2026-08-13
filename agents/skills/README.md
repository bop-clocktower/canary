# Canary Agent Skills

Agent-invokable workflows for Canary, written in the harness-engineering
SKILL.md format. Each skill is a prescriptive, phase-broken procedure with
explicit When-to-Use / NOT-for clauses, success criteria, rationalizations to
reject, examples, and escalation paths.

Skills are _prescriptive_. They tell an agent what to do, when to stop, and what
to refuse. For _descriptive_ documentation (what a component is and how to drive
it), see [Guides](../../docs/guides/index.md).

## Structure

```text
agents/skills/
├── claude-code/                    # Claude Code skills (21)
│   ├── canary-add-framework/
│   ├── canary-blackhawk/
│   ├── canary-cassandra/
│   ├── canary-ci-ready/
│   ├── canary-company-knowledge/
│   ├── canary-critical-areas/
│   ├── canary-edge-case-discovery/
│   ├── canary-fail-fast/
│   ├── canary-failure-impact/
│   ├── canary-fleet-health/
│   ├── canary-generate-test/
│   ├── canary-instrument/
│   ├── canary-katana/
│   ├── canary-pr-guardian/
│   ├── canary-promote-test/
│   ├── canary-savant/
│   ├── canary-setup-harness/
│   ├── canary-shadow/
│   ├── canary-ship/
│   ├── canary-test-pipeline/
│   └── canary-test-reporter/
└── README.md                       # this file
```

Skills are organized by host platform. As Canary adds support for additional
agent runtimes (Gemini CLI, Cursor, Codex), sibling directories mirror the same
skill set with platform-specific tool-list adjustments.

## Available Skills

Grouped by what you're trying to do, not alphabetically — see
[README.md's Usage section](../../README.md#-usage) for the CLI and
slash-command entry points.

### Generation & lifecycle

- [`canary-generate-test`](./claude-code/canary-generate-test/SKILL.md) —
  Generate a framework-appropriate test from a natural-language requirement.
  Routes through classify → recommend → generate, writes the test under
  `tests/generated/`, and optionally executes it. Invoked by
  `/canary-write-test`.
- [`canary-promote-test`](./claude-code/canary-promote-test/SKILL.md) — Move a
  generated test from `tests/generated/` into the committed test suite. Reviews,
  relocates, drops generation artifacts, and verifies the test runs in the
  project's normal flow.

### Discovery & prioritization

- [`canary-critical-areas`](./claude-code/canary-critical-areas/SKILL.md) —
  Risk-rank codebase areas by git churn, downstream dependents,
  business-critical signals, and existing coverage depth. Invoked by
  `/canary-critical-areas`; also Phase 1 of `canary-test-pipeline`.
- [`canary-edge-case-discovery`](./claude-code/canary-edge-case-discovery/SKILL.md)
  — Surface edge cases worth testing across six categories, for a feature
  description, function signature, or existing test suite. Invoked by
  `/canary-edge-cases`; also Phase 2 of `canary-test-pipeline`.
- [`canary-failure-impact`](./claude-code/canary-failure-impact/SKILL.md) —
  Trace the downstream blast radius of a test, function, or code path failing
  undetected; produces a severity label. Invoked by `/canary-failure-impact`;
  also Phase 3 of `canary-test-pipeline`.

### CI gate & reporting

- [`canary-ci-ready`](./claude-code/canary-ci-ready/SKILL.md) — Analyse a suite
  for CI readiness across five checks (coverage depth, flakiness, assertion
  quality, critical-path coverage, runtime). Invoked by `/canary-ci-ready`; also
  the gate/convergence check of `canary-test-pipeline`.
- [`canary-fail-fast`](./claude-code/canary-fail-fast/SKILL.md) — Bundled
  executable skill (`scripts/cli.mjs`). Audits a Playwright config for fail-fast
  knobs and prints a loud, categorized CI failure digest with GitHub `::error`
  annotations, failing the step so a real failure can't be missed.
- [`canary-test-reporter`](./claude-code/canary-test-reporter/SKILL.md) —
  Bundled executable skill (`scripts/cli.py`). Turns Playwright JSON results
  into a Markdown and/or JSON report with pass/fail/flaky/skipped counts.
  Complements `canary-fail-fast` (which aborts early) by summarising the full
  run at the end.

### Test hygiene & reliability

- [`canary-savant`](./claude-code/canary-savant/SKILL.md) — Order-dependence &
  isolation detector. A Tier-1 static scan flags shared-state smells that
  predict order-dependent tests; an opt-in dynamic confirmer shuffles the suite
  under a pinned seed and (for pytest) bisects the prefix to name the polluter.
  The first JS/Node skill (`requires: node>=20`).
- [`canary-katana`](./claude-code/canary-katana/SKILL.md) — Quarantines deleted
  and newly-skipped tests into an append-only provenance ledger, alarming in
  exactly one case: the deletion dropped the last coverage of a critical-area
  symbol. Silent by default; degrades to recording-only when critical-area data
  is absent.
- [`canary-blackhawk`](./claude-code/canary-blackhawk/SKILL.md) —
  Temporal-dependency linter. Statically flags tests that lean on wall-clock
  time, a real delay, or the local timezone — the ones that pass all day and
  fail at midnight, across a DST boundary, or on Feb 29 — suppressing itself
  when a frozen-clock idiom is already in use.

### Orchestration

- [`canary-test-pipeline`](./claude-code/canary-test-pipeline/SKILL.md) —
  Multi-phase orchestrator composing `canary-ci-ready`, `canary-critical-areas`,
  `canary-edge-case-discovery`, `canary-failure-impact`, and test generation
  into a sequential pipeline with a convergence loop, looping until CI-ready or
  the user stops. Invoked by `/canary-test-pipeline`.

### Integration & shipping

- [`canary-pr-guardian`](./claude-code/canary-pr-guardian/SKILL.md) — PR /
  pre-commit test-guardian. Runs a deterministic Tier-0 diff-coverage pass and
  posts fidelity-labeled findings (coverage-verified › graph-verified ›
  heuristic) on a sticky PR comment, with optional at-desk authoring of missing
  tests. Gate defaults to soft. Invoked by `/canary-pr-guardian`.
- [`canary-ship`](./claude-code/canary-ship/SKILL.md) — The ship gate for a
  finished, locally-green change: parallel adversarial review of the diff,
  resolve confirmed findings with regression tests, then commit, PR, and
  squash-merge while watching CI to green. Bakes in this repo's conventions (no
  co-author trailer, squash, prettier, exclude local IDE churn, roadmap update).
  Not for the implementation itself.

### Maintenance & instrumentation

- [`canary-add-framework`](./claude-code/canary-add-framework/SKILL.md) — Add a
  new testing framework to Canary's registry end-to-end. Enforces the
  classifier↔registry contract, authors the registry entry, validates the
  execution command, and updates docs + state.
- [`canary-instrument`](./claude-code/canary-instrument/SKILL.md) — Bundled
  executable skill (`scripts/cli.py`). Instruments a Playwright run with
  OpenTelemetry and emits a `run.json` artifact correlating every test to the
  outbound HTTP requests it made, with zero manual bookkeeping in test code.

### Setup

- [`canary-setup-harness`](./claude-code/canary-setup-harness/SKILL.md) —
  Configure the Harness Engineering guardrails in a new Canary project or fork.
  Installs the harness CLI, initialises the config, wires up CI workflows, and
  verifies all gates pass.

- [`canary-company-knowledge`](./claude-code/canary-company-knowledge/SKILL.md)
  — Scaffold `.canary/company.json`, the org-specific pointer file
  `canary-ci-ready` and `canary-failure-impact` assume already exists; prompts
  for the fields that can't be inferred.

### Analysis

- [`canary-fleet-health`](./claude-code/canary-fleet-health/SKILL.md) —
  Fleet-wide flake/spike/regression health summary across suites from the
  run-history store, condensed to one scannable chat-turn report.

- [`canary-cassandra`](./claude-code/canary-cassandra/SKILL.md) — Vacuous-test
  detection: tests that pass without proving anything (an assertion identical to
  the value it checks, a target never invoked, an absence observed on a
  bystander). Deterministic and advisory; a zero denominator exits 3 rather than
  reporting a pass.

## SKILL.md Format

Every skill in this tree follows the same structure:

1. **Tagline** — one sentence, what the skill does
2. **When to Use** — bulleted use-cases plus explicit NOT-for clauses
3. **Process** — broken into numbered phases with numbered steps
4. **Canary Integration** — files, env vars, and project entry points the skill
   touches
5. **Success Criteria** — measurable end-state conditions
6. **Rationalizations to Reject** — table of common shortcuts and why they fail
7. **Examples** — concrete walk-throughs (happy path + at least one failure
   path)
8. **Escalation** — when to stop the skill and surface to the user

This shape comes directly from the harness-engineering skill convention. Skills
authored outside this format don't belong here — file them as guides or wiki
pages.

## Usage

### Claude Code

Invoke by referencing the skill name in conversation, or via one of the 13
registered slash commands (`commands/*.md`) that wrap a skill or agent — e.g.
`/canary-write-test`, `/canary-ci-ready`, `/canary-critical-areas`. See
[README.md's Usage section](../../README.md#-usage) for the full
command-to-skill mapping.

```text
Use the canary-generate-test skill to write a load test for /v1/search.
```

### Programmatic

Most skills here are documentation, not executable artifacts — they describe
_how an agent should behave_, not a function to call. Several are bundled
executable skills with their own CLI entry point (`cli:` in frontmatter).
`canary-fail-fast`, `canary-katana`, and `canary-blackhawk` ship a Node entry
(`scripts/cli.mjs`); `canary-instrument` and `canary-test-reporter` ship a
Python entry (`scripts/cli.py`). Run those directly, e.g.:

```bash
node agents/skills/claude-code/canary-fail-fast/scripts/cli.mjs --help
```

For the rest — generation, review, healing, and analysis — there is no
standalone `generate`/orchestrator command; that pipeline was removed in v3.0
and now runs through the Claude Code plugin (`/canary-write-test` and friends)
using your session's own LLM. The deterministic, no-LLM subset of that work
(`recommend`, `init`, `run`, `review-test`, `flake-check`, `heal-test`,
`migrate`, and more) is exposed on the `canary` CLI — run `canary --help`, or
see [README.md's Usage section](../../README.md#-usage) for the full,
use-case-organized command list.

## Authoring New Skills

Before adding a skill, confirm:

- The workflow is **prescriptive** (a sequence an agent should follow), not
  **descriptive** (an explanation of how something works). Descriptive content
  goes in `docs/guides/`.
- The workflow is **agent-invokable** — there's a clear trigger phrase or
  context that should make an agent reach for it.
- The workflow has **at least one rationalization worth rejecting** — if no
  shortcut is tempting, the skill is probably too thin and should be a guide
  instead.

Then mirror the SKILL.md format above. Use the existing skills in this catalog
as templates — match section ordering, table style, and example density.

## The skill-CLI contract

A skill that declares `cli:` in its frontmatter ships an executable entry point,
and every one of them behaves the same way. That uniformity is enforced, not
merely encouraged: `test/skill-cli-conformance.test.ts` **discovers** every
SKILL.md declaring `cli:` and holds it to the contract below, so a new skill is
covered the moment it lands rather than when someone remembers to add a copy.

| Situation                                        | stdout/stderr                            | Exit                |
| ------------------------------------------------ | ---------------------------------------- | ------------------- |
| `--help` / `-h`                                  | usage on **stdout**                      | 0                   |
| unknown flag, missing/empty value, bad int       | `<prog>: error: <message>` on **stderr** | 2                   |
| runtime failure (missing file, unreadable input) | `<prog>: <message>` on stderr            | 1                   |
| advisory run, findings present                   | report                                   | 0 unless `--strict` |
| zero items verified                              | the abstention line                      | 3 under `--strict`  |

Do not hand-roll the parsing loop. Five skills did, and the same bug class came
back three consecutive rounds — the pattern was copy-paste, so each new skill
inherited whichever version its author copied, and two copies drifted into
passing against buggy code. Instead, declare a spec and export it:

```js
import {
  createParser,
  formatUsageError,
  EXIT_USAGE,
} from '../../../lib/parse-args.mjs';

export const CLI_SPEC = {
  prog: 'canary-example',
  booleans: { '--json': 'json', '--strict': 'strict' },
  values: { '--repo': { key: 'repo' }, '--seed': { key: 'seed', type: 'int' } },
  defaults: { repo: '.' },
  required: [],
  // Declaring positionals also enables `--` and a lone `-`; a CLI that takes
  // no paths gets neither, since there is nothing for them to protect.
  positionals: { key: 'paths', defaults: ['.'] },
};

const parseArgs = createParser(CLI_SPEC);
```

`CLI_SPEC` is the bridge between discovery and per-skill flags: the conformance
suite reads it to generate that skill's cases. A CLI that hand-rolls its parser
again exports no spec and fails the suite.

[`lib/parse-args.mjs`](lib/parse-args.mjs) owns four invariants that are easy to
get wrong by hand:

1. **null-prototype lookup** — on a plain object every inherited key resolves
   truthy, so `--toString` was swallowed as a value flag instead of rejected.
2. **empty-value rejection** — `--repo=` is typed by nobody, but
   `--repo "$UNSET_VAR"` expands to `--repo ''` in any shell, and an accepted
   empty path silently retargets writes at the process CWD.
3. **arity checking** — a value flag never consumes the next flag as its value.
4. **`--flag=value`** — both spellings, everywhere, not per-skill.

Deliberate divergences from argparse, shared by the whole family: flags must be
spelled in full (no prefix abbreviation), and `--bogus --help` exits 2 rather
than printing help.

## Related

- [Guides](../../docs/guides/index.md) — descriptive component documentation
- [Architecture Deep-Dive][arch-deep-dive] — internals for skill authors who
  need to know what they're orchestrating
- [Roadmap](../../docs/roadmap.md) — planned skills and capabilities

[arch-deep-dive]: ../../docs/wiki/Architecture-Deep-Dive.md
