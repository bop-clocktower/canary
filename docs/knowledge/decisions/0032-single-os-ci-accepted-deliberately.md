---
number: 0032
title: Single-OS CI is accepted deliberately, and must be disclosed
date: 2026-09-21
status: accepted
tier: medium
source: https://github.com/bop-clocktower/canary/issues/892
---

<!-- markdownlint-disable-file MD025 -->

# ADR 0032 — Single-OS CI is accepted deliberately, and must be disclosed

**Status:** accepted **Date:** 2026-09-21 **Deciders:** Bri Stevenski
**Related:** [#892](https://github.com/bop-clocktower/canary/issues/892)
(resolution option 3); ADR 0026 (trustworthy gate metric — disclosed partial);
`.github/workflows/`

## Context

Every `-fleet` member's VERIFY phase treats **"all-OS CI green"** as a primary
evidence source for its per-item verdicts. In this repository that phrase has
always described a single-OS target set.

Measured in a clean worktree at `b866088b` (2026-09-21):

```console
$ grep -rho 'runs-on:.*' .github/workflows/ | sort | uniq -c
  28 runs-on: ubuntu-latest
   1 runs-on: ubuntu-latest # A4: mutation results do not vary by OS.
```

**29 of 29** `runs-on` declarations across **15** workflow files are
`ubuntu-latest`. There are zero macOS runners and zero Windows runners. When
[#892](https://github.com/bop-clocktower/canary/issues/892) was filed on
2026-09-14 the figure was 25 of 25 across 13 files, so the ratio has not drifted
toward coverage — the single-OS surface grew.

This is a denominator problem, not a CI wishlist. "Green on all target OS" is
true and empty when the target set has one member. Nothing in a fleet report
distinguishes _"verified green across every OS this project targets"_ from
_"verified green on the only OS this project tests"_, and both render
identically — the same shape as a gate that checks zero items and reports a
pass.

The tension is real rather than theoretical: canary ships as an npm package and
a set of agent skills consumed on developer machines, macOS and Windows
included, and the repo's own guidance treats cross-platform scripting as a live
concern. Path separators, line endings, case-sensitivity and shell differences
are exactly the class this configuration cannot see.

## Decision

**Canary deliberately runs CI on `ubuntu-latest` only, and every verdict built
on that CI must name the OS set it actually observed.**

Two halves, and the second is not optional:

1. **The narrowness is chosen.** A reviewer finding a single-OS matrix should
   read it as a decision recorded here, not as an oversight awaiting a fix. A PR
   that adds `macos-latest` or `windows-latest` to an existing workflow is a
   change to this ADR and needs the revisit test below met, not merely a green
   run.

2. **The limit is disclosed at the point of use.** No fleet verdict, report, or
   status line may claim or imply multi-OS assurance. A CI-derived verdict says
   "green on ubuntu-latest", never "all-OS CI green". This follows ADR 0026's
   precedent: a partial gate is trustworthy only when it discloses that it is
   partial.

Accepting single-OS makes the disclosure _more_ load-bearing, not less. Once the
narrowness is deliberate, the disclosure is the only remaining thing standing
between a single-OS green and a reader who assumes a matrix.

### What this does not license

- It does not license the phrase "all-OS CI green" anywhere in the fleet family.
  That wording is now inaccurate by decision rather than by accident.
- It does not close #892. #892's acceptance criteria are both disclosure
  criteria, and the disclosure work is not done by this record.
- It does not extend to a future workflow whose subject is genuinely
  platform-specific; see the revisit test.

## Consequences

**Accepted costs.** Platform-specific breakage reaches consumers before it
reaches CI. Path-separator, line-ending, case-sensitivity and shell defects are
found by users on macOS and Windows, or by a developer running the suite
locally, not by a gate. This is a real and ongoing exposure, accepted knowingly
in exchange for CI minutes, wall-clock on every PR, and the flake surface a
three-OS matrix adds to a repo whose required checks are already strict and
whose ratchets are absolute.

**Gained.** Verdicts stop overstating. A single-OS green that says so is worth
more than a three-OS claim nobody verified, and the fleet family's evidence
vocabulary becomes honest about its own denominator.

**Precedent for scoped exceptions.** `.github/workflows/` already carries one
inline justification (`# A4: mutation results do not vary by OS.`). A workflow
that is OS-insensitive by argument should say so at the `runs-on` line; that
comment form is the pattern.

## Revisit test

This decision is falsifiable rather than permanent. Reopen it when **any one**
of these holds:

1. A platform-specific defect reaches a consumer — an issue filed against canary
   that reproduces on macOS or Windows and not on Linux. One is enough.
2. A workflow's subject becomes genuinely platform-sensitive: filesystem path
   handling, shell invocation, line-ending-dependent parsing, or the packaged
   CLI's install path.
3. Canary is adopted by an outside org whose developers are predominantly not on
   Linux, making the exposure someone else's rather than only ours.

On any trigger, the narrow fix is option 2 from #892 — a matrix on the
platform-sensitive workflows only, not on all 15.

## Alternatives considered

**Add a full OS matrix now (#892 option 2).** Rejected as premature, not as
wrong. It triples CI minutes and wall-clock on every PR across 15 workflows,
most of which analyse text and emit JSON with no OS-sensitive surface, and it
widens the flake surface under a strict required-check ruleset where a single
red blocks the merge. The revisit test above converts this from "rejected" to
"scheduled on evidence".

**State the limit and leave the matrix question open (#892 option 1 alone).**
Rejected as incomplete. Option 1 is correct under every outcome and is adopted
here as decision half 2, but on its own it leaves the narrowness looking
accidental — a future reader finds an undisclosed-then-disclosed gap with no
record of whether anyone chose it. That ambiguity is what this ADR removes.
