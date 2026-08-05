/**
 * Scaffold templates - the config-file bodies canary writes for each supported
 * framework, and the derived set of frameworks it can scaffold.
 *
 * Extracted from `scaffolder.ts` to break a circular dependency (#543):
 * `framework-registry` needs {@link scaffoldableFrameworks} to answer the
 * scaffold capability question, while `scaffolder` needs the registry to
 * degrade loudly on an unknown framework. With the data here, both depend on a
 * leaf module and neither depends on the other. `scaffolder.ts` re-exports
 * both names, so existing importers (the migrator, the parity suite) are
 * unaffected.
 *
 * The template strings remain a **byte-exact contract** with the Python
 * originals - see the note in `scaffolder.ts`. They were moved by line slice,
 * not retyped, and `core-parity.test.ts` compares TEMPLATES against the golden
 * fixture.
 */

interface Template {
  files: Record<string, string>;
  dirs: string[];
}

// Exported so the migrator port can compute would-create / already-present sets
// in its dry-run path (Python: `from agent.core.scaffolder import TEMPLATES`).
export const TEMPLATES: Record<string, Template> = {
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
 * Frameworks canary can scaffold - the single source of truth for the
 * `scaffold` capability, derived from the templates that actually exist
 * (Python: `scaffoldable_frameworks`).
 */
export function scaffoldableFrameworks(): Set<string> {
  return new Set(Object.keys(TEMPLATES));
}
