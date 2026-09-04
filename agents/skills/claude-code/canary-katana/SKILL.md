---
name: canary-katana
description:
  Quarantines deleted and newly-skipped tests instead of letting them vanish.
  Captures every removed or skipped test with provenance (who, when, which
  commit, why) into an append-only ledger, and alarms in exactly one case — the
  deletion removed the last coverage of a symbol critical-areas.json marks
  high-risk. Silent by default, degrades to recording-only when critical-area
  data is missing. Self-contained, deterministic, advisory by default.
cli: scripts/cli.mjs
requires: [node>=20]
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
| `removed` | a `def test_*` / `async def test_*` (Python) or `describe`/`it`/`test('…')` (JS/TS) that left on a `-` line **and did not come back on the `+` side**                     |
| `skipped` | a `+`-side skip/mute marker: `@pytest.mark.skip` / `skipif` / `xfail`, or `it.skip` / `test.skip` / `describe.skip`, `it.only` / `test.only`, `xit` / `xdescribe` / `fit` |

A test flipped in place from `it('x')` to `it.skip('x')` is **one** event, not
two: the skip supersedes the removal so the ledger never double-counts a
mute-in-place as both a deletion and a skip.

The general form of that rule is the emphasis above: a `(file, title)` that
reappears on the `+` side was **modified, not removed**. Without it, any rewrite
of a declaration line recorded a deletion of a test that is still in the tree —
a prettier reflow of a long signature, or a `.skip` lifted in place, was enough
(#783). The ledger is append-only, so such a row is permanent and cannot be
corrected without the hand-edit the ledger exists to prevent; and a consumer
that attributes on the newest matching row would hand every test under a phantom
removal of a `describe` the wrong ticket. A **rename** is still a removal — the
old title's coverage really is gone.

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

```text
critical-area data unavailable, recording only, not alarming
```

Degradation never manufactures a failure — even under `--strict`, a degraded run
exits `0`.

## The ledger

Append-only JSON at `.canary/quarantine.json` (override with `--ledger`). Each
row carries full provenance so a vanished test leaves a trail:

```json
{
  "schema_version": 2,
  "entries": [
    {
      "test": "test_points_service_earns",
      "file": "tests/test_points.py",
      "kind": "removed",
      "marker": "",
      "commit": "…40 hex…",
      "author": "Ada Lovelace",
      "date": "2026-07-20T10:00:00+00:00",
      "reason": "chore: drop points coverage",
      "cause": "",
      "issue": "",
      "expiry": ""
    }
  ]
}
```

Re-running on the same change adds nothing (entries de-duplicate); a corrupt
ledger is a hard error, never silently overwritten.

### Schema v2: why a row is out, not just how it left (#771)

`cause`, `issue` and `expiry` are written by the quarantine producer, not by
katana. Katana records what it can observe from a diff — a test was removed or
skipped — and leaves `cause` empty, because "someone deleted this in commit
abc123" is provenance, not a judgement about why the test is out of the suite.

`reason` and `cause` are deliberately separate. `reason` is **derived** (the
commit subject). `cause` is **asserted** — one of `flaky`, `product-defect`,
`blocked-data`, `obsolete`. Collapsing them would dress an auto-derived string
up as a claim someone stands behind.

**One row per `(test, file)` may state a cause, and a caused row wins.** A row
with a cause supersedes a causeless row for the same pair, and a causeless row
is dropped when a caused row already exists. This is the one place the ledger is
not purely append-only, and it exists because the alternative is worse: katana
recording `{kind: 'skipped', cause: ''}` and a quarantine producer recording
`{kind: 'skipped', cause: 'product-defect', issue: …}` differ in every-field
identity, so **both** would persist — and a consumer that fails on an unlinked
quarantine (`canary-ci-ready` does) would fail on the causeless row while the
linked row sat beside it. The ledger would be contradicting itself about one
test.

History survives that rule: only rows differing in cause-bearing state collapse.
Two caused rows, or two causeless rows, keep the full-field identity and both
remain.

### Where `issue` comes from, and why the trailer keeps its own name

`issue` is the bug the quarantine is waiting on. It has two sources, and both
land in the same field:

- **A `Ticket:` commit trailer**, read by katana at capture time (`Bug:` and
  `Tracked:` are accepted spellings). This is the low-friction path: the person
  switching the test off names the bug in the commit that does it.
- **A quarantine producer**, writing a caused row directly.

v1 called this field `ticket` (#781). It is folded into `issue` here rather than
kept alongside, because two fields answering "what is this waiting on" is how a
consumer ends up reading the empty one — and the consumer is specific:
`canary-ci-ready` fails a quarantine with no **linked issue**, in either Jira or
GitHub. The schema now uses the consumer's word. A v1 row's `ticket` migrates
onto `issue` on load, so no recorded link is lost.

`Ticket:` survives as the name of the **trailer**, which is a mechanism rather
than a schema: it is what you type in a commit message, and renaming it would
invalidate the trailers already written without teaching anyone anything.

Empty is a real and important state, not a gap to paper over. A test switched
off with nothing to chase is the worst thing this ledger can record, and it can
only be seen if it is recorded honestly.

A v1 file is normalized on load, so every row comes back carrying the v2 fields
(empty where unrecorded). That is what makes writing `schema_version: 2` honest
— the version claims these rows have these fields, and after load they do.
Stamping the version over un-migrated rows would make it a promise the file does
not keep.

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

# Usage and options (exits 0, and writes nothing to the ledger):
canary skills run canary-katana -- --help
```

Value flags (`--repo`, `--diff-file`, `--ledger`, `--critical-areas`) accept
both `--repo <path>` and `--repo=<path>`, matching `canary-instrument` and
`canary-fail-fast`.

An unknown flag is rejected with `unrecognized arguments: <flag>` and exit 2,
and a value flag left without a usable value is
`argument <flag>: expected one argument` (exit 2). That covers all three ways
the value can go missing: the flag is last, the next token is another flag, or
the value is empty — in either the `--repo=` spelling or, the one shells
actually produce, `--repo "$UNSET_VAR"`. Empty is rejected rather than accepted
because `--repo ''` would resolve the ledger to `path.join('', '.canary', ...)`
and write it into the process CWD instead of the target repo.

All of these are decided before any diff is read or ledger entry is appended, so
a usage request or a typo never mutates the working tree.

`--json` shape:

```json
{
  "schema_version": 2,
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
