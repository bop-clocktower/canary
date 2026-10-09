# Cassandra: triage the findings #1175 unmasked, and recognise typed helper declarations

**Issue:** #1179 · **Route:** feature (roadmap-fleet, autonomous lane) ·
**Keywords:** cassandra, vacuity-scanner, VAC-002, VAC-003, import-inference,
local-declarations, typed-declarations, dogfood

## Overview

PR #1175 ended a `function` helper's body at its own closing brace. Before that,
the body ran on to the next sibling declaration, and that over-attribution had
been hiding VAC-002/VAC-003 findings on canary's own suites. Dogfood is advisory
with no threshold, so nothing forced anyone to triage them. Separately, the
scanner's local-declaration pattern (`JS_LOCAL_DECL`,
`ts/src/core/vacuity-scanner.ts`) cannot see a declaration that carries a type
annotation. So `const parse: Parser = (...a) => parseArgv(a)` is invisible as a
same-file helper.

Goals:

1. Re-measure the exposed set and triage every finding in it: fix the test if it
   is vacuous, otherwise record why it is a false positive.
2. Teach `JS_LOCAL_DECL` the typed form, test first. Then measure how much of
   the VAC-002 abstention population the fix resolves.

Out of scope: a suppression mechanism (cassandra has none, and the settled
default forbids inventing one); fixing the false-positive shapes beyond the
typed form (filed as #1231); the `@covers` annotation bug found during triage
(filed as #1232).

## Decisions made

Questions were answered by the fleet's settled human defaults. No live human was
available.

| Question                            | Answer                                                                                                                                                                                                                | Source                  |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| How do we handle a vacuous finding? | Fix the test so it exercises its target                                                                                                                                                                               | settled default         |
| How do we handle a false positive?  | Record the reason in the PR. Suppress only if cassandra already supports a suppression (it does not). File ONE rule-gap issue for the shapes part 2 does not fix                                                      | settled default         |
| What is the "newly exposed" set?    | Findings present under today's engine but absent when only the function-body boundary is reverted (`return sibling;`), run on today's tree. #1179's 16 was measured at #1175's merge, and tests have been added since | method decision (below) |

Approaches considered for part 2:

|      | A) Optional annotation in `JS_LOCAL_DECL`                                                       | B) Strip type annotations before matching                                                                      | C) AST parse (TypeScript compiler)                                                                                         |
| ---- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| How  | Add `(?:\s*:(?:[^=;\n]\|=>)+?)?` before the `=`, and refuse `=>`/`==` as the binding `=`        | Pre-blank `: Type` spans so the existing regex sees `const parse = ...`                                        | Replace the regex declaration finder with a real parser                                                                    |
| Pros | One-line change; the offsets `declEnd` relies on are unchanged; also covers typed destructuring | Reuses the existing pattern unchanged                                                                          | Exact                                                                                                                      |
| Cons | Misses multi-line annotations and object types with `;` members                                 | Blanking types must be offset-preserving and must tell them apart from object literals or ternaries; high risk | New dependency in a deliberately regex-only, deterministic engine; large blast radius; violates the module's stated design |
| Risk | Low                                                                                             | Medium                                                                                                         | High                                                                                                                       |

**Chosen: A.** It is the smallest change that matches the issue's repro, and it
errs in the safe direction: a missed declaration leaves a finding standing; it
never silences one.

## Technical design

- `JS_LOCAL_DECL` gains an optional, single-line type annotation between the
  binding (identifier, object pattern or array pattern) and the `=`. The binding
  `=` must not be followed by `>` or `=`, so a function type's `=>` is never
  taken for the initializer.
- `m[0]` still ends at the binding `=`. So `declEnd` and `continuesPastNewline`
  (#871/#1170) bound the typed initializer exactly as they bound the untyped
  one.
- `JS_UNINITIALIZED_DECL` (`let parse: Parser;`) is untouched. The new pattern
  cannot match it, because the annotation cannot cross a `;` or a newline.

## Integration points

- **Entry points:** none new. `scanVacuity` is shared by `canary vacuity-check`,
  the promotion gate and the `canary-cassandra` skill CLI.
- **Registrations required:** none.
- **Documentation updates:** CHANGELOG entry. No change to SKILL.md: rule
  semantics are unchanged; only recall improved.
- **Architectural decisions:** none.
- **Knowledge impact:** the false-positive taxonomy is recorded in #1231.

## Success criteria

1. When a test reaches the target only through `const x: T = ...` (named,
   inline-function, or generic type; typed `let`; exported), VAC-002 shall not
   be reported and the test shall not abstain.
2. If a typed helper does not reference the target, then VAC-002 shall still be
   reported.
3. When a typed helper reaches the target only through another helper, VAC-002
   shall abstain, counted.
4. A typed one-line bystander inside a test body shall still end at its own line
   (#871 guard), so VAC-003 still fires.
5. Every finding in the re-measured exposed set has a disposition in the PR:
   resolved by part 2, test fixed, or false positive with a reason and a shape
   in #1231.
6. The PR reports before/after VAC counts for both trees, and the abstention
   resolution measured over the full population.

## Implementation order

1. RED: typed-helper fixtures in `ts/test/vacuity-scanner.test.ts`.
2. GREEN: the `JS_LOCAL_DECL` change.
3. Re-measure: before (origin/main), after, and the exposed set (boundary
   reverted).
4. Triage: fix the vacuous tests, record the false positives, file #1231 (rule
   gap) and #1232 (`@covers` bug).
5. Gates, scanners, provenance, PR.
