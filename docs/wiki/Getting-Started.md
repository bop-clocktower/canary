# Getting Started with Oracle

This guide takes you from zero to your first generated test.
It should take about five minutes.

## Prerequisites

You'll need:

- Python 3.11 or later (`python --version` to check)
- Node.js 18 or later (`node --version` to check)
- An Anthropic API key ([console.anthropic.com][anthropic])
- Git

[anthropic]: https://console.anthropic.com

## Step 1: Install Oracle

```bash
git clone https://github.com/bri-stevenski/oracle-test-ai-agent.git
cd oracle-test-ai-agent
pip install -e .
```

Verify the install worked:

```bash
oracle version
```

You should see: `Oracle AI v0.1 (MVP)`

## Step 2: Run Setup

This checks your environment, installs the harness tooling, and
wires up the Claude Code integration automatically:

```bash
oracle setup
```

What it does:

- Checks Node.js is available
- Installs `harness-mcp` globally if missing (provides CI checks
  and architecture enforcement inside Claude Code)
- Reminds you to set `ANTHROPIC_API_KEY` if it's not set
- Creates `.claude/settings.local.json` so Claude Code approves
  the project's MCP servers without prompting you each session

If anything fails, fix it and re-run `oracle setup` — it's safe
to run multiple times.

## Step 3: Set Your API Key

If `oracle setup` flagged a missing key, add it now:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

To make this permanent, add that line to your `~/.zshrc` or
`~/.bashrc`.

> **Using a different provider?** See
> [LLM Providers & Configuration](LLM-Providers-and-Configuration.md)
> for OpenAI and Gemini setup.

## Step 4: Generate Your First Test

```bash
oracle generate "Test that GET /api/health returns 200"
```

Oracle will:

1. Classify the intent (API test)
2. Pick the best framework (pytest)
3. Generate a test file
4. Print the path to the file

The output looks something like:

```text
Oracle Processing Request...

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

```bash
oracle generate "Test that GET /api/health returns 200" --run
```

Or, if you already have the file:

```bash
pytest tests/generated/api/test_api_health_get_200.py
```

## What Happens to Generated Tests

Generated tests live in `tests/generated/` — a scratch space
that is **not** committed to git. They're yours to review and
run freely.

Once a test passes review, you can promote it into the committed
test suite. See the
[oracle-promote-test][promote-skill] skill for
the full promotion checklist.

[promote-skill]: ../skills/claude-code/oracle-promote-test/SKILL.md

## Want a Preview Without Generating?

Use `--recommend-only` to see what Oracle would pick without
calling the LLM (no API key needed):

```bash
oracle generate "load test the search endpoint" --recommend-only
```

## Next Steps

- [Writing Good Prompts](Writing-Good-Prompts.md) — get the
  test you actually want on the first try
- [For Manual Testers](For-Manual-Testers.md) — if you're
  coming from a manual testing background
- [Troubleshooting](Troubleshooting.md) — if something
  went wrong above
