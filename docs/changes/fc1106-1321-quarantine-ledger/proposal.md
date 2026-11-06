# testtracker: publish quarantine state from the katana ledger

**Keywords:** ingest-reporter, testtracker-push, canary-katana,
quarantine-ledger, tags, skipped, junit, playwright

Issue #1321. Brainstormed in autonomous mode (roadmap-fleet run fc1106, lane
A2). Every product fork was decided by a human before dispatch; they are
recorded under **Decisions made** and were not re-asked.

## Overview and goals

A quarantined test is skipped against a ticket. The tracker should show it as
**quarantined, with its ticket**, rather than as an unexplained skip. Canary
already has both halves: the katana ledger records every skipped or removed test
with an `issue` (`.canary/quarantine.json`, schema v2, #771), and the ingest
reporter and `canary testtracker push` send skipped results. Nothing connects
the two. So consumers build the join themselves, and the issue reports two
incompatible implementations of it already.

Goal: both producers take `--quarantine-ledger <path>`. Each **skipped** result
that matches a ledger row by katana's `(file, test)` identity then carries the
quarantine state and ticket as tags. Ledger rows that match no skipped result
are reported in the push output, with the count and the names.

Out of scope:

- any new ingest field or endpoint (the ingest schema has no quarantine field,
  `docs/wiki/Ingest-Reporter.md`);
- dashboard changes;
- writing to the ledger;
- `test.fixme` → quarantine syncing.

## Decisions made

| #   | Decision                                                                                                                                                                                                                                                                                | Rationale                                                                                                                                                                                                                                                                                                                                                               |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Stay inside the existing ingest contract. Quarantine rides on `ResultEntry.tags` (`npm/src/reporters/ingest/types.ts:17`), which both paths already send.                                                                                                                               | Human decision (option a). `ResultEntry` has `tags` and no annotations field, so tags are the only existing carrier. The skip reason already rides there the same way (`reason:<text>`, `describe.ts` `skipTags`).                                                                                                                                                      |
| D2  | A matched skip gets two tags: `quarantined` (the state) and `quarantine:<issue>` (the ticket). When the row has no `issue`, only `quarantined` is sent.                                                                                                                                 | The human asked for both the ticket tag and a quarantined mark. An empty `quarantine:` tag would read as a ticket called "". A row with no issue is still the ledger's claim that the test was switched off on purpose. It is also the worst state the ledger can record (SKILL.md, "Empty is a real and important state"), so it is published honestly and not hidden. |
| D3  | Only `skipped` results are tagged. A skip with no ledger row gets no quarantine tag. A ledger row whose test ran (passed or failed) is not tagged, and it is reported as unmatched.                                                                                                     | Human decision. This is the issue's own rule: a skip is published as a quarantine only when the ledger backs it.                                                                                                                                                                                                                                                        |
| D4  | Matching uses katana's `(file, test)` identity: `result.test_file === row.file`, and the result's `full_title` either equals `row.test` or ends with `" > " + row.test`.                                                                                                                | katana's `test` is the leaf title (`diffscan.mjs`, `JS_SKIP`/`PY_DEF_TEST`) and its `file` is the repo-relative diff path. Both producers build `full_title` as `… > leaf` and `test_file` as a repo-relative path, so a suffix match on the title, with an exact match on the file, is that identity.                                                                  |
| D5  | Reuse katana's own reader, `load()` in `agents/skills/claude-code/canary-katana/scripts/ledger.mjs`, through a runtime `import()`. It resolves from `<pkg>/agents/skills` (the published package, staged by `build-engine.mjs` since #757) or from `<repo>/agents/skills` (a checkout). | Human decision: no second parser. `load()` is also where v1 `ticket` migrates onto `issue`, so a copy would drift on exactly that.                                                                                                                                                                                                                                      |
| D6  | Release is implicit: tags are computed fresh on every push, so a removed row stops emitting them.                                                                                                                                                                                       | Human decision. No state is kept, so nothing is left to clean up.                                                                                                                                                                                                                                                                                                       |
| D7  | Unmatched rows are reported every push, with the count and every name. Rows of kind `removed` are left out of the unmatched list: a deleted test can never produce a result. The summary line counts them separately, so they are never dropped silently.                               | Human decision for the report. The removed-row split is this lane's own call, recorded as an assumption. Without it, every deletion ever captured would print on every push forever, and that noise would bury the real unmatched rows.                                                                                                                                 |
| D8  | A missing or unreadable ledger is loud. `testtracker push` exits 1 with "Nothing was pushed.", like an unreadable `--junit`. The reporter warns (`::warning::`) and pushes without quarantine tags, like its other config errors.                                                       | Human decision: be loud, and match the neighbouring flags. katana's `load()` returns an empty ledger for a missing file, so existence is checked first. Otherwise a typo'd path would read as "nothing is quarantined".                                                                                                                                                 |
| D9  | The reporter option is `quarantineLedger`, with env `CANARY_INGEST_QUARANTINE_LEDGER`. The CLI flag is `--quarantine-ledger <path>`. Both resolve through `resolveConfig` into `ResolvedConfig.quarantineLedger`.                                                                       | This is how every other reporter setting works (option, then env, then config). Resolving it in one place means both paths agree on it.                                                                                                                                                                                                                                 |

## Technical design

New module `npm/src/reporters/ingest/quarantine.ts`:

```ts
export const QUARANTINED_TAG = 'quarantined';
export interface QuarantineReport {
  tagged: number;
  unmatched: string[];
  removed: number;
  rows: number;
}
/** Loads the ledger through katana's own load(); throws on missing/unreadable. */
export async function loadLedgerRows(file: string): Promise<LedgerRow[]>;
/** Pure: tags matched skipped results, reports unmatched rows. */
export function applyQuarantine(
  results: ResultEntry[],
  rows: LedgerRow[],
): { results: ResultEntry[]; report: QuarantineReport };
export function quarantineSummary(report: QuarantineReport): string;
/** Load + apply; null ledger path = identity. */
export async function quarantineResults(
  cfg,
  results,
): Promise<{ results; summary?: string }>;
```

Wiring:

- `config.ts`: an option and env name, and
  `ResolvedConfig.quarantineLedger: string | null`.
- `testtracker.ts`: parse `--quarantine-ledger`, pass it to `resolveConfig`, and
  call `quarantineResults` on the rows before `buildPayload`. On a load error,
  exit 1 with nothing pushed. Write the summary to `out`.
- `ingest.ts` `deliver()`: call `quarantineResults` on the results before
  `buildPayload`. On a load error, warn and continue untagged. Log the summary.

The tags are added before `buildPayload`, so they pass through redaction and
dedupe like any other tag: a test that runs in several projects merges its tags.

## Integration Points

### Entry Points

- New flag `canary testtracker push --quarantine-ledger <path>`.
- New reporter option `quarantineLedger` and env
  `CANARY_INGEST_QUARANTINE_LEDGER`.

### Registrations Required

None. The new module is imported by `ingest.ts` and `testtracker.ts`, so it is
not an entry point and needs no `entryPoints` declaration.

### Documentation Updates

- `docs/wiki/Ingest-Reporter.md`: the option, env and flag; the two tags;
  release semantics; the unmatched report; the dashboard caveat.
- The CLI `USAGE` text.
- `CHANGELOG.md`, Unreleased / Added.

### Architectural Decisions

None warrants an ADR. The change is additive and uses the existing tags carrier.

### Knowledge Impact

Ingest tags `quarantined` and `quarantine:<issue>` mean "the katana ledger backs
this skip". The dashboard has to read them before its UI shows "quarantined".

## Success Criteria

1. When a skipped result matches a ledger row with `issue: "#123"`, the pushed
   row's tags include `quarantined` and `quarantine:#123`. This holds for JUnit
   push and for the Playwright reporter.
2. If a skipped result has no ledger row, then it carries no quarantine tag.
3. If a ledger row's test ran (it was not skipped), then that result is not
   tagged and the row is reported as unmatched.
4. When ledger rows match no skipped result, the push output names the count and
   every `file › test`.
5. When a row is removed from the ledger, the next push sends no quarantine tag
   for that test.
6. If `--quarantine-ledger` names a missing or corrupt file, then
   `testtracker push` exits 1 and pushes nothing, and the reporter emits a
   `::warning::` and pushes untagged.
7. The ledger is read by katana's `load()`, so a v1 `ticket` row publishes its
   ticket.

## Implementation Order

1. Failing tests: the JUnit path, a new test file, and the reporter path, a new
   test file.
2. `quarantine.ts`: the katana loader, `applyQuarantine` and the summary.
3. Wire `config.ts`, `testtracker.ts` and `ingest.ts`.
4. Docs, CLI help and CHANGELOG.
5. Gates and ratchets.
