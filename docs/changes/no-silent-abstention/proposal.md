# No Silent Abstention: Denominator-Reporting Gates and the Abstained Outcome

**Status:** Approved-pending-sign-off — brainstormed 2026-07-30 (fast-track: all
four structural decisions made interactively; spec written whole). Implements
the doctrine from issue #508.

**Keywords:** abstention, denominator, gate, exit-code, conformance-suite,
doctor, guardian, freshness, negative-fixtures, zero-denominator

## Overview

Canary ran effectively broken in its flagship consuming repo for ~7 weeks while
every surface reported green: `migrate --check` exited 0 having matched zero
skills (#503, fixed), `doctor` printed "All checks passed" while skipping checks
(#505), the dry run printed "Migration complete" having migrated nothing (#504),
the plugin MCP server was dead on install (#507, fixed), and the guardian had
previously disabled itself silently (#456, fixed). One root defect: **abstention
rendered as success**.

The doctrine (issue #508):

> A check that verified zero items has abstained, not passed. Every gate, doctor
> check, and analysis command must (a) report its **denominator** — how many
> items it actually verified — and (b) treat denominator-zero / cannot-verify as
> a distinct loud outcome. "Skipped" never aggregates into "passed".

This is STRATEGY.md's own bet coming due: canary "states how it knows" and
"degrades loudly when the evidence tier drops rather than silently guessing." A
gate that cannot say what it checked has no evidence tier at all.

PR #510 (#503) shipped the doctrine's first instance and set the precedents this
spec generalizes: exit `3` = abstained, `checked` + `abstained` in JSON, loud
remediation text naming why the denominator collapsed and how to fix it.

## Goals

1. **Every gate reports its denominator** and treats zero as a distinct, loud
   outcome — exit `3` (abstained), reserved for this meaning across the entire
   CLI surface.
2. **Advisory commands abstain visibly without failing**: unmissable warning
   plus `abstained: true` in JSON, exit 0 (Decision D3).
3. **One helper, one registry:** a shared `GateResult`/`renderGateOutcome` in
   the ts engine for engine commands and npm scripts; a table-driven conformance
   suite whose registry table is the canonical list of gates, their
   gate/advisory classification, and their zero-denominator fixtures.
4. **Enforceable for future gates:** a new gate is not done until it has a
   registry row, and its row's negative fixture proves the loud outcome.
5. **Loud by default now** (Decision D1): ships in v6.4.0 with a changelog
   section listing every gate whose exit behavior changed.

## Non-goals

- No re-verification layers in consuming repos (the point is to make capwell's
  belt-and-suspenders overlay siren unnecessary, not to add more).
- No behavior flags: no `--strict-abstention`, no env toggle (D1 rejected staged
  rollout).
- No heuristic "find unregistered gates" sweep — registration is enforced by the
  new-gate checklist and review, not detection (YAGNI, revisit if a gate ships
  unregistered).
- Not in scope: #504's monorepo-aware detection and #501's overlay parser fixes
  (separate issues); this spec only takes their abstention halves (dry-run copy,
  lint's silent-empty `install_workflows`).

## Decisions Made

| #   | Decision                                                                                                                                          | Rationale                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Loud by default, v6.4.0 minor bump, changelog callout — no opt-in flag                                                                            | The bug IS the silent green; shipping off-by-default preserves it. A consumer seeing a new exit 3 is the doctrine working. #503 already set the precedent on main                        |
| D2  | Hybrid mechanic: engine helper imported by ts commands + npm scripts; convention + table-driven conformance suite for self-contained skill CLIs   | npm scripts ship beside `dist/engine/` and can import it (proven by the canary-mcp bin, #507); only skill CLIs need convention, and the conformance table holds them to it               |
| D3  | Asymmetric semantics: gates exit 3 on zero-denominator; advisory commands warn loudly + `abstained: true` but exit 0                              | "Gate" means exit-code contract; `canary history` on a fresh repo is an empty answer honestly labeled, not an error. A tool that nags gets muted (the katana lesson)                     |
| D4  | Exit 3 is reserved CLI-wide for "abstained"                                                                                                       | Matches #503; CI can distinguish "real finding" (1/2) from "checked nothing" (3) and choose retry-vs-fail per gate                                                                       |
| D5  | The conformance registry table is the canonical gate list; each row: command, layer, gate-or-advisory, zero-denominator fixture, expected outcome | Turns the fuzzy gate/advisory judgment into a reviewed one-line diff; doubles as the enforcement point for goal 4. Same architecture #479 wants for arg parsing — they share the harness |
| D6  | Delivery in 5 waves behind the helper (Approach 2), each leaving main shippable                                                                   | Wave 1 retrofits #503's shipped gate onto the helper, derisking the abstraction before it spreads. Wave discipline proven by guardian phases + TS migration                              |
| D7  | "Skipped" is always visible in summaries and never aggregates into "passed" (`All checks passed` → `All run checks passed (2 skipped)`)           | Doctor's current summary is instance zero of the doctrine violation (#505)                                                                                                               |

## Technical Design

### The helper (ts engine)

```text
ts/src/core/gate-result.ts
  GateResult<F>        { checked: number; findings: F[]; skipped?: SkipEntry[] }
  SkipEntry            { name: string; reason: string }
  EXIT_ABSTAINED = 3   // reserved CLI-wide (D4)
  gateOutcome(r, kind) -> { exitCode, abstained, summaryLine }
     kind: 'gate' | 'advisory' (D3)
     - gate + checked===0     -> exit 3, loud "Abstained — verified zero items"
     - advisory + checked===0 -> exit 0, unmissable warning line
     - skipped entries always render; never fold into the passed count (D7)
```

The CLI layer refuses to print a success line when `checked === 0` without the
abstention framing — `gateOutcome` is the only path to a summary line, so the
refusal is structural, not disciplinary. JSON surfaces gain `checked` and
`abstained` (additive, matching #503's shape).

Remediation text is required: an abstaining surface must say _why_ the
denominator collapsed and the first fix step (the #503 markdown is the
template).

### The conformance suite (registry table)

```text
ts/test/gate-conformance.test.ts       (engine + npm rows, table-driven)
agents/skills/test/gate-conformance.test.ts  (skill-CLI rows, subprocess)

Row shape:
  { command, layer: engine|npm|skill|workflow, kind: gate|advisory,
    fixture: <zero-denominator setup>, expect: exit3 | warnLine }
```

Each row builds its collapsed-denominator fixture (empty diff, 0 matched files,
unknown shape, empty history window, 0 resolved targets) and asserts the loud
outcome — the negative-testing discipline from #495 applied to every gate. The
table IS the gate registry (D5): reviewers check new commands for a row;
AGENTS.md's new-gate checklist points here.

### Audit list → wave mapping

| Surface                                                                     | Kind     | Wave |
| --------------------------------------------------------------------------- | -------- | ---- |
| `migrate --check` (shipped in #510; retrofit onto helper)                   | gate     | 1    |
| `migrate` dry-run copy ("Migration complete" → "would migrate")             | advisory | 1    |
| guardian `pr-check` / `hard-gate` (empty diff, 0 findings-eligible units)   | gate     | 2    |
| guardian `analyze` / `validate-coverage` (0 endpoints, no coverage input)   | advisory | 2    |
| `doctor` summary + consent-skips (#505 abstention half)                     | gate     | 3    |
| `overlay lint` silent-empty `install_workflows` (#501 abstention half)      | gate     | 3    |
| `review-test` / `flake-check` / `heal-test` on 0 matched files              | advisory | 4    |
| `analyze` / `history` on empty run-history windows                          | advisory | 4    |
| `skills run` resolving 0 targets                                            | gate     | 4    |
| blackhawk / savant / katana CLIs on 0 scanned files                         | advisory | 4    |
| CI workflow templates: `continue-on-error` soft jobs annotate (`::warning`) | workflow | 5    |

Skill CLIs are advisory by default (they gate only via `--strict`, which
inherits exit 3 when strict + zero-denominator).

### Versioning and rollout (D1)

- v6.4.0. CHANGELOG gains a "Gates that got louder" section enumerating every
  surface whose exit code can newly be 3 and the one-line reason.
- Workflow templates that consume gate exit codes are updated in the same
  release (template `version` field bumps so overlay freshness can push the
  correction — the #369 mechanism).

## Integration Points

### Entry Points

- New module `ts/src/core/gate-result.ts` (helper + `EXIT_ABSTAINED`).
- New conformance suites (engine/npm + skills test files).
- Modified commands per the audit table; no new commands, no new flags.

### Registrations Required

- Conformance registry rows for every audited surface (D5).
- npm scripts import the helper from `dist/engine/` (doctor, overlay lint).
- CHANGELOG + workflow-template version bumps (wave 5).

### Documentation Updates

- `AGENTS.md`: doctrine section + new-gate checklist (registry row required).
- `docs/guides/tracked-overlays.md` already documents exit 3 (#510); doctor and
  guardian guides gain the same exit-code/abstention documentation.
- CHANGELOG "Gates that got louder" (D1).

### Architectural Decisions

- D4 (exit 3 reserved CLI-wide) → ADR: cross-cutting exit-code vocabulary that
  every future command inherits.
- D5 (conformance table as canonical gate registry) → ADR: it is the enforcement
  mechanism for a doctrine, a pattern reusable beyond abstention (#479
  arg-parser conformance shares it).
- D1/D3/D6/D7 stay spec-level (consequences of the two ADRs).

### Knowledge Impact

- Knowledge entry: the abstention taxonomy (gate vs advisory, exit 3 semantics)
  and the #456/#503/#505/#507 lineage that produced it.
- Graph: `gate-result.ts` as a new core node consumed by engine commands and npm
  scripts.

## Success Criteria

1. Every row in the conformance registry passes: gates exit 3 on their
   zero-denominator fixture; advisory rows emit the warning line; no row's
   fixture produces a bare success.
2. `gateOutcome` is the only summary-line path for swept commands — grep finds
   no swept command printing success without it (reviewed per wave).
3. Doctor with N skipped checks prints `(N skipped)` and never "All checks
   passed"; doctor with zero runnable checks exits 3.
4. Guardian `pr-check` on an empty diff reports `checked: 0` and exits 3 (the
   #456 class has a permanent fixture).
5. JSON of every swept surface carries `checked` and `abstained` (additive;
   existing fields unchanged — verified by existing suites passing untouched
   except where a pin asserted silent success).
6. CHANGELOG enumerates every surface whose exit behavior changed; workflow
   templates consuming those exit codes are version-bumped in the same release.
7. AGENTS.md contains the doctrine + new-gate checklist referencing the registry
   table.
8. Full repo suite green at every wave boundary (each wave independently
   shippable, D6).

## Implementation Order

1. **Wave 1 — machinery:** `gate-result.ts` + conformance harness (empty
   registry accepted); retrofit `migrate --check` (#510) onto the helper;
   dry-run copy fix; first two registry rows.
2. **Wave 2 — guardian:** pr-check / hard-gate exit 3 on empty diff; analyze /
   validate-coverage advisory warnings; rows + fixtures.
3. **Wave 3 — npm layer:** doctor summary semantics (D7) + zero-runnable exit 3;
   overlay lint empty-`install_workflows` warning; rows (helper imported from
   `dist/engine/`).
4. **Wave 4 — long tail:** review-test / flake-check / heal-test / analyze /
   history / skills-run / skill CLIs; rows for each.
5. **Wave 5 — edges + doctrine:** CI template annotations + template version
   bumps; AGENTS.md doctrine + checklist; ADRs; CHANGELOG; v6.4.0 release.

## Deferred process steps

- `harness-soundness-review --mode spec` (fast-track; run before Wave 1
  planning).
- `advise_skills` scan → `SKILLS.md`.
- Human sign-off recorded below on approval.
