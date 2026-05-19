# agent/core/setup.py
"""Interactive setup wizard for first-run Oracle configuration."""

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from rich.prompt import Confirm, Prompt

from agent.core.orchestrator import OracleOrchestrator

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
        env_key, oracle_provider = _PROVIDER_MAP[provider]
        saved_key = os.environ.get(env_key)
        saved_provider = os.environ.get("ORACLE_LLM_PROVIDER")
        os.environ[env_key] = api_key
        os.environ["ORACLE_LLM_PROVIDER"] = oracle_provider
        try:
            result = OracleOrchestrator().run(
                "Generate a sample Playwright test for a login page"
            )
            rprint(
                f"\n[green]✓[/green] Sample written to "
                f"[bold]{result['output_file']}[/bold]"
            )
        finally:
            if saved_key is None:
                os.environ.pop(env_key, None)
            else:
                os.environ[env_key] = saved_key
            if saved_provider is None:
                os.environ.pop("ORACLE_LLM_PROVIDER", None)
            else:
                os.environ["ORACLE_LLM_PROVIDER"] = saved_provider
