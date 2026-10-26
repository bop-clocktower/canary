# #1488 — `Skills (JS)` red under the vitest 5.0.5 bump (PARKED)

Refs #1488. cicd-fleet remediation worker 2, fleet-command run fc1026.

**Status: PARKED — upstream regression, no canary code change.** Per human fork
F3a, a dependency regression is parked with a minimal reproduction and a
proposed upstream issue; nothing is filed upstream and the bump is not pinned or
held back.

## Symptom

Dependabot PR #1488 (agents/skills: vitest 5.0.4 → 5.0.5, @vitest/coverage-v8
5.0.4 → 5.0.5, eslint 10.12.0 → 10.13.0) fails the required `Skills (JS)` check
on 1 of 2579 tests:

```text
test/pytest-precondition.test.ts
  > savant integration files under a python3 without pytest (#1239)
  > FAILS under CI=true, so the required check cannot go falsely green
```

The nested vitest run exits non-zero (good) but prints

```text
⎯⎯⎯ Startup Error ⎯⎯⎯
TypeError: code.charCodeAt is not a function
    at extractInlineSourceMap (vite/dist/node/module-runner.js:366:57)
    at EvaluatedModules.getModuleSourceMapById (vite/dist/node/module-runner.js:355)
    at getRunnerSourceMap / mapSourcePosition / wrapCallSite
    at Function.prepareStackTrace (vite/dist/node/module-runner.js:1102)
    at prepareStackTraceCallback (node:internal/errors:144:29)
    at parseErrorStacktrace (vitest/dist/chunks/source-map…)
    at printErrorInner (vitest/dist/chunks/index…)
```

instead of the globalSetup's own `FAILED: pytest not installed — …` message, so
the `toContain('pytest not installed')` assertion fails.

## Determinism

- CI: `gh run rerun 40154883933 --failed` → attempt 2 `Skills (JS)` =
  **failure** (attempt 1 also failure). Deterministic.
- Local (macOS, Node 22.23.2 from `.nvmrc`), #1488's exact lockfile: 3/3 red,
  same TypeError. Platform-independent.

## Root cause (confirmed, one variable at a time)

The lockfile change in #1488 also moves the transitive **vite 8.3.4 → 8.3.5**
(plus rolldown 1.2.14 → 1.2.15, postcss, @oxc-project/types). The crash frame is
in vite, not vitest.

1. vitest's `ServerModuleRunner` (the module runner that loads `globalSetup`
   files in the main process) handles a `fetchModule` result that was spilled to
   a temp file with `const code = await readFile(result.tmp);` — **no
   encoding**, so `code` is a Node `Buffer`. This is present in **both** vitest
   5.0.4 (`chunks/index.B8VfM7Mf.js:3496`) and 5.0.5
   (`chunks/index.1TqnEahn.js:3582`). Instrumented proof:
   `DBG id=…/agents/skills/test/pytest-precondition.ts type=object ctor=Buffer`.
2. vite ≤ 8.3.4 `EvaluatedModules.getModuleSourceMapById` used
   `code.lastIndexOf(prefix)` + `code.slice()` + `RegExp.exec(...)`; all of
   these work on a Buffer (`exec` coerces it to a string), so the latent Buffer
   was harmless.
3. vite 8.3.5 refactored that into `extractInlineSourceMap(code)`, which calls
   `code.charCodeAt(dataEnd - 1)`. A Buffer has `lastIndexOf`/`indexOf`/`slice`
   but no `charCodeAt` → `TypeError`.
4. That code runs inside `Error.prepareStackTrace` whenever vitest prints an
   error whose stack passes through a server-runner-loaded module. So **any
   throwing `globalSetup`** has its real message replaced by the TypeError.
   Canary's `pytest-precondition.ts` throws by design under `CI=true` (#1239),
   which is exactly what this test exercises.

Isolation matrix (local, `test/pytest-precondition.test.ts`, coverage off):

| vitest | vite  | result                          |
| ------ | ----- | ------------------------------- |
| 5.0.4  | 8.3.4 | 17/17 pass (committed lockfile) |
| 5.0.5  | 8.3.5 | 1 fail, 3/3 runs (#1488 lock)   |
| 5.0.5  | 8.3.4 | 17/17 pass, 2/2 runs            |
| 5.0.4  | 8.3.5 | 1 fail, 2/2 runs                |

So the trigger is **vite 8.3.5** and the latent defect is vitest passing a
Buffer where vite's `ModuleRunner` expects a string `code`. Canary's test and
its nested-vitest invocation are **not** the cause: the test correctly caught a
real regression. A failing precondition's message is now invisible to anyone
reading the CI log. That also applies to `engine-precondition.ts` (#1221) and
any other throwing globalSetup. The exit code is still non-zero, so the required
check cannot go falsely green; only the diagnosis is lost.

## Minimal reproduction (no canary code)

`package.json`

```json
{
  "name": "vite-835-globalsetup-buffer-repro",
  "private": true,
  "type": "module",
  "devDependencies": { "vitest": "5.0.5", "vite": "8.3.5" },
  "overrides": { "vite": "8.3.5" }
}
```

`vitest.config.ts`

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { globalSetup: ['./setup.ts'] } });
```

`setup.ts`

```ts
export default function setup(): void {
  throw new Error('REAL MESSAGE: globalSetup precondition failed');
}
```

`a.test.ts`

```ts
import { it } from 'vitest';
it('noop', () => {});
```

`npm i && npx vitest run` (Node 22.23.2):

- vite 8.3.5 → `Startup Error` / `TypeError: code.charCodeAt is not a function`
  (real message lost)
- vite 8.3.4 → `Error: REAL MESSAGE: globalSetup precondition failed`

## Proposed upstream issue (NOT filed; for the human)

Target: vitest-dev/vitest (the Buffer originates there). Mention vite 8.3.5 as
the trigger; a defensive `String(code)` in vite's `extractInlineSourceMap` would
also fix it.

> **Title:** Throwing `globalSetup` reports
> `TypeError: code.charCodeAt is not a function` with vite 8.3.5
> (ServerModuleRunner passes a Buffer as module code)
>
> **Versions:** vitest 5.0.4 and 5.0.5, vite 8.3.5 (works on 8.3.4), Node
> 22.23.2, macOS and ubuntu-latest.
>
> **Repro:** four files above; `npx vitest run`.
>
> **Expected:** `Error: REAL MESSAGE: globalSetup precondition failed` with a
> mapped stack (as on vite 8.3.4).
>
> **Actual:** `Startup Error — TypeError: code.charCodeAt is not a function` at
> `extractInlineSourceMap` ← `EvaluatedModules.getModuleSourceMapById` ←
> `Function.prepareStackTrace`, and the original error message is never printed.
>
> **Cause:** `ServerModuleRunner`'s transport does
> `const code = await readFile(result.tmp)` without an encoding, so `meta.code`
> is a `Buffer`. vite ≤ 8.3.4's source-map lookup happened to work on a Buffer
> (`lastIndexOf` + `RegExp.exec` coercion); vite 8.3.5's
> `extractInlineSourceMap` calls `code.charCodeAt`, which a Buffer lacks.
> Suggested fix: `readFile(result.tmp, 'utf-8')` (matching the other
> `readFile(..., 'utf-8')` calls in the same chunk).

## Fix

None in canary. Forks F3a/F4a forbid pinning or holding back the bump, and the
cause is not in canary's test or its invocation. The assertion is not weakened:
it is doing its job (#1239).

## Tests

No test change. Evidence runs:

- committed 5.0.4 lockfile: `test/pytest-precondition.test.ts` green.
- #1488 lockfile (vitest 5.0.5 / vite 8.3.5): red 3/3, deterministic.
- swap matrix above isolates vite 8.3.5.

## Fork for the human (not covered by F3a/F4a)

F3a's park branch names a "vitest 5.0.5 regression"; the trigger is actually the
transitive **vite 8.3.5**, with the latent defect in vitest (5.0.4 too). Parked
on that branch's spirit (an upstream dependency regression). Options:

- **(a) wait upstream (default):** file the issue above, and leave #1488 red
  until vitest/vite ship a fix and dependabot rebases.
- **(b) canary-side workaround:** have `test/pytest-precondition.ts` (and
  `engine-precondition.ts`) also write their failure message to stderr before
  throwing. Then the message survives the printer crash on any vite. This is a
  workaround for an upstream bug, so it would carry a link to the upstream
  issue. It needs that issue filed first, which is outside this worker's remit.
