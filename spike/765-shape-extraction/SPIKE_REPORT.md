# Spike report: TypeScript compiler API cost and version coupling (#765 D2)

**Status: spike complete. The result contradicts D2's mechanism, so D2 needs to
be re-opened by a human.** This report recommends; it does not re-decide the
spec. See [Verdict](#6-verdict-and-recommendation).

Refs #765. Deliverable is measurements plus this note. No engine code was
written, no dependency was added, no CLI surface and no skill were created.

## Method and environment

| Item                 | Value                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| Hardware             | Apple M4, 10 cores, 16 GiB RAM                                                                  |
| OS                   | macOS 27.0 (build 26A5425a)                                                                     |
| Node                 | v22.23.2                                                                                        |
| npm                  | 10.9.8                                                                                          |
| `typescript` in repo | 5.9.3, resolved from `ts/node_modules` (`ts/package.json` declares `^5.6.0`, **devDependency**) |
| Extra TS installs    | 5.4.5, 6.0.3, 7.0.2, installed into throwaway scratch dirs, never into this repo                |
| Base commit          | `572ac22` (`origin/main` at spike start)                                                        |
| Repo scope measured  | `ts/src`: 130 `.ts` files, 39 207 lines                                                         |

**Timing method.** One process per measurement. `measure-cold.mjs` is spawned
fresh by `run-cold.mjs` for every sample, because a second `createProgram` in
the same process reuses a warm module graph and a warm JIT and reads several
times faster — measuring in-process would have flattered the result. Each
scenario is 5 runs; tables give the median, with min/max where spread matters.

Wall time is split into **load** (`await import('typescript')`) and **work**
(build the Program, get the checker, walk one target's parameter types into a
shape tree). The Program is deliberately forced to do checker work: a TS
`Program` is lazy, so timing `createProgram` alone would understate a real shape
query.

**Memory method.** `process.resourceUsage().maxRSS`, which libuv reports in
kilobytes on macOS — a true process peak, not a heap sample.

Raw JSON for every table is in [`results/`](results/).

## 1. Cold cost of `ts.createProgram`

TS 5.9.3, `skipLibCheck: false`, imports followed. 5 runs each.

| Scenario                          | Root files | Files in Program | Load (ms) | Work (ms) | **Total median (ms)** | min–max     | **Peak RSS (MB)** |
| --------------------------------- | ---------- | ---------------- | --------- | --------- | --------------------- | ----------- | ----------------- |
| (a) one file + its imports        | 1          | 64               | 144.3     | 162.0     | **306.3**             | 304.7–343.7 | **182.5**         |
| (b) small subtree (`ts/src/core`) | 48         | 141              | 151.0     | 256.0     | **410.0**             | 396.2–422.7 | **211.3**         |
| (c) whole `ts/src`                | 130        | 391              | 146.2     | 410.1     | **552.9**             | 551.2–561.2 | **273.4**         |

Target for (a) and for the shape query in all three:
`ts/src/core/gate-result.ts#gateOutcome`.

Three things the table says that a single number would hide:

- **There is a hard floor of ~145 ms before any analysis happens.** That is
  `await import('typescript')` alone, and it is scope-independent — identical in
  every row.
- **"One file" is never one file.** A single-file target with no imports at all
  still pulls 64 files into the Program: the default lib `.d.ts` set. The
  one-file case is already 55% of the whole-repo case.
- **Scope scales gently.** 130× the root files costs 1.8× the time. The marginal
  cost of widening scope is small; the cost of turning the compiler API on at
  all is most of the bill.

## 2. Cheaper alternatives, measured

Same target, same 5-run method.

| Variant                                                   | Files in Program | Load (ms) | Work (ms) | **Total (ms)** | **RSS (MB)** |
| --------------------------------------------------------- | ---------------- | --------- | --------- | -------------- | ------------ |
| Full program (= 1a, for reference)                        | 64               | 144.3     | 162.0     | 306.3          | 182.5        |
| `createSourceFile` only — no checker, no resolution       | 1                | 145.2     | **7.4**   | **152.6**      | **108.6**    |
| Narrowed `fileNames` + `skipLibCheck: true`               | 64               | 146.7     | 162.7     | 309.5          | 184.9        |
| Narrowed `fileNames` + `skipLibCheck` + `noResolve: true` | 64               | 145.5     | 162.2     | 310.9          | 183.8        |

### What each one can and cannot resolve

Measured with `extract-shapes.mjs --all-configs` over 10 targets. "Resolves an
imported interface" is the question the spec cares about, so it is asked
directly.

| Variant           | Imported interface resolves?                                                                                 | Generic resolves? | Cost vs full       | Verdict                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------ | ----------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Full program      | **Yes**                                                                                                      | Instantiated only | baseline           | The only configuration that answers the question                                                                         |
| Parse-only        | **No** — yields the type's _name_ as text (`AdoptionInput`, `GateResult<F>`, `Flags<Base>`) and nothing else | No                | **−50%, −40% RSS** | Cheap, and blind past the first hop                                                                                      |
| `skipLibCheck`    | Yes                                                                                                          | Same as full      | **+1%**            | **Buys nothing.** Lib _checking_ was never the cost; lib _loading_ and binding is, and `skipLibCheck` does not skip that |
| `noResolve: true` | **No — and it does not say so**                                                                              | Same as full      | **+1.5%**          | **Actively dangerous**, see below                                                                                        |

**`noResolve` is the finding of this section.** It costs nothing and saves
nothing, and it silently rewrites every unresolvable import to `any`:

| Target                            | Leaves, full config | Leaves, `noResolve` | What happened                                                                 |
| --------------------------------- | ------------------- | ------------------- | ----------------------------------------------------------------------------- |
| `adoption.ts#buildAdoptionReport` | 37                  | **8**               | `input.freshness` became `any` — the whole `FreshnessReport` subtree vanished |
| `ci-ready.ts#scoreCiReady`        | 24                  | **10**              | `inputs.inventory` and `inputs.criticalAreas` became `any`                    |

The collapsed fields arrive as `{kind: 'unresolved', reason: 'type is any'}` —
byte-identical to a field the author genuinely typed `any`. A generator using
`noResolve` would report a 78%-smaller denominator as an honest one. That is the
false-green shape the repo's abstention doctrine (ADR 0009) exists to catch, so
`noResolve` is disqualified on correctness, not on cost.

`skipLibCheck` is harmless but pointless: keep it for hygiene, do not count it
as an optimisation.

## 3. Shape-extraction feasibility on real targets

Targets picked from `ts/src/core` for varied shapes. `hard-target.ts` supplies
the difficult constructs **because `ts/src/core` has none** — a grep for mapped
types (`[K in …]`), conditional types, `Omit`/`Pick`/`Partial`/`ReturnType` and
template-literal types over `ts/src` returned zero matches at the base commit.
That absence is itself a finding: this repo's own core is unusually plain, so
its abstain rate is a floor, not a representative sample of consumer code.

Full config, TS 5.9.3. "Leaves" counts primitive/terminal nodes in the extracted
`ShapeNode` tree.

| #   | Target                                                  | Why chosen                                      | Leaves | Unresolved | Extracted shape (abridged)                                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------- | ----------------------------------------------- | ------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | `core/executor.ts#shlexSplit`                           | primitive arg                                   | 1      | **0**      | `input: {kind:'string'}`                                                                                                                                                                                                                                                      |
| T2  | `core/adoption.ts#buildAdoptionReport`                  | local interface, nullable fields, imported type | 37     | 5          | `object{shapes: array<string>, overlayPath: union[string,null], freshness: union[null, object{…}], companyJsonPresent: boolean, manifestPresent: boolean, coverageReportPath: string, sutControllersPath: string}` — the `FreshnessReport` branch resolved through the import |
| T3  | `core/ci-ready.ts#scoreCiReady`                         | interfaces imported across files, unions        | 24     | 4          | `object{runs: union[null, array<object{tests: union[null, array<object{…}>]}>], historyPath: string, inventory: union[object{…}], criticalAreas: union[object{…}]}`                                                                                                           |
| T4  | `core/gate-result.ts#gateOutcome`                       | generic, string-literal union, optional field   | 8      | 1          | `result: object{checked: number, findings: array<unresolved:F>, skipped?: array<object{name:string,reason:string}>}`; `kind: {kind:'string', enum:['gate','advisory']}`; `opts: object{noun?: string}`                                                                        |
| T5  | `hard-target.ts#hardMapped` (`Flags<Base>`)             | mapped type                                     | 3      | **0**      | `object{id:boolean, count:boolean, tags:boolean}` — **the checker evaluated the mapped type**                                                                                                                                                                                 |
| T6  | `hard-target.ts#hardConditional`                        | conditional type                                | 1      | **0**      | `{kind:'string'}` — `Unwrap<string[]>` collapsed correctly                                                                                                                                                                                                                    |
| T7  | `hard-target.ts#hardIndexed` (`Record<string,unknown>`) | index signature                                 | 1      | 1          | `unresolved: index signature: field names are not statically known`                                                                                                                                                                                                           |
| T8  | `hard-target.ts#hardTemplate`                           | template-literal type                           | 1      | **0**      | `{kind:'string', enum:['onClick','onFocus']}` — expanded to literals                                                                                                                                                                                                          |
| T9  | `hard-target.ts#hardIntersection`                       | intersection                                    | 1      | 1          | `unresolved: intersection type not modelled in v1`                                                                                                                                                                                                                            |
| T10 | `hard-target.ts#hardAny`                                | `any` / `unknown` / callable                    | 3      | 3          | three `unresolved` nodes: `type is any`, `type is unknown`, `callable type`                                                                                                                                                                                                   |

### Constructs that could not be resolved, by cause

This matters more than the raw rate, because three different things were
producing "unresolved" and only one of them is the compiler's fault.

| Cause                                                          | Occurrences | Whose limitation                                                                                              |
| -------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------- |
| **Unbound type parameter** (`GateResult<F>`'s `findings: F[]`) | 1           | **Genuine.** A generic's shape is unknowable until a caller instantiates it.                                  |
| **Index signature** (`Record<string, unknown>`)                | 1           | **Genuine.** Field names do not exist statically.                                                             |
| **`any` / `unknown`**                                          | 2           | **Genuine and correct** — the spec requires these to abstain (criterion 6).                                   |
| **Function-valued field** (methods on `FreshnessReport`)       | 6           | **By design** — not data-expressible. Arguably should be _skipped_, not counted as unresolved.                |
| **Depth cap of 6** (`ci-ready.ts` nesting)                     | 4           | **This harness**, not the compiler. `MAX_DEPTH` in `lib.mjs` is arbitrary; the checker would have kept going. |
| **Intersection type** (`Base & {extra: boolean}`)              | 1           | **This harness**, not the compiler. `shapeOf` refuses intersections; the checker resolves them fine.          |

### Abstention rate

| Measurement                                                                        | Full / `skipLibCheck` | Parse-only      |
| ---------------------------------------------------------------------------------- | --------------------- | --------------- |
| Leaf-level, 4 real `ts/src/core` targets                                           | 10 / 70 = **14.3%**   | n/a (no leaves) |
| …attributable to a genuine compiler limit (excl. harness gaps and by-design skips) | 1 / 70 = **1.4%**     | n/a             |
| Leaf-level, 6 synthetic hard targets                                               | 6 / 10 = **60%**      | n/a             |
| **Target-level abstention** (`fieldsResolved == 0` → exit 3), 4 real targets       | **0 / 4 = 0%**        | **3 / 4 = 75%** |
| Target-level abstention, 6 synthetic hard targets                                  | 3 / 6 = 50%           | 6 / 6 = 100%    |

Feasibility answer: **yes.** A `ShapeNode` tree usable by a seeded generator
came out of all four real targets, including one whose shape lives in a
different file. Mapped, conditional and template-literal types — the ones the
spike expected to be hardest — are resolved by the checker without special
handling, because by the time the checker hands you a `Type` the evaluation has
already happened. The residual genuine gaps are exactly three and all three are
semantically honest: an uninstantiated generic, an index signature, and an
explicit `any`.

Parse-only is not a degraded version of this. It is a different, much weaker
capability: it returns the _name_ of the type and abstains on 75% of real
targets at the target level.

## 4. Version coupling

### Measured: three versions produce identical shapes

`extract-shapes.mjs` run against three separate `typescript` installs, all 10
targets, all configs, output compared as JSON.

| `typescript` | Classic API present? | API entry points found / probed | Extracted shapes vs 5.9.3          |
| ------------ | -------------------- | ------------------------------- | ---------------------------------- |
| 5.4.5        | Yes                  | **43 / 43**                     | **Byte-identical**, all 10 targets |
| 5.9.3        | Yes                  | **43 / 43**                     | (baseline)                         |
| 6.0.3        | Yes                  | **43 / 43**                     | **Byte-identical**, all 10 targets |
| 7.0.2        | **No**               | **not probeable — see below**   | **Cannot run at all**              |

The probed surface is every compiler-API symbol `lib.mjs` actually touches — 5
module functions, 7 enums, 13 `TypeFlags` members, 3 `Program` methods, 9
`TypeChecker` methods, 6 `Type` methods. Cold cost was also re-measured under
6.0.3 and matched 5.9.3 within noise (one-file 310.6 ms vs 306.3 ms; whole-src
562.2 ms vs 552.9 ms).

So across a minor range **and across the 5 → 6 major bump**, there is no version
coupling for this API footprint at all. That is a better result than the
compiler API's general reputation would predict, and it is the part of D2's
stated risk that the spike **retires**.

### Measured: `typescript@7` deletes the API this design depends on

`typescript@7.0.2`'s package `exports` map resolves the main entry `"."` to
`./lib/version.cjs`, whose entire contents are:

```js
const { version } = require('../package.json');
exports.version = version;
exports.versionMajorMinor = '7.0';
```

`import('typescript')` under 7.0.2 therefore yields exactly two keys — `version`
and `versionMajorMinor`. `ts.createProgram` is not a function. `ts.ScriptTarget`
is `undefined`. Every script in this spike failed against it until
`version-probe.mjs` was taught to detect and report the break instead of
throwing.

The compiler API still exists, relocated to subpaths whose names state their own
contract:

| Subpath                                                | Exports | Shape                                                                                                                                                                           |
| ------------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typescript/unstable/sync`                             | 44      | `API`, `Project`, `Program`, `Checker`, `Symbol`, `Signature` **classes**; free predicates `isUnionType()`, `isConditionalType()`, `isTemplateLiteralType()`, `isIndexType()` … |
| `typescript/unstable/ast`                              | 409     | AST node types and factories                                                                                                                                                    |
| `typescript/unstable/async`, `/fs`, `/proto`, `/ast/*` | —       | further subpaths                                                                                                                                                                |

This is not a rename. `type.isUnion()` becomes `isUnionType(type)`;
`ts.createProgram({rootNames, options})` becomes construction through an `API` /
`Project` object. Porting `lib.mjs` to it is a second implementation of the
extractor, written against a path literally named `unstable`.

### The part that makes this urgent

The peer-dependency control experiment in question 5 asked npm to satisfy a
**non-optional** `peerDependencies: {"typescript": ">=5.0.0"}` with no other
instruction. npm installed **typescript 7.0.2**. `typescript@latest` is 7.x.

So "the consumer already has `typescript`" — D2's load-bearing premise — is
true, and increasingly means the consumer has a `typescript` with no reachable
compiler API at the classic entry point.

## 5. Peer-dependency mechanics, verified by experiment

`peer-dep-probe.mjs` builds throwaway packages with `npm pack`, installs them
into throwaway consumers in a temp dir, and runs a guarded dynamic import inside
each. npm 10.9.8.

| Experiment                                                                                               | `typescript` in consumer's `node_modules`? | Guarded `await import('typescript')` result                                                        |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| **A/B** Optional peer (`peerDependenciesMeta.typescript.optional: true`), consumer installs nothing else | **No** (1 package added)                   | Throws. `code: 'ERR_MODULE_NOT_FOUND'`, message `Cannot find package 'typescript' imported from …` |
| **C** Same optional peer, consumer also installs `typescript@5.4.5`                                      | **Yes, 5.4.5**                             | Resolves. `ts.version === '5.4.5'` — a version the host never installed                            |
| **Control** Non-optional peer, `>=5.0.0`, consumer installs nothing else                                 | **Yes, 7.0.2** (3 packages added)          | Resolves, to the version with no classic API                                                       |

Four confirmed answers:

1. **An optional peer really is optional.** Declaring
   `peerDependenciesMeta.<name>.optional = true` stops npm 7+ from
   auto-installing it. Without that flag npm installs it silently, which turns
   the "optional" peer into a hard dependency plus an uncontrolled major.
2. **Absence is detectable cleanly.** A guarded dynamic `import()` in
   `try`/`catch` yields an `Error` with the stable `code`
   `ERR_MODULE_NOT_FOUND`. That is a sound trigger for the abstain path — no
   probing of `node_modules` paths, no `require.resolve` try/catch dance.
3. **The published CLI already works with `typescript` absent, today.** Verified
   two ways rather than assumed: a grep of the built `ts/dist` tree found
   **zero** files referencing `typescript`, and
   `node ts/bin/canary.js --version` run from a directory with no resolvable
   `typescript` exits 0 and prints normally. `typescript` is a devDependency and
   nothing at runtime reaches for it. The abstain path's baseline is therefore
   the current behaviour, not new behaviour.
4. **Canary gets whatever version the consumer has**, with no say in it
   (experiment C resolved 5.4.5). Combined with question 4, a runtime
   `ts.versionMajorMinor` check is mandatory, not defensive — and it must
   abstain on 7.x rather than crash, because 7.x is what `latest` resolves to.

## 6. Verdict and recommendation

### The budget being judged against

Two budgets, both measured rather than asserted:

| Budget                                                         | Value                                                                                                                                                                     | Source                                             |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Spec assumption **A1**: "well under 5 s for a single target"   | 5 000 ms                                                                                                                                                                  | `proposal.md`, Assumptions                         |
| **Observed cost of the existing `canary` CLI**, per invocation | **77 ms** median (`--version`, `review-test --help`, `vacuity-check --help`, 5 runs each); **85 ms** for a real scan (`vacuity-check` over `core/gate-result.ts`, 3 runs) | Measured on the built `ts/dist` at the base commit |

A1 is met with 16× headroom and is not a useful discriminator. The second budget
is the one that bites: this is a per-invocation CLI whose entire current cold
start is 77 ms.

| Path                         | Added cost per invocation | As a multiple of the whole current CLI |
| ---------------------------- | ------------------------- | -------------------------------------- |
| `import('typescript')` alone | +145 ms                   | **1.9×**                               |
| One-file program             | +306 ms                   | **4.0×**                               |
| `ts/src/core` subtree        | +410 ms                   | **5.3×**                               |
| Whole `ts/src`               | +553 ms                   | **7.2×**                               |

### Answer to the question as asked

**Is the compiler API affordable for a per-invocation CLI? Yes — affordability
is not what kills D2.** 306 ms and 183 MB for a correct, import-resolving shape
tree on a real target is a defensible price for a command a developer runs
deliberately, and it is 16× inside the spec's own stated budget. Feasibility is
also confirmed: 0% target-level abstention on real canary targets, 1.4%
leaf-level abstention attributable to a genuine compiler limit.

**D2 fails on availability, not cost.** Its mechanism — "the consumer already
has `typescript`, use it, abstain if absent" — has a third case the spec did not
consider: _the consumer has `typescript` and it has no compiler API_. On
`typescript@7`, which is `latest`, `import('typescript')` returns two keys and
the extractor cannot run. An optional peer of `>=5.0.0` would present as
satisfied and then abstain on the newest installs — abstaining more often the
more current the consumer is.

### Recommendation: explicit-schema-first, compiler API as a pinned opt-in

One recommendation, per the spike's charter:

1. **v1's primary shape source is the explicit schema** — the spec's own
   approach **C**, already listed and already costed at "smallest and fully
   deterministic; `zod` already a runtime dep". It adds zero dependencies, zero
   version coupling and ~0 ms, and every success criterion except shape
   _derivation_ (1, 2, 4–11) is testable against it.
2. **The compiler API ships as an opt-in second source**, behind a guarded
   dynamic import, **version-gated on `ts.versionMajorMinor`** to the 5.x–6.x
   classic API, abstaining with a named reason on 7.x and on absence. The 43
   entry points were identical across 5.4.5 / 5.9.3 / 6.0.3, so that range is
   safe to support and cheap to keep.
3. **The `unresolved` node earns its keep either way** — it is the same
   abstention type whether the reason is `type is unknown`,
   `typescript not installed`, or `typescript 7 exposes no compiler API`.

This is the smallest change to D2 that survives the evidence: the shape model,
the seeded generator, the emitters, the abstention doctrine and the exit-code
contract are all untouched. Only the _ordering_ changes — schema first, compiler
API second and optional — so v1 does not stake its primary capability on an API
that `latest` has removed.

### What I would not build on this evidence

- **A parse-only extractor as the primary path.** It is genuinely half the cost,
  and it abstains at the target level on 75% of real `ts/src/core` targets
  because it returns a type's name and nothing behind it. Shipping it as "TS
  shape derivation" would be a capability in name only.
- **Anything using `noResolve`.** It saves nothing measurable and rewrites
  unresolved imports to `any`, so a collapsed denominator is indistinguishable
  from an honest one.
- **An extractor against `typescript/unstable/*`.** Not until that path loses
  the word `unstable`. It is a different API, and a canary release would be
  coupled to a surface Microsoft has labelled as free to change.
- **`typescript` as a non-optional peer or a hard runtime dependency.** The
  control experiment shows npm resolves that to 7.0.2 today — a heavyweight
  install that does not even provide the API the feature wants.

### Park note

Per the spike's park rule: this result contradicts D2's mechanism, so **D2 is
not re-decided here**. The recommendation above is a recommendation. **Leave
issue #765 open** for the human to re-open D2 with this evidence.

## Open gate finding: this directory trips the entropy ratchet

Reported rather than fixed, because the fix is a shared-config decision this
lane was not authorised to take.

| Measurement                                                  | Findings |
| ------------------------------------------------------------ | -------- |
| `origin/main` at `572ac22`, clean detached worktree          | **144**  |
| Ceiling in `.harness/entropy-baseline.json`                  | **145**  |
| This branch                                                  | **167**  |
| Same worktree with `spike/765-shape-extraction/` moved aside | **144**  |

All 23 new findings come from this directory, and `main` had only 1 of headroom.
The cause is mechanical rather than a code smell: the six `.mjs` scripts are
invoked as `node <path>` and `hard-target.ts` is handed to the compiler as a
_path string_, never `import`ed, so the analyzer's reachability model sees seven
files' exports with no importer and reports them as dead code.

The sanctioned fix in this repo is to declare them in **both**
`entropy.entryPoints` and `performance.entryPoints` in `harness.config.json` —
the same treatment `scripts/lib/*.mjs` already has, for the same reason. Raising
`maxFindings` or excluding the path would be the wrong move and was not
attempted. `harness cleanup` truncates its finding list at 10 entries, so the 23
are attributed in aggregate by the differential above rather than enumerated
individually.

Note that `spike/schemathesis/` does not have this problem only because it is
Python, which the JS analyzer does not walk. A TypeScript/JS recorded spike is
the first of its kind here, so this is a new interaction rather than a
regression.

## Abstentions and what was not measured

Stated rather than estimated, per the repo's no-silent-abstention rule.

| Question                                                                  | Status                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Cold cost                                                               | **Measured**, 5 runs per scenario.                                                                                                                                                                                           |
| 2 Cheaper alternatives                                                    | **Measured**, incl. what each can and cannot resolve.                                                                                                                                                                        |
| 3 Shape feasibility                                                       | **Measured** on 4 real + 6 synthetic targets.                                                                                                                                                                                |
| 4 Version coupling                                                        | **Measured** across 4 versions (5.4.5, 5.9.3, 6.0.3, 7.0.2).                                                                                                                                                                 |
| 5 Peer-dependency mechanics                                               | **Measured** by experiment, plus direct verification of today's CLI without `typescript`.                                                                                                                                    |
| 6 Verdict                                                                 | **Given**, against two stated budgets.                                                                                                                                                                                       |
| **Install / bundle size impact of `typescript`**                          | **Not measured.** The spike never added it as a dependency, by charter. Relevant to a future ADR on install footprint.                                                                                                       |
| **Whether a TS 7 `unstable/sync` extractor is feasible**                  | **Not measured.** Its API surface was enumerated (44 exports) but no port was attempted — outside the timebox, and the recommendation does not depend on it.                                                                 |
| **Python `ast` path** (spec's A2, step 1's second half)                   | **Not measured.** Out of D2's scope; that assumption is still unchecked.                                                                                                                                                     |
| **Cost on a consumer repo rather than canary's own `ts/src`**             | **Not measured.** All numbers are this repo. `ts/src/core` has no mapped/conditional types, so the abstain rate here is a floor.                                                                                             |
| **Warm / long-lived-process cost** (e.g. an MCP server holding a Program) | **Not measured.** Every number is deliberately cold, matching the per-invocation CLI in D1. A resident process would amortise the 145 ms load and the Program build; that is a different design and a different measurement. |

Harness limitations that shaped the numbers, named so they are not read as
compiler limitations: `lib.mjs`'s `MAX_DEPTH = 6` produced 4 of the 10
real-target unresolved leaves, and its refusal to model intersection types
produced 1 of the 6 synthetic ones. Both are gaps in a throwaway sketch, not in
the checker.
