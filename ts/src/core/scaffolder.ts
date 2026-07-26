/**
 * Canary Scaffolder - bootstraps new test suites with Gold Standard configs.
 *
 * Faithful TypeScript port of `agent/core/scaffolder.py`. Provides templates and
 * logic to initialize directory structures and configuration files for the
 * supported testing frameworks.
 *
 * Python->TS nuances:
 *   - The emitted config-file bodies are a **byte-exact contract**: the template
 *     strings reproduce the Python triple-quoted literals character for
 *     character, including the trailing newline. The single non-ASCII glyph the
 *     Python source contains (an em-dash, U+2014, in the wdio comment) is written
 *     as a `\u{2014}` escape so this source stays ASCII while the emitted byte is
 *     identical. Python `open(path, "w")` writes `\n` verbatim on POSIX;
 *     `writeFileSync` does the same.
 *   - `Path(project_root).resolve()` -> `resolve(projectRoot)`;
 *     `Path.exists()` -> `existsSync`; `dir.mkdir(parents=True)` ->
 *     `mkdirSync(p, { recursive: true })`.
 *   - Python truthiness (`""`/`null` falsy) for the degrade path via
 *     {@link pyTruthy}.
 *   - `raise ValueError` -> `throw new Error` (mirrors reporter.ts).
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { FrameworkRegistry } from './framework-registry.js';

// ---------------------------------------------------------------------------
// Python-compatibility helper (copied locally per-module, matching reporter.ts)
// ---------------------------------------------------------------------------

/**
 * Python-truthiness for the values used here: `null`/`undefined`/`""` are falsy
 * (mirrors `if x:`).
 */
function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (value === 0 || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

interface Template {
  files: Record<string, string>;
  dirs: string[];
}

const TEMPLATES: Record<string, Template> = {
  playwright: {
    files: {
      'playwright.config.ts': `import { defineConfig, devices } from '@playwright/test';

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
`,
    },
    dirs: ['tests/e2e'],
  },
  vitest: {
    files: {
      'vitest.config.ts': `import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
  },
});
`,
    },
    dirs: ['tests/unit'],
  },
  pytest: {
    files: {
      'pytest.ini': `[pytest]
testpaths = tests
python_files = test_*.py *_test.py
python_classes = Test*
python_functions = test_*
`,
    },
    dirs: ['tests'],
  },
  k6: {
    files: {
      'k6.config.js': `export const options = {
  vus: 10,
  duration: '30s',
};
`,
    },
    dirs: ['tests/performance'],
  },
  wdio: {
    files: {
      'wdio.conf.ts': `import type { Options } from "@wdio/types";

// Appium + WebdriverIO config. Fill in the capabilities stub below for the
// device/platform under test (Android shown; add an iOS entry as needed).
export const config: Options.Testrunner = {
  runner: "local",
  specs: ["./tests/**/*.spec.ts"],
  maxInstances: 1,
  // Appium capabilities stub \u{2014} replace deviceName / app / versions to match
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
  // Requires the Appium service: \`npm i -D @wdio/appium-service appium\`.
  services: ["appium"],
};
`,
    },
    dirs: ['tests'],
  },
};

/**
 * Handles initialization and scaffolding of test suites.
 *
 * Uses predefined templates to create the necessary boilerplate for frameworks
 * like Playwright, Vitest, Pytest, and k6.
 */
export class Scaffolder {
  /**
   * Create the directory structure and config files for a framework.
   *
   * `framework` is lowercased (matching `FrameworkRegistry.capabilities`).
   * `projectRoot` defaults to the current directory. Returns a summary of the
   * created/skipped files and directories, or a loud-degrade result for a known
   * framework with no template (Python: `scaffold`).
   */
  scaffold(framework: string, projectRoot = '.'): Record<string, unknown> {
    framework = framework.toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(TEMPLATES, framework)) {
      return this.degrade(framework);
    }

    const template = TEMPLATES[framework]!;
    const root = resolve(projectRoot);
    const createdFiles: string[] = [];
    const createdDirs: string[] = [];

    // 1. Create directories.
    for (const d of template.dirs) {
      const dirPath = join(root, d);
      if (!existsSync(dirPath)) {
        mkdirSync(dirPath, { recursive: true });
        createdDirs.push(d);
      }
    }

    // 2. Create files.
    // Byte-for-byte identical to the Python oracle on POSIX/UTF-8. NOTE: Python
    // uses text-mode `open(path, "w")`, so on Windows / a non-UTF-8 locale it
    // would translate LF -> os.linesep (CRLF) and encode in the locale codec.
    // We intentionally write LF + UTF-8 on every platform: deterministic,
    // cross-platform-identical scaffolds beat replicating locale-dependent
    // output, and LF configs run fine on Windows toolchains.
    for (const [name, content] of Object.entries(template.files)) {
      const filePath = join(root, name);
      if (!existsSync(filePath)) {
        writeFileSync(filePath, content, 'utf-8');
        createdFiles.push(name);
      }
    }

    return {
      framework,
      status: 'scaffolded',
      created_files: createdFiles,
      created_dirs: createdDirs,
      skipped_files: Object.keys(template.files).filter(
        (f) => !createdFiles.includes(f),
      ),
    };
  }

  /**
   * No scaffold template for this framework (Python: `_degrade`).
   *
   * A framework canary knows (registry entry) degrades loudly with actionable
   * guidance instead of crashing - the adopter still learns how to run it
   * (#294/#295 fail-loud). A framework canary does *not* know is genuinely
   * invalid input and throws (Python `ValueError`).
   */
  private degrade(framework: string): Record<string, unknown> {
    const entry = new FrameworkRegistry().findByName(framework);
    if (entry === null) {
      throw new Error(
        `Unknown framework: '${framework}'. ` +
          'Run `canary frameworks list` to see supported frameworks.',
      );
    }

    // Python `entry.get("execution_command")` -> null for an absent key.
    const execCmd = entry.execution_command ?? null;
    const runNote = pyTruthy(execCmd)
      ? `canary can run it via: ${execCmd}`
      : 'canary does not yet have a run command for it either';
    const guidance =
      `No scaffold template for '${framework}' yet \u{2014} canary won't create ` +
      `boilerplate for it. Set the suite up manually; ${runNote}. ` +
      'See `canary frameworks list` for capability tiers.';
    return {
      framework,
      status: 'unsupported',
      created_files: [],
      created_dirs: [],
      skipped_files: [],
      guidance,
      execution_command: execCmd,
    };
  }
}

/**
 * Frameworks canary can scaffold - the single source of truth for the
 * `scaffold` capability, derived from the templates that actually exist
 * (Python: `scaffoldable_frameworks`).
 */
export function scaffoldableFrameworks(): Set<string> {
  return new Set(Object.keys(TEMPLATES));
}
