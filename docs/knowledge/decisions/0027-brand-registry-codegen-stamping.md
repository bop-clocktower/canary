---
number: 0027
title: Brand registry with codegen stamping and a drift gate
date: 2026-09-15
status: proposed
tier: medium
source: docs/changes/bop-subbranding/proposal.md
---

<!-- markdownlint-disable-file MD025 -->

# ADR 0027 — Brand registry with codegen stamping and a drift gate

**Status:** proposed **Date:** 2026-09-15 **Related:**
docs/changes/bop-subbranding/proposal.md (D5, D8); ADR 0028 (flair cascade)

## Context

The BoP sub-branding proposal (docs/changes/bop-subbranding/proposal.md) gives
every character-named component a kit: voice, tagline, epigraphs, accent colour,
rule prefix and severity labels. Two goals pull against each other. The kits
need one source of truth (Goal 1) that cannot drift (Goal 2). Skills must also
stay self-contained, with no runtime dependency on the core package (Goal 3).
Tombstoned names (oracle, gypsy) must be enforced, not remembered (D8).

The proposal flags D5 for an ADR because it sets the pattern for any future
"shared data inside self-contained skills" problem.

Options considered:

- A) One schema-validated registry (`brand/registry.json`).
  `scripts/generate-brand.mjs` stamps each skill's `scripts/brand.mjs` and the
  `BRANDING.md` brand book from it, and `generate-brand --check` fails CI on any
  diff.
- B) Skills import a shared runtime brand module from the core package. This
  gives one source of truth but breaks self-containment.
- C) Each skill carries a hand-maintained copy. This keeps skills self-contained
  but gives no single source of truth, and drift is guaranteed.

## Decision

Adopt option A. `brand/registry.json` is the only hand-edited source for
character kits and tombstones, and it is schema-validated.
`scripts/generate-brand.mjs` generates each character skill's
`scripts/brand.mjs` and the repo-level `BRANDING.md`. Every generated file
carries a "Generated — do not edit" header.

`generate-brand --check` regenerates into a temp directory and fails on any
diff. It runs in CI, so a hand edit to a generated file, or a registry change
without regeneration, goes red. The generator hard-fails when a kit uses a
tombstoned name.

The generated `brand.mjs` may embed small shared logic (for example the flair
resolver, whose rungs ADR 0028 fixes). That duplication is owned by the
generator, never by hand. A new character skill's registry entry is part of its
definition of done.

## Consequences

- One place to change a kit. Every skill picks the change up by regenerating,
  with no runtime coupling.
- Drift is caught by construction, following the same pattern as the repo's
  other regenerate-and-diff ratchets.
- Generated files add diff noise to PRs that touch the registry. Reviewers
  review the registry, not the stamped copies.
- Embedded logic is duplicated per skill. A bug in the generator template ships
  to every skill at once, and so does its fix.
- This sets precedent: future shared-data-into-skills problems default to
  registry + codegen + `--check` unless an ADR says otherwise.
- New required-ish check: the `--check` step must be wired into CI (the dogfood
  workflow per the proposal). Until it is, the drift guarantee is unenforced,
  and that should be stated rather than assumed.
- Nothing is built by this ADR. `brand/`, `generate-brand.mjs` and
  `ts/src/core/flair.ts` do not exist on main as of 6aa3158d.
