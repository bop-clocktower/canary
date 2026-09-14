---
number: 0019
title: TypeScript 7 migrates by workspace; /agents/skills gets a typecheck first
date: 2026-09-13
status: accepted
tier: large
source: 'adr'
---

<!-- markdownlint-disable-file MD025 -->

# ADR 0019 — TypeScript 7 migrates workspace by workspace

**Status:** accepted **Date:** 2026-09-13 **Deciders:** Bri Stevenski
(maintainer) **Related:** #792 (source issue); #775, #777, #778 (the three
dependabot PRs); ADR 0014 (checks that report over nothing)

## Context

Three dependabot group PRs — #775 (`/ts`), #778 (`/npm`), #777
(`/agents/skills`) — each carried `typescript ^5.6.0 → ^7.0.2` and
`@types/node ^22 → ^26` inside a routine weekly bump. TypeScript 7 is the
Go-native compiler rewrite, not a point release.

Two of the three failed loudly, every error the same class: `@types/node` stops
resolving entirely under the new compiler with this repo's `module: NodeNext` /
`node16` configuration.

```text
error TS2591: Cannot find name 'node:fs'.
error TS2503: Cannot find namespace 'NodeJS'.
error TS2304: Cannot find name 'URL' / 'fetch' / 'AbortController'.
```

**The third reported all-green.** #777 carried the identical bump and passed for
one reason: nothing typechecks the `/agents/skills` tree the way `/ts` and
`/npm` are typechecked. Same change, same breakage, invisible — the denominator
differed, not the risk. Merging it on its green would have put TypeScript 7 into
one workspace silently.

There are therefore two distinct problems inside one issue, and they have
different lifetimes. The compiler major is a migration with a beginning and an
end. The untypechecked workspace is a permanent hole in the gate that will
produce a false green on _every_ future major, of which TS7 is merely the first
to have been caught.

`typescript` and `@types/node` major updates are currently held out of
dependabot's groups so the migration cannot ride in on a weekly dependency PR.
Minor and patch updates to both still flow normally.

## Decision

**1. `/agents/skills` is brought under typechecking, and the gap is not accepted
in writing.** This is the load-bearing half of the decision and it is settled
first, independently of TS7's timing. The alternative — recording that the tree
is knowingly uncovered — was considered and rejected: a documented hole is still
a hole, and #777's false green recurs on every future compiler major, each time
looking exactly like a pass. The finding outlives the upgrade that surfaced it,
so the fix must too.

**2. The migration proceeds workspace by workspace, `/ts` first, then `/npm`,
then `/agents/skills`.** `/ts` is the tree with the most coverage, so it
produces the clearest signal about what TS7 actually changes. A simultaneous
three-workspace move would mix three sets of failures and make the
`module`/`moduleResolution` question harder to answer, not easier.
`/agents/skills` goes last because it must first _have_ a typecheck for the
migration to mean anything there — decision 1 is a precondition for its turn,
not a parallel task.

**3. The `node:` specifier failures are explained before the pin is raised.**
The TS2591/TS2503/TS2304 class is the symptom to diagnose first: read the TS7
release notes for `module`/`moduleResolution` and lib-resolution changes, and
confirm `@types/node` 26's minimum supported compiler and whether the two must
move together. Raising a pin until the typecheck goes quiet, without
understanding why it was loud, is explicitly not a resolution.

**4. The dependabot `ignore` entries are removed when the migration completes.**
The hold is a deliberate, temporary measure to keep a compiler major off a
weekly bump PR. Left in place by inattention it becomes a permanent silent
divergence from upstream — the same class of quiet the hold was meant to
prevent.

**5. Neither #777 nor any successor is merged on its green while the tree is
unchecked.** A green from a job that checks nothing is an abstention, not a
pass.

## Consequences

- `/agents/skills` gains a typecheck it has never had. Expect an initial backlog
  of genuine errors that were always present and never reported; that backlog is
  the measure of what the gap was costing, and it is paid down before the
  workspace takes the TS7 bump.
- The migration is three sequenced changes rather than one. It takes longer in
  wall-clock terms and each step is individually reviewable and revertible.
- Until the migration completes, `typescript` and `@types/node` majors stay out
  of the dependabot groups. Minor and patch updates continue to flow, so the
  hold does not freeze the dependency.
- Build output may change under the Go-native compiler. That is an open question
  this ADR does not settle — it is answered by the `/ts` step, which is
  positioned first precisely to answer it cheaply.
- A future compiler major arrives with all three workspaces typechecked, so it
  fails loudly in three places instead of failing loudly in two and silently in
  one.
- If `@types/node` 26 turns out to require a compiler this repo cannot yet
  adopt, the sequencing still holds: the `/ts` step reports that, and the
  migration parks with the coverage gap already closed — the durable half of the
  work is not contingent on the upgrade succeeding.
