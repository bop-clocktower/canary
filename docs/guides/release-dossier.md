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

| Section             | Fed when                                                         | Dark when                                                                        |
| ------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `run-history`       | at least one stored run executed a test                          | no store, a corrupt or future-version store, or no run with tests                |
| `coverage-tiers`    | at least one guardian record did not abstain and checked units   | no records, or every record abstained, checked 0 units or was malformed          |
| `guardian-findings` | same records as above                                            | same as above                                                                    |
| `ci-readiness`      | `ci-ready` scored at least one check                             | `ci-ready` abstained, or reading the store hit an unexpected (non-content) error |
| `quarantine`        | a katana v2 ledger exists (katana writes one on every scan)      | no ledger, or a file without `schema_version: 2` and `entries`                   |
| `sweep`             | a canary-sweep v1 report evaluated rules and did not abstain     | no `--sweep`, the report abstained, or its findings disagree with its summary    |
| `escapes`           | the escape log has a `tracked_since` date and an `escapes` array | no log, or no parseable `tracked_since`                                          |

A guardian record counts only when it says `source: canary-pr-guardian`, carries
a `schemaVersion`, and its `findings` array matches `summary.total`. A record
that fails any of those is listed as malformed and never read as "no findings".
Abstained records are listed too, not dropped.

`--history` moves only the run-history section. The ci-readiness section always
reads the default store under `--root`, as `canary ci-ready` does, so the two
commands cannot score different runs. A default store that exists but cannot be
read (a directory at the path, a 0-perm file) is not dark on its own: it is
ci-ready's skip on flakiness and suite runtime,
`<path> could not be read (EISDIR)`, shown in the section's facts the same way
`canary ci-ready` reports it (#1132). A corrupt or unsupported-schema default
store is the same pass-through skip, naming the line:
`<path> could not be parsed (line N: invalid JSON)` or
`<path> has unsupported schema <v> (line N; supported: 2, 3)` (#1156). Either
only goes dark if nothing else scored, and then the dark reason names it. An
error that is not a content problem (a bug in the reader, not a property of the
store) still darkens the section as `ci-ready cannot read <path> (...)`.

A section that does not apply is declared, not omitted:
`--exclude sweep="<reason>"`. The reason is printed in the dossier. An empty
reason, an unknown section id, or excluding a section whose source WAS read is a
usage error (exit 2): an exclusion declares a source out of scope, and applied
to a read source it would hide what that source found.

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
read. Paths are stored relative to `--root`, so the same evidence gives the same
digest in any checkout on any machine, and no home directory leaks into the
file. `canary manhunter verify dossier.json` exits 0 on a match, 1 on a
mismatch, 2 on a file that is not a v1 dossier. Verify also recomputes the
section counts and the verdict from the sections, so flipping the verdict and
re-hashing is still caught. This is a fingerprint, not a signature: there is no
key, and anyone can recompute it. It detects an edit made without recomputing
the digest; it cannot prove who produced the dossier. Ledger expiry is judged
against the time of the run, so a row can expire between two runs and change the
digest.

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
