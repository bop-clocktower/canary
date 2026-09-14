# Plan: guarded complexity refactor of `classifyArchReport` (#905)

`classifyArchReport` in `scripts/arch-verdict.mjs` decides the architecture
gate's verdict (#626, #648). It measured cyclomatic complexity 20 (error
threshold 15). Most of that was not decisions but `?.` and `??` reads, each
counted as a branch. Guard order: pin, prove the pins bite, refactor, converge.

## 1. Decision table (enumerated from the code at origin/main 9edae90c)

| #   | Input condition (in precedence order)                        | Verdict      | Extra                      |
| --- | ------------------------------------------------------------ | ------------ | -------------------------- |
| B1  | `report?.newViolations` is not an array (incl. null report)  | `unknown`    | `reason` = no-split string |
| B2  | `newViolations.length > 0` (regardless of `passed`)          | `regression` | no `reason`                |
| B3  | `newViolations` empty, `regressions.length > 0`              | `regression` | no `reason`                |
| B4  | nothing new, `passed === true` (strict)                      | `clean`      | no `reason`                |
| B5  | nothing new, `passed` anything else (false, missing, "true") | `baseline`   | no `reason`                |

Shape fields on every verdict: `newCount`, `regressionCount`, `preExistingCount`
(non-array = 0), `totalViolations` (`Number(x ?? 0)`), `mode`
(`String(x ?? 'unknown')`), `newViolations` / `regressions` (non-array = `[]`).

Pins: `ts/test/arch-verdict.test.ts`, describe
`classifyArchReport decision table (#905)`, 8 cases asserting the whole returned
object where it matters.

## 2. Mutation matrix (each applied alone, suite re-run, then reverted)

| Mutation                                        | Caught by                 |
| ----------------------------------------------- | ------------------------- |
| M1 drop the B1 guard                            | all 3 B1 cases            |
| M2 B1 verdict `unknown` -> `baseline`           | all 3 B1 cases            |
| M3 drop `newCount > 0`                          | B2                        |
| M4 drop `regressionCount > 0`                   | B3                        |
| M5 `regression` -> `baseline`                   | B2, B3                    |
| M6 `passed === true` -> truthy                  | B5 strict-true case       |
| M7 `clean` -> `baseline`                        | B4                        |
| M8 final `baseline` -> `clean`                  | both B5 cases             |
| M9 drop `Number()` on totalViolations           | B2 (string "7")           |
| M10 mode default `unknown` -> `baseline`        | B1 null, B3               |
| M11 regression check moved before abstention    | B1 missing-newViolations  |
| M12 regressions passthrough without array check | B2 (`regressions: 'bad'`) |
| M13 drop the abstention `reason`                | all 3 B1 cases            |

13 of 13 caught. `git diff scripts/` empty after the run.

## 3. Refactor (same file, no new module)

- `classifyArchReport` normalizes `report ?? {}` once, then composes:
- `readArchShape(fields)` builds the shape fields,
- `archVerdictFor(fields, shape)` is the decision table in precedence order,
- `listOrEmpty(value)` is the array guard.

## 4. Convergence (`harness check-perf`, no flag, CLI 12.7.0, same tree)

| Measure                                   | Before | After         |
| ----------------------------------------- | ------ | ------------- |
| Total findings                            | 224    | 223           |
| `classifyArchReport` complexity finding   | 20     | gone          |
| Findings on new helpers                   | n/a    | 0 (none > 10) |
| `perf-ratchet.mjs` delta vs base          | n/a    | 0 new, exit 0 |
| `arch-verdict.mjs` file-length (advisory) | 306    | 324           |

The file-length finding already existed; the ratchet reports its growth as an
advisory warning only. No ceiling, baseline, or allowance touched.
