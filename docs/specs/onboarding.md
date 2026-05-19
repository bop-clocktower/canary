# Interactive Guided Onboarding — Design Spec

**Date:** 2026-05-19
**Status:** approved
**Roadmap item:** Interactive Guided Onboarding (Developer Experience & Onboarding)

---

## Overview

A first-run guided experience for end users who install Oracle via pip. Walks them through provider selection, API key entry, and connection verification before any `oracle` command runs for the first time in a project. Re-runnable explicitly via `oracle setup`.

---

## Trigger Behaviour

Onboarding fires in two ways:

1. **Auto-trigger** — before any `oracle` subcommand, a Typer `@app.callback()` checks whether the project is configured. If not, and stdin is a TTY, it prompts:
   ```
   ! Oracle isn't configured for this project yet.
     Run setup now? [Y/n]  (skip with --no-setup or run later: oracle setup)
   ```
   If the user says Y, the wizard runs and the original command resumes automatically on completion. If N, a warning is printed and the command continues (it will fail naturally if the API key is missing).

2. **Explicit** — `oracle setup` always runs the wizard regardless of config state, allowing reconfiguration. Accepts a `--full` flag to append a sample test generation after setup completes.

---

## Components

### `agent/core/setup.py` — `SetupWizard`

Owns all interactive setup logic. Responsibilities:

- `is_configured(path: Path = None) -> bool` — classmethod; checks whether `.oracle/config.json` exists in `cwd` (or a given path) and contains a valid `provider` field.
- `run(full: bool = False) -> None` — runs the three-step wizard:
  1. **Provider selection** — interactive prompt: `claude` (default), `openai`, `gemini`
  2. **API key entry** — masked input; key is not stored, only used for verification
  3. **Connection verify** — cheap call to the provider to confirm the key works; loops on failure
- Writes `.oracle/config.json` on success (only after verification passes).
- If `full=True`, invokes `OracleOrchestrator` with a canned prompt after config is written to show a live generation.

### `cli.py` — `@app.callback()`

Added to the Typer app. Runs before every subcommand:

1. Calls `SetupWizard.is_configured()`
2. If False and `sys.stdin.isatty()` and `--no-setup` not passed → prompt user
3. If user says Y → `SetupWizard().run()` → continue
4. If user says N → warn and continue
5. If not a TTY → silently skip (CI-safe)

`oracle setup` is exempt from the guard — it always runs.

### `--no-setup` flag

Added to `generate`, `run`, `init`, and `migrate`. Suppresses the callback check for scripting contexts.

---

## Config Format

**Location:** `.oracle/config.json` (project-local, relative to `cwd`)

```json
{
  "provider": "claude",
  "configured_at": "2026-05-19T17:42:00Z"
}
```

- No API key stored — stays in the environment
- `.oracle/` added to `.gitignore`
- `is_configured()` requires `provider` field to be present and non-empty

---

## Error Handling

| Scenario | Behaviour |
|---|---|
| Bad API key / network error during verify | Print provider error, offer "Try a different key? [Y/n]", loop back to key input |
| Verification passes on retry | Continue normally, write config |
| Non-TTY / CI context | Skip wizard silently; command runs as-is |
| Ctrl-C mid-wizard | Catch `KeyboardInterrupt`, print "Setup cancelled. Run `oracle setup` to try again.", exit — no partial config written |
| User runs `oracle setup` outside a project directory | No guard; config written to `cwd/.oracle/config.json` |

---

## Testing

New file: `tests/unit/test_setup.py` (~12 tests)

| Test | Description |
|---|---|
| `test_is_configured_false_when_missing` | Returns False when `.oracle/config.json` absent |
| `test_is_configured_true_when_valid` | Returns True when file present with valid `provider` |
| `test_is_configured_false_when_malformed` | Returns False when file exists but `provider` missing |
| `test_run_writes_config_on_success` | Config written with correct provider after mocked verify pass |
| `test_run_no_partial_config_on_interrupt` | No file written when `KeyboardInterrupt` raised mid-wizard |
| `test_run_loops_on_bad_key` | Loops back to key input on first verify failure, succeeds on second |
| `test_callback_skips_when_configured` | `@app.callback()` does not prompt when config exists |
| `test_callback_skips_when_not_tty` | `@app.callback()` silently skips when `sys.stdin.isatty()` is False |
| `test_callback_skips_with_no_setup_flag` | `@app.callback()` skips when `--no-setup` passed |
| `test_callback_prompts_when_unconfigured_tty` | Prompt shown when no config and stdin is TTY |
| `test_callback_resumes_command_after_setup` | Original command args preserved and executed after wizard |
| `test_setup_full_invokes_orchestrator` | `oracle setup --full` calls orchestrator after config written |

All provider verify calls stubbed via the existing mock provider. No network required.

---

## Out of Scope

- Storing API keys in the config file (keys stay in environment variables)
- Multi-provider configs (one active provider per project)
- GUI or web-based onboarding
- Automatic shell profile modification (e.g. writing `export ANTHROPIC_API_KEY=...` to `.zshrc`)
