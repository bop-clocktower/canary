"""Tester-focused first-run onboarding flow.

Orchestrates: python version check -> provider prompt -> API key prompt ->
no-cost ping -> .env merge -> recommend-only smoke check.

Designed to be called from `oracle env-setup` (agent/cli.py). Each step
surfaces a structured result so CLI layer renders consistently.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, List

from agent.core.env_writer import merge_env
from agent.core.provider_ping import ping

MIN_PYTHON = (3, 10)
PROVIDER_ENV_VAR = {
    "anthropic": "ANTHROPIC_API_KEY",
    "openai":    "OPENAI_API_KEY",
    "codex":     "OPENAI_API_KEY",
    "gemini":    "GEMINI_API_KEY",
    "mock":      None,
}
DEFAULT_PROVIDER = "anthropic"
SUPPORTED_PROVIDERS = ("anthropic", "openai", "codex", "gemini", "mock")


@dataclass(frozen=True)
class EnvSetupResult:
    success: bool
    reason: str = ""
    provider: str = ""
    env_added: List[str] = field(default_factory=list)
    env_preserved: List[str] = field(default_factory=list)
    smoke_ok: bool = False


def _check_python_version() -> bool:
    return sys.version_info[:2] >= MIN_PYTHON


def run_flow(
    repo_root: Path,
    provider_prompt: Callable[[], str],
    api_key_prompt: Callable[[str], str],
    smoke_check: Callable[[], bool],
    logger: Callable[[str], None] = print,
) -> EnvSetupResult:
    """Run the onboarding flow. Returns a structured result.

    All I/O (prompts, smoke check, logging) is injected so the flow is
    testable without touching the terminal or network.
    """
    if not _check_python_version():
        logger(
            f"Python {MIN_PYTHON[0]}.{MIN_PYTHON[1]}+ required "
            f"(found {sys.version_info.major}.{sys.version_info.minor})."
        )
        return EnvSetupResult(success=False, reason="python_version")

    provider = (provider_prompt() or DEFAULT_PROVIDER).lower()
    if provider not in SUPPORTED_PROVIDERS:
        logger(f"Unknown provider '{provider}'. Choose one of: {', '.join(SUPPORTED_PROVIDERS)}.")
        return EnvSetupResult(success=False, reason="bad_provider")

    env_var = PROVIDER_ENV_VAR[provider]
    added: List[str] = []
    preserved: List[str] = []

    if env_var is not None:
        existing_key = os.environ.get(env_var)
        api_key = existing_key or api_key_prompt(env_var)
        if not api_key:
            logger(f"No {env_var} provided. Aborting.")
            return EnvSetupResult(success=False, reason="no_key", provider=provider)

        ok, msg = ping(provider, api_key)
        logger(msg)
        if not ok:
            return EnvSetupResult(success=False, reason="ping_failed", provider=provider)

        env_path = repo_root / ".env"
        merged = merge_env(env_path, {env_var: api_key})
        added = merged["added"]
        preserved = merged["preserved"]
        # #34: merge_env refuses to rewrite a .env containing quoted /
        # multiline values. Surface the reason so the user knows to edit
        # the file by hand.
        if merged.get("skipped"):
            logger(merged.get("reason", "skipped writing to .env"))
        os.environ[env_var] = api_key

    smoke_ok = smoke_check()
    return EnvSetupResult(
        success=smoke_ok,
        reason="" if smoke_ok else "smoke_failed",
        provider=provider,
        env_added=added,
        env_preserved=preserved,
        smoke_ok=smoke_ok,
    )
