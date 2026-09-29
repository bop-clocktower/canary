# canary manhunter — release quality dossier

Assemble the evidence behind a release into one report, name every source that
was dark, and fingerprint the result so the dossier that was reviewed can be
shown to be the one that was shipped.

`canary manhunter` (#611) is a composer. It runs no producer and touches no
network. It reads what `canary history record`, `canary guardian pr-check`,
canary-katana and canary-sweep already wrote, and writes markdown (and
optionally JSON). The spec is
[docs/changes/611-canary-manhunter/proposal.md](../changes/611-canary-manhunter/proposal.md).

## Usage

```bash
canary manhunter --release v2.3.0
canary manhunter --release v2.3.0 --sweep a11y/report.json \
  --out dossier.md --json-out dossier.json
canary manhunter --exclude sweep="CLI only, no UI surface"
canary manhunter verify dossier.json
```

| Option                  | Default                                 |
| ----------------------- | --------------------------------------- |
| `--root <dir>`          | current directory                       |
| `--history <path>`      | `test-results/reports/history-v2.jsonl` |
| `--analyses <dir>`      | `.harness/analyses`                     |
| `--ledger <path>`       | `.canary/quarantine.json`               |
| `--escapes <path>`      | `.canary/escapes.json`                  |
| `--sweep <path>`        | none (no convention exists)             |
| `--window <runs>`       | `30` (flaky-test window)                |
| `--exclude <id=reason>` | repeatable                              |

Relative paths resolve against `--root`.

## Sections and when each goes dark

| Section             | Fed when                                                       | Dark when                                                         |
| ------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------- |
| `run-history`       | the store holds at least one run                               | no store, a corrupt or future-version store, or 0 runs            |
| `coverage-tiers`    | at least one guardian record did not abstain and checked units | no records, or every record abstained or checked 0 units          |
| `guardian-findings` | same records as above                                          | same as above                                                     |
| `ci-readiness`      | `ci-ready` scored at least one check                           | `ci-ready` abstained (no inputs)                                  |
| `quarantine`        | the katana ledger exists and has an `entries` array            | no ledger: "nothing removed" and "katana not wired" look the same |
| `sweep`             | the sweep report evaluated rules and did not abstain           | no `--sweep`, or the report abstained                             |
| `escapes`           | the escape log has `tracked_since` and an `escapes` array      | no log, or no `tracked_since`                                     |

A section that does not apply is declared, not omitted:
`--exclude sweep="<reason>"`. The reason is printed in the dossier. An empty
reason or an unknown section id is a usage error.

## Exit codes: the checklist item

| Exit | Verdict      | Meaning                                                 |
| ---- | ------------ | ------------------------------------------------------- |
| 0    | `complete`   | every section fed or excluded with a reason             |
| 1    | `incomplete` | at least one section dark and not declared out          |
| 3    | `abstained`  | nothing was read (excluding everything also lands here) |
| 2    | —            | usage error                                             |

The verdict grades the evidence, never the product. **Worth your eyes** is
derived and never moves the exit code: dark sections first, then failing latest
runs, flaky tests, guardian coverage below the coverage tier and open findings,
failing or warning ci-ready checks, ledger rows with no linked issue or an
expired quarantine, serious accessibility findings, and recorded escapes. Each
section contributes at most ten, plus an "and N more" line.

## The escape log

Canary holds no incident data, so escaped defects are recorded by hand:

```json
{
  "schema_version": 1,
  "tracked_since": "2026-07-01",
  "escapes": [
    {
      "id": "ESC-1",
      "summary": "totals rounded wrong",
      "found_at": "2026-08-02"
    }
  ]
}
```

`tracked_since` is the denominator. An empty `escapes` list with it reads as "0
escapes recorded since 2026-07-01". Without it, the section is dark.

## The content digest

The JSON dossier carries `digest`: sha256 over the canonical JSON (keys sorted
at every depth) of every field except `generatedAt` and `digest`. Each source
file's own sha256 is inside that payload, so the digest pins which bytes were
read. The same evidence gives the same digest, and any edit to the dossier
changes it. `canary manhunter verify dossier.json` exits 0 on a match, 1 on a
mismatch, 2 on a file that is not a dossier. This is a fingerprint, not a
signature: there is no key, and it proves the dossier is unedited, not who
approved it. Ledger expiry is judged against the time of the run, so a row can
expire between two runs and change the digest.

## Source layout

- Engine (the `analysis` layer, no guardian import):
  [types.ts](../../ts/src/analysis/manhunter/types.ts),
  [sources.ts](../../ts/src/analysis/manhunter/sources.ts),
  [history.ts](../../ts/src/analysis/manhunter/history.ts),
  [guardian.ts](../../ts/src/analysis/manhunter/guardian.ts),
  [readiness.ts](../../ts/src/analysis/manhunter/readiness.ts),
  [ledger.ts](../../ts/src/analysis/manhunter/ledger.ts),
  [sweep.ts](../../ts/src/analysis/manhunter/sweep.ts),
  [escapes.ts](../../ts/src/analysis/manhunter/escapes.ts),
  [assemble.ts](../../ts/src/analysis/manhunter/assemble.ts),
  [render.ts](../../ts/src/analysis/manhunter/render.ts)
- CLI: [manhunter-cli.ts](../../ts/src/manhunter/manhunter-cli.ts), mounted
  through the `readiness` registry
  ([commands/readiness/cli.ts](../../ts/src/commands/readiness/cli.ts))
- Skill:
  [canary-manhunter](../../agents/skills/claude-code/canary-manhunter/SKILL.md)
