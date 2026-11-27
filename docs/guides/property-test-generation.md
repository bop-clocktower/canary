# canary-harley — property test generation

`canary-harley` proposes candidate invariants from the function signatures in
one source file, and writes a seeded property test only for a candidate a human
confirmed. The design is recorded in the
[canary-harley proposal](../changes/616-canary-harley/proposal.md). Authoring
conventions, shrinking and arbitrary design belong to the
`harness-property-test` skill and are not repeated here.

```text
propose FILE  ->  ranked list (nothing generated)
                      |
                human confirms ids
                      |
emit FILE --confirm ID  ->  one seeded test per confirmed id
```

## Propose

```bash
canary skills run canary-harley -- propose src/codec.ts
```

`propose` asks the engine for the functions in the file, reads each function's
parameter and return types, and prints the candidates in rank order. Each one
carries an id, a kind, the invariant in words, the evidence it came from, when
it legitimately fails, and whether a test can be emitted for it.

| Flag              | Effect                                              |
| ----------------- | --------------------------------------------------- |
| `--function NAME` | Keep one function's candidates                      |
| `--root DIR`      | The project root paths are printed from (default .) |
| `--json`          | Print the proposal as JSON                          |
| `--json-out PATH` | Also write the JSON to `PATH`                       |

The score is a fixed prior per kind, raised when the function name carries a
cue. Tiers are `likely` (0.70 and up), `plausible` (0.40 up to 0.70) and
`speculative`. Nothing measures whether the invariant holds, so every candidate
is labelled `heuristic`.

The markdown report is read by people and by agents. Text taken from the
analysed file, its path or the command line is printed as inert single-line
text: control characters and line breaks become a space, backticks become
apostrophes, a leading block marker is escaped, and a long value is cut with a
visible marker. The JSON output carries the raw values, escaped as JSON strings.

## Confirm

The human reads the list and picks the invariants that are true of the code.
This step belongs to a human. An agent presents the list and stops; it never
supplies `--confirm` itself, and there is no "confirm all".

A candidate id is `<kind>:<functions>:<8 hex>`. The hex is a SHA-256 over the
kind and the parameter and return types of the functions involved. Change a type
and the id changes, so the old confirmation matches nothing. Parameter names are
not hashed, so a rename keeps a confirmation valid.

## Emit

```bash
canary skills run canary-harley -- emit src/codec.ts \
  --confirm round-trip:encodeToken+decodeToken:1a2b3c4d
```

`emit` derives the candidates from the file again and looks each confirmed id up
in that fresh list. It reads no saved proposal. It is all-or-nothing: one id
that cannot be used means no file is written.

| Flag                   | Effect                                                  |
| ---------------------- | ------------------------------------------------------- |
| `--confirm ID[,ID...]` | Required. The ids a human confirmed                     |
| `--root DIR`           | The project root (default .)                            |
| `--out-dir DIR`        | Output directory, inside `<root>/tests/generated/` only |
| `--seed N`             | The seed for every file in this call                    |
| `--runs N`             | Runs per property (default 100)                         |
| `--force`              | Overwrite an existing generated file                    |

TypeScript sources get a fast-check test for vitest, named
`<stem>.<functions>.<kind>.property.test.ts`. Python sources get a Hypothesis
test for pytest, named `test_<stem>_<functions>_<kind>_property.py`. Both go to
`<root>/tests/generated/property/`. Untyped JavaScript is proposed and cannot be
emitted.

`--out-dir` is contained because the files are executable test code. A path
outside `<root>/tests/generated/`, a `../` climb, and a symlink that leads out
are all refused with exit 2. `--json-out` is not contained: like the other
skills' report flags it is the operator's path.

The generated tests are checked for syntax in this repository's CI and are not
run there. Running them needs `fast-check` or `hypothesis` in the target
project.

## Candidate kinds

| Kind                | Type shape                              | Name cues                                       | When it legitimately fails                    |
| ------------------- | --------------------------------------- | ----------------------------------------------- | --------------------------------------------- |
| `round-trip`        | `f: A -> B` and `g: B -> A` in one file | encode/decode, parse/stringify, to/from         | A lossy encoder; a parser that normalizes     |
| `idempotence`       | `f: A -> A`                             | normalize, sanitize, trim, dedupe, sort         | A function that appends or counts             |
| `involution`        | `f: A -> A`                             | reverse, negate, invert, toggle, flip, swap     | Anything that is not its own inverse          |
| `commutativity`     | `f: (A, A) -> A`                        | add, merge, union, intersect, max, min, combine | Subtraction, concatenation, "right side wins" |
| `length-preserving` | `f: array(A) -> array(A)`               | sort, reverse, shuffle, map, rotate             | A filter or a dedupe                          |
| `total-predicate`   | `f: (...) -> boolean`                   | is, has, validate, check, matches               | A validator that throws by contract           |
| `determinism`       | Any function with parameters            | none                                            | Reads a clock, randomness or mutable state    |

A `round-trip` pair whose two types are equal is proposed only when a name pair
matches. Without that rule every two string functions would qualify.

A `determinism` test compares outcomes, not return values: a parser that throws
the same error for the same bad input twice is deterministic, and passes.

## Safety properties

- **File-derived text is inert.** Type text, paths and command-line values are
  printed as one line with no markup of their own, in the markdown proposal and
  in every error line on stderr. The JSON output carries raw values as escaped
  JSON strings.
- **Generated code is escaped by construction.** Text reaches a generated test
  only as an escaped string literal, a one-line comment, or a name that was
  checked to be an identifier.
- **`emit` is all-or-nothing.** Every id and path is checked before the first
  write. Files are staged beside their targets and moved into place together. A
  failed run exits 1, leaves no generated test and restores any file it had
  replaced.
- **`--out-dir` is contained** in `<root>/tests/generated/`, by path and by real
  path. **`--json-out` is the operator's path** and is not contained.

## Exit codes

| Code | Meaning                                                                                                                                                         |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Proposed, or every confirmed test was written                                                                                                                   |
| 1    | An output file (`--json-out`, or a generated test) could not be written                                                                                         |
| 2    | Usage error: a missing `--confirm`, an `--out-dir` outside `tests/generated/`, an existing file without `--force`, a control character in a path                |
| 3    | Abstained: the engine was not found, the file is unreadable, no functions or candidates, an id that is not derivable now, or a candidate that cannot be emitted |

Exit 3 is an abstention and never a pass. When the engine cannot be located the
message names every directory that was tried.

## Seeds

Every generated file fixes its seed and run count as named constants (`SEED`,
`NUM_RUNS` or `MAX_EXAMPLES`), records both in its header and passes the seed to
the framework (`fc.assert(..., { seed: SEED, numRuns: NUM_RUNS })` or
`@seed(SEED)`). An unseeded generator is a flake source.

- The default seed is the first 31 bits of SHA-256 of the candidate id. It is
  stable across runs and differs between tests. It stays inside the int32 range
  so the seed fast-check prints on a failure is the one in the file; a larger
  `--seed` still runs, but fast-check reports it as a different number.
- `--seed N` overrides it for every id in one `emit` call.
- Hypothesis output sets `database=None` and `deadline=None`. The example
  database and the timing deadline both vary between runs.
- Generated floats exclude NaN (`fc.double({ noNaN: true })`,
  `st.floats(allow_nan=False)`). `nan != nan` would fail every equality property
  for a reason unrelated to the invariant.

## Boundary and non-goals

Property tests suit large input spaces: parsers, serializers, encoders and
validators. They do not suit simple CRUD or UI rendering, and harley skips
functions whose first name token is CRUD- or UI-shaped (`create`, `fetch`,
`render`, `handle` and similar).

Out of scope for this skill:

- Model-based tests. Offline sync is the named example: checking that any
  interleaving of offline edits followed by reconnect gives the merge policy's
  output or an explicit conflict needs fast-check commands, a model and a merge
  policy that no signature states.
- Resolving imported or aliased types, async functions, methods, generics and
  overloads. Each is named as a skip or an unresolved type.
- `Buffer` parameters get `fc.uint8Array()`, which yields a `Uint8Array`.
- Promotion into the committed suite, which stays with `canary-promote-test`.

## Module map

The skill's scripts live in `agents/skills/claude-code/canary-harley/scripts/`.

- [cli.mjs](../../agents/skills/claude-code/canary-harley/scripts/cli.mjs):
  argument parsing, the `propose` and `emit` commands and exit codes.
- [engine.mjs](../../agents/skills/claude-code/canary-harley/scripts/engine.mjs):
  locates the built engine and loads its function extractor.
- [scan.mjs](../../agents/skills/claude-code/canary-harley/scripts/scan.mjs):
  bracket- and string-aware splitting and matching.
- [types.mjs](../../agents/skills/claude-code/canary-harley/scripts/types.mjs):
  the type-node seam: picks a parser and gives a node its canonical key.
- [types-ts.mjs](../../agents/skills/claude-code/canary-harley/scripts/types-ts.mjs):
  TypeScript type expressions to type nodes.
- [types-py.mjs](../../agents/skills/claude-code/canary-harley/scripts/types-py.mjs):
  Python annotations to type nodes.
- [signatures.mjs](../../agents/skills/claude-code/canary-harley/scripts/signatures.mjs):
  parameter and return types for the listed functions, with named skips.
- [cues.mjs](../../agents/skills/claude-code/canary-harley/scripts/cues.mjs):
  name-cue tables and the CRUD/UI boundary check.
- [candidate.mjs](../../agents/skills/claude-code/canary-harley/scripts/candidate.mjs):
  one candidate: score, tier, id, evidence and blocked reasons.
- [invariants.mjs](../../agents/skills/claude-code/canary-harley/scripts/invariants.mjs):
  derives the seven candidate kinds from signatures.
- [proposal.mjs](../../agents/skills/claude-code/canary-harley/scripts/proposal.mjs):
  proposal assembly, abstentions and the JSON and markdown renderers.
- [safe.mjs](../../agents/skills/claude-code/canary-harley/scripts/safe.mjs):
  makes text from the analysed file inert before it is printed as markdown.
- [arbitraries.mjs](../../agents/skills/claude-code/canary-harley/scripts/arbitraries.mjs):
  type nodes to fast-check and Hypothesis expressions, and literal escaping.
- [emit-fast-check.mjs](../../agents/skills/claude-code/canary-harley/scripts/emit-fast-check.mjs):
  the text of a TypeScript fast-check test.
- [emit-hypothesis.mjs](../../agents/skills/claude-code/canary-harley/scripts/emit-hypothesis.mjs):
  the text of a Python Hypothesis test.
- [derive.mjs](../../agents/skills/claude-code/canary-harley/scripts/derive.mjs):
  from a source text and its function names to signatures and candidates.
- [emit.mjs](../../agents/skills/claude-code/canary-harley/scripts/emit.mjs):
  resolves confirmed ids into the plan of files to write, or a refusal.
- [failure.mjs](../../agents/skills/claude-code/canary-harley/scripts/failure.mjs):
  a refusal: an exit code and one inert message line.
- [out-dir.mjs](../../agents/skills/claude-code/canary-harley/scripts/out-dir.mjs):
  output containment, the control-character check and the overwrite refusal.
- [targets.mjs](../../agents/skills/claude-code/canary-harley/scripts/targets.mjs):
  the generated file's name and the import of the function under test.
- [render-test.mjs](../../agents/skills/claude-code/canary-harley/scripts/render-test.mjs):
  the text of one generated test, with its seed fixed.
- [write-plan.mjs](../../agents/skills/claude-code/canary-harley/scripts/write-plan.mjs):
  writes every planned file or none, restoring what a failed run replaced.
