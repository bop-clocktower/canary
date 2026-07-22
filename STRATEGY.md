---
name: canary
last_updated: '2026-07-21'
version: 2
---

# canary Strategy

## Target problem

Teams ship test suites that pass without proving anything. Line-coverage
percentages — the number that typically gates a merge — can be maxed out by
assertion-free tests, so the gate is uncorrelated with whether a regression
would actually be caught. The cost of authoring genuinely good tests (knowing
the framework, the edge cases, the real risk surface) lands on whoever has the
least time to pay it. Suites then decay silently until a launch or a demo
exposes them.

## Our approach

Bet on fidelity-labeled evidence over verdicts. Canary never asserts "this is
tested" — it states how it knows, ranked coverage-verified › graph-verified ›
heuristic, and degrades loudly when the evidence tier drops rather than silently
guessing. Auditable provenance is the precondition for letting an agent near a
merge gate.

Second bet: a deterministic Tier-0 engine that imports no LLM, with the agent
tier strictly optional on top — so the gate stays reproducible, cheap, and
secret-free while intelligence layers above it.

Third bet: meet the engineer during development rather than at a release gate,
picking up immediately downstream of harness-engineering's architectural and
spec governance.

## Who it's for

Primary: the engineer mid-development who has just had harness-engineering
govern their architecture, spec, and review, and now needs to know whether their
tests prove the thing works. They reach for canary while writing code —
unit-test generation, edge-case discovery, bug hunting — not at a release gate.
Today they rely on a coverage percentage and their own judgment about what is
worth testing.

Secondary: client-success and delivery staff who need to answer "is this
client's platform healthy and well-covered?" without reading code, and who query
canary for coverage, health, and fleet status.

## Key metrics

- Escaped-defect ratio: defects found post-release vs. caught pre-release by a
  canary gate or exploratory sweep; issue-tracker labels reconciled against
  guardian findings and test-reporter run artifacts. Requires an incident-data
  join canary does not hold today — tracked manually at first.
- Coverage-verified finding share: percentage of guardian findings backed by
  real coverage evidence rather than heuristic inference; read from
  `canary guardian pr-check` output.
- Time to first trustworthy gate: elapsed time from install to a passing
  guardian gate; derived from canary-ci-ready scoring.

## Tracks

- Coverage evidence fidelity: widen what qualifies as coverage-verified
  (Cobertura parsing, producer contract, coverage-delta on touched units).
- Test intelligence depth: turn signals canary already computes into
  gate-consumable findings (quality_scorer, flake detection, generated-test
  soundness).
- Adoption and onboarding: shorten the distance from install to a first
  trustworthy gate.
- Pre-release confidence: adversarial exploration ahead of launches, client
  onboardings, and demos.
- Quality made legible: turn per-run, per-person evidence into durable signal
  that accrues over time and reads to people who do not open the code —
  including recognizing sound engineering, not only detecting unsound
  engineering.

## Not working on

Company-specific content of any kind — client names, internal domains,
proprietary skills, populated company.json. This repo is the open-core generic
engine; org-specific content lives only in a private overlay discovered at
runtime via `.canary/skills/`, enforced by the internal-hostname and
company-denylist guard described in AGENTS.md.
