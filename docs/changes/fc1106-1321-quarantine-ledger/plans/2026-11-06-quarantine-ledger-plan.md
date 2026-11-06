# Plan: publish quarantine state from the katana ledger

Spec: `docs/changes/fc1106-1321-quarantine-ledger/proposal.md`. Issue #1321.
One phase, low/medium complexity. Auto-approved: no concerns were raised, there
are 6 tasks, and every product fork was decided upstream.

## Tasks

### Task 1: failing JUnit-path tests

**Files:** `npm/scripts/__tests__/testtracker-push-quarantine.test.js`

Drive `canary testtracker push --junit vitest.xml --quarantine-ledger <tmp>`
through the router with fetch stubbed, and assert on the wire payload:

- A matched skip gets `quarantined` and `quarantine:#123`.
- A skip with no row gets no quarantine tag.
- A row whose test passed gets no tag and is reported as unmatched.
- A row that matches nothing is reported, with its name and the count.
- `removed` rows are counted, not listed.
- A v1 `ticket` row publishes its ticket.
- A row with no issue sends `quarantined` alone.
- Release: the same run without the row sends no tag.
- A missing ledger exits 1 with nothing pushed.
- A corrupt ledger exits 1 with nothing pushed.

Run the tests and record them failing.

### Task 2: failing reporter-path tests

**Files:** `npm/scripts/__tests__/ingest-quarantine.test.js`

Drive `runReporter` with the `quarantineLedger` option and with
`CANARY_INGEST_QUARANTINE_LEDGER`, and assert:

- A matched skip is tagged.
- A skip in a different file is not tagged.
- A missing ledger gives a `::warning::` and the push still goes out, untagged.

Run the tests and record them failing.

### Task 3: `npm/src/reporters/ingest/quarantine.ts`

Load the ledger through katana's `ledger.mjs` `load()`, resolved at runtime from
`<pkg>/agents/skills` or from `<repo>/agents/skills`. Check that the file exists
first. Implement `applyQuarantine` (pure), `quarantineSummary` and
`quarantineResults`.

### Task 4: wiring

**Files:** `config.ts`, `testtracker.ts`, `ingest.ts`

- `config.ts`: the `quarantineLedger` option, the env name and the
  `ResolvedConfig` field.
- `testtracker.ts`: the flag, exit 1 on a load error, and the summary on `out`.
- `ingest.ts`: call it in `deliver()`, warn on error, and keep the file at 300
  lines or fewer.

Keep the edits to `testtracker.ts` and `ingest.ts` minimal, because #1581
overlaps them.

### Task 5: docs

Update `docs/wiki/Ingest-Reporter.md` (the option, the tags, release, the
unmatched report and the dashboard caveat), the CLI `USAGE` text, and
`CHANGELOG.md` (Unreleased / Added).

### Task 6: gates and ratchets

- `npm test`.
- From `ts/`: build, typecheck, format:check and test.
- `harness check-deps`, `harness validate` and `harness ci check`.
- The module-size, entropy and perf deltas against `origin/main`.

[checkpoint:human-verify] Done by the fleet's verifier, from the CI on the PR
head.
