# canary-harley: invariants proposed from a signature, tests after confirmation

**Issue:** #616 · **Route:** feature · **Slug:** `616-canary-harley`

**Keywords:** property-based-testing, invariant, signature, fast-check,
Hypothesis, arbitrary, seed, confirmation-gate, round-trip, idempotence

## Overview

Property-based testing needs an invariant, and stating the invariant is the hard
part. A generator that wraps framework boilerplate around a weak or wrong
property produces a test that shrinks to a meaningless minimal case and still
looks authoritative (the objection recorded against candidate 11 in
`docs/ideation/bop-themed-canary-skills-2026-07-21.md`).

Harness already ships the authoring craft: `harness-property-test` covers
fast-check and Hypothesis setup, shrinking and the property vocabulary. It does
not derive candidate properties from a signature. That derivation is the only
part this feature builds (issue #616, first comment).

`canary-harley` has two deterministic steps with a human between them.

1. `propose <file>` reads the function signatures in one source file, derives
   candidate invariants from their types and names, ranks them by how likely
   they are to hold, and prints the ranked list. Nothing is generated.
2. A human reads the list and confirms the invariants that are true of the code.
3. `emit <file> --confirm <id>` writes one property test per confirmed
   candidate: fast-check for TypeScript, Hypothesis for Python. Every generated
   file carries a fixed, recorded seed.

The primary output is the proposal. `emit` never writes a test for a candidate
that was not named in `--confirm`.

**Strategy grounding.** `STRATEGY.md#tracks` lists "Test intelligence depth".
`STRATEGY.md#our-approach` calls for a deterministic Tier-0 engine with an
optional agent layer on top; both commands are deterministic and call no LLM,
and the skill prose is the agent layer.

## Goals

- G1. A source file alone is enough input. The function list comes from the same
  extractor `analyze_file` uses, so harley and `analyze_file` name the same
  functions.
- G2. Every candidate is ranked, carries the evidence it was derived from, and
  says when it legitimately does not hold.
- G3. Generation is impossible without a confirmation that names the candidate,
  and a confirmation stops matching when the signature changes.
- G4. Every generated test is seeded, and the seed is recorded in the file.
- G5. A type harley cannot map to a generator is named. It is never guessed.

## Non-goals

- Restating property-testing craft. The skill points to `harness-property-test`
  for conventions, shrinking and arbitrary design.
- Model-based (stateful) generation. The offline-sync example below is a named
  target for a later slice.
- Deciding that an invariant holds. Harley proposes; a human confirms.
- Running the generated test, or installing fast-check or Hypothesis.
- Simple CRUD and UI rendering code. Functions shaped like those are skipped and
  named.
- Resolving imported or aliased types, JSDoc types, async functions, methods,
  generics and overloads. Each is named as a skip or an unresolved type.
- Promotion into the committed suite. That stays with `canary-promote-test`.
- An LLM call inside the CLI, and a new top-level `canary` subcommand.

## Boundary

Property testing pays for itself on large input spaces: parsers, serializers,
encoders and validators. It does not suit simple CRUD or UI rendering. Harley
states this in its output and skips CRUD- and UI-shaped functions by name.

It is distinct from its neighbours:

| Skill                        | Works on                    | Output                                   |
| ---------------------------- | --------------------------- | ---------------------------------------- |
| `canary-cry`                 | User flows on a live target | Replayable state-corruption findings     |
| `canary-edge-case-discovery` | A feature or function       | Named example cases, reasoned by a model |
| `canary-harley`              | One function signature      | A proposed invariant, then a seeded test |

### Named example for a later slice: offline sync

Issue #616 names a model-based target. It is recorded here so the follow-up has
a concrete invariant to start from; nothing in this slice builds it.

> For any interleaving of offline edits by N clients to the same record,
> followed by reconnect in any order, the merged result either (a) equals a
> declared merge policy's output or (b) surfaces an explicit conflict. It never
> silently produces a record mixing fields from different logical entities.

That needs fast-check commands plus a model, and a merge policy no signature
states. It is out of reach of signature-derived candidates.

## Decisions made

| #   | Decision                                                                                                                                                                                                                                                                  | Rationale                                                                                                                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | A self-contained skill runtime under `agents/skills/claude-code/canary-harley/scripts/`, run with `canary skills run canary-harley -- <subcommand>`. No new top-level `canary` subcommand.                                                                                | `READINESS_COMMANDS` already holds 12 imports, the cap in `ts/test/cli-command-registry.test.ts`. The script-skill shape is the one `canary-question` and `canary-savant` use.                                                                                                   |
| D2  | The function list comes from `extractFileFunctions` in the built engine's `mcp-server.js`, loaded the way `canary-cassandra/scripts/engine.mjs` loads its engine modules. If the engine cannot be located, `propose` and `emit` abstain (exit 3).                         | It is the extractor behind `analyze_file`'s `file_functions` (`ts/src/mcp-server.ts:413`). Reusing it keeps one definition of "the functions in this file". The extractor returns names only and caps at 20, so harley adds its own reader for parameter types.                  |
| D3  | Harley reads parameter and return types itself, with a small type-expression parser per language. A type it cannot map is an `unresolved` node carrying the type text and a reason.                                                                                       | `analyze_file` has no type information. Guessing a generator for an unknown type would test something the function does not accept. `ts/src/core/gen-data/shape.ts` sets the same rule for `canary gen-data`.                                                                    |
| D4  | Seven candidate kinds, each from a type shape plus optional name cues: `round-trip`, `idempotence`, `involution`, `commutativity`, `length-preserving`, `total-predicate`, `determinism`.                                                                                 | Each is decidable from a signature. Kinds that need a domain rule (ordering, conservation, a merge policy) are left out.                                                                                                                                                         |
| D5  | Each candidate gets a score from 0 to 1 and a tier: `likely` (0.7 and up), `plausible` (0.4 up to 0.7), `speculative` (below 0.4). The score is a fixed prior per kind plus a name-cue boost. The output labels it `heuristic`.                                           | The issue asks for a ranking by how likely the invariant is to hold. Nothing here measures that, so the label says what kind of number it is.                                                                                                                                    |
| D6  | A candidate id is `<kind>:<functions>:<8 hex>`. The hex is a SHA-256 over the kind and the normalized signatures of the functions involved.                                                                                                                               | A confirmation is bound to the signature that was read. Change a parameter type and the id changes, so the old confirmation matches nothing.                                                                                                                                     |
| D7  | `emit` re-derives the candidates from the source file and looks the confirmed ids up in that fresh list. It does not read a proposal file.                                                                                                                                | A proposal file can be edited by hand or go stale. `canary-cry` rebuilds its manifest from the input files for the same reason.                                                                                                                                                  |
| D8  | `emit` without `--confirm` exits 2 and writes nothing. There is no "confirm all". The skill tells the agent to stop after `propose` and never supply `--confirm` itself.                                                                                                  | The maintainer's rule: a test is never emitted around an unconfirmed invariant. The CLI cannot tell who typed the flag, so the human pause lives in the skill, as it does for `canary-cry`.                                                                                      |
| D9  | Every generated file fixes its seed and run count as named constants and records both in the header. The default seed is derived from the candidate id; `--seed` overrides it. Hypothesis output also sets `database=None` and `deadline=None`.                           | An unseeded generator is a flake source (issue #616, first comment). A derived default is stable across runs and differs between tests. The Hypothesis example database and its timing deadline both vary between runs.                                                          |
| D10 | TypeScript sources get a fast-check test under vitest. Python sources get a Hypothesis test under pytest. Plain JavaScript without type annotations is proposed but cannot be emitted.                                                                                    | The generator comes from the declared types. Untyped JavaScript declares none.                                                                                                                                                                                                   |
| D11 | Generated tests are written under `<root>/tests/generated/property/`. `emit` refuses any `--out-dir` outside `<root>/tests/generated/` and refuses to overwrite an existing file without `--force`.                                                                       | Generated tests live in `tests/generated/` and are promoted by `canary-promote-test`. A hand-edited test must not be silently replaced.                                                                                                                                          |
| D12 | Exit codes: 0 proposed or emitted, 2 usage (including a missing `--confirm`), 3 abstained. `propose` abstains when it finds no functions, no candidates, or an unreadable file. `emit` abstains on an id that is not derivable now or a candidate that cannot be emitted. | The family's convention (`agents/skills/lib/parse-args.mjs`, `ts/src/core/gate-result.ts`). A proposal with zero candidates must not read as success.                                                                                                                            |
| D13 | No new dependency. The generated tests are checked for syntax in CI (TypeScript transpile, Python `ast.parse`) and are not executed there.                                                                                                                                | Executing them needs fast-check and Hypothesis installed in the skills project. That is a dependency and lockfile change better made on its own PR.                                                                                                                              |
| D14 | Closing keyword is `Closes #616`.                                                                                                                                                                                                                                         | The issue's remaining delta is four bullets: read the signature, propose ranked invariants, emit arbitraries, hand conventions to harness. The seed requirement is met. The model-based case is a named example for the spec by the maintainer's decision, not a v1 requirement. |

### Approaches considered

- **A (chosen).** A script skill with a deterministic `propose` and `emit`, the
  function list loaded from the engine. The gate is testable without an LLM. It
  costs an engine lookup at start.
- **B.** An engine module under `ts/src/` with a `canary harley` subcommand.
  Users would get a shorter command. `READINESS_COMMANDS` is full, so it needs a
  new command domain, and new engine source grows the arch module-size ratchet,
  which needs an allowance file this lane may not write. Rejected for this
  slice.
- **C.** A prose-only skill where the agent reads the file and proposes
  invariants. It is cheap to build. The ranking would differ run to run, and
  nothing would stop generation before confirmation. Rejected because D5 and D8
  could not be enforced.

### Questions taken without a human

This lane ran with no human available. Each question below was answered with the
recommended option and is recorded in `provenance.json`.

| Question                                                      | Answer taken                                              |
| ------------------------------------------------------------- | --------------------------------------------------------- |
| Engine subcommand or script skill?                            | Script skill (D1)                                         |
| What binds a confirmation to the code?                        | A hash of the signature in the candidate id (D6)          |
| Read a saved proposal on `emit`, or re-derive?                | Re-derive (D7)                                            |
| Default seed: one constant, random-then-recorded, or derived? | Derived from the candidate id (D9)                        |
| Execute generated tests in CI?                                | No, syntax checks only (D13)                              |
| Emit for untyped JavaScript?                                  | No, propose only (D10)                                    |
| Resolve same-file interfaces and aliases in this slice?       | No. Named as unresolved; a follow-up can add the resolver |

## Technical design

### Layout

```text
agents/skills/claude-code/canary-harley/
  SKILL.md
  scripts/
    cli.mjs             argument parsing, subcommand dispatch, exit codes
    engine.mjs          locate the engine, load extractFileFunctions
    types.mjs           type-expression parser (TypeScript and Python)
    signatures.mjs      parameter and return types for the listed functions
    cues.mjs            name-cue tables and the CRUD/UI boundary check
    invariants.mjs      candidate derivation, scoring, ids
    proposal.mjs        proposal assembly and the markdown and JSON renderers
    arbitraries.mjs     type node to fast-check and Hypothesis expressions
    emit-fast-check.mjs TypeScript test text
    emit-hypothesis.mjs Python test text
    emit.mjs            confirmation lookup, seed, output path, write
```

### Type nodes

```text
string | number | integer | boolean | bigint | bytes | null
array(item) | tuple(items) | record(value) | object(fields) | optional(inner)
union(members) | literal(value) | unresolved(typeText, reason)
```

TypeScript `number` maps to `number`. Python `int` maps to `integer` and `float`
to `number`. `Uint8Array`, `Buffer` and Python `bytes` map to `bytes`. A named
type, a generic parameter, `any`, `unknown` and a function type are
`unresolved`.

### Signatures

For each name `extractFileFunctions` returns, `signatures.mjs` finds the
declaration and reads its parameter list and return type with a
bracket-and-string-aware scan. A function is skipped, with the reason named,
when it is async, a method, has a rest or destructured parameter, or its
declaration cannot be read. Each signature records whether the function is
exported (TypeScript) or module-level (Python).

### Candidate kinds

| Kind                | Type shape                              | Name cues that raise the score                                 | When it legitimately fails                    |
| ------------------- | --------------------------------------- | -------------------------------------------------------------- | --------------------------------------------- |
| `round-trip`        | `f: A -> B` and `g: B -> A` in one file | encode/decode, parse/stringify, serialize/deserialize, to/from | A lossy encoder; a parser that normalizes     |
| `idempotence`       | `f: A -> A`                             | normalize, sanitize, trim, canonicalize, dedupe, sort, slugify | A function that appends or counts             |
| `involution`        | `f: A -> A`                             | reverse, negate, invert, toggle, flip, swap                    | Anything that is not its own inverse          |
| `commutativity`     | `f: (A, A) -> A`                        | add, merge, union, intersect, max, min, gcd, combine           | Subtraction, concatenation, "right side wins" |
| `length-preserving` | `f: array(A) -> array(A)`               | sort, reverse, shuffle, map, rotate                            | A filter or a dedupe                          |
| `total-predicate`   | `f: (...) -> boolean`                   | is, has, validate, check, matches                              | A validator that throws by contract           |
| `determinism`       | any function with resolvable parameters | none                                                           | Reads a clock, randomness or mutable state    |

A `round-trip` pair with `A` equal to `B` is proposed only when a name pair
matches; without one, every pair of string functions would qualify. Candidates
are sorted by score, then kind order, then function name, so the output is
stable.

A candidate is `emittable` only when every function involved is exported (or
module-level), synchronous, and every parameter type resolves. Otherwise it is
still listed, with `blocked` naming why.

### Proposal

`propose` prints markdown by default and JSON with `--json`. `--json-out` also
writes the JSON. The JSON carries `schema: "canary.harley-proposal/1"`, the
source path and SHA-256, the functions seen, the signatures read, the skipped
functions with reasons, the ranked candidates, and the boundary statement. Each
candidate carries `id`, `kind`, `functions`, `statement`, `score`, `tier`,
`basis: "heuristic"`, `evidence`, `failsWhen`, `emittable`, `blocked` and
`status: "proposed"`.

### Emit

`emit <file> --confirm <id>[,<id>...]` re-derives the proposal, resolves each
id, and writes one file per candidate:

- TypeScript: `<stem>.<function>.<kind>.property.test.ts`, importing `vitest`
  and `fast-check`, with
  `fc.assert(fc.property(...), { seed: SEED, numRuns: NUM_RUNS })`.
- Python: `test_<stem>_<function>_<kind>_property.py`, with `@seed(SEED)`,
  `@settings(max_examples=MAX_EXAMPLES, database=None, deadline=None)` and
  `@given(...)`.

The header of each file names the candidate id, the invariant statement, the
seed, and `harness-property-test` as the place for authoring conventions. The
import of the function under test is a relative path (TypeScript) or a dotted
module path from `--root` (Python); the header says to adjust it if the project
layout differs.

`--seed N` overrides the derived seed. `--runs N` sets the run count (default
100). `--root DIR` defaults to the current directory.

### CLI

```text
canary-harley propose FILE [--function NAME] [--root DIR] [--json] [--json-out PATH]
canary-harley emit FILE --confirm ID[,ID...] [--root DIR] [--out-dir DIR]
                        [--seed N] [--runs N] [--force]
```

### Skill

`SKILL.md` declares `cli: scripts/cli.mjs` and `requires: [node>=20]`. Its
workflow is PROPOSE, CONFIRM (a human-only pause: the agent presents the ranked
list and stops), EMIT, then hand-off to `harness-property-test` for refinement
and to `canary-promote-test` for promotion. It states the boundary, the
difference from `canary-cry` and `canary-edge-case-discovery`, and the
offline-sync example as out of scope.

## Integration Points

### Entry Points

- New skill `canary-harley` with a `cli:` entry, reached through
  `canary skills run canary-harley -- propose|emit ...`.

### Registrations Required

- `.claude-plugin/plugin.json`: add the skill directory.
- `harness.config.json`: add `scripts/cli.mjs` to `entropy.entryPoints` and
  `performance.entryPoints`, the same way every script skill is declared.
- `agents/skills/package.json` `format:check` and
  `agents/skills/vitest.config.ts` coverage `include`: add the skill's scripts
  glob.
- `agents/skills/README.md`: tree entry, count and description.
- `docs/naming-registry.md`: `canary-harley` goes from reserved to shipped.

### Documentation Updates

- `docs/guides/property-test-generation.md` plus an entry in
  `docs/guides/index.md`.
- A `CHANGELOG.md` Unreleased entry (the convention in
  `AGENTS.md#changelog-entries` for a `feat` PR).
- The `docs/roadmap.md` row gets its spec and plan links and status.

### Architectural Decisions

None warrant a standalone ADR. D8 applies the confirmed-input gate that ADR 0046
already records for live-target skills to a generation step.

### Knowledge Impact

The concept "proposed invariant: a ranked, heuristic candidate that becomes a
test only after a human confirms it", and the rule "generated property tests
carry a fixed, recorded seed".

## Success Criteria

1. When `propose` is given a TypeScript or Python file with an encode/decode
   pair, the system shall list a `round-trip` candidate in the `likely` tier,
   ranked above a `determinism` candidate for the same functions.
2. When `propose` runs twice on the same file, the system shall print identical
   output, including candidate ids.
3. If a parameter type cannot be mapped, then the system shall list the
   candidate as not emittable and name the type text, and shall not emit a
   generator for it.
4. If `emit` is run without `--confirm`, then the system shall exit 2 and write
   no file.
5. When `emit` is given a confirmed id, the system shall write exactly one test
   file per id under `tests/generated/property/`, and each file shall contain a
   fixed seed constant that is passed to the framework.
6. If a function's signature changed after the id was issued, then `emit` shall
   exit 3, name the id as not derivable, and write no file.
7. If the file holds no functions, no candidates, or only CRUD- or UI-shaped
   functions, then `propose` shall exit 3 and say why.
8. If the engine cannot be located, then both subcommands shall exit 3 and name
   the directories tried.
9. Every emitted TypeScript file shall transpile without syntax errors, and
   every emitted Python file shall parse with `ast.parse` where `python3` is
   available.
10. All fixtures are synthetic, and the four gates, the skills suite and the CI
    ratchets are green with no baseline, allowance or ceiling edited.

## Implementation Order

1. Type parser and signature reader, with unit tests over synthetic TypeScript
   and Python sources.
2. Candidate derivation, scoring and ids, with a test per kind and per
   legitimate non-match.
3. Proposal assembly, renderers and the `propose` subcommand, including engine
   loading and abstentions.
4. Arbitrary mapping, the two emitters and the `emit` subcommand, including the
   confirmation gate, staleness, containment and overwrite refusal.
5. The skill, guide, README, plugin manifest, naming registry, changelog and
   roadmap.
6. Ratchets: entry points, dead exports, perf, docs coverage, blackhawk and
   savant strict, rehearse.
