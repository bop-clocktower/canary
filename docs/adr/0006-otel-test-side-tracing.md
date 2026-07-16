# ADR 0006 — Test-side-only OTel tracing (Phase 1, SUT-side deferred)

**Status:** accepted
**Date:** 2026-07-15
**Deciders:** Bri Stevenski (upstream maintainer)
**Related:** roadmap item "Overlay Upstreaming" → "OTel instrumentation
bootstrap"; `docs/changes/canary-instrument/proposal.md`

## Context

`canary-instrument` correlates each Playwright test to the outbound HTTP
requests it made, using OTel span parent/child relationships: a root span
opened per test (via a Playwright fixture) becomes the OTel active context,
so the test's own HTTP calls automatically nest as child spans of that
root. `span_reader.py` reads the resulting `otel-spans.*.jsonl` files and
resolves each trace's root via its `test.*` attributes.

This works because the *test process* is instrumented — the Node process
running Playwright, with `@opentelemetry/auto-instrumentations-node`
patching its own `http`/`undici` client calls. It says nothing about what
happens *inside* the system under test (SUT) once a request arrives:
whether the SUT propagates the trace context onward (to its own downstream
calls, a database, another service), or whether the SUT's own spans (if
any) get exported anywhere `canary-instrument` could read them.

A more complete tracing story would have the SUT also participate: accept
the inbound `traceparent` header, emit its own spans as children of the
inbound span, and export them somewhere `span_reader.py` (or a successor)
could merge in. That is a materially larger scope — it requires the SUT to
be instrumented (which `canary-instrument`, a *test-tooling* skill, does
not control), a shared or federated span sink, and correlation logic that
spans two independently-deployed processes.

## Decision

**Phase 1 (this skill, v1) instruments the test process only.** Spans come
from the Playwright/Node test runner's own HTTP client calls — never from
the SUT. `otel_bootstrap/instrument.mjs` and `playwright-fixture.ts` ship
as fixtures the *consumer's test suite* imports; nothing in this skill
touches, configures, or assumes anything about the SUT's runtime.

This is a reusable commitment, not just a v1 scope note: future pytest/k6/
plain-Node producers extending the `trace` block (see the `run.json`
contract's schema-version-stable extension point) inherit the same
boundary — they instrument their own test process, not the SUT. SUT-side
context propagation is explicitly out of scope until a concrete consumer
need exists.

## Consequences

### Immediate

- `canary-instrument` has zero coupling to the SUT's language, framework,
  or deployment shape — it works identically whether the SUT is a Node
  API, a Python service, or a third-party API this suite merely calls.
- The `run.json` contract's `by_test[].requests[]` entries describe the
  *outbound* view only (method/url/route/status/duration from the test's
  perspective). There is no SUT-side span data to merge, so no
  cross-process correlation logic is needed in `span_reader.py`.
- `coverage` (API route-hit coverage) was cut entirely from this skill
  for the same reason it's a separate roadmap item, not a `run.json`
  field: it requires knowing the SUT's actual route table, which is
  SUT-side knowledge this skill deliberately doesn't have.

### Follow-on

- If a future consumer needs full request lifecycles (test → SUT → its
  downstream calls), that is a new, larger skill (or a v2 schema bump to
  `run.json`'s `trace` block) — not a change to this ADR's boundary. The
  `trace` block's shape (list of typed producers keyed by `test_id`) is
  chosen so a v2 field can be additive.
- pytest/k6/plain-Node producers (deferred, non-goals in
  `docs/changes/canary-instrument/proposal.md`) will each instrument their
  own test process the same way — no ADR update needed to onboard them,
  since the boundary this ADR sets is per-test-process, not per-language.

### Risks

- **Incomplete picture for multi-hop requests.** If the SUT calls a
  second internal service, that hop is invisible to `run.json` — only the
  test's direct call is recorded. Mitigation: none in this skill; a
  future SUT-side tracing effort would need its own ADR when a real
  consumer asks for it.
- **Consumer confusion about "why doesn't `run.json` show my backend's
  spans?"** Mitigation: `SKILL.md` states plainly that this is
  test-side-only tracing.

### Reversibility

High. SUT-side tracing is purely additive — nothing in Phase 1's contract
or code needs to change to add it later; it would extend `run.json`'s
`trace` block or introduce a new top-level key.

## Alternatives Considered

### Alternative 1: Root span via a custom Playwright reporter

Rejected (see `docs/changes/canary-instrument/proposal.md` Decisions
table) — reporters run in Playwright's main process and can't establish
the OTel active context that makes HTTP child spans nest automatically.
The fixture approach (this ADR's mechanism) runs *in* the test's own
worker process, where the active-context propagation actually works.

### Alternative 2: Require SUT-side instrumentation from day one

Rejected for v1 — no roadmap item or spec success criterion asks for it,
and it would require this skill to make assumptions about the SUT's
language/framework/deployment that a generic, client-agnostic skill
should not make. Revisit only when a concrete consumer need exists
(YAGNI).

## Open Questions

None at this time — this ADR resolves cleanly to "test-side-only for v1,
additive extension point preserved."

## References

- `docs/changes/canary-instrument/proposal.md`
- `agents/skills/claude-code/canary-instrument/scripts/span_reader.py`
- `agents/skills/claude-code/canary-instrument/scripts/otel_bootstrap/`
- Roadmap: "Overlay Upstreaming" → "OTel instrumentation bootstrap"
