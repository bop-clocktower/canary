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

### Fixed

- **Every guardian run now reports what it declined to judge, not just what it
  checked** (#582). `#579` fixed the abstain payload; an ordinary run that
  checked 3 units and filtered out 5 still emitted a payload describing only
  the 3. `checked: 3` was honest as far as it went and left a consumer unable to
  distinguish "this diff had 3 source files" from "this diff had 8 and the
  guardian declined to judge 5 of them" — the same "the engine knows something
  the output never says" class, one layer down, on a run that did verify a real
  denominator. `--format json` and the emitted analysis record now both carry
  `skipped: [{name, reason}]` on every run, always as an array (`[]` means
  nothing was dropped, never "unknown"). The reason tokens stay distinct per
  filter (`test support` vs `type-only module`), so adjudication can measure
  suppression classes over time and a precision regression in one filter stays
  visible instead of being averaged away. Analysis-record `schemaVersion` moves
  `1.1 → 1.2`, additive: every earlier field keeps its name, type, and meaning,
  and the minor moved because an absent `skipped` reads as good news — the same
  test `>= 1.1` applied to the `coverage` block.

- **The consent remedy `doctor` prints can now actually be carried out** (#505).
  When an overlay's `command-succeeds` checks were consent-skipped, `doctor`
  said "re-run `canary overlay add`" — and `add` returned early for an
  already-registered overlay, never reaching the consent prompt. Three separate
  messages pointed at that path (`doctor`'s skip remedy, its abstention remedy,
  and the decline message's "Re-add the overlay to change this"), and none of
  them worked: short of `canary overlay remove` followed by
  `canary overlay add`, a user who declined once could never grant consent.
  Filed as a wording nit; it was a dead end. Re-adding a registered overlay is
  now a consent-only operation — it re-asks, records the new answer, and still
  never re-clones or duplicates the registry entry, so `--yes` grants consent
  non-interactively in CI. The messages now say the argument is `<source>` (not
  `<name>`, which no invocation accepts) and that re-adding an installed overlay
  is safe, since "re-run add" read as "reinstall it" — the one thing a user with
  a working overlay will not risk. `docs/guides/doctor.md` gained the step it
  never had: how to change your mind about consent.

- **Type-only modules no longer raise unsatisfiable coverage findings** (#562).
  A `types.ts` holding nothing but interfaces produced a `coverage-verified`,
  `high`-severity finding ("lines 1-39: 39 uncovered") that no test could ever
  clear — an interface has no runtime existence to execute. This was the
  guardian's entire measured false-positive class: a bounded adjudication of 20
  findings sampled from a frame of 456 across 41 merged PRs put precision at
  13/20 against a 0.8 promotion bar, and **all seven misses were this one
  class**, holding the repo below its soft→hard gate promotion indefinitely. The
  heuristic-tier fix (#413) structurally could not reach it: that filter is
  gated on `fidelity === HEURISTIC` precisely because a coverage-verified
  verdict rests on a real lcov row, and here the lcov row is genuinely correct.
  Detection is therefore about the file, not the tier — a filename gate
  (`types.ts`, `*.types.ts`, `types/`, `*.d.ts`) selects candidates and the
  file's **content** confirms, so a `types.ts` that also exports an `enum` or a
  `const` map keeps its findings. Applied pre-resolution, so it holds at every
  tier and on the authoring surface too, which had been proposing to write
  `src/ConfirmModal/types.test.ts` — a test file for an interface. Every
  uncertainty (unreadable file, unrecognised construct) keeps the finding.
- **Guardian says what it skipped, and why** (#579). `SkipEntry.reason` was
  write-only: every suppression path set one (`skipGlobs`, `test path`,
  `test support`, `re-export barrel`, `heuristic noise`) and no surface ever
  rendered it. The `--format json` abstain payload was worse than lossy — it
  omitted `skipped` entirely, so a machine consumer saw `abstained: true` with
  no indication of what had been dropped. That is the #508 zero-denominator
  class one layer down, on the only surface a machine can read. The payload now
  carries `skipped: [{name, reason}]`, and text summary lines render the cause
  beside the name, **grouped by reason** so a shared cause is stated once —
  producers write reasons at very different grain (the guardian uses short
  tokens like `skipGlobs`; doctor uses whole remedy sentences), and repeating
  the reason per name turned one doctor summary into 183 characters that said
  the same thing twice. Reasons are stripped of control characters on the same
  terms as names, since rendering the field made it a second line-forging
  surface.

- **The proprietary-leak gate can now read TypeScript** (#578). `docs-lint`
  reported `clean — no removed-symbol or proprietary leaks` while structurally
  unable to open the language essentially all of this repo's code is written in.
  The v6 cutover moved the engine from `agent/` (`.py`) to `ts/src/`, and
  neither of the script's two suffix sets followed: `SCANNED_SUFFIXES`
  (removed-symbol half) was still `{.md, .py}`, and `PROPRIETARY_SUFFIXES`
  (compliance half) had grown to nine suffixes without ever picking up
  `.ts`/`.tsx`/`.js`/`.mjs`/`.cjs`. The cost was measured, not theoretical: PR
  #577 leaked a downstream consumer identifier into four places and the gate
  caught exactly one — the `CHANGELOG.md` instance — passing over two in
  `ts/test/`. Both sets now cover the TS/JS family plus `.json`/`.yml`/`.yaml`.
  Note the green was never _wrong_ about what it measured; the denominator just
  excluded the codebase, which is the same false-green class as #548/#549 with
  compliance rather than noise as the cost.

  Widening the removed-symbol half surfaced one real drift: the `canary-shadow`
  example config shipped `["python3", "-m", "agent.cli"]` as its copy-me
  baseline — an engine deleted in the v6 cutover — so anyone following the
  example ran a module that no longer exists. It now shadows the released CLI
  against the local build, which is the durable use of that skill.

  The script had no tests at all and no seam to write one against (a bare
  `process.exit(main())`, nothing exported), so its suite could not distinguish
  "no leaks" from "cannot see leaks". `ts/test/leak-gate-denominator.test.ts`
  now plants a known offender in a fixture repo per suffix and requires the gate
  to fail on it, with a clean-control case so a gate that fails on everything
  cannot pass as one that works. The fixture repos are reached through a new
  `CANARY_LEAK_SCAN_ROOT` override, which prints a banner stating the run does
  not gate the repository — the seam that makes the gate testable would
  otherwise be a seam that silently neuters it.

- **The guardian no longer asks a test fixture to have a test** (#565). #413
  taught the gate that a non-source path can never satisfy a coverage finding,
  but it recognised test support by _directory_ (`fixtures/`). Files that are
  test infrastructure by _filename idiom_ and live in an ordinary source
  directory slipped through: measured on a downstream consumer PR, a pytest
  `conftest_otel.py` and a Playwright `playwright-fixture.ts` under
  `scripts/otel_bootstrap/` were both flagged "no test file references this".
  Both files _are_ the harness the tests run inside, so the finding inverts the
  relationship the gate exists to check and a reviewer's only correct response
  is 👎 — which drives `precision = TP / (TP + FP)` down and holds the repo
  below its soft→hard promotion bar.

  A file whose basename carries a `conftest` component (`.py` only — it is
  pytest's own resolution rule) or a `fixture`/`fixtures` component under any
  separator is now dropped before coverage is resolved, so the suppression holds
  at **every** fidelity tier rather than only the heuristic one. That matches
  where the existing `fixtures/` convention already sat: an lcov row proving a
  fixture's lines are uncovered is perfectly true and still cannot make "this
  needs a test" satisfiable.

  Matching is on `-`/`_`/`.`-separated components, not substrings, so
  `conftestimonial.py` and `prefixtures.ts` remain ordinary source. The
  predicate is deliberately kept separate from `isTestPath`, which also decides
  what _confers_ graph coverage — widening that would let a conftest mark every
  module it imports as tested, trading a false positive for a false negative.

  The same suppression applies to the `author-plan` authoring surface, which
  previously proposed writing `scripts/otel_bootstrap/test_conftest_otel.py` — a
  test for the conftest. Suppressed paths stay visible in the skip list and a
  support-only diff now abstains (exit 3) rather than reporting a clean pass.

### Changed

- **CI checks can now stop a merge to `main`** (#542). The `main` ruleset
  contained no `required_status_checks` rule at all — not a missing entry, the
  rule type was absent — so every check this repo runs was advisory. PR #540 was
  merged by auto-merge while `markdownlint` was reporting `FAILURE`; auto-merge
  fires once the _required_ checks pass, and with none required it fires as soon
  as the PR exists. `main` went red and stayed red until #541. The check was not
  wrong: it caught four real MD040/MD033 violations and was overruled by
  configuration. (The classic `branches/main/protection` endpoint returns
  `404 Branch not protected`, so an audit through the old endpoint concludes
  nothing is configured at all — which is how this survived.)

  Thirteen checks are now required, and `.github/required-checks.json` is the
  in-repo record of which and why, with the GitHub ruleset as the copy that
  enforces it. Promoting a check meant also removing its path filter: a required
  check behind `paths:` never reports on a PR outside those paths, so GitHub
  shows it as "Expected — waiting for status" and the PR can never merge. #542's
  own proposal named `docs-lint` among the checks to promote, and `docs-lint`
  was path-filtered — following it verbatim would have deadlocked every
  code-only PR while fixing the gate. `docs-lint`, `harness-architecture`,
  `harness-security` and `validate-plugin` now run on every PR; the security
  scan's `push` filter went too, since a scan that skips itself on some pushes
  to `main` leaves `main` unscanned for exactly the changes nobody classified as
  security-relevant.

  Every check-producing job is classified as required, or advisory with a stated
  reason, and `workflow-false-green.test.ts` fails when a job is neither — so a
  new check cannot join the advisory pile by default. The five dogfood jobs stay
  advisory against ADR 0010's rule (precision unknown until #544 triages the
  409-finding baseline), and `refresh-arch-baseline` stays advisory because it
  only triggers on a label and requiring it would deadlock every unlabeled PR.
  `required_approving_review_count` stays 0, now as a recorded decision for a
  single-maintainer repo rather than an unconfigured default. See ADR 0011.

- **Agent-tooling artifacts are now ignored rather than permanently dirty.** A
  skills-manager extension writes ~2.6 MB of machine-local state into the tree
  each session — telemetry under `.claude/learning/`, per-vendor skill mirrors
  in `.cursor/` and `.kiro/` and `.github/instructions/`, and copies of both
  wherever a hook happened to run (`ts/`, `npm/`, `.github/workflows/`). One of
  those files, `.claude/mcp-usage.jsonl`, records absolute local paths, session
  IDs, and full bash command strings, and this repository is public. The rules
  are globbed rather than path-listed because the hooks resolve from the working
  directory, so the next `cd` grows another copy. Two tracked files the same
  extension rewrites — a `CLAUDE.md` table documenting skills that live only on
  one machine, and `.claude/settings.json` hooks curling `127.0.0.1:4895` — were
  reverted; the hooks moved to the gitignored `settings.local.json`, where they
  keep working without asking every contributor to run a local daemon.

- **Agent ignores moved out of `.git/info/exclude` into the tracked
  `.gitignore`.** That file is machine-local and never shared, so 15 personal
  skill installs and ten kinds of Claude Code runtime state were invisible on
  the machine that wrote them and untracked noise on every other clone — the
  same state looking clean or dirty depending on which laptop you opened. The
  skill directories are third-party artifacts rather than source: each carries a
  `.skill-version.json` receipt (`{"version", "installedAt"}`), `skill-creator`
  ships an Apache-2.0 `LICENSE.txt`, and not one file under `.claude/skills/`
  mentions canary — the project's own skills ship from `agents/skills/`.
  Committing them would vendor another author's code at whatever version one
  developer installed. `.claude/skills/` is now ignored wholesale, with the
  negation to commit a genuine project skill documented inline. Coverage
  equivalence was verified rather than assumed: all 15 skill paths and all 12
  runtime paths remain ignored, and `.git/info/exclude` is left with zero active
  rules.

  `.claude/skills/` is ignored by **named install**, not wholesale. A blanket
  rule would have foreclosed committing a genuine project skill there, and done
  it in the worst possible way — the file simply never appears in `git status`,
  which is the same silent-abstention shape ADR 0010 is about. The two cases are
  distinguishable even though `.gitignore` cannot express the distinction:
  installed skills carry a `.skill-version.json` receipt and authored ones do
  not, so `agent-artifact-ignores.test.ts` enforces both halves from the
  filesystem. A receipt-bearing directory that is _not_ ignored fails (the next
  `git add -A` would vendor third-party code); a receiptless one that _is_
  ignored fails (someone's own work would vanish). Each failure names the
  directory and the remedy. Verified in both directions rather than assumed.

- **The guardian's sticky PR comment now says what to do, not just what is
  wrong.** Three pieces of information were computed and then dropped before
  they reached the reader:

  - **Which lines are uncovered.** `resolveCoverage` produced
    `CoverageResult.uncovered_lines`, but `buildFindings` built a `Finding`
    without that field, so a coverage-verified finding could only say
    `lines 40-58: 12 uncovered` — the reader had to re-run coverage locally to
    learn which 12. `Finding` now carries `uncovered_lines` (and emits it in the
    `--format json` record). An empty array means _this tier cannot measure
    lines_, never _nothing is uncovered_, so the renderer omits the detail
    rather than printing an empty list that would read as a clean measurement.
  - **A suggested next action.** `Finding.suggestion` was in the interface, in
    the JSON schema, and rendered by the local CLI — and nothing ever populated
    it, so it was permanently `''`. A field that is present everywhere and empty
    in every record reads as alive and is dead. It is now populated per tier,
    stating only what that tier established: the coverage tier names the lines,
    the graph tier names the symbol to call, the heuristic tier says plainly
    that no filename matched. A suggestion that guessed at a test path would be
    worse than none — it sends the reader somewhere before they learn to
    distrust it.
  - **A link to the code.** The file cell was plain code text. It is now a
    permalink to the first uncovered line, built from `GITHUB_REPOSITORY` plus
    the PR head SHA (preferred over `GITHUB_SHA`, which on a `pull_request`
    event is an ephemeral merge commit whose blob URL can 404). When neither
    resolves, the cell stays plain text: an unresolvable link still _looks_
    clickable, which is worse than no link.

### Fixed

- **The hard gate's severity filter did not filter** (#553). `buildFindings`
  derived severity from fidelity alone, so every coverage-verified finding was
  `high` and nothing was ever `critical`. Measured across 274 downstream runs
  over six weeks: 1,488 coverage-verified findings, 100% of them `high`. That
  made `gate: hard`'s `critical`/`high` bar exactly equivalent to "block on any
  coverage-verified finding" — 45 of 123 PRs would have been blocked, one with
  68 findings and one with 132 — and left a reviewer no way to tell which row
  mattered, since every row said the same thing. A promotion bar written in
  terms of `CRITICAL`/`HIGH` was describing a filter that discriminated nothing.

  Coverage-verified findings are now graded on signal the engine already held:
  how many lines came back unhit, and what share of the unit's added lines that
  is. `critical` needs both volume (20+ lines) and concentration (80%+ unhit);
  `high` needs either 5+ lines or a 50%+ share; the remainder — a guard clause
  inside an otherwise-tested change — is `medium` and no longer blocks a merge.
  The graph and heuristic tiers are deliberately left flat: neither can measure
  how much of a unit is unhit, so any spread across them would be invented.

  Both unknowns escalate rather than downgrade. A coverage-verified result with
  no line numbers means the tier could not say _which_ lines were unhit, not
  that few were, and a missing added-line count leaves the share denominator
  unknown; both grade as though the gap were total. The regression test asserts
  the distribution rather than the labels — a future rule that collapses every
  finding back onto one severity fails on the same assertion that would have
  caught this.

  The sticky comment's icon column mapped `critical` and `high` to the same red
  circle — a collision with nothing to collide with while `critical` was
  unreachable, and one that would have hidden the new ranking behind identical
  glyphs the moment it became reachable. `high` is now the orange circle, which
  is what `summary-emitter.ts` has always used.

- **Guardian read GitHub's comment and reaction lists 30 rows at a time and
  reported the result as complete** (#528). Both REST clients called the list
  endpoints bare — no `per_page`, no `Link` following — so every read stopped at
  GitHub's default page size and said nothing about the remainder. Two things
  broke on a busy PR, both silently: once the thread passed 30 comments the
  guardian's own sticky comment fell off page one, so `findSticky` missed it and
  guardian **posted a second sticky** while recording no adjudication at all;
  and once a sticky passed 30 reactions the 👍/👎 tally was cut mid-sample,
  biasing the **precision metric that gates the soft-to-hard promotion** toward
  whichever verdicts happened to sort first. A truncated denominator is worse
  than an empty one — 30-of-30 reads as a healthy sample, and no number in the
  code said "30" to notice.

  Both clients now request `per_page=100` and follow `Link: rel="next"` to the
  end. The loop refuses to truncate quietly: a `Link` cycle or a read past 20
  pages (2000+ rows) throws rather than returning what it managed to collect,
  and a failure on page two propagates instead of degrading to page one. A 403
  maps to `GitHubPermissionError` identically on the paged read and the write,
  so a fork PR behaves the same on both.

  Also corrected: the module comment claiming an adjudication record can never
  collide with a findings filename. A branch named `adjudication/pr-42`
  sanitizes to exactly that name. Nothing breaks — `loadAdjudicationRecords`
  keys off the `source` field, so a colliding record is skipped rather than
  mis-tallied — but the comment asserted a guarantee the filenames do not carry.

- **Every guardian sticky comment told reviewers to run a command that does not
  exist** (#489). The one instruction in the comment — reply
  `/guardian suppress <file> <reason>` — was the one thing that could not work:
  nothing has ever implemented a slash command, and guardian does not read PR
  comments for input at all. The mechanism that does work, a
  `// canary:allow-untested <reason>` pragma on the line, was documented in the
  guide and advertised nowhere a reviewer would look. The comment now names the
  pragma. A test asserted the fake command was present, so the suite had been
  actively holding the false claim in place; it now asserts the opposite — no
  rendered comment advertises a `/guardian` slash command in any form.

- **`canary-shadow` shipped a CLI it could not execute** (#478).
  `scripts/cli.mjs` was committed at mode 0644 while the other six first-party
  skill CLIs are 0755, so `canary skills run canary-shadow` failed on a skill
  that installed, listed, and documented perfectly. Made executable, and a new
  suite now walks every `SKILL.md` declaring a `cli:` entry point and asserts
  `X_OK` on it — including an explicit check that the scan found a non-zero
  number of skills, so a renamed frontmatter key cannot turn the guard into a
  vacuous pass.

- **The guardian's analysis record never said whether coverage was actually
  available** (#554). `degradedNotice` was wired to exactly one producer — the
  agent-tier resolver — so the coverage ladder's own fall-through (report →
  graph → heuristic) went unrecorded: `null` in 274 of 274 runs across six weeks
  of a downstream repo, including every run that produced heuristic findings
  only. 43 of those PRs changed source files and reported zero coverage-verified
  findings, which reads as "the new lines are covered" and could equally have
  meant "the lcov never arrived"; the CI-side evidence that would settle it
  expires (48 of 55 `guardian-lcov` artifacts were already gone). Every run now
  records a `CoverageInputState` — was a report requested, did the file exist,
  did it parse, how many files did it carry, and how many of the changed files
  did it actually speak to — surfaced as:
  - an additive `coverage` block in the analysis record (`schemaVersion` 1.0 →
    1.1) carrying `status` (`verified` / `partial` / `unavailable`) plus every
    raw count, so the downstream soft-to-hard promotion metric can be computed
    without parsing prose;
  - `degradedNotice` populated with that state in words, alongside (not instead
    of) any tier-degradation notice;
  - a sticky-comment body line, and — the point of the issue — **no ✅ all-clear
    headline on a run whose coverage was not `verified`**. Zero files matched is
    an abstention, not a pass.
  - the same block and notice in `--format json`, plus an Actions `::warning::`
    annotation. That annotation is routed to stderr when JSON owns stdout, so
    the document stays parseable.

  The minor bump is deliberate, and narrows an earlier rule that said additive
  fields never move the version. An additive field whose absence would read as
  good news is not merely more detail: a missing `coverage` block looks like
  "coverage was fine" when it means "this producer could not say". So
  `schemaVersion >= 1.1` is what licenses a reader to trust the block. Compare
  the **major** for readability — a strict `=== "1.0"` check rejects a record it
  can read. Note that `checked` and `abstained` were added additively under
  "1.0" before this rule existed, so a "1.0" record may or may not carry them;
  test for those two keys, not the version.

- **`review-test` / `flake-check` reported a confident green over `.mjs` and
  `.cjs` files they never actually read** (#566). Four defects from one consumer
  report, all the #503 family — a check that measured nothing presenting as a
  pass:
  - `.mjs`/`.cjs`/`.mts`/`.cts` now match test discovery. They never did, and
    the deeper half was in `detectFramework`, whose `return 'pytest'` fallback
    handed an unrecognised extension to the Python assertion scanners. Over ESM
    JavaScript those match nothing, so a single `.mjs` file with real defects
    printed `✅ No issues found` and exited 0. A downstream overlay repo with 30
    of its 36 test files in `.mjs` was told all 30 were clean. There is no
    fallback any more: `lintableFramework` returns `null` and the caller
    abstains, because a guess indistinguishable from a clean result is a lie.
  - A single file whose extension no ruleset parses now **abstains (exit 3)**
    instead of reporting clean. `abstainOnZeroFiles` only ever fired on a
    directory — a single file is a one-element list, so its denominator is never
    zero — which is why directory scans abstained correctly while the
    single-file path lied. The directory abstention's own remedy text ("or pass
    a single file directly") had been routing readers straight into it.
  - **`node_modules` is excluded from the walk**, along with the rest of the
    ignore set `pattern-matcher.ts` has carried since the Python port (`.git`,
    `dist`, `build`, `.venv`, `.next`, `.nuxt`, `__pycache__`). `walkFiles` was
    the copy that never got it: one consumer run was 254 vendored findings out
    of 256, with its only `critical` inside a dependency.
  - **`--json` now carries the same exit code as human mode.** It returned
    before the exit-code throw, so a consumer gating on `$?` read every
    finding-bearing run as clean. Abstention (3) was already preserved in both
    modes; findings (1) were not.

  Upstream CI could not have caught this: every suite in `ts/test`,
  `npm/scripts/__tests__` and `agents/skills/test` is `.ts`/`.js`, so the
  denominator was never zero here. Two existing tests had to be rewritten — they
  asserted the buggy behaviour outright
  (`unknown extension falls back to pytest`, and `--json` exiting 0 with
  findings).

- **Reviewer adjudications would have silently stopped being attributed** (#490,
  #508). `activeFindingPaths` anchors on the comment table's second cell opening
  with a backtick; the permalinked cell opens with `[`, so the regex would have
  matched nothing on every comment posted from CI. The failure mode is the one
  this repo keeps filing against itself — not an error, but an empty path list,
  zeroing the precision denominator while reporting success. The parser now
  accepts the linked form, and a regression test feeds `render`'s own linked
  output through it so producer and consumer cannot drift apart again.

- **The published Node floor is now `>=22`, and it is enforced at runtime**
  (#559). `canary-test-cli` promised `engines.node: ">=18"` while the engine it
  bundles is built only from `ts/`, which requires `>=22`, and compiled only by
  the release workflow, which runs on 22. Nothing tested 18; nothing prevented
  claiming it. Node 18 and 20 are both past end-of-life, so the floor rises to
  match what is actually built rather than adding a compatibility leg for
  runtimes nobody should be on.

  The bump alone would have been cosmetic. **`engines` is advisory** — verified,
  not assumed: installing a package declaring `engines.node: ">=99"` on Node 24
  exits 0 with nothing but `npm warn EBADENGINE`, and only `engine-strict=true`
  turns that into an error. So a Node 20 user still installs. `bin/canary.js`
  now checks `process.versions.node` against its own `engines.node` and exits 1
  with a message naming the required version, the running version, and how to
  upgrade. The check sits **above** the `require('../dist/router.js')` line on
  purpose: the engine is compiled for the floor, so requiring it first can throw
  a bare `SyntaxError` on an older Node and the guard would be dead code on
  exactly the versions it exists to catch.

### Added

- `ts/test/agent-artifact-ignores.test.ts` — asserts that the machine-local
  state agent tooling writes into this repo stays out of it. Sixteen artifact
  paths are checked individually via `git check-ignore`, so a partial regression
  names the path that slipped; a companion assertion requires the tracked shared
  config (`.claude/settings.json`, `.cursor/mcp.json`, the workflows) to be
  **un**ignored, which is the guard against over-correcting. A third checks
  nothing is tracked _today_, since `.gitignore` has no effect on an
  already-tracked file. The un-ignored assertion earned itself on its first run
  by catching a blanket `.cursor/` rule that would have swallowed the shared
  `mcp.json` beside the telemetry.
- `ts/test/node-engines-floor.test.ts` — holds four declarations of the Node
  floor together: `npm/package.json` `engines.node`, the README badge, the
  README install prose, and the `setup-node` version in `release.yml`. The
  version badge is out of scope in `version-consistency.test.ts` as a "display
  artifact" — correct there, since `bump-version.mjs` stamps it. Nothing stamps
  the _node_ badge, which is why it read `python-3.11+` for six releases and
  then `18+`. An unstamped badge is a declaration.
- `npm/scripts/__tests__/node-floor-guard.test.js` — pins the runtime guard: the
  floor is read from `engines.node` rather than hardcoded (a hardcoded copy
  would be a fourth thing to drift), the message names both versions and a
  remedy, an unparseable version abstains rather than false-blocks, and the
  guard textually precedes the engine require.
- **`dogfood.yml` job E — "Node floor is enforced (unsupported runtime)".**
  Packs the tarball on the supported Node, switches to `floor - 2`, installs,
  and asserts the guard fires: a clean exit means the floor is unenforced, and a
  `SyntaxError` means the guard ran too late. The unsupported version is derived
  from `engines.node`, so raising the floor moves the test with it. No unit test
  can prove a guard survives module-load ordering in a real install.

## [6.6.0] - 2026-08-05

The **precision** release. v6.5.0 made a check that examined zero items say so;
this one aims the linter at canary's own test suites for the first time and
fixes what that exposed. Findings went 409 -> 19, and 13 of the 19 are a
deliberately-bad fixture. A detector nobody has ever pointed at real code is not
a passing gate — it is an unmeasured one, and ADR 0010 is explicit that a noisy
check gets ignored, so precision is the prerequisite for ever gating on it.

### Added

- `ts/test/harness-config-denominator.test.ts` — asserts that the architecture
  rules govern real files: every layer pattern and every side of every import
  boundary matches at least one **git-tracked** file, every
  `allowedDependencies` name resolves to a declared layer, and every tracked
  file under `ts/src` belongs to some layer. Tracked files rather than a
  filesystem walk on purpose — the dead `tests/**` pattern still matched a
  directory full of untracked `.pyc` spoil, which is precisely how the rule
  looked alive.
- `ts/test/import-graph-acyclic.test.ts` — reproduces the CI cycle check at desk
  speed and names the offending chain instead of leaving a bisect. Type-only
  imports count, because the gate it stands in for counts them; a local check
  more permissive than the gate hands back green while the pipeline goes red.
- `ts/test/workflow-false-green.test.ts` — asserts the false-green invariants
  fixed below across _every_ workflow, not just the files that were broken: a
  path-filtered workflow lists its own file, no `git push` has its failure
  swallowed by `|| echo`/`|| true`, nothing pushes directly to `main`, and a
  workflow that pushes a side branch says where it went. That last invariant
  immediately caught a third instance nobody had filed —
  `refresh-arch-baseline.yml` pushed a baseline commit and announced nothing.
- **`dogfood.yml` — canary pointed at canary** (#536). Four advisory jobs over
  the product surface the repo had never run on itself: `review-test` plus
  `flake-check` across all three suites; `doctor` from a real global install of
  the packed tarball, so the bundled engine, bin shims, and `package.json#files`
  are exercised rather than the checkout; fleet health over a recorded vitest
  run, since every `analyze` and history path had until now only ever seen
  synthetic fixtures; and `katana --strict`, handling "a test was deleted" (exit
  1. and "the diff was empty" (exit 3) as separate outcomes rather than blurring
     both behind `continue-on-error`. Nothing blocks a merge — each check
     ratchets to strict once its findings are triaged to zero, the same path
     blackhawk and savant took. It paid for itself before it shipped: the
     LINT-006 defects below were found by running it.

### Fixed

- **LINT-006 precision, 6% -> ~100%** (#535). Running `review-test` over
  canary's own suites reported 216 assertion-free tests, of which 13 were real.
  Two independent defects, neither reachable from a unit test because both need
  a large, diverse codebase to express themselves. First, `ASSERT_JS` matched
  only `expect()`-style assertions, so every `node:test` + `node:assert` suite
  read as assertion-free — 200 of the 216 findings, and that is the framework
  canary's own npm package uses, so canary could not see the assertions in its
  own shipped code. It now recognizes `assert.equal(...)` and friends, bare
  `assert(...)`, and chai's `should`. Second, the test body boundary was a fixed
  2000-character window, wrong in both directions: a long test whose first
  assertion fell past the window was flagged, and a short empty test could
  borrow the _next_ test's assertion from inside the window, a false negative
  nobody had counted. The body is now bounded by the next test declaration —
  what the pytest scanner had been doing all along with "next `def` at the same
  indent". The two scanners had silently disagreed since the port.
- **LINT-005 was 0-for-157 on real test code** (#537). Two mistakes. Every rule
  in this linter works line by line, so a line inside a template literal or a
  Python triple-quoted block was read as bare source — canary's own diff
  fixtures are template literals, so the git file mode `100644` sitting in test
  _data_ was reported as a magic number 30 times, and any consumer with a
  multi-line SQL, JSON, HTML, or diff fixture had the same defect. Multi-line
  string interiors are now blanked before the per-line scan, preserving line
  numbering; an _unbalanced_ delimiter discards the run rather than blanking to
  end-of-file, which would silently disable every rule below it — the abstention
  shape, one layer inside the linter. Separately, "extract the magic number to a
  named constant" is a production-code principle that inverts in a test:
  `expect(len).toBe(2048)` states the contract that
  `expect(len).toBe(MAX_NOTES)` hides. Since this linter only ever reads test
  files, the rule was misapplied across its entire domain. It now fires only in
  a timing position (`setTimeout`, `waitForTimeout`, `sleep`, `delay`,
  `retryDelay`, `retries`, `backoff`, `poll`, `debounce`, `throttle`), where a
  bare `5000` genuinely has unclear units and intent. Hardcoded sleeps remain
  CRITICAL under FLAKE-001/002. LINT-005: 218 -> 2.
- **Data was acting as code in four more scanners** (#539, closes #499). One
  root cause across two codebases. blackhawk's pragma parser ran against the raw
  line, so a `blackhawk-ignore` inside a string literal registered as a live
  directive and contributed a fabricated reason to the suppressed count — savant
  shipped that guard in #495/#498 and it was never ported back. The FLAKE and
  missing-await rules never stripped strings either, so
  `const src = 'const t = Date.now();'` — a fixture string feeding a linter test
  — was a real FLAKE-004. And the assertion scanners read the raw source while
  the per-line rules read the blanked one, so a diff fixture full of deleted
  `it(...)` lines was still mined for assertion-free tests. The selector rules
  are deliberately excluded and pinned by a test: LINT-001/002/003 match
  `'.btn'` and `'#id'` inside quotes by construction, because a selector _is_ a
  string, and stripping would delete those rules outright. LINT-006 now also
  credits an `expectX()`/`assertX()` helper as an assertion — a regex linter
  cannot follow the call, so the name carries the signal, and `[A-Z]` keeps it
  to the convention. Across the triage rounds: 409 -> 199 -> 35 -> 26 -> 19
  findings, of which 13 are the deliberately-bad `lint-target.spec.ts` fixture.
- **Five `harness.config.json` keys sat at paths the schema never reads**
  (#545). Zod strips unknown keys silently, so all five were dead on the pinned
  @9 as well as on @10, and nothing ever reported it. One was load-bearing:
  `entryPoints` belongs at `entropy.entryPoints`, and with it stripped,
  reachability analysis had no entry point and `harness cleanup` exited 2 at
  startup with "Could not resolve entry points". That is the CI Entropy Scan
  step, which is `continue-on-error` — so the startup failure has rendered as a
  green job for the entire life of the step, and the scan has never once run its
  analysis. It now exits 1 with 718 findings (40 drift, 678 dead code), still
  non-blocking until those are triaged. The dead top-level `tooling` block is
  deleted rather than moved: its pip/ruff/pytest values describe pre-v6 canary,
  and promoting stale Python tooling into a path harness actually reads would be
  worse than leaving it dead.
- **`arch-snapshot.yml` never committed a snapshot** (#548). The change guard
  ran `git diff` against `.harness/arch/timeline.json`, a path git had never
  tracked. git cannot report a diff for an unknown path, so the guard was
  trivially true, the early `exit 0` fired on every run, and the `git add` below
  it was unreachable. Both runs the workflow had ever made reported success and
  produced nothing. The guard now uses `git status --porcelain`, which sees
  untracked files, and the timeline is seeded so the series has a starting
  point.
- **`harness-security.yml` failed the same way, one step further along** (#548).
  Its guard worked, but the delivery did not: it pushed to `main`, which ruleset
  `16189198` rejects for every actor, and `|| echo` converted the `GH013`
  rejection into a green job. The eight most recent qualifying runs each logged
  `remote rejected` and each reported success. Both workflows now commit to a
  standing branch, so a push failure is a failure again.
- **Three path-filtered workflows could not gate changes to themselves** (#549).
  `harness-security.yml`, `harness-architecture.yml`, and `wiki-sync.yml`
  omitted their own file from their `paths:` filters, so editing one of them
  never ran it — #547 changed the CLI pin in `harness-security.yml` and the
  workflow did not run on that PR. Each now lists its own path, matching the
  precedent `docs-lint.yml` already set.
- **Ledger workflows could not open their own PR.** The first cut of the #548
  fix ended each run with `gh pr create`, which this repo refuses outright:
  `can_approve_pull_request_reviews` is `false`, so a workflow gets _"GitHub
  Actions is not permitted to create or approve pull requests"_. The branch push
  succeeded and only the PR creation failed, turning `main` red — correctly, and
  for the first time, rather than printing a reassuring line. Both workflows now
  stop after pushing the branch and write a compare link to the job summary;
  opening the PR is a human step. `pull-requests: write` was dropped from both
  since nothing needs it any more.

- **The architecture gate had nothing to check** (#543). Every layer pattern and
  import boundary in `harness.config.json` still described the `agent/` Python
  tree deleted in the v6.0.0 cutover, so `harness check-deps` analysed zero
  files and reported `validation passed` for the entire life of the TypeScript
  engine — a zero denominator, not a clean graph. The patterns now describe
  `ts/src` by role: `entry` and `cli` on top, then `guardian`, `analysis`, and
  `history`, then `core`, over the `ui` and `util` leaves, with `util` and
  `core` forbidden from reaching back up. Repointing them surfaced two genuine
  circular dependencies the gate had never been in a position to see, both fixed
  below.
- **Two circular dependencies in the engine** (#543). `framework-registry`
  imported `scaffoldableFrameworks` from `scaffolder`, while `scaffolder`
  imported `FrameworkRegistry` to degrade loudly on an unknown framework; the
  templates and the derived framework set move to a leaf
  `ts/src/core/scaffold-templates.ts` that both depend on. `history/store`
  imported every backend it can construct and `history/supabase-store` imported
  the interface it implements; the contract moves to
  `ts/src/history/async-store.ts`. The second was type-only and so never a
  runtime hazard, but the gate counts it, and both original modules re-export
  the moved names, so no caller changed.

### Security

- **`hono` 4.12.32 -> 4.13.0** (#556). Two Dependabot advisories, both medium
  and both _runtime_ scope: `hono < 4.12.34` is vulnerable to ReDoS in the CORS
  middleware via `Access-Control-Request-Headers`. Runtime scope matters here —
  hono arrives transitively through `@modelcontextprotocol/sdk`, a production
  dependency of the published `canary-test-cli`, so this sits behind
  `bin/canary-mcp.js` rather than in test tooling. Lockfiles only, in `ts/` and
  `npm/`: nothing declares hono directly and the SDK asks for `^4.11.4`, so
  4.13.0 resolves inside the existing range with no manifest change. Verified
  with a real `npm ci` in both packages rather than a lockfile diff alone, since
  a lockfile diff proves nothing about what npm actually resolves.
- **`fast-uri` 3.1.4 -> 3.1.5, `@hono/node-server` 1.19.15 -> 2.0.12, `postcss`
  8.5.22 -> 8.5.25** (#546). Closes five of the seven open alerts, including
  both high-severity `fast-uri` ones. All transitive; the `postcss` half is
  dev-only, which is why hono needed the separate follow-up above.

### Notes for consumers

- **The linter reports much less now, and that is the point.** If you gate on
  `review-test` or the static linter, expect the finding count to drop sharply —
  LINT-005 is scoped to timing values, LINT-006 sees `node:assert` and helper
  assertions, and none of the per-line rules read the inside of a multi-line
  string any more. Nothing was suppressed to get there; each change removed a
  class of finding that was never actionable. A baseline or ratchet pinned to
  the old counts will need refreshing downward.
- **Two CI checks start reporting for the first time.** The Entropy Scan and the
  architecture gate were both failing or matching zero files while showing
  green. They now produce real findings (718 and 2 respectively, the latter
  already fixed). Both remain non-blocking until triaged.

## [6.5.0] - 2026-08-03

The **denominator** release. v6.4.0 turned "a check that verified zero items has
abstained, not passed" into a rule and applied it to the first two layers; this
one finishes the sweep across every remaining surface, and closes #508.

Sixteen more commands now report how many items they actually verified. The
subtle half is that the denominator is almost never the finding count: zero
flaky tests across 500 runs is a healthy fleet, while zero across zero runs is
an absent measurement, and the two used to print the same line. Separating them
is what most of this release is.

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
| `doctor`                                                              | exit **3**                    | every check skipped, or no check registered         | 6.5.0   |
| `overlay lint`                                                        | warns, exit 0                 | overlay ships zero skills                           | 6.5.0   |
| `review-test`                                                         | exit **3**                    | directory matched zero test files                   | 6.5.0   |
| `flake-check`                                                         | exit **3**                    | directory matched zero test files                   | 6.5.0   |
| `analyze` (flaky/spikes/common-failures/regression-candidates/digest) | warns, exit 0                 | zero runs recorded                                  | 6.5.0   |
| `analyze area-health`                                                 | warns, exit 0                 | always — its row set is hardcoded empty             | 6.5.0   |
| `history flaky`                                                       | warns, exit 0                 | zero runs recorded                                  | 6.5.0   |
| `history summary`                                                     | warns, exit 0                 | zero runs (previously reported a fabricated `0.0%`) | 6.5.0   |
| `history migrate`                                                     | warns, exit 0                 | zero runs migrated                                  | 6.5.0   |
| `canary-blackhawk` / `canary-savant`                                  | warns; **`--strict` exits 3** | zero files scanned                                  | 6.5.0   |
| `canary-katana`                                                       | warns; **`--strict` exits 3** | the diff was empty                                  | 6.5.0   |
| `history timeline`                                                    | warns, exit 0                 | zero runs recorded (vs. an unknown test)            | 6.5.0   |
| `guardian author-plan`                                                | warns, exit 0                 | empty diff; `checked`/`abstained` now in the JSON   | 6.5.0   |

Audited and deliberately **unchanged**: `heal-test` (its denominator is always
exactly 1) and `skills run` (its exit ladder already used 3 for a refusal to
invoke, which is an abstention). Both carry conformance rows recording the
classification.

`--json` surfaces gain `checked` and `abstained` additively. Where the payload
is a bare array with nowhere to put them, stdout stays byte-identical and the
notice goes to **stderr**, so existing parsers are unaffected.

### Added

- **`canary doctor` reports its denominator** (#508, #505). The summary names
  what actually ran and what was skipped —
  `All 7 run check(s) passed (2 skipped: smoke-test, api-reachable)` — instead
  of `All checks passed.` over a run where every check was skipped. `--json`
  gains `checked`, `skipped`, and `abstained`; `allPassed` is now `false` on an
  abstained run. Zero runnable checks exits **3**.
- **`NdjsonHistoryStore.countRuns()`** — the denominator probe every
  history-backed report consults. `AsyncHistoryStore.countRuns?()` is
  deliberately **optional**: a backend that cannot report how many runs it holds
  (today, the remote Supabase store) keeps benefit-of-the-doubt rather than
  abstaining. An unknown denominator is not a zero one.
- **Two ADRs** recording the doctrine's load-bearing decisions:
  [0009 — exit 3 reserved CLI-wide](docs/adr/0009-exit-3-reserved-for-abstained.md)
  and
  [0010 — the conformance registry is the canonical gate list](docs/adr/0010-conformance-registry-as-gate-registry.md).
  `AGENTS.md` gains the doctrine plus a **new-gate checklist**.
- **Conformance registries, one per runtime layer** — 24 rows total (15 engine,
  3 npm, 6 skill). Every row collapses a command's denominator and runs the
  **real command**, asserting both the loud outcome and the absence of the old
  success copy. A new gate is not done until it has a row.
- **The npm package's test suite now runs in CI.** It ran in _zero_ jobs before:
  `release.yml` built the package at tag time but never tested it, so a
  regression in `doctor`, the overlay commands, or the MCP bin reached npm
  unchallenged.

### Fixed

- **`history summary` fabricated a pass rate over an empty sample** (#508). Zero
  recorded runs printed `avg pass rate: 0.0%` — the most misleading shape in the
  audit, since 0% reads as catastrophe rather than as absence. It now says the
  rate is unknown.
- **`analyze` and `history` reports abstained on the wrong denominator** (#508).
  They keyed off result rows, so a healthy fleet with 500 recorded runs and zero
  flaky tests was indistinguishable from an empty store. They now consult the
  **run count**, which is the only thing that separates "clean" from "unknown".
- **`analyze area-health` always presented a template as a measurement** (#508).
  It builds its report from a hardcoded empty row set, so it rendered "no area
  health data" no matter how much history existed. It now abstains
  unconditionally; wiring a real row set is tracked separately.
- **`guardian author-plan` on an empty diff answered "do not block"** (#508, the
  #456 class). It emitted `block: false, authored_count: 0` and exited 0 — "we
  examined nothing, therefore do not block". The payload now carries `checked`
  and `abstained`; the exit stays 0 (it is an authoring aid, not the gate) and
  stdout stays a single parseable object.
- **`history timeline` conflated "no history for this test" with "no history at
  all"** (#508). Both rendered identically; the empty store now abstains.
- **`review-test` / `flake-check` reported a clean bill of health over zero
  scanned files** (#508) — now exit **3**. Same for `canary-blackhawk` /
  `canary-savant` (advisory; `--strict` inherits exit 3) and `canary-katana` on
  an empty diff.
- **`canary overlay lint` called an empty overlay clean** (#508). Linting zero
  skills now abstains instead of printing `0 skill(s) — no issues`.
- **`guardian.yml` treated every non-zero exit as a failure** (#508). It now
  handles exit 3 distinctly — annotate and pass, since a docs-only PR has
  nothing to gate — while exit 1 stays red. The two `continue-on-error` steps in
  `harness-quality.yml` now annotate on failure instead of going quietly green.

### Notes for consumers

If a pipeline step newly exits **3**, that command was already verifying nothing
— the exit code is the first time it has been able to say so. Treat `3` as
"empty input, nothing checked" and `1` as "a real finding"; collapsing them back
into "non-zero" reintroduces exactly the blindness this release removes.

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

[Unreleased]: https://github.com/bop-clocktower/canary/compare/v6.6.0...HEAD
[6.6.0]: https://github.com/bop-clocktower/canary/compare/v6.5.0...v6.6.0
[6.5.0]: https://github.com/bop-clocktower/canary/compare/v6.4.0...v6.5.0
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
