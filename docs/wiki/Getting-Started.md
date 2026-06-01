# Getting Started with Canary

This guide takes you from zero to your first generated test.
It should take about five minutes.

## Prerequisites

You'll need:

- Python 3.11 or later (`python --version` to check)
- Node.js 18 or later (`node --version` to check)
- Claude Code (Canary runs as a plugin — no separate API key needed)
- Git

## Step 1: Install Canary

```bash
git clone https://github.com/bop-clocktower/canary.git
cd canary
pip install -e .
```

Verify the install worked:

```bash
canary version
```

You should see the Canary banner with the version, e.g. `canary  v1.0.0`.

## Step 2: Open Canary in Claude Code

Canary runs as a Claude Code plugin — no API key setup required.
Install the plugin once:

```bash
claude plugin install .
```

Claude Code's own session provides the LLM. Your first
`/canary:generate` will analyse the target file and write tests
automatically.

## Step 3: Generate Your First Test

In Claude Code, invoke the test-author persona:

```text
/canary-write-test  Test that GET /api/health returns 200
```

Canary will:

1. Classify the intent (API test)
2. Pick the best framework (pytest)
3. Generate a test file
4. Print the path to the file

The output looks something like:

```text
Canary Processing Request...

Test Type: api
Framework: pytest

Reasoning:
 - HTTP endpoint test maps to API category
 - Python ecosystem detected, pytest preferred

Output File:
tests/generated/api/test_api_health_get_200.py
```

## Step 5: Look at the Generated File

```bash
cat tests/generated/api/test_api_health_get_200.py
```

Read through it. Check that:

- The endpoint matches what you intended
- The assertion matches the expected behavior
- There are no placeholder values you need to fill in

## Step 6: Run the Test

Once the file is written, run it with the CLI executor (deterministic, no key):

```bash
canary run tests/generated/api/test_api_health_get_200.py pytest
```

Or invoke the framework directly:

```bash
pytest tests/generated/api/test_api_health_get_200.py
```

## What Happens to Generated Tests

Generated tests live in `tests/generated/` — a scratch space
that is **not** committed to git. They're yours to review and
run freely.

Once a test passes review, you can promote it into the committed
test suite. See the
[canary-promote-test][promote-skill] skill for
the full promotion checklist.

[promote-skill]: ../skills/claude-code/canary-promote-test/SKILL.md

## Want a Preview Without Generating?

Use `canary recommend` to see what framework Canary would pick, with its
reasoning — a deterministic CLI command that makes no LLM call:

```bash
canary recommend "load test the search endpoint"
```

## Next Steps

- [Writing Good Prompts](Writing-Good-Prompts.md) — get the
  test you actually want on the first try
- [For Manual Testers](For-Manual-Testers.md) — if you're
  coming from a manual testing background
- [Troubleshooting](Troubleshooting.md) — if something
  went wrong above
