---
name: canary-unquarantine
description:
  The release half of quarantine. Reads the canary-katana ledger
  (.canary/quarantine.json, schema v1 or v2) and every marker a quarantine can
  take in code (test.skip / describe.skip / fixme, runtime skips, pytest
  skip/xfail, tags like @known-failure), finds the ticket each one waits on —
  following hand-offs, so a closed issue that was "Filed as UP-123" waits on
  UP-123, not on nothing — and classifies every row as candidate, blocked,
  stale, unlinked or abstained, with a printed denominator. Use when the user
  asks "can any of these quarantined tests come back", "what is still skipped
  and why", "audit the quarantine ledger", or "trial-release the candidates".
  `audit` is read-only; `trial` opens one draft PR lifting the candidates'
  markers only after an explicit --yes, and `verdict` reads that PR's CI per
  test to release passes and re-quarantine failures. `quarantine` writes a
  marker and its ledger row together, and `migrate` turns tag-style
  (@known-failure) quarantine into ledger rows without losing a ticket link.
  Never releases a test on ticket state alone. NOT a test runner and NOT a flake
  diagnosis (that is canary-flake-hunter).
cli: scripts/cli.mjs
requires: [node>=20, gh]
---

# Canary Unquarantine

`canary-katana` puts tests into quarantine; nothing took them out. Its own rule
— "remove the row when the test passes live" — had no step that acted on it. And
a skipped test never runs, so it can never pass live: a quarantine with no
release step is permanent by construction.

This skill is that step. `audit` answers one question per ledger row: **is the
thing this test waits on resolved?** `trial` and `verdict` then let the suite's
own CI decide whether each candidate really comes back.

It is deliberately not "is the ticket closed?". The common way a quarantine's
tracking issue closes is that the finding was filed with the team that owns the
fix — "Filed as UP-123, stays quarantined until it goes green" — and the issue
is closed because the work moved. **Closed-to-upstream is not fixed.** The audit
follows that hand-off and asks the upstream ticket instead.

## Capability

Deterministic for a given tracker state; needs the **network** (it reads issues
through `gh`, and Jira when configured); invokes no agent or model. A tracker it
cannot read is never treated as an answer: those rows **abstain**, by name, with
the reason.

## The classes

| Class       | Meaning                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------ |
| `candidate` | Every blocker the row waits on is resolved. Ready for a trial release — not a release.     |
| `blocked`   | At least one blocker is open. Its owner (assignee) is named.                               |
| `stale`     | A ledger row whose marker is not in the code: the test is unskipped, renamed or gone.      |
| `unlinked`  | A row that names no ticket anywhere — no `issue`, no reference in comment/reason/title.    |
| `abstain`   | A blocker's tracker could not be read. **Never reported as clear.**                        |
| `removed`   | A katana `removed` row for a test that really is gone: a deletion record, nothing to lift. |

A katana `removed` row whose test is still in the file is `stale` (a phantom
removal, #783), not `removed`.

Duplicate rows (same file, test, kind and marker) are each classified and the
later ones are marked `duplicateOf`.

Markers in the code with **no** ledger row are listed separately as
**unledgered**, with any ticket their comment names — a marker with no row is
reported, never silently ignored.

## Finding the blocker

For each row, the first source that names a ticket wins:

1. the ledger's v2 `issue` field (a producer asserted it);
2. the comment block directly above the marker, plus the marker statement itself
   (`test.skip(cond, 'blocked by #12')`, `@pytest.mark.skip(reason=…)`);
3. the ledger `reason` (the commit subject katana recorded);
4. the test title.

Within one source, a reference after a blocker phrase — "quarantined against",
"parked against", "blocked by", "filed as", "tracked in" — is _the_ blocker, and
it is the only one taken. A comment that says "quarantined against #225; the
twin finding is quarantined against #200" waits on #225. With no such phrase,
every reference in the source counts.

References: `#N` (in the suite's own repository), `owner/repo#N`, GitHub issue
or pull URLs, Jira `/browse/KEY-N` URLs, and bare Jira keys. A bare key is
believed only after a blocker phrase or when its project is in `jira_projects`,
and a key that appears in the test's own title (`TC-065 …`) is a case id, never
a ticket.

### Hand-offs

When a blocker is a **closed** GitHub issue, its comments are read (newest
first) for a hand-off: a line that says the work was filed, raised, moved,
parked, superseded or continued somewhere, and names where. Only the newest
comment carrying a hand-off is used — a later comment re-routes an earlier one.
When that comment routes several cases to several tickets, the lines naming the
row's own case id are the ones that count; otherwise every target counts, which
errs toward blocked. Chains are followed up to 4 hops, and a cycle abstains.

A closed issue whose comments cannot be read abstains: a hand-off cannot be
ruled out, and ruling it out is the whole point.

### Combining blockers

One open blocker decides the row is `blocked`. Otherwise any unreadable blocker
makes it `abstain`. Only when every blocker is resolved is it a `candidate`.

## Trackers are adapters

- **GitHub** is built in, through `gh api`. A bare `#N` is in `--github-repo`,
  else the repository `gh repo view` reports for `--repo`.
- **Jira** is enabled per project by `.canary/company.json` `jira_projects`
  (company-specific configuration, not a separate skill). Credentials come from
  the environment — `CANARY_JIRA_EMAIL` and `CANARY_JIRA_API_TOKEN` (or the
  `JIRA_*` spellings) — and the site from the ticket's own URL or
  `CANARY_JIRA_BASE_URL`. They are passed to `curl` on stdin, never in argv. A
  Jira project not in `jira_projects`, or no credentials, abstains for that row.
  A status in Jira's `done` category is resolved; `new` and `indeterminate` are
  open.

Tag-style quarantine reads its tags from `--tags`, else company.json
`quarantine_tags`, else `@known-failure,@quarantine`.

## Invocation

```bash
# Audit the ledger in the current repo (advisory, exit 0):
canary skills run canary-unquarantine

# Another suite, machine-readable:
canary skills run canary-unquarantine -- --repo ../suite --json

# Usage and options:
canary skills run canary-unquarantine -- --help
```

`--strict` exits `1` when something needs action (a candidate, a stale or
unlinked row, an unledgered marker) and `3` when the audit abstained — zero rows
read, or any row whose blocker could not be read (ADR 0009). A finding outranks
an abstention, as in the rest of the family, but the abstention is still
printed.

### The denominator

Every run prints, before anything else:

```text
Denominator: 36 ledger row(s) read · 19 resolved by a tracker · 14 abstained · 3 answered from the code alone (stale/unlinked/removed)
```

"Nothing to release" is only ever printed when rows were read, none abstained,
and every one is blocked on an open ticket. Zero rows read prints
`⚠ Abstained — verified zero items; this is not a pass.`

`--json` carries `checked` (rows read), `abstained`, `verdict`, `denominator`,
`counts`, `rows` (each with `class`, `why`, `blockers` and the `via` chain) and
`unledgered`.

## Trial release: `trial`, then `verdict`

A candidate is released only by the suite's own CI, never by ticket state.

### `trial`

```bash
# Show what would be lifted (writes nothing):
canary skills run canary-unquarantine -- trial

# The one confirm -- opens ONE draft PR lifting every candidate's marker:
canary skills run canary-unquarantine -- trial --yes
```

Without `--yes` the trial prints its plan and writes nothing. An agent running
this skill shows the user that plan and asks before passing `--yes`. That is the
single confirm.

With `--yes`:

1. A throwaway `git worktree` is created at `HEAD` on a new branch (`--branch`,
   default `canary/unquarantine-trial-<date>-<sha>`). The user's checkout is
   never switched, stashed or dirtied.
2. Each selected marker is lifted by a checked text edit:
   - `test.skip(`, `test.describe.skip(`, `it.skip(` and `test.fixme(` become
     the same call without `.skip` or `.fixme`;
   - `xit(`, `xtest(` and `xdescribe(` become `it(`, `test(` and `describe(`;
   - pytest `skip`, `skipif` and `xfail` decorators are removed;
   - a quarantine tag is removed from the title;
   - an `eslint-disable-next-line` directive that only permitted the skip goes
     with the skip.

   If the line no longer looks like the marker the audit saw, that test is not
   lifted. A runtime guard is never lifted either: it skips on a condition and
   lifts itself when the condition clears. Duplicate ledger rows lift one marker
   once.

3. The branch is pushed and `gh pr create --draft` opens the PR (`--pr-base` to
   choose its base). The trial's plan travels in the PR body as an HTML comment,
   so `verdict` needs only the PR number.

Candidates are always selected. `--include-abstained` also selects rows whose
tracker could not be read. Use it when the upstream tracker is out of reach but
the suite's CI is not: the trial run is the arbiter either way.

### `verdict`

```bash
# Read the trial PR's CI per test (writes nothing):
canary skills run canary-unquarantine -- verdict --pr 77 --artifact playwright-report-json

# Apply it: rewrite the trial PR and tell failing tickets:
canary skills run canary-unquarantine -- verdict --pr 77 --artifact playwright-report-json --apply
```

Results come from the newest **completed** CI run on the trial commit, through
`--artifact` (downloaded with `gh run download`). `--results PATH` takes a local
file or directory instead. Both read a Playwright JSON report or JUnit XML. A
lifted describe is judged on every case under it.

| Outcome in the run      | `--apply` does                                                                                                                                                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pass (every case)       | the marker stays lifted; every ledger row for it is dropped                                                                                                                                                                              |
| fail                    | the marker is restored; the rows' `issue` is re-pointed at the blocker the audit read as resolved, and that ticket gets a comment saying the test still fails (GitHub through `gh`, Jira when configured, otherwise listed for a person) |
| flaky (passed on retry) | the marker is restored and the test is listed for `canary-flake-hunter`. Dispatch that agent for each one; a retry pass is not a fix                                                                                                     |
| missing / still skipped | the marker is restored and nothing else changes. A test the run never reached proved nothing                                                                                                                                             |

Every touched file is rebuilt from the trial's base commit plus only the lifts
that passed. A restored marker comes back byte for byte, however many lifts
share its file. The rewrite is one commit pushed to the trial branch. A person
reviews and merges it.

`verdict` abstains (`--strict` exit `3`) when there is no per-test result. That
covers four cases: no `--results` or `--artifact`, CI not finished, no such
artifact, or a document with no test cases. It never falls back to the run's
overall conclusion. `--strict` exits `1` when a lifted test failed or was flaky.

## The producer side: `quarantine` and `migrate`

A marker with no ledger row is a skip nobody can chase. A row with no marker is
stale: it claims a quarantine the code no longer has. So nothing here writes one
without the other.

### `quarantine`: switch one test off

```bash
canary skills run canary-unquarantine -- quarantine \
  --file tests/api/points.spec.ts --test 'a sale earns points' \
  --cause product-defect --issue https://github.com/acme/suite/issues/7
```

This writes the marker and a caused ledger row together, or writes neither.

The marker is `.skip` on the declaration: `test`, `it`, `describe` and
`test.describe` are handled. A pytest test gets a `@pytest.mark.skip(reason=…)`
decorator instead. With `--as-tag`, the first quarantine tag is added to the
title, for suites that quarantine by tag. A comment above the marker names the
ticket and the cause.

The row records the marker the way katana does (`describe.skip` for a
`test.describe.skip`), with `cause`, `issue` and `expiry`.

The command refuses, and touches nothing, in these cases:

- `--cause` is not one of katana's causes;
- `--issue` is missing for `product-defect`, `blocked-data` or
  `pending-feature`;
- the test is not in the file, or is already switched off;
- the ledger is corrupt.

### `migrate`: one-shot, markers to rows

```bash
# Show the rows the unledgered markers would become (writes nothing):
canary skills run canary-unquarantine -- migrate

# Append them:
canary skills run canary-unquarantine -- migrate --yes
```

For a suite that quarantines by tag (`@known-failure` plus a ticket URL in the
comment above) or by bare skip, `migrate` turns every unledgered marker into a
ledger row. It is offline and asks no tracker.

**No ticket link is lost.** Every reference in the comment above the marker is
kept exactly as written: a URL stays a URL. The first reference becomes the
row's `issue`, and the rest go into its `reason`.

A tag row records the title without its tag, so the row still matches the test
after a trial removes the tag.

A marker that names no ticket becomes a row anyway. The audit then shows it as
`unlinked`, where before it was invisible.

Re-running finds nothing left to migrate, so no row is written twice. A suite
with no test files abstains rather than reporting "nothing to migrate".

`canary-ci-ready` reads these classes for its flakiness check. A row that is
`unlinked` or `stale` is a quarantine nobody can release.

## Fidelity limits

- **Titles are matched as text.** Exact first, then containment, the same rule
  the ledger's consumers use. A title assembled at run time is not found, and
  its row reads `stale`.
- **The comment is the block directly above the marker.** A blocker named only
  in a describe's docblock further up is not read; the row falls back to its
  `reason`.
- **Hand-off lines are read by verb.** A closing comment that moves work in
  words the patterns do not cover ("see the new issue") reads as no hand-off, so
  the row can show as a `candidate` when it is not one. That is why a candidate
  goes to a trial run and is never released on this audit alone.
