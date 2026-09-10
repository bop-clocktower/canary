---
name: canary-batwoman
description:
  Closure auditing — reports whether the files a closed issue's fix changed have
  actually EXECUTED since that fix merged. GitHub closes an issue on a keyword
  match in a PR body, which checks neither that the fix works nor that it ever
  ran; batwoman answers only the second question, per changed file, and names
  the files it could not answer for. Use when the user asks "did that fix
  actually run", "is this issue really done", "audit a closed issue", or after a
  batch of merges. Advisory and read-only — it never asserts correctness, never
  fails a job, and never reopens an issue. NOT a test runner, NOT a coverage
  tool (a dormant workflow has whatever coverage it always had), and NOT a
  correctness check.
cli: canary batwoman
requires: [node>=20, gh]
---

# Canary Batwoman

GitHub closes an issue when a merged PR body matches `Closes #N`. That is a
**string match with no denominator**: nothing checks that the fix works, and
nothing checks that the fix ever ran. The issue moves to `CLOSED` on the
strength of a keyword.

Batwoman audits the claim. For each file the closing PR changed, it reports
whether that artifact has executed since the merge — and, just as importantly,
which files it could not decide about.

## The founding case

canary#749 fixed a false-green in `.github/workflows/refresh-arch-baseline.yml`.
It merged as `1e0c05b` and auto-closed on the keyword. Verified afterwards:

- 11 script unit tests passed
- 97 static workflow assertions passed
- the workflow itself **had not run since twelve days before the fix merged** —
  it is label-triggered, so it stayed dormant until someone applied the label

Every gate the repo owns read that as done. The fix was real and well-tested;
its end-to-end path was unproven. **Verified and exercised are different
properties**, and that gap is what batwoman makes visible.

## Usage

```bash
canary batwoman --help
```

That one needs no credentials, no network and no fixtures. A real audit needs
the repository named and `gh` authenticated:

```bash
export GITHUB_REPOSITORY=owner/name   # never inferred from a git remote
canary batwoman --issue 749           # the report
canary batwoman --issue 749 --json    # the machine shape, for CI
```

`GITHUB_REPOSITORY` is required rather than guessed. Auditing the wrong
repository's run history would produce a confident answer about the wrong thing,
which is worse than refusing.

## What the five statuses mean

| status           | meaning                                                                    |
| ---------------- | -------------------------------------------------------------------------- |
| `exercised`      | a run started after the merge, and it names which                          |
| `not-exercised`  | the artifact has not run since — with the `on:` trigger explaining why     |
| `abstain`        | a probe looked and could not tell (unreadable history, untraceable script) |
| `no-probe`       | nothing looked: a registry gap, fixable by adding a probe                  |
| `not-applicable` | prose, config, or a file this change deleted                               |

`abstain` and `no-probe` are deliberately separate, and neither is folded into
anything resembling a pass. **The summary always prints all five counts**, and
they always sum to the changed-file total — a report over a subset presented as
a report over the whole is the exact defect batwoman exists to detect.

There is no `assessed` field, no score, and no success token anywhere in the
output. A convenient `passed: true` in the JSON is the field a CI wrapper would
grow later; it does not exist, and a test asserts it stays that way.

## What it will not tell you

- **Whether the fix is correct.** Batwoman proves execution, never behaviour. A
  workflow that ran and did the wrong thing reports `exercised`.
- **Whether coverage is adequate.** A dormant workflow has whatever coverage it
  always had; that is the point.
- **Anything about a file it has no probe for.** `ts/src/**` is an honest
  `no-probe` row in v1, countable rather than silent.

## Probes shipped

| probe             | matches                   | decides by                                                               |
| ----------------- | ------------------------- | ------------------------------------------------------------------------ |
| `workflow`        | `.github/workflows/*.yml` | a run created after the merge; reads `on:` to explain a dormant one      |
| `workflow-script` | `scripts/*.mjs`           | the workflows that name it, inheriting `exercised` if **any** caller ran |
| `no-execution`    | `*.md`, config manifests  | returns `not-applicable`, reading nothing                                |

A script nothing references **abstains** rather than reporting as never-run: "no
workflow calls this" is a statement about the repo, not about the script, which
may still be run by a hand or a hook.

## Requires the network, and says so

Batwoman shells out to `gh` for run history and for the closing PR. That is a
property, not a tier — unlike the deterministic offline detectors alongside it
(`canary-savant`, `canary-blackhawk`, `canary-cassandra`, `canary-katana`),
which run anywhere node does.

An unauthenticated or missing `gh` does not degrade to a clean report. It fails
loudly, and every affected file becomes an `abstain` naming the failure. Per
this repo's standing rule, **cannot-verify is a finding, not a skip**.

## In CI

`.github/workflows/batwoman.yml` runs it on every push to `main`, deriving the
issue from the merge commit's closing keyword — the very keyword match batwoman
questions, which is the right input precisely because it is what GitHub acted
on. Advisory: every step is `continue-on-error`, and a merge that closes nothing
is reported and skipped rather than passing silently over an empty set.
