---
status: proposal
issue: 312
date: 2026-07-19
keywords:
  - pr-guardian
  - diff-coverage
  - test-quality-audit
  - agentless-fallback
  - capability-boundary
  - soft-hard-gate
  - pre-commit
  - canary-write-test
  - fidelity-labels
  - tier-ladder
---

# canary-pr-guardian — PR test-guardian skill

## Overview & Goals

### Overview

`canary-pr-guardian` is a canary orchestrator that runs a per-change
test-quality loop: it scopes a diff, determines whether the new/changed code is
tested, audits the quality of the affected tests, and logs ranked,
**fidelity-labeled** findings — then, where a runtime is available, authors the
missing or strengthened tests via the verified `canary-write-test` skill. It is
the **PR-scoped, write-capable sibling** of the on-demand
`canary-test-pipeline`, and it exposes two independently-configurable surfaces:
a **PR check** (CI-wired) and a **pre-commit check**.

Its defining constraint is graceful degradation across a **capability ladder**.
The deterministic core (diff-coverage → comment) runs on stock CI with no agent,
no secret, and no write permission — so the baseline value (findings logged on
every PR) is _guaranteed_. LLM-driven test-quality audit and test authoring are
additive tiers that engage only where an agent runtime exists (at the
developer's desk today; in a CI runner later). The guardian **composes**
existing capabilities rather than reimplementing them — harness
`analyze_diff`/`get_impact` for coverage, `canary-review-test` for quality
audit, `canary-write-test` for authoring — making it a thin, well-tested
orchestration layer.

### Goals

1. **Guarantee agentless findings on every PR.** The Tier 0 deterministic pass
   (diff-coverage via harness graph tools + heuristic fallback) posts a ranked
   findings comment on stock GitHub Actions — no runtime, secret, or write
   access required.
2. **Never mislead on fidelity.** Every finding is labeled by how it was derived
   (`coverage-verified` / `graph-verified` / `heuristic`), and any
   requested-but-unavailable tier degrades _loudly_, never silently.
3. **Close the "is new code tested?" loop with zero manual prompting where a
   runtime exists.** The guardian authors the missing/strengthened tests (via
   `canary-write-test`) rather than only flagging the gap.
4. **Two independently-toggleable surfaces.** PR check and pre-commit check each
   enable/disable on their own, with a soft→hard gate promotion
   (`gate: soft|hard`) per repo.
5. **Ship v1 fully in-repo, under our control**, with a capability boundary that
   lets a future harness-hosted CI-agent tier attach without redesign.

### Non-Goals (v1)

- **Building an agent-in-CI runtime.** v1 CI is Tier 0 only; the read-only
  (Tier 1) and write-back (Tier 2) CI tiers are deferred to when a runner
  exists.
- **Autonomous write-back to a PR branch in CI** (and its
  loop-guard/fork/concurrency machinery) — deferred with Tier 2.
- **Running arbitrary project test suites in CI** for coverage — the guardian
  consumes coverage data, it doesn't execute suites (that stays
  `canary-ci-ready`'s job).
- **A generic multi-domain gate** (docs-/security-guardian) — if that emerges,
  it belongs in the future harness gate host, not here.

### Assumptions

- **Git host / CI is GitHub for v1.** The PR surface targets GitHub Actions and
  the PR-comment API; other hosts are out of scope until a surface is added.
- **Git is available in every surface** — diff scoping shells `git`.
- **The harness graph and CLI are optional.** A populated `.harness/graph/`
  improves fidelity; its absence degrades to the heuristic tier and never
  blocks.
- **The agent tiers require a Claude-compatible runtime at the desk**
  (in-session / pre-commit); v1 assumes none in CI.
- **The engine is Python** (`agent/`), consistent with canary's core.

### Tier ladder (summary)

| Tier  | Adds                     | Runtime           | Write | v1 status                                  |
| ----- | ------------------------ | ----------------- | ----- | ------------------------------------------ |
| **0** | diff-coverage → comment  | none              | no    | **default, ships now**                     |
| **1** | + LLM test-quality audit | agent (read-only) | no    | opt-in; activates when a CI runtime exists |
| **2** | + author + push tests    | agent             | yes   | opt-in; deferred (future CI host)          |

Authoring at the **desk** (in-session / pre-commit) delivers Tier-2-style value
in v1 without a CI runtime.

## Decisions Made

Each decision carries its rationale and the alternatives weighed. These are the
canonical statements; later sections reference them by name.

### D1 — Agent boundary: agentless-in-CI, agent-at-desk, behind a capability boundary

**Choice.** The deterministic pass runs in CI on stock Actions; the LLM tiers
run wherever a runtime already lives (developer's session / pre-commit for v1).
The agent tier sits behind an explicit capability interface so a future CI-agent
runner can host it unchanged.

**Rationale.** No LLM-in-CI runtime exists in this repo today (verified: no
workflow carries an API key or agent runner). Making the deterministic pass the
CI baseline guarantees the must-have — findings on every PR — with zero new
infra, and the boundary avoids a rewrite when a runner later lands.

**Rejected.** Stand up a canary CI-agent runner now, or depend on harness
`review-ci` — both add the largest surface + sharpest safety edges before the
baseline has earned trust.

### D2 — Ownership: a canary skill that harness leverages

**Choice.** The guardian is a canary skill (`canary-pr-guardian`), owned in this
repo, composing the canary skills; a future harness gate host leverages it as
the CI surface via the D1 boundary.

**Rationale.** Test intelligence is canary's domain and the guardian is the
PR-scoped sibling of `canary-test-pipeline`. Canary is
downstream/in-our-control; a harness-owned skill would live upstream
(`Intense-Visions`) and block v1 on external timing. This extends the existing
"harness surfaces/leverages canary" direction rather than fighting it.

**Rejected.** Harness-owned gate skill (leverages canary) — right home only if
the gate machinery must be generic from day one; not the v1 call. Build both
halves now (split) — doubles surface, needs upstream work immediately.

### D3 — Diff-coverage: tiered leverage, fidelity-labeled

**Choice.** Primary signal = harness `analyze_diff` + `get_impact` (graph-based
"is this changed code covered", deterministic, no artifact). Enrich with a
project-emitted coverage report (line-level) when present. Fall back to a canary
naming/AST heuristic when neither exists. Every finding is labeled
`coverage-verified` / `graph-verified` / `heuristic`.

**Rationale.** Harness already ships the diff-coverage primitive, so the
agentless pass is composition, not new coverage code. Graph-based works without
requiring projects to emit coverage; the report is a precision _enrichment_, not
a prerequisite. Fidelity labels prevent a heuristic guess from reading like
execution truth.

**Rejected.** Coverage-report as the _primary_ — forces a coverage-artifact
convention on every consumer. Guardian runs the suite itself — heavy,
framework-specific, duplicates `canary-ci-ready`.

**Caveat carried forward.** `harness:test-advisor` is JS/TS-only in its file
filter; `analyze_diff`/`get_impact` need a populated harness graph. Both feed
the "when signals are unavailable, degrade loudly" behavior.

### D4 — v1 write-back posture: pre-commit auto-authors, stages, and surfaces

**Choice.** In the pre-commit surface, when new code is untested the guardian
invokes the verified `canary-write-test` to author tests, `git add`s them, then
**blocks the commit once** with a "N tests authored & staged — review and
re-commit" message. No autonomous push.

**Rationale.** `canary-write-test` is verified/high-confidence, so authoring at
commit time is safe to enable immediately. Blocking once guarantees a human sees
generated code before it lands — the fail-loud principle — while still
delivering Tier-2-style value with no CI runtime.

**Rejected.** At-desk generate + purely manual commit — safe but leaves
authoring un-wired. Autonomous CI write-back now (Tier 2) — needs the deferred
runtime and all the loop-guard/fork/concurrency machinery.

### D5 — Config home: `harness.config.json` → `canary.guardian`

**Choice.** Configuration lives in a `canary.guardian` block in
`harness.config.json`, with independent per-surface `enabled` and a
`gate: soft|hard` promotion flag.

**Rationale.** Canary already requires and reads `harness.config.json`
(`canary__migrate`), and CI already reads it — so no new config surface is
invented. Independent `enabled` satisfies the "toggle either" requirement;
`gate` is the soft→hard promotion.

**Rejected.** Dedicated `canary.config.json` — cleaner ownership, but a new file
to introduce/document. `[tool.canary]` in `pyproject.toml` — Python-only, wrong
home for vitest/playwright projects.

### D6 — Tier default: Tier 0 default, Tier 1/2 opt-in, loud degradation

**Choice.** `pr.tier` defaults to `0`. Tier 1/2 are opt-in. Opting into a tier
whose runtime is absent runs Tier 0 and emits a loud notice
(`Tier N requested but no agent runtime detected — ran Tier 0`), never a silent
under-delivery.

**Rationale.** Guarantees the agent-free baseline for everyone while letting
teams with a runtime opt up. Loud degradation is the same anti-silent-failure
principle that runs through the whole audit effort.

**Rejected.** Tier 1 available in v1 CI — impossible without the deferred
runtime (Tier 1 is read-only but still needs an agent-in-CI).

## Technical Design

### Component map

The feature is **three artifacts**, split along the agent boundary (D1):

- **Deterministic engine (agent-free)** — `agent/guardian/pr_check.py` (Tier 0
  core: parse git diff, resolve coverage, render findings + fidelity labels,
  upsert sticky PR comment / print locally), exposed as CLI
  `canary guardian pr-check`.
- **Surface adapters** — `.github/workflows/guardian.yml` (PR, stock CI) and
  `hooks/guardian_precommit.py` (pre-commit). Both invoke the engine; neither
  needs an LLM.
- **Agent orchestrator (LLM tiers, behind the boundary)** —
  `agents/skills/claude-code/canary-pr-guardian/` (SKILL.md + skill.yaml): runs
  the engine, then Tier 1 (`canary-review-test` quality audit) and Tier 2/desk
  (`canary-write-test` authoring).

**Why the CLI/skill split is load-bearing:** a `SKILL.md` is agent instructions
— it _cannot_ execute on stock Actions. So the Tier 0 pass must be a
deterministic **CLI command** the workflow shells out to. The skill is the
agent-facing orchestrator that reuses that same CLI for the deterministic parts
and adds the LLM tiers on top.

> **Naming note (integration):** `agent/guardian/` already exists for
> OpenAPI-diff blast-radius (`canary guardian analyze`). This feature adds a
> _sibling_ subcommand `canary guardian pr-check` under the same namespace (both
> "guard a change"), reusing `guardian/impact_mapper.py`'s severity vocabulary
> rather than inventing a second one.

### Deterministic Tier 0 engine (`canary guardian pr-check`)

**Inputs:** `--diff <file|->` (or auto from `git diff`), `--coverage <path>`
(optional), `--format comment|json|text`, `--post-comment` (PR number + repo
from CI env), `--emit-analysis` (harness handoff, see Integration Points).

**Coverage resolution (D3), first hit wins per changed unit:**

1. **coverage-verified** — if `--coverage` (or an auto-discovered
   `coverage.xml`/`lcov.info`/`coverage.json`) is present, map changed lines →
   covered/uncovered.
2. **graph-verified** — else query the harness graph for changed-file →
   covering-tests. **The deterministic engine reaches the graph via a CLI / file
   path — `harness impact-preview --json` or reading `.harness/graph/` directly
   — NOT the `analyze_diff`/`get_impact` MCP tools, which require an agent/MCP
   client and so cannot run on stock Actions** (those MCP tools are the
   agent-tier equivalents). A changed file with no covering-test edge →
   untested; if no graph is present, fall through to the heuristic tier.
3. **heuristic** — else naming/AST: does a `*.test.*`/`test_*.py` reference the
   changed symbol?

**Finding shape:**

```jsonc
{
  "path": "agent/core/foo.py",
  "unit": "foo.parse_row",                          // symbol or file
  "kind": "untested-new-code" | "weak-test",        // weak-test only Tier 1+
  "fidelity": "coverage-verified" | "graph-verified" | "heuristic",
  "severity": "critical|high|medium|low",           // reuse impact_mapper vocab
  "evidence": "no covering test found for lines 12-28",
  "suggestion": "add a test exercising the ValueError branch"
}
```

### Findings surface — sticky PR comment

Rendered as one **upsert-by-marker** comment (`<!-- canary-pr-guardian -->`),
the same pattern as harness `pre-merge-brief`, so re-runs replace rather than
pile up. Sections: a fidelity-labelled summary line, findings ranked by
severity, and a footer stating the tier that ran + any loud-degradation notice
(D6). In `gate: hard`, the CLI exits non-zero when unaddressed `critical/high`
`untested-new-code` findings exist; in `gate: soft`, it always exits 0.

### Agent orchestrator skill (Tiers 1/2, at-desk in v1)

`SKILL.md` runs the full loop and **composes** — it does not reimplement:

1. Delegates scope + coverage to `canary guardian pr-check --format json`.
2. **Tier 1 — quality audit:** feeds affected tests to `canary-review-test`;
   merges `weak-test` findings into the set.
3. **Tier 2 / desk authoring:** for each `untested-new-code` gap, invokes
   `canary-write-test`; in pre-commit, stages the result and blocks once (D4).

**Capability boundary (D1)** — the seam that lets a future CI runner host the
agent tiers unchanged:

```python
class AgentTier(Protocol):
    def audit_test_quality(self, affected_tests: list[Path]) -> list[Finding]: ...
    def author_tests(self, gaps: list[Finding]) -> list[GeneratedTest]: ...
```

Implementations: `InSessionAgentTier` (v1 — drives
`canary-review-test`/`canary-write-test` in the host session) and, later,
`CiAgentTier` (a runner). The Tier 0 engine never imports `AgentTier`.

### Surface adapters

- **PR (`.github/workflows/guardian.yml`):** stock Actions; installs canary,
  runs `canary guardian pr-check --post-comment` (Tier 0). Skips
  docs/config-only diffs (reuses the existing "nothing to verify" skip). Reads
  `canary.guardian.pr`.
- **Pre-commit (`hooks/guardian_precommit.py`):** wired via
  `.claude-plugin/hooks.json`; runs Tier 0 locally, and — since a runtime is
  present at the desk — optionally the authoring loop (D4). Respects the
  hook-dedup guard (`hooks/_harness_dedup.py`). Reads
  `canary.guardian.preCommit`.

### Config schema (full, D5/D6)

```jsonc
"canary": {
  "guardian": {
    "pr":        { "enabled": true,  "tier": 0, "gate": "soft" },   // tier 1/2 opt-in
    "preCommit": { "enabled": false, "authorTests": true, "gate": "soft" },
    "coveragePaths": ["coverage.xml", "coverage/lcov.info"],        // optional enrich
    "skipGlobs": ["docs/**", "**/*.md"]
  }
}
```

Loaded through the `config_validation.read_json_with_warning()` path (added in
issue #299/#307) so a malformed block warns loudly instead of silently
defaulting.

### File layout (new/changed)

| Path                                                                 | New/changed | Role                                |
| -------------------------------------------------------------------- | ----------- | ----------------------------------- |
| `agent/guardian/pr_check.py`                                         | new         | Tier 0 engine                       |
| `agent/guardian/coverage.py`                                         | new         | tiered coverage resolver + fidelity |
| `agent/guardian/cli.py`                                              | changed     | register `guardian pr-check`        |
| `agents/skills/claude-code/canary-pr-guardian/{SKILL.md,skill.yaml}` | new         | orchestrator skill                  |
| `.github/workflows/guardian.yml`                                     | new         | PR surface                          |
| `hooks/guardian_precommit.py`                                        | new         | pre-commit surface                  |
| `commands/canary-pr-guardian.md`                                     | new         | slash-command entry                 |
| `tests/unit/test_guardian_pr_check.py`, `test_guardian_coverage.py`  | new         | TDD                                 |

## Integration Points

### Entry Points

| Entry point                                | Type               | Note                                             |
| ------------------------------------------ | ------------------ | ------------------------------------------------ |
| `canary guardian pr-check`                 | new CLI subcommand | Tier 0 engine; the only surface stock CI invokes |
| `canary-pr-guardian`                       | new skill          | agent orchestrator (Tiers 1/2, at-desk)          |
| `/canary-pr-guardian`                      | new slash command  | in-session invocation                            |
| `.github/workflows/guardian.yml`           | new workflow       | PR surface (self-registering)                    |
| `hooks/guardian_precommit.py`              | new hook           | pre-commit surface                               |
| `canary.guardian` in `harness.config.json` | new config block   | per-surface `enabled`/`tier`/`gate`              |

### Registrations Required

- **CLI:** register `pr-check` on the existing `guardian` Typer sub-app
  (`agent/guardian/cli.py`) — no new top-level command group.
- **Skill discoverability:** author `skill.yaml` with real `name` +
  trigger-phrase `description`, then run `harness generate-slash-commands` so
  the generated command files and `.harness/skills-index.json` regenerate from
  that source (the issue #308 lesson: edit the tracked `skill.yaml`, never the
  generated index). The discovery regression test from #310
  (`tests/unit/test_discovery_tree_integrity.py`) will assert the new skill's
  frontmatter + command↔agent linkage.
- **Pre-commit hook:** add `guardian_precommit.py` to
  `.claude-plugin/hooks.json`, routed through the `hooks/_harness_dedup.py`
  guard (from #309) so it doesn't double-fire against a harness JS counterpart.
- **Overlay/deploy tags:** if the guardian ships as a deployable overlay skill,
  tag it `deploy_to: [all]` so a framework-`unknown` project still receives it
  (the #295/#307 degradation contract).

### Harness-check integration

The guardian's Tier 0 result is published as a structured **canary analysis**
that harness's gate surface consumes, so it shows up _inside_ the harness check
flow rather than as an orphaned parallel comment:

- **Emit:** `canary guardian pr-check --emit-analysis` writes a finding record
  to the canary analyses dir (the channel `publish-analyses`/`sync-analyses`
  already use).
- **Consume:** harness `pre-merge-brief` picks it up in its "Worth your eyes"
  section, and — under `gate: hard` — the guardian's non-zero exit registers as
  a required status check alongside `harness`/`validate`/`enforce`. One gate,
  not two (addresses the #311 "no single merge gate" finding).
- **Dependency it advances:** this is the upstream ask in **#899** (harness
  consuming canary's structured results), scoped to the guardian — so the
  guardian becomes the reverse-handoff's first real producer. Where harness-side
  ingestion isn't available yet, the guardian degrades to its own sticky comment
  and says so — no hard dependency on #899 landing first.

### Documentation Updates

- **`docs/guides/harness-canary-integration.md`** (created in #308/#311): add
  `canary-pr-guardian` to the disambiguation matrix — vs `canary-test-pipeline`
  (on-demand, whole-suite) and vs harness `review-ci`/`pre-merge-brief` (generic
  PR gates).
- **AGENTS.md:** one line in the skills overview + a pointer to the guide.
- **`README.md` + `agents/skills/README.md`:** catalog entry + a use-case row.
- **New `docs/guides/pr-guardian.md`:** config schema, the tier ladder,
  soft→hard promotion, pre-commit setup, and the fidelity labels' meaning.
- **Config-ownership map** (in the integration guide): add `canary.guardian`
  under the `harness.config.json` column.
- **Roadmap/state:** the `#312` row moves `backlog → planned` now, `→ done` on
  ship; `CANARY_STATE.md` records it.

### Architectural Decisions

Two decisions warrant standalone ADRs (referenced by name, not restated):

- **D1 — Agent capability boundary.** Warrants an ADR because it governs how the
  feature evolves across the tier ladder and defines the exact seam
  (`AgentTier`) a future CI-agent runner plugs into.
- **D2 — Canary owns, harness leverages.** Warrants an ADR because it's a
  cross-project ownership stance (not a local implementation choice) that the
  future harness gate host and any sibling guardian will cite; it records _why_
  this did not go upstream in v1.

D3–D6 remain spec-level decisions.

### Knowledge Impact

- **Concept — "diff-coverage fidelity ladder":** findings carry provenance
  (`coverage-verified`/`graph-verified`/`heuristic`); consumers must treat them
  by fidelity.
- **Pattern — "deterministic-CLI + agent-orchestrator split behind a capability
  boundary":** the reusable shape for any future guardian.
- **Concept — "capability tier ladder (0/1/2)":** graceful degradation as a
  first-class design property, with loud-degradation as the contract.
- **Relationships:** `canary-pr-guardian` **composes** `canary-review-test`,
  `canary-write-test`, `canary-ci-ready`, `canary-critical-areas`; **leverages**
  harness `analyze_diff`/`get_impact`; **is the PR-scoped sibling of**
  `canary-test-pipeline`.

## Success Criteria

Each criterion is observable and maps to at least one test.

| #     | Criterion                                                                                                                                                                                                                                                                                                               | Verified by                                             |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| SC-1  | On a PR whose diff adds untested code, the Tier 0 pass posts a fidelity-labeled findings comment on stock GitHub Actions — no agent, secret, or write token                                                                                                                                                             | workflow + integration test with a fixture diff         |
| SC-2  | A docs/config-only diff (matches `skipGlobs`) produces no findings and a "nothing to verify" skip                                                                                                                                                                                                                       | unit test on the skip predicate                         |
| SC-3  | Coverage resolution selects the highest available fidelity per unit (coverage-report › graph › heuristic) and labels each finding accordingly                                                                                                                                                                           | unit test feeding each combination of available signals |
| SC-4  | `gate: hard` exits non-zero when a `critical/high` `untested-new-code` finding remains **not addressed** — where _addressed_ = (i) a covering test added in the same diff (the finding no longer reproduces on re-run) OR (ii) an explicit `// canary:allow-untested <reason>` suppression; `gate: soft` always exits 0 | unit test on exit-code logic                            |
| SC-5  | Opting `pr.tier: 1\|2` with no runtime present runs Tier 0 and emits the degradation notice on **both** the PR findings comment (a `⚠ degraded: tier N unavailable — ran tier 0` line) and the Actions step summary — never silent                                                                                      | unit test on tier resolution                            |
| SC-6  | Pre-commit with `authorTests: true` invokes `canary-write-test`, stages the generated tests, and blocks the commit once with the review message                                                                                                                                                                         | hook test (node/CLI-gated)                              |
| SC-7  | `pr.enabled: false` skips the PR surface; `preCommit.enabled: false` skips the hook — independently                                                                                                                                                                                                                     | unit tests per surface toggle                           |
| SC-8  | A malformed `canary.guardian` block yields a loud warning (via `read_json_with_warning`), not a silent default                                                                                                                                                                                                          | unit test on config load                                |
| SC-9  | Re-running on the same PR upserts the sticky comment (marker-matched), never stacks duplicates                                                                                                                                                                                                                          | integration test on comment write                       |
| SC-10 | With `--emit-analysis`, the finding record is written to the analyses channel in a documented schema; when harness ingestion is unavailable it falls back to the sticky comment and logs the fallback (harness `pre-merge-brief` consumption is verified once #899 lands upstream)                                      | integration test on the emit + fallback path            |
| SC-11 | The deterministic engine (`agent/guardian/pr_check.py`, `coverage.py`) imports no `AgentTier` or LLM/agent module — the capability boundary (D1) holds                                                                                                                                                                  | import/architecture test                                |
| SC-12 | A `// canary:allow-untested <reason>` annotation on a flagged unit clears its finding from the `gate: hard` exit calculation while leaving it visible (labeled `suppressed`) in the comment                                                                                                                             | unit test on the suppression path                       |

**Explicit non-criteria (v1):** no assertion of autonomous CI write-back, no
assertion of an in-CI LLM audit, no requirement that a coverage report exist
(its absence must degrade to graph/heuristic, per SC-3).

## Implementation Order

High-level phases, each independently shippable and TDD-gated. Phases 1–2
deliver the guaranteed baseline; the rest layer value behind the capability
boundary.

| Phase                            | Delivers                                         | Key work                                                                                                                                                                                                        | Verifies         |
| -------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| **1. Deterministic engine**      | The agent-free Tier 0 core                       | `agent/guardian/coverage.py` (tiered resolver + fidelity labels), `agent/guardian/pr_check.py` (scope diff, render, exit codes), register `guardian pr-check` CLI                                               | SC-3, SC-4, SC-8 |
| **2. PR surface**                | Agentless findings on every PR (goal #1)         | `.github/workflows/guardian.yml`, sticky-comment upsert, `skipGlobs`, `--post-comment`; `pr.enabled`/`gate` config                                                                                              | SC-1, SC-2, SC-9 |
| — _checkpoint_ —                 | Baseline proven on a real PR, soft gate          | _human review before wiring any authoring_                                                                                                                                                                      | —                |
| **3. Pre-commit + toggles**      | Local Tier 0 + full config                       | `hooks/guardian_precommit.py` (via `_harness_dedup.py`), config schema, per-surface enable/disable, tier resolution + loud degradation                                                                          | SC-5, SC-7       |
| **4. Agent orchestrator**        | At-desk Tiers 1/2                                | `canary-pr-guardian` SKILL.md + skill.yaml, `AgentTier` boundary + `InSessionAgentTier`, compose `canary-review-test` + `canary-write-test`, pre-commit stage-and-block; slash command; regenerate skills-index | SC-6             |
| **5. Harness-check integration** | One coherent gate (#311) + #899's first producer | `--emit-analysis`, `pre-merge-brief` consumption, required-check under `gate: hard`, sticky-comment fallback                                                                                                    | SC-10            |
| **6. Docs, ADRs & rollout**      | Discoverability + safe promotion                 | ADRs for D1 & D2, `docs/guides/pr-guardian.md`, disambiguation-matrix entry, README/catalog, roadmap `#312 → done`; ship `gate: soft` default, promote to `hard` per-repo once trust is earned                  | —                |

**Sequencing rationale:** the capability boundary (Phase 4) is built _after_ the
deterministic surfaces (1–3) so the seam is shaped by real Tier-0 behavior, not
guessed. Phase 5 depends only on Phase 1's finding shape (not on the agent
tiers), so it can proceed in parallel with Phase 4. Phases 1–2 alone are a
usable soft-gate product.
