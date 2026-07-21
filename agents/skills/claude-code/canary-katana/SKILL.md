---
name: canary-katana
description:
  Quarantines deleted and newly-skipped tests instead of letting them vanish.
  Captures every removed or skipped test with provenance (who, when, which
  commit, why) into an append-only ledger, and alarms in exactly one case — the
  deletion removed the last coverage of a symbol critical-areas.json marks
  high-risk. Silent by default, degrades to recording-only when critical-area
  data is missing. Self-contained, deterministic, advisory by default.
cli: scripts/cli.py
requires: [python3>=3.10]
---

# Canary Katana

Named for Tatsu Yamashiro's Soultaker — the blade that captures the soul of
whatever it cuts. A deleted test is coverage that leaves without a trace: the
suite still goes green, the gap is invisible, and nobody notices until the bug
it caught ships. Katana catches every test as it is removed or muted, records
who took it and why, and raises its voice only when the cut was the last thing
guarding a critical path.

Tier-0 deterministic analysis: no LLM, no network, no secrets, no dependency on
any other skill at runtime.

## What it captures

| Event     | Detected from a diff                                                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `removed` | a `def test_*` / `async def test_*` (Python) or `describe`/`it`/`test('…')` (JS/TS) that left on a `-` line                                                               |
| `skipped` | a `+`-side skip/mute marker: `@pytest.mark.skip` / `skipif` / `xfail`, or `it.skip` / `test.skip` / `describe.skip`, `it.only` / `test.only`, `xit` / `xdescribe` / `fit` |

A test flipped in place from `it('x')` to `it.skip('x')` is **one** event, not
two: the skip supersedes the removal so the ledger never double-counts a
mute-in-place as both a deletion and a skip.

## The one thing it alarms on

Most test deletions are legitimate — dead feature removal, genuine dedup — so
alarming on every one is nag fatigue within a week, and a gate people mute is
worse than no gate. Katana is **silent by default** and alarms only when a
removed test was the **last coverage** of a symbol listed in
`critical-areas.json` (produced by `canary-critical-areas`).

- **name-matched** — the removed test's name matches an area symbol and no other
  test still covers it. Severity `critical` when the area's `risk_score` is high
  (≥ 0.7), otherwise `high`.
- **heuristic** — only the test's _directory_ maps to the area (no name match).
  Always severity `medium`, and flagged as lower fidelity.

### Degradation is loud and safe

When `critical-areas.json` is missing or malformed, katana records everything
but alarms on nothing, printing:

```
critical-area data unavailable, recording only, not alarming
```

Degradation never manufactures a failure — even under `--strict`, a degraded run
exits `0`.

## The ledger

Append-only JSON at `.canary/quarantine.json` (override with `--ledger`). Each
row carries full provenance so a vanished test leaves a trail:

```json
{
  "schema_version": 1,
  "entries": [
    {
      "test": "test_points_service_earns",
      "file": "tests/test_points.py",
      "kind": "removed",
      "marker": "",
      "commit": "…40 hex…",
      "author": "Ada Lovelace",
      "date": "2026-07-20T10:00:00+00:00",
      "reason": "chore: drop points coverage"
    }
  ]
}
```

Re-running on the same change adds nothing (entries de-duplicate); a corrupt
ledger is a hard error, never silently overwritten.

## Invocation

```bash
# Diff the current branch against its merge-base, record, advise (exit 0):
canary skills run canary-katana

# Feed an explicit diff and a critical-areas map:
canary skills run canary-katana -- \
  --diff-file changes.diff --critical-areas .canary/critical-areas.json

# Machine-readable:
canary skills run canary-katana -- --json

# Fail the step only when a critical path loses its last coverage:
canary skills run canary-katana -- --strict
```

`--json` shape:

```json
{
  "schema_version": 1,
  "captured": [
    { "name": "…", "file": "…", "kind": "removed", "line": 3, "marker": "" }
  ],
  "findings": [
    {
      "kind": "last-coverage-removed",
      "test": "…",
      "file": "…",
      "area": "src/loyalty/points.service.ts",
      "fidelity": "name-matched",
      "severity": "critical",
      "evidence": "…"
    }
  ],
  "ledger": ".canary/quarantine.json"
}
```

A degraded run adds a top-level `"degraded_notice"` and an empty `findings`.

## CI wiring (GitHub Actions)

Advisory first, then promote to blocking once the ledger is trusted — the same
path every canary gate takes.

```yaml
- name: Quarantine deleted tests (advisory)
  run:
    canary skills run canary-katana -- --critical-areas
    .canary/critical-areas.json
# Once trusted, add --strict so a last-coverage loss fails the PR:
# run: canary skills run canary-katana -- --critical-areas .canary/critical-areas.json --strict
```

## Fidelity limits (regex/diff-lite, on purpose)

- **Line-scoped diff parsing.** A declaration split across lines can be missed;
  katana errs toward recording the clear cases.
- **Name/dir coverage is heuristic.** "Last coverage" is inferred from test
  names and directory layout, not a real coverage run — treat `heuristic`
  findings as prompts to look, not verdicts.
- **Provenance needs git.** Fed a `--diff-file` outside a git repo, author and
  commit are recorded as `unknown` / empty rather than guessed.
