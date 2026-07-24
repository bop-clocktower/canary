# agent/core/scaffolder.py

"""
Canary Scaffolder - Bootstraps new test suites with Gold Standard configurations.

This module provides templates and logic to initialize directory structures
and configuration files for supported testing frameworks.
"""

from pathlib import Path
from typing import Any, Dict, Set

TEMPLATES = {
    "playwright": {
        "files": {
            "playwright.config.ts": """import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
"""
        },
        "dirs": ["tests/e2e"]
    },
    "vitest": {
        "files": {
            "vitest.config.ts": """import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
  },
});
"""
        },
        "dirs": ["tests/unit"]
    },
    "pytest": {
        "files": {
            "pytest.ini": """[pytest]
testpaths = tests
python_files = test_*.py *_test.py
python_classes = Test*
python_functions = test_*
"""
        },
        "dirs": ["tests"]
    },
    "k6": {
        "files": {
            "k6.config.js": """export const options = {
  vus: 10,
  duration: '30s',
};
"""
        },
        "dirs": ["tests/performance"]
    },
    "wdio": {
        "files": {
            "wdio.conf.ts": """import type { Options } from "@wdio/types";

// Appium + WebdriverIO config. Fill in the capabilities stub below for the
// device/platform under test (Android shown; add an iOS entry as needed).
export const config: Options.Testrunner = {
  runner: "local",
  specs: ["./tests/**/*.spec.ts"],
  maxInstances: 1,
  // Appium capabilities stub — replace deviceName / app / versions to match
  // your emulator or real device.
  capabilities: [
    {
      platformName: "Android",
      "appium:automationName": "UiAutomator2",
      "appium:deviceName": "Android Emulator",
      "appium:app": "./app/build/outputs/apk/debug/app-debug.apk",
    },
  ],
  framework: "mocha",
  mochaOpts: {
    ui: "bdd",
    timeout: 60000,
  },
  reporters: ["spec"],
  // Requires the Appium service: `npm i -D @wdio/appium-service appium`.
  services: ["appium"],
};
"""
        },
        "dirs": ["tests"]
    }
}

class Scaffolder:
    """
    Handles initialization and scaffolding of test suites.

    This class uses predefined templates to create the necessary boilerplate
    for frameworks like Playwright, Vitest, Pytest, and k6.
    """

    def scaffold(self, framework: str, project_root: str = ".") -> Dict[str, Any]:
        """
        Creates the directory structure and config files for a framework.

        Args:
            framework: The framework to scaffold (e.g., 'playwright').
            project_root: The directory where scaffolding should occur.
                Defaults to the current directory.

        Returns:
            A dictionary summarizing created and skipped files/directories.
        """
        framework = framework.lower()
        if framework not in TEMPLATES:
            return self._degrade(framework)

        template = TEMPLATES[framework]
        root = Path(project_root).resolve()
        created_files = []
        created_dirs = []

        # 1. Create directories
        for d in template.get("dirs", []):
            dir_path = root / d
            if not dir_path.exists():
                dir_path.mkdir(parents=True, exist_ok=True)
                created_dirs.append(str(d))

        # 2. Create files
        for name, content in template.get("files", {}).items():
            file_path = root / name
            if not file_path.exists():
                with open(file_path, "w") as f:
                    f.write(content)
                created_files.append(str(name))

        return {
            "framework": framework,
            "status": "scaffolded",
            "created_files": created_files,
            "created_dirs": created_dirs,
            "skipped_files": [f for f in template.get("files", {}) if f not in created_files]
        }

    def _degrade(self, framework: str) -> Dict[str, Any]:
        """No scaffold template for this framework.

        A framework canary knows (registry entry) degrades loudly with
        actionable guidance instead of crashing — the adopter still learns how
        to run it (#294/#295 fail-loud). A framework canary does *not* know is
        genuinely invalid input and raises ``ValueError``.
        """
        from agent.core.framework_registry import FrameworkRegistry

        entry = FrameworkRegistry().find_by_name(framework)
        if entry is None:
            raise ValueError(
                f"Unknown framework: '{framework}'. "
                "Run `canary frameworks list` to see supported frameworks."
            )

        exec_cmd = entry.get("execution_command")
        run_note = (
            f"canary can run it via: {exec_cmd}"
            if exec_cmd
            else "canary does not yet have a run command for it either"
        )
        guidance = (
            f"No scaffold template for '{framework}' yet — canary won't create "
            f"boilerplate for it. Set the suite up manually; {run_note}. "
            "See `canary frameworks list` for capability tiers."
        )
        return {
            "framework": framework,
            "status": "unsupported",
            "created_files": [],
            "created_dirs": [],
            "skipped_files": [],
            "guidance": guidance,
            "execution_command": exec_cmd,
        }


def scaffoldable_frameworks() -> Set[str]:
    """Frameworks canary can scaffold — the single source of truth for the
    ``scaffold`` capability, derived from the templates that actually exist.
    """
    return set(TEMPLATES)
