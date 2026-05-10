# agent/core/scaffolder.py

import os
from pathlib import Path
from typing import Dict, Any

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
    }
}

class Scaffolder:
    """
    Handles initialization and scaffolding of test suites.
    """

    def scaffold(self, framework: str, project_root: str = ".") -> Dict[str, Any]:
        """
        Creates the directory structure and config files for a framework.
        """
        framework = framework.lower()
        if framework not in TEMPLATES:
            raise ValueError(f"No scaffolding template found for framework: '{framework}'")

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
            "created_files": created_files,
            "created_dirs": created_dirs,
            "skipped_files": [f for f in template.get("files", {}) if f not in created_files]
        }
