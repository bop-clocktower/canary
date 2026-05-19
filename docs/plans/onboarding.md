# Interactive Guided Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-run setup wizard that auto-triggers before any Oracle
command in an unconfigured project, walks the user through provider and API
key selection, verifies the key works, and writes `.oracle/config.json`.

**Architecture:** A new `SetupWizard` class in `agent/core/setup.py` owns all
interactive logic. A Typer `@app.callback()` in `cli.py` runs before every
subcommand and triggers the wizard when the project is unconfigured and stdin
is a TTY. The existing `oracle setup` command body is replaced to call
`SetupWizard().run()`.

**Tech Stack:** Python, Typer, Rich (`rich.prompt.Prompt`, `rich.prompt.Confirm`),
`unittest.mock`, `typer.testing.CliRunner`

---

## File Map

| Action | Path | Purpose |
| --- | --- | --- |
| Create | `agent/core/setup.py` | `SetupWizard` class — all wizard logic |
| Create | `tests/unit/test_setup.py` | 12 unit tests for wizard + callback |
| Modify | `agent/cli.py` | Add `@app.callback()`, replace `setup()` body |
| Modify | `.gitignore` | Add `.oracle/` |
| Modify | `docs/roadmap.md` | Link plan, update status |

---

### Task 1: `SetupWizard.is_configured()`

**Files:**

- Create: `agent/core/setup.py`
- Create: `tests/unit/test_setup.py`

- [ ] **Step 1: Write the three `is_configured` tests**

```python
# tests/unit/test_setup.py
import json
import unittest
from pathlib import Path
from unittest.mock import patch
import tempfile

from agent.core.setup import SetupWizard


class TestIsConfigured(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.root = Path(self.tmp)

    def test_false_when_missing(self):
        self.assertFalse(SetupWizard.is_configured(self.root))

    def test_true_when_valid(self):
        (self.root / ".oracle").mkdir()
        (self.root / ".oracle" / "config.json").write_text(
            json.dumps({"provider": "claude"})
        )
        self.assertTrue(SetupWizard.is_configured(self.root))

    def test_false_when_malformed(self):
        (self.root / ".oracle").mkdir()
        (self.root / ".oracle" / "config.json").write_text("{}")
        self.assertFalse(SetupWizard.is_configured(self.root))


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
.venv/bin/pytest tests/unit/test_setup.py -v
```

Expected: `ImportError` or `ModuleNotFoundError` for `agent.core.setup`.

- [ ] **Step 3: Create `agent/core/setup.py` with `is_configured`**

```python
# agent/core/setup.py
"""Interactive setup wizard for first-run Oracle configuration."""

import json
from pathlib import Path
from typing import Optional

_CONFIG_FILE = Path(".oracle") / "config.json"


class SetupWizard:

    @classmethod
    def is_configured(cls, path: Optional[Path] = None) -> bool:
        """Return True if .oracle/config.json exists with a valid provider."""
        config = (path or Path.cwd()) / _CONFIG_FILE
        if not config.exists():
            return False
        try:
            data = json.loads(config.read_text())
            return bool(data.get("provider"))
        except (json.JSONDecodeError, OSError):
            return False
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
.venv/bin/pytest tests/unit/test_setup.py -v
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add agent/core/setup.py tests/unit/test_setup.py
git commit -m "feat(onboarding): SetupWizard.is_configured()"
```

---

### Task 2: Wizard happy path — provider, key, verify, write config

**Files:**

- Modify: `agent/core/setup.py`
- Modify: `tests/unit/test_setup.py`

- [ ] **Step 1: Add the happy-path test**

Add to `tests/unit/test_setup.py` after `TestIsConfigured`:

```python
class TestSetupWizardRun(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.root = Path(self.tmp)

    def _run_wizard(self, provider="claude", key="sk-test", full=False):
        wizard = SetupWizard(output_dir=self.root)
        with patch("agent.core.setup.Prompt.ask", side_effect=[provider, key]), \
             patch("agent.core.setup.SetupWizard._test_connection", return_value=None), \
             patch("agent.core.setup.Confirm.ask", return_value=False):
            wizard.run(full=full)

    def test_run_writes_config_on_success(self):
        self._run_wizard()
        config = json.loads((self.root / ".oracle" / "config.json").read_text())
        self.assertEqual(config["provider"], "claude")
        self.assertIn("configured_at", config)
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
.venv/bin/pytest tests/unit/test_setup.py::TestSetupWizardRun::test_run_writes_config_on_success -v
```

Expected: `ImportError` — `run`, `Prompt`, `Confirm` not yet defined.

- [ ] **Step 3: Implement the wizard happy path**

Replace `agent/core/setup.py` with:

```python
# agent/core/setup.py
"""Interactive setup wizard for first-run Oracle configuration."""

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from rich.prompt import Confirm, Prompt

_CONFIG_FILE = Path(".oracle") / "config.json"

_PROVIDERS = ("claude", "openai", "gemini")

# Maps wizard provider name -> (env key name, ORACLE_LLM_PROVIDER value)
_PROVIDER_MAP = {
    "claude": ("ANTHROPIC_API_KEY", "anthropic"),
    "openai": ("OPENAI_API_KEY", "openai"),
    "gemini": ("GEMINI_API_KEY", "gemini"),
}


class SetupWizard:

    def __init__(self, output_dir: Optional[Path] = None):
        # output_dir is injectable for tests; defaults to cwd
        self._output_dir = output_dir or Path.cwd()

    @classmethod
    def is_configured(cls, path: Optional[Path] = None) -> bool:
        """Return True if .oracle/config.json exists with a valid provider."""
        config = (path or Path.cwd()) / _CONFIG_FILE
        if not config.exists():
            return False
        try:
            data = json.loads(config.read_text())
            return bool(data.get("provider"))
        except (json.JSONDecodeError, OSError):
            return False

    def run(self, full: bool = False) -> None:
        """Run the interactive setup wizard."""
        from rich import print as rprint
        rprint("\n[bold cyan]⚡ Oracle Setup[/bold cyan]\n")
        try:
            provider = self._select_provider()
            api_key = self._enter_key(provider)
            self._verify(provider, api_key)
            self._write_config(provider)
            if full:
                self._run_sample(provider, api_key)
        except KeyboardInterrupt:
            from rich import print as rprint
            rprint(
                "\n\nSetup cancelled. "
                "Run [bold]oracle setup[/bold] to try again."
            )
            raise SystemExit(1)

    def _select_provider(self) -> str:
        return Prompt.ask(
            "\n[bold]Step 1 of 3 · Provider[/bold]\nChoose a provider",
            choices=list(_PROVIDERS),
            default="claude",
        )

    def _enter_key(self, provider: str) -> str:
        env_key = _PROVIDER_MAP[provider][0]
        return Prompt.ask(
            f"\n[bold]Step 2 of 3 · API Key[/bold]\n{env_key}",
            password=True,
        )

    def _verify(self, provider: str, api_key: str) -> None:
        from rich import print as rprint
        rprint("\n[bold]Step 3 of 3 · Verify[/bold]")
        while True:
            try:
                self._test_connection(provider, api_key)
                rprint("[green]✓[/green] Connected")
                return
            except Exception as exc:
                rprint(f"[red]✗[/red] {exc}")
                if not Confirm.ask("Try a different key?", default=True):
                    raise SystemExit(1)
                api_key = self._enter_key(provider)

    def _test_connection(self, provider: str, api_key: str) -> None:
        """Make a minimal provider call to verify the key. Raises on failure."""
        env_key, oracle_provider = _PROVIDER_MAP[provider]
        saved_key = os.environ.get(env_key)
        saved_provider = os.environ.get("ORACLE_LLM_PROVIDER")
        os.environ[env_key] = api_key
        os.environ["ORACLE_LLM_PROVIDER"] = oracle_provider
        try:
            from agent.llm.factory import ProviderFactory
            p = ProviderFactory.get_provider()
            p.generate([{"role": "user", "content": "ping"}])
        finally:
            if saved_key is None:
                os.environ.pop(env_key, None)
            else:
                os.environ[env_key] = saved_key
            if saved_provider is None:
                os.environ.pop("ORACLE_LLM_PROVIDER", None)
            else:
                os.environ["ORACLE_LLM_PROVIDER"] = saved_provider

    def _write_config(self, provider: str) -> None:
        from rich import print as rprint
        config_dir = self._output_dir / ".oracle"
        config_dir.mkdir(exist_ok=True)
        config = {
            "provider": provider,
            "configured_at": datetime.now(timezone.utc).isoformat(),
        }
        (config_dir / "config.json").write_text(
            json.dumps(config, indent=2) + "\n"
        )
        rprint(
            "\n[green]✓[/green] Config saved to "
            "[bold].oracle/config.json[/bold]"
        )

    def _run_sample(self, provider: str, api_key: str) -> None:
        from rich import print as rprint
        env_key = _PROVIDER_MAP[provider][0]
        os.environ[env_key] = api_key
        from agent.core.orchestrator import OracleOrchestrator
        result = OracleOrchestrator().run(
            "Generate a sample Playwright test for a login page"
        )
        rprint(
            f"\n[green]✓[/green] Sample written to "
            f"[bold]{result['output_file']}[/bold]"
        )
```

- [ ] **Step 4: Run test to confirm it passes**

```bash
.venv/bin/pytest tests/unit/test_setup.py::TestSetupWizardRun::test_run_writes_config_on_success -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/core/setup.py tests/unit/test_setup.py
git commit -m "feat(onboarding): wizard happy path — provider, key, verify, write config"
```

---

### Task 3: Verify loop on bad key

**Files:**

- Modify: `tests/unit/test_setup.py`

- [ ] **Step 1: Add the loop test**

Add to `TestSetupWizardRun`:

```python
    def test_run_loops_on_bad_key(self):
        # First verify call raises, second succeeds.
        verify_calls = [Exception("Invalid API key"), None]

        def fake_verify(provider, api_key):
            result = verify_calls.pop(0)
            if isinstance(result, Exception):
                raise result

        wizard = SetupWizard(output_dir=self.root)
        with patch("agent.core.setup.Prompt.ask",
                   side_effect=["claude", "bad-key", "good-key"]), \
             patch("agent.core.setup.SetupWizard._test_connection",
                   side_effect=fake_verify), \
             patch("agent.core.setup.Confirm.ask", return_value=True):
            wizard.run()

        config = json.loads(
            (self.root / ".oracle" / "config.json").read_text()
        )
        self.assertEqual(config["provider"], "claude")
```

- [ ] **Step 2: Run test to confirm it passes (no new code needed)**

```bash
.venv/bin/pytest tests/unit/test_setup.py::TestSetupWizardRun::test_run_loops_on_bad_key -v
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/test_setup.py
git commit -m "test(onboarding): verify loops back to key entry on bad key"
```

---

### Task 4: `KeyboardInterrupt` — no partial config written

**Files:**

- Modify: `tests/unit/test_setup.py`

- [ ] **Step 1: Add the interrupt test**

Add to `TestSetupWizardRun`:

```python
    def test_no_partial_config_on_interrupt(self):
        wizard = SetupWizard(output_dir=self.root)
        with patch("agent.core.setup.Prompt.ask",
                   side_effect=KeyboardInterrupt):
            with self.assertRaises(SystemExit):
                wizard.run()

        config_path = self.root / ".oracle" / "config.json"
        self.assertFalse(config_path.exists())
```

- [ ] **Step 2: Run test to confirm it passes**

```bash
.venv/bin/pytest tests/unit/test_setup.py::TestSetupWizardRun::test_no_partial_config_on_interrupt -v
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/test_setup.py
git commit -m "test(onboarding): KeyboardInterrupt leaves no partial config"
```

---

### Task 5: `@app.callback()` — skip when configured or not a TTY

**Files:**

- Modify: `agent/cli.py`
- Modify: `tests/unit/test_setup.py`

- [ ] **Step 1: Add skip tests**

Add to `tests/unit/test_setup.py` after `TestSetupWizardRun`:

```python
from typer.testing import CliRunner
from agent.cli import app

_runner = CliRunner()


class TestAppCallback(unittest.TestCase):

    def test_skips_when_configured(self):
        with patch("agent.core.setup.SetupWizard.is_configured",
                   return_value=True):
            result = _runner.invoke(app, ["version"])
        self.assertNotIn("Oracle isn't configured", result.output)

    def test_skips_when_not_tty(self):
        # CliRunner sets stdin to a non-TTY by default
        with patch("agent.core.setup.SetupWizard.is_configured",
                   return_value=False):
            result = _runner.invoke(app, ["version"])
        self.assertNotIn("Oracle isn't configured", result.output)

    def test_skips_with_no_setup_flag(self):
        with patch("agent.core.setup.SetupWizard.is_configured",
                   return_value=False), \
             patch("sys.stdin.isatty", return_value=True):
            result = _runner.invoke(app, ["--no-setup", "version"])
        self.assertNotIn("Oracle isn't configured", result.output)
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
.venv/bin/pytest tests/unit/test_setup.py::TestAppCallback -v
```

Expected: FAIL — `--no-setup` is an unrecognised option.

- [ ] **Step 3: Add `@app.callback()` to `cli.py`**

Add after `app = typer.Typer()` (line 16) in `agent/cli.py`:

```python
import sys as _sys

@app.callback()
def _pre_command(
    ctx: typer.Context,
    no_setup: bool = typer.Option(
        False, "--no-setup",
        help="Skip the first-run setup check.",
    ),
) -> None:
    """Run the setup wizard if this project has not been configured."""
    if ctx.invoked_subcommand == "setup":
        return
    if no_setup or not _sys.stdin.isatty():
        return
    from agent.core.setup import SetupWizard
    if not SetupWizard.is_configured():
        from rich.prompt import Confirm
        if Confirm.ask(
            "! Oracle isn't configured for this project yet. "
            "Run setup now?",
            default=True,
        ):
            SetupWizard().run()
            print("\n[dim]Continuing with your command…[/dim]\n")
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
.venv/bin/pytest tests/unit/test_setup.py::TestAppCallback -v
```

Expected: 3 passed.

- [ ] **Step 5: Run the full test suite to check for regressions**

```bash
.venv/bin/pytest tests/unit/ -v --tb=short 2>&1 | tail -20
```

Expected: all previously passing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add agent/cli.py tests/unit/test_setup.py
git commit -m "feat(onboarding): app.callback() skips wizard when configured or non-TTY"
```

---

### Task 6: `@app.callback()` — prompt and run when unconfigured TTY

**Files:**

- Modify: `tests/unit/test_setup.py`

- [ ] **Step 1: Add the prompt and resume tests**

Add to `TestAppCallback`:

```python
    def test_prompts_when_unconfigured_tty(self):
        with patch("agent.core.setup.SetupWizard.is_configured",
                   return_value=False), \
             patch("sys.stdin.isatty", return_value=True), \
             patch("agent.core.setup.Confirm.ask", return_value=False) \
             as mock_confirm:
            _runner.invoke(app, ["version"])
        mock_confirm.assert_called_once()
        self.assertIn("Oracle isn't configured", mock_confirm.call_args[0][0])

    def test_runs_wizard_when_user_says_yes(self):
        with patch("agent.core.setup.SetupWizard.is_configured",
                   return_value=False), \
             patch("sys.stdin.isatty", return_value=True), \
             patch("agent.core.setup.Confirm.ask", return_value=True), \
             patch("agent.core.setup.SetupWizard.run") as mock_run:
            _runner.invoke(app, ["version"])
        mock_run.assert_called_once_with()
```

- [ ] **Step 2: Run tests to confirm they pass (no new code needed)**

```bash
.venv/bin/pytest tests/unit/test_setup.py::TestAppCallback -v
```

Expected: 5 passed.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/test_setup.py
git commit -m "test(onboarding): callback prompts and runs wizard on unconfigured TTY"
```

---

### Task 7: Replace `oracle setup` command body

**Files:**

- Modify: `agent/cli.py`
- Modify: `tests/unit/test_setup.py`

- [ ] **Step 1: Add the `oracle setup` test**

Add to `TestAppCallback`:

```python
    def test_setup_command_runs_wizard(self):
        with patch("agent.core.setup.SetupWizard.run") as mock_run:
            result = _runner.invoke(app, ["setup"])
        mock_run.assert_called_once_with(full=False)
        self.assertEqual(result.exit_code, 0)
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
.venv/bin/pytest tests/unit/test_setup.py::TestAppCallback::test_setup_command_runs_wizard -v
```

Expected: FAIL — current `setup()` calls `shutil.which("node")` etc., not `SetupWizard`.

- [ ] **Step 3: Replace the `setup()` body in `agent/cli.py`**

Find the existing `def setup():` function (currently at line ~282) and replace
its entire body:

```python
@app.command()
def setup(
    full: bool = typer.Option(
        False, "--full",
        help="Run a sample generation after setup to preview output.",
    ),
) -> None:
    """
    Configure Oracle for this project: choose a provider and verify your
    API key. Re-run at any time to update the configuration.
    """
    from agent.core.setup import SetupWizard
    SetupWizard().run(full=full)
```

- [ ] **Step 4: Run test to confirm it passes**

```bash
.venv/bin/pytest tests/unit/test_setup.py::TestAppCallback::test_setup_command_runs_wizard -v
```

Expected: PASS.

- [ ] **Step 5: Run the full suite to check for regressions**

```bash
.venv/bin/pytest tests/unit/ -v --tb=short 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add agent/cli.py tests/unit/test_setup.py
git commit -m "feat(onboarding): replace oracle setup with SetupWizard"
```

---

### Task 8: `oracle setup --full` invokes orchestrator

**Files:**

- Modify: `tests/unit/test_setup.py`

- [ ] **Step 1: Add the `--full` test**

Add to `TestSetupWizardRun`:

```python
    def test_setup_full_invokes_orchestrator(self):
        wizard = SetupWizard(output_dir=self.root)
        with patch("agent.core.setup.Prompt.ask",
                   side_effect=["claude", "sk-test"]), \
             patch("agent.core.setup.SetupWizard._test_connection",
                   return_value=None), \
             patch("agent.core.setup.Confirm.ask", return_value=False), \
             patch("agent.core.setup.OracleOrchestrator") as mock_orch:
            mock_orch.return_value.run.return_value = {
                "output_file": "tests/generated/sample.spec.ts"
            }
            wizard.run(full=True)

        mock_orch.return_value.run.assert_called_once()
```

- [ ] **Step 2: Update `_run_sample` to import `OracleOrchestrator` at**
  **module level for patching**

In `agent/core/setup.py`, add to the top of `_run_sample`:

The current implementation already imports `OracleOrchestrator` inside
`_run_sample`. The mock patches `agent.core.setup.OracleOrchestrator`, so
add a top-level import alias so the patch target resolves correctly.

Add near the top of `agent/core/setup.py` (after the existing imports):

```python
from agent.core.orchestrator import OracleOrchestrator
```

Then remove the local import inside `_run_sample`:

```python
    def _run_sample(self, provider: str, api_key: str) -> None:
        from rich import print as rprint
        env_key = _PROVIDER_MAP[provider][0]
        os.environ[env_key] = api_key
        result = OracleOrchestrator().run(
            "Generate a sample Playwright test for a login page"
        )
        rprint(
            f"\n[green]✓[/green] Sample written to "
            f"[bold]{result['output_file']}[/bold]"
        )
```

- [ ] **Step 3: Run test to confirm it passes**

```bash
.venv/bin/pytest tests/unit/test_setup.py::TestSetupWizardRun::test_setup_full_invokes_orchestrator -v
```

Expected: PASS.

- [ ] **Step 4: Run the full suite**

```bash
.venv/bin/pytest tests/unit/ -v --tb=short 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add agent/core/setup.py tests/unit/test_setup.py
git commit -m "test(onboarding): oracle setup --full calls orchestrator after config written"
```

---

### Task 9: Gitignore, markdownlint, and roadmap

**Files:**

- Modify: `.gitignore`
- Modify: `docs/roadmap.md`

- [ ] **Step 1: Add `.oracle/` to `.gitignore`**

Add to `.gitignore` under the `# Oracle artifacts` block:

```text
# User project Oracle config (project-local, no secrets, but personal)
.oracle/
```

- [ ] **Step 2: Run markdownlint across all docs**

```bash
npx --yes markdownlint-cli "**/*.md" --ignore node_modules 2>&1
```

Expected: no errors.

- [ ] **Step 3: Update `docs/roadmap.md` — link plan, update status**

Find the `### Interactive Guided Onboarding` section and update:

```markdown
### Interactive Guided Onboarding

- **Status:** done
- **Spec:** [docs/specs/onboarding.md](specs/onboarding.md)
- **Summary:** First-run guided experience for end users who install Oracle
  via pip. `SetupWizard` in `agent/core/setup.py`; Typer `@app.callback()`
  asks permission before any unconfigured command; `oracle setup` is
  re-runnable with `--full` for a sample generation. Config stored in
  `.oracle/config.json` (project-local, no secrets). 12 unit tests.
- **Blockers:** none
- **Plan:** [docs/plans/onboarding.md](../plans/onboarding.md)
```

- [ ] **Step 4: Commit**

```bash
git add .gitignore docs/roadmap.md docs/plans/onboarding.md
git commit -m "chore(onboarding): gitignore .oracle/, update roadmap to done"
```
