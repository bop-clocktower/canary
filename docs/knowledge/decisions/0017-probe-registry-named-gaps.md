---
number: 17
title: 'ADR 0017 — A probe registry with named gaps'
date: 2026-09-09
status: accepted
source: adr
---

<!-- markdownlint-disable-file MD025 -->

# ADR 0017 — A probe registry with named gaps

**Status:** accepted **Date:** 2026-09-09 **Deciders:** Bri Stevenski
(maintainer) **Related:** #749 (canary-batwoman, where the pattern is first
implemented); proposal decision D3; #508 (no-silent-abstention, which this
generalises); ADR 0014 (gate wiring, on checks that report over nothing)

## Context

A detector that classifies files has to do something about files it does not
understand. The cheap options are both wrong: skip them silently, or fold them
into a denominator so the report reads as complete.

`canary-batwoman` classifies every file a closing PR changed. In v1 it has
probes for workflows, workflow scripts, and prose/config — and none at all for
`ts/src/**`, `ts/test/**`, or `agents/skills/**`. That gap is large, permanent
until someone closes it, and impossible to hide honestly.

## Decision

**1. Probes are a registry, not a monolithic classifier.** Each probe declares
what it matches and answers only for that. Adding an artifact type is adding a
probe, not editing a growing conditional that every other type shares.

**2. The two ways of not knowing are separate statuses, and stay separate.**

| status     | meaning                           | what to do about it                                    |
| ---------- | --------------------------------- | ------------------------------------------------------ |
| `abstain`  | a probe looked and could not tell | investigate: unreadable history, an untraceable script |
| `no-probe` | nothing looked                    | close the gap: write a probe                           |

These are genuinely different facts about the world, and they have different
remedies. Collapsing them — into `unknown`, or into a single "not assessed"
bucket — loses which one a given file suffers from, and therefore loses whether
a human should go read a run log or write code.

**3. Every non-answer is counted and printed, in every register.** The summary
line carries one column per status and the columns sum to the changed-file
total. There is no derived `assessed` figure, because a subtotal that folds
`abstain` and `no-probe` away is indistinguishable from coverage.

**4. A `no-probe` row names the artifact type it could not classify** — "no
probe for this test file" — so the gap is enumerable rather than a silence a
reader has to notice by counting.

## Why this is worth an ADR rather than a comment

The two-status split is subtle enough to look like an accident. It reads as
redundancy — two statuses that both mean "no answer" — and the natural
simplification is to merge them. That simplification is a regression, and it
would pass every test that does not specifically assert the distinction.

It generalises #508's approach: that work made abstentions visible in the gate
register; this makes them visible per artifact, and adds the second axis of
_why_ nothing is known.

## Consequences

- Adding an artifact type is a contained change: one probe, one registration, no
  edits to existing probes.
- `ts/src/**` reports as an honest `no-probe` row in v1. The gap is loud, which
  is the point — a report that quietly omitted those files would look better and
  say less.
- A probe that throws is turned into `abstain` by the registry, so a failing
  evidence source can never present as a clean file.
- Anyone tempted to merge the two statuses has to argue with this document
  first.
