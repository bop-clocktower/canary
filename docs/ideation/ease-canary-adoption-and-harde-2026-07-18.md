---
topic: Ease canary adoption and harden skill-usage confidence (audit-grounded)
generated_at: 2026-07-18T22:36:08Z
strategy_grounded: false
strategy_path: null
count_requested: 12
count_generated: 16
ranking_formula: '(impact × confidence) ÷ effort; strategy-alignment tiebreaker (max +0.75) applied only when |Δbase_score| ≤ 0.05'
---

<!-- markdownlint-disable-file MD013 -->

# Ideation: Ease canary adoption and harden skill-usage confidence

## Inputs

- Topic: Ease canary adoption and harden skill-usage confidence (audit-grounded)
- Generated: 2026-07-18T22:36:08Z
- Strategy grounding: disabled — STRATEGY.md not present at repo root

## Method

Four parallel research passes audited the live repo before candidate generation, rather than
generating ideas from first principles: (1) skill/agent/command inventory quality, (2)
onboarding/UX friction in README/AGENTS.md/docs, (3) already-documented pain points and open
GitHub issues (#293, #294, #295), (4) CLI error-handling and confidence-signal gaps in
`agent/`. Every candidate below traces to a concrete finding from one of those passes.

## Ranked candidates

### 1. Slash commands for init/migrate — score: 9.00

- Persona: brand-new user running their very first canary command, who won't know to invoke an agent by name.
- Complexity: low
- Impact / Confidence / Effort: H/H/L — base score 9.00
- Strategy alignment: none (STRATEGY.md absent) — final score 9.00
- Strongest objection: this is mostly wiring/documentation, but if `canary-initializer`/`canary-migrator` have undocumented side effects, the new command surface needs the same guardrails as every other command, not just a pointer.
- Objection answered: no — user opted to proceed with fixes directly rather than rebutting individually; treated as an accepted downside to verify during implementation.

### 2. Fix redact-on-parse-failure leak — score: 9.00

- Persona: any user whose history-store credentials could leak into logs/output when the redaction path throws.
- Complexity: low
- Impact / Confidence / Effort: H/H/L — base score 9.00
- Strategy alignment: none — final score 9.00
- Strongest objection: essentially none — closest to a pure bugfix. Only risk is scope creep if bundled with the broader config-validation idea (#8) instead of shipped standalone and fast.
- Objection answered: no — accepted; will ship standalone as the objection itself recommends.

### 3. Skill router frontmatter backfill — score: 6.00

- Persona: a user who types natural language and expects auto-routing, doesn't know exact skill names.
- Complexity: low
- Impact / Confidence / Effort: M/H/L — base score 6.00
- Strategy alignment: none — final score 6.00
- Strongest objection: frontmatter alone doesn't fix underlying content problems in the same files (see #6's contradiction) — could create false confidence the skill is solid when only its visibility improved.
- Objection answered: no — accepted; frontmatter fix will ship alongside, not instead of, addressing #6.

### 4. Confidence-score documentation for classifier.py — score: 6.00

- Persona: engineer deciding whether to trust a classifier result unattended in CI.
- Complexity: low (docs) to high (real computation)
- Impact / Confidence / Effort: M/H/L — base score 6.00
- Strategy alignment: none — final score 6.00
- Strongest objection: the cheap "document it's heuristic" version is honest but doesn't fix the real problem — a CI user still can't distinguish a well-founded 0.95 from an arbitrary one; real computation needs calibration data that may not exist yet.
- Objection answered: no — accepted; docs-only ships now as an explicit stopgap, not a final state.

### 5. README/skill-catalog full sync — score: 4.50

- Persona: prospective adopter scanning README to decide if canary fits their needs.
- Complexity: medium
- Impact / Confidence / Effort: H/H/M — base score 4.50
- Strategy alignment: none — final score 4.50
- Strongest objection: a fully comprehensive catalog without curation by use-case could become noise that hurts discoverability more than the current gaps do.
- Objection answered: no — accepted; will organize by use-case grouping rather than a flat list.

### 6. Cross-link guardian blast-radius with canary-failure-impact — score: 4.00

- Persona: engineer assessing "what breaks if I change this" who unknowingly gets the weaker grep heuristic when a more rigorous tool already exists.
- Complexity: low
- Impact / Confidence / Effort: M/M/L — base score 4.00
- Strategy alignment: none — final score 4.00
- Strongest objection: guardian's OpenAPI-diff approach may not generalize to non-API changes that `canary-failure-impact` currently covers — merging could reduce coverage rather than improve fidelity.
- Objection answered: no — accepted; will cross-link and document scope difference rather than merge/replace.

### 7. Company-knowledge bootstrap skill — score: 4.00

- Persona: team lead setting up canary for their org for the first time.
- Complexity: low
- Impact / Confidence / Effort: M/M/L — base score 4.00
- Strategy alignment: none — final score 4.00
- Strongest objection: if `.canary/company.json` requires org-specific manual input a bootstrap skill can't infer, it only gets the user partway there and the underlying friction persists.
- Objection answered: no — accepted; bootstrap will scaffold + prompt for the non-inferable fields rather than claim full automation.

### 8. Config-validation fail-fast layer — score: 3.00

- Persona: engineer whose CI run silently misbehaves because of a config typo that was never surfaced.
- Complexity: medium
- Impact / Confidence / Effort: H/M/M — base score 3.00
- Strategy alignment: none — final score 3.00
- Strongest objection: strict validation could turn previously-tolerated malformed-but-working configs into hard failures on upgrade, breaking existing CI pipelines.
- Objection answered: no — accepted; will implement as a clear warning first (deprecation-style), not an immediate hard fail, per the objection's own recommendation.

### 9. Canonicalize the "write a test" path — score: 3.00

- Persona: engineer getting mutually exclusive instructions depending on which doc (skill vs. agent) they land on.
- Complexity: medium
- Impact / Confidence / Effort: H/M/M — base score 3.00
- Strategy alignment: none — final score 3.00
- Strongest objection: the three paths (`canary-generate-test` CLI pipeline, `canary-test-author` interactive, `canary-test-generator` MCP retry loop) might be intentional differentiation, not accidental drift — collapsing them could remove a real use case nobody documented as such.
- Objection answered: no — accepted; will resolve by cross-referencing and clarifying when to use each rather than deleting any path, since ownership/intent couldn't be confirmed.

### 10. Fleet analytics skill wrapper — score: 3.00

- Persona: QA lead wanting a fleet-wide flake/health report, not a single-test diagnosis.
- Complexity: medium
- Impact / Confidence / Effort: H/M/M — base score 3.00
- Strategy alignment: none — final score 3.00
- Strongest objection: fleet-wide analytics may need a dashboard/visual surface to be genuinely useful, not a chat-turn skill that dumps a wall of text.
- Objection answered: no — accepted; will ship a compact summary-format skill first as a low-cost validation before any larger investment.

### 11. CLI command-surface test backfill — score: 3.00

- Persona: maintainer merging changes to error-handling paths with no safety net today.
- Complexity: medium
- Impact / Confidence / Effort: M/H/M — base score 3.00
- Strategy alignment: none — final score 3.00
- Strongest objection: tests only lock in current (already-flawed) silent-failure behavior as spec unless paired with #8's actual fix — writing tests first without fixing the swallowing logic risks codifying the bug.
- Objection answered: no — accepted; will sequence after #8 and #2, not before.

### 12. Fail-loud auto-detection pattern — score: 2.00

- Persona: new user on a less-common stack (e.g. WebdriverIO/Appium) whose tools silently do less than expected instead of telling them why.
- Complexity: high
- Impact / Confidence / Effort: H/M/H — base score 2.00
- Strategy alignment: none — final score 2.00
- Strongest objection: spans three subsystems (`canary migrate` framework detection, `canary doctor --persona`, historical SetupWizard) with different constraints — a "single pattern" framing risks a half-applied fix that satisfies none of them well.
- Objection answered: no — accepted; will build one shared uncertain-detection helper and apply it to the two live subsystems (issues #294, #295) first, deferring the historical SetupWizard case since it's already deprecated.

## Supplement: harness review/craft skill sweep (2026-07-18)

Per user request, ran the harness review/craft skill suite against this repo to check
coverage beyond the manual audit. Mechanical checks (`check-harness-strength`, `cleanup`,
`check-security`, `check-deps`, `insights`) ran cleanly and produced real findings. The
LLM-judgment craft tools (`copy-craft`, `spec-craft`, `security-craft`) require a configured
`HARNESS_CRAFT_LLM` provider not present in this environment and returned empty scaffolding;
`naming-craft`'s in-session mode ran but extracted garbage pseudo-identifiers from Python
docstring prose (a tool/AST-parser limitation on this codebase, not a canary finding) and was
abandoned after two probes. Four new candidates below, folded into the same ranking.

### 13. Fix theatre quality-gate hooks — score: 9.00

- Persona: any contributor relying on pre-commit/pre-push hooks to catch a regression before it ships.
- Complexity: low
- Impact / Confidence / Effort: H/H/L — base score 9.00
- Strategy alignment: none — final score 9.00
- Source: `harness check-harness-strength` (STRENGTH-001 ×2, score 58/100, tier "at-risk"). `.harness/hooks/quality-warner.js` and `.harness/hooks/telemetry-reporter.js` both unconditionally `exit 0`, so neither can ever block a bad commit — a hook that can't fail is worse than no hook, because it looks like a safety net that isn't one.
- Strongest objection: making these blocking could break contributor workflows if the underlying checks they wrap are noisy/flaky today — flipping to blocking without first verifying the checks are reliable will just train people to reach for `--no-verify`.
- Objection answered: no — accepted; will sanity-check each hook's underlying check for flakiness before removing the `exit 0` escape hatch.

### 14. Set architecture thresholds in harness.config.json — score: 4.00

- Persona: maintainer trusting `harness check-arch`/`insights` to catch coupling regressions that it currently structurally cannot.
- Complexity: low
- Impact / Confidence / Effort: M/M/L — base score 4.00
- Strategy alignment: none — final score 4.00
- Source: `harness check-harness-strength` (STRENGTH-004). Architecture layers are declared in `harness.config.json` but no `architecture.thresholds` (e.g. `maxFanOut`, `maxDependencyDepth`) are set, so the check has nothing to enforce.
- Strongest objection: setting thresholds without first measuring the current baseline risks either being too strict (immediate false positives) or too loose (a no-op that looks configured but isn't).
- Objection answered: no — accepted; will measure current fan-out/depth first and set thresholds just above baseline rather than guessing.

### 15. Fix live doc-drift in roadmap.md — score: 6.00

- Persona: contributor trusting the live roadmap to reflect current implementation reality.
- Complexity: low
- Impact / Confidence / Effort: M/H/L — base score 6.00
- Strategy alignment: none — final score 6.00
- Source: `harness cleanup` entropy/drift scan. 5 renamed/not-found symbol references in the **live** (non-archived) `docs/roadmap.md`: `maxFailures`, `forbidOnly`, `retries`, `coverage`, `canary_run_id`. This is distinct from the already-known `roadmap-archive.md` drift (expected, historical) and from the harness#838 CI-suppression-parity issue already tracked in memory.
- Strongest objection: this is exactly the class of finding already blocked by harness#838 (CI drift check doesn't honor local suppression config) — fixing the symptom here doesn't fix the root parity bug, so equivalent drift will likely reappear.
- Objection answered: no — accepted; will fix the 5 stale references now as a point-fix, independent of the still-blocked harness#838 upstream issue.

### 16. Add schema validation before JSON.parse in npm/src/engine-checks.ts — score: 6.00

- Persona: user whose engine-check config parsing could throw an unclear error (or silently act on malformed data) if the input is malformed.
- Complexity: low
- Impact / Confidence / Effort: M/H/L — base score 6.00
- Strategy alignment: none — final score 6.00
- Source: `harness check-security` (SEC-DES-001, warning). `npm/src/engine-checks.ts:55` calls `JSON.parse` on potentially untrusted input with no schema validation.
- Strongest objection: the "untrusted input" here is most likely a local config file, not a network-facing payload — actual exploitability is low; this is a robustness fix, not a critical vulnerability.
- Objection answered: no — accepted; will frame as a minimal try/catch + shape check for robustness, not overbuild it as a security-critical fix.

## Combined final ranking (16 candidates)

| Rank | Score | Candidate |
| --- | --- | --- |
| 1 | 9.00 | #1 Slash commands for init/migrate |
| 1 | 9.00 | #2 Fix redact-on-parse-failure leak |
| 1 | 9.00 | #13 Fix theatre quality-gate hooks |
| 4 | 6.00 | #3 Skill router frontmatter backfill |
| 4 | 6.00 | #4 Confidence-score documentation for classifier.py |
| 4 | 6.00 | #15 Fix live doc-drift in roadmap.md |
| 4 | 6.00 | #16 Add schema validation before JSON.parse (engine-checks.ts) |
| 8 | 4.50 | #5 README/skill-catalog full sync |
| 9 | 4.00 | #6 Cross-link guardian blast-radius with canary-failure-impact |
| 9 | 4.00 | #7 Company-knowledge bootstrap skill |
| 9 | 4.00 | #14 Set architecture thresholds in harness.config.json |
| 12 | 3.00 | #8 Config-validation fail-fast layer |
| 12 | 3.00 | #9 Canonicalize the "write a test" path |
| 12 | 3.00 | #10 Fleet analytics skill wrapper |
| 12 | 3.00 | #11 CLI command-surface test backfill |
| 16 | 2.00 | #12 Fail-loud auto-detection pattern |

## Handoff

Ideation artifact written: `docs/ideation/ease-canary-adoption-and-harde-2026-07-18.md`
Top picks (3-way tie): #1 Slash commands for init/migrate, #2 Fix redact-on-parse-failure leak, #13 Fix theatre quality-gate hooks — score 9.00 each
User directive: proceed to implement all 16 candidates directly rather than routing through `/harness:brainstorming` per-item.
