# Plan: canary-harley (invariants proposed from a signature, tests after confirmation)

**Date:** 2026-11-27 | **Spec:** docs/changes/616-canary-harley/proposal.md |
**Tasks:** 25 | **Time:** ~100 min | **Integration Tier:** large (new skill)

## Goal

`canary skills run canary-harley -- propose FILE` prints a ranked, heuristic
list of candidate invariants read from the file's function signatures, and
`emit FILE --confirm ID` writes one seeded fast-check or Hypothesis test per
confirmed candidate and nothing for any other.

## Observable Truths (Acceptance Criteria)

Numbered to match the spec's Success Criteria 1-10.

1. When `propose` is given a TypeScript or Python file with an encode/decode
   pair, the system shall list a `round-trip` candidate in tier `likely`, ranked
   above the `determinism` candidates for the same functions (SC1). Tasks 9, 11,
   12, 16.
2. When `propose` runs twice on the same file, the system shall print
   byte-identical markdown and JSON, candidate ids included (SC2). Tasks 9, 11,
   13, 16, 21.
3. If a parameter type cannot be mapped, then the system shall list the
   candidate with `emittable: false` and the type text in `blocked`, and
   `toFastCheck` / `toHypothesis` shall return `null` for it (SC3). Tasks 4, 5,
   9, 16, 17, 19.
4. If `emit` is run without `--confirm`, then the system shall exit 2 before the
   engine is loaded and write no file (SC4). Task 15.
5. When `emit` is given confirmed ids, the system shall write exactly one file
   per id under `<root>/tests/generated/property/`, each with a `SEED` constant
   that is passed to `fc.assert` or `@seed` (SC5). Tasks 18, 19, 20, 21.
6. If a signature changed after the id was issued, then `emit` shall exit 3,
   name the id as not derivable, and write no file (SC6). Tasks 9, 19, 20.
7. If the file holds no functions, no candidates, or only CRUD- or UI-shaped
   functions, then `propose` shall exit 3 and say which (SC7). Tasks 8, 12, 16.
8. If the engine cannot be located, then `propose` and `emit` shall exit 3 and
   name every directory tried (SC8). Tasks 14, 16, 20.
9. Every emitted TypeScript file shall transpile with zero syntax diagnostics,
   and every emitted Python file shall pass `ast.parse` where `python3` exists
   (SC9). Task 21.
10. All fixtures are synthetic; the four `ts/` gates, the skills suite and the
    CI ratchets are green with no baseline, allowance or ceiling edited (SC10).
    Tasks 1, 2, 24, 25.

## Assumptions

No human was available. Each fork below took the recommended option.

- **A1. Fifteen script modules, not the spec's eleven.** `scan.mjs`,
  `types-ts.mjs`, `types-py.mjs` and `candidate.mjs` are added so every file
  stays under 300 lines and every function under cyclomatic 10. The public seams
  the spec names (`types.mjs`, `invariants.mjs`) keep their roles.
- **A2. Exit codes the spec leaves open.** `--out-dir` outside
  `<root>/tests/generated/` exits 2. An existing target without `--force`
  exits 2. `--runs` below 1 exits 2. `--function NAME` naming no function in the
  file exits 3. An engine module that lacks `extractFileFunctions` exits 3.
- **A3. `emit` is all-or-nothing.** Every id is resolved and every path checked
  before the first write. One bad id means zero files.
- **A4. Ids.** `<kind>:<f>[+<g>]:<8 hex>`. The hash covers the kind and, per
  function, `name(typeKey,...)->typeKey`. Parameter names are not hashed, so a
  rename keeps a confirmation valid and a type change does not.
- **A5. Round-trip direction.** A name pair fixes the order (`encode` then
  `decode`, `stringify` then `parse`, `serialize` then `deserialize`, `to` then
  `from`). Without a name pair and with `A` unequal to `B`, one candidate per
  unordered pair is proposed in declaration order.
- **A6. Boundary lists.** A function is CRUD-shaped when its first name token is
  one of create, fetch, list, update, delete, remove, save, insert, upsert,
  store or find, and UI-shaped when it is one of render, draw, mount, unmount,
  paint, show, hide, handle, on or use. `get`, `set`, `read` and `load` are left
  out because they prefix many pure parsers.
- **A7. Floats exclude NaN.** `number` maps to `fc.double({ noNaN: true })` and
  `st.floats(allow_nan=False)`. `nan != nan` would fail every equality property
  for a reason unrelated to the invariant. The guide says so.
- **A8. `--seed` applies to every id in one `emit` call.** The default is the
  first 8 hex digits of SHA-256 of the id, read as an integer.
- **A9. Functions with zero parameters yield no candidates.** There is nothing
  to generate.
- **A10. The extractor cap is reported.** When the engine returns exactly 20
  names the proposal sets `capped: true` and the markdown says the list may be
  cut short.
- **A11. `main` returns a number for `--help` and usage errors and a Promise for
  a dispatched command**, the shape `canary-cry` uses. The conformance suite
  calls `main` synchronously only on the first two.
- **A12. Fixtures are inline strings in each test file.** A shared `.ts` helper
  under `agents/skills/test/` would need its own `entropy.entryPoints` rows and
  would grow the arch `module-size` aggregate for `agents/skills/test`, which
  needs an allowance this lane may not write.
- **A13. Detail level follows the judomaster plan.** Each task fixes signatures,
  data shapes, tables and test cases. Function bodies are written during
  execution.
- **A14. Skeleton approval.** Standard rigor asks for approval at 8 or more
  tasks. The caller reviews this plan as a whole; treat the skeleton as pending
  that sign-off.

## Uncertainties

- [ASSUMPTION] Entropy ignores test-only imports. Each module therefore exports
  only what another script module imports; tests reach helpers through those
  exports. If entropy names an export in Task 25, unexport it.
- [ASSUMPTION] Importing `<engineDir>/mcp-server.js` has no side effect beyond
  module load (verified by the caller for `ts/dist`). The npm layout
  `dist/engine/mcp-server.js` is assumed to behave the same.
- [ASSUMPTION] `harness check-arch` does not count `.mjs` files in
  `module-size`. Measured on this branch: the only `agents/skills` scopes are
  `.ts`/`.js` files. Complexity, coupling and circular-deps do read `.mjs`.
- [ASSUMPTION] Docs coverage counts a script as documented when a markdown link
  under `docs/` has the same basename. Measured on this branch: 140 of 517 =
  27.08% against a floor of 26.73, so only 6 undocumented files fit. Fifteen new
  scripts would fail the docs ratchet, so Task 23 links every script from the
  guide. Other lanes spend the same budget.
- [DEFERRABLE] Exact wording of statements, evidence lines and the markdown
  layout. Tests pin the ids, tiers, order, key phrases and exit codes only.
- [DEFERRABLE] `Buffer` parameters get `fc.uint8Array()`, which yields a
  `Uint8Array`. The guide names it as a known limit.
- [DEFERRABLE] Whether the TypeScript import needs a `.js` suffix. The header
  tells the reader to adjust the import.
- No BLOCKING uncertainty remains.

## Constraints for every task

- TDD: write the failing test first. Fixtures are synthetic: invented function
  names such as `encodeToken`, `normalizeSlug`, `scoreWidget`. No real names,
  client data or employer code.
- `.mjs` sources are printable ASCII plus tab, LF and CR. Write any other
  character as `\uXXXX`. Task 21 enforces it.
- Style: single quotes, 80 columns, trailing commas. Run
  `npx prettier --write <touched files>` from `agents/skills/`. Run it on
  touched files only.
- Perf ratchet, new code: cyclomatic complexity <= 10, nesting <= 4, functions
  <= 50 lines, files < 300 lines. Use table lookups in place of `if` chains. Do
  not destructure parameters on a function that branches. `cli.mjs` imports at
  most 10 modules (coupling ceiling is 12).
- Export only what another script module imports.
- The tool never reads the clock or `Math.random`. Hashing is `node:crypto`
  SHA-256. Tests use no `new Date()`, `Date.now()`, `setTimeout` or `sleep`.
- Tests keep no shared mutable module state. Each test file declares
  `let root = ''`, assigns `fs.mkdtempSync(path.join(os.tmpdir(), 'harley-'))`
  in `beforeEach`, and removes it in `afterEach` together with
  `vi.restoreAllMocks()`. No module-scope array or object is mutated in place.
- Never edit `.harness/arch/**`, `.harness/*-baseline.json` or any ceiling. No
  new dependency and no lockfile change.
- Registration lists are append-only. If another lane added a row first, keep
  both.
- Work only in `/Users/bs/Github/canary-616`.

## File Map

- CREATE agents/skills/claude-code/canary-harley/SKILL.md
- CREATE agents/skills/claude-code/canary-harley/scripts/{cli,engine,scan,
  types,types-ts,types-py,signatures,cues,candidate,invariants,proposal,
  arbitraries,emit-fast-check,emit-hypothesis,emit}.mjs
- CREATE agents/skills/test/canary-harley-{types,signatures,invariants,
  proposal,cli,arbitraries,emit,syntax}.test.ts
- MODIFY .claude-plugin/plugin.json (skills array, after `canary-generate-test`,
  line 30)
- MODIFY docs/naming-registry.md (line 91, `reserved` to `shipped`)
- MODIFY agents/skills/package.json (`format:check` glob list)
- MODIFY agents/skills/vitest.config.ts (coverage `include`, after the
  `canary-sweep` row)
- MODIFY harness.config.json (`entropy.entryPoints` near line 222 and
  `performance.entryPoints` near line 424)
- MODIFY agents/skills/README.md (tree line 16 count 38 to 39, tree entry,
  description bullet, the `cli:` list near line 329)
- CREATE docs/guides/property-test-generation.md
- MODIFY docs/guides/index.md (entry after the Incident to Regression Test
  entry, line 107)
- CREATE docs/knowledge/gates/proposed-invariant.md
- MODIFY CHANGELOG.md (`## [Unreleased]`, line 15)
- MODIFY docs/roadmap.md (the `canary-harley` row, `Plan:` at line 83)

## Skeleton

1. Scaffold and registrations that keep the `ts/` suite green (2 tasks, ~6 min)
2. Type parser and signature reader (5 tasks, ~22 min)
3. Candidate derivation, scoring, ids (4 tasks, ~16 min)
4. Proposal, engine, `propose` (5 tasks, ~20 min)
5. Arbitraries, emitters, `emit`, syntax checks (5 tasks, ~24 min)
6. Skill, guide, knowledge note (2 tasks, ~10 min)
7. Changelog, roadmap, gates and ratchets (2 tasks, ~12 min)

_Skeleton approval: pending caller sign-off (25 tasks >= 8). Twenty-five tasks
is past the 20-task split point; the group checkpoints below are the milestone
boundaries if execution has to pause._

## Shared fixtures

Each test file declares the constants it needs as template strings. They are
repeated here once so every task names them the same way.

```ts
// CODEC_TS: written to <root>/src/codec.ts when a test needs it on disk.
export function encodeToken(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
export function decodeToken(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
export function normalizeSlug(value: string): string {
  return value.trim().toLowerCase();
}
export const isSlug = (value: string): boolean => /^[a-z0-9-]+$/.test(value);
export function mergeCounts(a: number[], b: number[]): number[] {
  return a.map((n, i) => n + (b[i] ?? 0));
}
export function sortScores(values: number[]): number[] {
  return [...values].sort((x, y) => x - y);
}
export function scoreWidget(widget: Widget): number {
  return widget.weight;
}
function clampLevel(level: number): number {
  return Math.max(0, level);
}
```

```python
# CODEC_PY: written to <root>/src/codec.py.
def encode_token(text: str) -> bytes:
    return text.encode("utf-8")


def decode_token(data: bytes) -> str:
    return data.decode("utf-8")


def normalize_slug(value: str) -> str:
    return value.strip().lower()


def is_slug(value: str) -> bool:
    return value.isalnum()
```

`CODEC_NAMES_TS` is the list the extractor returns for `CODEC_TS`. Function
declarations come first in source order, then const arrows, so the list is
encodeToken, decodeToken, normalizeSlug, mergeCounts, sortScores, scoreWidget,
clampLevel, isSlug.

## Tasks

Every code task runs this loop. Paths are relative to
`/Users/bs/Github/canary-616`.

1. Write the test cases into the named test file.
2. Run `cd agents/skills && npx vitest run test/<file>` and see it fail for the
   stated reason.
3. Implement.
4. Re-run the same command and see it pass with a non-zero test count.
5. `cd agents/skills && npx prettier --write <touched files>`.
6. `harness validate` from the worktree root.

`ts/dist` must exist before any vitest run: `cd ts && npm run build` (once, and
again after any `ts/src` change).

### Task 1: Scaffold the skill directory and its registrations

**Depends on:** none | **Files:**
agents/skills/claude-code/canary-harley/SKILL.md, .claude-plugin/plugin.json,
docs/naming-registry.md | **Category:** integration

A bare directory under `claude-code/` turns two `ts/` tests red, so the stub and
both rows land together.

1. Create `SKILL.md` with frontmatter only (`name: canary-harley`, a one
   sentence `description`, `requires: [node>=20]`; no `cli:` yet) and an
   `# Canary Harley` heading with one paragraph.
2. Run
   `cd ts && npx vitest run test/plugin-skills.test.ts test/bop-name-registry.test.ts`
   and see `registers exactly the adopter-facing skills` and
   `marks a shipped directory as shipped` fail.
3. Add `"./agents/skills/claude-code/canary-harley",` after the
   `canary-generate-test` row in `.claude-plugin/plugin.json`. Change the
   `canary-harley` row in `docs/naming-registry.md` from `reserved` to `shipped`
   and set its description to
   `Invariants proposed from a signature; seeded property tests on confirm`,
   keeping the table columns aligned.
4. Re-run step 2 and see both files pass. Run
   `npx --yes markdownlint-cli@0.50.1` on the two markdown files.
5. `harness validate`.

### Task 2: Format and coverage globs

**Depends on:** Task 1 | **Files:** agents/skills/package.json,
agents/skills/vitest.config.ts | **Category:** integration

1. Append the JSON-escaped glob `claude-code/canary-harley/scripts/**/*.mjs` to
   the `format:check` list in `agents/skills/package.json`, before the
   `test/**/*.ts` glob, quoted and escaped like its neighbours.
2. Append `'claude-code/canary-harley/scripts/**/*.mjs',` to the coverage
   `include` array in `agents/skills/vitest.config.ts`, after the `canary-sweep`
   row.
3. Run `cd agents/skills && npm run format:check` and see it pass (the glob
   matches no file yet; prettier accepts that because other globs match).
4. `harness validate`.

**Checkpoint commit (group 1):**
`chore(harley): scaffold the canary-harley skill and its registrations (#616)`

### Task 3: Bracket-aware scanner

**Depends on:** Task 2 | **Files:**
agents/skills/claude-code/canary-harley/scripts/scan.mjs,
agents/skills/test/canary-harley-types.test.ts

1. Test `splitTopLevel(text, sep)`: `'a, b'` by `,` gives `['a', 'b']`;
   `'Record<string, number>, x'` gives two parts; `"'a,b' | 'c'"` by `|` gives
   two parts (quotes respected); `'{ a: [x, y]; b: z }'` by `;` gives one part;
   `''` gives `[]`; parts are trimmed. Test `matchClose(text, open)`:
   `'(a: (b)) => c'` from index 0 returns 7; a `')'` inside a quoted string is
   skipped; an unbalanced input returns -1.
2. Fails with: cannot find module `scan.mjs`.
3. Implement and export `splitTopLevel(text, sep)` and `matchClose(text, open)`.
   One private `step(state, ch)` updates `{ depth, quote }`; the pairs `()`,
   `[]`, `{}`, `<>` come from one lookup table. `=>` must not count its `>` as a
   closer: skip a `>` preceded by `=`.

### Task 4: TypeScript type expressions

**Depends on:** Task 3 | **Files:**
agents/skills/claude-code/canary-harley/scripts/types-ts.mjs,
agents/skills/claude-code/canary-harley/scripts/types.mjs,
agents/skills/test/canary-harley-types.test.ts

Nodes are plain objects: `{ kind: 'string' }`, `{ kind: 'array', item }`,
`{ kind: 'tuple', items }`, `{ kind: 'record', value }`,
`{ kind: 'object', fields: [{ name, type, optional }] }`,
`{ kind: 'optional', inner }`, `{ kind: 'union', members }`,
`{ kind: 'literal', value }`, `{ kind: 'unresolved', typeText, reason }`.

1. Table test `parseType(text, 'typescript')`:

   | Input                                        | Node                                            |
   | -------------------------------------------- | ----------------------------------------------- |
   | `string` `number` `boolean` `bigint`         | the same kind                                   |
   | `null`                                       | `null`                                          |
   | `Uint8Array`, `Buffer`                       | `bytes`                                         |
   | `string[]`, `Array<string>`                  | `array(string)`                                 |
   | `ReadonlyArray<number>`, `readonly number[]` | `array(number)`                                 |
   | `string[][]`                                 | `array(array(string))`                          |
   | `(string \| number)[]`                       | `array(union(string, number))`                  |
   | `[string, number]`                           | `tuple(string, number)`                         |
   | `Record<string, number>`                     | `record(number)`                                |
   | `{ id: number; tag?: string }`               | `object` with `tag` optional                    |
   | `string \| undefined`                        | `optional(string)`                              |
   | `'asc' \| 'desc'`                            | `union(literal('asc'), literal('desc'))`        |
   | `42`, `true`                                 | `literal(42)`, `literal(true)`                  |
   | `Widget`                                     | `unresolved`, reason `named type`               |
   | `any`, `unknown`                             | `unresolved`, reason `any` / `unknown`          |
   | `(x: number) => string`                      | `unresolved`, reason `function type`            |
   | `Map<string, number>`                        | `unresolved`, reason `generic type`             |
   | `Record<number, string>`                     | `unresolved`, reason `record key is not string` |
   | `void`                                       | `unresolved`, reason `no value`                 |
   | `''`                                         | `unresolved`, reason `no type annotation`       |

   Every `unresolved` node keeps the input as `typeText`. Also test
   `typeKey(node)`: `array<string>`, `tuple<string,number>`, `record<number>`,
   `object{id:number,tag?:string}`, `optional<string>`, `union<number|string>`
   (members sorted, so `string | number` and `number | string` share a key),
   `literal<"asc">`, `unresolved<Widget>`.

2. Fails with: cannot find module `types.mjs`.
3. `types-ts.mjs` exports `parseTsType(text)`. Order of rules: empty; top-level
   `|` split (union, with `undefined` folded into `optional`); `=>` at depth 0
   (function type); trailing `[]`; leading `readonly`; wrapping parentheses;
   `[...]` tuple; `{...}` object; `Name<args>` via a `GENERICS` table; quoted,
   numeric or boolean literal; a `PRIMITIVES` table; otherwise `named type`.
   Each rule is its own small function returning a node or `null`; `parseTsType`
   walks the rule list.
4. `types.mjs` exports `parseType(text, lang)` (a `{ typescript, javascript }`
   lookup onto `parseTsType`; `python` arrives in Task 5) and `typeKey(node)` (a
   per-kind lookup table of formatters).

### Task 5: Python type expressions and unresolved collection

**Depends on:** Task 4 | **Files:**
agents/skills/claude-code/canary-harley/scripts/types-py.mjs,
agents/skills/claude-code/canary-harley/scripts/types.mjs,
agents/skills/test/canary-harley-types.test.ts

1. Table test `parseType(text, 'python')`: `str` gives `string`; `int` gives
   `integer`; `float` gives `number`; `bool`; `bytes`; `None` gives `null`;
   `list[int]` and `List[int]` give `array(integer)`; `tuple[str, int]`;
   `dict[str, int]` gives `record(integer)`; `Optional[str]` and `str | None`
   give `optional(string)`; `Union[str, int]` and `int | str` give the same
   `typeKey`; `Literal['a', 'b']` gives a union of two literals; `Literal[3]`
   gives `literal(3)`; `list[list[int]]` nests. Unresolved: `Widget` and
   `'Widget'` (`named type`), `Any` (`any`), `Callable[[int], str]`
   (`function type`), `dict[int, str]` (`record key is not str`), `set[int]`
   (`generic type`), `''` (`no type annotation`). Test
   `collectUnresolved(node)`: `array(tuple(string, unresolved Widget))` returns
   that one node; a fully resolved object returns `[]`; a union with two
   unresolved members returns both in order.
2. Fails with: `parseType(..., 'python')` returns `undefined` or throws.
3. `types-py.mjs` exports `parsePyType(text)`, built the same way as the
   TypeScript parser (rule list, `PRIMITIVES` and `GENERICS` tables,
   `splitTopLevel` for `|` and `,`). `types.mjs` adds the `python` row and
   exports `collectUnresolved(node)` (one recursive walk over a per-kind
   `CHILDREN` table).

### Task 6: TypeScript signature reader

**Depends on:** Task 5 | **Files:**
agents/skills/claude-code/canary-harley/scripts/signatures.mjs,
agents/skills/test/canary-harley-signatures.test.ts

1. Test `langOf(file)`: `.ts` and `.tsx` give `typescript`; `.js`, `.jsx`,
   `.mjs` give `javascript`; `.py` gives `python`; `.rb` gives `null`. Test
   `readSignatures(CODEC_TS, 'typescript', CODEC_NAMES_TS)` returns
   `{ signatures, skipped }`, every signature carrying `lang: 'typescript'`,
   where `encodeToken` has `params: [{ name: 'text', type: string }]`,
   `returns: bytes`, `exported: true`; `isSlug` (const arrow) has
   `returns: boolean`; `mergeCounts` has two `array(number)` params;
   `scoreWidget` has an `unresolved` param with `typeText: 'Widget'`;
   `clampLevel` has `exported: false`. Further cases, each a small inline
   source: `x?: number` gives `optional(number)`; `x: number = 3` gives
   `number`; a parameter with no annotation gives `unresolved` reason
   `no type annotation`; a multi-line parameter list reads the same as the
   one-line form; a `)` inside a default string value does not end the list.
   Skips, each with `{ name, reason }`: `export async function hashLater`
   (`async function`), `function pick<T>(items: T[]): T` (`generic function`),
   `function sum(...parts: number[])` (`rest parameter`),
   `function area({ w, h }: Size)` (`destructured parameter`), two overload
   declarations of `parseLevel` (`overloaded function`), a declaration indented
   inside another function (`nested function`), a name with no declaration in
   the source (`declaration not found`).
2. Fails with: cannot find module `signatures.mjs`.
3. Export `langOf(file)` and `readSignatures(source, lang, names)`. Private
   helpers: `findTsDeclarations(source, name)` (the two anchored regexes for
   `function NAME` and `const NAME =`, returning indent, `exported`, `async` and
   the index of `(` or `<`), `readParams(source, open)` (`matchClose`, then
   `splitTopLevel` by `,`), `readParam(text)` (strip a default with
   `splitTopLevel` by `=`, split name and type at the first top-level `:`),
   `readReturn(source, close)` (text after `:` up to a top-level `{`, `=>` or
   `;`), and `tsSkipReason(decls, params)` as an ordered list of
   `[predicate, reason]` pairs.

### Task 7: Python signature reader

**Depends on:** Task 6 | **Files:**
agents/skills/claude-code/canary-harley/scripts/signatures.mjs,
agents/skills/test/canary-harley-signatures.test.ts

1. Test `readSignatures(CODEC_PY, 'python', [...])`: `encode_token` has
   `params: [{ name: 'text', type: string }]`, `returns: bytes`,
   `exported: true`; `is_slug` returns `boolean`. Further cases:
   `def scale(value: float, factor: float = 2.0) -> float` reads two `number`
   params; `def tag(value)` gives `unresolved` reason `no type annotation` and
   an `unresolved` return; a parameter list spread over three lines reads the
   same. Skips: `async def pull(...)` (`async function`), a `def` indented under
   `class Store:` (`method or nested function`), `def join(*parts: str)` and
   `def cfg(**opts: int)` (`rest parameter`),
   `def clip(value: int, /, low: int)` and `def clip2(value: int, *, low: int)`
   (`positional-only or keyword-only marker`). A `javascript` source
   `export function trimTag(value) { ... }` yields one signature whose param is
   `unresolved` reason `no type annotation`.
2. Fails with: `readSignatures(..., 'python', ...)` returns no signatures.
3. Add `findPyDeclarations(source, name)` (regex
   `^(\s*)(async\s+)?def\s+NAME\s*\(`), `readPyReturn(source, close)` (text
   between `->` and the top-level `:`), and `pySkipReason`. `readSignatures`
   picks the reader set from a `{ typescript, javascript, python }` table.

**Checkpoint commit (group 2):**
`feat(harley): type-expression parser and signature reader (#616)`

### Task 8: Name cues and the boundary check

**Depends on:** Task 2 | **Files:**
agents/skills/claude-code/canary-harley/scripts/cues.mjs,
agents/skills/test/canary-harley-invariants.test.ts

1. Test `cueFor(kind, name)` returns the matched cue word or `null`:
   `('idempotence', 'normalizeSlug')` gives `normalize`;
   `('idempotence', 'normalize_slug')` gives `normalize`;
   `('involution', 'reverseWords')` gives `reverse`;
   `('commutativity', 'mergeCounts')` gives `merge`;
   `('commutativity', 'address')` gives `null` (whole tokens only, `add` does
   not match); `('length-preserving', 'sortScores')` gives `sort`;
   `('total-predicate', 'isSlug')` gives `is`; `('determinism', 'anything')`
   gives `null`. Test `pairCue(a, b)` returns `{ first, second, label }` or
   `null`: `('decodeToken', 'encodeToken')` gives first `encodeToken`, second
   `decodeToken`, label `encode/decode`; `('parse', 'stringify')` gives first
   `stringify`; `('toJson', 'fromJson')` gives first `toJson`;
   `('encodeToken', 'decodeHeader')` gives `null` (the remaining tokens differ);
   `('encode_token', 'decode_token')` matches. Test `boundarySkip(name)` returns
   a reason or `null`: `createWidget` gives `CRUD-shaped by name (create)`;
   `renderBadge` gives `UI-shaped by name (render)`; `onClick` and `useWidget`
   are UI-shaped; `getChecksum`, `readVarint`, `encodeToken` and `listen` give
   `null`. Assert `BOUNDARY` mentions `parsers`, `serializers`, `encoders`,
   `validators`, `CRUD` and `UI`.
2. Fails with: cannot find module `cues.mjs`.
3. Export `cueFor`, `pairCue`, `boundarySkip`, `BOUNDARY`. Private:
   `tokens(name)` (split on `_` and on lower-to-upper boundaries, lowercased),
   `KIND_CUES` (the spec's table, one array per kind), `PAIRS` (encode/decode,
   stringify/parse, serialize/deserialize, to/from, each as `[first, second]`),
   `CRUD` and `UI` sets from assumption A6.

### Task 9: Candidate construction, scoring and ids

**Depends on:** Tasks 5, 8 | **Files:**
agents/skills/claude-code/canary-harley/scripts/candidate.mjs,
agents/skills/test/canary-harley-invariants.test.ts

1. Test `makeCandidate(kind, signatures, cue, statement)` with signatures built
   by `readSignatures`:
   - shape: `id`, `kind`, `functions`, `statement`, `score`, `tier`,
     `basis: 'heuristic'`, `evidence`, `failsWhen`, `emittable`, `blocked`,
     `status: 'proposed'`;
   - scores (prior, with cue): `round-trip` 0.55 / 0.90, `idempotence` 0.30 /
     0.75, `involution` 0.10 / 0.75, `commutativity` 0.25 / 0.75,
     `length-preserving` 0.35 / 0.80, `total-predicate` 0.60 / 0.85,
     `determinism` 0.65 with no cue; scores are exact two-decimal numbers
     (computed in hundredths);
   - tiers: 0.70 and up `likely`, 0.40 up to 0.70 `plausible`, below
     `speculative`; test the three edges 0.70, 0.40 and 0.39;
   - id matches `/^round-trip:encodeToken\+decodeToken:[0-9a-f]{8}$/`; the same
     input gives the same id twice; changing `text: string` to `text: number`
     changes the 8 hex; renaming the parameter does not; a different kind over
     the same function has a different hex;
   - `emittable: true` for `normalizeSlug`; `scoreWidget` gives
     `emittable: false` and a `blocked` entry containing `'Widget'` and
     `named type`; `clampLevel` is blocked with `not exported`; a `javascript`
     signature is blocked with `untyped JavaScript`;
   - `evidence` holds a `shape:` line and, with a cue, a `name cue:` line;
     `failsWhen` is the spec's text for the kind.

   Test `sortCandidates(list)`: score descending, then kind order (round-trip,
   idempotence, involution, commutativity, length-preserving, total-predicate,
   determinism), then first function name.

2. Fails with: cannot find module `candidate.mjs`.
3. Export `makeCandidate`, `sortCandidates`. Private: `KINDS` (one row per kind:
   `order`, `prior`, `boost`, `failsWhen`), `signatureKey(sig)`
   (`name(typeKey,...)->typeKey`), `candidateId(kind, sigs)`
   (`createHash('sha256')` over the kind and the keys joined by `\n`, first 8
   hex), `tierOf(hundredths)`, `blockedReasons(sigs)` (uses `collectUnresolved`
   on each param).

### Task 10: Single-function kinds

**Depends on:** Task 9 | **Files:**
agents/skills/claude-code/canary-harley/scripts/invariants.mjs,
agents/skills/test/canary-harley-invariants.test.ts

1. Test `deriveCandidates(signatures)`, one case per kind and per legitimate
   non-match:
   - `normalizeSlug` (`string -> string`): `idempotence` 0.75 `likely`,
     `involution` 0.10 `speculative`, `determinism` 0.65;
   - `reverseWords(text: string): string`: `involution` 0.75;
   - `sortScores` (`number[] -> number[]`): `length-preserving` 0.80 and
     `idempotence` 0.75;
   - `isSlug`: `total-predicate` 0.85; a `boolean` function named `matchesAny`
     with no token cue still gets 0.60 `plausible`;
   - non-matches: `toLength(text: string): number` gets no `idempotence` and no
     `involution`; `head(values: number[]): number` gets no `length-preserving`;
     `pad(text: string, width: number): string` gets no `idempotence`; a
     zero-parameter function gets no candidate at all;
   - `scoreWidget` still gets `determinism`, with `emittable: false`.
2. Fails with: cannot find module `invariants.mjs`.
3. Export `deriveCandidates(signatures)`. A `DERIVERS` array holds one function
   per kind, each `(sig, all) => candidate[]`; this task adds `idempotence`,
   `involution`, `lengthPreserving`, `totalPredicate` and `determinism`.
   Statements are ASCII, for example
   `normalizeSlug(normalizeSlug(x)) equals normalizeSlug(x)`. The result goes
   through `sortCandidates`.

### Task 11: Pair kinds and ranking

**Depends on:** Task 10 | **Files:**
agents/skills/claude-code/canary-harley/scripts/invariants.mjs,
agents/skills/test/canary-harley-invariants.test.ts

1. Test:
   - `CODEC_TS` signatures: the first candidate is `round-trip` over
     `[encodeToken, decodeToken]`, score 0.90, tier `likely`, statement
     `decodeToken(encodeToken(x)) equals x`, and it sorts above every
     `determinism` candidate (SC1); the same holds for `CODEC_PY`;
   - exactly one `round-trip` candidate exists for the pair (no reversed
     duplicate);
   - `toHex(n: number): string` with `parseHex(s: string): number` (no name
     pair, `A` unequal to `B`): one `round-trip` at 0.55 `plausible` in
     declaration order;
   - `trimTag(s: string): string` with `padTag(s: string): string` (`A` equals
     `B`, no name pair): no `round-trip`;
   - `mergeCounts`: `commutativity` 0.75;
     `concat(a: string, b: string): string`: `commutativity` 0.25 `speculative`;
     `scale(a: number, b: string): number`: none;
   - the whole `CODEC_TS` list is in score order and calling `deriveCandidates`
     twice returns deeply equal arrays.
2. Fails with: no `round-trip` or `commutativity` candidate is returned.
3. Add `roundTrip` and `commutativity` to `DERIVERS`. `roundTrip` runs once per
   signature against later signatures only, compares `typeKey` of the single
   parameter and return both ways, and takes its direction from `pairCue`.

**Checkpoint commit (group 3):**
`feat(harley): derive, score and identify candidate invariants (#616)`

### Task 12: Proposal assembly

**Depends on:** Tasks 7, 11 | **Files:**
agents/skills/claude-code/canary-harley/scripts/proposal.mjs,
agents/skills/test/canary-harley-proposal.test.ts

1. Test `buildProposal(input)` with `input = { path, source, names, only }`:
   - `CODEC_TS` with `CODEC_NAMES_TS`: `schema` is `canary.harley-proposal/1`;
     `source.path` is the given path; `source.sha256` is the SHA-256 of the
     source (compare to a `createHash` value computed in the test); `functions`
     equals `names`; `signatures` has 8 entries; `candidates[0].kind` is
     `round-trip`; `boundary` equals `BOUNDARY`; `abstained` is `null`; `capped`
     is `false`;
   - names `createWidget` and `renderBadge` are in `skipped` with their boundary
     reasons and never reach `signatures`;
   - `names: []` gives `abstained` containing `no functions`;
   - a source holding only `createWidget` and `renderBadge` gives `abstained`
     containing `only CRUD- or UI-shaped functions`;
   - a source holding only a zero-parameter function gives `abstained`
     containing `no candidates`;
   - an unsupported extension (`notes.rb`) gives `abstained` containing
     `unsupported file type`;
   - `only: 'normalizeSlug'` keeps just the candidates whose `functions` include
     it; `only: 'missing'` gives `abstained` containing
     `no function named 'missing'`;
   - 20 names give `capped: true`.
2. Fails with: cannot find module `proposal.mjs`.
3. Export `buildProposal(input)`. Private steps, each its own function:
   `partition(names)` (boundary skips), `readSignatures`, `deriveCandidates`,
   `filterOnly`, `abstention(parts)` as an ordered list of
   `[predicate, message]` pairs.

### Task 13: Renderers

**Depends on:** Task 12 | **Files:**
agents/skills/claude-code/canary-harley/scripts/proposal.mjs,
agents/skills/test/canary-harley-proposal.test.ts

1. Test `renderJson(proposal)`: parses back to an object deeply equal to the
   proposal; ends with a newline; two calls give the same string. Test
   `renderMarkdown(proposal)`: the first line is
   `# canary-harley proposal: src/codec.ts`; it prints the SHA-256, the counts
   (`functions seen`, `signatures read`, `skipped`), the boundary statement and
   the word `heuristic`; candidates are numbered in rank order with tier, score,
   `id:`, `evidence:`, `fails when:` and `emittable: yes` or `emittable: no`
   followed by the blocked reason; the `scoreWidget` entry prints `'Widget'`;
   skipped functions are listed with reasons; it ends with a line saying nothing
   was generated and the `emit ... --confirm` form; a `capped` proposal says the
   function list may be cut short at 20; an abstained proposal prints the reason
   and no candidate list. The text is ASCII (`/^[\t\n\r\x20-\x7E]*$/`).
   Rendering twice is byte-identical (SC2).
2. Fails with: `renderJson` is not exported.
3. Export `renderJson` (`JSON.stringify(proposal, null, 2) + '\n'`) and
   `renderMarkdown`. Build the markdown from small section functions (`header`,
   `candidateLines`, `skippedLines`, `nextLines`) joined by `\n`.

### Task 14: Engine loading

**Depends on:** Task 2 | **Files:**
agents/skills/claude-code/canary-harley/scripts/engine.mjs,
agents/skills/test/canary-harley-cli.test.ts

1. Test `engineCandidates(root, env)`: with
   `env = { CANARY_ENGINE_DIR: '/x/engine' }` the list is
   `['/x/engine', '<root>/ts/dist', '<root>/dist/engine']`; with `{}` it is the
   last two. Test `loadEngine(candidates)`: with the default candidates it
   resolves `{ ok: true, dir, extractFileFunctions }` and
   `extractFileFunctions(<tmp>/codec.ts)` returns `CODEC_NAMES_TS`; with
   `[path.join(root, 'none-a'), path.join(root, 'none-b')]` it resolves
   `{ ok: false, error }` and `error` contains both directories; with a temp
   directory holding an `mcp-server.js` that exports nothing it resolves
   `{ ok: false }` and `error` names `extractFileFunctions`.
2. Fails with: cannot find module `engine.mjs`.
3. Model on `canary-cassandra/scripts/engine.mjs`. Export
   `engineCandidates(root = ROOT, env = process.env)` and
   `async loadEngine(candidates = engineCandidates())`. The one module is
   `mcp-server.js`, imported with `pathToFileURL`. The not-found message names
   every directory tried and the fix (`npm --prefix ts run build`, or set
   `CANARY_ENGINE_DIR`).

### Task 15: CLI entry, usage contract and entry points

**Depends on:** Tasks 13, 14 | **Files:**
agents/skills/claude-code/canary-harley/scripts/cli.mjs,
agents/skills/claude-code/canary-harley/SKILL.md, harness.config.json

1. In `canary-harley-cli.test.ts`, with a `run(argv, deps)` helper that spies
   `console.log` and `console.error` and awaits `main`:
   - `main(['--help'])` returns the number 0 synchronously and prints a line
     starting `usage: canary-harley`;
   - no arguments: 2, `the following arguments are required: command`;
   - `['frobnicate']`: 2, `invalid choice: 'frobnicate'`;
   - `['propose']`: 2, `the following arguments are required: FILE`;
   - `['propose', 'a.ts', 'b.ts']`: 2, `unrecognized arguments: b.ts`;
   - `['emit', 'a.ts']`: 2, `the following arguments are required: --confirm`,
     returned synchronously with `deps.engineDirs` pointing at a directory that
     does not exist (so the engine was never consulted) and no `tests/`
     directory created under `root` (SC4);
   - `['emit', 'a.ts', '--confirm', 'x', '--runs', '0']`: 2;
   - `CLI_SPEC.prog` is `canary-harley`.
2. Fails with: cannot find module `cli.mjs`.
3. Create `cli.mjs`: line 1 `#!/usr/bin/env node`, a header comment (purpose,
   exit codes 0 / 2 / 3, the invocation line), then:

   ```js
   export const CLI_SPEC = {
     prog: 'canary-harley',
     booleans: { '--json': 'json', '--force': 'force' },
     values: {
       '--function': { key: 'function' },
       '--root': { key: 'root' },
       '--json-out': { key: 'jsonOut' },
       '--confirm': { key: 'confirm' },
       '--out-dir': { key: 'outDir' },
       '--seed': { key: 'seed', type: 'int' },
       '--runs': { key: 'runs', type: 'int' },
     },
     defaults: { root: '.', runs: 100 },
     positionals: { key: 'command' },
   };
   ```

   `usageError(error, positionals, opts)` is an ordered list of
   `[predicate, message]` checks. `export function main(argv = [], deps = {})`
   handles help and usage synchronously, then returns
   `COMMANDS[command](opts, file, ctx)` where `COMMANDS` is `{ propose, emit }`
   and both are stubs returning `Promise.resolve(3)` until Tasks 16 and 20. The
   file ends with the `isMain` guard that sets
   `process.exitCode = await main(process.argv.slice(2));` (the conformance
   suite matches that exact assignment).

4. `chmod +x agents/skills/claude-code/canary-harley/scripts/cli.mjs`. Add
   `cli: scripts/cli.mjs` to the `SKILL.md` frontmatter. Append
   `"agents/skills/claude-code/canary-harley/scripts/cli.mjs",` to BOTH
   `entropy.entryPoints` and `performance.entryPoints` in `harness.config.json`,
   after the `canary-question` row in each.
5. Run
   `npx vitest run test/canary-harley-cli.test.ts test/skill-cli-conformance.test.ts`
   and see the `canary-harley` conformance block pass (shebang, exec bit,
   `CLI_SPEC`, help, unknown flag, inherited keys, empty values, spawn,
   symlink).

### Task 16: `propose` subcommand

**Depends on:** Task 15 | **Files:**
agents/skills/claude-code/canary-harley/scripts/cli.mjs,
agents/skills/test/canary-harley-cli.test.ts

1. Tests write `CODEC_TS` to `<root>/src/codec.ts` and `CODEC_PY` to
   `<root>/src/codec.py`, and pass `--root <root>`:
   - `propose <ts file>`: exit 0; stdout starts with
     `# canary-harley proposal: src/codec.ts` (path relative to `--root`); the
     `round-trip` line appears before the first `determinism` line and carries
     `likely` (SC1); the same for the Python file;
   - two runs print identical stdout (SC2);
   - `--json`: stdout parses; `schema` is `canary.harley-proposal/1`; every
     candidate has `status: 'proposed'` and `basis: 'heuristic'`; the
     `scoreWidget` candidate has `emittable: false` and `blocked` naming
     `'Widget'` (SC3);
   - `--json-out <root>/out/p.json` writes the same JSON and still prints
     markdown;
   - `--function normalizeSlug` lists only its candidates;
   - nothing is written under `<root>/tests/`;
   - abstentions, each exit 3 with the reason on stderr and no candidate list on
     stdout (SC7): an empty file (`no functions`); a file with only
     `createWidget` and `renderBadge` (`only CRUD- or UI-shaped`); a file with
     only a zero-parameter function (`no candidates`); a path that does not
     exist (`cannot read`);
   - `deps.engineDirs = [<root>/none-a, <root>/none-b]`: exit 3 and stderr names
     both directories (SC8).
2. Fails with: `propose` returns 3 for the happy path.
3. Implement `async function propose(opts, file, ctx)`:
   `loadEngine(ctx.engineDirs ?? engineCandidates())`, `readSource(file)`
   (try/catch around `readFileSync`), `displayPath(file, root)` (posix relative
   path when inside `root`, else the path as given), `buildProposal`, optional
   `--json-out` write (mkdir `recursive`), print, return
   `proposal.abstained === null ? 0 : 3`. Abstention reasons go to stderr as
   `canary-harley: abstained: <reason>`.

**Checkpoint commit (group 4):**
`feat(harley): canary-harley propose with engine loading and abstentions (#616)`

### Task 17: Arbitrary mapping

**Depends on:** Task 5 | **Files:**
agents/skills/claude-code/canary-harley/scripts/arbitraries.mjs,
agents/skills/test/canary-harley-arbitraries.test.ts

1. Table test `toFastCheck(node)` and `toHypothesis(node)` over nodes built with
   `parseType`:

   | Node                 | fast-check                                   | Hypothesis                            |
   | -------------------- | -------------------------------------------- | ------------------------------------- |
   | `string`             | `fc.string()`                                | `st.text()`                           |
   | `number`             | `fc.double({ noNaN: true })`                 | `st.floats(allow_nan=False)`          |
   | `integer`            | `fc.integer()`                               | `st.integers()`                       |
   | `boolean`            | `fc.boolean()`                               | `st.booleans()`                       |
   | `bigint`             | `fc.bigInt()`                                | `st.integers()`                       |
   | `bytes`              | `fc.uint8Array()`                            | `st.binary()`                         |
   | `null`               | `fc.constant(null)`                          | `st.none()`                           |
   | `array(string)`      | `fc.array(fc.string())`                      | `st.lists(st.text())`                 |
   | `tuple(string, int)` | `fc.tuple(fc.string(), fc.integer())`        | `st.tuples(st.text(), st.integers())` |
   | `record(number)`     | `fc.dictionary(fc.string(), ...)`            | `st.dictionaries(st.text(), ...)`     |
   | `object`             | `fc.record({ id: ... })`                     | `st.fixed_dictionaries({"id": ...})`  |
   | `object`, optional   | adds `{ requiredKeys: ['id'] }`              | adds `optional={"tag": ...}`          |
   | `optional(string)`   | `fc.option(fc.string(), { nil: undefined })` | `st.one_of(st.none(), st.text())`     |
   | `union`              | `fc.oneof(a, b)`                             | `st.one_of(a, b)`                     |
   | `literal('asc')`     | `fc.constant("asc")`                         | `st.just("asc")`                      |
   | `literal(true)`      | `fc.constant(true)`                          | `st.just(True)`                       |

   An `unresolved` node gives `null` from both, and so does any node that
   contains one (`array(Widget)`, an object with one unresolved field) (SC3).

2. Fails with: cannot find module `arbitraries.mjs`.
3. Export `toFastCheck(node)` and `toHypothesis(node)`. One private
   `render(node, table)` recursion; `FC` and `HYP` are per-kind tables of
   formatters taking already-rendered children. `render` returns `null` as soon
   as a child is `null`. Literals use `JSON.stringify`; the Hypothesis table
   maps `true`, `false`, `null` to `True`, `False`, `None`.

### Task 18: fast-check and Hypothesis test text

**Depends on:** Tasks 11, 17 | **Files:**
agents/skills/claude-code/canary-harley/scripts/emit-fast-check.mjs,
agents/skills/claude-code/canary-harley/scripts/emit-hypothesis.mjs,
agents/skills/test/canary-harley-arbitraries.test.ts

Both renderers take one argument,
`spec = { candidate, signatures, importPath, stem, seed, runs }`, where
`signatures` are the functions the candidate names, in order.

1. Test `renderFastCheck(spec)` for the `round-trip` candidate of `CODEC_TS`
   with `seed: 4242`, `runs: 100`, `importPath: '../../../src/codec'`:
   - the header comment holds the candidate id, the statement, `Seed: 4242`,
     `harness-property-test`, and a line telling the reader to adjust the
     import;
   - `import { describe, expect, it } from 'vitest';` and
     `import fc from 'fast-check';`;
   - `import { decodeToken, encodeToken } from '../../../src/codec';` (names
     sorted);
   - `const SEED = 4242;` and `const NUM_RUNS = 100;`;
   - `{ seed: SEED, numRuns: NUM_RUNS }` is the second argument of `fc.assert`,
     and the literal `4242` appears nowhere else in code lines;
   - the body is `expect(decodeToken(encodeToken(a))).toEqual(a);` and the
     generator is `fc.string()`, the first function's parameter type (not
     `fc.uint8Array()`, the second's).

   One assertion per other kind's body line: idempotence
   `expect(f(f(a))).toEqual(f(a));`, involution `expect(f(f(a))).toEqual(a);`,
   commutativity `expect(f(a, b)).toEqual(f(b, a));`, length-preserving
   `expect(f(a)).toHaveLength(a.length);`, total-predicate
   `expect(typeof f(a)).toBe('boolean');`, determinism
   `expect(f(a)).toEqual(f(a));`.

   Test `renderHypothesis(spec)` for the `CODEC_PY` pair with
   `importPath: 'src.codec'`, `stem: 'codec'`:
   - the same header facts as `#` comments;
   - `from hypothesis import given, seed, settings` and
     `from hypothesis import strategies as st`;
   - `from src.codec import decode_token, encode_token`;
   - `SEED = 4242` and `MAX_EXAMPLES = 100`;
   - the decorators in this order: `@seed(SEED)`,
     `@settings(max_examples=MAX_EXAMPLES, database=None, deadline=None)`,
     `@given(a=st.text())`;
   - `def test_codec_encode_token_decode_token_round_trip(a):` and
     `assert decode_token(encode_token(a)) == a`;
   - the other kinds' bodies: `assert f(f(a)) == f(a)`, `assert f(f(a)) == a`,
     `assert f(a, b) == f(b, a)`, `assert len(f(a)) == len(a)`,
     `assert isinstance(f(a), bool)`, `assert f(a) == f(a)`.

   Both outputs are ASCII, end with one newline, and are identical on a second
   call.

2. Fails with: cannot find module `emit-fast-check.mjs`.
3. `emit-fast-check.mjs` exports `renderFastCheck(spec)`; `emit-hypothesis.mjs`
   exports `renderHypothesis(spec)`. Each holds a `BODIES` table keyed by kind
   (a function of the call names and argument names returning the assertion
   line) and builds the file from `header`, `imports`, `constants` and
   `testBlock` sections. Argument names are `a`, `b`, `c` by position.

### Task 19: Emit planning

**Depends on:** Tasks 12, 18 | **Files:**
agents/skills/claude-code/canary-harley/scripts/emit.mjs,
agents/skills/test/canary-harley-emit.test.ts

`planEmit(proposal, opts)` takes
`opts = { ids, file, root, outDir, seed, runs, force }` and returns
`{ files: [{ path, text }], error: null }` or
`{ files: [], error: { exit, message } }`.

1. Test, with a proposal built from `CODEC_TS` at `<root>/src/codec.ts`:
   - one confirmed `round-trip` id: one file at
     `<root>/tests/generated/property/codec.encodeToken-decodeToken.round-trip.property.test.ts`,
     whose text imports from `../../../src/codec` (SC5);
   - the Python proposal: one file at
     `<root>/tests/generated/property/test_codec_encode_token_decode_token_round_trip_property.py`
     importing `src.codec`;
   - two ids give two files; the same id twice gives one;
   - default seed: `parseInt(sha256(id).slice(0, 8), 16)` (computed in the test)
     appears as `const SEED = <n>;`; `seed: 7` gives `const SEED = 7;` in every
     file; `runs: 25` gives `const NUM_RUNS = 25;`;
   - an id that is not in the proposal: `error.exit` 3, the message contains the
     id and `not derivable`, `files` is empty (SC6); one good id plus one
     unknown id still gives zero files;
   - the `scoreWidget` determinism id: exit 3, the message contains `'Widget'`
     and `cannot be emitted` (SC3);
   - an id from a `javascript` proposal: exit 3, `untyped JavaScript`;
   - `outDir: 'src'`, `outDir: '../elsewhere'` and an absolute path outside
     `root`: exit 2, the message names `tests/generated`;
   - `outDir: 'tests/generated/custom'`: accepted;
   - a symlink `<root>/tests/generated/link` pointing at `<root>/src`, used as
     `outDir`: exit 2;
   - the target file already exists: exit 2 naming the path and `--force`; with
     `force: true` the plan is returned;
   - a Python source whose path from `root` has a segment that is not an
     identifier (`my-pkg/codec.py`): exit 3 naming the segment.
2. Fails with: cannot find module `emit.mjs`.
3. Export `planEmit(proposal, opts)`. Private, one decision each:
   `resolveIds(proposal, ids)`, `resolveOutDir(root, outDir)` (lexical
   containment with `path.relative`, then `realpathSync` of the deepest existing
   ancestor against `realpathSync(root)`), `targetName(lang, stem, candidate)`,
   `importFor(lang, file, root, outDir)`, `derivedSeed(id)`, `specFor(...)`, and
   a `RENDERERS` table
   `{ typescript: renderFastCheck, python: renderHypothesis }`. Every failure
   returns early with `{ files: [], error }`.

### Task 20: `emit` subcommand

**Depends on:** Tasks 16, 19 | **Files:**
agents/skills/claude-code/canary-harley/scripts/emit.mjs,
agents/skills/claude-code/canary-harley/scripts/cli.mjs,
agents/skills/test/canary-harley-emit.test.ts

1. Tests drive `main` with `--root <root>`. Each first runs `propose --json` and
   reads ids from its output:
   - `emit <file> --confirm <round-trip id>`: exit 0; exactly one file exists
     under `<root>/tests/generated/property/`; stdout names it; the file holds a
     `const SEED` assignment and `{ seed: SEED, numRuns: NUM_RUNS }` (SC5);
   - `--confirm <id1>,<id2>`: exactly two files; candidates that were not
     confirmed have no file (list the directory and compare);
   - Python: the file holds `@seed(SEED)`, `database=None`, `deadline=None`;
   - `--seed 7 --runs 25` appear as the constants;
   - stale id (SC6): take the id, rewrite the source so `encodeToken` takes
     `text: number`, run `emit` with the old id: exit 3, stderr contains the id
     and `not derivable`, and `<root>/tests` does not exist;
   - a second `emit` of the same id: exit 2 and the file's content is unchanged
     (write a marker into it first); with `--force`: exit 0 and the marker is
     gone;
   - `--out-dir src`: exit 2, nothing written;
   - `deps.engineDirs` pointing nowhere: exit 3, both directories named, no file
     written (SC8);
   - an unreadable source path: exit 3.
2. Fails with: `emit` returns 3 and writes nothing.
3. In `emit.mjs` export `writePlan(files)` (mkdir `recursive`, then
   `writeFileSync` each; called only when `error` is `null`). In `cli.mjs`
   implement `async function emit(opts, file, ctx)`: load the engine, read the
   source, `buildProposal`, `planEmit` with `ids = opts.confirm.split(',')`
   (trimmed, empties dropped), print `canary-harley: <message>` to stderr and
   return `error.exit` on failure, else `writePlan`, print one
   `wrote <relative path>` line per file plus a line pointing to
   `harness-property-test` and `canary-promote-test`, and return 0. Share the
   engine-and-source step with `propose` through one helper so neither command
   duplicates it.

### Task 21: Syntax, ASCII and end-to-end determinism checks

**Depends on:** Task 20 | **Files:**
agents/skills/test/canary-harley-syntax.test.ts

1. Tests:
   - ASCII: every `.mjs` under `canary-harley/scripts/` matches
     `/^[\t\n\r\x20-\x7E]*$/`; assert the file count is 15 first, so an empty
     glob cannot pass;
   - TypeScript syntax (SC9): build a proposal from a source with one function
     per kind, call `planEmit` for every emittable id, assert at least 7 files,
     and for each run `ts.transpileModule` with `reportDiagnostics: true` and
     `module: ts.ModuleKind.ESNext` (import `ts` from `typescript`, already a
     devDependency) and expect zero diagnostics;
   - Python syntax (SC9): the same for a Python source; write the files to
     `root` and run ONE `spawnSync('python3', ['-c', SCRIPT, ...paths])` with
     `timeout: 20000`, where `SCRIPT` imports `ast` and `sys` and calls
     `ast.parse(open(p).read())` for each path in `sys.argv[1:]`; expect status
     0; when `python3` is missing, fail if `process.env.CI` is set to anything
     but `''`, `0` or `false`, otherwise `ctx.skip()` after a `console.warn`
     naming what was not verified;
   - every emitted file, both languages, contains its seed constant and passes
     it to the framework, and no Hypothesis file lacks `database=None` or
     `deadline=None`;
   - spawned determinism (SC2): run the real `cli.mjs` twice with
     `spawnSync(process.execPath, argv)`, `argv` being the cli path then
     `propose FILE --root ROOT --json`, and expect identical stdout and exit 0;
     then `emit` one id into two different temp roots and expect identical file
     bytes.
2. Fails with: any defect the unit tests missed; if all pass at first run, break
   one emitter line locally to see the transpile check fire, then restore it.
3. No production change expected. Fix what the checks find in the owning module,
   with a unit test added to that module's test file first.

**Checkpoint commit (group 5):**
`feat(harley): canary-harley emit behind a confirmation gate (#616)`

### Task 22: SKILL.md and the skills README

**Depends on:** Task 20 | **Files:**
agents/skills/claude-code/canary-harley/SKILL.md, agents/skills/README.md |
**Category:** integration | **Skills:** `harness-property-test` (reference)

1. Before editing, to have a green starting point, run from `ts/`:

   ```bash
   npx vitest run test/plugin-skills.test.ts \
     test/public-docs-first-run.test.ts test/doc-links.test.ts
   ```

2. Write `SKILL.md`. Frontmatter: `name: canary-harley`, a `description` that
   says it proposes ranked invariants from signatures and writes seeded
   fast-check or Hypothesis tests only for confirmed candidates,
   `cli: scripts/cli.mjs`, `requires: [node>=20]`. Sections:
   - `# Canary Harley`: the two steps with a human between them;
   - `## What this is not`: the boundary (parsers, serializers, encoders,
     validators; CRUD and UI skipped by name), the table against `canary-cry`
     and `canary-edge-case-discovery`, and model-based offline sync as a named
     example that this skill does not build;
   - `## Quick start`: `canary skills run canary-harley -- --help`, a `propose`
     line and an `emit` line, in `bash` fences;
   - `## PROPOSE`: flags, what the list contains, `heuristic` scores and tiers,
     `emittable` and `blocked`;
   - `## CONFIRM (human only)`: the agent presents the ranked list and stops; it
     never supplies `--confirm` itself; a confirmation stops matching when a
     signature changes;
   - `## EMIT`: flags, the output directory rule, the fixed recorded seed,
     `database=None` and `deadline=None`, overwrite refusal;
   - `## Exit codes`: a table with rows 0, 2 and 3;
   - `## Hand-off`: `harness-property-test` for conventions, shrinking and
     arbitrary design (do not restate them), `canary-promote-test` for
     promotion;
   - `## Limits`: unresolved types, async, methods, generics, overloads, untyped
     JavaScript, the 20-function cap, NaN excluded, `Buffer`.
3. `agents/skills/README.md`: tree count `(38)` to `(39)`; add
   `│   ├── canary-harley/` after `canary-generate-test/`; add a description
   bullet in the test-authoring group next to `canary-edge-case-discovery`
   (bundled executable skill, `scripts/cli.mjs`); add `canary-harley` to the
   alphabetical `cli:` list near line 329.
4. `npx prettier --write` both files; `npx --yes markdownlint-cli@0.50.1` on
   both; `node scripts/check_doc_fences.mjs`; re-run step 1 and
   `cd agents/skills && npx vitest run test/skill-cli-conformance.test.ts`.
5. `harness validate`.

### Task 23: Guide, guide index and knowledge note

**Depends on:** Task 22 | **Files:** docs/guides/property-test-generation.md,
docs/guides/index.md, docs/knowledge/gates/proposed-invariant.md | **Category:**
integration

1. Record the docs-coverage starting point:
   `harness check-docs --json --min-coverage 0 > "$TMPDIR/harley-docs.json"` and
   note documented / scanned. With 15 new scripts and no links it would read
   about 140 / 532 = 26.3%, below the 26.73 floor.
2. Guide `docs/guides/property-test-generation.md`: title
   `# canary-harley — property test generation`; sections Propose, Confirm,
   Emit, Candidate kinds (the seven-row table with when each legitimately
   fails), Exit codes, Seeds (fixed and recorded; `--seed`; NaN excluded),
   Boundary and non-goals (offline-sync named as out of scope), and a
   `## Module map` with one markdown link per script, 15 in all, each of the
   form
   `[types.mjs](../../agents/skills/claude-code/canary-harley/scripts/types.mjs)`
   with a one-line role. Link the spec and `harness-property-test` by name.
3. `docs/guides/index.md`: add
   `### [Property Test Generation Guide](./property-test-generation.md)` with a
   two-sentence description and a `**Best for:**` line, after the Incident to
   Regression Test entry.
4. `docs/knowledge/gates/proposed-invariant.md`: frontmatter
   `type: business_rule`, `domain: gates`, `source: authored`, `related:` the
   spec and `docs/knowledge/gates/evidence-brief.md`; body states the two rules
   (a proposed invariant becomes a test only after a human confirms it;
   generated property tests carry a fixed, recorded seed) and why.
5. `npx prettier --write` the three files; markdownlint each;
   `cd ts && npx vitest run test/doc-links.test.ts`. Re-run step 1's command and
   confirm all 15 scripts are in `documented` and the ratio is at or above the
   starting ratio.
6. `harness validate`.

### Task 24: Changelog, roadmap and local gates

**Depends on:** Task 23 | **Files:** CHANGELOG.md, docs/roadmap.md |
**Category:** integration

1. `CHANGELOG.md`: under `## [Unreleased]` add `### Added` (if absent) with one
   bullet in the house style: bold lead naming the skill and `(#616)`, then what
   `propose` and `emit` do, the confirmation gate, and the fixed seed.
2. `docs/roadmap.md`, `canary-harley` row: set `**Plan:**` to
   `docs/changes/616-canary-harley/plans/2026-11-27-canary-harley-plan.md`.
   Leave `Status: planned`; the merge flips it. Never run
   `harness roadmap sync --apply`.
3. `npx prettier --write` both; markdownlint both.
4. Gates. Each must report a non-zero count of what it checked.
   - from `ts/`: `npm run build`, `npm run typecheck`, `npm run format:check`,
     `npm test`;
   - from `agents/skills/`: `npm run typecheck`, `npm run format:check`,
     `npm test`; in the coverage table every `canary-harley/scripts/*.mjs` row
     is at or above 90 lines / functions / statements and 85 branches; add tests
     for any row below (never an exclusion);
   - from the root:

     ```bash
     node agents/skills/claude-code/canary-blackhawk/scripts/cli.mjs \
       ts/test agents/skills/test --strict
     node agents/skills/claude-code/canary-savant/scripts/cli.mjs \
       ts/test agents/skills/test --strict
     node scripts/rehearse.mjs
     harness validate
     harness check-deps
     ```

5. Any failure, related or not, is fixed or filed as an issue before moving on.

### Task 25: CI ratchets against the merge base

**Depends on:** Task 24 | **Files:** none (measurement only) | **Category:**
integration

Run each ratchet the way `.github/workflows/harness-quality.yml` and
`harness.yml` do. `BASE` is
`/private/tmp/claude-501/-Users-bs-Github-canary/8440812d-6183-4961-8c60-ceb3d4a8cda4/scratchpad/lane-616/base`;
`OUT` is its parent directory. `VER` is `harness --version | tail -n 1`
(expected 14.1.1, the version the baselines record).

1. Create the base worktree and run the four ratchets from the worktree root
   (`ROOT=/Users/bs/Github/canary-616`):

   ```bash
   git -C "$ROOT" worktree add --detach "$BASE" ea020e5e

   # Docs coverage
   harness check-docs --json --min-coverage 0 > "$OUT/docs.json" || true
   (cd "$BASE" && harness check-docs --json --min-coverage 0) \
     > "$OUT/docs-base.json" || true
   node scripts/docs-ratchet.mjs --report "$OUT/docs.json" \
     --cli-version "$VER" --base-report "$OUT/docs-base.json" \
     --base-baseline "$BASE/.harness/docs-coverage-baseline.json"

   # Entropy
   harness cleanup --findings-json > "$OUT/entropy.txt" || true
   (cd "$BASE" && harness cleanup --findings-json) \
     > "$OUT/entropy-base.txt" || true
   node scripts/entropy-ratchet.mjs --report "$OUT/entropy.txt" \
     --cli-version "$VER" --base-report "$OUT/entropy-base.txt" \
     --base-baseline "$BASE/.harness/entropy-baseline.json"

   # Performance
   harness check-perf > "$OUT/perf.txt" 2>&1 || true
   (cd "$BASE" && harness check-perf) > "$OUT/perf-base.txt" 2>&1 || true
   node scripts/perf-ratchet.mjs --report "$OUT/perf.txt" \
     --cli-version "$VER" --report-root "$ROOT" \
     --base-report-root "$BASE" --base-report "$OUT/perf-base.txt" \
     --base-baseline "$BASE/.harness/perf-baseline.json"
   grep -n "by count" "$OUT/perf.txt"

   # Architecture
   harness check-arch --json > "$OUT/arch.json" || true
   node scripts/arch-verdict.mjs "$OUT/arch.json"
   ```

   Run each ratchet as its own command and read its exit code directly, never
   after a pipe.

2. Docs: every `canary-harley` script is in `documented`.
3. Entropy: a dead export it names in `canary-harley` is unexported; a file it
   calls unreachable means an import or the entry-point row is wrong.
4. Perf: a `by count` hit means the delta fell back to counts and the result is
   not trusted. Fix any function the ratchet names in code (split it), never by
   allowance.
5. Arch: `newViolations` and `regressions` must both be empty.
6. Every ratchet must exit 0. Exit 3 is an abstention and counts as not
   verified: report it, do not read it as a pass. If a ratchet is red for a
   reason that only a baseline, allowance or ceiling edit would clear, STOP and
   report it; do not edit those files.
7. `git -C "$ROOT" worktree remove --force "$BASE"` and confirm with
   `git worktree list`. Confirm `git status --short` shows no change under
   `.harness/arch/` or to any `.harness/*-baseline.json`, and no
   `package-lock.json` change.

**Checkpoint commit (groups 6 and 7):**
`docs(harley): skill, guide, changelog and roadmap for canary-harley (#616)`

## Traceability

| Truth (SC) | Tasks               |
| ---------- | ------------------- |
| 1          | 9, 11, 12, 16       |
| 2          | 9, 11, 13, 16, 21   |
| 3          | 4, 5, 9, 16, 17, 19 |
| 4          | 15                  |
| 5          | 18, 19, 20, 21      |
| 6          | 9, 19, 20           |
| 7          | 8, 12, 16           |
| 8          | 14, 16, 20          |
| 9          | 21                  |
| 10         | 1, 2, 24, 25        |
