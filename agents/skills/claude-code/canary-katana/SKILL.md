---
name: canary-katana
description:
  Quarantines deleted and newly-skipped tests instead of letting them vanish.
  Captures every removed or skipped test with provenance (who, when, which
  commit, why) into an append-only ledger, and alarms in exactly one case — the
  deletion removed the last coverage of a symbol critical-areas.json marks
  high-risk. Silent by default, degrades to recording-only when critical-area
  data is missing. `--check` fails when a static skip in the source has no
  ledger row. Self-contained, deterministic, advisory by default.
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
`critical-areas.json` (produced by `canary critical-areas`). With no
`--critical-areas` flag, katana reads the map that command writes,
`<repo>/.canary/critical-areas.json`, when it exists, and names the file on
stderr (`canary-katana: using …`). An explicit flag always wins.

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

| Reason             | Why the name-matched alarm cannot fire                                                                                                                                                                                                                                                                                                                                                 | Fix                              |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `symbol-saturated` | a test near the area names its symbol but neither imports the area nor is its own test file (named for it and strongly near). For example, `validator.test.ts` saying "rules" beside `rules.ts`. So the area always reads as covered                                                                                                                                                   | declare narrower `symbols`       |
| `no-symbol`        | no `symbols` declared and the basename gives no symbol of 4+ letters or digits (`db.ts`, `utils.ts`)                                                                                                                                                                                                                                                                                   | declare `symbols`                |
| `invalid-area`     | the entry fails the critical-areas contract                                                                                                                                                                                                                                                                                                                                            | fix the entry the evidence names |
| `unlinked`         | this diff deleted a test related to the area (near it, sharing a significant directory such as the package, or — for an area with `risk_score` ≥ 0.7 — under the root `test/`/`tests/`) that katana cannot tie to it, and no remaining test imports it or is its own test file. Typical: integration tests in a central `test/` that drive a service over HTTP through a server module | add a test that imports the area |

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
leaves the area alone. A deletion under the root `test/` or `tests/` with no
shared significant directory counts only for a **high-risk** area (`risk_score`
≥ 0.7, the same line that makes an alarm `critical`) (#1255). In a
single-package repo, `src/services/widgetService.ts` and
`test/widget-links.integration.test.ts` share no significant directory, so
without this rule deleting every integration test would exit `0`. Lower-risk
areas keep the rule above: such a deletion leaves them alone, so the noise stays
limited to the areas that matter. A nested `tools/test/` is not the root test
directory. The human output lists every not-assessed area and marks the at-stake
ones. When the run found no alarm but an at-stake area was not assessed, it says
so in an abstention line:

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
critical-area data unavailable, recording only, not alarming; run `canary critical-areas` (katana reads .canary/critical-areas.json), or pass --critical-areas PATH
```

Degradation never manufactures a failure — even under `--strict`, a degraded run
exits `0`.

### A stale map abstains

The map is a snapshot. An area added or reshaped after it was written can never
alarm, so "0 alarms" against an old map is a claim nobody checked (#1325).
katana reads the map's `generated` stamp (which `canary critical-areas` always
writes) and states its age next to the area denominator on the summary line:

```text
0 deletion(s) captured; checked against 12 critical area(s) from a map 85 day(s) old (limit 30).
⚠ critical-areas map is stale: generated 2026-09-01T00:00:00.000Z, 85 day(s) ago, past the 30-day limit (--max-age-days). Areas added or reshaped since cannot alarm; regenerate it with `canary critical-areas`.
⚠ Abstained — katana scored this diff against a map it cannot vouch is current, so 0 alarms is not a pass.
```

A map older than `--max-age-days` (default `30`, whole days; exactly the limit
is still fresh) is **stale**. `generated` must be strict ISO-8601: a calendar
date (`2026-09-01`, read as UTC) or a date-time with an explicit offset
(`2026-09-01T00:00:00Z`, `…+02:00`), which is what `canary critical-areas`
writes. Looser forms a JavaScript engine might still parse (`Nov 1 2026`,
`2026/11/01`, a date-time without an offset) are not accepted, so every reader
agrees on what the map says. The warning prints the parsed instant, never the
raw field. A map whose `generated` is missing, not strict ISO-8601, or more than
a day in the future cannot be checked at all, and says
`⚠ Cannot verify critical-areas map freshness: …` with `map of unknown age` on
the summary line. Either way the run still assesses every area and still alarms;
under `--strict` a run with no finding exits `3` (abstained), not `0`. A real
alarm outranks the abstention and exits `1`. A degraded run (no map) has no age
to check and is unchanged.

The age check is a staleness heuristic, not a trust boundary. Anyone who can
edit the map can also edit the gate, so katana does not cross-check `generated`
against the file's git history.

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
`blocked-data`, `pending-feature`, `obsolete`, `env-gated`. Collapsing them
would dress an auto-derived string up as a claim someone stands behind.

Three causes **require an `issue`**: `product-defect`, `blocked-data` and
`pending-feature`. In each, the test is correct and someone else owns the fix,
so a row with no link decays into an unexplained skip. Katana does not enforce
this at write time; consumers do (manhunter flags
`out as <cause> with no linked issue`, and `canary-ci-ready` fails an unlinked
quarantine). Use `pending-feature` when a correct test covers behaviour that has
not shipped, or has shipped behind a flag that is off; link the feature's
ticket. It is not `blocked-data`: the owner and the trigger differ (the feature
team ships the feature, not someone supplying environment data), and filing one
as the other sends whoever looks for data work to feature work. The release rule
is the same for every cause: **remove the row when the test passes live**, not
when the ticket closes. A closed ticket with a still-failing test is exactly
what the ledger exists to keep visible (#1330).

Use `env-gated` for a test that **skips itself on purpose in this run** because
something it needs is absent (a native library, an opt-in flag such as
`RUN_NIGHTLY=1`), and that runs for real somewhere else (a nightly job, a
dedicated runner). Nothing is broken and nobody owns a fix, so it needs no
`issue`; a producer may put where the test really runs there instead (a workflow
path). Without this cause such a skip either stays unledgered, and a dashboard
escalates the unchanging skip as "coverage switched off", or it is filed under a
cause whose release trigger never comes. It is not `obsolete`: the test still
matters and still runs. If it stops running anywhere, the row is wrong. Remove
it and ledger the test under the cause that is now true.

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

Normalizing on load only **adds** the v2 fields; it never takes anything away. A
field outside the schema that you recorded on a row (a `scope` naming the one
config the row applies to, say) passes through unchanged, in the row's own key
order, and the file is rewritten with the indentation it already had (2 spaces
only for a new or single-line file). An append to a v2 file that supersedes no
row is therefore a diff of the appended rows alone (#1569).

## Check mode: every static skip has a row (#1319)

Katana records a skip only when it runs on the diff that adds it. Nothing used
to check the ledger against the source, so a test could be switched off with
`test.skip` and no row, and CI stayed green. In one consuming repo, 37 tests
were parked that way before it wrote its own gate.

`--check` walks the test files (`scripts/skipscan.mjs`), finds every **static**
skip, and matches each one to a ledger row:

```bash
canary skills run canary-katana -- --check            # whole repo
canary skills run canary-katana -- --check tests/e2e  # narrowed to PATHs
canary skills run canary-katana -- --check --json
```

| Exit | Meaning                                                                                                                 |
| ---- | ----------------------------------------------------------------------------------------------------------------------- |
| `0`  | every static skip has a ledger row, and nothing is focused                                                              |
| `1`  | a static skip has no row (listed as `file:line`, title, marker, and the fix), or a focus marker is committed            |
| `3`  | abstained: zero test files read, a PATH that selected no test file, or a ledger that is not valid JSON or not an object |

**What counts as static.** The patterns are the ones diffscan uses when it
records a skip, so the check and the recorder agree on what a skip is:
`it.skip`, `test.skip('title', …)`, `describe.skip`, `test.describe.skip`,
`test.fixme('title', …)`, `xit`, `xdescribe`, and, on a `def` or `class`, pytest
`@pytest.mark.skip`, `@pytest.mark.xfail` with no condition, and
`@pytest.mark.skipif(True, …)`. A "condition" that is a literal is no condition,
so these are static too: `skipIf(true)`, `skipIf(1)`, `runIf(false)`,
`test.skip(true, why)`, `test.fixme(!0)`, `test.skip(() => true)`. So is an
argument-less `test.skip()` / `test.fixme()`, Playwright's mute for a whole test
or file. A skip with no title of its own is matched by the title of the nearest
declaration before it (the test it sits in), or `(file)` when there is none.

**Focus markers fail on their own.** `.only`, `fit` and `fdescribe` (and
`test.describe.only`) are reported in a separate `focused` bucket and exit `1`.
A committed focus mutes every _other_ test in its file or block, so it is a
switched-off-tests event that no ledger row can excuse: remove it.

**Nothing skip-shaped is invisible.** Every match lands in one bucket: static
(matched against the ledger), `exempt`, or `focused`, and each count is printed.

**What is exempt.** A skip that depends on the run is an environment gate, not a
quarantine: `it.skipIf(cond)`, `describe.runIf(cond)`, Playwright's
`test.skip(cond, why)` inside a test, pytest `skipif(cond)` and `xfail(cond)`. A
non-literal first argument is a condition. They are counted as `exempt` and do
not fail the check. Ledger one under `env-gated` if a dashboard should know
where it really runs. A marker inside a comment, string or template literal is
not a skip. Suites keep fixture source that only looks like one. Python
triple-quoted bodies are skipped too.

**Identity.** A skip matches a row with the same `file` (repo-relative) and
`test`: the title in the skip call, or the decorated function's name. That is
the identity katana writes when it records. Line numbers are reported, not
matched, so a row still matches after code above it moves. A `removed` row does
not count, because it records a deletion and the test is still in the file.

**The fix.** Every unledgered skip prints the command that records it:

```text
✗ tests/cart.test.ts:8  "parks the cart"  (it.skip) has no ledger row
  fix: canary skills run canary-katana -- --check --record tests/cart.test.ts
```

`--record` appends one causeless `skipped` row per unledgered skip, as a
diff-mode capture would have. Provenance comes from `git blame` of the marker
line: the commit that added the skip, its author, date and subject, and its
`Ticket:` trailer as `issue`. Outside git, or for an uncommitted line, the
author is `unknown`. `cause` stays empty, because why a test is out is the
quarantine producer's call. `--record` never writes over a ledger it cannot
read. It is refused with `--no-write`. `--diff-file` and `--critical-areas` are
refused with `--check`, because the check reads the tree and not a diff.

**PATHs never narrow a run to green.** Each PATH must select at least one
readable test file. If any one selects none (a typo, a moved directory), the run
abstains with exit `3` and names it, even when the other PATHs matched.

**A finding outranks an abstention** (ADR 0009), as in the rest of the family. A
run that found a focused marker, or an unledgered skip against a ledger it could
read, exits `1` even when a PATH matched nothing or the ledger could not be
read, and it still prints each abstention line. With an unreadable ledger,
static skips cannot be matched, so they alone abstain (`3`), but a focused
marker still exits `1`. A bare `--` ends the options, in check mode and in diff
mode alike.

`--json` shape:

```json
{
  "checked": 14,
  "skips": 2,
  "ledgered": 1,
  "exempt": 3,
  "unledgered": [
    {
      "file": "tests/cart.test.ts",
      "line": 8,
      "test": "parks the cart",
      "marker": "it.skip",
      "fix": "canary skills run canary-katana -- --check --record tests/cart.test.ts"
    }
  ],
  "focused": [],
  "unmatched": [],
  "recorded": 0,
  "abstained": false,
  "ledger": ".canary/quarantine.json"
}
```

`focused` entries have the same shape as `unledgered` ones, without `fix`.
`unmatched` lists the PATHs that selected no test file. An abstained run adds
`"error"` when the ledger could not be read. Limits: a module-level `pytestmark`
and titles built at run time are not seen, and the title must be a string
literal on a single line. The enclosing test of an untitled skip is the nearest
declaration before it, which is a heuristic and not a parse.

## Invocation

```bash
# Diff the current branch against its merge-base, record, advise (exit 0):
canary skills run canary-katana

# Feed an explicit diff and a critical-areas map kept off the default path:
canary skills run canary-katana -- \
  --diff-file changes.diff --critical-areas maps/critical-areas.json

# Machine-readable:
canary skills run canary-katana -- --json

# Fail the step only when a critical path loses its last coverage:
canary skills run canary-katana -- --strict

# Accept a critical-areas map up to 90 days old (default 30):
canary skills run canary-katana -- \
  --critical-areas .canary/critical-areas.json --max-age-days 90

# Usage and options (exits 0, and writes nothing to the ledger):
canary skills run canary-katana -- --help
```

Value flags (`--repo`, `--diff-file`, `--ledger`, `--critical-areas`,
`--max-age-days`) accept both `--repo <path>` and `--repo=<path>`, matching
`canary-instrument` and `canary-fail-fast`. `--max-age-days` takes a whole
number of at least `1`; anything else is a usage error (exit 2).

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
  },
  "map": {
    "generated": "2026-11-20T00:00:00Z",
    "age_days": 5,
    "max_age_days": 30,
    "freshness": "fresh"
  }
}
```

A degraded run adds a top-level `"degraded_notice"` and an empty `findings`, and
has no `map`. `map.freshness` is `fresh`, `stale` or `unknown`; when `unknown`,
`age_days` is `null` (and `generated` is `null` when the field is missing).
`abstained` is `true` in four cases, and `--strict` exits `3` exactly then:

- the diff was empty;
- deletions were captured but the critical-areas file lists **0 areas** (a zero
  denominator, not a pass);
- `findings` is empty and an `at_stake` area is not assessed;
- `findings` is empty and `map.freshness` is `stale` or `unknown` (#1325).

A critical-areas file with no `areas` list at all is degraded (recording only,
exit 0), like a missing file.

## CI wiring (GitHub Actions)

Advisory first, then promote to blocking once the ledger is trusted — the same
path every canary gate takes.

```yaml
- name: Quarantine deleted tests (advisory)
  # Reads .canary/critical-areas.json when `canary critical-areas` wrote it.
  run: canary skills run canary-katana
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
      3) echo "::warning title=Katana abstained::empty diff, an empty areas list, a touched area katana cannot assess (see areas.not_assessed), or a stale or undated critical-areas map (see map)" ;;
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
- **Root test directories are related by risk, not by reading.** katana does not
  follow a test's imports through a server module, so an integration test under
  the root `test/`/`tests/` can't be tied to the `src/` area it exercises. For
  an area with `risk_score` ≥ 0.7, deleting such a test abstains (`unlinked`, at
  stake, `--strict` exit `3`) until a remaining test imports the area. Below
  0.7, the same deletion is not seen at all, so a lower-risk area covered only
  by root integration tests can lose that coverage silently.
- **Provenance needs git.** Fed a `--diff-file` outside a git repo, author and
  commit are recorded as `unknown` / empty rather than guessed.
