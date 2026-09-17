# Adoption signals: measure abandonment from guardian records (#491)

**Keywords:** adoption-signals, guardian, analyses-records, abstention,
local-first, telemetry-consent, merge-state

## Overview

The active feedback paths (#489, #490) need a consumer to _do_ something. The
people who stopped trusting canary do nothing, so the honest signals are the
passive ones. This change ships `canary adoption`: a local, read-only report
computed from the guardian's existing `.harness/analyses/` records
(`--emit-analysis`, `ts/src/guardian/analysis-emit.ts`) plus merge state read
from the local git history. It sends nothing anywhere.

Goals:

1. A consumer can see their own adoption health with no network call and no new
   instrumentation (issue acceptance 1 and 2).
2. Every signal states its denominator; a signal with nothing to count is an
   **abstention**, printed as such, never a zero that reads as healthy.
3. The telemetry stance is documented plainly: what is measured, where it goes
   (nowhere), how to turn it off, and the consent pattern any future egress must
   follow (issue acceptance 3 and 4).

Out of scope for v1: any egress, dashboards, cross-repo aggregation, gating.

## Decisions made

| #   | Decision                                                                                                                                                                                                                                              | Rationale                                                                                                                                                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | v1 is a local-first `canary adoption` report, human text plus `--json`, advisory, always exits 0.                                                                                                                                                     | Human-confirmed fork for this item. Advisory because adoption health is a conversation starter for the consumer, not a merge gate.                                                                                                  |
| D2  | **No network egress in v1.** Any future egress must follow the consent pattern of `.harness/hooks/telemetry-reporter.js` (explicit opt-in, one-time notice) and the `canary feedback` privacy stance.                                                 | Issue #491 "The consent question, up front". Signals describe the consumer's repo behaviour, so leaving the repo is telemetry.                                                                                                      |
| D3  | Merge state comes from **local git**, not the GitHub API: a record `ref` of `pr-<n>` counts as merged when the default branch's log (`git log <branch> --grep`) holds a subject ending `(#<n>)` (squash) or `Merge pull request #<n>` (merge commit). | Keeps D2 literally true (no network read either). Squash merges break SHA ancestry, so `provenance.head` cannot be used. A rebase-merged PR is not detectable and lands in `unresolved`, which is counted and printed, not guessed. |
| D4  | Signals the records cannot carry are **scoped out explicitly** and printed as `not measured` with the reason, never estimated.                                                                                                                        | Rule: a zero denominator is an abstention.                                                                                                                                                                                          |
| D5  | Records are read from `--dir` (default `.harness/analyses`), filtered to `source === "canary-pr-guardian"`; unparseable or foreign files are counted as `skipped` with a reason.                                                                      | Harness stores its own records in the same directory (`analysis-emit.ts` header); silently ignoring them would hide a mis-pointed `--dir`.                                                                                          |
| D6  | Implementation lives in a new `ts/src/adoption/` feature folder (pure `signals.ts` + git-backed `merge-state.ts` + `adoption-cli.ts`), registered through the `readiness` domain registry.                                                            | `core/adoption.ts` is already the #459 overlay adoption report (`canary migrate --adoption-report`); a separate folder avoids overloading that name. Registry per #1038, so `cli.ts` gains no import.                               |

Approaches considered (PRIORITIZE):

| Approach                              | Gain                                  | Cost / risk                                                                                                              |
| ------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **A. Local git merge state (chosen)** | Zero network; works offline and in CI | Rebase merges unresolved (counted as such)                                                                               |
| B. `gh pr view` per record            | Exact merge state                     | Network call per PR, token required, contradicts the "no egress" spirit of the confirmed fork, slow on large record sets |
| C. Records only, no merge state       | Simplest                              | Drops signal 2, the strongest "is anyone acting on this" measure the issue names                                         |

## Technical design

### Signal coverage (what the records can and cannot support)

| Issue signal                            | v1 status                  | Source                                                                                                                       |
| --------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1. Workflow deleted or disabled         | **Partial: presence only** | Local scan of `.github/workflows/*.y{a,}ml` for `guardian pr-check`. _Disabled_ state needs the Actions API: `not measured`. |
| 2. PRs merged with unaddressed findings | Measured                   | `summary.unaddressed` on `pr-<n>` records + D3 merge state. Denominator: records resolved as merged.                         |
| 3. `canary:allow-untested` usage        | Measured                   | `summary.suppressed` / `summary.total` across records; records with any suppression.                                         |
| 4. Stuck on `gate: soft`                | Measured (distribution)    | `gate` per record, plus latest record's gate by `analyzedAt`. "Indefinitely" is not a record field: reported as counts.      |
| 5. Tier degradation frequency           | Measured                   | `tier`, `degradedNotice`, `abstained`.                                                                                       |
| 6. Findings-per-PR distribution         | Measured                   | `summary.total`: min / median / p90 / max, count over 100 (#457 comment-size ceiling).                                       |

Records are one file per ref (`canary-pr-guardian-<ref>.json`), overwritten per
run, so every per-PR number is "latest run for that PR". Stated in the output.

**Record availability caveat.** A CI runner's `.harness/analyses/` is ephemeral;
canary's own `guardian.yml` does not upload it. The report reads whatever
directory it is pointed at (a local checkout, or downloaded run artifacts).
Persisting records is a consumer choice and out of scope here; an empty
directory yields a whole-report abstention.

### Types (sketch)

```ts
type Measured<T> =
  | { status: 'measured'; denominator: number; value: T }
  | { status: 'abstained'; denominator: 0; reason: string }
  | { status: 'not-measured'; reason: string };

interface AdoptionSignals {
  records: { read: number; skipped: { file: string; reason: string }[] };
  workflow: Measured<{ present: boolean; files: string[] }>;
  mergedWithUnaddressed: Measured<{
    merged: number;
    withUnaddressed: number;
    unresolved: number;
  }>;
  suppression: Measured<{
    findings: number;
    suppressed: number;
    recordsWithSuppression: number;
  }>;
  gate: Measured<{ byGate: Record<string, number>; latest: string }>;
  degradation: Measured<{
    degraded: number;
    abstained: number;
    byTier: Record<string, number>;
  }>;
  findingsPerPr: Measured<{
    min: number;
    median: number;
    p90: number;
    max: number;
    over100: number;
  }>;
}
```

`--json` emits this shape verbatim with `schemaVersion: "1.0"` and
`egress: "none"`. No aggregate score and no `healthy: true` field.

### CLI

`canary adoption [--dir <path>] [--branch <name>] [--json]`. `--branch` defaults
to `origin/HEAD`'s target, else `main`. Exit 0 always, including on abstention;
exit 2 only for usage errors (commander).

## Integration points

### Entry points

- New CLI subcommand `canary adoption` (`ts/src/adoption/adoption-cli.ts`).

### Registrations required

- Append `buildAdoptionCommand` to `ts/src/commands/readiness/cli.ts` (stays
  under the 12-import registry cap).
- Entropy `entryPoints`: none expected (reachable from `cli.ts`); verify both
  arrays in `harness.config.json` if the ratchet flags it. Never raise
  `maxFindings`.

### Documentation updates

- New `docs/guides/adoption-signals.md`: what is measured, where it goes
  (nowhere), how to turn it off (do not run it; delete records; omit
  `--emit-analysis`), and the consent rule for any future egress.
- `docs/guides/pr-guardian.md` and `docs/guides/index.md`: link to it.

### Architectural decisions

None standalone. D2 restates an existing stance (telemetry consent) rather than
creating one.

### Knowledge impact

Concept: _passive adoption signal_ (measured without consumer action), and the
rule that each carries its own denominator.

## Success criteria

1. When `.harness/analyses/` holds guardian records, `canary adoption` shall
   print all six signals, each with its denominator, and exit 0.
2. When the directory is empty or absent, the report shall mark every
   record-derived signal `abstained` and exit 0.
3. If a signal cannot be derived from records or local files (workflow
   _disabled_ state), then the report shall print `not measured` with the reason
   and shall not print a number for it.
4. When a `pr-<n>` record's number appears as a squash or merge-commit subject
   on the branch, it shall count as merged; otherwise it shall count as
   `unresolved`.
5. The command shall make no network call (tests inject git; no HTTP module is
   imported by `ts/src/adoption/`, asserted by test).
6. `--json` output shall carry `egress: "none"` and no pass/health aggregate.
7. The guide documents what is measured, where it goes, how to turn it off, and
   the opt-in consent requirement for any future egress.
8. Gates green: build, typecheck, format:check, test; CI ratchets green.

## Implementation order

1. Pure signal computation over parsed records (TDD, fixture records that are
   synthetic and de-identified).
2. Record loading with skip reasons; workflow presence scan.
3. Local git merge-state resolver behind an injected runner.
4. CLI wiring, text renderer, `--json`, registry entry.
5. Guide + doc links; ratchet checks.
