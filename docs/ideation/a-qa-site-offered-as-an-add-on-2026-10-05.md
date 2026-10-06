---
topic:
  "A QA site offered as an add-on feature of canary, or embeddable into a
  consumer's existing site"
generated_at: 2026-10-05T18:47:28Z
strategy_grounded: true
strategy_path: STRATEGY.md
count_requested: 10
count_generated: 11
ranking_formula:
  '(impact × confidence) ÷ effort; strategy-alignment tiebreaker (max +0.75)
  applied only when |Δbase_score| ≤ 0.05'
---

# Ideation: QA site as a canary add-on or embed

## Inputs

- Topic: A QA site offered as an add-on feature of canary, or embeddable into a
  consumer's existing site
- Generated: 2026-10-05T18:47:28Z
- Strategy grounding: enabled — STRATEGY.md v2 (last updated 2026-07-21).
  Primary anchor is the **Quality made legible** track and the secondary persona
  (client-success and delivery staff reading health without code).
- Count: 10 requested; 11 generated. Idea 11 was added during critique from the
  user's comment on idea 1 and scored independently — it is not a rescore of
  idea 1.
- Context that shaped the candidates:
  - `canary-test-cli/reporter` already pushes runs to the TestTracker / QA
    Intelligence Dashboard ingest API (`docs/wiki/Ingest-Reporter.md`).
  - The spec-pure `canary report` → `canary publish` path (unified-reporting
    Phase 2a) is still blocked (`docs/roadmap.md`).
  - Data canary already produces: run history (NDJSON / Supabase store), flake
    detection, `canary ci-ready` scoring, `.canary/test-inventory.json`,
    manhunter release dossier, briefing charters, signal digest.
  - STRATEGY.md "Not working on" forbids company-specific content in this repo,
    so anything here must be generic and themeable.

## Ranked candidates

### 1. Feed contract — score: 6.00

- Premise: A versioned `canary-site.json` feed contract that canary emits and
  any frontend renders.
- Persona: Integrators wiring canary into their own dashboards or portals.
- Complexity: low
- Impact / Confidence / Effort: M/H/L — base score 6.00
- Strategy alignment: +0.5 track:Quality made legible, +0.25 Our approach (feed
  carries fidelity tiers) — recorded, not applied (outside tie window) — final
  score 6.00
- Strongest objection: A contract with no renderer is shelfware — nobody adopts
  a schema they cannot see. Most likely failure mode: the schema ships, nothing
  reads it, and it drifts from what canary actually computes. What would need to
  be true for this objection to NOT hold: it ships together with at least one
  first-party consumer (ideas 3, 6, 9, or 11) that renders it from day one.
- Objection answered: no

### 2. Static site build — score: 4.50

- Premise: `canary site build` emits a self-contained static HTML site from run
  history, inventory, and ci-ready output.
- Persona: Delivery staff and engineering leads who need suite health without
  reading code.
- Complexity: medium
- Impact / Confidence / Effort: H/H/M — base score 4.50
- Strategy alignment: +0.5 track:Quality made legible — recorded, not applied
  (outside tie window) — final score 4.50
- Strongest objection: It overlaps the blocked `canary report` /
  `canary publish` spec (unified-reporting Phase 2a); building it separately
  risks a third reporting path beside the TestTracker reporter. Most likely
  failure mode: two renderers that drift apart. What would need to be true for
  this objection to NOT hold: the site _is_ Phase 2a's renderer, or explicitly
  unblocks it.
- Objection answered: no — the user agreed the objection holds ("that seems like
  an issue that we want to avoid"). Their comment, verbatim: "for 1 - that seems
  like an issue that we want to avoid. Can we do something like: offer a family
  of skills to use for creating a comprehensive and smart QA site and then use
  the canary site I created on netlify as the QA site for our own internal test
  tracking?" That comment became idea 11 below.

### 3. Playwright report layer — score: 4.00

- Premise: A canary layer for the Playwright HTML report — flake history and
  evidence labels added to the report consumers already host.
- Persona: QA engineers who already publish `playwright-report/`.
- Complexity: low
- Impact / Confidence / Effort: M/M/L — base score 4.00
- Strategy alignment: +0.5 track:Quality made legible, +0.25 Our approach
  (evidence labels) — recorded, not applied (outside tie window) — final score
  4.00
- Strongest objection: It depends on Playwright HTML-report internals, which are
  not a public API and change across versions, and it helps only Playwright
  users. Most likely failure mode: a Playwright minor release breaks it
  silently. What would need to be true for this objection to NOT hold: it uses
  only documented extension points (attachments, annotations) and never patches
  the report.
- Objection answered: no

### 4. Evidence-labeled badges — score: 3.75

- Premise: Evidence-tier-labeled SVG badges (coverage-verified %, flake rate)
  emitted per run for READMEs, Confluence, and portals.
- Persona: Repo maintainers and stakeholders who skim a README.
- Complexity: low
- Impact / Confidence / Effort: L/H/L — base score 3.00
- Strategy alignment: +0.5 track:Quality made legible, +0.25 Our approach
  (fidelity-labeled evidence) — applied (tie window, Δ = 0.00 with ideas 5–7) —
  final score 3.75
- Strongest objection: A green badge is the coverage-percentage vanity metric
  STRATEGY.md's Target problem names. Most likely failure mode: teams optimize
  the badge, not the evidence. What would need to be true for this objection to
  NOT hold: every badge carries its evidence tier and degrades loudly to
  "unverified" instead of showing a number when the tier drops.
- Objection answered: no

### 5. Embeddable web components — score: 3.50

- Premise: Embeddable web components (`<canary-health>`, `<canary-flakes>`,
  `<canary-release>`) on a CDN that read a published JSON feed.
- Persona: A consumer team with an existing internal QA or engineering portal.
- Complexity: medium
- Impact / Confidence / Effort: H/M/M — base score 3.00
- Strategy alignment: +0.5 track:Quality made legible — applied (tie window) —
  final score 3.50
- Strongest objection: Host sites vary in CSP, styling, and framework, so
  components that look right in the demo break in a real portal, and the CDN
  versioning contract is a permanent support commitment. Most likely failure
  mode: one consumer's CSP blocks the script and the integration is dropped.
  What would need to be true for this objection to NOT hold: Shadow-DOM
  isolation, a no-script fallback, and a version pinned in the URL.
- Objection answered: no

### 6. Release launch room — score: 3.50

- Premise: A release "launch room" page — manhunter dossier, mission briefing,
  and ci-ready verdict on one shareable go/no-go page per release or demo.
- Persona: Delivery staff preparing a client demo or launch.
- Complexity: medium
- Impact / Confidence / Effort: H/M/M — base score 3.00
- Strategy alignment: +0.5 track:Pre-release confidence — applied (tie window) —
  final score 3.50
- Strongest objection: Point-in-time pages rot — right the day before the demo,
  silently wrong a week later. Most likely failure mode: someone cites last
  month's page as current. What would need to be true for this objection to NOT
  hold: every page is pinned to a commit and timestamp with a visible "as of"
  label and an expiry.
- Objection answered: no

### 7. QA-site skill family + dogfood — score: 3.50

- Premise: A QA-site skill family (scaffold, wire data, add panels, theme) for
  building or extending a QA site, with canary's own Netlify site as the dogfood
  reference instance.
- Persona: Consumer teams that want their own QA site, or want to extend an
  existing one; canary itself via the dogfood instance.
- Complexity: medium
- Impact / Confidence / Effort: H/M/M — base score 3.00
- Strategy alignment: +0.5 track:Quality made legible (also serves Adoption and
  onboarding) — applied (tie window) — final score 3.50
- Origin: proposed by the user during critique as the replacement for idea 2's
  approach. Dogfood instance: the canary site the user deployed (described as
  Netlify; URL not recorded in this artifact). Related existing surface: this
  repo's GitHub `Production` environment is fed by the Vercel GitHub App
  (`canary` project). All 12 of its deployments failed on 2026-09-03 because the
  repo had no web surface, and #787 (#769) suppressed it with `vercel.json`
  `git.deploymentEnabled: false`. Deploying a real site from this repo means
  reversing that suppression and its `externalStatuses` entry in
  `.github/required-checks.json` — standing up that pipeline is the first
  concrete step of this idea.
- Strongest objection: If the skills generate _sites_ rather than consume a
  _contract_, every consumer ends up with a slightly different fork — idea 2's
  drift problem multiplied across N consumers. Separately, _internal_ test
  tracking on a Netlify site is only safe if the site is private or its data is
  de-identified: test titles and suite names are where client names leak (the
  exposure canary-strix exists to catch), and canary is meant to be pitched
  publicly. Most likely failure mode: forks diverge, or a consumer identifier
  appears on a public page. What would need to be true for this objection to NOT
  hold: the skills read a versioned feed (idea 1) and differ only in
  presentation, and the dogfood site publishes canary's own suites only.
- Objection answered: no

### 8. Per-PR QA preview — score: 2.00

- Premise: A per-PR QA preview page showing guardian findings by evidence tier,
  linked from the PR comment.
- Persona: The engineer or reviewer mid-development (STRATEGY.md's primary
  persona).
- Complexity: medium
- Impact / Confidence / Effort: M/M/M — base score 2.00
- Strategy alignment: +0.5 track:Test intelligence depth, +0.25 Our approach
  (evidence tiers) — recorded, not applied (outside tie window) — final score
  2.00
- Strongest objection: The guardian PR comment already carries these findings
  inline, so a page adds a click without adding information. Most likely failure
  mode: nobody clicks through. What would need to be true for this objection to
  NOT hold: the page shows something a comment cannot, such as a diff-annotated
  coverage view.
- Objection answered: no

### 9. Hosted SaaS dashboard — score: 1.50

- Premise: A hosted multi-tenant canary dashboard (SaaS) on the existing
  Supabase history store.
- Persona: Organizations that want canary results without hosting anything.
- Complexity: high
- Impact / Confidence / Effort: H/L/H — base score 1.00
- Strategy alignment: +0.5 track:Adoption and onboarding — applied (tie window,
  Δ = 0.00 with ideas 10–11) — final score 1.50
- Strongest objection: It takes on ops, security, tenant isolation, and possible
  PII/PHI in test names for a largely solo-maintained open-core repo, and it
  cuts against the "deterministic, secret-free Tier-0" bet. Most likely failure
  mode: an under-maintained service holding client data. What would need to be
  true for this objection to NOT hold: funding and a team — a business decision,
  not an engineering one.
- Objection answered: no

### 10. TestTracker convergence — score: 1.50

- Premise: TestTracker convergence — canary's site becomes the reference
  renderer for the QA Intelligence Dashboard ingest schema.
- Persona: Consumers already pushing runs to TestTracker.
- Complexity: high
- Impact / Confidence / Effort: M/L/M — base score 1.00
- Strategy alignment: +0.5 track:Quality made legible — applied (tie window) —
  final score 1.50
- Strongest objection: It couples the public open-core repo to one specific
  downstream dashboard, straining the "Not working on" boundary and the goal of
  canary as a pitchable asset. Most likely failure mode: company-shaped fields
  leak into the public schema. What would need to be true for this objection to
  NOT hold: the ingest schema is fully generic and TestTracker is one adapter
  among several.
- Objection answered: no

### 11. Quality ledger — score: 1.50

- Premise: A quality-ledger page of accrued per-contributor signal (tests that
  caught regressions, flakes fixed, gates earned).
- Persona: Engineering managers and the engineers themselves.
- Complexity: medium
- Impact / Confidence / Effort: M/L/M — base score 1.00
- Strategy alignment: +0.5 track:Quality made legible ("recognizing sound
  engineering") — applied (tie window) — final score 1.50
- Strongest objection: Per-person metrics turn into a leaderboard that gets
  gamed or read as surveillance, and they put identity data on a page. Most
  likely failure mode: engineers read it as performance monitoring and adoption
  drops. What would need to be true for this objection to NOT hold: opt-in,
  team-level by default, celebrating events rather than ranking people.
- Objection answered: no

## Reading the ranking

The top four compose rather than compete: the feed contract (#1) is the backbone
that removes the drift objection from the static site (#2), the Playwright layer
(#3), the web components (#5), and the skill family (#7). A natural
brainstorming scope is **#1 + #7**, with the Netlify site as the first renderer
of the feed — which answers #1's "no renderer" objection and #7's "forks
diverge" objection in one move.
