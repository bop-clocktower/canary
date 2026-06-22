# Example: Semver Compare

Tests a `compareVersions` function that orders two semantic-version strings
by [Semantic Versioning](https://semver.org) precedence, returning `-1` / `0`
/ `1`.

This is a **TypeScript unit** example. Version comparison looks like a
three-integer sort until prerelease tags enter: `1.0.0-rc.1` sorts *before*
`1.0.0`, numeric identifiers rank below alphanumeric ones, more identifiers
beat fewer, and build metadata is ignored entirely. The prompt encodes those
precedence rules so the suite covers the parts that naïve string or numeric
comparison gets wrong.

## Prompt

```text
Generate Vitest unit tests for a compareVersions function.

Signature:
    function compareVersions(a: string, b: string): -1 | 0 | 1

The function compares two semantic-version strings by Semantic Versioning
precedence and returns -1 if a < b, 0 if they are equal in precedence, and
1 if a > b.

Precedence rules (a subset of semver.org §11):
  - Compare major, then minor, then patch as integers, in that order.
  - A version WITH a prerelease tag has LOWER precedence than the same
    core version WITHOUT one: "1.0.0-rc.1" < "1.0.0".
  - Prerelease identifiers are compared left to right. A numeric identifier
    is compared numerically; an alphanumeric identifier is compared lexically
    (ASCII). A numeric identifier always has lower precedence than an
    alphanumeric one.
  - When all shared prerelease identifiers are equal, the version with MORE
    identifiers has higher precedence: "1.0.0-alpha" < "1.0.0-alpha.1".
  - Build metadata (anything after "+") is IGNORED for precedence:
    "1.0.0+build.1" == "1.0.0+build.2".
  - Malformed input (non-integer core segment, fewer than three segments)
    throws a TypeError.

Cover these cases:
  1. Equal core versions — ("1.2.3", "1.2.3") → 0
  2. Major differs — ("2.0.0", "1.9.9") → 1
  3. Patch differs — ("1.2.4", "1.2.3") → 1
  4. Prerelease is lower than release — ("1.0.0-rc.1", "1.0.0") → -1
  5. Numeric identifier lower than alphanumeric — ("1.0.0-1", "1.0.0-alpha") → -1
  6. More prerelease identifiers wins — ("1.0.0-alpha", "1.0.0-alpha.1") → -1
  7. Build metadata ignored — ("1.0.0+build.1", "1.0.0+build.2") → 0
  8. Malformed input — ("1.0", "1.0.0") → throws TypeError
```

See [`prompt.txt`](prompt.txt) for a copy-pasteable version.

## Run it

```bash
cd examples/realworld-functions/semver-compare
cat prompt.txt
```

Then, in Claude Code, generate the test:

```text
/canary-write-test  <paste the contents of prompt.txt>
```

Canary will:

1. Classify the request as `frontend_unit` (Vitest hint)
2. Pick `vitest` from the framework registry
3. Write a `compareVersions.test.ts` file under `tests/generated/`
4. Print the file path + feedback hint

## What Canary should produce

Eight `it()` / `test()` cases. The prerelease ordering rules are the ones
worth asserting carefully — release-beats-prerelease and numeric-below-alpha
are the two most-missed edges:

```typescript
it('ranks a prerelease below the release', () => {
  expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1)
})

it('ranks a numeric identifier below an alphanumeric one', () => {
  expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1)
})
```

## Running the generated test

```bash
npm install -D vitest
npx vitest run tests/generated/compareVersions.test.ts
```

The tests import a `compareVersions` stub — paste your real implementation
or point the import at your module before running.

## Variations to try

- **Symmetry property:** ask Canary to add a property-style check that
  `compareVersions(a, b) === -compareVersions(b, a)` for every pair above
- **Sort integration:** request a case that runs `versions.sort(compareVersions)`
  on a shuffled list and asserts the fully ordered result
- **Range satisfaction:** extend the contract to a `satisfies(version, range)`
  helper for `^` / `~` ranges and update the signature accordingly

## See also

- [Getting Started → generating tests](../../../docs/wiki/Getting-Started.md)
- [Writing Good Prompts](../../../docs/wiki/Writing-Good-Prompts.md)
- [Real-world functions overview](../README.md)
