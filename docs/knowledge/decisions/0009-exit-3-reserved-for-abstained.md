---
number: 9
title: 'ADR 0009 — Exit 3 is reserved CLI-wide for "abstained"'
date: 2026-08-03
status: accepted
source: adr
---

<!-- markdownlint-disable-file MD025 -->

# ADR 0009 — Exit 3 is reserved CLI-wide for "abstained"

**Status:** accepted **Date:** 2026-08-03 **Deciders:** Bri Stevenski
(maintainer) **Related:** #508 (doctrine), #503/#505/#507/#456 (the defect
class); `docs/changes/no-silent-abstention/proposal.md` (Decision D4)

## Context

Canary ran effectively broken in a consuming repo for roughly seven weeks while
every surface reported green. `migrate --check` exited 0 having matched zero
skills. `doctor` printed `All checks passed.` while skipping every check. The
guardian silently no-op'd on five downstream PRs. Each looked like its own bug;
all five were one defect: **abstention rendered as success**.

The root problem is that the POSIX exit vocabulary has two slots — 0 for
success, non-zero for failure — and "I verified nothing" fits neither. Squeezed
into 0 it becomes a lie. Squeezed into 1 it becomes indistinguishable from a
real finding, so CI cannot choose "retry, the input was empty" over "block, a
test is missing", and operators learn to ignore both.

A tool whose whole product is _test intelligence_ cannot afford to be unable to
report its own blindness. STRATEGY.md already commits to "degrade loudly when
the evidence tier drops rather than silently guessing"; a gate that cannot say
what it checked has no evidence tier at all.

## Decision

**Exit code 3 means "abstained — verified zero items" across the entire canary
CLI surface, and means nothing else.** The constant lives in one place,
`ts/src/core/gate-result.ts` as `EXIT_ABSTAINED`, and every layer either imports
it or mirrors it under enforcement.

The vocabulary is therefore:

| Code | Meaning                                                         |
| ---- | --------------------------------------------------------------- |
| `0`  | Verified ≥1 item, found nothing wrong                           |
| `1`  | Found something real                                            |
| `2`  | Usage error / unreadable input (surface-specific)               |
| `3`  | **Abstained** — the denominator collapsed; nothing was verified |

Three consequences follow, and they are the load-bearing part:

- **Only gates exit 3.** A "gate" is a command with an exit-code contract
  (`pr-check`, `doctor`, `migrate --check`, `review-test`). Advisory commands
  (`analyze`, `history`, the skill CLIs at rest) warn unmissably and exit 0 —
  `canary history` on a fresh repo is an empty answer honestly labeled, not an
  error. A tool that nags gets muted, which would cost more than the doctrine
  buys.
- **Findings outrank abstention.** A finding proves something was checked, so a
  weird denominator must never mask it. `gateOutcome` enforces the precedence in
  one place rather than at each call site.
- **Unknown is not zero.** A surface that _cannot_ determine its denominator
  (the remote Supabase history backend; a precision sample with no
  adjudications) reports unknown and does not abstain. Inventing an abstention
  is its own dishonesty — hence `precision: number | null` and `countRuns?()` as
  optional.

## Consequences

**A consumer seeing a new exit 3 is the doctrine working, not a regression.**
Shipping this off-by-default behind a flag would have preserved the bug for
everyone who did not opt in, so there is no `--strict-abstention` and no env
toggle (D1).

The visible cost: a docs-only PR now exits 3 from `guardian pr-check` in CI.
That is intended. Workflow templates that consume the exit code handle 3
explicitly rather than treating "non-zero" as failure.

Exit 3 was already in use in one place — `skills run`, for "refusing to invoke
an executable skill non-interactively". Rather than renumber a published ladder,
the audit found that case _is_ an abstention (zero skills executed, with an
explicit reason), so the existing code was already conformant and only its
classification was missing.

The alternative considered and rejected: a `--json`-only `abstained` field with
no exit-code change. It would have left every shell-script and CI consumer — the
majority — reading the same lie, and those are precisely the consumers who were
burned.

## Enforcement

`gateOutcome` is the only path to a summary line for swept commands, so the
refusal to print a bare success over a zero denominator is structural rather
than disciplinary. Registration is enforced by the conformance registry (ADR
0010), not by a heuristic sweep.
