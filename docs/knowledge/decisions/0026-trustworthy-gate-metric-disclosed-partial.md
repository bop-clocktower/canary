---
number: 0026
title: Trustworthy-gate metric is kept and disclosed as partial
date: 2026-09-15
status: accepted
tier: small
source: '#885'
---

<!-- markdownlint-disable-file MD025 -->

# ADR 0026 — Trustworthy-gate metric is kept and disclosed as partial

**Status:** accepted **Date:** 2026-09-15 **Deciders:** Bri Stevenski
**Related:** PR #914 (`canary ci-ready`); issue #885 (source issue)

## Context

STRATEGY.md lists "Time to first trustworthy gate: elapsed time from install to
a passing guardian gate; derived from canary-ci-ready scoring." Issue #885 found
that nothing computed a canary-ci-ready score, so the metric read as backed by
an existing mechanism when it was not. That is a false-green shape: the
neighbouring escaped-defect metric states its own gap ("tracked manually at
first"), and a reader or downstream skill grounding in STRATEGY.md cannot tell
the two apart.

PR #914 (merged) added `canary ci-ready [--root] [--json]`, a deterministic
producer for the skill's five checks. Only flakiness is scored today. Coverage
depth, assertion quality and critical paths skip because nothing produces
`.canary/test-inventory.json`; suite runtime skips because the history store
does not record durations. A skip is never a pass, and the `incomplete` verdict
exits 0.

Options considered: (A) keep the metric and disclose it as partial; (B)
re-derive it from install time plus the first passing `guardian pr-check`,
demoting ci-ready scoring to supporting evidence; (C) withdraw the metric until
all five checks produce.

## Decision

Keep "time to first trustworthy gate" as a STRATEGY.md key metric, and disclose
in STRATEGY.md, in the same form as the escaped-defect ratio, that it is only
partially produced: `canary ci-ready` scores 1 of 5 checks (flakiness), the
other four report `skip` with a named missing input, and the metric is tracked
manually until they produce. The disclosure names the missing producers (test
inventory, run durations) so the gap is visible where the metric is read.

The wording lands in the same change as this ADR. The metric's derivation is not
changed here; option B stays available if the ci-ready checks never fill in.

## Consequences

- STRATEGY.md stops asserting a derivation that does not exist; readers and
  grounding skills see the gap.
- The track keeps its measure instead of losing it (option C), so the
  adoption/onboarding track still has a stated target.
- The disclosure is a promise with an owner: it should be removed only when
  `canary ci-ready` scores all five checks, which needs a test-inventory
  producer and duration recording in the history store. Those remain unfiled
  follow-ups outside this ADR.
- Risk: a "partial" disclosure can become wallpaper. Mitigation: it names the
  specific skipping checks, so any change in `canary ci-ready` coverage makes
  the text visibly stale.
- #885 can close once the STRATEGY.md wording merges.

## Update 2026-09-15 (#956)

The decision stands; one of the facts behind it changed. `canary history record`
now writes per-run and per-test `duration_ms` (vitest and Playwright JSON), and
`canary ci-ready` scores suite runtime as the p95 of recorded run durations
against the absolute 5/10-minute thresholds. It still skips when no stored run
carries a duration. `canary ci-ready` therefore scores 2 of 5 checks, and the
STRATEGY.md disclosure now names only the remaining gap: the test-inventory
producer.
