---
project: canary
created: 2026-07-19
---

# PR Guardian — operator guide

`canary-pr-guardian` is a per-change test-quality loop. On every pull request
(and, optionally, at pre-commit) it scopes the diff, decides whether the
new/changed code is tested, and posts ranked, **fidelity-labeled** findings —
then, where an agent runtime exists, authors the missing tests. It is the
PR-scoped, write-capable sibling of the on-demand `canary-test-pipeline`.

Its defining property is **graceful degradation**: the deterministic core
(diff-coverage → comment) runs on stock CI with no agent, no secret, and no
write token, so the baseline value — findings on every PR — is guaranteed.
LLM-driven audit and authoring are additive tiers that engage only where a
runtime lives. See ADR 0007 (capability boundary) and ADR 0008 (ownership) for
the design rationale.

## What it does

- **Scopes the diff** (`git diff`), filtering out non-source paths via
  `skipGlobs` (docs, lockfiles, build output, generated command artifacts).
- **Resolves coverage** at the highest available fidelity per changed unit
  (see [Fidelity labels](#fidelity-labels)).
- **Renders findings** ranked by severity onto a sticky PR comment (upsert by
  marker `<!-- canary-pr-guardian -->`, so re-runs replace rather than stack).
- **Emits a harness analysis** (`--emit-analysis`) so the result surfaces inside
  the harness gate flow rather than as an orphaned parallel comment.
- **Authors tests** at the desk (in-session / pre-commit) when a runtime exists.

## Surfaces and how to enable them

Configuration lives in a `canary.guardian` block in `harness.config.json`. Each
surface toggles independently; a malformed block warns loudly (never silently
defaults).

```jsonc
"canary": {
  "guardian": {
    "pr":        { "enabled": true,  "tier": 0, "gate": "soft" },
    "preCommit": { "enabled": false, "authorTests": true, "gate": "soft" },
    "coveragePaths": ["coverage.xml", "coverage/lcov.info"],
    "skipGlobs": ["docs/**", "**/*.md"]
  }
}
```

### PR check

Set `canary.guardian.pr.enabled: true`. The stock workflow
(`.github/workflows/guardian.yml`) installs canary and runs
`canary guardian pr-check --post-comment` (Tier 0). Docs/config-only diffs
(matching `skipGlobs`) are skipped with a "nothing to verify" notice.

### Pre-commit check

Set `canary.guardian.preCommit.enabled: true`. The hook
(`hooks/guardian_precommit.py`, wired through `hooks/_harness_dedup.py`) runs
Tier 0 locally. Opt in to authoring with `authorTests: true`: when new code is
untested the guardian invokes `canary-write-test`, `git add`s the result, and
**blocks the commit once** with a "N tests authored & staged — review and
re-commit" message. No autonomous push. `authorTests` defaults to `false` so a
runtime-less desk degrades quietly rather than blocking every commit.

## Fidelity labels

Every finding is labeled by **how it was derived** — never treat a heuristic
guess as execution truth. Highest available fidelity wins per unit:

| Label | Derived from | Meaning |
| --- | --- | --- |
| `coverage-verified` | a coverage report (`coverage.xml`/`lcov.info`/`.json`) | changed lines mapped to covered/uncovered — strongest |
| `graph-verified` | the harness graph (`.harness/graph/`, via CLI/file) | a changed file has no covering-test edge |
| `heuristic` | naming/AST | no `*.test.*`/`test_*.py` references the changed symbol — weakest |

If no coverage report exists, the guardian falls back to the graph; with no
graph, it falls back to the heuristic. Absence degrades — it never blocks.

## The tier ladder

| Tier  | Adds                     | Runtime           | Write | Status                    |
| ----- | ------------------------ | ----------------- | ----- | ------------------------- |
| **0** | diff-coverage → comment  | none              | no    | default, ships now        |
| **1** | + LLM test-quality audit | agent (read-only) | no    | opt-in (desk in v1)       |
| **2** | + author + push tests    | agent             | yes   | opt-in (desk authoring)   |

`pr.tier` defaults to `0`. Tiers 1/2 are opt-in and require a Claude-compatible
runtime. The agent tiers sit behind the `AgentTier` capability boundary
(`agent/guardian/agent_tier.py`); the Tier 0 engine never imports them. The
`CANARY_GUARDIAN_AGENT` environment marker signals when an agent runtime is
present so the guardian can engage Tiers 1/2.

**Loud degradation.** Opting into a tier whose runtime is absent runs Tier 0 and
emits a notice — `⚠ degraded: tier N unavailable — ran tier 0` — on both the PR
comment and the Actions step summary. Never a silent under-delivery.

## Suppression

To accept an untested unit deliberately, annotate it in the diff:

```text
// canary:allow-untested <reason>
```

A suppressed finding is cleared from the `gate: hard` exit calculation but
stays **visible** in the comment (labeled `suppressed`), so the decision is
auditable rather than hidden.

## Soft → hard promotion

The gate starts **soft** and earns its way to **hard** — do not flip a repo to
`hard` before the baseline has proven itself there.

- **`gate: soft` (default).** The guardian always exits `0`. Findings are
  advisory: they post to the PR and emit an analysis, but never block a merge.
  Run here until the team trusts the findings on real PRs.
- **`gate: hard`.** The CLI exits non-zero when an unaddressed `critical`/`high`
  `untested-new-code` finding remains — where *addressed* means either a
  covering test was added in the same diff (the finding no longer reproduces on
  re-run) or an explicit `// canary:allow-untested` suppression.

Promotion is **per-repo** and has one human-admin step the guardian cannot do
for you: **register the guardian's required status check in the branch
protection rules**. Until that check is required, `gate: hard` blocks the
guardian's own exit code but not the merge button. Set `gate: hard`, confirm a
few PRs behave, then add the check to branch protection.

## Related

- [Harness + Canary Integration Guide](harness-canary-integration.md) —
  disambiguation matrix (guardian vs `canary-test-pipeline` vs harness gates)
- [ADR 0007](../adr/0007-guardian-agent-capability-boundary.md) — agent
  capability boundary
- [ADR 0008](../adr/0008-guardian-canary-owned.md) — canary-owned ownership
  stance
- `docs/changes/canary-pr-guardian/proposal.md` — full spec and success criteria
