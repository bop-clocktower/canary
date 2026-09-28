# canary-signal: QA impact digest (#609)

**Keywords:** digest, run-history, quarantine ledger, abstention, thin sample,
quality made legible, emit-only, chat block, skill

## Overview

Issue #609 (ideation rank 4,
`docs/ideation/bop-themed-canary-skills-2026-07-21.md`) asks for a periodic
digest of what testing actually caught, so the work of testing is visible to
people who do not open the code. It serves STRATEGY.md's "Quality made legible"
track (`STRATEGY.md`, Tracks).

The ideation's strongest objection is the design constraint: a digest reading "1
run, 0 escapes" says "QA did nothing this week" — it undersells QA and inverts
the goal. The issue's correction note removes the old blocker (the run history
store exists) but keeps the risk: **the digest must degrade honestly when
history is thin**, stating the window size and sample count explicitly.

`canary-signal` is a self-contained skill CLI that reads data canary already
persists and emits a markdown digest plus a chat-ready block. It **emits only,
never posts**, exactly like `canary-screech`
(`agents/skills/claude-code/canary-screech/SKILL.md` — "emits only, never
posts").

### Out of scope

- Posting to Slack, Teams, a PR comment, or any webhook. No network, no
  credentials, no secrets. (Human-answered fork: EMIT-ONLY.)
- New engine code under `ts/src/history` (at its 1800-LOC arch ceiling, #1074).
- Scheduling. The digest is a pure function of its inputs; a cron workflow can
  call it, and the SKILL.md shows how.

## Decisions made

| #   | Decision                                                                                                                                                                                | Rationale                                                                                                                                                                                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Emit-only: markdown artifact (`--out`) + chat-ready block on stdout. No posting.                                                                                                        | Human-answered fork. Matches `canary-screech`.                                                                                                                                                                                                |
| D2  | Self-contained skill CLI (`agents/skills/claude-code/canary-signal/scripts/*.mjs`), reading the JSONL store directly — no engine import.                                                | Every sibling skill does this (`canary-screech/scripts/history.mjs`); `ts/src/history` has zero headroom (#1074).                                                                                                                             |
| D3  | Sources: the run-history store (`--history`, required) and the katana quarantine ledger (`--ledger`, default `.canary/quarantine.json`). Production escapes are named as a dark source. | These are the two persisted records of "what testing did". No canary store records production escapes, so "escapes avoided" cannot be measured — the digest says so rather than implying zero.                                                |
| D4  | Every metric carries its own denominator; a metric whose denominator is zero **abstains** instead of printing 0.                                                                        | #508 no-silent-abstention. "0 caught" over zero pre-merge runs is the false-green shape.                                                                                                                                                      |
| D5  | Zero runs in the window → the whole digest ABSTAINS (exit 3 under `--strict`). 1–2 runs → a loud THIN SAMPLE banner.                                                                    | The ideation objection. Three runs is the smallest sample in which one run is not the whole story; the threshold is a named constant, not a flag (YAGNI).                                                                                     |
| D6  | Window = `--days N` (default 7) ending at `--until ISO` (default now).                                                                                                                  | Weekly digest is the ideation's framing; `--until` makes a digest reproducible and testable.                                                                                                                                                  |
| D7  | "Caught before `<branch>`" = distinct failing tests on runs from other branches. "Reached `<branch>`" = distinct failing tests on the default branch. Both labelled factually.          | Failures on PR/feature branches are the observable proxy for bugs stopped before merge. The copy says "failures caught on branches other than main", never "bugs prevented" as a claim — a failing test may be a test bug, not a product bug. |
| D8  | Flake count is reported only over runs whose `reporter_format` can emit `flaky` (playwright, junit); otherwise that line abstains.                                                      | Mirrors `ts/src/util/flake-window.ts:46` (`FLAKY_CAPABLE_FORMATS`). A structural zero is not a measured zero (#604).                                                                                                                          |
| D9  | Advisory by default (exit 0); `--strict`: 3 = abstained, 0 otherwise. No exit 1 "red" state — a digest has nothing to fail on. Read errors exit 1, usage 2.                             | #508 D3/D4 family contract.                                                                                                                                                                                                                   |
| D10 | An explicitly-passed `--ledger` that does not exist is an error (exit 1); the default path missing is a dark source.                                                                    | Same reasoning as `canary-screech/scripts/history.mjs`: a typo'd path must look like a typo'd path, but an absent optional source is not an error.                                                                                            |

### Approaches considered

1. **Self-contained skill over the JSONL store and ledger (chosen).** Low
   complexity; identical shape to `canary-screech`/`canary-sweep`; no engine
   headroom needed. Cost: re-reads the store rather than reusing
   `canary history summary`.
2. **New `canary signal` engine subcommand** reusing `ts/src/history` exports.
   Rejected: every new CLI subcommand pays the perf-delta ratchet and
   `history/cli.ts` is at its import limit (#1074); it buys nothing over (1).
3. **Skill that shells out to `canary history summary --json`.** Rejected:
   couples the digest to an installed, rebuilt CLI (`ts/bin/canary.js` runs
   `ts/dist`, which goes stale) and to that command's output shape.

## Technical design

```text
agents/skills/claude-code/canary-signal/
  SKILL.md                name, description, cli: scripts/cli.mjs, requires: [node>=20]
  scripts/cli.mjs         arg parsing (shared parser), orchestration, --out write, exit codes
  scripts/sources.mjs     loadRuns(history), loadLedger(path, explicit) -> {state, rows, reason}
  scripts/window.mjs      windowFor(days, until); runsInWindow; ledgerRowsInWindow
  scripts/tally.mjs       pure metrics, each {value, denominator} or {abstained, reason}
  scripts/digest.mjs      renderDigest(tally) -> {markdown, chatBlock}
agents/skills/test/canary-signal.test.ts
```

### Metrics (all pure, over the windowed runs)

| Metric             | Value                                                  | Denominator (abstains when 0)               |
| ------------------ | ------------------------------------------------------ | ------------------------------------------- |
| Runs               | runs in window, suites, distinct days                  | — (zero ⇒ whole digest abstains)            |
| Tests executed     | sum of `tests.length` (fallback `total`)               | runs                                        |
| Caught pre-merge   | distinct failing test names on non-default-branch runs | non-default-branch runs                     |
| Reached `<branch>` | distinct failing test names on default-branch runs     | default-branch runs                         |
| Flaky surfaced     | distinct tests with status `flaky`                     | runs with a flaky-capable `reporter_format` |
| Quarantine trail   | ledger rows dated in window, by `kind` and `cause`     | ledger present and non-empty (else dark)    |
| Production escapes | never measured                                         | always dark (no source)                     |

Runs without a parseable `timestamp` are excluded and **counted** ("N undated
runs excluded"), never silently dropped.

### Output

Markdown: title with window, a sample line ("N runs across S suites on K days,
`<since>` → `<until>`"), THIN SAMPLE banner if applicable, a "What testing
caught" section, a "Dark sources" section naming every source that could not be
read and why, and a fenced chat-ready block. The chat block is ≤8 plain lines
and always contains the sample line — the one line a reader of a forwarded
message must not lose.

## Integration points

### Entry points

- New skill CLI `agents/skills/claude-code/canary-signal/scripts/cli.mjs`,
  invoked via `canary skills run canary-signal -- --history …`.

### Registrations required

- `harness.config.json`: `entropy.entryPoints` and `performance.entryPoints`.
- `agents/skills/package.json` `format:check` glob;
  `agents/skills/vitest.config.ts` coverage include.
- `agents/skills/test/gate-conformance.test.ts` row (zero-denominator ⇒ exit 3).
- `skill-cli-conformance.test.ts` discovers it automatically via `cli:`.

### Documentation updates

- `agents/skills/README.md` skill tree/listing.
- `docs/naming-registry.md`: `canary-signal` reserved → shipped.
- A markdown link to the skill from `docs/` for the docs-coverage floor.

### Architectural decisions

None warrant an ADR: this is a leaf skill following the established
self-contained skill pattern.

### Knowledge impact

Concept: "denominator-carrying metric" — every digest number travels with the
count it was measured over, and abstains when that count is zero.

## Success criteria

1. When the store holds ≥3 runs in the window, the digest prints the sample
   line, per-metric values with denominators, and a chat block; exit 0.
2. When the store holds zero runs in the window, the digest prints `ABSTAINED`,
   never the "What testing caught" copy; under `--strict` exit 3.
3. When the store holds 1–2 runs in the window, the digest prints a THIN SAMPLE
   banner stating the run count.
4. If there are no non-default-branch runs, then the pre-merge line abstains
   rather than printing `0`.
5. If no run has a flaky-capable reporter, then the flaky line abstains.
6. When the ledger is absent at the default path, the Dark sources section names
   it; an explicit missing `--ledger` exits 1.
7. Production escapes are always listed as a dark source.
8. The skill makes no network call and writes nothing except `--out`.
9. `--help` exits 0; unknown flags exit 2 (shared conformance suite).

## Implementation order

1. Tests first: fixtures + unit tests for sources, window, tally, digest, cli.
2. Implement modules to green.
3. Registrations (gate-conformance row, config globs, entryPoints).
4. SKILL.md, README, naming-registry, docs link.
5. Ratchets (entropy, perf, arch, docs) vs merge base; four gates.
