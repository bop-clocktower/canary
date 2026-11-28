---
name: canary-hawk-dove
description:
  Outcome labels for past gate findings - was each one real, noise, intentional,
  or a defect the gate missed - kept in an append-only ledger with provenance,
  plus a per-gate report of the observed counts. Derives labels the team already
  leaves (ADR 0025 - an fp-prefixed allow-untested is noise, any other reason is
  intentional, a coverage-verified finding covered later in the same PR is real)
  and takes any other label as one CLI step, never a reaction. Below 30
  adjudicated labels per gate the report abstains (exit 3). Slice of
  #618 - it never tunes or proposes a threshold.
cli: scripts/cli.mjs
requires: [node>=20]
---

# Canary Hawk-Dove

A gate tuned too hawkish blocks good PRs and gets muted; too dovish and defects
walk through. Tuning that balance needs to know, for past findings, which were
real. Nobody records that, so this skill records it first. It is the
labels-first slice of
[#618](https://github.com/bop-clocktower/canary/issues/618). **The threshold
tuner is not built, and nothing here proposes a threshold.**

See
[the spec](../../../../docs/changes/618-hawk-dove-outcome-labels/proposal.md)
for where labels can come from, which ones a person must supply, and why the
floor is 30.

## Usage

```bash
canary skills run canary-hawk-dove -- --help
```

<!-- canary:illustrative -->

```bash
# 1. Record a guardian run (pass --pr so later runs of the same PR compare).
canary guardian pr-check --format json > guardian-run.json
canary skills run canary-hawk-dove -- record --gate guardian --from guardian-run.json --pr 1234

# 2. Label what no signal covers: one command, with evidence.
canary skills run canary-hawk-dove -- label hd1-0123456789abcdef \
  --outcome noise --by a-reviewer --evidence "issue 1234"
canary skills run canary-hawk-dove -- escape --gate guardian \
  --by a-reviewer --evidence "incident 56"

# 3. Read the counts.
canary skills run canary-hawk-dove -- report
```

| Command                                                       | What it does                                                                                    |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `record --gate G --from FILE [--pr N] [--by WHO]`             | Takes a gate run's JSON into the ledger, gives each finding a line-free id, and derives labels. |
| `label ID --outcome real\|noise\|intentional --by --evidence` | Labels one recorded finding. An unknown id is rejected, not stored.                             |
| `escape --gate G --by WHO --evidence REF`                     | Records a defect the gate missed. There is no finding id, because the gate never saw it.        |
| `report [--json] [--out PATH]`                                | Prints per-gate counts; abstains (exit 3) until a gate has 30 adjudicated labels.               |

Every command also takes `--repo DIR` (default `.`) and `--ledger PATH` (default
`.canary/hawk-dove/ledger.jsonl`, inside the repository). `label` and `escape`
take `--note TEXT`, and the writers take `--at ISO` for the provenance time
(default: now).

**Labels only count if the ledger survives.** The default path sits beside
canary-katana's `.canary/quarantine.json`, and many repositories (this one
included) gitignore `.canary/`. Commit the ledger (`git add -f`) or point
`--ledger` at a tracked path. A ledger that lives only on a CI runner is lost
with the runner, which is the persistence failure ADR 0025 records.

## Inputs

- `--gate guardian` reads `canary guardian pr-check` JSON. A finding's identity
  is its path, kind and unit.
- Any other gate supplies the scan-baseline identity shape:
  `{"findings": [{"file", "rule", "anchor"}]}`.

The id is `hd1-` plus 16 hex characters of a hash over the gate and that
identity, with whitespace runs collapsed, so a moved or re-indented line keeps
its id.

## Derived labels (guardian only)

| Rule                            | Signal                                                                                                   | Outcome     | Known false-label risk                                                 |
| ------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------- |
| `guardian-fp-suppression`       | The finding is suppressed with `canary:allow-untested fp: <why>`                                         | noise       | Low. It is a reviewer's stated verdict.                                |
| `guardian-reasoned-suppression` | Suppressed with any other reason                                                                         | intentional | A false positive whose author skipped `fp:` hides here (ADR 0025).     |
| `guardian-covered-later`        | Coverage-verified in the PR's first recorded run; gone from a later vouching run; file still in its diff | real        | Medium. A rewrite that deletes the flagged unit can also look covered. |

Each rule runs from the same signals as
[`adjudication.ts`](../../../../ts/src/guardian/adjudication.ts). A finding that
disappears without coverage evidence, or that is still present, is left
unlabelled. Every derived label names its rule and the run it came from. A later
explicit `label` overrides it, and the derived line stays in the ledger.

## Exit codes

| Code | Meaning                                                                 |
| ---- | ----------------------------------------------------------------------- |
| `0`  | Done. For `report`, at least one gate reached the floor.                |
| `1`  | The ledger or `--out` could not be written.                             |
| `2`  | A usage error, an unreadable input or ledger, or a rejected label.      |
| `3`  | `report` abstained: no ledger, no labels, or no gate reached the floor. |

## Boundaries

- It reads only regular files inside the repository's real path. A symlink
  anywhere on the path is reported as `not read: symlink`.
- git is run through argv only, with validated revisions.
- The ledger is only ever appended to. A malformed line is counted and left in
  place.
- Every printed value is escaped. Controls and ANSI are stripped, Markdown is
  escaped, autolinks are broken and lengths are clamped.
- It is not a gate and never tunes anything. For the guardian's own derived
  precision, see `canary guardian precision`.

## Scripts

[cli](scripts/cli.mjs) · [write](scripts/write.mjs) · [read](scripts/read.mjs) ·
[ingest](scripts/ingest.mjs) · [derive](scripts/derive.mjs) ·
[ledger](scripts/ledger.mjs) · [report](scripts/report.mjs) ·
[files](scripts/files.mjs) · [git](scripts/git.mjs) ·
[escape](scripts/escape.mjs)
