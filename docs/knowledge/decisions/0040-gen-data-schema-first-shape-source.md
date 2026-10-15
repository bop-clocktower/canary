---
number: 0040
title: gen-data shapes come from a schema first; the compiler API is opt-in
date: 2026-10-15
status: proposed
tier: medium
source: docs/changes/765-synthetic-test-data/proposal.md
---

<!-- markdownlint-disable-file MD025 -->

# ADR 0040 — gen-data shapes come from an explicit schema first

**Status:** proposed **Date:** 2026-10-15 **Deciders:** Bri Stevenski
(maintainer) **Related:** #765 (source issue, closed); PR #986 (the D2 spike,
`spike/765-shape-extraction/SPIKE_REPORT.md`);
`docs/changes/765-synthetic-test-data/proposal.md` (D2, "D2 revisited after the
spike (2026-09-15)"); ADR 0009 (exit 3 reserved for "abstained"); ADR 0019
(TypeScript 7 migrates by workspace)

## Context

`canary gen-data` (#765) turns a shape description into a seeded, literal-only
fixture module. It needs a **shape source**: something that says which fields a
target takes and what type each one is. Anything the source cannot resolve
becomes an `unresolved` node and is never filled with a guessed shape.

The proposal's original D2 chose the TypeScript compiler API as the TypeScript
shape source, with `typescript` as an **optional peer dependency** and the
command abstaining when it is absent. The reasoning was that consumer TypeScript
projects already have `typescript`, regex over type text cannot resolve imports,
and a hard runtime dependency bloats every install. That mechanic assumes two
cases: the consumer has `typescript`, or does not.

The D2 spike (PR #986) measured cost and version coupling, and found a third
case:

- **Cost is affordable.** One file plus its imports costs 306 ms and 183 MB cold
  (TS 5.9.3, 5 runs); about 145 ms of that is `import('typescript')` alone. That
  meets the 5 s budget with 16x headroom, though it is 4.0x-7.2x a whole current
  CLI invocation.
- **5.x and 6.x are interchangeable.** Across 5.4.5, 5.9.3 and 6.0.3, all 43
  probed entry points exist and the extracted shapes are byte-identical.
- **`typescript@7` has no compiler API at its main export.** On 7.0.2,
  `import('typescript')` yields only `{ version, versionMajorMinor }` and
  `ts.createProgram` is not a function. The API moved to
  `typescript/unstable/sync` with a different shape.
- **A non-optional peer of `>=5.0.0` installs exactly that version.** In the
  spike's control experiment, npm satisfied the peer with 7.0.2. An optional
  peer (`peerDependenciesMeta.typescript.optional: true`) is not installed by
  npm, and the import then fails cleanly with `ERR_MODULE_NOT_FOUND`.
- **The cheaper paths do not work.** A parse-only `createSourceFile` pass costs
  153 ms but resolves no imported interface, so 3 of 4 real targets abstain.
  `noResolve` silently rewrites unresolvable imports to `any`, which cannot be
  told apart from an `any` the author wrote.

So the broken premise is availability, not cost. A consumer can have
`typescript` installed and still have no compiler API.
`npm install typescript@latest` now produces that state. The original "optional
peer, abstain if absent" mechanic does not cover it: the import succeeds, and
the failure would come later as an untyped call on a missing function.

A human accepted the spike's recommendation on 2026-09-15, and the proposal
records it as the amended D2. This ADR records that decision. It does not
re-decide it.

What the code does today, on base `be26f0a9`:

- `ts/src/gen-data/gen-data-cli.ts` takes `--schema <path>` (a JSON Schema file
  whose root type is `object`) as its only shape input.
  `ts/src/core/gen-data/json-schema.ts` maps JSON Schema to `ShapeNode` and
  describes itself as "the primary shape source in v1 ('D2 revisited')".
- No module in `ts/src` imports the compiler API or reads `versionMajorMinor`.
  The compiler-API second source has not been built yet.
- `ts/package.json` declares `typescript` `^5.6.0` as a devDependency only.
  There is no `peerDependencies` or `peerDependenciesMeta` entry. `zod` `^4.6.5`
  is a runtime dependency, but `gen-data` does not yet accept a zod schema
  module.

## Decision

1. **The explicit schema is the primary v1 shape source.** That means JSON
   Schema, which is shipped, and a zod schema module, which the proposal names
   and which is not built yet. It costs about 0 ms, has no version coupling, and
   adds no dependency, since `zod` is already a runtime dependency.
2. **The TypeScript compiler API is an opt-in second source.** When it is built:
   - It is loaded only through a guarded dynamic `import('typescript')`, never a
     static import, so a consumer without `typescript` never loads it.
   - It is version-gated on `ts.versionMajorMinor`. Only the 5.x-6.x classic API
     is accepted.
   - It **abstains with a named reason** in both failure cases. When
     `typescript` is absent, the import fails with `ERR_MODULE_NOT_FOUND`. When
     `typescript` is 7.x, the package is present but has no classic API. Each
     reason names its case, so "not installed" and "installed without the
     compiler API" stay distinguishable. When no field resolves, the exit is 3
     (ADR 0009).
   - If `typescript` is declared at all, it is an **optional** peer
     (`peerDependenciesMeta.typescript.optional: true`) with a version range
     that **excludes 7.x**. Changing the kind of dependency alone is not enough.
3. **Not built on this evidence:**
   - a parse-only extractor as the primary path;
   - anything that uses `noResolve`;
   - an extractor against `typescript/unstable/*`;
   - `typescript` as a hard runtime dependency or a non-optional peer.

The shape model, the seeded generator, the emitters, the abstention doctrine and
the exit-code contract are unchanged by this decision.

## Consequences

- Every user can produce fixtures without any `typescript` install. The schema
  path does not depend on which compiler major a consumer has.
- Users who have no schema get nothing from the primary path until they write
  one, or until the opt-in compiler-API source ships. That is the cost the
  original D2 avoided, and it is accepted because the alternative fails silently
  on `typescript@latest`.
- The version gate is a single point that has to be revisited. A later port to
  `typescript/unstable/sync`, or a stable TS 7 API, needs a new decision. Until
  then, 7.x users get a named abstention, not a guessed shape.
- The "Registrations required" line in the proposal now reads as a version range
  that excludes 7.x, not only a change of dependency kind.
- This sits beside ADR 0019 without conflict. ADR 0019 governs canary's own
  compiler (still `^5.6.0` in `ts/package.json`). This ADR governs the
  `typescript` that canary may load from a consumer's tree at run time. When
  canary's own workspace moves to TS 7, the consumer-side gate does not move
  with it.
- Still unmeasured, if the compiler-API source is built: install and bundle-size
  impact, a port to `typescript/unstable/sync`, the Python `ast` path (A2), cost
  on a consumer repo rather than canary's own `ts/src`, and warm cost in a
  long-lived process such as an MCP server holding a Program.

### Assumptions made

- The ADR is written from the amended D2 in the proposal and the spike report.
  The architecture advisor's discovery and choice gates were treated as already
  answered by the 2026-09-15 human acceptance. No separate
  `docs/architecture/<topic>/` discovery, analysis or proposal files were
  written.
- "Explicit schema" covers both JSON Schema and a zod schema module, as the
  proposal's "Shape sources (v1)" table says. Only JSON Schema is shipped. The
  zod input is recorded as decided and unbuilt, not as a contradiction.
- The exact abstention reason strings and the exact semver range that excludes
  7.x are left to the implementing PR. This ADR fixes only that the two failure
  cases are named separately and that 7.x is excluded.
- The frontmatter `title` is shortened to fit one line. Prettier folds a longer
  YAML title onto two lines, and the knowledge ingestor then skips the file
  without a warning (observed: `decisions` stayed at 36 until the title fit).
- The compiler-API source is recorded as decided but not yet built. Nothing in
  the shipped code contradicts the amended decision, so this record is not
  parked.

## Alternatives Considered

- **Original D2: compiler API as the primary source, optional peer, abstain if
  absent.** Rejected by the spike. It does not anticipate a consumer who has
  `typescript@7`, where the import succeeds but the API is missing, and
  `typescript@latest` produces exactly that case.
- **`typescript` as a hard or non-optional peer dependency.** Rejected. A
  non-optional peer of `>=5.0.0` was shown to install 7.0.2, which has no
  classic API. This also brings back the install bloat the original D2 avoided.
- **Parse-only extractor (`createSourceFile`, no checker) as the primary path.**
  Rejected. It is cheaper (153 ms), but it resolves no imported interface, so
  75% of the real targets abstain. A capability that abstains that often exists
  in name only.
- **`noResolve` to cut resolution cost.** Rejected. It saves no measurable time
  (310.9 ms against 306.3 ms), and it silently turns unresolvable imports into
  `any`. That is a guessed shape the abstention doctrine forbids.
- **Target `typescript/unstable/sync` now.** Not built. The API is explicitly
  unstable and has a different shape, and porting to it is listed as unmeasured.
- **Schema-only, with no compiler-API source ever.** Not chosen. The compiler
  API resolves real imported types, with 0 of 4 targets abstaining under a full
  program, and 5.x-6.x consumers can use it safely behind the gate. It stays
  available as an opt-in second source.
