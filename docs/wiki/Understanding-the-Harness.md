# Understanding the Harness

When you open a pull request or push to a branch, a set of
automated checks run. These are called the **harness** — a
collection of CI gates that keep the codebase healthy.

This page explains what each check does in plain language and
what to do when one fails.

## Why These Checks Exist

The harness isn't bureaucracy. Each check protects against a
specific type of problem that has caused real issues before:

- Broken links in docs that send readers to dead pages
- Security vulnerabilities introduced during normal development
- Code structure that makes Canary harder to maintain or extend
- Documentation that drifts out of sync with the code it
  describes

The checks run automatically so problems are caught early,
before they become bigger problems.

## The Checks

### Architecture Enforcer

**What it checks:** That the code's layer structure is intact.
Canary is built in three layers — LLM, Core, and CLI — and they
must only communicate in one direction (CLI depends on Core,
Core depends on LLM, LLM depends on nothing else). This check
also validates that markdown links in docs point to files that
actually exist.

**When it fails:**

- A file imports from a layer it's not supposed to touch
- A markdown link points to a file or directory that doesn't
  exist (including `tests/generated/`, which is gitignored)

**What to do:** Read the error carefully. For broken links,
either fix the path or change the link to plain text if the
file intentionally doesn't exist (e.g., gitignored output).
For layer violations, check which import is crossing a boundary
and restructure it.

### Quality & Integrity

**What it checks:** That the Python package is consistent and
that key metadata (like the security ledger) is up to date.

**When it fails:**

- The Python package has configuration issues (e.g., two
  top-level packages discovered when only one is expected)
- The security ledger is stale (a scan ran but the ledger
  wasn't refreshed)

**What to do:** Check the CI log for the specific error. Package
configuration issues are usually in `pyproject.toml`. Ledger
staleness is fixed by running `python3 scripts/security_ledger.py`
and committing the result.

### Docs Lint

**What it checks:** That all markdown files follow consistent
formatting rules. The key rules are:

- Lines must be 80 characters or shorter (prose only — code
  blocks and tables are exempt)
- Headings must have a blank line before and after them
- Lists must have a blank line before and after them
- Code blocks must have a language tag (e.g., ` ```bash ` not
  just ` ``` `)
- No raw HTML inside markdown

**When it fails:** A doc file has a line that's too long, a
missing blank line around a heading, or a code block without
a language.

**What to do:** Run markdownlint locally to see the exact
violations:

```bash
npx markdownlint-cli "docs/**/*.md" "agents/**/*.md" AGENTS.md
```

Fix the flagged lines. For long lines, break them at a
natural point. For missing blank lines, add them. For code
blocks missing a language, add one (use `text` if nothing
else fits).

### Security Reviewer

**What it checks:** That no new security vulnerabilities have
been introduced — things like hardcoded credentials, insecure
dependencies, or code patterns that could be exploited.

After each scan, it updates the security ledger automatically
(via a bot commit). You don't need to manually update it.

**When it fails:** The scan found a security issue, or the
harness validation step failed. Read the scan output — it will
name the specific file and issue.

**What to do:** Address the flagged issue. If the finding is
a false positive, the harness config has a way to suppress
specific rules — but understand the finding before suppressing.

## How to Read a Failing Check

Every failing check in the CI logs shows:

1. **The check name** — which gate failed
2. **The command that ran** — so you can reproduce it locally
3. **The error output** — the specific file and line number

Always read the error output before guessing at a fix. Most
failures are specific and fixable in a few minutes once you
know what's wrong.

## Asking for Help

If a check is failing and you can't figure out why:

1. Copy the error message from the CI log
2. Share it in your team channel or with Canary — describe
   what you were changing when it failed
3. The error message usually contains enough information for
   someone to spot the issue immediately

The harness is strict because it protects everyone on the team,
not just you. A check that fails on your PR is catching something
before it becomes a problem for the whole team.
