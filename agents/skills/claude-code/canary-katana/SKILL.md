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

- **name-matched** — the removed test's name matches an area symbol and no test
  **near the area** still names it. Severity `critical` when the area's
  `risk_score` is high (≥ 0.7), otherwise `high`.
- **heuristic** — only the test's _directory_ maps to the area (no name match).
  Always severity `medium`, and flagged as lower fidelity.

### "Still covered" means covered nearby (#1242)

A remaining test keeps an area covered only when its name matches the area's
symbol **and** it sits near the area:

- **Same significant directory.** The test's path contains the area's deepest
  non-generic directory, wherever it appears. For
  `src/loyalty/points.service.ts` that is `loyalty`, so `src/loyalty/…` and the
  mirrored `tests/loyalty/…` both count.
- **Its test-dir sibling.** When every directory of the area is generic
  (`src/engine.ts`), the area's own directory counts, plus a `__tests__`,
  `test`, `tests`, `spec` or `e2e` directory inside it or beside it
  (`src/__tests__/`, `tests/`). The rest of the tree does not.
- **Or it imports the area.** A test file anywhere that imports the area's
  module counts. Relative imports (`../../src/engine`) resolve exactly. Aliased
  or package paths are matched on their last two segments
  (`@app/pricing/engine`) or one segment off an alias root (`@/engine`). A bare
  single segment (`'engine'`) is a package name, not the area, and a
  `vi.mock`/`jest.mock` of the module is not an import.

A name match anywhere else in the repo no longer counts. It used to, and an area
named for a common word (`engine.ts`, `rules.ts`, `auth.ts`) was then "covered"
by every unrelated test that said that word. Its alarm could never fire. In one
consuming repo, deleting all 234 tests of its highest-risk area produced 0
findings and exit 0 under `--strict`, because a UI test elsewhere was named
`engine signal`.

### Declared `symbols`

An area may declare the names a test title must contain, in place of its
basename:

```json
{
  "path": "src/pricing/engine.ts",
  "risk_score": 0.95,
  "symbols": ["pricingEngine", "quoteTotal"]
}
```

Symbols are compared case-insensitively on letters and digits, so
`pricingEngine` matches a test titled `pricing engine quotes a total`. Once
declared, the basename is not matched at all. The field is optional, so a file
without it reads exactly as before. `symbols` is part of the critical-areas
contract (`lib/contracts/critical-areas.v1.schema.json`, checked by
`lib/contracts/critical-areas.mjs`). An empty list, a non-string item, or a
symbol with no letters or digits fails it, and that area is reported as not
assessed (`invalid-area`) instead of being matched on a guess.

### Not assessed: the denominator

Some areas katana **cannot** alarm on, whatever the diff deletes. Each one is
reported with a reason, so "0 alarms" can be told apart from "unable to alarm":

| Reason             | Why the name-matched alarm cannot fire                                                                                                                                       | Fix                              |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `symbol-saturated` | a test near the area names its symbol without importing the area or being named for it (`validator.test.ts` saying "rules" beside `rules.ts`), so it always reads as covered | declare narrower `symbols`       |
| `no-symbol`        | no `symbols` declared and the basename has under 4 letters or digits (`db.ts`)                                                                                               | declare `symbols`                |
| `invalid-area`     | the entry fails the critical-areas contract                                                                                                                                  | fix the entry the evidence names |

Saturation is read from the tree on disk, which is the tree before the diff
minus what the diff deleted: a deleted test cannot keep anything covered.

An area is **at stake** when a deletion in this diff relates to it: its name
matches the area's symbol, or its file is near the area or shares its directory.
The human output lists every not-assessed area and marks the at-stake ones. When
the run found no alarm but an at-stake area was not assessed, it says so in an
abstention line:

```text
⚠ Abstained on 1 critical area(s) this diff put at risk — katana cannot alarm on them, so 0 alarms is not a pass.
```

**Under `--strict` that run exits `3` (abstained, ADR 0009), not `0`.** That is
the loud option, chosen on purpose. For that area, `0` would claim the critical
path is still covered when nobody could check, which is the false green #1242
was filed about. `1` is kept for a real alarm, so CI can still tell "a test is
missing" from "katana is blind here". A real alarm outranks the abstention: a
finding proves a check ran, so a run with one exits `1`. A not-assessed area
that nothing in the diff touches is listed but does not change the exit code. No
deletion could have taken its coverage, and failing every PR on it would get the
gate muted.

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
  "ledger": ".canary/quarantine.json",
  "checked": 1,
  "abstained": false,
  "areas": {
    "total": 2,
    "assessed": 1,
    "not_assessed": [
      {
        "area": "src/rules.ts",
        "reason": "symbol-saturated",
        "evidence": "…",
        "at_stake": false
      }
    ]
  }
}
```

A degraded run adds a top-level `"degraded_notice"` and an empty `findings`.
`abstained` is `true` on an empty diff, or when `findings` is empty and an
`at_stake` area is not assessed; `--strict` exits `3` exactly then. A
critical-areas file with no `areas` list is degraded, not read as zero areas.

## CI wiring (GitHub Actions)

Advisory first, then promote to blocking once the ledger is trusted — the same
path every canary gate takes.

```yaml
- name: Quarantine deleted tests (advisory)
  run:
    canary skills run canary-katana -- --critical-areas
    .canary/critical-areas.json
# Once trusted, add --strict so a last-coverage loss fails the PR (exit 1), and
# a diff touching an area katana cannot assess abstains (exit 3):
# run: canary skills run canary-katana -- --critical-areas .canary/critical-areas.json --strict
```

## Fidelity limits (regex/diff-lite, on purpose)

- **Line-scoped diff parsing.** A declaration split across lines can be missed;
  katana errs toward recording the clear cases.
- **Name/dir coverage is heuristic.** "Last coverage" is inferred from test
  names, directory layout and imports, not a real coverage run. Treat
  `heuristic` findings as prompts to look, not verdicts.
- **Imports are read, not resolved.** Path aliases and package exports are
  matched by their trailing segments, not through the consumer's
  `tsconfig`/bundler config. A test reaching the area only through a re-export
  under another name is not seen as importing it, so it must sit near the area
  to count.
- **Provenance needs git.** Fed a `--diff-file` outside a git repo, author and
  commit are recorded as `unknown` / empty rather than guessed.
