---
number: 12
title: 'ADR 0012 — The entropy scan is ratcheted against a triaged baseline'
date: 2026-08-10
status: accepted
source: adr
---

<!-- markdownlint-disable-file MD025 -->

# ADR 0012 — The entropy scan is ratcheted against a triaged baseline

**Status:** accepted **Date:** 2026-08-10 **Deciders:** Bri Stevenski
(maintainer) **Related:** #544; #638 (the same entry-point model, at
`performance.entryPoints`); #677 (the exclude list, which amended the
"Alternatives Considered" entry below); ADR 0009 (exit 3 = abstained); ADR 0011
(required checks); #508 (no silent abstention); #485 (the dogfood ratchet this
copies); #676 / PR #685 (the 26 dead links whose repair lowered the ceiling);
issue #686 (the 27 structural doc-drift findings that are detector defects,
below); #694 / #719 (the 11.2.0 drift-detector fix, 281 -> 257); #744 (the
floating pin, and the instrument-identity abstention that closes it)

## Context

`Harness Cleanup (Entropy Scan)` in `harness-quality.yml` had never blocked a
merge. It carried `continue-on-error: true` from the day it was added, which is
the workflow-layer form of the abstention #508 spent five waves removing from
the CLI: the step goes orange, the job goes green, nobody reads the log.

Issue #544 fixed the first layer — `entryPoints` sat at the top level of
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

| category                                   | dead files | verdict                                                                                                                                                                                                                                                  |
| ------------------------------------------ | ---------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm/scripts/__tests__/*.test.js`          |         29 | False positive. The analyzer's default exclusions cover `**/*.test.ts` and `**/*.spec.ts`, not `.test.js`. These run under `node:test` in the `npm package` job. **Excluded outright as of #677** — see Decision item 6; they no longer reach the count. |
| `ts/test/**` testkits and fixture projects |         12 | Intentional. `scanner-project/` and `sample-project/` are synthetic inputs that exist to be scanned; the testkits are imported only by `*.test.ts`, which the analyzer excludes from its own snapshot, so their usage is invisible by construction.      |
| `spike/schemathesis/**`                    |          2 | Genuinely unreferenced, and deliberately so — it is a recorded spike. Left in place; deleting exploration history is not a cleanup.                                                                                                                      |
| `ts/src` production-unreferenced           |          5 | Real finding, deliberately kept — see below.                                                                                                                                                                                                             |

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

2. **`performance.entryPoints` carries the identical list (#638).** The perf
   check builds the same `EntropyAnalyzer` snapshot as the entropy check, but
   the two callers read the roots from different keys and only some of them fall
   back — measured against CLI 11.1.1:

   | Caller                            | Roots read from                        |
   | --------------------------------- | -------------------------------------- |
   | `ci check` → entropy              | `entropy.entryPoints ?? performance.…` |
   | `ci check` → perf                 | `performance.entryPoints` **only**     |
   | `harness check-perf` (standalone) | `performance.… ?? entropy.…`           |

   Declaring only the entropy key therefore left the standalone command green
   and the required `harness` job reporting
   `perf: warn — Could not resolve entry points`: zero files analysed, one
   "issue", exit 0. Declaring both keys is the only configuration under which
   every caller measures something. Perf findings went 0 files / 1 pseudo-issue
   → **67 files / 238 findings**; the entropy count is untouched at 330, because
   the entropy caller was already satisfied by its own key.

   The alternative the issue named — disabling the perf check outright — is
   rejected. 238 real findings is not nothing to look at, and
   `PerformanceConfigSchema` is `.passthrough()`, so the key survives the schema
   rather than being one of the silently-stripped paths that caused #544 in the
   first place.

3. `.harness/entropy-baseline.json` carries `maxFindings`, **308** as of #677.
   It was 340 against a measured 330 when this ADR was written; by #677 the
   measured count had drifted up to 340 — the whole ten findings of headroom
   spent — and 32 of those were the `.test.js` artifacts item 6 below now
   excludes. Lowering it to the measured 308 restores the number to something
   the repo has actually triaged. Note that this left **zero** headroom, which
   is the state `main` was already in; it is the ratchet doing its job, not a
   tightening, and the next genuine addition of test-only exports will need
   either an entry point or a re-triage rather than a raised ceiling.

   **Amended by #676 (PR #685).** Repairing 26 dead documentation links removed
   21 drift findings, so the ceiling came down again — `maxFindings` is now
   **297** against a measured 287, restoring the ~10 findings of headroom this
   ADR originally specified. The lesson from the #677 round holds: the ceiling
   moves only when the measured count moves, and it moves _down_.

   **Amended by #668 (PR #687).** Splitting `guardian/coverage.ts` into eleven
   modules raised the measured count to **292** (5 of headroom remaining). All
   +5 are false positives with a single root cause: the analyzer does not credit
   a re-export edge (`export { x } from './y'`) as a use of `x`. A split-out
   export survives only if some sibling module imports it directly; if its only
   path to consumers is the barrel, it is flagged. Adding the barrel to
   `entropy.entryPoints` is the documented remedy and would reclaim the 5 — not
   applied, so the number stays honest until someone decides to.

   **Amended 2026-08-13 by the dead-code paydown.** `main` measured **296**
   against the 297 ceiling — one finding of headroom, with two finished branches
   waiting that needed three between them. Rather than squeeze those through, 15
   provably-dead exports were removed and `maxFindings` lowered to the measured
   **281**. Thirteen are `export`-keyword removals on symbols still used inside
   their own module (`RECORD_STATUSES`, `ANALYSIS_SOURCE`, `KNOWN_FRAMEWORKS`,
   `workflow-discovery`'s `SCHEMA_VERSION`, `arch-verdict.mjs`'s two helpers,
   the redundant `TestResultRecord` re-export, and
   `SUPPORTED_SUFFIXES`/`isTestFile`/`scanFileFull` in the canary-savant and
   canary-blackhawk scanners) — no code deleted, nothing changed at runtime. Two
   are genuine deletions: the `scanFile` thin wrapper in both scanners, with
   zero consumers anywhere. Measured 296 → 281, and the before/after `--json`
   sets differ by exactly those 15 with **zero** additions — purely subtractive.

   **Amended 2026-08-18 by the CLI drift fix (#694, #745): 291 → 267.** The
   largest single move in this file's history, and the only one that paid down
   nothing. CLI 11.2.0 retired the doc-drift false positives (see item 7), the
   measured count fell 281 → 257 with no repo change, and the ceiling followed
   at the standing +10. The lesson worth carrying: `maxFindings` is an absolute
   count produced by a tool the workflows pin to a **floating major**, so the
   number can move without a commit. The baseline now records the exact
   `harnessCli` that measured it and declares its own `maxHeadroom`, which
   `scripts/entropy-ratchet.mjs` and `ts/test/entropy-ratchet.test.ts` both read
   rather than keeping private copies (they had drifted to 25 and 10). Minor
   drift is still undetected — the major check cannot see 11.1.1 → 11.2.0 — and
   that gap is tracked in #744.

   **Two traps that make an export look dead when it is live**, both hit during
   this triage and both worth naming so the next paydown does not delete live
   code:

   | trap                | why the analyzer misses it                                                                                                                                                                              |
   | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | the `dist` hop      | `npm/scripts/__tests__/*.test.js` does `require('../../dist/engine-checks.js')`, so all 15 flagged `npm/src` exports (`checkPluginVersion`, `parseRegistryVersion`, ...) are test-covered and **live**. |
   | the sync-mirror hop | `npm/src/gate-result.ts` is a verbatim generated copy of `ts/src/core/gate-result.ts`; `npm/src/doctor.ts` imports `skippedSuffix` from the copy, so the engine export is live.                         |

   A third class stays exported by necessity: `tsconfig` sets
   `declaration: true`, so a type named in an exported signature cannot be
   unexported. That is why `BlockDecision` (return type of the exported
   `decideBlock`) and migrator's `SkillDeployResult` / `WorkflowInstallResult` /
   `SkillFreshnessResult` (field types of the exported `MigrationReport` /
   `FreshnessReport`) were left alone.

   **A wiring finding surfaced and was deliberately NOT resolved by deleting.**
   `ts/src/cli-common.ts` documents `ensureAscii` as shared plumbing "every
   command tree needs", and it is imported by nothing: eight modules
   (`mcp-server.ts`, `guardian/cli.ts`, `guardian/pr-check.ts`,
   `guardian/analysis-emit.ts`, `core/reporter.ts`, `core/migrator.ts`,
   `core/ticket-updater.ts`, `core/workflow-discovery.ts`) each declare their
   own private copy instead. The copies have drifted into **two**
   implementations — six use a regex `replace`, two use the per-code-unit loop
   `cli-common.ts` documents. Both forms iterate UTF-16 code units, so they
   agree today and no behavior is wrong; what is wrong is that the single source
   of truth was written and never wired, so the next parity fix has eight places
   to land instead of one. Unexporting it would have paid one more finding and
   cemented the duplication, so it was left exported and recorded here instead.
   Consolidating the eight copies is a separate change.

   **Resolved in #710.** The single implementation now lives in
   `ts/src/util/ensure-ascii.ts` — `util`, not `cli-common.ts`, because the
   copies spanned the `core`, `guardian`, and entry layers and the layer model
   permits none of them to depend on `cli`. All nine call sites import it, and
   `ts/test/shared-helper-single-source.test.ts` fails if a ninth copy is
   declared. The measured entropy count fell by exactly one (the dead export),
   which is the point worth keeping: the gate could only ever see the one
   finding, while the eight copies it could not see were the actual defect.

4. `scripts/entropy-ratchet.mjs` compares the count from
   `harness cleanup --findings-json` against that baseline and fails above it.
   `continue-on-error` is gone from the step.

5. **A missing count fails.** No contract line in the output means nothing was
   measured, and the script exits 3 (abstained, per ADR 0009) rather than
   reading the absence as zero findings. This is the property that matters most:
   without it, a future startup failure would produce a green ratchet, which is
   the #544 bug rebuilt one layer higher.

6. **`entropy.excludePatterns` is declared in-repo, not inherited (#677).** The
   CLI's schema default is `[...skipDirGlobs(), '**/*.test.ts']` — a
   TypeScript-shaped list applied to a repo whose npm package is tested with
   `node --test` over `.js` files. All 32 of them were scanned as ordinary
   source and every one came back unreferenced by construction, a pure analyzer
   artifact absorbed into the baseline. Declaring the key **replaces** that
   default rather than extending it (zod `.default()`, not a merge), so the
   build-output globs are carried explicitly next to the test globs. That is the
   hazard the "Alternatives Considered" section below originally rejected the
   key over; it is handled by test, not by care.

7. **RETIRED 2026-08-18 (#694, #745) — the floor is gone; upstream fixed it.**
   CLI 11.2.0 shipped the `extractFileLinks` fence-awareness fix
   (Intense-Visions/harness-engineering#1342) and the `Documentation drift`
   category fell **24 → 0** with no change to this repo. Measured both ways on
   the same commit (`aa36af6`) in a clean worktree: 11.1.1 reports 281 findings
   with 24 drift, 11.2.0 reports 257 with 0, dead code unchanged at 10. The
   ceiling moved 291 → 267 to match.

   Two things corroborated that this was an upstream FIX and not a detector
   going dark, since a count falling and a check going silent are
   indistinguishable from the number alone. First, the per-finding
   classification recorded below — 56 occurrences, 56 fenced, 0 bare — which
   identifies the disappeared set as exactly the Class A defect rather than an
   aggregate coincidence. Second, `scripts/check_doc_links.mjs`, which is
   fence-aware, spans a larger denominator, and is asserted strict-at-zero in
   the blocking suite; it does not move when the harness CLI floats, so the real
   dead-link signal never depended on the drift check. A planted bare broken
   link was also checked and is still reported, but that is only a smoke check:
   fence awareness is what changed, so a bare link exercises the path that did
   not, and it cannot fail by construction. Use a fenced/unfenced pair if a
   probe is wanted next time.

   **The rest of this item is kept as the historical record** of why the floor
   was accepted rather than muted — the reasoning is what made the prediction
   falsifiable, and the `docPaths` allowlist analysis below still governs. Every
   one of the 27 findings `harness ci check` reports resolves correctly for a
   reader. Two defects in `@harness-engineering/core` 11.1.1, neither of them
   ours to patch:

   | class | count | defect                                                                                                                                                                |
   | ----- | ----: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | A     |    24 | `extractFileLinks` has no fence awareness, so a link quoted inside a ` ```markdown ` fence is resolved relative to the quoting plan instead of the file being quoted. |
   | B     |     3 | `slugifyHeading` runs `.trim()` before hyphenating, so `## 📖 Usage` slugs to `usage`; GitHub keeps the space the emoji left and produces `-usage`.                   |

   Filed upstream as `Intense-Visions/harness-engineering` — see the
   Consequences below for what happens when it ships.

   **The local mute was rejected.** The one lever harness offers is
   `entropy.drift.docPaths`, which is an **allowlist**: narrowing it to drop
   `docs/plans/` and `docs/changes/` also drops `docs/knowledge/`,
   `docs/runbooks/`, and every doc directory added after the list is written.
   `docs/changes/` is precisely where #676 found real dead links, so the trade
   on offer is 27 false positives in exchange for a denominator that shrinks
   silently — the shape this whole ADR exists to refuse.

   **Amended by #719.** The floor was re-measured at 97bb15f against
   `@harness-engineering/cli` 11 and reads **24**, all Class A; the 3 Class B
   anchor findings no longer appear. #719 proposed a second local mute on a
   different reading of those 24 — that they are _archival link rot_, historical
   plan documents pointing into a repo layout that legitimately no longer exists
   — and offered two levers: excluding `docs/plans/**` and
   `docs/changes/**/plans/**` by path, or an `archived: true` frontmatter key
   `check_doc_links.mjs` would honour.

   The reading does not survive measurement. Every one of the 24 targets was
   located in its source file and tested for fence membership: **56 occurrences,
   56 fenced, 0 bare.** Not one is a link a reader could follow and fail on, so
   none of them is rot. They are the Class A defect above, arriving under a new
   name.

   Both levers are therefore declined, and for the same reason the `docPaths`
   mute was: `docs/changes/` is where #676 found 26 genuinely dead links, so an
   archived-tree exclusion blinds the check over the one directory in this repo
   with a proven failure history. The frontmatter variant is worse than the path
   list rather than better — it is self-service, invisible from any config file,
   and grants any future document a permanent exemption for the cost of one
   line. Neither trade is on offer.

   The decline is pinned by test rather than by this paragraph, because an
   exclusion is cheap to add later by someone reading only the issue:
   `doc-links.test.ts` → `archived plan documents (#719)` asserts that a dead
   link in either archived tree is reported, that an `archived: true`
   frontmatter buys no exemption, and that the fenced shape those plans actually
   carry stays quiet. Verified live at the same commit by appending a dead link
   to `docs/plans/onboarding.md`: exit 1, named at
   `docs/plans/onboarding.md:668`, over 251 scanned files; exit 0 once removed.

   **What is not accepted is the loss of signal.** A standing floor of 27 means
   finding #28 — a genuinely dead link — is invisible, which is the exact cost
   #676 was opened to remove. `scripts/check_doc_links.mjs` restores it: the
   same check, implemented correctly, on a **larger** denominator (249 Markdown
   files versus the drift check's `docs/**` plus READMEs), with no path
   allowlist and an exit-3 abstention when the walk finds nothing.

   It measures 0 today, but it did not on its first run: it found **five
   genuinely dead links that survived #676** — three `docs/adr/` targets
   orphaned by the move to `docs/knowledge/decisions/`, and two `docs/wiki/`
   links to `agents/skills/` missing a path segment — all repaired in the same
   change. Every one is a reference-style definition (`[label]: path`), a form
   `extractFileLinks` does not read at all, so they were never among the 27 and
   no amount of triaging that number would have surfaced them. That is the case
   for building the check rather than only documenting the floor: the detector
   is not merely noisy, it is also silently narrow. At 0 it is strict at zero
   rather than ratcheted — there is nothing to triage.

   Files carrying a generator's `Do not edit` stamp are counted and printed but
   do not gate: `harness generate-agent-definitions` emits 30 links to
   `references/*.md` files it never writes, which is a third upstream defect and
   not one a commit here can fix. That exclusion keys off the generator's own
   stamp rather than a path list, so it cannot go stale the way `docPaths`
   would.

   The change costs four findings against this very ratchet: **292 → 296**,
   leaving **1** of headroom under the 297 ceiling. All four are
   `ts/test/doc-links-testkit.ts` and its three exports — the "testkit imported
   only by `*.test.ts`" category triaged above, arriving again. The testkit is
   not optional: with the helpers inline in the spec file, `check-arch`
   attributes the entire 263-line `describe` body to whichever module-scope
   helper was declared last and reports three new complexity violations;
   extracting them drops that to zero. Measured both ways before choosing. The
   ceiling is **not** raised to absorb it — one finding of headroom is the
   honest state, and the next addition needs a re-triage rather than a bigger
   number.

   It deliberately adds **no CI job**. `ts/test/doc-links.test.ts` runs the
   script against the real repository inside `npm test`, which is already the
   required `TS engine (pilot)` check — so the gate is hard without a new entry
   in `.github/required-checks.json` and without the ruleset edit ADR 0011 would
   otherwise require.

Strict-at-zero is explicitly rejected for now, matching the #485 dogfood
convention — advisory, then triage, then ratchet.

## Amendment — 2026-08-20: the ceiling is only as good as the instrument (#744)

This ADR chose an **absolute** ceiling. That choice has a consequence nobody
wrote down at the time, and it has now cost two silent drifts: the number on the
left of the comparison is produced by a tool the workflows pin as a **floating
major** (`@harness-engineering/cli@11`), so the analyzer behind the count can
change without a single commit to this repository.

Both moves were downward, which is why neither was noticed:

| CLI move                | Count      | Ceiling at the time | Slack it created |
| ----------------------- | ---------- | ------------------- | ---------------- |
| 11.1.1 -> 11.2.0 (#694) | 281 -> 257 | 291                 | 34               |
| 11.2.0 -> 11.3.0 (#744) | 257 -> 147 | 267                 | **120**          |

The second is the serious one. For four days a gate that had just been
deliberately **tightened** to 267 would have required a 45% increase in entropy
to turn red. Nothing was broken, no test failed, and no human error occurred —
which is the whole point. As the baseline file's own `$whatIsGuarded` note
predicted _in writing_ before it happened, every offline guard compares the
baseline against itself (the ceiling did not rise; `measuredCount` matched its
declared gap; the CLI **major** still matched the pin), and a floating **minor**
clears a major check by construction.

A falling count is genuinely ambiguous — "the code got cleaner" and "the
detector went dark" produce the identical signal — so the 257 -> 147 drop was
corroborated three ways before the ceiling moved. The middle one is the one that
carries it:

1. **Purely subtractive.** 31 files stopped being flagged; **zero** were newly
   flagged, and no per-file count rose.
2. **A planted positive, in a live and currently-clean file.** Three
   unambiguously-dead exports appended to `ts/src/core/pattern-matcher.ts` moved
   the total 147 -> 150 and that file 0 -> 3. This is what rules out the
   per-file-dedup hypothesis, which the raw numbers look exactly like: nearly
   every surviving file had collapsed to exactly one finding, and a granularity
   change would produce that same shape. **The probe must go in a live file the
   scanner already reports as clean** — in a new file, the file itself is dead,
   so the increment cannot be attributed to symbol-level detection.
3. **The disappeared set is shipped code** — `guardian/adjudication.ts` (6),
   `analysis-emit.ts` (5), `github-paging.ts` (4), `pattern-matcher.ts`, and the
   per-skill `scanner.mjs` / `rules.mjs` trees: the test-only-consumer and
   workflow-invoked false-positive classes this ADR already documents.

### What changed

`scripts/entropy-ratchet.mjs` and `scripts/perf-ratchet.mjs` now take
`--cli-version`, supplied by a `Resolve harness CLI version` step in
`harness-quality.yml` that resolves the floating pin at run time. When the
baseline declares `harnessCli` and the running version disagrees — **or the
caller does not say which version it ran** — the ratchet **abstains** (exit 3,
per ADR 0009) instead of comparing.

Abstention, not failure, is the correct verdict and the distinction matters: the
tree may be perfectly healthy. What is _not_ true is that the measurement is
comparable to the ceiling, so there is nothing to compare, and "cannot verify"
is a finding rather than a pass. The remedy is the one both drift episodes
needed and neither got: re-measure in a clean worktree, and move `measuredCount`
and `harnessCli` in the same PR.

The perf baseline was re-measured in the same pass and had quietly drifted too —
recorded 237 at 11.1.1, actually 225, and the move belongs to the 11.1.1 ->
11.2.0 boundary rather than to 11.3.0 (11.2.0 and 11.3.0 both report 225 on the
same tree). Its gap was 20 rather than 120, which is precisely why it would have
gone on sitting there.

### What is still not guarded

- `measuredCount` remains a **memory of the last human run**, not a measurement.
  The instrument stamp beside it is now enforced, so it can be trusted that far
  and no further.
- **Excessive headroom is still only a log line.** A codebase that got cleaner
  must never turn the build red, so nothing forces a ceiling down except a human
  reading the nudge. That is a deliberate trade, and it is why the 120-point gap
  persisted for four days once created.
- The perf ratchet's implausible-collapse guard does **not** cover this. It
  fires below 25% of the baseline; the real drops were 55% (entropy) and 92%
  (perf). A collapse guard catches a detector going dark all at once, never an
  instrument that is merely different.

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
- Three structural test files guard the config itself:
  `ts/test/entropy-entrypoints.test.ts` fails if an entry point is untracked,
  globbed, or inside a skipped directory — the bug above, made unrepeatable —
  `ts/test/entropy-exclude-patterns.test.ts` fails if the exclude list stops
  covering a test-file shape that exists in `git ls-files` or drops a
  build-output glob, and `ts/test/entropy-ratchet.test.ts` pins the exit-code
  contract, including the abstention path. The first file applies its invariants
  to **both** entry-point keys and additionally asserts the two arrays are
  identical: JSON cannot share an array, so the duplication is real and the only
  thing stopping the two checks from silently walking different codebases is
  that assertion. The second derives its expectations from the repo's own file
  list rather than a fixed set, so the day someone adds a `.spec.js` the gate
  notices instead of passing vacuously.
- ~~When the upstream fix ships, the 27 should disappear on a CLI bump with no
  repo change.~~ **This happened, on 2026-08-18 (#694, #745).** CLI 11.2.0
  shipped the `extractFileLinks` fence fix and the drift category went 24 → 0
  with no repo change, exactly as predicted. The prediction is recorded as
  confirmed rather than deleted, because it is the only place the reasoning was
  written down before the outcome was known. `scripts/check_doc_links.mjs` stays
  either way: it covers more files than the drift check does, and it is the
  thing that would catch the regression — and it is now the thing carrying the
  dead-link signal alone.
- The perf check is `warn`-only under the default `--fail-on error`, so its 238
  findings do not gate a merge today. That is deliberate and matches the #485
  convention this ADR already follows — advisory, then triage, then ratchet.
  What changed is that the warning now reports a measurement instead of standing
  in for one.

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

> **Amended by #677 — partially.** The reasoning above still holds for the
> _triage_ categories (the fixture projects, the spike, the test-only `ts/src`
> modules): those stay in the baseline. It does **not** hold for `.test.js`,
> which was never a triage call at all — it is the analyzer applying a
> TypeScript-shaped default (`**/*.test.ts`, `**/*.spec.ts`) to a package whose
> tests are `.js`. The key is now declared, and the wholesale-replacement hazard
> is handled the only way it can be: the build-output globs are carried
> explicitly alongside the test globs, and
> `ts/test/entropy-exclude-patterns.test.ts` fails if either half goes missing.
> Measured 340 → 308 on CLI 11.1.1, and the rest of the report is byte-identical
> — the change is purely subtractive.

**Keep it advisory and annotate harder.** The step already annotates on failure
and it changed nothing — a warning that nobody has to act on is a warning nobody
acts on. That is the finding of #544, not a hypothesis about it.
