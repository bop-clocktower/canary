# Troubleshooting

Common problems and how to fix them.

## API Key Errors

**Error:** `AuthenticationError` or `Invalid API key`

This means Oracle can't connect to the LLM provider.

**Fix:** Make sure your API key is set in your shell session:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

If you've set it before but it's gone, you may need to re-add
it to your shell config (`~/.zshrc` or `~/.bashrc`) and reload:

```bash
source ~/.zshrc
```

To confirm the key is set:

```bash
echo $ANTHROPIC_API_KEY
```

Using a different provider? See
[LLM Providers & Configuration](LLM-Providers-and-Configuration.md)
for the correct env variable names.

## Oracle Command Not Found

**Error:** `oracle: command not found`

Oracle wasn't installed or the install didn't complete.

**Fix:** Run the install from the repo root:

```bash
pip install -e .
```

If you're using a virtual environment, make sure it's activated
before installing and before running Oracle.

## No Framework Resolved

**Error:** `No framework found for category: ...`

The classifier produced a test type that has no matching entry
in the framework registry.

**Fix:** This usually means the prompt was vague or the classifier
made an unexpected guess. Try adding the test type explicitly:

```bash
oracle generate "API test: GET /v1/users returns 200"
```

Or check the registry for the available categories:

```bash
cat agent/frameworks/registry.json
```

If the category genuinely has no entry, a new registry entry is
needed. See the
[oracle-add-framework skill][add-framework] for how to add one.

[add-framework]: ../skills/claude-code/oracle-add-framework/SKILL.md

## Test Execution Fails After Generation

**Error:** The generated test exits with a non-zero code.

First, determine what kind of failure it is:

**Syntax/import error in the generated file:**

Oracle produced code that doesn't run. This is a generation
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

**Symptom:** Oracle generates a test for the wrong type (e.g.,
unit test when you wanted an API test).

Low-confidence classifications happen when the prompt is
ambiguous.

**Fix:** Be more explicit. Add the test type to the prompt:

```bash
oracle generate "API test: POST /v1/orders with a valid payload
should return 201 and an order ID"
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

This usually means the LLM response was truncated or the
provider had a transient error.

**Fix:** Rerun the same command. If it fails repeatedly, try
a different provider:

```bash
ORACLE_LLM_PROVIDER=openai oracle generate "..."
```

## Can't Find the Generated File

Oracle always prints the output path at the end of a successful
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

This error appears during `/plugin install oracle@oracle` and is caused by a
Node.js version mismatch — Claude Code picks up the wrong Node runtime and
misreads the marketplace plugin source format.

**Fix:** Install [Volta](https://volta.sh) to pin the Node version:

```bash
brew install volta
volta install node
```

Then restart your terminal (or `source ~/.zshrc`) and retry the plugin install:

```bash
/plugin marketplace add https://github.com/bri-stevenski/oracle-test-ai-agent
/plugin install oracle@oracle
```

> **Note:** Volta sets a default Node version globally. It does not affect
> project-local `.nvmrc` files or other version managers already in use.

## Still Stuck?

Open an issue on GitHub with:

1. The exact command you ran
2. The full error output
3. Your Python version (`python --version`)
4. Your Oracle version (`oracle version`)
