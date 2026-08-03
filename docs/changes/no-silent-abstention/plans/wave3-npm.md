# Plan: No Silent Abstention — Wave 3 (npm layer)

**Date:** 2026-08-03 | **Spec:** `docs/changes/no-silent-abstention/proposal.md`
(Implementation Order item 3; D2 / D7) | **Issue:** #508 (+ the #505 defect
class) | **Tasks:** 10 | **Time:** ~40 min | **Integration Tier:** medium (the
doctrine docs / CHANGELOG / workflow templates stay Wave 5 by design, D6)

**Branch:** `feat/abstention-wave3-npm`, based on `origin/main` at `b538b765`
(PR #527 merged). Waves 1+2 shipped in v6.4.0, so `main` already carries
`ts/src/core/gate-result.ts` and six conformance rows. Baselines on `main`:
**1727** ts tests (83 files) and **207** npm tests (51 suites).

## Goal

`canary doctor` reports its denominator — skipped checks stay visible and never
aggregate into "passed" (D7) — and exits `EXIT_ABSTAINED` (3) when zero checks
were actually runnable; `canary overlay lint` warns unmissably when it linted
zero skills. Both route through the Wave 1 `gate-result` policy rather than a
second copy of the doctrine, with npm-layer conformance rows proving each loud
outcome through the real command, and every non-zero-denominator path
byte-identical.

## Observable Truths (Acceptance Criteria)

1. **[Event-driven]** When `canary doctor` finishes with zero `pass` results and
   zero `fail` results — every check skipped, or no check registered at all —
   the system shall print the `gateOutcome` abstention line naming the skipped
   checks plus remediation, and exit 3. It shall never print
   `All checks passed.` (SC3, the #505 class, with a permanent negative
   fixture.)
2. **[Ubiquitous]** When `canary doctor` has at least one `pass` and any number
   of skips, the summary shall name the denominator and the skips in one line
   (`All N run check(s) passed (M skipped: <names>)`) — `skip` never folds into
   the passed count (D7).
3. **[Ubiquitous]** `canary doctor --json` shall carry `checked`, `skipped`, and
   `abstained` additively; `allPassed` shall be `false` whenever `abstained` is
   `true`. Existing fields (`version`, `checks[]`, `warnings`) are unchanged.
4. **[Event-driven]** When `canary overlay lint` resolves an overlay whose
   `.canary/skills` directory contains zero skill directories, the system shall
   print the abstention line + remediation instead of
   `✓ 0 skill(s) — no issues.`, and `--json` shall carry `checked`/`abstained`
   additively. Exit stays 0 (advisory, D3) — and stays 1 when an error finding
   is present, which outranks abstention.
5. **[Ubiquitous]** `npm/src/gate-result.ts` shall be a byte-verbatim generated
   copy of `ts/src/core/gate-result.ts`; a drift check shall fail the npm test
   run when the two diverge.
6. **[Ubiquitous]** `npm/scripts/__tests__/gate-conformance.test.js` shall hold
   the npm-layer registry (3 rows: doctor all-skipped, doctor zero-registered,
   overlay lint zero-skills), each collapsing the denominator through the real
   command and asserting the loud outcome + forbidden success copy. The engine
   registry's header comment shall point at it (as it already does for the skill
   layer).
7. **[Unwanted]** If the denominator is non-zero, then the system shall not
   change any existing output byte or exit code — the npm suite passes with only
   the pins that asserted silent success updated (spec SC5).
8. **[Ubiquitous]** `npm test` (207 baseline + new) and the ts suite (1727) are
   green, `tsc` clean, prettier gate clean, at the wave boundary (D6).

## Uncertainties

- **[DECISION] How the npm (CJS) layer consumes the ESM engine helper.** D2 says
  "npm scripts import the helper from `dist/engine/`". That is not reachable as
  written: `npm/package.json` has no `"type"` field (CommonJS),
  `npm/dist/engine/package.json` declares `"type": "module"`, and npm's `test`
  script is `tsc && node --test` — it never runs `build-engine.mjs`, so
  `dist/engine/` may not exist when the npm suite runs in CI
  (`.github/workflows/harness-quality.yml`).

  **Chosen: a generated verbatim copy with a drift check.**
  `ts/src/core/gate-result.ts` has **zero imports** — 116 lines of pure policy —
  so the identical source compiles correctly as ESM under `ts/` and as CJS under
  `npm/`. `npm/scripts/sync-gate-result.mjs` copies it to
  `npm/src/gate-result.ts` behind a GENERATED banner; `--check` mode (a file
  read + compare, no compile) runs as npm's `pretest` and fails on drift. Single
  source of truth, no runtime bridge, no build ordering, and `overlay lint`
  stays synchronous.

  Rejected:
  - _Dynamic `await import('../engine/core/gate-result.js')`_ — works in a
    published package, fails in CI where `dist/engine/` is unbuilt; and it would
    force `overlayLint` (and the whole `OVERLAY_SUBCOMMANDS` table) async for a
    constant and one pure function.
  - _Add `build-engine.mjs` to npm's `pretest`_ — single source of truth, but
    couples a 1.2-second unit suite to a full TypeScript engine compile.
  - _Widen npm's `rootDir` to include `../ts/src`_ — relocates every emitted
    path in `npm/dist/`, breaking `package.json#files` and the bin shims.

  Spec follow-through: D2's wording is now inaccurate for the npm layer. Wave 5
  amends it to "npm consumes the helper as a drift-checked generated copy" and
  records why. **[DEFERRABLE]** — behavior is identical either way.

- **[DECISION] `info` results are not part of the denominator.** `CheckStatus`
  is `pass | fail | skip | info`. `checked` counts `pass + fail` only; `info` is
  neither a verification nor a skip (it reports context, e.g. a version string),
  so a doctor run that emitted only `info` rows **abstains**. This is the
  doctrine's point — an informational line is not evidence of a check.
- **[DECISION] Abstention does not outrank a failure.** `gateOutcome` already
  puts findings first (`gate-result.ts:90`): a `fail` proves something was
  checked, so a run with 1 fail + 9 skips exits 1 and reads as a finding, never
  as an abstention. No special-casing needed in doctor.
- **[DECISION] overlay lint is advisory (exit 0), matching the spec's Wave 3
  bullet.** An overlay with no skills is a legitimate authoring state (a
  workflows-only overlay), so exit 3 would be a nag. The abstention line is
  still unmissable, and `--json` carries `abstained: true` for anyone gating.
- **[DECISION] The `install_workflows` half of the spec's Wave 3 bullet is
  already shipped.** `overlay-lint.ts:12-13` and `frontmatterFindings` already
  report a declared-but-unparseable list as a loud error (#501). The remaining
  zero-denominator gap is the zero-skills case, which is what this wave takes.
- **[DECISION] The npm registry lives in npm's own suite, not the ts one.** The
  ts registry runs under vitest against ESM engine sources and cannot invoke
  npm's CJS `runDoctor`. This follows the precedent already recorded in
  `ts/test/gate-conformance.test.ts:12-13` for the skill layer.

## Tasks

| #   | Task                                                                                                                          | Verify                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1   | `npm/scripts/sync-gate-result.mjs` (copy + `--check`), generated `npm/src/gate-result.ts`, `pretest` wiring                   | drift test: mutate the copy, `--check` exits non-zero         |
| 2   | RED: `doctor-abstention.test.js` — `summarizeChecks` policy (all-skip, zero-registered, pass+skip, fail+skip, info-only)      | 5 failing tests                                               |
| 3   | GREEN: `summarizeChecks` in `npm/src/doctor.ts` over `gateOutcome`, exported for test                                         | task 2 green                                                  |
| 4   | RED→GREEN: `runDoctor` human summary uses the outcome's `summaryLine` + remediation; returns its `exitCode`                   | integration tests on a consent-skipped overlay check          |
| 5   | RED→GREEN: `runDoctor --json` gains `checked`/`skipped`/`abstained`; `allPassed` false on abstention                          | JSON contract tests; existing `doctor-json.test.js` untouched |
| 6   | RED→GREEN: `overlay lint` zero-skills abstention (human + `--json`), error findings still outrank                             | `overlay-lint-cli.test.js` additions                          |
| 7   | `npm/scripts/__tests__/gate-conformance.test.js` — 3 npm-layer registry rows through the real commands                        | 3 green rows                                                  |
| 8   | Update `ts/test/gate-conformance.test.ts` header to point at the npm registry; `docs/guides/doctor.md` exit-3 + `--json` docs | markdownlint, doc-drift check                                 |
| 9   | Record the CHANGELOG decision (Wave 5 adds "Gates that got louder", backfilling v6.4.0) on the roadmap row + proposal D1      | roadmap comment guard passes                                  |
| 10  | Full gate: `npm test`, ts suite, `tsc --noEmit`, `format:check`, arch baseline if the ratchet trips                           | 207+ npm, 1727+ ts, all green                                 |

## Rollback

Every task is additive except the two summary lines in `doctor.ts` and the one
in `overlay-commands.ts`. Reverting the branch restores the old copy exactly; no
data format, no persisted state, and no published contract changes (`--json`
fields are additive).
