# BoP Sub-branding: Character Kits, Flair Dial, and Brand Registry

**Status:** Draft — brainstormed 2026-07-30; soundness review and roadmap
promotion deferred (session pivoted to P0s). Sections 1–4 human-reviewed
section-by-section; Sections 5–6 are agent recommendations pending review.

**Keywords:** branding, flair, registry, codegen, character-kits, scope-cascade,
determinism, company-overlay

## Overview

Canary's components are named for Birds of Prey members, but the branding is
informal — one skill (blackhawk) has a tagline and rule prefix, the core CLI has
a gold banner, and everything else is unthemed. This change formalizes a full
sub-brand system: every character-named component gets a "character kit" (voice,
tagline, epigraphs, accent color, rule prefix, severity labels) driven from a
single brand registry and stamped into self-contained skills by codegen.

The theme applies to all human-readable output, including CI logs, governed by a
0–3 flair dial with per-surface overrides and a multi-scope config cascade. The
machine contract — findings JSON, rule IDs (`BH001`), exit codes, suppression
pragmas — stays canonical and untouched. Flair never alters gate behavior:
epigraph selection is deterministically seeded, so identical inputs produce
byte-identical output, preserving the Tier-0 reproducibility bet in STRATEGY.md.

## Goals

1. **One source of truth:** a brand registry defining every character kit;
   `BRANDING.md` and per-skill brand files are generated from it, never
   hand-edited.
2. **Zero drift by construction:** CI regenerates and fails on diff (same
   pattern as the arch ratchet / dogfood-strict gates).
3. **Skills stay self-contained:** codegen stamps each skill's kit into its own
   directory; no runtime dependency on the mothership.
4. **Standing convention:** every future character skill ships with a kit from
   day one — the registry entry is part of the skill's definition of done. Kits
   are pre-drafted for the ideation doc's mapped future birds.
5. **Determinism preserved:** no randomness in any themed output; machine
   surfaces byte-for-byte unchanged.
6. **Client-safe external surfaces:** flair level 0 plus the existing
   `.canary/company.json` `brand` block produces a pure company-branded
   deliverable with zero character content. Per-client env overrides
   (`company.<env>.json` with `flair.level: 0`) guarantee "the client never sees
   the birds" per engagement.

## Non-goals

- No renaming of shipped CLI commands or components (guardian et al. keep their
  names).
- No theming of JSON output, rule IDs, exit codes, or pragma syntax.
- No changes to the `company.json` `brand` schema itself.
- No new required flags — themed output defaults on for human text;
  `NO_COLOR`/non-TTY conventions respected for color (never text content).

## Decisions Made

| #   | Decision                                                                                                                                                                        | Rationale                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Full sub-brand system                                                                                                                                                           | Human call 2026-07-30 — waives the ideation doc's "wrapper, never substance" cosmetic-only rejection for _presentation_; the rule remains in force for feature candidates |
| D2  | Theme all human-readable text incl. CI logs; machine contract untouched                                                                                                         | CI logs are the largest human surface; strict gate (#500) and suppression pragmas (#498) depend on canonical IDs                                                          |
| D3  | Kits for shipped + future birds; standing convention for every future character skill                                                                                           | Ideation doc already mapped characters to jobs; registry entry is part of a new skill's definition of done                                                                |
| D4  | No retrofit of unbirded components (guardian, test-reporter, doctor, fail-fast, instrument)                                                                                     | Dual identities confuse users                                                                                                                                             |
| D5  | Registry + codegen stamping                                                                                                                                                     | Only design satisfying single-source-of-truth AND skill self-containment; proven pattern (generate-slash-commands, arch ratchet)                                          |
| D6  | Deterministic epigraph selection (seeded by content digest, never Math.random)                                                                                                  | Tier-0 reproducibility: identical inputs → byte-identical output                                                                                                          |
| D7  | Flair is a 0–3 dial with per-surface trim knobs, not a switch                                                                                                                   | Human call — tunable blend of company/dry/professional vs. canary flair; levels: 0 Suit & Tie, 1 Business Casual, 2 Field Kit (default), 3 Full Aviary                    |
| D8  | Oracle stays retired; Gypsy excluded; registry encodes tombstones                                                                                                               | Standing decisions become enforced invariants — generator hard-fails on reuse                                                                                             |
| D9  | Scope cascade, most specific wins: default < org (`~/.canary`) < project (`.canary/`) < env (`company.<env>.json`) < `CANARY_FLAIR` < test-set/reporter config < `--flair` flag | Every scope the user needs (company, client, codebase, env, test set, execution) has a rung; rides the existing CompanyKnowledge precedence chain                         |
| D10 | `canary flair` settings command with resolved-value provenance and `--preview`                                                                                                  | A CLI's settings page; provenance ("which scope set this") matches canary's evidence-first voice                                                                          |

### Flair levels (D7)

| Level | Codename            | What renders                                                                 |
| ----- | ------------------- | ---------------------------------------------------------------------------- |
| 0     | Suit & Tie          | Dry professional output; company brand if configured; zero character content |
| 1     | Business Casual     | + component accent colors; names render plainly                              |
| 2     | Field Kit (default) | + taglines, themed section headers, character-voiced summaries               |
| 3     | Full Aviary         | + epigraphs, banner art, themed severity labels, maximum voice               |

Per-surface overrides pin individual surfaces (`banner`, `colors`, `taglines`,
`voice`, `epigraphs`, `severityLabels`) to a level different from the master
dial; unset surfaces inherit it.

```jsonc
"flair": {
  "level": 2,
  "surfaces": { "banner": 3, "epigraphs": 0, "severityLabels": 1 }
}
```

Company branding is orthogonal: it applies whenever configured, at any level.

## Technical Design

### File layout

```text
brand/registry.json            # single source of truth (schema-validated)
scripts/generate-brand.mjs     # codegen: registry -> per-skill brand.mjs + BRANDING.md
ts/src/core/flair.ts           # cascade resolver (level + surface + provenance)
ts/src/ui/brand.ts             # render helpers for core CLI surfaces
agents/skills/claude-code/<skill>/scripts/brand.mjs   # GENERATED
BRANDING.md                    # GENERATED brand book
```

### Registry schema (per character)

```jsonc
{
  "version": 1,
  "retired": ["oracle", "gypsy"],
  "characters": {
    "blackhawk": {
      "character": "Lady Blackhawk (Zinda Blake)",
      "status": "shipped", // shipped | reserved | future
      "role": "temporal-dependency linter",
      "accent": "#3D6DB5",
      "rulePrefix": "BH",
      "tagline": "Finds the lines the calendar will break.",
      "voice": "Aviator precision. Flight-log terseness. Time is not your friend.",
      "epigraphs": [
        "A test that reads the wall clock is a test with a scheduled outage.",
        "Lost sixty years to a time slip. Knows exactly what a timezone can do to you.",
        "Midnight, DST, and Feb 29 walk into your suite. She's already there.",
      ],
      "severityLabels": {
        "high": "mayday",
        "medium": "turbulence",
        "low": "crosswind",
      },
    },
  },
}
```

### Shipped-character kit drafts

| Kit                  | Character hook                                                                                | Tagline                                         |
| -------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| canary (masterbrand) | Coal-mine canary × sonic scream — detection + alarm in one bird                               | "Sings when something's wrong."                 |
| canary-cry           | The Canary Cry: one scream, everything shatters — broad exploratory sweep                     | "One cry, every weak point in the room."        |
| blackhawk            | Zinda Blake: WWII pilot displaced 60 years — a literal victim of time skew, linting time bugs | "Finds the lines the calendar will break."      |
| katana               | The Soultaker sword keeps the souls it takes — deleted-test provenance capture                | "No test dies unrecorded."                      |
| savant               | Canon: perceives memories out of chronological order — detecting order-dependence             | "Remembers everything. In no particular order." |

Future birds (clocktower, signal, cassandra, misfit, manhunter, question,
judomaster, ivy, harley, hawk-dove, batgirl) get `status: "future"` stubs
(accent + tagline only). Huntress stays `reserved`. Severity label sets are
per-character (e.g. katana: severed/nicked/scratched).

### Flair resolution

`resolveFlair(sources) -> { level, surfaces, provenance }` — pure function in
`ts/src/core/flair.ts`, cascade per D9, every resolved value carries which scope
set it. Generated `brand.mjs` embeds a ~30-line copy of the resolver (reads
`.canary/company.json` tiers, `CANARY_FLAIR`, `--flair`) so skills stay
self-contained; duplication is owned by the generator.

### Rendering rules

- Surfaces gated by resolved level per the D7 table.
- Epigraph index = `fnv1a(inputsDigest) % epigraphs.length` (FNV-1a already in
  the codebase from feature-flag bucketing).
- Themed severity labels render at level 3 only, always suffixed with the
  canonical word — `MAYDAY (high)` — so CI-log grep for "high" still matches.
  JSON untouched.
- Company brand applies at any level when configured; level 0 + brand block =
  pure client deliverable.
- `NO_COLOR`/non-TTY suppresses ANSI only, never text content.

### Sample: blackhawk finding at level 0 vs 3

```text
# --flair 0
[high] BH001-wall-clock  tests/auth.test.ts:42  Date.now() in test body

# --flair 3
  BLACKHAWK — Finds the lines the calendar will break.
  "Midnight, DST, and Feb 29 walk into your suite. She's already there."

  MAYDAY (high)  BH001-wall-clock  tests/auth.test.ts:42  Date.now() in test body
```

### CI drift gate

`generate-brand --check` in the dogfood workflow: regenerate to temp dir, fail
on diff. All generated files carry a "Generated — do not edit" header.

## Integration Points

### Entry Points

- New CLI command `canary flair` (resolved levels + provenance; `--preview <n>`)
- New global flag `--flair <0-3>` on output-producing commands
- New env var `CANARY_FLAIR`
- New `flair` config key in `.canary/company.json` (all cascade tiers) and
  test-set/reporter config
- New script `scripts/generate-brand.mjs` (with `--check`)
- Generated artifacts: `BRANDING.md`, per-skill `scripts/brand.mjs`

### Registrations Required

- `canary flair` in the commander command tree + help text
- `generate-brand --check` step in the dogfood/CI workflow
- `flair` key in `config-validation.ts` and company-knowledge schema warnings

### Documentation Updates

- `AGENTS.md`: brand registry section + "new character skill = registry entry
  first" convention (D3)
- README reference to generated `BRANDING.md`
- Themed skills' `SKILL.md`: note generated `brand.mjs` + flair flag
- Skill-authoring docs: kit creation on the new-skill checklist

### Architectural Decisions

- D5 (registry + codegen stamping) → ADR: sets the pattern for any future
  shared-data-into-self-contained-skills problem.
- D9 (flair scope cascade) → ADR: six-scope precedence order will be
  re-litigated without a written record.

### Knowledge Impact

- Knowledge entry: character-to-component mapping + tombstone rationale.
- Auto-memory roster gains "kit shipped" status per character (post-merge).
- Graph: `flair.ts` as a new core node; generated files marked codegen so drift
  detectors skip them.

## Success Criteria (agent-recommended, pending review)

1. `generate-brand --check` passes in CI; hand-editing any generated file fails
   the gate.
2. Adding a kit named `oracle` or `gypsy` makes the generator exit non-zero with
   a tombstone message.
3. Byte-identical output across two runs with identical inputs at every flair
   level (determinism test per themed surface).
4. Flair level 0 + populated brand block yields output with zero character
   strings (snapshot test asserts no registry tagline/epigraph/character name
   appears).
5. Cascade resolution: for each adjacent scope pair in D9, the more specific
   scope wins, and `canary flair` reports the winning scope by name.
6. Machine contract regression: findings JSON, rule IDs, exit codes, and pragma
   matching are byte-identical before/after at all flair levels.
7. `canary flair --preview <n>` renders a sample block for each level 0–3.
8. Themed severity labels always carry the canonical suffix; `grep high` over
   level-3 CI logs matches every high finding.

## Implementation Order (agent-recommended, pending review)

1. **Registry + schema + tombstones** — `brand/registry.json`, validation,
   shipped kits, future stubs (TDD on validator).
2. **Flair resolver** — `ts/src/core/flair.ts` cascade + provenance, config
   plumbing (`company.json` tiers, env var, flag), `canary flair` command.
3. **Codegen** — `generate-brand.mjs`, per-skill `brand.mjs` stamping,
   `BRANDING.md`, `--check` mode + CI wiring.
4. **Core surface rendering** — banner, guardian output, reporter through
   `ts/src/ui/brand.ts`; determinism + level-0 client-safety snapshots.
5. **Skill adoption** — blackhawk, katana, savant, canary-cry consume their
   stamped kits.
6. **Docs + ADRs** — AGENTS.md convention, two ADRs, skill-authoring checklist.

## Deferred process steps

- `harness-soundness-review --mode spec` (run before implementation planning)
- `advise_skills` scan → `SKILLS.md`
- Roadmap promotion (`manage_roadmap promote`)
- Human sign-off on Sections 5–6
