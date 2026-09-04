# Canary name registry

The one place a `canary-*` name is minted.

Before you name a skill, a roadmap row, or an issue, add a row to the table
below. That row is the claim. Everything else — the roadmap, the tracker, the
shipped skill directory — is downstream of it.

`ts/test/bop-name-registry.test.ts` fails when the surfaces disagree with this
file, so a name minted anywhere else is a red test rather than a silent
collision discovered months later.

## Why this file exists

Birds of Prey names were minted independently by three surfaces that never read
each other: roadmap rows, GitHub issue titles, and the skills that actually
ship. The same name was claimed twice on three separate occasions. The second
occurrence was diagnosed correctly and written down _inside one of the colliding
surfaces_ — the `canary-cassandra` roadmap row still carries the sentence "the
collision was possible because roadmap rows and tracker issues both mint Birds
of Prey names and neither reads the other" — and a third collision followed
sixteen days later.

A comment inside one of the colliding surfaces is not a check. This file is
paired with one.

See [issue #754](https://github.com/bop-clocktower/canary/issues/754).

## How to claim a name

One edit:

1. Add a row to the table, alphabetically, with status `reserved`.
2. If a tracker issue exists, put its number in the `Issue` column. If the name
   also gets a roadmap row, the row's `External-ID` must carry the same number —
   the check compares them.
3. When the skill ships under `agents/skills/claude-code/<name>/`, change the
   status to `shipped`.

Retiring a name: change its status to `retired` and leave the row in place
forever. A retired name must not reappear on any surface — `oracle` is the
standing example, and the check enforces it.

## The tiebreak when two claims collide

**The better thematic fit keeps the name.** This is precedent, not preference:
both prior collisions resolved that way. `canary-cassandra` stayed with
vacuous-test detection because Cassandra Cain reads the fake; `canary-manhunter`
stayed with the release dossier because a prosecutor assembling a case file is
what a dossier is. The later claimant renames.

First-come-first-served is explicitly _not_ the rule. A name that fits its
subject is worth more than the order two people happened to type it in.

## Collision history

| When       | Collision                                                                                                                          | Resolution                                                    |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 2026-08-07 | Issue #460 and a roadmap row both claimed `canary-cassandra`                                                                       | #460 renamed to `canary-shiva`; the roadmap row kept the name |
| 2026-08-23 | A closure-verification detector was scoped as `canary-manhunter`; roadmap row #611 already held it for the release quality dossier | The new work renamed to `canary-batwoman`; #611 kept the name |

`canary-batwoman` is reserved below on the strength of that second resolution.
It has no roadmap row, no issue, and no shipped skill — the rename was agreed
and then recorded nowhere, which is the same failure in a smaller form.

## The registry

Status is one of `shipped` (a directory exists under
`agents/skills/claude-code/`), `reserved` (claimed, not built), or `retired`
(used once, never to be reused).

| Name                         | Status   | Issue | Claim                                                                      |
| ---------------------------- | -------- | ----- | -------------------------------------------------------------------------- |
| `canary-add-framework`       | shipped  | —     | Add a testing framework to the registry end-to-end                         |
| `canary-batgirl`             | reserved | 619   | Developer and team quality scorecard                                       |
| `canary-batwoman`            | reserved | —     | Closure-verification detector (renamed out of the 2026-08-23 collision)    |
| `canary-blackhawk`           | shipped  | —     | Temporal-dependency linter for test files                                  |
| `canary-cassandra`           | shipped  | 612   | Vacuous-test detection                                                     |
| `canary-ci-ready`            | shipped  | —     | Suite CI-readiness analysis                                                |
| `canary-clocktower`          | reserved | 610   | Run-history gap analysis                                                   |
| `canary-company-knowledge`   | shipped  | —     | Scaffold the org-specific `.canary/company.json` pointer file              |
| `canary-critical-areas`      | shipped  | —     | Risk-based test prioritisation                                             |
| `canary-cry`                 | reserved | 608   | Pre-launch exploratory "try to break it" sweep                             |
| `canary-edge-case-discovery` | shipped  | —     | Edge-case surfacing across six categories                                  |
| `canary-fail-fast`           | shipped  | —     | Loud, early failure surfacing for Playwright runs                          |
| `canary-failure-impact`      | shipped  | —     | Downstream blast radius of an undetected failure                           |
| `canary-fleet-health`        | shipped  | —     | Fleet-wide test health summary across suites                               |
| `canary-generate-test`       | shipped  | —     | Batch test generation through the classify → recommend → generate pipeline |
| `canary-harley`              | reserved | 616   | Property-based and fuzz test generation                                    |
| `canary-hawk-dove`           | reserved | 618   | Gate threshold auto-tuner                                                  |
| `canary-huntress`            | reserved | 617   | Targeted regression pursuit                                                |
| `canary-instrument`          | shipped  | —     | OpenTelemetry instrumentation of a Playwright run                          |
| `canary-ivy`                 | reserved | 615   | Suite overgrowth and pruning                                               |
| `canary-judomaster`          | reserved | 614   | Incident to regression test                                                |
| `canary-katana`              | shipped  | —     | Quarantine ledger for deleted and newly-skipped tests                      |
| `canary-manhunter`           | reserved | 611   | Release quality dossier                                                    |
| `canary-misfit`              | reserved | 592   | E2E resilience injection                                                   |
| `canary-mission-briefing`    | reserved | 593   | PR diff to human test charter                                              |
| `canary-pr-guardian`         | shipped  | —     | Per-diff test-guardian orchestrator                                        |
| `canary-promote-test`        | shipped  | 477   | Move a generated test into the committed suite                             |
| `canary-question`            | reserved | 613   | Test-bug vs product-bug triage                                             |
| `canary-rewind`              | reserved | 461   | Time-travel run debugging                                                  |
| `canary-savant`              | shipped  | —     | Order-dependence and isolation detector                                    |
| `canary-screech`             | reserved | 591   | Broken-main siren                                                          |
| `canary-setup-harness`       | shipped  | —     | Configure the Harness Engineering guardrails in a project                  |
| `canary-shadow`              | shipped  | —     | Differential parity testing between a baseline and a candidate             |
| `canary-shiva`               | reserved | 460   | Predictive test ordering                                                   |
| `canary-ship`                | shipped  | —     | The ship gate: adversarial review, commit, PR, merge                       |
| `canary-signal`              | reserved | 609   | QA impact digest                                                           |
| `canary-strix`               | shipped  | 799   | Company/consumer identifier leak scan (files + commit authorship)          |
| `canary-sweep`               | reserved | 594   | Site-wide a11y audit                                                       |
| `canary-test-pipeline`       | shipped  | —     | Multi-phase test intelligence orchestrator                                 |
| `canary-test-reporter`       | shipped  | —     | Playwright JSON results to Markdown and JSON reports                       |
| `oracle`                     | retired  | —     | The pre-rename product name. Never reuse.                                  |

## What the check does and does not cover

The check reads two surfaces offline: `### canary-*` rows in `docs/roadmap.md`
and directories under `agents/skills/claude-code/`. Every name it finds must
appear exactly once above, and a `shipped` row must have a real directory.

The tracker is reached transitively, not directly: a test cannot call the GitHub
API, so the check compares each registry row's `Issue` against the matching
roadmap row's `External-ID` instead. An issue that mints a name without a
roadmap row is therefore still invisible to the check — the mitigation is that a
name worth an issue is worth a registry row, and this file is the first thing
the naming convention points at.

Two things deliberately do _not_ count as minting a name:

- Launchd job labels and other identifiers that merely contain the string
  `canary-` (issue #758's scheduled deep-siren job is the live example). They
  are not skills and do not consume a skill name.
- Roadmap headings that mention an existing skill in prose rather than claiming
  it (for example "Gate canary-promote-test on structured test-craft verdicts").
  Only a heading that _begins_ with the name is a claim.
