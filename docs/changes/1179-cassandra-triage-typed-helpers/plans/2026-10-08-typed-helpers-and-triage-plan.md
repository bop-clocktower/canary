# Plan: Cassandra typed helper declarations and #1175 triage (#1179)

**Spec:** `docs/changes/1179-cassandra-triage-typed-helpers/proposal.md` ·
**Complexity:** low · **Integration tier:** small

## Tasks

### Task 1: RED — typed-helper fixtures

**Files:** `ts/test/vacuity-scanner.test.ts`

Add `it.each` cases for a named function type, an inline function type (whose
`=>` comes before the `=`), a generic type, a typed `let` function expression,
and an exported typed const. Add three more tests: a negative (a typed helper
that never reaches the target still reports), a two-deep abstention, and a
typed-bystander guard (issue 871). Run the tests and confirm the typed cases
fail (6 failed).

### Task 2: GREEN — `JS_LOCAL_DECL` accepts a type annotation

**Files:** `ts/src/core/vacuity-scanner.ts`

Add an optional single-line annotation before the binding `=`; refuse `=>`/`==`
as that `=`. Document the _why_ and the known misses (multi-line annotations,
object types with `;` members). Run the tests and confirm all pass.

### Task 3: Re-measure

Build `ts/`. Run the cassandra CLI `--json` on `ts/test` and
`agents/skills/test` with (a) origin/main's engine, (b) this branch's engine,
and (c) this branch's engine with the #1175 function-body boundary reverted
(`return sibling;`). The exposed set is (b) minus (c).

### Task 4: Triage

For each exposed finding, choose one disposition: resolved by Task 2, test fixed
(it was vacuous, or an absence-only assertion had no in-test precondition), or
false positive (reason recorded, shape filed in #1231). The `@covers` remedy
turned out to be dead after a file's first test, so that was filed as #1232
instead of being used.

### Task 5: Gates and ship

Run `ts/` build, typecheck, format:check and test. Run `agents/skills/`
typecheck, format:check and test. Run savant and blackhawk `--strict` on the
changed tests. Check the entropy, perf, arch and dead-export ratchets. Commit
the CHANGELOG and provenance. Push, open the PR, and watch CI.
