---
name: canary-strix
description: >
  Keeps company, client and consumer identifiers out of a public repository —
  scanning both tracked file contents and the AUTHORSHIP of the commits a change
  adds (author, committer, and `Co-authored-by:` trailers), because a company
  email never appears in a file, only in commit metadata. Use when the user says
  "is anything leaking into this public repo", "scan for client names", "did we
  commit a company email", "open-source hygiene", or before making a repo
  public. Deterministic — no LLM, no network, no execution. NOT a secret scanner
  (use gitleaks/trufflehog for credentials); this is about IDENTIFIERS — who you
  work for and who your customers are.
cli: scripts/cli.mjs
requires: [node>=20]
---

# canary-strix

A public repository leaks who you work for in two places, and only one of them
is a file.

## The two surfaces

**Tracked file contents** (`STRIX-001`) — the obvious half. A client name in a
comment, a fixture, a changelog entry.

**Commit authorship** (`STRIX-002`) — the half that gets missed. A company email
never appears _in_ a tracked file; it lives in the metadata of the commit
carrying it. A tree can scan perfectly clean while every commit in it is stamped
with a company address. This is not hypothetical: canary itself accumulated 190
such commits, every one from a clone that inherited a global `user.email`
instead of the repo's pin.

The authorship scan reads the author, the committer, **and** `Co-authored-by:`
style trailers. GitHub renders a co-author as a linked contributor on the public
commit page, which makes a trailer a _more_ visible identity surface than the
author field.

## Where terms come from

Three sources, unioned. Which one is right depends on whether the repo is
public:

| Source                              | Committed? | Use when                                     |
| ----------------------------------- | ---------- | -------------------------------------------- |
| `CANARY_PROPRIETARY_DENYLIST` env   | no         | **public repo** — supply it as a CI secret   |
| `.proprietary-denylist` (gitignore) | no         | **public repo** — the same list, at the desk |
| `.canary/company.json`              | **yes**    | **private repo only**                        |

`company.json` is the convenient option and the one to be careful with: it is
committed, so on a public repo it publishes exactly the list of identifiers you
are trying to hide. The CLI says so out loud when terms come from there.

Prefer **one term per line** in the secret. GitHub masks a multi-line secret
line by line, so each term is masked individually in a log; a comma-joined value
is only masked as the whole string, which is never the form that appears in
output.

## Zero terms is not a clean scan

With no terms configured this cannot match anything, whatever it is pointed at.
That is an abstention, and it exits **3** under `--strict` rather than reporting
a pass. The same applies when only half the scan ran — files read but commits
unreadable is a partial result, not a green one.

Findings never echo the matched value. On a public repo the CI log is
world-readable, so printing the identifier would publish the thing the scan
exists to protect, on exactly the lines that trip it. A finding names the file
and line, or the commit and which field matched, plus a local command to inspect
it.

## Matching

Terms are authored as prose (`Acme Health`, `Acme Inc.`) and subjects are not:
an email domain drops or changes the separator. A naive `\b<term>\b` misses
`dev@acmehealth.example`, misses `dev@acme-health.example`, and — for a term
ending in punctuation like `Acme Inc.` — matches nothing at all, ever, because
`\b` after `.` requires a word character. Those failures are silent and they
fail **open**.

So a term is split into alphanumeric tokens, joined with a separator-tolerant
gap, and bounded with unicode-aware lookarounds. Boundaries still hold: `Acme`
does not match `acmecorp`.

## Invocation

```bash
# Advisory scan of the current repo (exit 0 regardless):
canary skills run canary-strix

# Gate a CI step — findings or an abstention fail it:
canary skills run canary-strix -- --strict

# Files only, skipping commit authorship:
canary skills run canary-strix -- --files-only

# An explicit range instead of the CI event:
canary skills run canary-strix -- --range origin/main..HEAD

# Machine-readable:
canary skills run canary-strix -- --json
```

On CI the commit range is resolved from the event: `GITHUB_BASE_REF` (with
`GITHUB_PR_HEAD_SHA`) on a pull request, `GITHUB_EVENT_BEFORE` on a push. Pass
`GITHUB_PR_HEAD_SHA: ${{ github.event.pull_request.head.sha }}` — without it the
range ends at the checked-out `refs/pull/N/merge` commit, which GitHub
synthesises per event and authors with the PR author's _account_ email. That
commit is discarded at merge, so scanning it reports a leak that cannot happen.

## Exit codes

| Code | Meaning                                                         |
| ---- | --------------------------------------------------------------- |
| 0    | advisory run, or `--strict` with a complete scan and no finding |
| 1    | `--strict`, findings                                            |
| 2    | usage error                                                     |
| 3    | `--strict`, abstained — no terms, or only half the scan ran     |

## Fidelity limits

Literal terms, not inference. It will not catch a client referred to only by a
nickname, an internal hostname that is not on the list, or a codename nobody
wrote down. The list is the denominator, and the CLI always prints it.

Secrets and credentials are out of scope — that is a different tool and a
different failure mode.
