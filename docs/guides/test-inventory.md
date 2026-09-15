# Test inventory (`.canary/test-inventory.json`)

`canary ci-ready` scores three of its five checks from a test inventory:
coverage-depth, assertion-quality and critical-paths. `canary inventory` writes
that inventory. This page covers how to produce the file, the schema, and how
`ci-ready` scores against it.

## Produce it

```console
$ canary inventory --root .
Wrote ./.canary/test-inventory.json: 136 test(s) in 18 file(s).
$ canary ci-ready
```

- `canary inventory [testDir] [--root <dir>] [--json]`
- `testDir` defaults to `--root`. `--root` defaults to the current directory.
- It walks the same files as `review-test` and `vacuity-check`: `test_*.py` and
  `*.test|spec.{ts,js,mjs,cjs,mts,cts}`. It skips `node_modules`, `dist` and
  similar directories.
- Exit codes: `0` when the file was written. `3` (abstained) when no test was
  found, in which case **no file is written**. An empty inventory must not look
  like a real input.

Run `canary inventory` before `canary ci-ready` wherever the inventory can go
stale, for example as a CI step.

## Schema (version 1)

```json
{
  "schema_version": 1,
  "generated": "2026-09-15T00:00:00.000Z",
  "files": [
    {
      "path": "tests/cart.test.ts",
      "framework": "vitest",
      "targets": ["src/cart"],
      "tests": [
        { "name": "adds an item", "line": 4, "depth": 2 },
        { "name": "cart exists", "line": 9, "depth": 1 }
      ]
    }
  ],
  "skipped": [{ "name": "tests/broken.test.ts", "reason": "unreadable: ..." }]
}
```

| Field                   | Meaning                                                                                                                                                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema_version`        | Always `1` for this layout. `ci-ready` skips an unknown version and asks you to re-run the producer.                                                                                                                       |
| `generated`             | ISO timestamp of the run.                                                                                                                                                                                                  |
| `files[].path`          | POSIX path, relative to `--root`.                                                                                                                                                                                          |
| `files[].framework`     | `vitest`, `playwright` or `pytest`, from the file name.                                                                                                                                                                    |
| `files[].targets`       | First-party modules the file imports, with the extension stripped and paths relative to `--root`. JS relative `import`/`require`/`import()` count; Python `from x.y import` becomes `x/y`, and stdlib modules are ignored. |
| `files[].tests[].name`  | The test's name as written.                                                                                                                                                                                                |
| `files[].tests[].line`  | 1-based line of the declaration.                                                                                                                                                                                           |
| `files[].tests[].depth` | Static assertion depth tier (see below).                                                                                                                                                                                   |
| `skipped`               | Files that matched but could not be read, each with a reason.                                                                                                                                                              |

### Assertion depth

Depth is a **static tier read from source**. It is not runtime coverage.

| Depth | Rule                                                                                                                                                                                                         |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0`   | No recognised assertion: `review-test`'s LINT-006 vocabulary finds none.                                                                                                                                     |
| `1`   | Every assertion is weak. Weak means an absence (`toBeNull`, `.not.*`, `assert x is None`, ...) or a trivial presence (`toBeDefined`, `toBeTruthy`, `assert x`). This is the vocabulary `vacuity-check` uses. |
| `2`   | At least one shaped assertion, one that pins a value.                                                                                                                                                        |

## How `ci-ready` scores it

"Area depth" is the best test depth among files whose `targets` match an area's
path. Paths are compared with extensions stripped, as path suffixes. When no
test's file imports the area, its depth is 0.

| Check             | Scope                                                                           | pass                 | warn                 | fail                  |
| ----------------- | ------------------------------------------------------------------------------- | -------------------- | -------------------- | --------------------- |
| coverage-depth    | areas in `critical-areas.json`, or every inventory target when there are none   | all areas at depth 2 | some at 1, none at 0 | any at 0              |
| assertion-quality | tests importing a critical area, or every test when there are no critical areas | all tests at depth 2 | a minority at ≤ 1    | a majority at ≤ 1     |
| critical-paths    | the 5 highest-`risk_score` areas                                                | all at depth ≥ 1     | one uncovered        | two or more uncovered |

Each check reports `skip` with the reason named, and never passes, in these
cases:

- the inventory is missing, not JSON, or an unknown `schema_version`
- it lists 0 tests
- the scope is empty
- for critical-paths, `critical-areas.json` is absent or lists no areas
