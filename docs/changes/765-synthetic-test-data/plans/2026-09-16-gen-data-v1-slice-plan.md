# Plan: `canary gen-data` v1 slice (schema-first, seeded, vitest)

**Date:** 2026-09-16 | **Spec:**
`docs/changes/765-synthetic-test-data/proposal.md` (signed off; "D2 revisited"
governs) | **Tasks:** 16 | **Time:** ~70 min | **Integration Tier:** medium |
**Rigor:** standard | **Branch:** `feat/765-synthetic-test-data`

## Goal

`canary gen-data --schema <path> --framework vitest` turns a JSON Schema into a
byte-deterministic, literal-only vitest fixture module (`build<Name>()` plus
`<name>Cases`) with an honest field denominator, abstaining (exit 3) instead of
guessing when nothing resolves, and refusing to write output that its own
blackhawk/savant self-check flags.

This PR is spec implementation steps 2 + 3, re-ordered by "D2 revisited": the
**explicit schema** is the only shape source in this slice.

## Out of scope (this PR)

| Deferred item                                                           | Spec step | Why not here                                            |
| ----------------------------------------------------------------------- | --------- | ------------------------------------------------------- |
| Python `ast` extractor + pytest emitter (criterion 10 pytest)           | 5         | Separate PR; `--framework pytest` exits 2 in this slice |
| `canary-edge-case-discovery --format json` + case planner (criterion 8) | 4         | Separate PR; no `--cases` flag in this slice            |
| TS compiler-API source (`file#symbol` target)                           | D2 rev.   | Opt-in, version-gated; deferred by the spike            |
| zod schema-module source                                                | D2 rev.   | JSON Schema only; zod needs module loading (code exec)  |
| ADRs for D2 / D7                                                        | 6         | Step 6 PR                                               |
| MCP tool `canary__generate_fixtures`, skill/agent guidance              | 7         | Later spec                                              |
| `FixtureScanner` duplicate-factory warning                              | —         | Not required by any criterion in this slice (YAGNI)     |
| Criterion 11 (leak gate) as a dedicated test                            | —         | Covered by CI leak gate over the corpus; no new test    |

## Observable Truths (Acceptance Criteria)

Numbers in brackets are spec success criteria.

1. **[4, 6] Abstention.** If every field of the schema is unresolved, then
   `canary gen-data --schema s.json --framework vitest` shall exit 3, write no
   file under `--out`, and print every unresolved path with its reason.
2. **[6] No guessed shapes.** If a schema property has no `type` (`{}` or
   `true`), a `$ref`, or an unsupported type construct, then the extractor shall
   return `{ kind: 'unresolved', reason, typeText }` for it, and the emitted
   builder shall throw
   `gen-data: <path> is unresolved (<reason>); pass it via overrides` when that
   field is not supplied in `overrides`.
3. **[5] Partial disclosure.** When some but not all fields resolve, the command
   shall exit 0 and print `N/M fields resolved` and every unresolved path in
   human output, and `fieldsTotal`, `fieldsResolved`, `unresolved[]` in `--json`
   output.
4. **[1] Determinism.** When run twice with the same schema and seed, the system
   shall write byte-identical files (no timestamps, no absolute paths).
5. **[2] Seed sensitivity.** When `--seed` changes, at least one emitted
   non-boundary string or number literal shall differ.
6. **[9] SOUND-003 closure.** When a resolved field is `type: number` (not
   `integer`), the emitted cases shall include at least one non-integer value
   for it.
7. **[7] Detector clean.** For each of >= 5 corpus schemas, running the real
   `canary-blackhawk` and `canary-savant` CLIs
   (`node .../scripts/cli.mjs --json <file>`) over the emitted file shall report
   0 findings.
8. **[3] Shape fidelity.** The emitted default for the synthetic `Order` schema
   (`id: string`, `total: number`, `lines: OrderLine[]`, `coupon?: string`)
   shall type-check against a hand-written `interface Order` under the
   TypeScript compiler with `strict` + `exactOptionalPropertyTypes`.
9. **Exit codes.** Bad `--seed`, unknown `--framework`, missing/unparseable
   schema file, or a schema root that is not `type: "object"` shall exit 2;
   `--framework pytest` shall exit 2 with `not yet supported in this slice`.
   Self-check findings shall exit 1 and write no file.
10. **Categories.** Every successful run shall report `categoriesCovered`
    (subset of `boundary`, `locale-timezone`, `unexpected-shape`) and
    `notCovered` = `race`, `partial-network`, `accessibility`, each with reason
    `not data-expressible`; emitted cases shall be capped at 50 with
    `casesTruncated` reporting how many were dropped.
11. Gates from `ts/`: `npm run build`, `npm run typecheck`,
    `npm run format:check`, `npm test` pass; `harness validate` and
    `harness check-deps` pass; perf and entropy ratchets show a delta of +0
    against the merge base.

## Uncertainties

- [ASSUMPTION] **Self-check can import the skill scanners in-process.**
  `agents/skills/claude-code/canary-blackhawk/scripts/scanner.mjs` and
  `canary-savant/scripts/scanner.mjs` both export `scanText(text, file)`
  (blackhawk `scanner.mjs:170`, savant `scanner.mjs:300`). They sit outside
  `ts/src` (`rootDir: src`), so a static import does not compile; a **runtime
  dynamic `import()`** of a path built from `bundledSkillsDirFrom`
  (`ts/src/core/skill-registry.ts:97`) works in source, `ts/dist`, and the
  published package (skills ship since #757). If the skill files are absent the
  self-check cannot run — see Concern C1 for the exit code.
- [ASSUMPTION] **Field denominator = leaf fields.** `fieldsTotal` counts every
  non-object node reachable through object properties; array item leaves count
  once with path `lines[].sku`; an object-typed field counts its leaves, not
  itself. Root must be `type: "object"`.
- [ASSUMPTION] **JSON Schema subset.** Resolved: `string` (+`minLength`,
  `maxLength`, `enum`, `format: date-time|date` -> `date`), `integer`, `number`
  (+`minimum`, `maximum`), `boolean`, `array` (+`items` object form), `object`
  (+`properties`, `required`), `anyOf`/`oneOf` -> `union`. Unresolved with a
  named reason: missing `type`, `$ref`, type arrays (`["string","null"]`),
  `allOf`, `not`, `if/then/else`, `patternProperties`/`additionalProperties`
  schemas, tuple `items` arrays. No `null` ShapeNode kind exists in the spec, so
  nullability is unresolved rather than guessed.
- [ASSUMPTION] **Name derivation.** Fixture name = schema `title` if it is an
  identifier-ish string, else the file basename minus `.schema.json`/`.json`,
  PascalCased (`Order`) / camelCased (`order`). No `--name` flag (spec has
  none). Output: `<out>/<camel>.fixtures.ts`, default
  `--out tests/generated/fixtures` relative to cwd.
- [ASSUMPTION] Emitted cases are `{ name, category, value: unknown }` because
  unexpected-shape values deliberately violate the type.
- [DEFERRABLE] Exact placeholder string format (`synthetic-<field>-<hex>`) and
  the fixed locale/timezone literal list; finalize in Task 5.
- [DEFERRABLE] Whether consumers mutate `<name>Cases[i].value` (would be an
  SV001 in _their_ test, not in ours). Not addressed in this slice.

## Concerns / forks the spec does not settle

- **C1 (fork) — self-check unavailable.** The spec's exit table has no row for
  "the blackhawk/savant scanners could not be loaded". This plan treats it as an
  **abstention: exit 3, no file written, reason printed** — writing a file whose
  detector-clean guarantee was never checked would be a silent pass.
  Alternative: exit 1 (treat as generator failure). Needs human confirmation;
  Task 9 is marked `[checkpoint:decision]`.
- **C2 (fork) — non-object schema root.** The spec's factory
  `build<Name>(overrides?)` presumes an object. This plan exits 2 (usage) for a
  non-object root. Alternative: exit 3 (abstain). Recorded as an assumption; low
  stakes.
- **C3 (premise correction) — perf "paydown elsewhere".** Since #850/#853 the
  perf ratchet compares finding **identities** against the merge base
  (`scripts/lib/perf-delta.mjs`), so paying down an unrelated function does NOT
  offset a new violation in gen-data code. The absolute ceiling is
  `maxViolations: 233` vs `measuredCount: 215` (headroom exists). So the plan
  is: introduce zero new identities by construction (small functions, lookup
  tables instead of `switch`, files well under length thresholds); Task 14
  measures, and any new identity is fixed in code. A `deltaAllowances` entry
  requires human approval and is not planned.
- **C4 — arch `module-size` aggregate.** Every feature adding LOC regresses the
  repo-wide `module-size` aggregate (see
  `.harness/arch/allowances/feat-957-test-inventory-producer.json`). An
  allowance file will be needed; the value must be measured with
  `harness check-arch --json` after rebasing, not estimated. Also `ts/src/core`
  already holds 49 files against `maxFiles: 12`, and `ts/src` itself is at the
  limit (#957 moved its CLI into a subdir for this reason) — so new code goes in
  `ts/src/core/gen-data/` (core layer) and `ts/src/gen-data/gen-data-cli.ts`
  (cli layer via `ts/src/**/*cli*.ts`).
- **C5 — entropy at 144/145.** Every new dead export is a delta finding. Export
  only what another module or test imports; verify with
  `harness cleanup --findings-json` in Task 14. `entropy.entryPoints`
  (harness.config.json ~line 169) and `performance.entryPoints` (~line 265) get
  the new CLI module only if the analyzer flags it unreachable (it is imported
  by `ts/src/cli.ts`, which is itself declared); both arrays are kept in sync.
- **C6 — skeleton not human-approved.** Standard rigor with 16 tasks calls for a
  skeleton approval gate; this plan was produced by a subagent with no human in
  the loop, so the skeleton below is recorded but unapproved.

## File Map

```text
CREATE ts/src/core/gen-data/shape.ts              ShapeNode type, FieldTally, tallyFields()
CREATE ts/src/core/gen-data/json-schema.ts        extractJsonSchema(): unknown -> ShapeNode
CREATE ts/src/core/gen-data/prng.ts               mulberry32, DEFAULT_SEED=765, parseSeed()
CREATE ts/src/core/gen-data/strategies.ts         defaultValue(), leafCases() per category
CREATE ts/src/core/gen-data/generate.ts           generateFixtureSet(): FixtureSet (cap 50)
CREATE ts/src/core/gen-data/emit-vitest.ts        emitVitest(): string (literal-only)
CREATE ts/src/core/gen-data/self-check.ts         selfCheck(): loads blackhawk+savant scanText
CREATE ts/src/gen-data/gen-data-cli.ts            buildGenDataCommand(deps)
MODIFY ts/src/cli.ts                              import + program.addCommand(buildGenDataCommand(deps))
MODIFY ts/src/main-deps.ts                        genDataSelfCheck injectable (default selfCheck)
CREATE ts/test/gen-data-shape.test.ts
CREATE ts/test/gen-data-json-schema.test.ts
CREATE ts/test/gen-data-prng.test.ts
CREATE ts/test/gen-data-generate.test.ts
CREATE ts/test/gen-data-emit-vitest.test.ts
CREATE ts/test/gen-data-self-check.test.ts
CREATE ts/test/gen-data-cli.test.ts
CREATE ts/test/gen-data-corpus.test.ts
CREATE ts/test/fixtures/gen-data/order.schema.json
CREATE ts/test/fixtures/gen-data/profile.schema.json
CREATE ts/test/fixtures/gen-data/ledger-entry.schema.json
CREATE ts/test/fixtures/gen-data/shipment.schema.json
CREATE ts/test/fixtures/gen-data/partial.schema.json
CREATE ts/test/fixtures/gen-data/unresolvable.schema.json
MODIFY harness.config.json                        entropy.entryPoints + performance.entryPoints (only if flagged)
CREATE .harness/arch/allowances/feat-765-gen-data-v1.json  (measured module-size)
MODIFY AGENTS.md                                  command list + core-module map entry
```

`ts/src/core/gen-data/` = 7 files (under `maxFiles: 12`), target < 900 LOC.

## Skeleton

1. Shape model + JSON Schema extractor, abstention rules first (~3 tasks, ~14
   min)
2. Seeded PRNG + strategies + generator (~3 tasks, ~14 min)
3. vitest emitter + self-check (~3 tasks, ~13 min)
4. CLI command + registration + exit codes (~3 tasks, ~14 min)
5. Corpus + determinism/type-fidelity/detector proofs (~1 task, ~5 min)
6. Ratchets + docs (~3 tasks, ~10 min)

_Skeleton approved: no (subagent run; see C6)._

## Tasks

All commands run from
`/Users/bs/Github/canary/.claude/worktrees/agent-a2aad24d25f819f16/ts` unless
stated. Per task: `npx vitest run <test>` for red/green, then
`npx prettier --write <touched ts files>` and `harness validate` (from repo
root). Never `--no-verify`. Commit subjects are Conventional Commits, no
co-author trailer.

### Task 1: ShapeNode type and field tally (denominator)

**Depends on:** none | **Files:** `ts/src/core/gen-data/shape.ts`,
`ts/test/gen-data-shape.test.ts`

1. Write `ts/test/gen-data-shape.test.ts`:

   ```ts
   import { describe, expect, it } from 'vitest';
   import { tallyFields, type ShapeNode } from '../src/core/gen-data/shape.js';

   const obj = (
     fields: Record<string, ShapeNode>,
     optional: string[] = [],
   ): ShapeNode => ({
     kind: 'object',
     fields: Object.fromEntries(
       Object.entries(fields).map(([k, node]) => [
         k,
         { node, optional: optional.includes(k) },
       ]),
     ),
   });

   describe('tallyFields', () => {
     it('counts leaves, not containers, and lists every unresolved path with its reason', () => {
       const root = obj({
         id: { kind: 'string' },
         meta: { kind: 'unresolved', reason: 'no type', typeText: '{}' },
         lines: {
           kind: 'array',
           item: obj({
             sku: { kind: 'string' },
             qty: { kind: 'number', integer: true },
           }),
         },
       });
       expect(tallyFields(root, 'order')).toEqual({
         fieldsTotal: 4,
         fieldsResolved: 3,
         unresolved: [{ path: 'order.meta', reason: 'no type' }],
       });
     });

     it('reports zero resolved when every leaf is unresolved', () => {
       const root = obj({
         a: {
           kind: 'unresolved',
           reason: '$ref not resolved in v1',
           typeText: '#/x',
         },
       });
       expect(tallyFields(root, 'x').fieldsResolved).toBe(0);
     });
   });
   ```

2. Run `npx vitest run test/gen-data-shape.test.ts` — fails (module missing).
3. Create `ts/src/core/gen-data/shape.ts`:

   ```ts
   /**
    * The canary term for an extracted value shape (#765). Anything a shape
    * source cannot resolve is an `unresolved` node carrying its reason -- never
    * a guessed shape (spec D7, criterion 6).
    */
   export type ShapeNode =
     | {
         kind: 'string';
         minLength?: number;
         maxLength?: number;
         enum?: string[];
       }
     | { kind: 'number'; integer: boolean; min?: number; max?: number }
     | { kind: 'boolean' }
     | { kind: 'date' }
     | { kind: 'array'; item: ShapeNode }
     | {
         kind: 'object';
         fields: Record<string, { node: ShapeNode; optional: boolean }>;
       }
     | { kind: 'union'; members: ShapeNode[] }
     | { kind: 'unresolved'; reason: string; typeText: string };

   export interface UnresolvedField {
     path: string;
     reason: string;
   }
   export interface FieldTally {
     fieldsTotal: number;
     fieldsResolved: number;
     unresolved: UnresolvedField[];
   }

   /** Leaf denominator: objects count their leaves; array items use `[]`. */
   export function tallyFields(node: ShapeNode, path: string): FieldTally {
     const tally: FieldTally = {
       fieldsTotal: 0,
       fieldsResolved: 0,
       unresolved: [],
     };
     walk(node, path, tally);
     return tally;
   }

   function walk(node: ShapeNode, path: string, t: FieldTally): void {
     if (node.kind === 'object') {
       for (const [k, f] of Object.entries(node.fields))
         walk(f.node, `${path}.${k}`, t);
       return;
     }
     if (node.kind === 'array') return walk(node.item, `${path}[]`, t);
     t.fieldsTotal += 1;
     if (node.kind === 'unresolved')
       t.unresolved.push({ path, reason: node.reason });
     else t.fieldsResolved += 1;
   }
   ```

4. Run the test — passes.
   `npx prettier --write src/core/gen-data/shape.ts test/gen-data-shape.test.ts`.
5. `harness validate` (repo root).
6. Commit: `feat(gen-data): ShapeNode model and leaf-field denominator (#765)`

### Task 2: JSON Schema extractor — abstention rules first

**Depends on:** Task 1 | **Files:** `ts/src/core/gen-data/json-schema.ts`,
`ts/test/gen-data-json-schema.test.ts`

1. Write `ts/test/gen-data-json-schema.test.ts` with the **unresolved** cases
   only:

   ```ts
   import { describe, expect, it } from 'vitest';
   import { extractJsonSchema } from '../src/core/gen-data/json-schema.js';

   const reasonOf = (s: unknown) => {
     const n = extractJsonSchema(s);
     return n.kind === 'unresolved' ? n.reason : `resolved:${n.kind}`;
   };

   describe('extractJsonSchema abstains, never guesses', () => {
     it.each([
       [{}, 'no type declared'],
       [true, 'no type declared'],
       [{ $ref: '#/$defs/Money' }, '$ref is not resolved in this slice'],
       [
         { type: ['string', 'null'] },
         'type arrays are not supported in this slice',
       ],
       [
         { allOf: [{ type: 'string' }] },
         'allOf is not supported in this slice',
       ],
       [
         { type: 'array', items: [{ type: 'string' }] },
         'tuple items are not supported in this slice',
       ],
       [{ type: 'array' }, 'array has no items schema'],
       [{ type: 'null' }, 'type "null" has no ShapeNode kind'],
       [{ type: 'wat' }, 'unknown type "wat"'],
     ])('%j -> unresolved (%s)', (schema, reason) => {
       expect(reasonOf(schema)).toBe(reason);
     });

     it('keeps the original schema text for the report', () => {
       const n = extractJsonSchema({ $ref: '#/$defs/Money' });
       expect(n).toMatchObject({
         kind: 'unresolved',
         typeText: '{"$ref":"#/$defs/Money"}',
       });
     });
   });
   ```

2. Run `npx vitest run test/gen-data-json-schema.test.ts` — fails.
3. Create `ts/src/core/gen-data/json-schema.ts`. Structure it as a table of
   guards checked in order, then a `KIND_READERS` lookup keyed by `type`, so no
   function carries a large branch count (perf ratchet, C3):

   ```ts
   /** JSON Schema -> ShapeNode, the primary shape source in v1 ("D2 revisited"). */
   import type { ShapeNode } from './shape.js';

   type Schema = Record<string, unknown>;
   const unresolved = (reason: string, s: unknown): ShapeNode => ({
     kind: 'unresolved',
     reason,
     typeText: JSON.stringify(s) ?? String(s),
   });

   /** Constructs this slice refuses to interpret, in check order. */
   const REFUSALS: ReadonlyArray<[(s: Schema) => boolean, string]> = [
     [(s) => '$ref' in s, '$ref is not resolved in this slice'],
     [
       (s) => Array.isArray(s.type),
       'type arrays are not supported in this slice',
     ],
     [(s) => 'allOf' in s, 'allOf is not supported in this slice'],
     [
       (s) => 'not' in s || 'if' in s,
       'conditional schemas are not supported in this slice',
     ],
   ];

   export function extractJsonSchema(schema: unknown): ShapeNode {
     if (
       typeof schema !== 'object' ||
       schema === null ||
       Array.isArray(schema)
     ) {
       return unresolved('no type declared', schema);
     }
     const s = schema as Schema;
     for (const [hit, reason] of REFUSALS)
       if (hit(s)) return unresolved(reason, s);
     const union = s.anyOf ?? s.oneOf;
     if (Array.isArray(union))
       return { kind: 'union', members: union.map(extractJsonSchema) };
     if (s.type === undefined) return unresolved('no type declared', s);
     const read = KIND_READERS[String(s.type)];
     return read ? read(s) : unresolved(TYPE_REASON(s.type), s);
   }

   const TYPE_REASON = (t: unknown) =>
     t === 'null'
       ? 'type "null" has no ShapeNode kind'
       : `unknown type "${String(t)}"`;

   const num = (v: unknown) => (typeof v === 'number' ? v : undefined);

   const KIND_READERS: Record<string, (s: Schema) => ShapeNode> = {
     string: readString,
     integer: (s) => readNumber(s, true),
     number: (s) => readNumber(s, false),
     boolean: () => ({ kind: 'boolean' }),
     array: readArray,
     object: readObject,
   };
   ```

   Implement `readString`, `readNumber`, `readArray`, `readObject` with
   `exactOptionalPropertyTypes`-safe spreads (only set a key when defined):
   - `readString`: `format` `date-time`|`date` -> `{kind:'date'}`; else
     `{kind:'string', ...minLength, ...maxLength, ...enum}` (enum only if every
     member is a string).
   - `readNumber(s, integer)`:
     `{kind:'number', integer, ...(min from minimum), ...(max from maximum)}`.
   - `readArray`: `items` undefined ->
     `unresolved('array has no items schema')`; `Array.isArray(items)` ->
     `unresolved('tuple items are not supported in this slice')`; else
     `{kind:'array', item: extractJsonSchema(items)}`.
   - `readObject`: `properties` absent -> `{kind:'object', fields:{}}`; required
     = string entries of `s.required`; each property ->
     `{ node: extractJsonSchema(v), optional: !required.includes(k) }`. Only
     `extractJsonSchema` is exported (C5).

4. Run the test — passes.
5. Prettier on the two files; `harness validate`.
6. Commit:
   `feat(gen-data): JSON Schema extractor abstains on unsupported constructs (#765)`

### Task 3: JSON Schema extractor — resolved shapes

**Depends on:** Task 2 | **Files:** `ts/test/gen-data-json-schema.test.ts` (and
fixes in `ts/src/core/gen-data/json-schema.ts` only if red)

1. Append to the test file:

   ```ts
   describe('extractJsonSchema resolves the supported subset', () => {
     it('reads the Order shape with required/optional and nested arrays', () => {
       const n = extractJsonSchema({
         type: 'object',
         required: ['id', 'total', 'lines'],
         properties: {
           id: { type: 'string', minLength: 1 },
           total: { type: 'number', minimum: 0 },
           lines: {
             type: 'array',
             items: {
               type: 'object',
               required: ['sku'],
               properties: {
                 sku: { type: 'string' },
                 qty: { type: 'integer', minimum: 1, maximum: 99 },
               },
             },
           },
           coupon: { type: 'string' },
           placedAt: { type: 'string', format: 'date-time' },
           status: { type: 'string', enum: ['open', 'paid'] },
           gift: { type: 'boolean' },
           ref: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
         },
       });
       expect(n).toEqual({
         kind: 'object',
         fields: {
           id: { node: { kind: 'string', minLength: 1 }, optional: false },
           total: {
             node: { kind: 'number', integer: false, min: 0 },
             optional: false,
           },
           lines: {
             node: {
               kind: 'array',
               item: {
                 kind: 'object',
                 fields: {
                   sku: { node: { kind: 'string' }, optional: false },
                   qty: {
                     node: { kind: 'number', integer: true, min: 1, max: 99 },
                     optional: true,
                   },
                 },
               },
             },
             optional: false,
           },
           coupon: { node: { kind: 'string' }, optional: true },
           placedAt: { node: { kind: 'date' }, optional: true },
           status: {
             node: { kind: 'string', enum: ['open', 'paid'] },
             optional: true,
           },
           gift: { node: { kind: 'boolean' }, optional: true },
           ref: {
             node: {
               kind: 'union',
               members: [{ kind: 'string' }, { kind: 'number', integer: true }],
             },
             optional: true,
           },
         },
       });
     });
   });
   ```

2. Run `npx vitest run test/gen-data-json-schema.test.ts` — expect pass if Task
   2's readers are complete; if red, fix the reader named in the diff. (This
   task exists so resolved-shape behavior is proven separately from the
   abstention rules; if it passes first time, record that in the commit body.)
3. Prettier; `harness validate`.
4. Commit: `test(gen-data): pin resolved JSON Schema shapes (#765)`

### Task 4: Seeded PRNG and seed parsing

**Depends on:** none | **Files:** `ts/src/core/gen-data/prng.ts`,
`ts/test/gen-data-prng.test.ts`

1. Write `ts/test/gen-data-prng.test.ts`:

   ```ts
   import { describe, expect, it } from 'vitest';
   import {
     DEFAULT_SEED,
     mulberry32,
     parseSeed,
   } from '../src/core/gen-data/prng.js';

   describe('mulberry32', () => {
     it('is a pure function of the seed', () => {
       const a = mulberry32(765),
         b = mulberry32(765);
       const seqA = [a(), a(), a()],
         seqB = [b(), b(), b()];
       expect(seqA).toEqual(seqB);
       expect(seqA.every((x) => x >= 0 && x < 1)).toBe(true);
     });
     it('differs across seeds', () => {
       expect(mulberry32(765)()).not.toBe(mulberry32(766)());
     });
   });

   describe('parseSeed', () => {
     it('defaults to the fixed constant 765, never a clock', () => {
       expect(DEFAULT_SEED).toBe(765);
       expect(parseSeed(undefined)).toEqual({ ok: true, seed: 765 });
     });
     it.each(['12', '0', '-3'])('accepts integer %s', (v) => {
       expect(parseSeed(v)).toEqual({ ok: true, seed: Number(v) });
     });
     it.each(['1.5', 'abc', '', '9007199254740993'])('rejects %j', (v) => {
       expect(parseSeed(v).ok).toBe(false);
     });
   });
   ```

2. Run — fails.
3. Create `ts/src/core/gen-data/prng.ts`:

   ```ts
   /**
    * Seeded PRNG for emit-time generation (#765 D4). Values are baked into the
    * emitted file as literals, so the test itself never touches a PRNG.
    */
   export const DEFAULT_SEED = 765;

   /** mulberry32: small, well-known 32-bit generator; returns [0, 1). */
   export function mulberry32(seed: number): () => number {
     let a = seed >>> 0;
     return () => {
       a = (a + 0x6d2b79f5) >>> 0;
       let t = a;
       t = Math.imul(t ^ (t >>> 15), t | 1);
       t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
       return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
     };
   }

   export type SeedResult =
     { ok: true; seed: number } | { ok: false; reason: string };

   /** Mirrors savant's `--seed`: non-integer or unsafe integer is a usage error. */
   export function parseSeed(raw: string | undefined): SeedResult {
     if (raw === undefined) return { ok: true, seed: DEFAULT_SEED };
     const n = /^-?\d+$/.test(raw) ? Number(raw) : Number.NaN;
     return Number.isSafeInteger(n)
       ? { ok: true, seed: n }
       : {
           ok: false,
           reason: `--seed must be a safe integer, got ${JSON.stringify(raw)}`,
         };
   }
   ```

4. Run — passes. Prettier; `harness validate`.
5. Commit: `feat(gen-data): mulberry32 PRNG with fixed default seed 765 (#765)`

### Task 5: Value strategies per leaf and category

**Depends on:** Task 1, Task 4 | **Files:**
`ts/src/core/gen-data/strategies.ts`, `ts/test/gen-data-generate.test.ts`

1. Write `ts/test/gen-data-generate.test.ts` (strategy section):

   ```ts
   import { describe, expect, it } from 'vitest';
   import { mulberry32 } from '../src/core/gen-data/prng.js';
   import { defaultValue, leafCases } from '../src/core/gen-data/strategies.js';

   describe('leafCases', () => {
     it('boundary for a non-integer number includes a fractional value (SOUND-003)', () => {
       const cases = leafCases(
         { kind: 'number', integer: false, min: 0, max: 100 },
         'total',
       );
       const boundary = cases
         .filter((c) => c.category === 'boundary')
         .map((c) => c.value);
       expect(boundary).toEqual(
         expect.arrayContaining([
           0,
           -1,
           1,
           Number.MAX_SAFE_INTEGER,
           Number.MIN_SAFE_INTEGER,
           101,
         ]),
       );
       expect(
         boundary.some((v) => typeof v === 'number' && !Number.isInteger(v)),
       ).toBe(true);
     });
     it('an integer field gets no fractional boundary', () => {
       const cases = leafCases({ kind: 'number', integer: true }, 'qty');
       expect(
         cases.every(
           (c) => typeof c.value !== 'number' || Number.isInteger(c.value),
         ),
       ).toBe(true);
     });
     it('strings get empty, whitespace, maxLength+1 and non-ASCII/RTL/emoji literals', () => {
       const values = leafCases({ kind: 'string', maxLength: 3 }, 'code').map(
         (c) => c.value,
       );
       expect(values).toEqual(expect.arrayContaining(['', '   ', 'xxxx']));
       expect(
         values.some((v) => typeof v === 'string' && /[֐-׿]/.test(v)),
       ).toBe(true);
     });
     it('dates are fixed ISO-8601 UTC literals with an explicit Z, incl. leap-day', () => {
       const values = leafCases({ kind: 'date' }, 'placedAt').map(
         (c) => c.value,
       );
       expect(values).toContain('2024-02-29T23:59:59Z');
       expect(
         values
           .filter((v) => typeof v === 'string')
           .every((v) => String(v).endsWith('Z') || !/^\d{4}-/.test(String(v))),
       ).toBe(true);
     });
     it('unexpected-shape offers wrong primitive type and null', () => {
       const cats = leafCases({ kind: 'string' }, 'id').filter(
         (c) => c.category === 'unexpected-shape',
       );
       expect(cats.map((c) => c.value)).toEqual(
         expect.arrayContaining([null, 0]),
       );
     });
   });

   describe('defaultValue', () => {
     it('is seed-dependent for strings and non-boundary numbers', () => {
       const s = { kind: 'string' } as const;
       expect(defaultValue(s, 'id', mulberry32(765))).not.toBe(
         defaultValue(s, 'id', mulberry32(1)),
       );
     });
     it('respects min/max and integer-ness', () => {
       const v = defaultValue(
         { kind: 'number', integer: true, min: 1, max: 99 },
         'qty',
         mulberry32(765),
       );
       expect(Number.isInteger(v)).toBe(true);
       expect(v as number).toBeGreaterThanOrEqual(1);
       expect(v as number).toBeLessThanOrEqual(99);
     });
   });
   ```

2. Run `npx vitest run test/gen-data-generate.test.ts` — fails.
3. Create `ts/src/core/gen-data/strategies.ts`, lookup-table style
   (`DEFAULTS: Record<Kind, fn>`, `CASES: Record<Kind, fn>`), one small function
   per kind:

   ```ts
   /** Per-leaf value strategies for the data-expressible categories (#765). */
   import type { ShapeNode } from './shape.js';

   export type Category = 'boundary' | 'locale-timezone' | 'unexpected-shape';
   export interface LeafCase {
     category: Category;
     label: string;
     value: unknown;
   }
   type Rng = () => number;
   type Leaf = Exclude<ShapeNode, { kind: 'object' | 'array' | 'unresolved' }>;

   const hex = (rng: Rng) =>
     Math.floor(rng() * 0xffffff)
       .toString(16)
       .padStart(6, '0');
   const BASE_DAY_MS = Date.UTC(2024, 0, 1); // fixed epoch, not a clock read
   export const LOCALE_STRINGS = ['café über', 'שלום', '\u{1F426} canary'];
   export const TZ_LITERALS = [
     '2024-02-29T23:59:59Z',
     '2024-03-10T07:00:00Z',
     '1970-01-01T00:00:00Z',
   ];

   const DEFAULTS: Record<
     Leaf['kind'],
     (n: never, field: string, rng: Rng) => unknown
   > = {/* ... */};
   ```

   Rules (write each as its own function):
   - string default: enum -> `enum[floor(rng()*len)]`; else
     `synthetic-${field}-${hex(rng)}`, padded with `x` to `minLength`, cut to
     `maxLength`.
   - number default: `lo = min ?? 1`, `hi = max ?? 1000`; integer ->
     `lo + floor(rng()*(hi-lo+1))`; non-integer ->
     `Math.round((lo + rng()*(hi-lo)) * 100) / 100`.
   - boolean default: `rng() < 0.5`. date default:
     `new Date(BASE_DAY_MS + floor(rng()*366)*86400000).toISOString()` (computed
     at emit time, emitted as a string literal; ends in `Z`).
   - union default: default of `members[0]`.
   - number boundary: `0, -1, 1, MAX_SAFE_INTEGER, MIN_SAFE_INTEGER`, plus
     `min-1` / `max+1` when defined, plus `0.5` when `integer === false`.
   - string boundary: `''`, `'   '`, `'x'.repeat(maxLength+1)` when defined;
     enum -> add `'not-in-enum'` as unexpected-shape.
   - locale-timezone: strings -> `LOCALE_STRINGS`; dates -> `TZ_LITERALS`.
   - unexpected-shape for every leaf: `null`, and a wrong primitive (`0` for
     string/date/boolean, `'0'` for number).
   - `label` = `${category}: ${field} = ${JSON.stringify(value)}` truncated to
     60 chars. Export only `defaultValue`, `leafCases`, `LeafCase`, `Category`
     (constants stay module-private unless a test imports them; drop the
     `export` on `LOCALE_STRINGS`/`TZ_LITERALS` if unused after Task 6).

4. Run — passes. Prettier; `harness validate`.
5. Commit:
   `feat(gen-data): boundary, locale-timezone and unexpected-shape strategies (#765)`

### Task 6: Generator — FixtureSet, cap 50, notCovered

**Depends on:** Task 5 | **Files:** `ts/src/core/gen-data/generate.ts`,
`ts/test/gen-data-generate.test.ts`

1. Append to `ts/test/gen-data-generate.test.ts`:

   ```ts
   import { generateFixtureSet } from '../src/core/gen-data/generate.js';
   import { extractJsonSchema } from '../src/core/gen-data/json-schema.js';

   const ORDER = extractJsonSchema({
     type: 'object',
     required: ['id', 'total'],
     properties: {
       id: { type: 'string' },
       total: { type: 'number' },
       meta: {},
     },
   });

   describe('generateFixtureSet', () => {
     it('is a pure function of (shape, seed)', () => {
       expect(generateFixtureSet(ORDER, 'order', 765)).toEqual(
         generateFixtureSet(ORDER, 'order', 765),
       );
     });
     it('omits unresolved fields from the default and discloses them', () => {
       const set = generateFixtureSet(ORDER, 'order', 765);
       expect(set.defaultValue).not.toHaveProperty('meta');
       expect(set.unresolved).toEqual([
         { path: 'order.meta', reason: 'no type declared' },
       ]);
       expect([set.fieldsResolved, set.fieldsTotal]).toEqual([2, 3]);
     });
     it('never plans a case against an unresolved path', () => {
       const set = generateFixtureSet(ORDER, 'order', 765);
       expect(
         set.cases.some(
           (c) => c.name.includes('meta') && c.category !== 'unexpected-shape',
         ),
       ).toBe(false);
     });
     it('adds missing-required and extra-field whole-object cases', () => {
       const names = generateFixtureSet(ORDER, 'order', 765).cases.map(
         (c) => c.name,
       );
       expect(names).toContain('unexpected-shape: missing required id');
       expect(names).toContain('unexpected-shape: extra field');
     });
     it('reports race, partial-network and accessibility as notCovered', () => {
       expect(generateFixtureSet(ORDER, 'order', 765).notCovered).toEqual([
         { category: 'race', reason: 'not data-expressible' },
         { category: 'partial-network', reason: 'not data-expressible' },
         { category: 'accessibility', reason: 'not data-expressible' },
       ]);
     });
     it('caps cases at 50 and reports the truncation', () => {
       const wide = extractJsonSchema({
         type: 'object',
         properties: Object.fromEntries(
           Array.from({ length: 20 }, (_, i) => [`f${i}`, { type: 'number' }]),
         ),
       });
       const set = generateFixtureSet(wide, 'wide', 765);
       expect(set.cases).toHaveLength(50);
       expect(set.casesTruncated).toBeGreaterThan(0);
     });
     it('includes a fractional value for a non-integer number (criterion 9)', () => {
       const vals = generateFixtureSet(ORDER, 'order', 765)
         .cases.filter((c) => c.name.includes('total'))
         .map((c) => (c.value as { total?: unknown }).total);
       expect(
         vals.some((v) => typeof v === 'number' && !Number.isInteger(v)),
       ).toBe(true);
     });
   });
   ```

2. Run — fails.
3. Create `ts/src/core/gen-data/generate.ts`:
   - `export const CASE_CAP = 50;`
   - `FixtureCase { name: string; category: Category; value: unknown }`
   - `FixtureSet extends FieldTally` adding: `name`, `seed`,
     `defaultValue: Record<string, unknown>`, `cases: FixtureCase[]`,
     `casesTruncated`, `categoriesCovered: Category[]`,
     `notCovered: {category, reason}[]`.
   - `generateFixtureSet(root, name, seed)`: one `rng = mulberry32(seed)`; build
     default by walking the object depth-first in `Object.keys` order (arrays ->
     one-item array; unresolved -> key omitted); cases: for each resolved leaf
     path (same order) take `leafCases`, and for each produce
     `value = withPath(structuredClone(defaultValue), path, leafValue)`, name =
     leaf label; then whole-object cases: one `missing required <k>` per
     required top-level resolved key (delete it), one `extra field`
     (`__unexpected: true`), one `over-nested` (`{ value: default }`). Keep full
     list order deterministic, then `cases.slice(0, CASE_CAP)` and
     `casesTruncated = total - kept`. `categoriesCovered` = distinct categories
     in the kept cases, in fixed order
     `boundary, locale-timezone, unexpected-shape`. `notCovered` is a module
     constant.
   - Helpers `walkDefault`, `resolvedLeafPaths`, `withPath` are private, each <
     25 lines.
   - Leaf paths inside arrays write into item index 0 (`lines[0].sku`).
4. Run — passes. Also rerun Task 1-5 tests:
   `npx vitest run test/gen-data-*.test.ts`.
5. Prettier; `harness validate`.
6. Commit:
   `feat(gen-data): deterministic FixtureSet generator with 50-case cap (#765)`

### Task 7: vitest emitter — literal-only builder and cases

**Depends on:** Task 6 | **Files:** `ts/src/core/gen-data/emit-vitest.ts`,
`ts/test/gen-data-emit-vitest.test.ts`

1. Write `ts/test/gen-data-emit-vitest.test.ts`:

   ```ts
   import { describe, expect, it } from 'vitest';
   import { emitVitest } from '../src/core/gen-data/emit-vitest.js';
   import { generateFixtureSet } from '../src/core/gen-data/generate.js';
   import { extractJsonSchema } from '../src/core/gen-data/json-schema.js';

   const shape = extractJsonSchema({
     type: 'object',
     required: ['id', 'meta'],
     properties: {
       id: { type: 'string' },
       total: { type: 'number' },
       meta: {},
     },
   });
   const text = () =>
     emitVitest(
       shape,
       generateFixtureSet(shape, 'order', 765),
       'fixtures/order.schema.json',
     );

   describe('emitVitest', () => {
     it('exports buildOrder, OrderFixture and orderCases', () => {
       expect(text()).toMatch(/export interface OrderFixture \{/);
       expect(text()).toMatch(
         /export function buildOrder\(\s*overrides: Partial<OrderFixture> = \{\},?\s*\): OrderFixture/,
       );
       expect(text()).toMatch(/export const orderCases: ReadonlyArray<\{/);
     });
     it('holds literals only: no PRNG, clock, or runtime generator call', () => {
       expect(text()).not.toMatch(
         /Math\.random|Date\.now|new Date\(|mulberry32|faker/,
       );
     });
     it('builds a fresh object per call (no shared module-level default)', () => {
       expect(text()).toMatch(
         /export function buildOrder[\s\S]*const base[^=]*= \{/,
       );
     });
     it('an unresolved field becomes a throwing overrides-required placeholder', () => {
       expect(text()).toContain('  meta: unknown;');
       expect(text()).toContain(
         "throw new Error('gen-data: order.meta is unresolved (no type declared); pass it via overrides');",
       );
     });
     it('header names seed and source, with no timestamp', () => {
       expect(text().split('\n')[0]).toBe(
         '// Generated by canary gen-data (seed 765) from fixtures/order.schema.json. Regenerate; do not edit.',
       );
     });
     it('is byte-identical across runs', () => {
       expect(text()).toBe(text());
     });
   });
   ```

2. Run — fails.
3. Create `ts/src/core/gen-data/emit-vitest.ts` exporting only
   `emitVitest(shape: ShapeNode, set: FixtureSet, source: string): string` and
   `fixtureNames(name: string): { pascal: string; camel: string }`. Private
   helpers:
   - `renderType(node, indent)`: string -> `string` (enum -> `'a' | 'b'`),
     number -> `number`, boolean -> `boolean`, date -> `string`, array ->
     `Array<...>`, object -> `{ k: T; k2?: T }`, union -> `A | B`, unresolved ->
     `unknown`. Keys rendered via `renderKey` (bare if `/^[A-Za-z_$][\w$]*$/`,
     else `JSON.stringify`).
   - `renderLiteral(value, indent)`: `JSON.stringify` for strings and finite
     numbers, `true/false`, `null`, arrays and objects rendered multi-line with
     two-space indent; `Number.MAX_SAFE_INTEGER` prints as digits (literal, not
     an identifier).
   - Output template (exact order):

     ```ts
     // Generated by canary gen-data (seed ${seed}) from ${source}. Regenerate; do not edit.
     // Fields resolved: ${fieldsResolved}/${fieldsTotal}.${unresolvedLines}

     export interface ${Pascal}Fixture ${renderType(shape)}

     export function build${Pascal}(
       overrides: Partial<${Pascal}Fixture> = {},
     ): ${Pascal}Fixture {
     ${guards}  const base: Omit<${Pascal}Fixture, ${unresolvedKeysUnion or never}> = ${renderLiteral(defaultValue)};
       return { ...base, ...overrides } as ${Pascal}Fixture;
     }

     export const ${camel}Cases: ReadonlyArray<{
       name: string;
       category: string;
       value: unknown;
     }> = [
       { name: ..., category: ..., value: ... },
     ];
     ```

     `guards` = one line per **top-level** unresolved key: (shown as emitted):

     ```ts
     if (overrides.meta === undefined) {
       throw new Error(
         'gen-data: order.meta is unresolved (no type declared); pass it via overrides',
       );
     }
     ```

     (message single-quoted; escape `'` and `\` in reasons). Nested unresolved
     paths are disclosed in the header comment and typed `unknown` but not
     guarded (assumption; guard only where `overrides` can supply it).

   - Unresolved `// - path: reason` lines follow the "Fields resolved" line.
4. Run — passes. Prettier; `harness validate`.
5. Commit:
   `feat(gen-data): vitest emitter with literal-only builders and cases (#765)`

### Task 8: Emitted default type-checks against an interface (criterion 3)

**Depends on:** Task 7 | **Files:** `ts/test/gen-data-emit-vitest.test.ts`

1. Append a test that runs the real TypeScript compiler (devDependency,
   test-only — nothing in `ts/src` imports `typescript`):

   ```ts
   import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
   import { tmpdir } from 'node:os';
   import { join } from 'node:path';
   import ts from 'typescript';

   it('the Order default type-checks against interface Order (criterion 3)', () => {
     const order = extractJsonSchema({
       type: 'object',
       required: ['id', 'total', 'lines'],
       properties: {
         id: { type: 'string' },
         total: { type: 'number' },
         coupon: { type: 'string' },
         lines: {
           type: 'array',
           items: {
             type: 'object',
             required: ['sku', 'qty'],
             properties: { sku: { type: 'string' }, qty: { type: 'integer' } },
           },
         },
       },
     });
     const dir = mkdtempSync(join(tmpdir(), 'gen-data-tsc-'));
     try {
       writeFileSync(
         join(dir, 'order.fixtures.ts'),
         emitVitest(
           order,
           generateFixtureSet(order, 'order', 765),
           'order.schema.json',
         ),
       );
       writeFileSync(
         join(dir, 'check.ts'),
         [
           "import { buildOrder } from './order.fixtures.js';",
           'interface OrderLine { sku: string; qty: number }',
           'interface Order { id: string; total: number; lines: OrderLine[]; coupon?: string }',
           'export const o: Order = buildOrder();',
           "export const p: Order = buildOrder({ coupon: 'SYNTH10' });",
         ].join('\n'),
       );
       const program = ts.createProgram([join(dir, 'check.ts')], {
         strict: true,
         exactOptionalPropertyTypes: true,
         noEmit: true,
         module: ts.ModuleKind.NodeNext,
         moduleResolution: ts.ModuleResolutionKind.NodeNext,
         target: ts.ScriptTarget.ES2022,
         skipLibCheck: true,
         types: [],
       });
       const diags = ts
         .getPreEmitDiagnostics(program)
         .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
       expect(diags).toEqual([]);
     } finally {
       rmSync(dir, { recursive: true, force: true });
     }
   });
   ```

2. Run `npx vitest run test/gen-data-emit-vitest.test.ts`. If red, fix
   `renderType`/`renderLiteral` in `emit-vitest.ts` (common cause: array item
   type or optional key rendering). If `import ts from 'typescript'` fails under
   `tsconfig.check.json`, use `import * as ts from 'typescript'`.
3. Prettier; `harness validate`.
4. Commit:
   `test(gen-data): emitted Order default type-checks under strict tsc (#765)`

### Task 9: Self-check loads blackhawk and savant in-process

`[checkpoint:decision]` — confirm C1 (scanners unavailable => exit 3) before
Task 11 wires it.

**Depends on:** Task 7 | **Files:** `ts/src/core/gen-data/self-check.ts`,
`ts/test/gen-data-self-check.test.ts`

1. Write `ts/test/gen-data-self-check.test.ts`:

   ```ts
   import { mkdtempSync, rmSync } from 'node:fs';
   import { tmpdir } from 'node:os';
   import { join } from 'node:path';
   import { describe, expect, it } from 'vitest';
   import { selfCheck } from '../src/core/gen-data/self-check.js';

   describe('selfCheck', () => {
     it('runs both real detectors and reports 0 findings on clean text', async () => {
       const r = await selfCheck(
         'export function buildX() {\n  return { a: 1 };\n}\n',
         'x.fixtures.ts',
       );
       expect(r).toEqual({
         status: 'ran',
         detectors: ['canary-blackhawk', 'canary-savant'],
         findings: [],
       });
     });
     it('catches a planted clock read (proves the detector is live, not a zero)', async () => {
       const r = await selfCheck(
         'export const at = Date.now();\n',
         'x.fixtures.ts',
       );
       expect(r.status).toBe('ran');
       expect(r.status === 'ran' && r.findings.map((f) => f.ruleId)).toEqual(
         expect.arrayContaining([expect.stringMatching(/^BH001/)]),
       );
     });
     it('reports unavailable, never a pass, when the skills dir is missing', async () => {
       const empty = mkdtempSync(join(tmpdir(), 'no-skills-'));
       try {
         const r = await selfCheck(
           'export const a = 1;\n',
           'x.fixtures.ts',
           empty,
         );
         expect(r.status).toBe('unavailable');
       } finally {
         rmSync(empty, { recursive: true, force: true });
       }
     });
   });
   ```

2. Run — fails.
3. Create `ts/src/core/gen-data/self-check.ts`:

   ```ts
   /**
    * Run canary-blackhawk and canary-savant over emitted fixture text before it
    * is written (#765). The scanners live in agents/skills (outside ts/src's
    * rootDir), so they are loaded with a runtime dynamic import from the
    * bundled skills dir -- the same packaging contract skill-registry pins
    * (#757). If they cannot be loaded the result is `unavailable`: a check
    * that did not run is an abstention, never a clean result.
    */
   import { existsSync } from 'node:fs';
   import { dirname, join } from 'node:path';
   import { fileURLToPath, pathToFileURL } from 'node:url';
   import { bundledSkillsDirFrom } from '../skill-registry.js';

   export interface DetectorFinding {
     detector: string;
     ruleId: string;
     line: number;
     snippet: string;
   }
   export type SelfCheckResult =
     | { status: 'ran'; detectors: string[]; findings: DetectorFinding[] }
     | { status: 'unavailable'; reason: string };

   const DETECTORS = ['canary-blackhawk', 'canary-savant'] as const;
   type ScanText = (
     text: string,
     file: string,
   ) => Array<{ ruleId: string; line: number; snippet: string }>;

   // This module sits one directory below core/, so hand skill-registry the
   // core/ directory to keep its "three levels up" contract intact.
   const defaultSkillsDir = () =>
     bundledSkillsDirFrom(join(dirname(fileURLToPath(import.meta.url)), '..'));

   async function loadScan(
     skillsDir: string,
     skill: string,
   ): Promise<ScanText | string> {
     const file = join(
       skillsDir,
       'claude-code',
       skill,
       'scripts',
       'scanner.mjs',
     );
     if (!existsSync(file)) return `${skill} scanner not found at ${file}`;
     const mod: unknown = await import(pathToFileURL(file).href);
     const fn = (mod as { scanText?: unknown }).scanText;
     return typeof fn === 'function'
       ? (fn as ScanText)
       : `${skill} scanner exports no scanText`;
   }

   export async function selfCheck(
     text: string,
     file: string,
     skillsDir = defaultSkillsDir(),
   ): Promise<SelfCheckResult> {
     const findings: DetectorFinding[] = [];
     for (const detector of DETECTORS) {
       const scan = await loadScan(skillsDir, detector);
       if (typeof scan === 'string')
         return { status: 'unavailable', reason: scan };
       for (const f of scan(text, file))
         findings.push({
           detector,
           ruleId: f.ruleId,
           line: f.line,
           snippet: f.snippet,
         });
     }
     return { status: 'ran', detectors: [...DETECTORS], findings };
   }
   ```

   Note the savant scanner may select rules by file extension; pass the real
   output basename (`order.fixtures.ts`). If `skill-registry.js` import from
   `core/gen-data` trips `check-deps` (same layer, should pass), stop and
   report.

4. Run — passes. `harness check-deps` (repo root) — passes.
5. Prettier; `harness validate`.
6. Commit: `feat(gen-data): in-process blackhawk and savant self-check (#765)`

### Task 10: CLI — usage errors (exit 2) first

**Depends on:** Task 4 | **Files:** `ts/src/gen-data/gen-data-cli.ts`,
`ts/test/gen-data-cli.test.ts`, `ts/src/cli.ts`

1. Write `ts/test/gen-data-cli.test.ts` using the house testkit
   (`ts/test/canary-cli-testkit.ts:46` `invokeCanary`, `mkTmp`, `rmTmp`):

   ```ts
   import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
   import { join } from 'node:path';
   import { afterEach, beforeEach, describe, expect, it } from 'vitest';
   import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

   const ORDER = {
     title: 'Order',
     type: 'object',
     required: ['id'],
     properties: { id: { type: 'string' }, total: { type: 'number' } },
   };

   describe('canary gen-data usage errors (exit 2)', () => {
     let root: string;
     let schema: string;
     beforeEach(() => {
       root = mkTmp();
       schema = join(root, 'order.schema.json');
       writeFileSync(schema, JSON.stringify(ORDER));
     });
     afterEach(() => rmTmp(root));

     const run = (...extra: string[]) =>
       invokeCanary([
         'gen-data',
         '--schema',
         schema,
         '--out',
         join(root, 'out'),
         ...extra,
       ]);

     it.each([
       [
         ['--framework', 'vitest', '--seed', '1.5'],
         /--seed must be a safe integer/,
       ],
       [['--framework', 'jest'], /unknown framework "jest"/],
       [['--framework', 'pytest'], /pytest is not yet supported in this slice/],
     ])('%j exits 2', async (args, msg) => {
       const res = await run(...args);
       expect(res.code).toBe(2);
       expect(res.stdout + res.stderr).toMatch(msg);
       expect(existsSync(join(root, 'out'))).toBe(false);
     });

     it('a missing schema file exits 2', async () => {
       const res = await invokeCanary([
         'gen-data',
         '--schema',
         join(root, 'nope.json'),
         '--framework',
         'vitest',
       ]);
       expect(res.code).toBe(2);
       expect(res.stdout + res.stderr).toMatch(/cannot read schema/);
     });

     it('unparseable JSON exits 2', async () => {
       writeFileSync(schema, '{ not json');
       expect((await run('--framework', 'vitest')).code).toBe(2);
     });

     it('a non-object root exits 2', async () => {
       writeFileSync(schema, JSON.stringify({ type: 'string' }));
       const res = await run('--framework', 'vitest');
       expect(res.code).toBe(2);
       expect(res.stdout + res.stderr).toMatch(
         /schema root must be type "object"/,
       );
     });
   });
   ```

2. Run `npx vitest run test/gen-data-cli.test.ts` — fails (unknown command).
3. Create `ts/src/gen-data/gen-data-cli.ts` with
   `buildGenDataCommand(deps: MainDeps): Command` mirroring
   `ts/src/inventory/inventory-cli.ts`:
   - Options: `--schema <path>` (required via `.requiredOption`),
     `--framework <name>` (required), `--seed <n>`, `--out <dir>` (default
     `tests/generated/fixtures`), `--json`.
   - `normalizeUsageExit` applied as other subcommands do (see header of
     `ts/src/cli.ts` and `cli-common.ts`).
   - `validateUsage(opts)` returns `{ seed }` or throws `CliExitError(2)` after
     `deps.out(message)`; framework table:
     `FRAMEWORKS = { vitest: 'ok', pytest: '<not-yet message>' }` where the
     message is `pytest is not yet supported in this slice (spec step 5)`;
     anything else -> `unknown framework "<x>"; expected vitest`.
   - `readSchema(path)` -> parsed JSON or exit 2
     `cannot read schema <path>: <err>`.
   - Root check: `extractJsonSchema(json).kind !== 'object'` -> exit 2
     `schema root must be type "object" in this slice`.
   - For now the action stops after validation (Task 11 adds the pipeline).
4. In `ts/src/cli.ts` add
   `import { buildGenDataCommand } from './gen-data/gen-data-cli.js';` next to
   the inventory import (line ~47) and
   `program.addCommand(buildGenDataCommand(deps));` next to
   `program.addCommand(buildInventoryCommand(deps));` (line ~383).
5. Run — passes. `harness check-deps` from repo root.
6. Prettier on the three files; `harness validate`.
7. Commit:
   `feat(gen-data): register canary gen-data with usage-error exits (#765)`

### Task 11: CLI — abstention, partial disclosure, write, self-check exits

**Depends on:** Task 6, Task 7, Task 9, Task 10 | **Files:**
`ts/src/gen-data/gen-data-cli.ts`, `ts/src/main-deps.ts`,
`ts/test/gen-data-cli.test.ts`

1. Append to `ts/test/gen-data-cli.test.ts`:

   ```ts
   import { readFileSync } from 'node:fs';
   import { EXIT_ABSTAINED } from '../src/core/gen-data/../gate-result.js';

   describe('canary gen-data outcomes', () => {
     let root: string;
     beforeEach(() => {
       root = mkTmp();
     });
     afterEach(() => rmTmp(root));
     const write = (name: string, s: unknown) => {
       const p = join(root, name);
       writeFileSync(p, JSON.stringify(s));
       return p;
     };
     const out = () => join(root, 'out');

     it('abstains with exit 3, writes nothing, and names every unresolved path (criteria 4, 6)', async () => {
       const p = write('blob.schema.json', {
         type: 'object',
         properties: { a: {}, b: { $ref: '#/x' } },
       });
       const res = await invokeCanary([
         'gen-data',
         '--schema',
         p,
         '--framework',
         'vitest',
         '--out',
         out(),
       ]);
       expect(res.code).toBe(EXIT_ABSTAINED);
       expect(existsSync(out())).toBe(false);
       expect(res.stdout).toMatch(/blob\.a: no type declared/);
       expect(res.stdout).toMatch(
         /blob\.b: \$ref is not resolved in this slice/,
       );
     });

     it('partial resolution exits 0 and discloses N/M in human output (criterion 5)', async () => {
       const p = write('order.schema.json', {
         title: 'Order',
         type: 'object',
         properties: { id: { type: 'string' }, meta: {} },
       });
       const res = await invokeCanary([
         'gen-data',
         '--schema',
         p,
         '--framework',
         'vitest',
         '--out',
         out(),
       ]);
       expect(res.code).toBe(0);
       expect(res.stdout).toMatch(/1\/2 fields resolved/);
       expect(res.stdout).toMatch(/order\.meta: no type declared/);
       expect(readFileSync(join(out(), 'order.fixtures.ts'), 'utf-8')).toMatch(
         /export function buildOrder/,
       );
     });

     it('--json carries the spec report shape (criterion 5)', async () => {
       const p = write('order.schema.json', {
         title: 'Order',
         type: 'object',
         properties: { id: { type: 'string' }, meta: {} },
       });
       const res = await invokeCanary([
         'gen-data',
         '--schema',
         p,
         '--framework',
         'vitest',
         '--out',
         out(),
         '--json',
         '--seed',
         '7',
       ]);
       const report = JSON.parse(res.stdout);
       expect(report).toMatchObject({
         seed: 7,
         fieldsTotal: 2,
         fieldsResolved: 1,
         unresolved: [{ path: 'order.meta', reason: 'no type declared' }],
         categoriesCovered: expect.arrayContaining(['boundary']),
         notCovered: expect.arrayContaining([
           { category: 'race', reason: 'not data-expressible' },
         ]),
         selfCheck: { status: 'ran', findings: 0 },
       });
       expect(report.casesEmitted).toBeGreaterThan(0);
       expect(report.output).toBe(join(out(), 'order.fixtures.ts'));
     });

     it('self-check findings exit 1 and write nothing', async () => {
       const p = write('order.schema.json', {
         title: 'Order',
         type: 'object',
         properties: { id: { type: 'string' } },
       });
       const res = await invokeCanary(
         ['gen-data', '--schema', p, '--framework', 'vitest', '--out', out()],
         {
           deps: {
             genDataSelfCheck: async () => ({
               status: 'ran',
               detectors: ['canary-blackhawk'],
               findings: [
                 {
                   detector: 'canary-blackhawk',
                   ruleId: 'BH001',
                   line: 3,
                   snippet: 'Date.now()',
                 },
               ],
             }),
           },
         },
       );
       expect(res.code).toBe(1);
       expect(existsSync(out())).toBe(false);
       expect(res.stdout).toMatch(/BH001/);
     });

     it('self-check unavailable abstains (exit 3) and writes nothing (C1)', async () => {
       const p = write('order.schema.json', {
         title: 'Order',
         type: 'object',
         properties: { id: { type: 'string' } },
       });
       const res = await invokeCanary(
         ['gen-data', '--schema', p, '--framework', 'vitest', '--out', out()],
         {
           deps: {
             genDataSelfCheck: async () => ({
               status: 'unavailable',
               reason: 'canary-savant scanner not found',
             }),
           },
         },
       );
       expect(res.code).toBe(3);
       expect(existsSync(out())).toBe(false);
     });
   });
   ```

   Fix the `EXIT_ABSTAINED` import to `'../src/core/gate-result.js'`. The
   `deps.genDataSelfCheck` injection is added to `MainDeps` in Step 3b so the
   exit-1 and exit-3 self-check paths are testable without planting a defect in
   the emitter.

2. Run — fails.
3. Implement in `ts/src/gen-data/gen-data-cli.ts`, one small function per stage
   (`validateUsage`, `readSchema`, `abstain`, `render`, `writeOutput`):
   - a. `set = generateFixtureSet(shape, camel, seed)`; if
     `set.fieldsResolved === 0`: print
     `Abstained: 0/<M> fields resolved in <schema>; no fixture written.` then
     one `- <path>: <reason>` line (two-space indent) per unresolved, throw
     `CliExitError(EXIT_ABSTAINED)`.
   - b. `MainDeps` gets `genDataSelfCheck: typeof selfCheck` with default
     `selfCheck` in `defaultMainDeps()` (`ts/src/main-deps.ts`).
   - c. `text = emitVitest(shape, set, posixRelative(deps.cwd(), schemaPath))`;
     `check = await deps.genDataSelfCheck(text, basename(outFile))`;
     `unavailable` -> print
     `Abstained: self-check could not run (<reason>); no fixture written.` exit
     3; findings > 0 -> print each `<detector> <ruleId> line <n>: <snippet>` and
     `generator bug: emitted fixtures failed self-check; nothing written.`,
     exit 1.
   - d. `mkdirSync(outDir, {recursive:true})`, `writeFileSync(outFile, text)`.
   - e. `--json` -> `jsonIndent2({...})` with keys `target` (schemaRel), `seed`,
     `fieldsTotal`, `fieldsResolved`, `unresolved`, `casesEmitted`,
     `casesTruncated`, `categoriesCovered`, `notCovered`,
     `selfCheck: { status: 'ran', detectors, findings: 0 }`, `output`; human ->
     a `Wrote <outFile>: N/M fields resolved, K case(s) [cats]` line, then
     `not covered: race, partial-network, accessibility (not data-expressible).`,
     plus unresolved lines and a truncation line when `casesTruncated > 0`.
   - The action is async: use `.action(async (...) => { await run(...) })`;
     confirm `invokeCanary` awaits `parseAsync` (it is `async`; check
     `canary-cli-testkit.ts` for `parseAsync` and use the same pattern as any
     existing async command, e.g. `history`).
4. Run `npx vitest run test/gen-data-cli.test.ts` — passes.
5. `harness check-deps`; prettier; `harness validate`.
6. Commit:
   `feat(gen-data): abstain, disclose, self-check and write fixtures (#765)`

### Task 12: Seed sensitivity and byte determinism via the CLI (criteria 1, 2)

**Depends on:** Task 11 | **Files:** `ts/test/gen-data-cli.test.ts`

1. Append:

   ```ts
   describe('canary gen-data determinism', () => {
     let root: string;
     beforeEach(() => {
       root = mkTmp();
     });
     afterEach(() => rmTmp(root));
     const gen = async (seed: string, outDir: string) => {
       const p = join(root, 'order.schema.json');
       writeFileSync(
         p,
         JSON.stringify({
           title: 'Order',
           type: 'object',
           properties: { id: { type: 'string' }, total: { type: 'number' } },
         }),
       );
       const res = await invokeCanary(
         [
           'gen-data',
           '--schema',
           p,
           '--framework',
           'vitest',
           '--seed',
           seed,
           '--out',
           join(root, outDir),
         ],
         { cwd: root },
       );
       expect(res.code).toBe(0);
       return readFileSync(join(root, outDir, 'order.fixtures.ts'), 'utf-8');
     };

     it('same seed twice -> byte-identical files (criterion 1)', async () => {
       expect(await gen('765', 'a')).toBe(await gen('765', 'b'));
     });
     it('different seed -> a non-boundary literal changes (criterion 2)', async () => {
       const a = await gen('765', 'a');
       const b = await gen('766', 'b');
       expect(a).not.toBe(b);
       const defaultBlock = (t: string) =>
         t.slice(t.indexOf('const base'), t.indexOf('return {'));
       expect(defaultBlock(a)).not.toBe(defaultBlock(b));
     });
   });
   ```

2. Run — expected pass; if the file embeds an absolute path, fix `posixRelative`
   in Task 11's code.
3. Prettier; `harness validate`.
4. Commit:
   `test(gen-data): byte determinism and seed sensitivity via the CLI (#765)`

### Task 13: Synthetic schema corpus is detector-clean (criterion 7)

**Depends on:** Task 11 | **Files:** `ts/test/fixtures/gen-data/*.schema.json`
(6 files), `ts/test/gen-data-corpus.test.ts`

1. Create the corpus. All names/values synthetic (no people, emails, domains,
   company names — leak gate):
   - `order.schema.json`: the criterion-3 Order (id, total number, lines[] of
     {sku, qty integer 1..99}, coupon optional, placedAt date-time).
   - `profile.schema.json`: handle string minLength 3 maxLength 20, tier enum
     `["free","pro"]`, active boolean, joinedOn `format: date`, tags array of
     string.
   - `ledger-entry.schema.json`: amountCents integer, rate number 0..1, currency
     enum `["XTS"]` (ISO test currency), memo string maxLength 40.
   - `shipment.schema.json`: nested `origin`/`dest` objects {zone string, lat
     number, lon number}, parcels array of {weightKg number}.
   - `partial.schema.json`: id string, payload `{}`, link
     `{ "$ref": "#/$defs/L" }`, note `{ "type": ["string","null"] }`.
   - `unresolvable.schema.json`: every property untyped or `$ref` (abstention).
2. Write `ts/test/gen-data-corpus.test.ts`:

   ```ts
   import { spawnSync } from 'node:child_process';
   import { readdirSync, readFileSync } from 'node:fs';
   import { join, resolve } from 'node:path';
   import { afterAll, beforeAll, describe, expect, it } from 'vitest';
   import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

   const REPO = resolve(__dirname, '..', '..');
   const CORPUS = resolve(__dirname, 'fixtures', 'gen-data');
   const EMITTING = readdirSync(CORPUS)
     .filter(
       (f) => f.endsWith('.schema.json') && f !== 'unresolvable.schema.json',
     )
     .sort();
   const skillCli = (skill: string) =>
     join(REPO, 'agents', 'skills', 'claude-code', skill, 'scripts', 'cli.mjs');

   describe('gen-data corpus is detector-clean (criterion 7)', () => {
     let out: string;
     beforeAll(() => {
       out = mkTmp();
     });
     afterAll(() => rmTmp(out));

     it('the corpus has at least 5 emitting schemas (denominator guard)', () => {
       expect(EMITTING.length).toBeGreaterThanOrEqual(5);
     });

     it.each(EMITTING)(
       '%s emits, and blackhawk + savant CLIs report 0 findings',
       async (schema) => {
         const res = await invokeCanary([
           'gen-data',
           '--schema',
           join(CORPUS, schema),
           '--framework',
           'vitest',
           '--out',
           out,
           '--json',
         ]);
         expect(res.code).toBe(0);
         const file = JSON.parse(res.stdout).output as string;
         expect(readFileSync(file, 'utf-8').length).toBeGreaterThan(0);
         for (const skill of ['canary-blackhawk', 'canary-savant']) {
           const r = spawnSync('node', [skillCli(skill), '--json', file], {
             encoding: 'utf-8',
             timeout: 20_000,
           });
           expect(r.status, `${skill} stderr: ${r.stderr}`).toBe(0);
           const report = JSON.parse(r.stdout);
           expect(report.findings ?? report).toEqual([]);
         }
       },
     );

     it('unresolvable.schema.json abstains with exit 3', async () => {
       const res = await invokeCanary([
         'gen-data',
         '--schema',
         join(CORPUS, 'unresolvable.schema.json'),
         '--framework',
         'vitest',
         '--out',
         out,
       ]);
       expect(res.code).toBe(3);
     });
   });
   ```

   Before writing the assertion on `report`, run one skill CLI by hand to read
   its JSON shape and exit code on a clean file:
   `node ../agents/skills/claude-code/canary-blackhawk/scripts/cli.mjs --json src/core/gen-data/prng.ts`
   and adjust `report.findings` / scanned-file-count assertions to the real
   shape. Also assert the reported scanned-file count is 1 if the JSON carries
   one (a 0-file scan is an abstention, not a pass).

3. Run `npx vitest run test/gen-data-corpus.test.ts` — passes (the generator was
   built to be clean; a red here is a real generator bug — fix in
   `emit-vitest.ts`, never by suppressing a rule).
4. Prettier; `harness validate`.
5. Commit:
   `test(gen-data): five-schema corpus is blackhawk and savant clean (#765)`

### Task 14: Ratchets — entropy, perf, arch, deps (measure, then declare)

`[checkpoint:human-verify]` — show the measured deltas before committing any
allowance.

**Depends on:** Task 13 | **Files:** `harness.config.json`,
`.harness/arch/allowances/feat-765-gen-data-v1.json`

1. Full local gates from `ts/`:
   `npm run build && npm run typecheck && npm run format:check && npm test`.
   Check the tail for the test/file counts (a silent run did not run).
2. Base worktree for deltas (outside this checkout):

   ```bash
   W=/Users/bs/Github/canary/.claude/worktrees/agent-a2aad24d25f819f16
   git -C "$W" fetch origin
   git -C "$W" worktree add --detach "$TMPDIR/gen-data-base" \
     "$(git -C "$W" merge-base HEAD origin/main)"
   ```

3. Entropy (from each root):
   `harness cleanup --findings-json > <scratch>/entropy-{head,base}.json`, then
   from repo root

   ```bash
   node scripts/entropy-ratchet.mjs --report <head> --base-report <base> \
     --cli-version "$(harness --version)"
   ```

   For every new dead-export finding under `ts/src/core/gen-data/` or
   `ts/src/gen-data/`: remove the `export` (preferred). Only if the new CLI
   module itself is reported unreachable, add
   `"ts/src/gen-data/gen-data-cli.ts"` to **both** `entropy.entryPoints`
   (harness.config.json ~line 169, alphabetical near
   `ts/src/briefing/briefing-cli.ts`) and `performance.entryPoints` (~line 265).
   Never touch `maxFindings`.

4. Perf: `harness check-perf > <scratch>/perf-{head,base}.txt` in each tree,
   then

   ```bash
   node scripts/perf-ratchet.mjs --report <head> --base-report <base> \
     --report-root <head root> --base-report-root <base root> \
     --cli-version "$(harness --version)"
   ```

   Expected delta +0. Any new identity in gen-data code -> split the function or
   file (C3). A new identity in `ts/src/cli.ts`'s `createCanaryCommand`
   (function-length) would be a magnitude change on an existing identity
   (advisory since #854); if it is a NEW identity, stop and escalate — no
   `deltaAllowances` entry without human approval.

5. Arch: `harness check-arch --json > <scratch>/arch.json` after
   `git rebase origin/main`. If `module-size` regressed, create
   `.harness/arch/allowances/feat-765-gen-data-v1.json` in the exact shape of
   `feat-957-test-inventory-producer.json` (`reason`, `categories.module-size` =
   the measured number, `violationIds: []`, `createdFrom` = short origin/main
   SHA), with a reason stating the growth is the feature, that new code was
   placed in subdirectories to avoid the `ts/src` / `ts/src/core` file-count
   thresholds, and that no entropy ceiling was raised. Any `newViolations` entry
   is fixed in code, not allowed.
6. `harness check-deps` and `harness validate` from repo root.
7. Remove the base worktree: `git worktree remove "$TMPDIR/gen-data-base"`.
8. Commit:
   `chore(gen-data): declare new CLI surface to entropy/perf/arch ratchets (#765)`

### Task 15: AGENTS.md — command list and core-module map

**Depends on:** Task 11 | **Files:** `AGENTS.md` | **Category:** integration

1. In `AGENTS.md` "Entry Points" (~line 155) append `gen-data` to the command
   list: `` `ci-ready`, `inventory`, `gen-data`. ``
2. In "Core Services (`ts/src/core/`)" add after the Promotion Verdict entry:

   ```markdown
   - **Synthetic test data:** [ts/src/core/gen-data/](ts/src/core/gen-data/) —
     `canary gen-data --schema <path> --framework vitest` (#765). A JSON Schema
     becomes a `ShapeNode` tree (anything unsupported is an `unresolved` node
     with a reason, never a guess); a mulberry32 generator seeded with a fixed
     default (765) produces boundary, locale-timezone and unexpected-shape cases
     (cap 50; race, partial-network and accessibility are reported
     `notCovered`); the vitest emitter writes literal-only `build<Name>()` and
     `<name>Cases` under `tests/generated/fixtures/`, after running
     canary-blackhawk and canary-savant over its own output. Exit 3 when zero
     fields resolve or the self-check could not run; exit 1 on self-check
     findings. pytest and the TS compiler-API source are later slices.
   ```

3. From repo root: `npx prettier --write AGENTS.md`; then the docs checks the
   repo runs (`node scripts/docs-ratchet.mjs` if it has a local mode — read its
   header first) and `harness validate`.
4. Commit:
   `docs(agents): document canary gen-data and the gen-data core module (#765)`

### Task 16: Final four gates on the latest base and self-review

**Depends on:** Task 14, Task 15 | **Files:** none (verification)

1. `git fetch origin && git rebase origin/main` (worktree-local).
2. From `ts/`: `npm run build`, `npm run typecheck`, `npm run format:check`,
   `npm test` — run each separately, read each exit code directly (no pipes).
3. From repo root: `harness validate`, `harness check-deps`.
4. Smoke the built CLI:

   ```bash
   node ts/bin/canary.js gen-data --json --framework vitest \
     --schema ts/test/fixtures/gen-data/order.schema.json --out "$TMPDIR/gd"
   ```

   — exit 0, `selfCheck.status: "ran"` (proves the dist-relative skills path
   resolves, not just the source path).

5. Read the full diff (`git diff origin/main...HEAD`) as a reviewer: no
   `Math.random`/clock in emitted text, no exported symbol without an importer,
   no absolute paths in emitted files, no real-looking PII in the corpus.
6. No commit unless a fix was needed (`fix(gen-data): ...`).

## Traceability

| Observable truth         | Task(s)      |
| ------------------------ | ------------ |
| 1 Abstention [4, 6]      | 1, 2, 11, 13 |
| 2 No guessed shapes [6]  | 2, 7, 11     |
| 3 Partial disclosure [5] | 1, 6, 11     |
| 4 Determinism [1]        | 4, 6, 7, 12  |
| 5 Seed sensitivity [2]   | 4, 5, 12     |
| 6 SOUND-003 [9]          | 5, 6         |
| 7 Detector clean [7]     | 9, 13        |
| 8 Shape fidelity [3]     | 8            |
| 9 Exit codes             | 10, 11       |
| 10 Categories, cap       | 6, 11        |
| 11 Gates and ratchets    | 14, 16       |

## Parallelism

Tasks 1 and 4 have no dependencies and can run in parallel. After Task 7, Task 8
and Task 9 are independent. Task 15 can run in parallel with Tasks 12-14.
Everything else is sequential by dependency.
