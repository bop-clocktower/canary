# Troubleshooting

Common problems and how to fix them.

## "Canary needs an API key"

It doesn't. Canary runs as a Claude Code plugin and uses your Claude Code
session for all LLM work — there is no provider API key to set. The CLI
commands (`recommend`, `init`, `run`, `migrate`) are deterministic and make no
LLM calls. If a doc, script, or older fork tells you to set `ANTHROPIC_API_KEY`
or `CANARY_LLM_PROVIDER`, it predates v3 and is out of date.

## Canary Command Not Found

**Error:** `canary: command not found`

Canary wasn't installed or the install didn't complete.

**Fix:** Run the install from the repo root:

```bash
pip install -e .
```

If you're using a virtual environment, make sure it's activated
before installing and before running Canary.

## No Framework Resolved

**Error:** `No framework found for category: ...`

The classifier produced a test type that has no matching entry
in the framework registry.

**Fix:** This usually means the prompt was vague or the classifier
made an unexpected guess. Try adding the test type explicitly:

```text
/canary-write-test  API test: GET /v1/users returns 200
```

Or check the registry for the available categories:

```bash
cat agent/frameworks/registry.json
```

If the category genuinely has no entry, a new registry entry is
needed. See the
[canary-add-framework skill][add-framework] for how to add one.

[add-framework]: ../skills/claude-code/canary-add-framework/SKILL.md

## Test Execution Fails After Generation

**Error:** The generated test exits with a non-zero code.

First, determine what kind of failure it is:

**Syntax/import error in the generated file:**

Canary produced code that doesn't run. This is a generation
quality issue. Try a more specific prompt and regenerate —
don't hand-edit more than a line or two.

**Environment error (missing creds, wrong URL):**

The test ran but couldn't reach the system under test. Fix
your environment (set the right base URL, credentials, etc.),
then rerun the test. Don't change the test itself.

**Assertion failure (the SUT returned something unexpected):**

This is the most useful outcome — the test ran and found a
real mismatch between what you expected and what the system
does. Review whether the assertion is wrong (your prompt was
imprecise) or the system is wrong (genuine bug). If it's the
latter, you just found a bug automatically.

## Classifier Confidence Is Low

**Symptom:** Canary generates a test for the wrong type (e.g.,
unit test when you wanted an API test).

Low-confidence classifications happen when the prompt is
ambiguous.

**Fix:** Be more explicit. Add the test type to the prompt:

```text
/canary-write-test  API test: POST /v1/orders with a valid payload
should return 201 and an order ID
```

See [Writing Good Prompts](Writing-Good-Prompts.md) for more
guidance on avoiding this.

## Harness CI Check Failing

See [Understanding the Harness](Understanding-the-Harness.md)
for a breakdown of each check and what to do when it fails.

The most common CI failures:

- **Broken markdown link** — fix the path or change to plain
  text
- **Line too long in docs** — wrap prose at 80 characters
- **Stale security ledger** — run
  `python3 scripts/security_ledger.py` and commit

## Generated File Is Empty or Malformed

**Symptom:** The output file exists but contains no test code,
or contains garbled output.

This usually means the model response in your Claude Code session was
truncated or interrupted.

**Fix:** Re-run the `/canary-write-test` command in Claude Code. If the
problem persists, narrow the prompt to a single behavior so the generation
fits comfortably in one response.

## Can't Find the Generated File

Canary always prints the output path at the end of a successful
run. If you missed it, generated files are always under:

```text
tests/generated/<category>/
```

For example, an API test for `/v1/orders` might be at:

```text
tests/generated/api/test_orders_post_201.py
```

Note: `tests/generated/` is gitignored, so it won't show in
`git status`. Use `ls` or `find` to locate files there:

```bash
find tests/generated -name "*.py" -newer pyproject.toml
```

## Plugin Install Fails: "source type not supported"

**Error:**

```text
Failed to install: This plugin uses a source type your Claude Code version
does not support. Update Claude Code and try again.
```

This error was caused by the plugin source using the `git-subdir` format,
which requires a specific Node.js runtime version to parse correctly. The
root cause is fixed — the plugin now lives at the repo root and
`marketplace.json` uses a plain GitHub URL.

If you are on an older checkout that still uses `git-subdir`, install
[Volta](https://volta.sh) to fix the Node version:

```bash
brew install volta
volta install node
```

Then restart your terminal (or `source ~/.zshrc`) and retry:

```bash
/plugin marketplace add https://github.com/bop-clocktower/canary
/plugin install canary@bop-clocktower
```

## Still Stuck?

Open an issue on GitHub with:

1. The exact command you ran
2. The full error output
3. Your Python version (`python --version`)
4. Your Canary version (`canary version`)
