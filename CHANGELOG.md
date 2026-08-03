<!-- markdownlint-disable MD024 -->

# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This changelog starts at **v4.0.0**. Earlier releases (v1.0.0–v3.0.0, published
under the project's former name) are documented in the
[GitHub Releases](https://github.com/bop-clocktower/canary/releases) history.

## [Unreleased]

### Gates that got louder

Every surface below can now exit **3** (`abstained`) or print an unmissable
abstention line where it previously reported success over a **zero denominator**
— a check that verified nothing rendering as a pass. Exit 3 is reserved CLI-wide
for this meaning and nothing else
([ADR 0009](docs/adr/0009-exit-3-reserved-for-abstained.md)).

**A new exit 3 in your pipeline is the doctrine working, not a regression.** It
means that command was already verifying nothing — you just could not see it.
Handle it distinctly from exit 1: `1` is a real finding, `3` is an empty input.

| Surface                                                               | New behavior                  | When it fires                                       | Shipped |
| --------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------- | ------- |
| `migrate --check`                                                     | exit **3**                    | zero skills matched the resolved shape              | v6.4.0  |
| `migrate` (dry run)                                                   | loud abstention               | nothing left to migrate                             | v6.4.0  |
| `guardian pr-check`                                                   | exit **3**                    | empty diff, or every unit filtered out              | v6.4.0  |
| `guardian harden-gate --apply`                                        | exit **3**                    | zero observed check contexts on the branch          | v6.4.0  |
| `guardian analyze`                                                    | warns, exit 0                 | spec diff contains zero endpoints                   | v6.4.0  |
| `guardian validate-coverage`                                          | warns, exit 0                 | valid document with zero `files` entries            | v6.4.0  |
| `doctor`                                                              | exit **3**                    | every check skipped, or no check registered         | next    |
| `overlay lint`                                                        | warns, exit 0                 | overlay ships zero skills                           | next    |
| `review-test`                                                         | exit **3**                    | directory matched zero test files                   | next    |
| `flake-check`                                                         | exit **3**                    | directory matched zero test files                   | next    |
| `analyze` (flaky/spikes/common-failures/regression-candidates/digest) | warns, exit 0                 | zero runs recorded                                  | next    |
| `analyze area-health`                                                 | warns, exit 0                 | always — its row set is hardcoded empty             | next    |
| `history flaky`                                                       | warns, exit 0                 | zero runs recorded                                  | next    |
| `history summary`                                                     | warns, exit 0                 | zero runs (previously reported a fabricated `0.0%`) | next    |
| `history migrate`                                                     | warns, exit 0                 | zero runs migrated                                  | next    |
| `canary-blackhawk` / `canary-savant`                                  | warns; **`--strict` exits 3** | zero files scanned                                  | next    |
| `canary-katana`                                                       | warns; **`--strict` exits 3** | the diff was empty                                  | next    |

Audited and deliberately **unchanged**: `heal-test` (its denominator is always
exactly 1) and `skills run` (its exit ladder already used 3 for a refusal to
invoke, which is an abstention). Both carry conformance rows recording the
classification.

`--json` surfaces gain `checked` and `abstained` additively. Where the payload
is a bare array with nowhere to put them, stdout stays byte-identical and the
notice goes to **stderr**, so existing parsers are unaffected.

## [6.4.0] - 2026-08-02

The **silence** release. Every fix here is the same defect wearing a different
coat: a surface that reported success while verifying nothing. A gate that
matched zero skills and exited 0. A declared list that parsed as empty and
migrated nothing. An MCP server the plugin manifest has advertised since v6 that
was never shipped. Detectors so noisy their real findings were unreadable, and
an advisory CI step nobody read. Canary ran effectively broken in a consuming
repo for ~7 weeks and no surface said so.

This release starts turning that into a rule rather than a series of one-off
fixes: **a check that verified zero items has abstained, not passed.**

### Added

- **No-silent-abstention — Wave 1 machinery** (#508):
  `ts/src/core/gate-result.ts` is the doctrine's load-bearing helper —
  `GateResult`, `EXIT_ABSTAINED = 3` (now reserved CLI-wide), and
  `gateOutcome(result, kind, opts?)`. Gates exit 3 on a collapsed denominator,
  advisory surfaces warn loudly at exit 0, and skipped entries always render
  rather than folding into "passed". Hardened so the helper cannot be talked out
  of abstaining: invalid denominators (`NaN`, negative) abstain rather than
  pass, findings always outrank abstention, and skip names are control-char
  sanitized so a crafted skill name cannot inject ANSI into a gate summary.

  A **conformance registry** (`ts/test/gate-conformance.test.ts`) is the part
  meant to outlive Wave 1: the canonical table of every gate and its
  zero-denominator behaviour, with fixtures that collapse the denominator
  through the real CLI. New gates join the table rather than re-deciding the
  question. Seeded with `migrate --check` (gate) and `migrate` dry-run
  (advisory); #503's shipped `FreshnessReport` is retrofitted onto the helper
  with byte-identical output, pinned by a coupling assert.

  Waves 2–5 (guardian, doctor/npm layer, the `review-test` / `flake-check` /
  `analyze` / `history` long tail, and CI-template annotations) follow.

- **Savant inline suppression pragma** (#496):
  `savant-ignore <RULE>[,<RULE>] -- reason`, matching blackhawk's #393 pattern —
  same-line and preceding-line binding, **mandatory reason** (a reason-less
  pragma does not parse, because suppression is a decision and not an evasion),
  wrong-rule pragmas inert, and suppressed findings surfaced in their own count
  and in `summary.suppressed` rather than silently dropped.

  One deliberate divergence from blackhawk, and it was not optional: savant's
  pragma parser applies the anchor-in-string guard from #495, so a
  `savant-ignore` whose text begins inside a string literal is not a
  suppression. Without it, test data describing a pragma would suppress real
  findings.

- **Dogfooding goes strict in CI** (#485): blackhawk and savant now run over
  canary's own suites with `--strict` in the `Skills (JS)` job, replacing a
  single advisory step. An advisory gate whose findings nobody reads is the #413
  dynamic reproduced in our own CI — strict is what pins the triaged-to-zero
  state. Both scanners now skip `fixtures/`, `__fixtures__/`, `__mocks__/` and
  `testdata/` during discovery: a file under `fixtures/` never _runs_ as a test,
  so a temporal smell in it is a property of the data, not a defect.

### Fixed

- **Detector false-positive rates of ~80%** (#493): blackhawk went 15 findings →
  **3**, savant 56 → **7**, on canary's own suites. The obvious fix — strip
  string literals before matching — _breaks real detection_, because blackhawk's
  `LOCAL_TZ` rule deliberately matches the `%z` inside `strftime('…%Z')` quotes.
  A match is instead rejected only when its **anchor token's start index** falls
  inside a string literal, so `pyFile('time.sleep(1)')` is rejected while
  `d.strftime('%Y %Z')` is kept, and `${…}` interpolation is scanned as code.

- **Testkits leaked caller-supplied env overrides** (#497): both CLI testkits
  snapshotted only their fixed `*_ENV_KEYS` lists before mutating, but the `env`
  option applies **arbitrary** caller keys — so an off-list override leaked into
  `process.env` for every later test in the worker. A latent order-dependence
  bug in the testkits of the tool that exists to catch order-dependence bugs,
  and the dogfooding program's second real catch once #495 gave savant the
  precision to see it.

- **`canary_shape` override discarded in monorepos** (#502): `detectFramework`
  honored the explicit `.canary/company.json` override only inside the root
  `_CONFIG_PROBES` loop, so in any repo with no root framework config — i.e.
  every monorepo — user intent was silently dropped and shape resolved to
  `unknown`, making overlay adoption impossible with no repo-side workaround.
  Detection is now split: `probeFramework` runs the unchanged probe tiers and
  `detectFramework` applies the explicit shape unconditionally on top. The
  pre-existing override test covered only the branch that already worked.

- **`migrate --check` exited 0 having verified nothing** (#503): a resolved
  shape matching **zero** overlay skills rendered abstention as success, so any
  shape-detection regression made the gate permanently green. It now exits
  **3**, distinct from 0 (in sync), 1 (drift) and 2 (local edits); `--json`
  gains `checked` and `abstained`, and the markdown says what to fix.

- **Overlay lint and migrate disagreed on what a `SKILL.md` declares** (#501):
  three parser divergences, all reconciled toward tolerating standard YAML.
  Plain multiline `description:` scalars parsed as empty, so lint reported ~20
  healthy skills as missing a description. Custom `deploy_to` shapes
  hard-errored in lint while migrating fine, and are now a typo-guard warning.
  Most costly: when prettier rewrapped an over-long `install_workflows` flow
  list onto a continuation line, the parser read it as **empty** and migrate
  silently installed zero workflows while everything stayed green. Wrapped flow
  lists and block sequences now parse, and an unterminated list is a loud parse
  diagnostic — a non-empty declaration can no longer read as a silent empty one.

- **The plugin's MCP server was never shipped** (#507): `plugin.json` has
  declared `mcpServers.canary-mcp.command = "canary-mcp"` since v6, but the npm
  package ships only the `canary` bin — so the plugin's MCP server, and the
  three bundled agents whose only tools are `mcp__canary__*`, have been dead on
  every plugin install since the TS cutover. Adds `npm/bin/canary-mcp.js`, a CJS
  wrapper that dynamic-imports the bundled ESM engine and awaits `runStdio()`.
  All failure paths write to stderr only, so stdout stays a clean JSON-RPC
  stream.

- **`canary feedback` payload defects** (#506): `version` reported `"unknown"`
  (the pilot stub — it now comes from the same source `canary -V` prints); the
  `python` key carried `process.version` and was actively misleading now the
  Python engine is retired, so it is renamed `runtime`; and titles were hard-cut
  mid-word at 60 code points, now breaking at the last word boundary inside the
  budget with an ellipsis, astral-safe slicing preserved.

- **Savant's `detectFramework` tests were not hermetic** (#511): two phase-4
  tests injected the `exists` seam (step 3, config markers) but not `readdir`
  (step 2, directory scan), so the scan ran against the real cwd — any checkout
  with a `tests/` directory containing `.py` files resolved `pytest` before the
  mocked probe was consulted, false-failing both. Clean CI passed, so it bit
  only local development with a dirty tree. Both fs seams are now documented in
  the `detectFramework` JSDoc, which previously omitted `readdir` entirely.

## [6.3.0] - 2026-07-29

Two live user-facing fixes plus the overlay-adoption feature. Both fixes are for
failures that were **silent** — a shipped feature permanently disabling itself,
and a usage request mutating the working tree.

### Fixed

- **Guardian — Tier-2 authoring no longer disables itself permanently** (#456):
  the stage-and-block-once loop guard had two halves and only one survived. The
  half that CLEARED the `canary-guardian-authored` sentinel on the next commit
  was deleted as dead code in #449, and nothing replaced it — so once the
  guardian authored tests in a clone **even once**, authoring was silently dead
  in that clone forever, with `author-plan` reporting a `loop-guard` skip that
  claimed "this run" while meaning _forever_. The sentinel now records `HEAD`
  and the guard fires only while `HEAD` still matches, so committing the staged
  tests re-enables authoring with no manual step. Every failure path (absent,
  unreadable, malformed, unresolvable `HEAD`) **fails open** — the original bug
  was fail-closed-forever, so a fix preserving that shape would not have been a
  fix.
- **Skill CLIs — `--help`, unknown flags, and value arity restored** (#472): the
  Python→JS ports dropped argparse and with it three behaviours. Six skill CLIs
  now share one contract — `--help`/`-h` to stdout at exit 0, unknown flag →
  `unrecognized arguments:` at exit 2, missing/invalid value → exit 2, and
  `--flag=value` accepted.

  Three of the bugs found were worse than the one reported.
  **`canary-katana --help` ran the full scan and wrote
  `.canary/quarantine.json`** — a usage request mutating the working tree.
  **`canary-savant --seed` silently fell back to a random seed** on a missing
  _or_ invalid value, and truncated `9007199254740993` to `…992`, so the seed
  used differed from the seed asked for. **`canary-test-reporter` discarded
  typed arguments at exit 0** while reporting success. Three CLIs also shipped
  non-executable, so `canary skills run <skill> -- --help` failed with a bare
  exit 1 and no output.

  `canary-shadow` is deliberately **not** covered — it needs a contract decision
  rather than a fix (#478).

### Added

- **Workflow templates install during `canary migrate`** (#459): an overlay
  skill may declare `install_workflows: [templates/<file>.yml]` (optionally
  `<shape>:`-prefixed to pick a variant, plus a `workflow_template_version`) and
  `migrate` installs the template into the consuming repo's
  `.github/workflows/`. Previously the template bytes did reach the consumer —
  whole skill directories are copied — but sat inert under `.canary/skills/`, so
  adopting repos ended up with skills and no running guardian.

  **A consumer's CI is theirs.** Unlike deployed skills, which the overlay owns
  one-way (#334), a workflow that differs from the template is **reported and
  never overwritten**; `--force` is the deliberate opt-in. Workflow status also
  never changes the `migrate --check` exit code, so the gate cannot nag about a
  hand-tuned workflow. The template version recorded in
  `.canary/skills/.deploy-manifest.json` is what lets a corrected template (e.g.
  the #369 guardian gate that silently no-ops) be offered to repos that already
  adopted a broken one.

- **`coverage_report_path` / `sut_controllers_path` in `.canary/company.json`**
  (#459): repo-relative pointers for generated workflow YAML. Both are validated
  as repo-relative — an absolute path or one containing `..` is dropped with a
  warning, since the value is interpolated into generated CI.

## [6.2.0] - 2026-07-29

A **guardian-correctness** release. Three of the four fixes address failures
that were _silent_ — a gate that reported success without ever evaluating
anything, a comment that could vanish on large PRs, and findings that could
never have been true. Also lands the first reachability primitive and closes a
long-standing gap where the wiki described an engine that had not existed since
v3.0.

### Added

- **Reachability sweep primitive** (#452): `ts/src/analysis/reachability.ts` — a
  generic crawl primitive that enumerates links on a surface and asserts each
  resolves, with a configurable external-host allowlist (matching subdomains but
  never lookalikes). Catches dangling routes and 404s that targeted tests never
  look for.

  Its defining property is that **a dead link and a slow link are never
  confusable**. A 404 is `broken` and is a defect; a timeout, DNS failure, or
  refused connection is `unreachable` and is explicitly _inconclusive_ — carried
  with its reason and never asserted on. Conflating the two is how a broad sweep
  becomes a flaky test teams learn to ignore. The same principle separates 5xx
  (`server-error` — the target exists and is unwell) and 401/403 (`ok` —
  auth-walled, not missing). Ships with `createHttpProbe`, so callers do not
  re-implement (and quietly lose) that distinction themselves.

- **Guardian — `canary.guardian.pr.heuristicExclude`** and a repeatable
  `--heuristic-exclude <glob>` flag (#413), suppressing the heuristic tier for
  paths a naming heuristic cannot judge, without dropping them from the gate
  entirely the way `skipGlobs` does.
- **`canary-ci-ready` scores suite runtime against perf baselines** (#338): with
  the harness MCP available, check 5 compares p95 to `get_perf_baselines` and
  records the run back, instead of judging against an absolute clock that cannot
  tell a suite that always took 11 minutes from one that regressed to it. "No
  baseline yet" is a **skip** (baseline capture), not a failure.
- **`canary-test-pipeline` probes harness once** in Phase 0 and threads the
  verdict, then writes its health report to `.harness/analyses/` (#338).
  Per-phase rediscovery allowed a _mixed-fidelity_ run whose report was
  comparable to nothing.
- **CI: Markdown code-fence guard** (`scripts/check_doc_fences.mjs`) and **wiki
  Mermaid render check** — two failure modes that were previously silent.
- **Pre-commit prettier gate** mirroring the exact `format:check` CI runs, for
  the packages a commit touches.

### Fixed

- **Guardian — `pr-check` no longer silently no-ops in CI** (#369): with
  `--diff` omitted it ran a bare `git diff` (working tree vs. index), which is
  **empty on a clean `actions/checkout`** — so the gate scoped zero paths,
  exited 0, and posted nothing. An adopting repo saw a green check that had
  never evaluated a PR (confirmed across ~5 real downstream PRs). In CI an
  omitted `--diff` now resolves the PR diff from the base ref and runs
  `git diff <base>...HEAD` — the triple-dot merge-base form, so commits landing
  on the base branch mid-PR are excluded. When no base rev resolves **and** the
  fallback yields zero paths, the run warns loudly instead of reporting success.
- **Guardian — heuristic tier no longer manufactures gaps on non-source paths**
  (#413): for a config dotfile or lockfile there are no symbols and no test will
  ever name it, so the heuristic verdict was **structurally always "uncovered"**
  — a guaranteed false positive. Every 👎 on such a finding also drove
  `precision = TP / (TP + FP)` down, holding a repo below its soft→hard
  promotion bar for findings that could never have been true. Suppression is
  scoped to the **tier**, never the path: a coverage- or graph-verified finding
  on the same file still fires.

  **Behaviour change:** the extension floor is not config-defeatable —
  `skipGlobs: []` re-admits a lockfile to the gate but no longer produces a
  heuristic finding on it.

- **Guardian — sticky comment no longer risks exceeding GitHub's size limit**
  (#457): GitHub rejects a body over 65,536 characters and the post path reports
  that as "could not post", so a large PR silently produced nothing. Rows now
  fill against a 60,000-char budget in severity order — a critical finding is
  never dropped to make room for a low one — with an overflow line pointing at
  the analysis record, which is never truncated.
- **Guardian — comment no longer prints every path twice** (#458): findings
  rendered `path (path)`. The comment is also restructured into a table with a
  plain-English confidence footnote and an actionable header.
- **`canary_shape` is no longer reported as an ignored unknown field** (#459):
  it decides which overlay skills deploy, so warning that it was "ignored" told
  adopters the one field driving their adoption did nothing.
- **Corrupted code fences in four shipped docs** (#464): a fence closed with a
  language tag opens a _new_ block, so the rest of the document renders as code.
  `canary-critical-areas` had ~100 lines — its entire scoring methodology —
  swallowed this way.

### Documentation

- **`Architecture-Deep-Dive` corrected** (#465): the canonical architecture page
  described an in-process orchestrator calling an LLM — removed in **v3.0** —
  contradicted itself two paragraphs apart, pointed at a module that does not
  exist, and documented a `_sanitize_extension` security layer that is absent
  from the codebase. Rewritten around the real boundary (deterministic
  model-free engine; LLM judgement in the host session), with Mermaid diagrams
  for engine architecture, data flow, and the guardian `pr-check` flow.
- **PR-guardian guide corrected**: it documented the pre-commit surface as
  running via `hooks/guardian_precommit.py`, deleted as dead code in #449. Also
  discloses a live limitation — the authored-sentinel is never cleared, so
  Tier-2 authoring stops after its first run in a clone (tracked in #456).
- **AGENTS.md**: new **Diagrams** convention; the "TypeScript pilot" section
  corrected (the migration finished in v6 — `ts/` _is_ the engine).

## [6.1.0] - 2026-07-27

**Python-zero.** Completes the v6 cutover: no Python remains in anything a user
or plugin consumer installs or runs.

### Changed

- **Plugin hooks ported Python → Node ESM** (#449) — `block-no-verify`,
  `protect-config`, `quality-gate`, `pre-compact-state`, and the shared
  `_harness_dedup` helper, each parity-verified against its original. This
  removed the last Python that **plugin users** would have needed installed.
- **The four maintenance scripts ported Python → Node** (#448).

### Added

- **`canary-shadow`** — differential parity-testing skill (#447).
- **Removed-symbol guard extended** to flag `agent/` engine references, with the
  doc drift it found fixed in the same change (#450).

### Removed

- `hooks/guardian_precommit.py` and `check-proprietary.py`, deleted as dead code
  — unwired, with no live config referencing them (#449). **Note:** the guardian
  authored-sentinel loop guard depended on the former to clear it; that half was
  not replaced. See #456.

## [6.0.0] - 2026-07-27

**The TypeScript engine ships.** The Python engine is retired and the npm
package now bundles and runs the TS engine directly.

### Changed

- **BREAKING — the engine is TypeScript** (#442, #446). `agent/` is deleted,
  pytest is dropped, and the npm package ships `ts/` → `npm/dist/engine/`.
- **BREAKING — no per-OS binary and no PyPI package.** The PyInstaller spec and
  the PyPI publish job are gone; **npm is the sole distribution channel**. This
  also removed the ~29 MB postinstall binary download that could hang an
  `npm install` for over 20 minutes (#379).
- `npm` `files` narrowed to `bin/canary.js` so no stray binary can ship (#443).

### Added

- **The full engine port**, landed as waves: guardian API-diff, coverage,
  pr-comment/hard-gate, and pr-check (#426–#429); the core clusters — env/CI
  detection, reporting/feedback/validation, scaffolder/skill-registry,
  workflow-discovery/ticket-updater, company-knowledge/migrator (#430–#436);
  then the guardian CLI (#438), the MCP server (#439), and the main CLI (#440).
- **Golden-parity harness** extended across detection, pattern-healer, reporter,
  scaffolder, feedback, config-validation, and workflow-discovery (#437).
- **TestTracker ingest reporter** (#420).

## [5.15.0] - 2026-07-25

A large **additive** release centered on the PR guardian and the completion of
the skill-side move to Node. The `canary` CLI is unchanged and still runs on
Python — the one behavior change is that the **bundled skills now require
`node>=20`** instead of `python3` (they are agent-invoked; the skill runner
honors each skill's `requires:`). The engine's own Python→TS migration continues
in the `ts/` sandbox and is reserved for a future major.

### Added

- **Guardian — Cobertura coverage** (#412): `coverage.xml` is parsed into the
  **coverage-verified** tier, extending the strongest fidelity label to
  Java/.NET/JS-Istanbul pipelines. Pinned to the canonical line-level shape;
  non-Cobertura XML falls through rather than being guessed at.
- **Guardian — coverage-json contract + validator** (#417): the coverage-json
  format the guardian consumes is now a frozen v1 contract
  (`docs/specs/coverage-json-contract.md`), plus
  `canary guardian validate-coverage <file>` — loud where the parser is silent
  (error = coverage lost, warning = degraded), so a producer can gate its CI.
- **Guardian — `canary guardian harden-gate`** (#418): automates the admin step
  of the soft→hard promotion — registers the guardian status check as a required
  check in branch protection (merging, never clobbering), verifies the check
  context actually reports before requiring it, and fails loudly with a manual
  playbook when it can't (no admin scope / unsupported plan).
- **Guardian — advisory weak-test finding** (#419): flags an added test that
  defines a test function but asserts nothing. Advisory (never gates), tuned for
  precision (snapshot/table-driven and `assert`/`expect`/chai/`assert_*`-helper
  tests are not flagged). Toggle `canary.guardian.pr.weakTests`.
- **Framework capability tiers** (#414): `canary frameworks` now shows a
  code-derived support tier per framework — `full` (scaffold + run) /
  `executable` (run only) / `catalog` (listed only) — instead of subjective
  prose, with a drift guard that keeps the tiers honest.
- **`canary-ship` skill** (#415): a review-gated ship gate (parallel adversarial
  review → resolve → commit → PR → merge → watch CI).

### Changed

- **Skills moved to Node** — `canary-savant`, `-blackhawk`, `-katana`,
  `-instrument`, `-fail-fast`, and `-test-reporter` are ported Python→ESM
  (`requires: [node>=20]`); no bundled skill ships Python. Behavior is preserved
  byte-for-byte (themed reporter output, JSON artifacts, digests).
- **Framework scaffolding degrades gracefully** (#414): scaffolding a known
  framework that has no template now returns actionable guidance (and the run
  command) instead of raising; `canary migrate` records it as a follow-up rather
  than reporting a false "migration complete".
- **Coverage-json parsing tightened** (#417): hit counts and line numbers must
  be genuine JSON integers — a stringly-typed or fractional value is rejected
  (loudly, via the validator) rather than silently coerced/truncated.

### Fixed

- **README skills index** synced to the installed skill set and command count
  (#416).
- Docs: warn that the PyPI package (`canary-test-ai`) is not yet published
  (#404).

### Dependencies

- Bump the `npm_and_yarn` group (#391).

## [5.14.0] - 2026-07-22

An **additive** release — no breaking changes. New repo-setup and
customer-facing report-branding surfaces, two `canary-katana` correctness fixes,
and an overlay-doctor scoping fix. Also lands the internal Python→TS engine
migration (isolated `ts/` sandbox; the shipping product is unchanged).

### Added

- **`canary setup`** — top-level alias for the `company-knowledge init` wizard,
  so repo setup is discoverable from `canary --help`. Bare `canary init` (no
  framework) now prints a setup-vs-scaffold signpost instead of an arg error,
  and warns when `.canary/company.json` is absent (#344).
- **Brand assets + `report_branding()`** — `.canary/company.json` accepts an
  open `brand` block (recognized keys validated, any extras passed through;
  asset paths resolve relative to the repo).
  `CompanyKnowledge.report_branding()` hands report generators the brand data
  plus a "made with Canary" attribution and an optional voice line
  (`CANARY_NO_FLAVOR` off-switch). Intended to be rendered through the UI-polish
  skills; the engine supplies data, overlays own the pixels (#340).
- **`CANARY_INVOCATION_DIR`** — overlay `doctor.json` `command-succeeds` checks
  now receive the directory `canary doctor` was launched from, so a check can
  validate consuming-repo runtime artifacts rather than only the overlay clone
  (#378).

### Fixed

- **`canary-katana`: survives real monorepos** — the alarm scan no longer
  crashes on non-UTF-8 files under test dirs, and prunes `node_modules`/`.git`/
  build/cache dirs instead of walking the whole tree (which timed out) (#395).
- **`canary-katana`: `.fixme` conversions are quarantines, not deletions** —
  `test.fixme` / `test.describe.fixme` no longer misclassify as removed tests,
  which had fired spurious "last-coverage-removed" alarms (#400).
- **Overlay marketplace install** — the `canary` plugin uses a relative
  `source: "."`, fixing a misleading "source type not supported" install failure
  (#376).

### Internal

- Python→TypeScript engine migration, subsystems 1–4 (analysis, history, core
  framework-recommendation, core scanners) ported into an isolated, parity-
  tested `ts/` workspace behind a new `ts-validate` CI job. The shipping Python
  engine is unchanged (#388, #389, #392, #394).
- Ratcheting engine coverage gate in CI (#386); `actions/setup-node` bumped to
  v7 (#322).

## [5.13.0] - 2026-07-22

An **additive** release — no breaking changes. Ships the first batch of
BoP-themed test-intelligence skills plus a hook-scoping fix.

### Added

- **`canary-katana` skill** — deleted-test quarantine. Scans a diff for removed
  or skipped tests, records them in a ledger, and raises a severity-ranked alarm
  when a deletion removes the last coverage of a critical area (by name match or
  directory heuristic). Ships with a CLI (`--diff-file`, `--critical-areas`,
  `--json`, `--strict`).
- **`canary-blackhawk` skill** — flaky-test anti-pattern scanner. Flags
  flakiness-inducing patterns in test code (real `sleep`-based delays,
  local-timezone dependence, and related smells) with a CLI and JSON output.

### Fixed

- **format-check hook no longer blocks out-of-repo writes.** Files edited
  outside the project root (e.g. `~/.claude` memory or scratchpad writes) are
  now skipped instead of failing the hook. Symlinked project roots are
  normalized so in-repo files are still linted (#380).

## [5.12.0] - 2026-07-20

A large **additive** release — no breaking changes. The `canary doctor`
`--persona` flag was renamed to `--audience`, but `--persona` (and the
`persona:` doctor-manifest field) keep working as legacy aliases.

### Added

- **`canary doctor --json`** — a machine-readable report
  (`{ version, checks, allPassed, warnings }`) on stdout, with a documented
  canary-owned contract. The human report no longer claims parity with
  `harness doctor` — only the top-level `allPassed` intentionally matches.
- **Overlay skill-name conflict detection + declared precedence** — when two
  overlays ship the same skill name, a numeric `precedence` in `overlays.json`
  decides the winner (higher wins). `canary overlay list --conflicts` reports
  collisions, and `canary doctor` fails on an unresolved one. Both runtimes
  resolve the same winner.
- **Skill runtime-requirement verification** — skills declare
  `requires: [python3>=3.10, node>=20]` in frontmatter; `canary doctor` verifies
  the tools are installed (and new enough) for every installed skill.
- **`canary overlay lint`** — validates an overlay against the authoring
  contract (frontmatter floor, `deploy_to` targets, `cli:` paths, `doctor.json`)
  and exits non-zero on any error, for CI.
- **`canary frameworks`** and **run-command exposure** — a new command dumps the
  framework registry, and `canary recommend --json` now includes the chosen
  framework's `execution_command` (with a `{file}` placeholder) and `ci_flags`.
- **`canary feedback`** — opens a pre-filled GitHub issue with non-sensitive
  context (version/OS/Python/install); never environment variables or file
  contents.
- **`canary migrate --check`** — a no-write overlay freshness gate (exit 0 in
  sync / 1 drift / 2 a deployed skill has local edits; `--json` for CI).
  Deployment is now strictly one-way via a
  `.canary/skills/.deploy-manifest.json` content hash, so an update never
  clobbers local edits.
- **Framework-registry expansion** — five new frameworks (mutmut, WebdriverIO /
  Appium, Hurl, property-testing via fast-check/hypothesis, LLM-eval via
  promptfoo) plus Tier-0 contract repairs (every framework hint now resolves).
- **Context-aware environment detection** — `agent/core/environment_detect.py`
  derives `BASE_URL`, suite type, and an auditable SDET-vs-manual user-level
  signal, surfaced additively as an `environment` block on the MCP
  `analyze_file` response.
- **Harness impact primitives** — `canary-critical-areas` and
  `canary-failure-impact` call harness's `get_impact` / `compute_blast_radius` /
  `get_critical_paths` / `detect_anomalies` when the MCP is present, with the
  grep/`git log` fallbacks preserved.

### Changed

- **`canary doctor --persona` → `--audience`** — ends a semantic collision with
  harness's persona system. `--persona` and the `persona:` manifest field remain
  as documented legacy aliases.
- **Pinned the harness CLI to a major** (`@harness-engineering/cli@9`) across
  all dev-gate workflows, so an upstream rename is a deliberate PR, not a silent
  break.
- Canonicalized capability names across the routing docs; adopted Prettier on
  the hand-maintained `npm/` TypeScript bundle; added long-running-build
  guidance to the suite-executing agents; and added a guard against regeneration
  clobbering canary-local hook edits plus a weekly architecture-timeline
  snapshot.

### Fixed

- **`canary migrate`** no longer misclassifies a skills/docs overlay repo as a
  migratable test suite — the error now distinguishes "not a test project" from
  "no config."
- Isolated the bundled-skill tests from the developer's real `~/.canary`
  overlays, so an installed overlay no longer flakes them.

## [5.11.0] - 2026-07-19

> This entry consolidates user-facing changes since the last changelog entry
> (5.7.0). Interim tags 5.8–5.10 were published without changelog entries; the
> `canary-instrument` skill below shipped in that window and is recorded here
> for continuity.

### Added

- **`canary-pr-guardian`** — A PR test-coverage guardian. A deterministic Tier-0
  diff-coverage engine (`canary guardian pr-check`) posts fidelity-labeled
  findings (coverage-verified › graph-verified › heuristic) with no agent,
  secret, or write token. Ships a GitHub Actions workflow with a sticky PR
  comment, a pre-commit hook, an at-desk agent orchestrator
  (`/canary-pr-guardian`), and harness-check analysis emit (`--emit-analysis`).
  The gate defaults to **soft** (advisory); promote to hard per-repo once trust
  is earned. The Tier-0 engine imports no agent/LLM by construction.
- **`canary-init` and `canary-migrate` slash commands** — first-run entry points
  so a brand-new user can initialize or migrate a project without knowing an
  agent by name.
- **`canary-company-knowledge` skill** — bootstraps `.canary/company.json`,
  scaffolding and prompting for the non-inferable org-specific fields.
- **`canary-fleet-health` skill** — compact fleet-wide flake/health summary,
  distinct from single-test diagnosis.
- **`canary-instrument` skill** — Upstreamed the OTel test-instrumentation
  capability to `agents/skills/claude-code/canary-instrument`. Instruments a
  Playwright run with OpenTelemetry and emits a `run.json` v1 artifact
  correlating each test to the outbound HTTP requests it made, via OTel span
  parent/child relationships. Trace-only in this v1; default file-based span
  export needs no OTel collector.

### Changed

- **Fail-loud on uncertain auto-detection** — `canary migrate` framework
  detection and `canary doctor --persona` now surface uncertainty instead of
  silently doing less than expected.
- **Quality-gate hooks now block** — `quality-warner` and `telemetry-reporter`
  no longer unconditionally `exit 0`; a hook that cannot fail is no safety net.
- **Config validation** — malformed `harness.config.json` / `.mcp.json` now warn
  loudly instead of silently falling back to defaults.
- **Classifier confidence** — scores are documented as heuristic priors, not
  calibrated probabilities, so CI users don't over-trust them.
- **Architecture thresholds** — `maxFanOut` / dependency-depth thresholds set
  just above the measured baseline as a regression ratchet.

### Fixed

- History store now fails closed on unparseable Supabase connection URLs.
- npm engine-check validates JSON shape before trusting a registry version.
- Numerous `canary-pr-guardian` robustness fixes (atomic analysis writes,
  git-absent ref resolution, degrade-on-error, per-unit coverage fidelity,
  bounded graph-coverage BFS depth).
- Skill/agent routing and discoverability: backfilled YAML frontmatter for
  headless `SKILL.md` files; canonicalized the three "write a test" paths.

### Security

- Redact-on-parse-failure leak: the history-store redaction path now fails
  closed rather than risk leaking credentials into logs/output.
- Added a JSON shape guard before `JSON.parse` in `npm/src/engine-checks.ts`.

## [5.7.0] - 2026-07-13

Bundled fail-fast CI gate capability, Sentinel scope optimization, PyPI Trusted
Publishing integration, and MCP selection hook.

### Added

- **`canary-fail-fast` skill** — Upstreamed the fail-fast CI gate capability to
  a bundled skill in `agents/skills/claude-code/canary-fail-fast`. It audits
  Playwright configs for `maxFailures`, `forbidOnly`, and `retries`, parses test
  run results, outputs structured digests with GitHub Actions error annotations,
  and fails the build on test failures.
- **First-party MCP hook** — Added a `prefer-first-party-mcp` hook to nudge the
  LLM to use first-party MCP tools (harness, canary) over third-party
  alternatives.
- **PyPI Trusted Publishing** — Configured automated Python packaging and
  publication to PyPI on new tags using keyless OIDC Trusted Publishing.

### Changed

- **Sentinel scope optimization** — Restricted prompt-injection scanning in
  Sentinel to untrusted external sources (WebFetch, WebSearch, third-party
  MCPs). Local tools (Write, Edit, Bash, first-party MCPs) are exempted,
  preventing false-positive injection errors on codebase edits.
- Refactored workspace hooks to split the quality-gate checks and harden
  repository config protection.

### Documentation & Maintenance

- Added a `mise` install section to the README.
- Roadmap updates to mark the fail-fast CI gate complete and reclassify the
  api-signature doc-drift check.

## [5.6.0] - 2026-07-01

Public-readiness de-identification, plus linter tooling.

### Changed

- **`company.json` scalar config fields renamed** to generic names —
  `dashboard_url` and `dashboard_token_env` (previously client-prefixed). A
  config using the old keys no longer populates the dashboard fields; update it
  to the new names. `otel_exporter_endpoint` is unchanged.

### Added

- Unknown-key warning in the `company.json` loader: any unrecognized key emits
  `ignored unknown field: <key>`, so stale configs self-diagnose.
- MIT `license` and `authors` metadata in `pyproject.toml`.

### Tooling

- Adopted `ruff` as the Python linter (`[tool.ruff]` config); removed dead
  imports and unused variables it surfaced.

## [5.4.0] - 2026-06-22

A content and tooling release — no change to the shipped CLI binary's behavior.

### Added

- **Real-world function examples** — a new `examples/realworld-functions/`
  catalog of pure-function, domain-logic scenarios (you start from a function
  signature and let Canary design the coverage). Seven examples across Pytest
  and Vitest: LEGO-collection reconciliation, price normalizer,
  subscription-expiry checker, access-policy (RBAC) evaluator, interval merger,
  semver comparison, and a marginal tax-bracket calculator (#228, #229, #232).
- **Brand refresh ("The Cry")** — new `cry-mark` icon set (gold / dark / outline
  / favicon), a self-contained `docs/branding/brand-system.html` page,
  verdict-colored Slack announcement banners, and three new "flock" voice
  profiles: Black Canary, Huntress, and Batgirl (#233).

### Changed

- **Version-consistency guard** — `tests/unit/test_version_consistency.py`
  asserts all four version declarations (`npm/package.json`, `pyproject.toml`,
  `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`) agree and are
  semver-shaped, so a future release bump that forgets a file fails CI. The
  four-file bump requirement is documented in `AGENTS.md` (#234).
- Spec-craft and naming-craft quality fixes across specs and identifiers (#225,
  #227), and refreshed GitHub issue templates (#230).

### Fixed

- **Plugin manifest version drift** — `.claude-plugin/plugin.json` and the
  `canary` entry in `marketplace.json` sat at `4.0.0` through the entire 5.x
  line (manual release bumps only touched `package.json` + `pyproject.toml`);
  both are now synced (#234).
- **Release `latest`-tag advancement** — the floating `latest` tag is moved by
  `release.yml` directly, instead of a separate release-triggered workflow that
  could miss (#231).

### Removed

- Deleted the legacy `docs/specs/oracle.md` (v1/v2 spec, fully superseded by the
  current specs) (#226).

## [5.3.0] - 2026-06-21

### Fixed

- **npm install on 5.2.0** — GitHub release asset CDN now redirects through
  `release-assets.githubusercontent.com`; added to the trusted-host allowlist so
  `volta install canary-test-cli` succeeds again.

## [5.2.0] - 2026-06-21

### Security

- **npm install redirect host pinning** — binary download now validates every
  HTTP redirect against an allowlist (`github.com`,
  `objects.githubusercontent.com`). Redirects to any other host are rejected
  immediately, preventing a man-in-the-middle from substituting a malicious
  binary during `volta install canary-test-cli`.

## [5.1.0] - 2026-06-21

### Added

- `volta install canary-test-cli` — self-contained native binary distribution
  via npm. No Python required. Binaries built for linux-x64, darwin-arm64,
  win32-x64.

## [5.0.0] - 2026-06-07

> **Breaking change.** The `canary generate`, `canary feedback`, and the GitHub
> Action have been removed. See the migration guide below.

### Migration guide

| Removed surface                                  | Replacement                                                     |
| ------------------------------------------------ | --------------------------------------------------------------- |
| `canary generate "<prompt>"`                     | `/canary-write-test` in Claude Code (no API key)                |
| `canary generate "<prompt>" --recommend-only`    | `canary recommend "<prompt>"`                                   |
| `canary feedback`                                | no replacement — feedback loop is built into the slash commands |
| GitHub Action (`uses: bop-clocktower/canary@vN`) | `/canary-write-test` in Claude Code                             |

Pin to `@v4` or earlier to keep the old action while you migrate. The action
file at this version is a hard-error shim that exits 1 with a migration message.

### Added

- **Test Intelligence Skills** — five new bundled slash commands for suite-level
  analysis (PR #205):
  - **`/canary-ci-ready`** — scores a suite across 5 dimensions: coverage depth,
    flakiness (quarantined tests with linked open issues count as verified),
    assertion quality, critical path coverage, and suite runtime. Looks up a
    `user_catalog_skill` from `.canary/company.json` for user-catalog–aware
    auth-flow checks; absent → constructive degradation message.
  - **`/canary-test-pipeline`** — multi-phase orchestrator (Gate → Assess →
    Discover → Impact → Generate → Verify) that loops until the suite is
    CI-ready or the user stops. Emits a health report on exit. Follows the
    `harness:docs-pipeline` convergence pattern.
  - **`/canary-critical-areas`** — risk-ranked area list using git churn,
    downstream dependents (harness graph → static import fallback), and
    business-critical flags. Writes an optional `critical-areas.json` artifact
    consumed by the other analysis skills.
  - **`/canary-edge-cases`** — surfaces edge cases across 6 categories (boundary
    values, race conditions, locale/timezone, partial network, unexpected input
    shapes, accessibility). Output depth scales with
    `--level sdet|junior|manual`; focuses on critical areas when
    `critical-areas.json` is present.
  - **`/canary-failure-impact`** — traces downstream effects of a test,
    function, or code path failing undetected. Domain heuristics boost severity
    for billing/auth/compliance paths. Produces a Critical/High/Medium/Low label
    with an affected-dependency list and suggested next action.
- **`canary --version` / `canary -V`** — conventional version flag via Typer
  callback, alongside the existing `canary version` subcommand (PR #204).
- **`canary upgrade`** — upgrades to the latest published version using pipx
  (preferred), with a pip fallback for non-pipx installs (PR #204).
- **WebdriverIO (`wdio`) migrate support** — `wdio.conf.ts/.js/.mjs` config
  probe, `wdio` package.json script pattern, and a `wdio.conf.ts` + `tests/`
  scaffold (PR #202).
- **`action.yml` hard-error shim** — consumers who pin `@v5` receive a
  `::error::` message with migration instructions and exit 1, rather than
  "action not found".

### Changed

- `.py` skill CLIs now run under canary's own venv interpreter
  (`sys.executable`) instead of the system Python resolved by their shebang —
  skills that depend on venv packages (e.g. `openpyxl`) no longer require manual
  injection (PR #203).

### Fixed

- Added `openpyxl>=3.1` to `[project.dependencies]` so xlsx-import skills work
  out of the box (PR #203).

### Removed

- **`canary generate`** — deprecated in v4.1.0; removed. Use
  `/canary-write-test`.
- **`canary feedback`** — deprecated in v4.1.0; removed.
- **`agent/llm/`** — entire LLM provider matrix (`anthropic`, `openai`,
  `gemini`, `codex`, `mock`). No callers remain after the orchestrator was
  removed.
- **`agent/core/orchestrator.py`** — `CanaryOrchestrator` and all private
  helpers.
- **`agent/core/selector_healer.py`**, **`agent/core/feedback.py`**,
  **`agent/core/code_extractor.py`** — last stranded modules from the keyed
  path.

## [4.1.0] - 2026-06-01

### Added

- **Company Knowledge** (`canary company-knowledge`) — ground AI generation in
  internal context without committing proprietary content. Three-source merge
  cascade: `~/.canary/company.json` (org defaults) → `.canary/company.json`
  (project-local) → `.canary/company.<env>.json` (env override). Interactive
  scaffolder (`init`), `show --validate-mcp` to verify MCP server registration,
  `show --env <name>` to inspect a specific env layer.
- **Skill deployment via `canary migrate --overlay <path>`** — skills in an
  overlay repo are automatically copied into the target project's
  `.canary/skills/` filtered by a new `deploy_to` frontmatter field. Supports
  shape values `api`, `e2e_ui`, `load`, `frontend_unit`, `all`.
- **Global skill discovery** (`~/.canary/skills/`) — skills installed here are
  available in every Canary session regardless of working directory, including
  from the Claude web extension and scratch directories. Shown as a distinct
  **Global skills** group in `canary skills list`.
- **`hooks/check-proprietary.py`** — installable git pre-commit gate that runs
  the CI proprietary-identifier check locally before every commit. Install with
  `python3 hooks/check-proprietary.py --install`.
- **Company Knowledge guide** (`docs/guides/company-knowledge.md`) — full
  operational guide covering the cascade, schema, secrets, init/show/validate
  commands, org defaults, env overrides, and prompt injection.

### Changed

- `canary migrate` gains `--overlay` / `-o` flag; dry-run and apply reports now
  include a **Skills Deployed** / **Skills (would deploy)** section.
- `canary skills list` output shows three tiers: **Bundled**, **Global**
  (`~/.canary/skills/`), **Local overlay**.
- `docs/specs/skill-discovery.md` updated to v3 (global tier, `deploy_to` field,
  updated precedence table).
- `agents/skills/canary:migrate.md` documents the `--overlay` flag and skill
  deployment behaviour.
- `docs/wiki/For-Manual-Testers.md` adds guidance on global skill install for
  Claude web extension users.

## [4.0.0] - 2026-06-01

First release of the rebranded **Canary** plugin. Continues the existing release
line (descends from v3.0.0); no prior release was modified.

### Changed

- **Rebranded Oracle → Canary** across the project: Python package
  (`canary-test-ai`), CLI (`canary` / `canary-mcp`), plugin name (`canary`),
  slash commands, and branding assets.
- Relocated the plugin to the **repository root** (previously
  `plugins/oracle/`).
- Reconciled the version across all manifests (`pyproject.toml`,
  `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`) to `4.0.0`.
- Bumped `actions/setup-python` from v5 to v6 in CI.

### Removed

- Stale API-key and removed-command references throughout the documentation.

### Security

- Added an open-core proprietary guard and company-leak scrub, enforced by a CI
  guard (removed-symbol / proprietary-denylist checks).

[Unreleased]: https://github.com/bop-clocktower/canary/compare/v6.4.0...HEAD
[6.4.0]: https://github.com/bop-clocktower/canary/compare/v6.3.0...v6.4.0
[6.3.0]: https://github.com/bop-clocktower/canary/compare/v6.2.0...v6.3.0
[6.2.0]: https://github.com/bop-clocktower/canary/compare/v6.1.0...v6.2.0
[6.1.0]: https://github.com/bop-clocktower/canary/compare/v6.0.0...v6.1.0
[6.0.0]: https://github.com/bop-clocktower/canary/compare/v5.15.0...v6.0.0
[5.15.0]: https://github.com/bop-clocktower/canary/compare/v5.14.0...v5.15.0
[5.14.0]: https://github.com/bop-clocktower/canary/compare/v5.13.0...v5.14.0
[5.13.0]: https://github.com/bop-clocktower/canary/compare/v5.12.0...v5.13.0
[5.12.0]: https://github.com/bop-clocktower/canary/compare/v5.11.0...v5.12.0
[5.11.0]: https://github.com/bop-clocktower/canary/compare/v5.10.1...v5.11.0
[5.7.0]: https://github.com/bop-clocktower/canary/compare/v5.6.0...v5.7.0
[5.6.0]: https://github.com/bop-clocktower/canary/compare/v5.5.1...v5.6.0
[5.4.0]: https://github.com/bop-clocktower/canary/compare/v5.3.0...v5.4.0
[5.3.0]: https://github.com/bop-clocktower/canary/compare/v5.2.0...v5.3.0
[5.2.0]: https://github.com/bop-clocktower/canary/compare/v5.1.0...v5.2.0
[5.1.0]: https://github.com/bop-clocktower/canary/compare/v5.0.0...v5.1.0
[5.0.0]: https://github.com/bop-clocktower/canary/compare/v4.1.0...v5.0.0
[4.1.0]: https://github.com/bop-clocktower/canary/compare/v4.0.0...v4.1.0
[4.0.0]: https://github.com/bop-clocktower/canary/compare/v3.0.0...v4.0.0
