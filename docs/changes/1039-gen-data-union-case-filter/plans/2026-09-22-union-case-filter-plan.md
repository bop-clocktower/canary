# Plan: gen-data — filter union cases another member accepts

**Date:** 2026-09-22 | **Issue:** #1039 | **Spec:**
`docs/changes/1039-gen-data-union-case-filter/proposal.md` | **Tasks:** 5 |
**Time:** ~18 min | **Integration Tier:** small | **Rigor:** standard (skeleton
skipped — 5 tasks, below the 8-task threshold)

## Goal

`canary gen-data` never emits a union case that member 0 rejects but another
member of the same union accepts.

## Observable truths (acceptance criteria)

1. **Event-driven** — When `leafCases` is called on a union
   `[{kind:'string'}, {kind:'number',integer:false}]`, the system shall not
   return any case whose `value` is `0` (the `unexpected-shape` case the string
   member contributes, which the number member accepts).
2. **Ubiquitous** — For every union node, `leafCases` shall return only cases
   whose value is either accepted by member 0, or accepted by no member at all.
   Asserted generically over the member list, not just the reproducing shape.
3. **Ubiquitous** — Every case member 0 accepts shall be preserved: for a union
   whose members are all the same scalar kind with identical constraints,
   `leafCases(union)` equals `leafCases(member0)`.
4. **Ubiquitous** — Non-union behaviour shall be unchanged: all existing
   `ts/test/gen-data-*.test.ts` assertions pass, except the one documented below
   that encodes the old (unsound) union contract.
5. The four gates pass from `ts/`: `npm run build`, `npm run typecheck`,
   `npm run format:check`, `npm test`.

## Uncertainties

- **[ASSUMPTION]** `accepts` for a `date` member is a regex test over the ISO
  form (`YYYY-MM-DD` when `dateOnly`, otherwise a full ISO-8601 timestamp). The
  shape model carries no other date constraint, and `dateCases` only ever emits
  those two forms. If a richer date constraint is added later, `accepts` must
  grow with it. Recorded as the default; no human input taken (autonomous).
- **[ASSUMPTION]** A `union` nested inside a `union` (possible in the type but
  not producible by `isResolvedUnion`) is treated as accepting a value when any
  of its members does. Defensive only.
- **[DEFERRABLE]** Exact wording of the new test titles.
- **RESOLVED (design fork):** option 1 "Filter" — settled by the human at the
  fleet CONFIRM step. No per-member case sets, no `unresolved` union.

## Pre-existing test that must change (found during decomposition)

`ts/test/gen-data-generate.test.ts:97` — _"a union defaults and plans cases from
its first member"_ — asserts
`leafCases(union).values === leafCases(first).values` for
`first = {kind:'number',integer:true,min:1,max:9}`, second `{kind:'string'}`.
Under the filter, member 0's `['unexpected-shape', '0']` case is dropped (the
string member accepts the string `'0'`). That assertion encodes the exact bug
that issue #1039 describes, so it is **amended, not deleted** — Task 3 rewrites
it to state the filter contract, and it is red until Task 4 lands. This is the
only existing test affected; `gen-data-emit-vitest`/`-json-schema`/`-shape`
union assertions are about types, reasons and extraction, not case values.

## File map

- MODIFY `ts/test/gen-data-generate.test.ts` (Tasks 1, 2, 3)
- MODIFY `ts/src/core/gen-data/strategies.ts` (Task 4)
- CREATE
  `docs/changes/1039-gen-data-union-case-filter/plans/2026-09-22-union-case-filter-plan.md`
  (this file)

No new module, so no `entropy.entryPoints` registration (spec, Integration
points). A new test file is explicitly **not** created — it would trip the
entropy ratchet.

## Tasks

### Task 1: Failing reproducing test — a union drops the case its sibling accepts

**Depends on:** none | **Files:** `ts/test/gen-data-generate.test.ts`

1. In the `describe('leafCases', …)` block, immediately after the
   `'unexpected-shape offers wrong primitive type and null'` test (ends line
   62), insert:

   ```ts
   it('a union drops a member-0 case another member accepts (#1039)', () => {
     const first: ShapeNode = { kind: 'string' };
     const union: ShapeNode = {
       kind: 'union',
       members: [first, { kind: 'number', integer: false }],
     };
     const values = leafCases(union, 'ref').map((c) => c.value);
     // The string member contributes `0` as unexpected-shape, but the number
     // member accepts it -- asserting a rejection the schema would allow.
     expect(leafCases(first, 'ref').map((c) => c.value)).toContain(0);
     expect(values).not.toContain(0);
     // null is rejected by both members, so it survives the filter.
     expect(values).toContain(null);
   });
   ```

2. `ts/test/gen-data-generate.test.ts` already imports `ShapeNode` (line 5) and
   `leafCases` (line 6) — no import change.
3. Run: `cd ts && npx prettier --write test/gen-data-generate.test.ts`
4. Run: `cd ts && npx vitest run test/gen-data-generate.test.ts` — observe the
   new test FAIL on `expect(values).not.toContain(0)`.
5. Commit: `test(gen-data): a union must drop cases a sibling member accepts`

### Task 2: Failing invariant + preservation tests (criteria 2 and 3)

**Depends on:** Task 1 | **Files:** `ts/test/gen-data-generate.test.ts`

1. Directly after the Task 1 test, insert the generic invariant test. `accepts`
   is module-private, so the observable proxy is two-directional: every
   surviving value is a member-0 value (the filter only removes), and every
   dropped value is one some sibling kind can hold.

   ```ts
   it.each([
     [[{ kind: 'string' }, { kind: 'number', integer: true }]],
     [[{ kind: 'number', integer: true, min: 1, max: 9 }, { kind: 'string' }]],
     [[{ kind: 'date' }, { kind: 'number', integer: false }]],
     [[{ kind: 'boolean' }, { kind: 'number', integer: false }]],
   ] as unknown as Array<[ShapeNode[]]>)(
     'a union of %j emits only member-0 cases, minus sibling-accepted ones',
     (members) => {
       const first = members[0] as ShapeNode;
       const ownValues = leafCases(first, 'ref').map((c) => c.value);
       const unionValues = leafCases({ kind: 'union', members }, 'ref').map(
         (c) => c.value,
       );
       // Subset: the filter only ever removes.
       for (const v of unionValues) expect(ownValues).toContainEqual(v);
       // Any dropped value must be one a sibling can hold: it appears as a
       // legitimate value of some other member's own kind.
       const dropped = ownValues.filter((v) => !unionValues.includes(v));
       for (const v of dropped)
         expect(
           members
             .slice(1)
             .some((m) =>
               typeof v === (m as { kind: string }).kind
                 ? true
                 : (m as { kind: string }).kind === 'date' &&
                   typeof v === 'string',
             ),
         ).toBe(true);
     },
   );
   ```

2. Immediately after it, insert the preservation test (criterion 3):

   ```ts
   it('keeps every case when all members share the same constraints', () => {
     const member: ShapeNode = {
       kind: 'number',
       integer: true,
       min: 1,
       max: 9,
     };
     const union: ShapeNode = { kind: 'union', members: [member, member] };
     expect(leafCases(union, 'ref').map((c) => c.value)).toEqual(
       leafCases(member, 'ref').map((c) => c.value),
     );
   });
   ```

3. Run: `cd ts && npx prettier --write test/gen-data-generate.test.ts`
4. Run: `cd ts && npx vitest run test/gen-data-generate.test.ts` — the `it.each`
   rows must FAIL today (the union returns member-0 cases verbatim, so the
   string/number row still carries `0`); the preservation test passes both
   before and after, which is intended — it is a regression guard, not a red
   test. The Task 1 test remains red.
5. **As executed (two amendments, both under step 6's own rule):** the rows need
   an explicit `expect(dropped.length).toBeGreaterThan(0)` — without it both
   assertions hold trivially before the fix, so all four rows went green while
   the bug was live (a zero denominator). And the original `[date, string]` row
   can never drop anything (date's own values are ISO literals the date member
   keeps; its unexpected-shape values `null`/`0` are rejected by a string
   sibling), so it is `[date, number]` above.
6. **Denominator check:** if an `it.each` row passes in the red phase, that row
   is not exercising the bug. Replace its member list with one where member 0's
   `unexpected-shape` value is a valid value of a sibling. A vacuous green in
   the red phase is an abstention, not a pass.
7. Commit: `test(gen-data): assert the union case-filter invariant generically`

### Task 3: Amend the test that encodes the old union contract

**Depends on:** Task 2 | **Files:** `ts/test/gen-data-generate.test.ts`

1. Replace the body of the existing test at line ~97
   (`'a union defaults and plans cases from its first member'`) — rename it and
   rewrite the `leafCases` assertion:

   ```ts
   it('a union defaults from member 0 and plans its filtered cases', () => {
     const first: ShapeNode = { kind: 'number', integer: true, min: 1, max: 9 };
     const union: ShapeNode = {
       kind: 'union',
       members: [first, { kind: 'string' }],
     };
     const v = defaultValue(union, 'ref', mulberry32(765));
     expect(Number.isInteger(v)).toBe(true);
     // Member 0's `'0'` unexpected-shape case is a valid string, so the string
     // member accepts it and it is filtered out (#1039). Everything else --
     // out-of-range numbers and null -- is rejected by both members and stays.
     expect(leafCases(union, 'ref').map((c) => c.value)).toEqual(
       leafCases(first, 'ref')
         .map((c) => c.value)
         .filter((x) => x !== '0'),
     );
   });
   ```

2. Run: `cd ts && npx prettier --write test/gen-data-generate.test.ts`
3. Run: `cd ts && npx vitest run test/gen-data-generate.test.ts` — observe this
   test now FAILS as well (three red tests total). Do not implement yet.
4. Commit:
   `test(gen-data): state the filtered union contract in the member-0 test`

### Task 4: Implement `accepts` + `unionCases` and wire `CASES.union`

**Depends on:** Task 3 | **Files:** `ts/src/core/gen-data/strategies.ts`

1. In `ts/src/core/gen-data/strategies.ts`, after `dateCases` (ends line 122)
   and before the `CASES` table, insert:

   ```ts
   const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
   const ISO_DATE_TIME =
     /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

   /**
    * Would this scalar node accept `value`? Mirrors the constraints the case
    * generators above honour -- the shape model is canary's own and narrower
    * than JSON Schema, so no validator dependency is warranted (#1039).
    */
   const ACCEPTS: {
     [K in Leaf['kind']]: (n: Of<K>, v: unknown) => boolean;
   } = {
     string: (n, v) =>
       typeof v === 'string' &&
       (n.enum === undefined || n.enum.includes(v)) &&
       v.length >= (n.minLength ?? 0) &&
       v.length <= (n.maxLength ?? Infinity),
     number: (n, v) =>
       typeof v === 'number' &&
       Number.isFinite(v) &&
       (!n.integer || Number.isInteger(v)) &&
       v >= (n.min ?? -Infinity) &&
       v <= (n.max ?? Infinity),
     boolean: (_n, v) => typeof v === 'boolean',
     date: (n, v) =>
       typeof v === 'string' &&
       (n.dateOnly ? ISO_DATE_ONLY : ISO_DATE_TIME).test(v),
     union: (n, v) => n.members.some((m) => accepts(m, v)),
   };

   /** Non-scalar and missing nodes accept nothing, so the filter keeps the case. */
   function accepts(node: ShapeNode | undefined, value: unknown): boolean {
     if (node === undefined || !(node.kind in ACCEPTS)) return false;
     const fn = ACCEPTS[node.kind as Leaf['kind']] as (
       n: Leaf,
       v: unknown,
     ) => boolean;
     return fn(node as Leaf, value);
   }

   /**
    * Member 0's cases, minus any case member 0 rejects that a sibling accepts --
    * such a case would assert a rejection the union would actually allow (#1039).
    */
   function unionCases(n: Of<'union'>): Raw[] {
     const [first, ...rest] = n.members;
     return rawCases(first).filter(
       ([, v]) => accepts(first, v) || !rest.some((m) => accepts(m, v)),
     );
   }
   ```

2. Change line 132 of the `CASES` table from
   `union: (n) => rawCases(n.members[0]),` to `union: unionCases,`.
3. Run: `cd ts && npx prettier --write src/core/gen-data/strategies.ts`
4. Run: `cd ts && npx vitest run test/gen-data-generate.test.ts` — observe all
   three previously-red tests PASS.
5. Run the four gates from `ts/`:
   `npm run build && npm run typecheck && npm run format:check && npm test`.
   Read the test **counts**, not just the exit code — a suite that ran 0 files
   is an abstention.
6. Run: `harness validate` and `harness check-deps` from the repo root.
7. Commit:
   `fix(gen-data): drop union cases member 0 rejects but a sibling accepts (#1039)`

### Task 5: Ratchet and self-review pass

**Depends on:** Task 4 | **Files:** none (verification) | **Category:**
integration

1. `strategies.ts` grows by ~45 lines and one new local helper; the perf/entropy
   ratchets are the known trap for exactly this shape of change. Run from the
   repo root: `npx canary entropy --check` (or the repo's configured entropy
   command) and the perf-complexity check, and compare against the committed
   baselines. **Never raise `maxFindings`**; if a ratchet moves, report it
   rather than paying it down silently.
2. No new module and no new CLI surface, so no `entropy.entryPoints` edit and no
   architecture-allowance bump is expected. If one IS required, that is a
   finding to surface, not a quiet edit.
3. Read the full diff as a reviewer (`git diff main...HEAD`) before declaring
   done: green gates are verification, not review.
4. Doc-drift + testing-gap check: the union behaviour is not documented outside
   the issue (spec, Integration points), so no doc update is expected —
   re-confirm with `grep -rn "first member" docs/ ts/src` and report any hit.
5. Commit only if step 1–4 produced changes; otherwise this task produces no
   commit.

## Traceability

| Observable truth                       | Delivered by                                         |
| -------------------------------------- | ---------------------------------------------------- |
| 1 — `0` dropped for `[string, number]` | Task 1 (test), Task 4 (impl)                         |
| 2 — generic invariant                  | Task 2 (test), Task 4 (impl)                         |
| 3 — no coverage regression             | Task 2 (preservation test), Task 4                   |
| 4 — non-union unchanged                | Task 3 (amends the one affected test), Task 4 step 5 |
| 5 — four gates                         | Task 4 step 5, Task 5                                |

## Change specification

- [MODIFIED] `CASES.union` no longer returns member 0's raw case list; it
  returns that list filtered by sibling acceptance.
- [ADDED] module-private `accepts(node, value)` over the four scalar kinds.
- [MODIFIED] `ts/test/gen-data-generate.test.ts:97` asserts the filtered
  contract instead of raw member-0 equality.
- [UNCHANGED] `defaultValue`'s union branch — member 0's default is valid for
  the union by construction (spec, out of scope).
