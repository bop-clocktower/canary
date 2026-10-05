---
number: 0035
title: QA results travel in a versioned two-layer contract
date: 2026-10-05
status: accepted
tier: medium
source: docs/changes/canary-qa-site/proposal.md
---

<!-- markdownlint-disable-file MD025 -->

# ADR 0035 — QA results travel in a versioned two-layer contract

**Status:** accepted **Date:** 2026-10-05 **Deciders:** Bri Stevenski
**Related:** [#1151](https://github.com/bop-clocktower/canary/issues/1151);
`docs/changes/canary-qa-site/proposal.md` (D1–D5); ADR 0009 (exit 3 reserved for
"abstained"); ADR 0029 (repo-relative `file` join key); ADR 0030 (additive
schema versions)

## Context

At least three envelopes carry QA results to people who do not open code — the
TestTracker ingest run payload canary's reporter pushes, a private
unified-reporting report, and a consumer's health-signal envelope — and none
carries a version or names its scope. Each dashboard re-derives the metrics, and
the copies drift: one audited pass-rate trend returns 0% when nothing ran where
the canonical helper returns "—". canary's own outputs mix `schema_version` and
`schemaVersion`, int and string. Scope inferred from "last active" state once
resolved a handoff to the wrong tenant.

## Decision

1. **Two layers, aligned not invented (D1).** `canary.run/1` (per run, per test)
   maps field-for-field onto the ingest payload the reporter already sends;
   `canary.assessment/1` holds one assessed metric per record. A static
   `canary.site/1` feed composes them.
2. **Scope is explicit (D2).** Every record carries `scope: {id, env}`; `env` is
   opaque; nothing is inferred from a session or token.
3. **One version convention (D3).** `"contract": "canary.<layer>/<major>"`.
   Readers refuse an unknown major; a minor only adds optional fields, so
   readers tolerate unknown fields.
4. **Abstention is a value (D4).** `null` ≠ `0`; absent ≠ `[]` ≠ a list;
   `not-assessed` requires a `reason` and forbids a `value`, and every other
   status requires a value.
5. **Verification is derived (D5).** `verified_by` + `verified_at` are both set
   or both null; a producer-supplied `verified` key is refused, even `null`.
6. **Enforcement is schema-driven and zero-dependency.** The three
   `*.v1.schema.json` files in `agents/skills/lib/contracts/` are the contract;
   `validate.mjs` interprets a declared JSON Schema keyword subset and refuses,
   at load, any keyword it does not enforce. Relations between fields are named
   rules in `rules.mjs`. Exit 0 valid, 1 refused (including unparseable input),
   2 usage.
7. **No author identity in a public feed.** A site-feed register row carries no
   `who` or `author` field, and one supplied is refused, even `null`: unknown
   fields are otherwise tolerated (D3), and that tolerance must not become a way
   to publish names or email addresses.

## Consequences

- Adopting the contract is a field mapping for the reporter (phase 2), not a
  redesign; the existing ingest payload is unchanged.
- A stricter rule added after a release refuses documents that used to pass, so
  cross-record site invariants must land before the first npm release that
  carries `canary.site/1`.
- `additionalProperties`, `if/then`, `oneOf` and `format` are unavailable in the
  schemas; a contributor who needs one extends the interpreter and its tests
  first, or the validator refuses to load.
- Specs: `docs/specs/canary-run-contract.md`,
  `docs/specs/canary-assessment-contract.md`,
  `docs/specs/canary-site-feed-contract.md`.

## Alternatives Considered

- **A JSON Schema library (ajv).** Present only transitively in `ts/` and `npm/`
  via the MCP SDK; the skills tree is dependency-free so a producer's CI can run
  the validator with nothing installed. Rejected.
- **Hand-coded checks, schemas as documentation.** The schemas are what other
  teams read; a validator that does not interpret them drifts from them
  silently. Rejected.
- **Strict closure (`additionalProperties: false`).** Makes every additive minor
  a breaking change, contradicting D3. Rejected.
- **A fourth, superset envelope.** The drift problem itself. Rejected.
