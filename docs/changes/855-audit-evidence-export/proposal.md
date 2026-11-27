# Audit evidence export: a control-mapped evidence pack

**Issue:** #855 · **Route:** feature · **Slug:** `855-audit-evidence-export`

**Keywords:** audit-evidence, control-mapping, evidence-pack, no-evidence,
batwoman, katana-ledger, run-history, ci-ready, provenance

## Overview

An audit does not ask whether a team tested. It asks for evidence that a written
process was followed: a fix was verified, a skipped test had an owner and a
reason, a gate ran. Canary already produces that evidence as a byproduct, in
four places nobody would hand an auditor:

- `canary batwoman`: whether the files a closed issue changed have executed
  since the fix merged (`ts/src/batwoman-cli.ts`).
- `canary-katana`: the ledger of deleted and skipped tests, with who, when,
  which commit and why
  (`agents/skills/claude-code/canary-katana/scripts/ledger.mjs`).
- `canary history`: the run-history store, one record per recorded run
  (`ts/src/history/record.ts`).
- `canary ci-ready`: the five-check readiness score (`ts/src/core/ci-ready.ts`).

`canary evidence export --since <date>` reads those four outputs for a time
window and writes one evidence pack: `evidence-pack.json` for GRC tooling and
`evidence-pack.md` for a reviewer who reads it cold. Each evidence item is
mapped to the controls it supports and carries the commit, run or ledger entry
it came from.

**Strategy grounding.** `STRATEGY.md#tracks`, "Quality made legible": turn
evidence into durable signal that reads to people who do not open the code. This
points that track at auditors and procurement reviewers.
`STRATEGY.md#our-approach` calls for fidelity-labelled evidence over verdicts
and a deterministic engine with no network. The export follows both: it lists
evidence and never grades it, and it reads only local files.

## Goals

- G1. One command produces the whole pack for a window from outputs that already
  exist. No new analysis engine.
- G2. Every control in the catalogue appears in every pack. A control with no
  evidence in the window reads `NO EVIDENCE`.
- G3. Every source appears in every pack with its state. A source that is absent
  or cannot be read is named with the reason.
- G4. Every evidence item names the commit, run or ledger entry it came from.
- G5. The pack says in both formats that the mapping is an aid, not an
  attestation.
- G6. The pack counts evidence and never grades it, and two exports of the same
  window from the same files hold the same items.

## Non-goals

- HTML output. Deferred: the Markdown report is the reviewer format in v1.
- Running `canary batwoman` from the export. Batwoman needs the network (`gh`);
  the export reads reports that were already saved (D2).
- Grading evidence. The pack never says a control is met, satisfied or
  compliant, and has no score.
- A `canary-*` skill or a Birds of Prey name. The export is an engine command; a
  skill wrapper is a follow-up that claims its name in `docs/naming-registry.md`
  first.
- Frameworks beyond the four in the issue, and consumer-supplied control
  catalogues.
- Signing or hashing the pack, remote history backends (`--db-url`), and a
  `--json` stdout mode. The JSON file is the machine output.

## Decisions made

| #   | Decision                                                                                                                                                                                                                                                                                 | Rationale                                                                                                                                                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | The surface is the engine command `canary evidence export`, mounted through `AUDIT_COMMANDS`. Engine in `ts/src/analysis/evidence/`, CLI in `ts/src/evidence/cli.ts`.                                                                                                                    | Follows the judomaster and rewind layout (`ts/src/judomaster/judomaster-cli.ts`): the filename binds the `cli` layer and no existing module grows. `AUDIT_COMMANDS` holds 4 of its 12 allowed imports. Nothing goes under `ts/src/history` (#1074). |
| D2  | The export reads local files only. Batwoman evidence comes from saved `canary batwoman --issue N --json` reports in a directory.                                                                                                                                                         | Same inputs give the same pack, which is what "reproducible" asks for. It keeps the command deterministic with no network (`AGENTS.md`, "Naming and capability vocabulary"). See "Approaches considered".                                           |
| D3  | The window is half-open, `[since, until)`. `--since` is required. `--until` defaults to the time of the export. Both take an ISO 8601 date or date-time; a bare date is midnight UTC.                                                                                                    | A required start stops a pack from silently covering "everything". Half-open windows let consecutive packs tile without counting an item twice.                                                                                                     |
| D4  | The control catalogue is data, `ts/src/data/evidence/controls.json`, with six rows across the four frameworks. Each row lists the sources that support it.                                                                                                                               | The mapping is the part a reviewer will challenge, so it sits in one reviewable file, not spread through code. `ts/scripts/copy-data.mjs` already ships `src/data/`.                                                                                |
| D5  | Every catalogue row is rendered in both formats. A row with zero items in the window has `status: "no-evidence"` in JSON and `NO EVIDENCE` in Markdown, and lists each mapped source's state.                                                                                            | Maintainer decision. Dropping the empty rows would be a false green aimed at an auditor (`AGENTS.md`, "No silent abstention").                                                                                                                      |
| D6  | Every source is rendered with one of five states: `read`, `partial`, `absent`, `unreadable`, `out-of-window`. All but `read` carry a reason. A partly readable source is `partial` and names what it could not read.                                                                     | Maintainer decision: an unreadable source is reported, not skipped. "Absent" and "unreadable" stay apart because the fix differs.                                                                                                                   |
| D7  | The pack counts evidence and never grades it. A failed run, a batwoman report whose files are `not-exercised`, and a `not-ready` score are all evidence items, with their statuses printed.                                                                                              | An audit needs the record, including the bad days. Hiding a failed run would be the pack choosing what the auditor sees. Batwoman's own JSON has no aggregate for the same reason (`ts/src/batwoman-cli.ts`).                                       |
| D8  | The command is advisory. It exits 0 when a pack was written, 2 on a usage error. When no source produced an item it still writes the pack, prints a warning line that names why and the first fix step, and exits 0.                                                                     | It gates nothing. `AGENTS.md` asks an advisory command for an unmissable warning line on a zero denominator. The all-empty pack is still the honest artefact.                                                                                       |
| D9  | A path the caller typed that does not exist is a usage error (exit 2). Only a default path that is missing is `absent`.                                                                                                                                                                  | A typo must look like a typo (`agents/skills/claude-code/canary-signal/scripts/sources.mjs`, spec D10 there).                                                                                                                                       |
| D10 | `ci-ready` is scored at export time and is one item, dated at the export. It is linked to the `HEAD` commit of `--root`. With no resolvable `HEAD` the source is `unreadable`. With an export time outside the window it is `out-of-window`. With every check skipped it yields no item. | A readiness score has no history to window. Stating when and at which commit it was taken keeps G4. A score that scored nothing is an abstention, not evidence.                                                                                     |
| D11 | The Markdown report lists at most 25 items per source, newest first, then says how many more are in the JSON. The JSON carries every item.                                                                                                                                               | Output grows with the window (`AGENTS.md`, test-design rule 3). A year of runs must stay readable.                                                                                                                                                  |
| D12 | The pack carries run counts, not failure text. Ledger rows carry the author the ledger recorded.                                                                                                                                                                                         | `error_text` can hold secrets and is not needed to show a run happened. The ledger author is the "owner" an audit asks for, and is already in the repository.                                                                                       |
| D13 | Links are identifiers: a commit SHA, a run id, or a ledger key `file::test`. A commit also gets a GitHub URL when the repository is known (`--repo`, else `GITHUB_REPOSITORY`, else the `repo` field of a batwoman report).                                                              | Identifiers are enough to reproduce an item from its source file. A URL is a convenience and is never guessed from a git remote (`ts/src/batwoman-cli.ts`, `repoFromEnv`).                                                                          |
| D14 | Closing keyword is `Closes #855`.                                                                                                                                                                                                                                                        | All four sources, all four frameworks, both formats and the three accepted-risk constraints ship. HTML was written as "Markdown/HTML" in the issue and is deferred by the maintainer.                                                               |

### Approaches considered

- **A (chosen). Compose saved outputs from local files.** History, ledger and
  batwoman reports are read from disk; `ci-ready` is scored through the existing
  scorer. Deterministic and offline. The cost is that someone, or a CI step,
  must save batwoman reports; the report names the exact command when the
  directory is missing.
- **B. Run every source live.** The export calls `auditIssue` for each issue
  closed in the window. It needs `gh` and a token, so two exports of the same
  window can differ, and an unauthenticated run would produce a pack of
  abstentions. Rejected for v1 under G4.
- **C. A skill that asks an agent to assemble the pack.** Cheapest to build. The
  agent would decide what counts as evidence, and "never omit an empty control"
  could not be enforced by a test. Rejected under G2.

## Technical design

### Control catalogue (`ts/src/data/evidence/controls.json`)

| id                     | Framework and reference                                                 | What the evidence supports                                   | Sources                   |
| ---------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------- |
| `nist-800-40r4-2.3.3`  | NIST SP 800-40 Rev. 4, 2.3.3 Verify Deployment                          | A fix has executed since it merged                           | batwoman                  |
| `nist-800-40r4-2.3.4`  | NIST SP 800-40 Rev. 4, 2.3.4 Monitor the Deployed Patches               | Tests kept running after the change                          | history, ci-ready         |
| `iso-27001-2022-a.8.8` | ISO/IEC 27001:2022 Annex A 8.8, Management of technical vulnerabilities | Fixes were verified and changes were tested                  | batwoman, history         |
| `cis-v8-7`             | CIS Controls v8, Control 7 (Safeguards 7.2 and 7.7)                     | Remediation was followed through to a verified result        | batwoman                  |
| `soc2-cc7.1`           | SOC 2 CC7.1, detection and monitoring                                   | Test runs and readiness checks that detect regressions ran   | history, ci-ready         |
| `soc2-cc8.1`           | SOC 2 CC8.1, change management                                          | Changes were tested; removed and skipped tests were recorded | history, katana, ci-ready |

The NIST section numbers were checked against the published PDF (April 2022).
The ISO, CIS and SOC 2 references are the control identifiers named in the
issue; their descriptions here are paraphrases, not quotations.

### Types (`ts/src/analysis/evidence/types.ts`)

```ts
type SourceId = 'batwoman' | 'katana' | 'history' | 'ci-ready';
type SourceState =
  'read' | 'partial' | 'absent' | 'unreadable' | 'out-of-window';
interface EvidenceRef {
  kind: 'commit' | 'run' | 'ledger-entry';
  id: string;
  commit?: string;
  url?: string;
}
interface EvidenceItem {
  source: SourceId;
  at: string; // ISO time the item is dated at
  summary: string;
  ref: EvidenceRef;
}
interface SourceReport {
  id: SourceId;
  path: string;
  state: SourceState;
  reason?: string; // required unless state is 'read'
  read: number; // records read from the source
  inWindow: number; // items inside the window
  undated: number; // records with no usable date, placed nowhere
  items: EvidenceItem[];
}
interface ControlRow {
  id: string;
  framework: string;
  reference: string;
  supports: string;
  sources: SourceId[];
  status: 'evidence' | 'no-evidence';
  items: number;
}
interface EvidencePack {
  schema: 'canary-evidence-pack/1';
  disclaimer: string;
  generated_at: string;
  window: { since: string; until: string };
  commit: string | null;
  sources: Omit<SourceReport, 'items'>[];
  controls: ControlRow[];
  items: (EvidenceItem & { controls: string[] })[];
}
```

### Modules

- `analysis/evidence/sources.ts` reads the three file-backed sources. History
  goes through `NdjsonHistoryStore.readAll()`, so a corrupt store is
  `unreadable` with the line named (`HistoryContentError`). The ledger must
  carry `schema_version: 2` and an `entries` array, the rule
  `ts/src/analysis/manhunter/ledger.ts` already applies. Batwoman reads every
  `*.json` in its directory; a file that does not parse or lacks `issue`,
  `mergeSha`, `mergedAt` and `files` is named and the source is `partial`.
- `analysis/evidence/pack.ts` is pure. It takes the source reports, the
  catalogue and the window and returns the `EvidencePack`.
- `analysis/evidence/render.ts` is pure. It renders the Markdown report.
- `evidence/cli.ts` parses the flags, scores `ci-ready` through a function
  exported from `ts/src/ci-ready-cli.ts`, resolves `HEAD`, and writes the files.

### Item rules

| Source   | One item per              | Dated at    | Link                                                         |
| -------- | ------------------------- | ----------- | ------------------------------------------------------------ |
| history  | recorded run              | `timestamp` | `run` with `run_id`, plus `commit_sha`                       |
| katana   | ledger row                | `date`      | `ledger-entry` with `file::test`, plus `commit`              |
| batwoman | saved report (one issue)  | `mergedAt`  | `commit` with `mergeSha`; the summary names the issue and PR |
| ci-ready | the score taken at export | export time | `commit` with `HEAD` of `--root`                             |

A record with no parseable date is counted in `undated`, makes its source
`partial`, and is placed nowhere.

Two saved batwoman reports for one issue are two items; each summary names its
file. Batwoman's JSON carries no observation time, so the export cannot tell
which is newer and does not pick.

### Error cases

| Condition                                                       | Behaviour                                                |
| --------------------------------------------------------------- | -------------------------------------------------------- |
| `--since` or `--until` is not an ISO date, or `since >= until`  | exit 2, naming the value                                 |
| `--root` does not exist; `--batwoman` names a missing directory | exit 2                                                   |
| history store is missing                                        | `absent`                                                 |
| history store is corrupt or an unsupported schema               | `unreadable`, line named                                 |
| ledger is missing                                               | `absent`                                                 |
| ledger is not JSON, or not a v2 ledger with an `entries` array  | `unreadable`                                             |
| default batwoman directory is missing, or holds no `*.json`     | `absent`, with the command that saves a report           |
| one batwoman file is malformed                                  | `partial`, file named; the other files are still read    |
| any source file exists but cannot be read (EACCES, EISDIR)      | `unreadable`, errno code named                           |
| `--out` cannot be created or written                            | exit 1, path and errno code named; no partial pack claim |

### CLI

```text
canary evidence export --since <date> [--until <date>] [--root <dir>]
                       [--batwoman <dir>] [--out <dir>] [--repo <owner/name>]
```

| Input         | Default                                        |
| ------------- | ---------------------------------------------- |
| `--until`     | time of the export                             |
| `--root`      | current directory                              |
| history store | `<root>/test-results/reports/history-v2.jsonl` |
| katana ledger | `<root>/.canary/quarantine.json`               |
| `--batwoman`  | `<root>/.canary/batwoman`                      |
| `--out`       | `<root>/.canary/evidence`                      |
| `--repo`      | `GITHUB_REPOSITORY`, else none                 |

Stdout gets one line per control (`evidence: N` or `NO EVIDENCE`), one line per
source that is not `read`, and the two paths written. An export overwrites the
previous pack in `--out`.

### Markdown report layout

1. Title, window, generation time and commit.
2. The disclaimer: "This mapping is an aid, not an attestation. Canary cannot
   certify compliance. A listed item shows that a check ran and what it
   recorded; it does not show that a control is met."
3. Sources table: source, state, records read, items in window, reason.
4. Controls table: every catalogue row, with `NO EVIDENCE` or the item count,
   and each mapped source's state and count.
5. Evidence by source: up to 25 items each, newest first, each with its link.

## Integration Points

### Entry Points

- New CLI command `canary evidence export`.
- New exported function in `ts/src/ci-ready-cli.ts` that returns the readiness
  report for a root (the body of the existing action, moved).

### Registrations Required

- `AUDIT_COMMANDS` in `ts/src/commands/audit/cli.ts` (append).
- `EXPECTED_COMMANDS` in `ts/test/cli-command-registry.test.ts` (append).
- An advisory row in `ts/test/gate-conformance.test.ts`.
- `CHANGELOG.md` under `## [Unreleased]`, `### Added`, citing #855.

### Documentation Updates

- New guide `docs/guides/audit-evidence-export.md`, linking each new source
  file, and its entry in `docs/guides/index.md`.
- `AGENTS.md`, "Entry Points": add `evidence export` to the command list.
- `docs/roadmap.md`: the #855 row gets its spec and plan.

### Architectural Decisions

None rise to an ADR. D2 and D7 apply existing rules (the capability vocabulary
in ADR 0015 and the denominator rule in ADR 0009) to a new command.

### Knowledge Impact

- Concept: an evidence pack is a windowed list of evidence items mapped to
  controls. It counts and never grades.
- Relationship: `evidence export` consumes batwoman reports, the katana ledger,
  the run-history store and the `ci-ready` scorer.

## Success Criteria

1. (G2) When a control's mapped sources have no item in the window, the control
   appears in the JSON with `status: "no-evidence"` and in the Markdown as
   `NO EVIDENCE`. A test with every source empty finds all six controls in both
   formats.
2. (G3) When the history store is corrupt, the pack is still written, the
   history source is `unreadable` with the line named, and controls fed by other
   sources keep their items.
3. (G3) When a default source path is missing, that source is `absent` with a
   reason. When `--batwoman` names a missing directory, the command exits 2.
4. (G1, G4) Every item in the JSON has a `ref` with a non-empty `id`, and at
   least one control id. A test asserts this over a pack built from all four
   sources.
5. (G5) Both formats carry the disclaimer text.
6. (G6) An item dated exactly at `--until` is excluded and one dated exactly at
   `--since` is included.
7. (G6) When `--until` is omitted, the window ends at the export time (tested
   with a fixed clock, flag omitted).
8. (G1) With 500 runs in the window, the Markdown lists 25 run items and states
   that 475 more are in the JSON, and the JSON holds all 500.
9. (G2) When no source produced an item, the command exits 0, writes the pack,
   and prints a warning line naming the cause and the first fix step.
10. (G6) A second export into the same `--out` replaces the first pack; no item
    from the first survives in the second.
11. (G6) A batwoman report whose files are all `not-exercised` is listed as an
    item with those statuses in its summary, and the pack contains no `passed`,
    `score` or `compliant` field.
12. (G1) `build`, `typecheck`, `format:check` and `test` pass from `ts/`, and
    the arch, perf, entropy and docs ratchets pass without an allowance or a
    baseline edit.

## Implementation Order

1. Catalogue data and types; `pack.ts` with the empty-control test first.
2. `sources.ts`: history, ledger, batwoman readers, each with absent, unreadable
   and windowing tests.
3. `render.ts` with the disclaimer, NO EVIDENCE and 25-item cap tests.
4. `evidence/cli.ts`, the `ci-ready` export, registration, and CLI tests for
   defaults, usage errors, overwrite and the warning line.
5. Guide, index entry, `AGENTS.md`, CHANGELOG, roadmap row, ratchet measurement.

## Assumptions

No human was available to this fleet lane, so each question the brainstorm would
have asked was answered with its recommended option:

- Approach A over B and C (D2).
- The command name `canary evidence export`, with no skill and no Birds of Prey
  name in v1 (D1).
- Advisory, exit 0 on an all-empty pack with a warning line (D8).
- Six catalogue rows, with CIS Control 7 as one row naming Safeguards 7.2 and
  7.7 (D4).
- `ci-ready` is a single item scored at export time (D10).
- Saved batwoman reports default to `.canary/batwoman/` (the CLI table).
- The pack omits failure text and keeps the ledger author (D12).

Environment assumptions:

- Runtime is the engine's Node.js; source files are UTF-8.
- Dates in the sources are ISO 8601. A value `Date.parse` cannot read is
  `undated`, not guessed.
- Commit URLs assume GitHub, because `--repo` and `GITHUB_REPOSITORY` are GitHub
  `owner/name` slugs. Without a repository there is no URL.
- The catalogue is fixed at build time. A test pins that every row names only
  known sources and that every source maps to at least one control, which is
  what guarantees criterion 4.
