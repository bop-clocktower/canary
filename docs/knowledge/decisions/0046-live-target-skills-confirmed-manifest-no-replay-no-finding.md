---
number: 0046
title: Live-target skills need a confirmed manifest; no replay, no finding
date: 2026-11-25
status: accepted
tier: medium
source: https://github.com/bop-clocktower/canary/issues/608
---

<!-- markdownlint-disable-file MD025 -->

# ADR 0046 — Live-target skills: confirmed manifest, no replay no finding

**Status:** accepted **Date:** 2026-11-25 **Deciders:** Bri Stevenski
(maintainer) **Related:**
[#608](https://github.com/bop-clocktower/canary/issues/608) (this decision);
`docs/changes/canary-cry/proposal.md` (D2, D4, D6); ADR 0009 (exit 3 reserved
for "abstained" — this ADR adds exit 4 beside it); ADR 0015 (the three
capability axes)

## Context

Every canary skill so far reads: source files, run history, ledgers, pull
requests. `canary-cry` is the first that **writes to a system canary does not
own**. Its live tier spams a CTA, kills a browser mid-write, and signs a second
user in on a shared session — against a running application, on purpose. Done
against the wrong host, that corrupts real data and fires real emails, webhooks
and payments.

The same skill has a second, quieter hazard. Its issue proposed letting an agent
drive the app through Playwright MCP. An agent's clicks are a transcript, not a
program: they cannot be re-run identically, so a "finding" from them cannot be
confirmed fixed before the launch it was run for. That is the unverifiable green
STRATEGY.md warns against, pointed the other way — an unverifiable red.

Both hazards will recur. `canary-huntress` (reserved for directed bug pursuit)
and any future skill that exercises a live system face them identically, so the
rules belong in a durable record rather than in one skill's spec.

## Decision

**1. A live write runs only behind a confirmed, hash-bound manifest.**

- A first invocation validates the target against a committed allowlist and
  prints a **manifest** — every action that will reach the target, every command
  the skill will execute on the operator's behalf (verbatim), every egress host,
  and the names (never the values) of every credential it will read — plus
  `manifest-sha`, the sha256 of its canonical JSON. It makes **no request to the
  target**.
- Only a second invocation carrying `--confirm <sha>` executes, and only if the
  sha equals that of a **freshly rebuilt** manifest. Any change to what would
  run changes the sha and refuses the run.
- Inside an agent, the skill places a `gate` pause between the two invocations,
  so a human reads the manifest before anything is confirmed.
- A side effect the skill **cannot** intercept is printed in every manifest, so
  approval is informed rather than assumed. For a browser-driven skill that is
  "server-side side effects (email, webhooks, payments) are NOT intercepted".

**2. Production is refused absolutely.** A target must declare a non-production
environment, and any host matching a declared production pattern is refused.
There is no override flag. A skill that needs production is a new decision, not
a flag on this one.

**3. Browser egress is locked to the target's declared hosts.** Requests to any
other host are aborted and recorded.

**4. No replay, no finding.** A finding must be produced by a deterministic,
re-runnable artifact — for canary-cry, the generated Playwright spec plus its
runtime plus its seed. An agent may help **explain** a finding after the fact
(for example, by opening it in Playwright MCP) but no agent action may
**produce** one. A scenario that could not be evaluated is an `abstain` with its
reason, never a finding and never a clean.

**5. Exit 4 means "refused by a safety gate."** A refused target, a disallowed
environment, or a manifest-sha mismatch exits 4, distinct from 2 (usage) and 3
(abstained, ADR 0009), so CI and a reviewing human can tell a safety stop from a
typo or an empty denominator. Exit 4 means nothing else on any canary surface.

## Consequences

- An operator can approve a destructive run without reading code: the manifest
  is the whole blast radius, and the sha guarantees that what runs is what was
  read.
- Two invocations instead of one. CI pins the confirmed sha next to the change
  that produced it; a stale pin refuses rather than running something unread.
- Some abuse is harder to express, because it must be compiled into a script
  rather than improvised. That cost is the point: what cannot be scripted cannot
  be replayed, and so cannot be triaged.
- The server-side limit is permanent for browser-driven skills; this ADR makes
  it visible, not solved.
- ADR 0009's code table gains a fifth row. `gate-result.ts` does not need the
  constant until a `ts/src` surface refuses on a safety gate; skill CLIs mirror
  the value, as they already mirror `EXIT_ABSTAINED`.

## Alternatives considered

- **Interactive y/N prompt.** Rejected: agents and CI have no TTY, and a prompt
  binds approval to nothing in particular.
- **An environment flag** (`CANARY_CRY_LIVE=1`). Rejected: one variable skips
  the manifest entirely, and nothing ties the approval to what ran.
- **Agent-driven exploration via Playwright MCP.** Rejected as a finding source
  (Decision 4); kept as a triage aid.
- **Refuse production by default, with an override.** Rejected for v1: demo
  hardening is non-production by definition, and an override is a flag nobody
  audits.
