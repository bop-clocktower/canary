# Interactive Guided Onboarding Specification

A first-run guided experience for end users who install Oracle via pip. Walks
them through provider selection, API key entry, and connection verification
before any `oracle` command runs for the first time in a project. Re-runnable
explicitly via `oracle setup`.

## Scope

**In scope:**

- Auto-detection of unconfigured projects with an interactive prompt to run
  setup before continuing
- `oracle setup` command: provider selection, masked API key entry, connection
  verification
- `oracle setup --full` flag: runs a sample generation after setup to
  demonstrate output
- Project-local config file (`.oracle/config.json`) tracking provider and
  setup timestamp
- `--no-setup` flag on `generate`, `run`, `init`, and `migrate` to suppress
  the auto-trigger in scripting contexts

**Out of scope:**

- Storing API keys in the config file (keys stay in environment variables)
- Multi-provider configs (one active provider per project)
- GUI or web-based onboarding
- Automatic shell profile modification (e.g. appending
  `export ANTHROPIC_API_KEY=...` to `.zshrc`)

## Assumptions

- Users install Oracle via `pip install oracle` before running any command.
  The onboarding handles configuration, not installation.
- The API key is already known to the user; the wizard validates it but does
  not retrieve or generate one.
- CI environments set a recognised CI environment variable (`CI`, `TRAVIS`,
  `CIRCLECI`, etc.); the auto-trigger checks `sys.stdin.isatty()` and skips
  silently in non-interactive contexts.
- `.oracle/` is added to the project's `.gitignore` as part of setup.

## User Stories

| # | As a developer I want to… | So that… |
| --- | --- | --- |
| U1 | be prompted to configure Oracle the first time I run a command | I don't get a cryptic API key error with no guidance |
| U2 | choose my LLM provider interactively | I'm not forced to know the env var name upfront |
| U3 | have my API key validated before setup completes | I know immediately if the key is wrong |
| U4 | re-run setup at any time with `oracle setup` | I can switch providers or fix a broken key |
| U5 | skip setup inline with `--no-setup` | My CI scripts and pipelines are not interrupted |

## Trigger Behaviour

Onboarding fires in two ways:

**Auto-trigger:** A Typer `@app.callback()` runs before every subcommand. If
`SetupWizard.is_configured()` returns False and `sys.stdin.isatty()` is True,
it prompts:

```text
! Oracle isn't configured for this project yet.
  Run setup now? [Y/n]  (skip with --no-setup or run later: oracle setup)
```

If the user says Y, the wizard runs and the original command resumes
automatically on completion. If N, a warning is printed and the command
continues (and will likely fail on a missing API key).

**Explicit:** `oracle setup` always runs the wizard regardless of config
state, skipping the Y/N prompt and proceeding directly to provider selection.
Accepts `--full` to append a sample generation after setup.

## Wizard Steps

1. **Provider selection** — interactive prompt offering `claude` (default),
   `openai`, `gemini`
2. **API key entry** — masked input; key is not stored, only used for
   verification in step 3
3. **Connection verify** — cheap call to the selected provider to confirm the
   key is valid; loops back to step 2 on failure with the provider's error
   message

On success, `.oracle/config.json` is written. On `KeyboardInterrupt` at any
step, setup is cancelled and no partial config is written.

## Config Format

**Location:** `.oracle/config.json` (project-local, relative to `cwd`)

```json
{
  "provider": "claude",
  "configured_at": "2026-05-19T17:42:00Z"
}
```

No API key is stored. `SetupWizard.is_configured()` requires the `provider`
field to be present and non-empty.

## Error Handling

| Scenario | Behaviour |
| --- | --- |
| Bad API key or network error | Print error, offer "Try a different key? [Y/n]", loop to step 2 |
| Verification passes on retry | Continue normally and write config |
| Non-TTY or CI context | Skip wizard silently; command runs as-is |
| `KeyboardInterrupt` mid-wizard | Print "Setup cancelled. Run `oracle setup` to try again." No config written. |
| `oracle setup` run outside a project | No guard; config written to `cwd/.oracle/config.json` |

## src Reference

- [`agent/cli.py`](../../agent/cli.py) — `@app.callback()` and `oracle setup`
  command
- [`agent/core/setup.py`](../../agent/core/setup.py) — `SetupWizard` class
  (new)
- [`tests/unit/test_setup.py`](../../tests/unit/test_setup.py) — unit tests
  (new)

## Test Coverage

New file `tests/unit/test_setup.py` (~12 tests). All provider verify calls
stubbed via the existing mock provider; no network required.

| Test | What it checks |
| --- | --- |
| `test_is_configured_false_when_missing` | False when `.oracle/config.json` absent |
| `test_is_configured_true_when_valid` | True when file present with valid `provider` |
| `test_is_configured_false_when_malformed` | False when file exists but `provider` missing |
| `test_run_writes_config_on_success` | Config written after mocked verify pass |
| `test_run_no_partial_config_on_interrupt` | No file written on `KeyboardInterrupt` |
| `test_run_loops_on_bad_key` | Loops to key input on failure, succeeds on second try |
| `test_callback_skips_when_configured` | Callback does not prompt when config exists |
| `test_callback_skips_when_not_tty` | Callback skips silently when stdin is not a TTY |
| `test_callback_skips_with_no_setup_flag` | Callback skips when `--no-setup` passed |
| `test_callback_prompts_when_unconfigured_tty` | Prompt shown when no config and TTY |
| `test_callback_resumes_command_after_setup` | Original command resumes after wizard |
| `test_setup_full_invokes_orchestrator` | `--full` calls orchestrator after config written |
