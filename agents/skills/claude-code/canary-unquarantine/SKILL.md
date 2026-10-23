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
  and why", or "audit the quarantine ledger". Read-only and advisory; never
  releases a test on ticket state alone. NOT a test runner and NOT a flake
  diagnosis (that is canary-flake-hunter).
cli: scripts/cli.mjs
requires: [node>=20, gh]
---

# Canary Unquarantine

`canary-katana` puts tests into quarantine; nothing took them out. Its own rule
— "remove the row when the test passes live" — had no step that acted on it. And
a skipped test never runs, so it can never pass live: a quarantine with no
release step is permanent by construction.

This skill is that step. Its first command, `audit`, answers one question per
ledger row: **is the thing this test waits on resolved?**

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

## What comes next

The audit is the read-only half. The trial release — one confirm, one draft PR
in the suite that lifts every candidate's marker, and a verdict per test from
that PR's own CI run (pass: drop the row; fail: re-point it and restore the
marker; flaky: hand to `canary-flake-hunter`) — and the producer side (one entry
point that writes the ledger row and the marker together, and a one-shot
migration of tag-style quarantine into ledger rows) are tracked in #1455.

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
