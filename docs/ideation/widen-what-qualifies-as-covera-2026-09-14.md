---
topic:
  Widen what qualifies as coverage-verified — Cobertura parsing, the producer
  contract, and coverage-delta on touched units
generated_at: 2026-09-14T01:58:18Z
strategy_grounded: true
strategy_path: STRATEGY.md
count_requested: 10
count_generated: 10
ranking_formula:
  '(impact × confidence) ÷ effort; strategy-alignment tiebreaker (max +0.75)
  applied only when |Δbase_score| ≤ 0.05'
---

<!-- markdownlint-disable-file MD013 -->

# Ideation: Widen what qualifies as coverage-verified

## Inputs

- Topic: Widen what qualifies as coverage-verified — Cobertura parsing, the
  producer contract, and coverage-delta on touched units
- Generated: 2026-09-14T01:58:18Z
- Strategy grounding: enabled — `STRATEGY.md` present and valid; track "Coverage
  evidence fidelity" is this topic's anchor

## Method

Candidates were grounded in a live read of the shipped coverage surface, not
generated from the track blurb. Two of the track's three named items are already
built and were deliberately excluded as candidates: Cobertura parsing exists at
`ts/src/guardian/diff-coverage/formats/cobertura.ts` (a targeted scanner pinned
to the canonical `<coverage>…<class filename><line number hits>` shape, with
pre-parse oversize and `<!ENTITY>` guards), and coverage-delta on touched units
shipped as issue #606 / PR #881 at
`ts/src/guardian/diff-coverage/coverage-delta.ts`. Every candidate below traces
to a specific gap in that code:

- `report-tier.ts:parseByFormat` dispatches on the report's **filename**
  (`.json` / `.info` / `lcov` / `.xml`), so a correct report under an
  unrecognized name is unreadable and a non-Cobertura `.xml` is read as
  Cobertura-then-rejected.
- `cobertura.ts` documents that native JaCoCo (`<report>` root) "correctly
  returns `null`", and that branch / `condition-coverage` data is "intentionally
  dropped".
- `orchestrator.ts:resolveCoverageWithInput` accepts exactly one `coveragePath`,
  and nothing in the read path binds the report to the head commit.
- `types.ts:matchFile` resolves a unit only on an exact key or a **unique**
  path-boundary suffix match; ambiguity and source-root prefixes both collapse
  into the same silent tier drop.
- `coverage-delta.ts` requires `--base-coverage`, which its own header notes
  "most CI never uploads" — the accepted risk #606 shipped with.
- `coverage-json-lint.ts` lints canary's own JSON shape only; no versioned
  contract or conformance kit exists for a third-party producer.

All ten objections were left standing (the run elected to rebut none). Each is
recorded below as an accepted downside and an implementation-time risk to verify
— not as a rebutted concern.

## Ranked candidates

### 1. `canary coverage doctor <report>` — a diagnostic that explains why a report yielded no usable records and which changed paths failed to match — score: 9.00

- Candidate #7 (generation order)
- Persona: the engineer mid-development whose guardian run printed "coverage
  unavailable — report at 'coverage.xml' yielded no usable records" and who has
  no way to find out which of the six rejection paths fired.
- Complexity: low
- Impact / Confidence / Effort: H/H/L — base score 9.00
- Strategy alignment: +0.5 track:Coverage evidence fidelity, +0.25 Our approach
  (degrade loudly rather than silently guessing) = +0.75 — recorded but NOT
  applied (|Δ| to the next candidate is 2.25 > 0.05) — final score 9.00
- Strongest objection: A diagnostic command widens nothing by itself — it moves
  zero findings from heuristic to coverage-verified, so on the track's own
  metric ("coverage-verified finding share") it scores exactly nil, and it
  competes for the same effort as a reader that would actually move the number.
  Most likely failure mode: it ships, operators never discover it because the
  failing guardian run does not mention it, and it becomes an unrun command that
  documents a problem instead of fixing it. What would need to be true for the
  objection not to hold: the degradation notice emitted by
  `coverageDegradedNotice` would have to name the command inline, so the
  diagnostic is reached from the failure rather than from the docs.

### 2. Dispatch coverage-report format by sniffing content instead of by filename — score: 6.75

- Candidate #1 (generation order)
- Persona: the engineer mid-development whose CI writes a perfectly valid report
  to `coverage/report.dat`, `lcov.dat`, or `cov.txt` and who is dropped to the
  heuristic tier for the filename alone.
- Complexity: low
- Impact / Confidence / Effort: M/H/L — base score 6.00
- Strategy alignment: +0.5 track:Coverage evidence fidelity, +0.25 Who it's for
  / Our approach (fidelity tier should reflect the evidence, not the file
  extension) = +0.75 — applied (tie window with candidate #4) — final score 6.75
- Strongest objection: Sniffing trades a loud, predictable rejection for a
  quiet, probabilistic one — the current `parseByFormat` is honest precisely
  because it refuses to guess, and a sniffer that mistakes one dialect for
  another produces a COVERAGE_VERIFIED verdict from a mis-parse, which is
  strictly worse than the heuristic tier it replaced because it carries the
  highest fidelity label. Most likely failure mode: a JSON report that is not
  canary's shape sniffs as canary-json, parses into a thin index, and matches a
  handful of units with wrong hit counts. What would need to be true: each
  reader would need a cheap, high-specificity signature check (lcov `SF:`/`DA:`
  prefixes, a `<coverage>` root, canary-json's required keys) that fails closed
  and falls through to the next reader rather than to a partial parse.

### 3. Go `coverprofile` reader (`mode: set|count|atomic` blocks) as a first-class report format — score: 6.50

- Candidate #4 (generation order)
- Persona: Go teams, who have no Cobertura or lcov emitter in the standard
  toolchain and are therefore structurally unable to reach the coverage-verified
  tier today.
- Complexity: low
- Impact / Confidence / Effort: M/H/L — base score 6.00
- Strategy alignment: +0.5 track:Coverage evidence fidelity — applied (tie
  window with candidate #1) — final score 6.50
- Strongest objection: The Go coverprofile is block-based, not line-based — each
  record is `file:startLine.startCol,endLine.endCol numStmts count` — so
  converting it to the `{line: hits}` shape `ReportIndex` requires expanding
  every block across its line span, which credits non-statement lines inside a
  block as measured and inflates the coverable denominator the
  `matchUnitsToIndex` evidence string now states explicitly. Most likely failure
  mode: a changed comment or closing brace inside a covered block is reported as
  a covered coverable line, quietly weakening the denominator honesty that #508
  and #554 were built to establish. What would need to be true: the expansion
  would have to mark only the block's start line as definitively coverable, or
  the coverable set would have to be narrowed by a language-aware statement
  filter.

### 4. Accept `--coverage` repeatedly and merge the report indexes into one — score: 4.50

- Candidate #5 (generation order)
- Persona: the engineer on a polyglot monorepo whose PR touches both a
  TypeScript package (jest lcov) and a Python service (coverage.xml), and who
  can only feed the guardian one of the two.
- Complexity: medium
- Impact / Confidence / Effort: H/H/M — base score 4.50
- Strategy alignment: +0.5 track:Coverage evidence fidelity — recorded but NOT
  applied (|Δ| to the adjacent candidates is 2.00 and 0.75, both > 0.05) — final
  score 4.50
- Strongest objection: Merging indexes creates a collision semantics question
  the single-report path never had to answer — when two reports both speak to
  the same path with different hit counts (a file exercised by both a unit and
  an integration suite, or the same file instrumented twice at different roots),
  max-merge overstates coverage and first-wins makes the verdict depend on CLI
  argument order, which is a reproducibility regression for a gate whose whole
  pitch is determinism. Most likely failure mode: a duplicated path across two
  reports silently max-merges a 0-hit line to covered and a real uncovered
  changed line stops being reported. What would need to be true: the merge rule
  would need to be stated in the evidence string itself, and a path present in
  more than one report with disagreeing hits would need to surface as a named
  degradation rather than be resolved silently.

### 5. Bind a coverage report to the head commit and refuse the coverage-verified tier for a stale one — score: 3.75

- Candidate #2 (generation order)
- Persona: the engineer mid-development whose local or CI working tree still
  holds an `lcov.info` from a previous run, and who receives a confident
  COVERAGE_VERIFIED pass built on evidence that predates the change under
  review.
- Complexity: medium
- Impact / Confidence / Effort: H/M/M — base score 3.00
- Strategy alignment: +0.5 track:Coverage evidence fidelity, +0.25 Our approach
  (auditable provenance is the precondition for letting an agent near a merge
  gate) = +0.75 — applied (tie window) — final score 3.75
- Strongest objection: This narrows what qualifies as coverage-verified rather
  than widening it, so it moves the track's headline metric the wrong way and
  will read to operators as canary breaking a gate that worked yesterday — and
  the binding itself is unreliable, because no standard coverage format carries
  the commit SHA, leaving only mtime-versus-checkout heuristics that are wrong
  in every CI that restores a cache or does a shallow clone. Most likely failure
  mode: false staleness on a cache-restoring runner, operators pass the
  inevitable `--allow-stale-coverage` escape hatch once, and it is in their
  workflow forever. What would need to be true: canary's own producers would
  have to stamp the SHA into a sidecar, and third-party reports would have to
  degrade to a labelled "provenance unknown" sub-state rather than to a hard
  refusal.

### 6. Resolve the base coverage report automatically from a SHA-keyed store of main's last green run — score: 3.75

- Candidate #10 (generation order)
- Persona: the engineer whose PR would regress a well-covered file, on one of
  the many repos whose CI never uploads a base-branch coverage artifact — the
  accepted risk `coverage-delta.ts` shipped with.
- Complexity: medium
- Impact / Confidence / Effort: H/M/M — base score 3.00
- Strategy alignment: +0.5 track:Coverage evidence fidelity (coverage-delta on
  touched units is a named track item), +0.25 Our approach (the delta currently
  classifies `unavailable` rather than clean — this is what makes it run at all)
  = +0.75 — applied (tie window) — final score 3.75
- Strongest objection: A SHA-keyed store is persistent state, and canary's
  second strategic bet is a deterministic Tier-0 engine that is reproducible,
  cheap and secret-free — a resolver that reaches for a CI artifact API needs
  network access and a token inside the gate, which is exactly the property the
  Tier-0 boundary exists to protect. Most likely failure mode: the store is
  missing or stale for the merge-base, the delta silently compares against the
  wrong ancestor, and a regression is scored against a base that never existed
  on that line of history. What would need to be true: the resolver would have
  to live strictly outside the Tier-0 engine as an optional input producer, and
  a base whose SHA is not an ancestor of head would have to classify
  `unavailable` rather than be compared anyway.

### 7. A pluggable format-reader registry backed by a shared conformance-fixture corpus — score: 3.50

- Candidate #3 (generation order)
- Persona: the contributor adding the seventh coverage format, who today must
  hand-edit `parseByFormat`'s if-chain and invent their own fixtures with no
  shared definition of what a correct reader does.
- Complexity: high
- Impact / Confidence / Effort: M/H/M — base score 3.00
- Strategy alignment: +0.5 track:Coverage evidence fidelity — applied (tie
  window) — final score 3.50
- Strongest objection: With four readers in the tree, an extraction is
  speculative generality — the if-chain in `parseByFormat` is six lines and
  perfectly legible, while a registry adds an indirection layer, a registration
  seam, and a new arch-allowance and dead-export surface to the ratchets, paying
  real cost now for a contributor who may never arrive. Most likely failure
  mode: the registry ships, no third-party reader is ever registered, and the
  abstraction is carried as maintenance weight on a hot path. What would need to
  be true: two or more concrete new formats would have to be committed to first,
  so the registry is extracted from real duplication rather than anticipated
  duplication.

### 8. Source-root and path-prefix mapping, including Cobertura's `<sources>` element, so report paths resolve to diff paths — score: 3.50

- Candidate #8 (generation order)
- Persona: the engineer on a monorepo or a .NET/JaCoCo-converted pipeline whose
  report emits build-root-relative or package-qualified filenames that
  `matchFile`'s suffix-boundary rule cannot bind to the diff's repo-relative
  paths.
- Complexity: medium
- Impact / Confidence / Effort: M/H/M — base score 3.00
- Strategy alignment: +0.5 track:Coverage evidence fidelity — applied (tie
  window) — final score 3.50
- Strongest objection: Every prefix rewrite is a chance to bind coverage to the
  wrong file, and `matchFile`'s current conservatism — resolve only on an exact
  key or a _unique_ boundary match, return `null` otherwise — is the property
  that makes a COVERAGE_VERIFIED label trustworthy; loosening it to satisfy
  monorepos raises the probability that two same-named files in different
  packages cross-bind, which produces a confident verdict about the wrong code.
  Most likely failure mode: a mapping rule makes two candidates match where one
  matched before, and the "unique match" guard starts silently resolving the
  first one. What would need to be true: mapping would have to be explicit
  operator configuration rather than inference, and a rule that turns one
  candidate into several would have to be reported as ambiguity instead of
  resolved.

### 9. A branch-coverage sub-tier so a changed line whose branch was never taken stops scoring as covered — score: 2.75

- Candidate #6 (generation order)
- Persona: the engineer mid-development whose changed `if` line is executed by a
  single happy-path test and reads as fully covered, which is the exact shape of
  the target problem — a gate uncorrelated with whether a regression would be
  caught.
- Complexity: high
- Impact / Confidence / Effort: H/M/H — base score 2.00
- Strategy alignment: +0.5 track:Coverage evidence fidelity, +0.25 Target
  problem (line coverage maxed out without proving anything) = +0.75 — applied
  (tie window) — final score 2.75
- Strongest objection: Branch data is the least standardized part of every
  coverage format — Cobertura's `condition-coverage="50% (1/2)"` is a free-text
  attribute, lcov's `BRDA:` records disagree between instrumenters about what a
  branch even is, and canary's own coverage-json has no branch concept at all —
  so a branch sub-tier would be available for some producers and absent for
  others, splitting COVERAGE_VERIFIED into a two-class label whose meaning
  depends on which tool the team happens to run. Most likely failure mode: teams
  on a branch-reporting producer see strictly more findings than teams on an
  equivalent line-only producer and conclude canary is noisy rather than that
  their evidence is richer. What would need to be true: the tier ladder would
  have to carry branch availability as an explicit per-report capability, so its
  absence degrades loudly the way a missing report already does.

### 10. A versioned, published producer contract plus a conformance kit a third-party emitter can run to certify itself — score: 2.50

- Candidate #9 (generation order)
- Persona: the author of a test framework or CI plugin who wants to emit
  canary-native coverage, and who today has only `coverage-json-lint.ts`'s
  internal validation to reverse-engineer.
- Complexity: high
- Impact / Confidence / Effort: H/M/H — base score 2.00
- Strategy alignment: +0.5 track:Coverage evidence fidelity — applied (tie
  window) — final score 2.50
- Strongest objection: A published contract is a compatibility commitment made
  before there is a single external producer to honor it — it freezes the
  coverage-json shape at the moment canary most needs to change it (no branch
  data, no provenance field, no multi-root support, all of which the candidates
  above would add), and a versioned contract with no consumers is pure carrying
  cost that arrives precisely when the schema should still be liquid. Most
  likely failure mode: v1 ships, the branch or provenance work lands two months
  later, and canary either breaks its own published contract or carries a v1
  reader forever for zero real producers. What would need to be true: at least
  one external producer would have to be committed to adopting it, and the
  contract would have to be published only after the provenance and branch
  fields it will obviously need are settled.

## Handoff

- Ideation artifact written:
  `docs/ideation/widen-what-qualifies-as-covera-2026-09-14.md`
- Top pick: `canary coverage doctor <report>` — score 9.00
- Next: invoke `/harness:brainstorming "<candidate>"` to take a candidate into a
  spec, OR `/harness:roadmap` to enqueue picks for later. This artifact files
  nothing on its own.
