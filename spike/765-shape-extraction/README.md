# Shape-extraction spike for #765 D2 (kept on purpose)

This directory is the recorded throwaway spike behind decision **D2** of
[`docs/changes/765-synthetic-test-data/proposal.md`](../../docs/changes/765-synthetic-test-data/proposal.md).
D2 chose "derive TypeScript shapes with the TypeScript compiler API as an
optional peer dependency, abstain if it is missing", and the spec named
**compiler-API cost and TS version coupling** as the open risk, to be measured
by a spike before any implementation. This is that spike.

[`SPIKE_REPORT.md`](SPIKE_REPORT.md) has the numbers and the verdict. Read it
first; the scripts here are only the means by which those numbers were taken.

## Why it stays

- It is exploration history, not dead code. ADR 0012
  (`docs/knowledge/decisions/0012-entropy-ratchet.md`) records the rule:
  deleting a recorded spike is not a cleanup. The Schemathesis spike next door
  (`spike/schemathesis/`) is kept for the same reason.
- The report is the evidence for a decision the human has to re-open. The spike
  found that the compiler API is **absent from `typescript@7`'s main export**,
  which D2's "optional peer dependency" mechanic did not anticipate. A future
  reader needs to be able to re-run the probe rather than trust the prose.

## What is in it

| File                 | What it is                                                                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `SPIKE_REPORT.md`    | The measurements, per spike question, with method, versions, abstentions, and the verdict against D2.                                          |
| `lib.mjs`            | Shared harness: locate a `typescript` install, build a Program under one of three configs, walk a checker Type into a `ShapeNode`-shaped tree. |
| `measure-cold.mjs`   | One process = one cold measurement. Prints wall time and peak RSS as JSON.                                                                     |
| `run-cold.mjs`       | Driver: spawns `measure-cold.mjs` N times per scenario, reports min/median/max.                                                                |
| `extract-shapes.mjs` | Extracts shapes for the 10 spike targets under every config, and under parse-only. Answers the abstain-rate question.                          |
| `version-probe.mjs`  | Enumerates the 43 compiler-API entry points the extractor touches and checks each against a given install.                                     |
| `peer-dep-probe.mjs` | Builds throwaway npm packages in a temp dir to test optional-peer-dependency behaviour by experiment.                                          |
| `hard-target.ts`     | Synthetic fixture supplying mapped / conditional / template-literal / index-signature / intersection types, because `ts/src/core` has none.    |
| `results/`           | The raw JSON the report's tables were computed from. Absolute paths are redacted.                                                              |

## What it is not

This is **not canary engine code**.

- Nothing under `ts/` imports anything here, and nothing here is reachable from
  `ts/src`, the `canary` CLI, any skill, or CI.
- `hard-target.ts` is never compiled by `ts/tsconfig.json`, which includes `src`
  only.
- The spike added **no** dependency to `ts/package.json`. `typescript` is still
  a devDependency; the scripts resolve it out of `ts/node_modules` or out of an
  explicit `--ts <root>`, which is how the multi-version comparison was done.
- `lib.mjs`'s `shapeOf` is a sketch written to measure feasibility, not a design
  proposal. Its gaps (no intersection support, a depth cap of 6) are named as
  harness limitations in the report so they are not mistaken for compiler
  limitations.

## Re-running it

From this directory, with `ts/node_modules` installed:

```sh
node run-cold.mjs --runs 5                 # question 1 and 2
node extract-shapes.mjs --all-configs      # question 2 and 3
node version-probe.mjs --ts2 <other-root>  # question 4
node peer-dep-probe.mjs                    # question 5 (needs network)
```

`--ts <root>` points any script at a different `typescript` install; the
multi-version runs used throwaway installs under a scratch directory rather than
anything in this repo.
