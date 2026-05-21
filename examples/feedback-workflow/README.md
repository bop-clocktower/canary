# Example: Feedback Workflow

Demonstrates the feedback path end-to-end. No code generation involved — this is
about how to **report back** when Oracle does something unexpected.

## Why this example exists

The fastest way to make Oracle better is for testers to file specific issues
when output is wrong, surprising, or unhelpful. Oracle ships with a one-click
feedback flow exactly because every-time you have to navigate to GitHub
manually, the friction kills the report. This example walks through the loop so
you know what to expect.

For the full reference, see
[Feedback Workflow](../../docs/wiki/Feedback-Workflow.md).

## Walkthrough

### 1. Generate something

Any `oracle generate` works. Even the recommend-only path emits a hint.

```bash
oracle generate "smoke test the homepage"
```

The last line of the output:

```text
💬 Report feedback (public link — review before submitting): https://github.com/bri-stevenski/oracle-test-ai-agent/issues/new?title=...&body=...
```

That URL is your one-click report path.

### 2. Click the URL

GitHub opens "New Issue" pre-filled. The title looks like:

```text
[oracle feedback] pytest/api
```

The body looks like:

```markdown
> ⚠️ This issue will be public. Review the prompt below and remove any customer
> IDs, internal endpoints, credentials, or stack traces before submitting.

## What did Oracle do?

- **Prompt:** smoke test the homepage
- **Test type:** e2e_ui
- **Framework:** playwright
- **Provider:** anthropic
- **Model:** claude-sonnet-4-6
- **Output file:** `tests/generated/playwright_test_20260519_142301.spec.ts`

## What went wrong / what would you change?

<!-- describe the issue, paste snippets, attach files -->
```

### 3. Edit before submit

**Scrub the prompt** if it had customer IDs, internal endpoints, etc. The URL
hit GitHub but the issue **isn't created** until you click the Create button —
you have free editing space.

Fill in the "What went wrong" section with specifics:

> The generated test uses `page.click('#login')` but our actual selector is
> `data-testid="login-cta"`. Oracle should default to data-testid selectors
> for projects with that convention.

Click **Create**. Issue filed.

### 4. Reprint the URL later

Lost the terminal scrollback? Need to share the URL in Slack?

```bash
oracle feedback
```

This reads `.oracle/last_generation.json` (gitignored, local-only) and reprints
the same URL. Exits non-zero with a clear message if there's no recent
generation in this directory.

## What if I'm in an air-gapped or sensitive context?

Redirect feedback to a private repo:

```bash
export ORACLE_FEEDBACK_REPO=your-org/private-oracle-feedback
oracle generate "anything"   # URLs now point at the private repo
```

Or just don't click the URL — the warning is real, and the friction-free path
always has the option of being skipped.

## JSON mode

For tool integrations, `--json` emits the URL as a field:

```bash
oracle generate "test something" --json | jq .feedback_url
```

Useful for surfacing the link inside a chat bot, dashboard, or CI summary.

## See also

- [Feedback Workflow](../../docs/wiki/Feedback-Workflow.md) — full reference
- [CLI Reference → `oracle feedback`](../../docs/wiki/CLI-Reference.md)
- [Known Limitations](../../docs/wiki/Known-Limitations.md) — read this before
  filing
