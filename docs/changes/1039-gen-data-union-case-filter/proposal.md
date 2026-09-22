# gen-data: filter union cases that another member accepts

Issue: #1039. Follow-up to #1014 / PR #1035, spec D7 of #765.

## Overview

`canary gen-data` builds the leaf cases for a resolved union from its first
member only (`ts/src/core/gen-data/strategies.ts:132`,
`union: (n) => rawCases(n.members[0])`). A case that member 0 would reject — an
`unexpected-shape` value such as `0` for a string member, or a `boundary` value
one past a numeric bound — can be a perfectly valid value for another member of
the same union. The emitted fixture then asserts a rejection the schema would
actually accept, so the generated test is wrong, not merely imprecise.

Goal: no emitted case that is invalid for member 0 is valid for any other member
of its union.

Out of scope: per-member case sets, non-scalar union members (already
`unresolved` via `isResolvedUnion`, `ts/src/core/gen-data/shape.ts:62`), and the
default-value strategy (member 0's default is valid for the union by
construction).

## Decisions made

1. **Filter, not per-member, not refuse** — decided by the human at the fleet
   CONFIRM step for #1039. Keep member 0's case list and drop the invalid cases
   another member accepts. Rationale: it is the smallest change that makes every
   emitted case sound; per-member sets would multiply fixture size and change
   the emit contract, and refusing unions would remove coverage that is already
   correct today.
2. **"Invalid" means "not accepted by member 0"** — the filter is applied only
   to cases member 0 itself rejects. A case member 0 accepts (e.g. `''` for an
   unbounded string) is a legitimate valid-input case and is never dropped,
   whatever the other members do with it. This keeps the filter from silently
   eroding boundary coverage.
3. **Acceptance is a local scalar predicate** — a new `accepts(node, value)`
   covering the four scalar kinds (`string`, `number`, `boolean`, `date`),
   mirroring the constraints the generators already honour (enum, min/maxLength,
   integer, min/max, date-only). No JSON-Schema validator dependency: the shape
   model is canary's own and already narrower than JSON Schema.
4. **Live in `strategies.ts`** — the predicate is only meaningful against the
   same constraint set the case generators use; splitting it into a new module
   would add an entropy entry point for ~30 lines.

## Technical design

```ts
// strategies.ts
function accepts(node: ShapeNode, value: unknown): boolean; // scalar kinds only
const CASES = {
  ...,
  union: (n) => unionCases(n.members),
};
function unionCases(members: ShapeNode[]): Raw[] {
  const [first, ...rest] = members;
  return rawCases(first).filter(
    ([, v]) => accepts(first, v) || !rest.some((m) => accepts(m, v)),
  );
}
```

`accepts` returns `false` for any non-scalar node, so a union that slipped past
`isResolvedUnion` degrades to "keeps the member-0 case" rather than throwing.

## Integration points

- **Entry points** — none new. `leafCases` / `defaultValue` keep their
  signatures; `accepts` is module-private.
- **Registrations required** — none. No new module, so no `entropy.entryPoints`
  change.
- **Documentation updates** — none: the union behaviour is not documented as a
  contract anywhere outside the issue.
- **Architectural decisions** — none; small change, no ADR.
- **Knowledge impact** — none.

## Success criteria

1. For a two-member union `[string, number]`, the `unexpected-shape` case
   `value: 0` (emitted from the string member) is not present, because the
   number member accepts it.
2. No emitted case of a union is both rejected by member 0 and accepted by any
   other member — asserted generically over the member list, not just the one
   reproducing shape.
3. Cases member 0 accepts are preserved (no coverage regression for
   single-scalar-kind unions).
4. Non-union behaviour is byte-identical: existing gen-data tests pass
   unchanged.

## Implementation order

1. Write the failing test (two-member union where member 1 accepts member 0's
   unexpected shape) in `ts/test/gen-data-generate.test.ts`.
2. Add `accepts` + `unionCases`, wire into `CASES.union`.
3. Run the four gates from `ts/`.
