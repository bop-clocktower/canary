# Record the waypoint-sink abstention instead of configuring a sink

**Issue:** #967 **Tier:** small **Route:** feature (brainstorming → autopilot)
**Keywords:** waypoint, provenance, abstention, harness-config, fleet, adr,
sdlc-emission

## Overview

Every roadmap-fleet lane ends by running:

```bash
harness waypoint record-provenance docs/changes/<slug>/provenance.json
```

and every run returns, verbatim:

```text
Waypoint sink not configured (harness.config.json `waypoint.sink`); nothing recorded.
```

exiting 0. Issue #967 asks the repo to decide whether canary should configure
`waypoint.sink`, and — if not — to record the decision "so the no-op is not
mistaken for a working seam".

The goal of this change is **not** to make the command record something. It is
to make the silence legible: a reader who hits that line should be able to find
out, in one hop, that it is a deliberate abstention with a named revisit
condition, not a broken wire nobody noticed.

## Decisions made

**D1 — Do not configure `waypoint.sink`.** Decided by the human at fleet
CONFIRM. Rationale: there is no sink infrastructure to point at, so wiring one
would be speculative.

The mechanics support that call. `waypoint.sink.transport` accepts exactly one
value, `"spool"` ([evidence] `WaypointSinkConfigSchema`,
`dist/chunk-AWKMPQTN.js:706` in `@harness-engineering/cli@12.10.0`), which
appends JSONL segments to a repo-local `.harness/spool/` ([evidence]
`initWaypointEmitter`, `dist/chunk-SECMVKOY.js:15547`). Onward delivery is a
separate optional `ship` block requiring a service `url`, an `outpost` id, a
`project` id, and a `PNYON_WAYPOINT_INGEST_TOKEN` bearer credential from the
environment. Canary has none of those four. Turning the sink on today would
therefore create a growing local spool that is never shipped and is read by
nothing but `harness waypoint status` (which reports the spool's own health, not
the work) — strictly more moving parts than the abstention it replaced, with the
same amount of information reaching anybody.

**D2 — Record the decision as an ADR, and only as an ADR.** ADRs are the repo's
durable home for "why is it like this" and are already indexed, status-tracked,
and drift-gated ([evidence] `docs/knowledge/decisions/README.md`;
`ts/test/adr-index.test.ts`, which fails any ADR PR that skips the index row or
lets the row's status disagree with the file's frontmatter).

An AGENTS.md note was considered and rejected. The abstention is encountered
inside fleet lane output, not while reading AGENTS.md, and the ADR is reachable
by grepping the message text. A second copy of the same reasoning in AGENTS.md
would be one more thing to drift out of sync with the ADR, which is exactly what
the ADR index test exists to prevent elsewhere. The ADR is the single source.

**D3 — Name `docs/changes/<slug>/provenance.json` as the record of fleet
activity.** Since nothing is emitted, the committed provenance files are not a
redundant copy of the ledger — they are the only ledger. The ADR says so
explicitly, so a future reader looking for fleet history knows where to look
instead of assuming it is somewhere in a telemetry backend.

**D4 — State a revisit condition, not a "someday".** The ADR names what must
become true: a reachable Waypoint service url, an outpost id, a project id, and
a token delivered as `PNYON_WAYPOINT_INGEST_TOKEN` from a secret store rather
than committed. Absent those, re-opening the question is re-litigating D1 with
no new evidence.

## Technical design

No source changes, no configuration changes.

| File                                                        | Change                                  |
| ----------------------------------------------------------- | --------------------------------------- |
| `docs/knowledge/decisions/0033-waypoint-sink-abstention.md` | New ADR, status `accepted`              |
| `docs/knowledge/decisions/README.md`                        | One index row for 0033                  |
| `docs/changes/967-waypoint-sink-decision/`                  | Proposal, plan artifact, provenance     |
| `harness.config.json`                                       | **Unchanged** — no `waypoint` key added |

The ADR follows the directory's format contract: YAML frontmatter carrying
`number` and `title` (the ingestor skips the file silently without both), the
`**Status:**` / `**Date:**` bold lines, the
`<!-- markdownlint-disable-file MD025 -->` directive, and the four sections
Context / Decision / Consequences / Alternatives Considered.

Worth recording because it is counter-intuitive: `waypoint` is **not** one of
the config keys that gets silently stripped. It is declared as a tolerant
passthrough on the shared loader specifically so it does not trip the
stripped-key warning ([evidence] `dist/chunk-MFAMVKVN.js:1012`), and
`loadWaypointConfig` reads `parsed.waypoint` straight off the parsed file
([evidence] `dist/chunk-SECMVKOY.js:15322`). So the abstention is not a
schema-path bug being mistaken for a decision — the key would work. It is simply
absent, on purpose.

## Integration points

- **Entry Points:** None. No CLI surface, no module, no export.
- **Registrations Required:** The ADR index row in
  `docs/knowledge/decisions/README.md`, enforced by `ts/test/adr-index.test.ts`.
- **Documentation Updates:** The ADR itself. No AGENTS.md change (D2).
- **Architectural Decisions:** D1 — whether canary emits fleet provenance to an
  external ledger at all is exactly the kind of choice that gets re-litigated
  without a written record, which is what the issue asks for.
- **Knowledge Impact:** One decision node, once ingested. Concept: an abstention
  that is disclosed is a resolved decision, not an open defect — the same shape
  as ADR 0009 (exit 3 reserved for "abstained") and ADR 0026 (a partial metric
  kept and disclosed).

## Success criteria

1. `harness waypoint record-provenance` still returns "Waypoint sink not
   configured (harness.config.json `waypoint.sink`); nothing recorded." and
   exits 0 — unchanged behaviour is the point.
2. `harness.config.json` contains no `waypoint` key.
3. A reader who greps the repo for the phrase "Waypoint sink not configured"
   reaches a record that states it is deliberate, what the alternative would
   cost, and what would have to become true to revisit it.
4. The ADR index row exists and its status matches the file's frontmatter —
   `ts/test/adr-index.test.ts` passes.
5. `docs/changes/<slug>/provenance.json` is named in the ADR as the record of
   fleet activity.
6. The four `ts/` gates are green.

## Implementation order

1. Write ADR 0033 and add its index row.
2. Format (prettier) and lint (markdownlint) the changed docs.
3. Run the four gates from `ts/`.
4. Commit, run `record-provenance` unconditionally, quote its output, open the
   PR.
