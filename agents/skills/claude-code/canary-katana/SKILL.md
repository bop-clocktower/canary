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

- **name-matched** — the removed test is **tied to the area**: its name matches
  an area symbol and it **belonged to the area** (see below), or it imported the
  area's module directly, whatever its title says. Nothing near the area still
  covers it. Severity `critical` when the area's `risk_score` is high (≥ 0.7),
  otherwise `high`.
- **heuristic** — only the test's _directory_ maps to the area (no name match).
  Always severity `medium`, and flagged as lower fidelity.

### Proximity: both ends must be near the area (#1242)

A name match is not enough on either side. It used to be: a test anywhere in the
repo whose name contained the area's basename counted as remaining coverage, so
an area named for a common word (`engine.ts`, `rules.ts`, `auth.ts`) was always
"covered" and its alarm could never fire. In one consuming repo, deleting all
234 tests of its highest-risk area produced 0 findings and exit 0 under
`--strict`.

**Near** means one of:

- **The same significant directories.** The area's non-generic directories and
  the test's end the same way: a path suffix, not any shared segment. For
  `src/loyalty/points.service.ts` that is `loyalty`, so `src/loyalty/…` and the
  mirrored `tests/loyalty/…` both count. `apps/web/services/…` is **not** near
  `packages/api/services/engine.ts` just because both have a `services` folder.
- **Its test-dir sibling.** When every directory of the area is generic
  (`src/engine.ts`), the area's own directory counts, plus a `__tests__`,
  `test`, `tests`, `spec` or `e2e` directory inside it or beside it
  (`src/__tests__/`, `tests/`). The rest of the tree does not.

**Strongly near** is narrower: the area's own directory, its own test directory,
or an exact mirror of its significant directories.

A test file is **named for the area** when its stem is the area's basename or
the basename's first part, alone or followed by `.`, `-` or `_`:
`engine.test.ts` and `engine-refunds.test.ts` for `engine.ts`, and
`test_sprocket.py` for `sprocket.service.ts`.

A test file **imports** the area when one of its imports names the area's
module. Imports are read, not resolved:

- relative imports (`../../src/engine`) resolve exactly, including Python's
  `from .engine import x`;
- aliased and package paths match on their last two segments, after dropping an
  alias root (`@/`, `~/`, `#/`) or an npm scope (`@acme/`) and any `src`/`lib`
  segment. So `@acme/core/engine` reaches `packages/core/src/engine.ts`, and
  `@app/engine` reaches `src/engine.ts`;
- a bare single segment (`'engine'`) is a package name, not the area;
- Python `import a.b.engine as eng`, `from a.b.engine import *` and
  `from a.b import engine` all count;
- an import of the area's **directory** (`../src/pricing`, a barrel index that
  re-exports `src/pricing/engine.ts`) is weaker: it makes the file near, but its
  titles must still name the symbol;
- a `vi.mock`/`jest.mock` of the module is not an import, because a test that
  mocks a module does not exercise it.

With those terms:

1. **The deleted test must have belonged to the area.** Its file is near the
   area, is named for it, or imported it. Imports of a deleted file are read
   from the diff, since the file is gone from disk. Deleting an unrelated
   `engine signal` UI test is not a coverage loss for `src/engine.ts`, even
   though the names match. A deleted test that imports the area directly is tied
   to it even when its title only describes behaviour ("creates a link whose
   page is the run report"), as integration tests usually do (#1253).
2. **A remaining test file still covers the area** when it has at least one test
   and either imports the area, or is near it and named for it, whatever its
   titles say. Failing that, it still covers the area if it is near (or imports
   the area's directory) and a title names the symbol.

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
declared, the basename is not matched at all. The field is optional.

Without `symbols`, the basename gives at most two symbols: the joined basename
and its first dotted part (`invoice.service.ts` gives `invoice.service` and
`invoice`). A role word (`service`, `controller`, `handler`, `utils`, `util`,
`index`, `module`, `component`, `spec`, `test`) is never a symbol on its own,
because it would match every sibling of the same role. A derived symbol must
have at least 4 letters or digits.

`symbols` is part of the critical-areas contract
(`lib/contracts/critical-areas.v1.schema.json`, checked by
`lib/contracts/critical-areas.mjs`). These fail it: an empty list, a non-string
item, or a symbol with under 3 letters or digits (`"a"` would match almost every
title). A failing area is reported as not assessed (`invalid-area`) instead of
being matched on a guess. `risk_score` may be a number, a numeric string
(`"0.9"`) or `null`, which is what katana always accepted. Anything else is
`invalid-area`.

### Not assessed: the denominator

Some areas katana **cannot** alarm on, whatever the diff deletes, and some it
cannot decide for this particular diff. Each one is reported with a reason, so
"0 alarms" can be told apart from "unable to tell":

| Reason             | Why the name-matched alarm cannot fire                                                                                                                                                                                                                                                                    | Fix                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `symbol-saturated` | a test near the area names its symbol but neither imports the area nor is its own test file (named for it and strongly near). For example, `validator.test.ts` saying "rules" beside `rules.ts`. So the area always reads as covered                                                                      | declare narrower `symbols`       |
| `no-symbol`        | no `symbols` declared and the basename gives no symbol of 4+ letters or digits (`db.ts`, `utils.ts`)                                                                                                                                                                                                      | declare `symbols`                |
| `invalid-area`     | the entry fails the critical-areas contract                                                                                                                                                                                                                                                               | fix the entry the evidence names |
| `unlinked`         | this diff deleted a test beside the area (near it, or sharing a significant directory such as the package) that katana cannot tie to it, and no remaining test imports it or is its own test file. Typical: integration tests in a central `test/` that drive a service over HTTP through a server module | add a test that imports the area |

Saturation is read from the tree on disk, which is the tree before the diff
minus what the diff deleted: a deleted test cannot keep anything covered.

A not-assessed area is **at stake** when a deleted test in this diff was named
for it or imported it. Proximity alone does not count: if it did, any deletion
under a root `tests/` would put every such area at stake on every diff.

`unlinked` is the exception, and is **always** at stake: it is only reported
because of this diff (#1253). katana does not follow imports transitively (test
→ server module → service), so a test that reaches the area indirectly cannot be
tied to it. When such a test is deleted and nothing left on disk can be tied to
the area either, the coverage may have gone with it, or may never have been
there. katana cannot tell which, so it abstains instead of reading the silence
as clean. An area with a remaining test that imports it stays assessed and
quiet. A deletion in another package (no shared significant directory, not near)
leaves the area alone. A deletion under a root `tests/` with no shared
significant directory does not count either, for the reason above. The human
output lists every not-assessed area and marks the at-stake ones. When the run
found no alarm but an at-stake area was not assessed, it says so in an
abstention line:

```text
⚠ Abstained on 1 critical area(s) this diff put at risk — katana cannot tell whether they lost coverage, so 0 alarms is not a pass.
```

**Under `--strict` that run exits `3` (abstained, ADR 0009), not `0`.** That is
the loud option, chosen on purpose. For that area, `0` would claim the critical
path is still covered when nobody could check, which is the false green #1242
was filed about. `1` is kept for a real alarm, so CI can still tell "a test is
missing" from "katana is blind here". A real alarm outranks the abstention: a
finding proves a check ran, so a run with one exits `1`. A not-assessed area
that nothing in the diff touches is listed but does not change the exit code. An
`unlinked` area is never in that position: it is listed only when the diff
touched it. No deletion could have taken its coverage, and failing every PR on
it would get the gate muted.

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
`abstained` is `true` in three cases, and `--strict` exits `3` exactly then:

- the diff was empty;
- deletions were captured but the critical-areas file lists **0 areas** (a zero
  denominator, not a pass);
- `findings` is empty and an `at_stake` area is not assessed.

A critical-areas file with no `areas` list at all is degraded (recording only,
exit 0), like a missing file.

## CI wiring (GitHub Actions)

Advisory first, then promote to blocking once the ledger is trusted — the same
path every canary gate takes.

```yaml
- name: Quarantine deleted tests (advisory)
  run:
    canary skills run canary-katana -- --critical-areas
    .canary/critical-areas.json
```

Once the ledger is trusted, add `--strict` and branch on the exit code. Exit 3
is an abstention (ADR 0009), not a pass, and not a failure either. Report it;
don't let it read as green:

```yaml
- name: Quarantine deleted tests (blocking)
  run: |
    set +e
    canary skills run canary-katana -- \
      --critical-areas .canary/critical-areas.json --strict
    rc=$?
    set -e
    case "$rc" in
      0) echo "katana: no critical area lost its last coverage." ;;
      1) echo "::error title=Last coverage removed::see the step log"; exit 1 ;;
      3) echo "::warning title=Katana abstained::empty diff, an empty areas list, or a touched area katana cannot assess (see areas.not_assessed)" ;;
      *) echo "::error title=Katana failed::unexpected exit $rc"; exit "$rc" ;;
    esac
```

## Fidelity limits (regex/diff-lite, on purpose)

- **Line-scoped diff parsing.** A declaration split across lines can be missed;
  katana errs toward recording the clear cases.
- **Name/dir coverage is heuristic.** "Last coverage" is inferred from test
  names, directory layout and imports, not a real coverage run. Treat
  `heuristic` findings as prompts to look, not verdicts.
- **Imports are read, not resolved.** Path aliases and package exports are
  matched by their trailing segments, not through the consumer's
  `tsconfig`/bundler config. Reading `tsconfig` `paths` would mean interpreting
  `extends` chains and wildcards per package, which is more than a
  zero-dependency skill should guess at. A barrel import of the area's directory
  counts only when a title also names the symbol, since a barrel re-exports many
  modules. A re-export under another name or from another directory is not seen
  at all, so such a test must sit near the area to count.
- **Provenance needs git.** Fed a `--diff-file` outside a git repo, author and
  commit are recorded as `unknown` / empty rather than guessed.
