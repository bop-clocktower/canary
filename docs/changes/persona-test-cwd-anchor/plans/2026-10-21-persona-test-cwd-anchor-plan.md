# Plan: Anchor the persona live-detector contract test on `ts/` (#1370)

**Date:** 2026-10-21 | **Issue:** #1370 | **Tasks:** 3 | **Time:** ~15 min |
**Integration Tier:** small | **Pipeline:** harness:debugging + harness:tdd

## Root cause

`ts/test/persona.test.ts` > "agrees with the live detector on a code-shaped
project" called `detectUserLevel(process.cwd(), ['src/thing.ts'])`.

`detectUserLevel` emits one signal kind per piece of evidence: the open
`src/thing.ts` (`code/test file open`), plus a `project manifest present` and a
`test-framework config present` signal when the cwd holds a `package.json` /
`vitest.config.ts`. `resolvePersona` trusts a detected level only when at least
`DEFAULT_MIN_DETECTION_SIGNALS = 2` independent kinds fire.

- cwd = `ts/`: three kinds fire, resolution is `detected` -> `sdet`. Pass.
- cwd = repo root (no `package.json`, no `vitest.config.*`): only the open-file
  kind fires, the floor is not met, and resolution correctly returns `fallback`.
  Fail (`expected 'fallback' to be 'detected'`).

The production detector and resolver behave correctly; the test silently
depended on the working directory to supply two of its three signal kinds.

## Reproduction (failing first)

From the repo root, with vitest's root at `ts/` but `process.cwd()` left at the
repo root:

```sh
npm --prefix ts exec -- vitest run --root ts test/persona.test.ts -t "live detector"
npm --prefix ts exec -- vitest run test/persona.test.ts -t "live detector"
```

Both fail on `origin/main` (4608f963) with
`expected 'fallback' to be 'detected'`; both pass when run from `ts/`.

## Fix

Pass a directory derived from the test file instead of `process.cwd()`:
`fileURLToPath(new URL('..', import.meta.url))` (the `ts/` package), with a
comment naming why that directory supplies the needed signal kinds. No change to
`ts/src/core/environment-detect.ts` or `ts/src/core/persona.ts`.

## Tasks

1. Reproduce the failure from the repo root (above) and record it.
2. Anchor the test's detector input on `ts/` via `import.meta.url`.
3. Verify: the test passes from `ts/` and from the repo root; the full ts suite
   passes with cwd at the repo root (`--root ts`); build, typecheck,
   format:check, test pass from `ts/`.

## Observable truths

1. From the repo root, the "live detector" test passes. [EARS: ubiquitous]
2. From `ts/`, the test still passes and still asserts `source === 'detected'`
   and `persona.id === 'sdet'` (no assertion loosened).
3. No production source file changes.

## Assumptions / defaults taken

- Human-answered fork (binding): option (a), anchor on `ts/` derived from
  `import.meta.url`, which matches the cwd under which the test passes today.
  Alternatives not taken: a temp fixture dir with a written `package.json` +
  `vitest.config.ts`, or changing the detector.
- A checkout whose absolute path contains a manual hint (`manual`, `test-plan`,
  ...) adds one manual signal; with three sdet kinds the level is still `sdet`,
  so the anchored test is not sensitive to that.
