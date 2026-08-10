# ADR 0012 — The entropy scan is ratcheted against a triaged baseline

**Status:** accepted **Date:** 2026-08-10 **Deciders:** Bri Stevenski
(maintainer) **Related:** #544; ADR 0009 (exit 3 = abstained); ADR 0011
(required checks); #508 (no silent abstention); #485 (the dogfood ratchet this
copies)

## Context

`Harness Cleanup (Entropy Scan)` in `harness-quality.yml` had never blocked a
merge. It carried `continue-on-error: true` from the day it was added, which is
the workflow-layer form of the abstention #508 spent five waves removing from
the CLI: the step goes orange, the job goes green, nobody reads the log.

#544 fixed the first layer — `entryPoints` sat at the top level of
`harness.config.json`, a path the schema does not read, so the command exited 2
with `Could not resolve entry points` and the scan never ran at all. Moving the
key to `entropy.entryPoints` made it execute, and it reported 718 findings.

**The value at the corrected key was also wrong, and that was worse, because it
produced a number instead of an error.** The single declared entry point was
`ts/bin/canary.js`. `bin` and `dist` are both members of the analyzer's
`DEFAULT_SKIP_DIRS`, so that file was never in the scanned snapshot, and neither
was `../dist/cli.js`, the only module it imports. The reachability walk started
from an empty root set. Measured on harness CLI 11.1.1:

|                       | scanned | reported dead |
| --------------------- | ------: | ------------: |
| non-test source files |     175 |       **175** |

Every scanned non-test source file in the repository was reported dead,
`ts/src/guardian/pr-check.ts` and `ts/src/mcp-server.ts` included. A check that
flags 100% of its denominator has not measured the codebase; it has abstained.
The output simply did not look like an abstention — it looked like a very messy
repo, which is exactly why 718 sat unexamined.

Building `ts/dist` first changes nothing: `dist` is skipped too, so the entry
point has no reachable target under any working-tree state.

### What the numbers actually were

Every figure previously recorded for this check is stale, and they disagree with
each other because they were taken with different tooling and different
composition:

| source                                         |   count |
| ---------------------------------------------- | ------: |
| #544 issue body (v9/v10)                       |     718 |
| `harness ci check` on `main`, v11              |     603 |
| `harness cleanup`, v11, broken entry points    | **770** |
| `harness cleanup`, v11, corrected entry points | **346** |
| after this change's unexports                  | **330** |

The 770 decomposes as 175 dead files + 555 dead exports. Only 175 distinct files
are involved — the `--json` array flattens both categories, so a file with 21
dead exports appears 22 times. Any future count quoted from this check should
say which command produced it.

### Triage of the 346 (corrected entry points, before this change's edits)

| category                                   | dead files | verdict                                                                                                                                                                                                                                             |
| ------------------------------------------ | ---------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm/scripts/__tests__/*.test.js`          |         29 | False positive. The analyzer's default exclusions cover `**/*.test.ts` and `**/*.spec.ts`, not `.test.js`. These run under `node:test` in the `npm package` job.                                                                                    |
| `ts/test/**` testkits and fixture projects |         12 | Intentional. `scanner-project/` and `sample-project/` are synthetic inputs that exist to be scanned; the testkits are imported only by `*.test.ts`, which the analyzer excludes from its own snapshot, so their usage is invisible by construction. |
| `spike/schemathesis/**`                    |          2 | Genuinely unreferenced, and deliberately so — it is a recorded spike. Left in place; deleting exploration history is not a cleanup.                                                                                                                 |
| `ts/src` production-unreferenced           |          5 | Real finding, deliberately kept — see below.                                                                                                                                                                                                        |

Dead exports (258 at that point) are dominated by the same structural cause:
`ts/src/core` (52), `ts/src/guardian` (51) and `agents/skills` (58) are heavily
unit-tested modules whose internal exports are consumed only from `*.test.ts`
files the analyzer does not scan.

Five `ts/src` files are reachable from no production entry point and are
referenced only by tests: `analysis/reachability.ts`, `core/fixture-scanner.ts`,
`core/mcp-validator.ts`, `core/metadata-scanner.ts`, `core/reporter.ts`. **They
are not deleted.** They are ported-and-tested capability from the Python
reference (see the core TS migration, #430–#440) that the CLI has not yet been
wired to; deleting them would discard working, covered code and the parity tests
that pin it to the reference implementation. They are recorded here so the
decision is visible rather than implied by a number.

The only deletions this change makes are 16 symbols that were exported but
referenced nowhere outside their own module — `TRACKER_URL`, `segGlobRegex`,
`SEVERITY_SORT_KEY`, `coverageBlock` and similar. Their `export` keyword is
removed; no code is deleted, so nothing changes at runtime and coverage is
unaffected. That is the entire "provably dead" category on this repo.

## Decision

**The entropy step blocks the build, gated on a triaged baseline rather than on
zero.**

1. `entropy.entryPoints` names literal source entry points — never a file under
   `bin/` or `dist/`, never a glob. The schema resolves each string as a path,
   so `scripts/*.mjs` silently matches nothing and looks identical to a correct
   config until every script in the directory reads as dead. Verified against
   v11 before this was written.

2. `.harness/entropy-baseline.json` carries `maxFindings`, currently **340**
   against a measured 330 — ten findings of headroom, roughly 3%. Enough that
   adding a module with a couple of test-only exports does not turn `main` red
   in the same commit, tight enough that a real regression cannot hide in it.

3. `scripts/entropy-ratchet.mjs` compares the count from
   `harness cleanup --findings-json` against that baseline and fails above it.
   `continue-on-error` is gone from the step.

4. **A missing count fails.** No contract line in the output means nothing was
   measured, and the script exits 3 (abstained, per ADR 0009) rather than
   reading the absence as zero findings. This is the property that matters most:
   without it, a future startup failure would produce a green ratchet, which is
   the #544 bug rebuilt one layer higher.

Strict-at-zero is explicitly rejected for now, matching the #485 dogfood
convention — advisory, then triage, then ratchet.

## Consequences

- A PR that adds unreachable code now fails `Quality & Integrity` instead of
  logging an orange step. The failure message names the delta and points at
  `entropy.entryPoints` as the fix when the finding is an entry-point gap.
- Raising `maxFindings` to make CI pass is the failure mode this invites. The
  script says so in its failure output, the baseline file says so in a comment,
  and reviewers should treat an increase as a change requiring justification.
- The baseline is coupled to the harness CLI major. v11 scans strictly more than
  v10 did (`check-security` went from a bare `validation passed` with no
  denominator to `166 file(s) scanned, 51 rule(s) applied`), so a CLI bump can
  move this number without any repo change. `harnessCli` is recorded in the
  baseline file so a jump has somewhere to be checked against.
- Two structural test files guard the config itself:
  `ts/test/entropy-entrypoints.test.ts` fails if an entry point is untracked,
  globbed, or inside a skipped directory — the bug above, made unrepeatable —
  and `ts/test/entropy-ratchet.test.ts` pins the exit-code contract, including
  the abstention path.

## Alternatives Considered

**Delete the 175 "dead" files.** The output said they were dead. They were not;
the entry-point model was broken. This is the reason the ADR leads with the
denominator rather than the count.

**Drive the count to zero by deleting the five test-only `ts/src` modules and
the fixture projects.** That trades a documented number for lost capability and
lost test inputs. Deleting live code to satisfy an analyzer is a worse outcome
than carrying a triaged baseline.

**Suppress the categories via `entropy.excludePatterns`.** Setting the key
replaces the analyzer's defaults wholesale rather than extending them —
measured: adding a single `spike/**` pattern silently un-excluded `**/*.test.ts`
and drove `ts/test` dead files from 12 to 120. A baseline that carries the
residual is both smaller and more honest than a default set this repo would have
to mirror and keep in sync across CLI majors.

**Keep it advisory and annotate harder.** The step already annotates on failure
and it changed nothing — a warning that nobody has to act on is a warning nobody
acts on. That is the finding of #544, not a hypothesis about it.
