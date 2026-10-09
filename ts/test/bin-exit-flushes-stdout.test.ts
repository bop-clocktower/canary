/**
 * bug-fleet A1: `bin/canary.js` maps a CliExitError to `process.exit(code)`.
 * Where stdout is an asynchronous pipe (macOS, Windows), `process.exit` ends
 * the process before queued writes drain, so a large `--json` payload from a
 * command that exits non-zero is cut off at the pipe buffer. The same pattern
 * was fixed for the skill CLIs in #791; the main entry point still has it.
 *
 * The reader starts draining only after a short delay, which is what a slow
 * consumer (`| jq`, an orchestrator) looks like to the writer.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { mkTmp, rmTmp } from './canary-cli-testkit.js';

const BIN = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'bin',
  'canary.js',
);

function runSlowReader(
  args: string[],
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    child.stdout.pause();
    setTimeout(() => {
      child.stdout.on('data', (c: Buffer) => chunks.push(c));
      child.stdout.resume();
    }, 500);
    child.on('close', (code) =>
      resolvePromise({ code, stdout: Buffer.concat(chunks).toString('utf-8') }),
    );
  });
}

describe('canary bin: a non-zero exit does not truncate piped --json', () => {
  it('delivers the whole flake-check --json payload to a slow pipe reader', async () => {
    const dir = mkTmp();
    try {
      const tests = join(dir, 'tests');
      mkdirSync(tests, { recursive: true });
      for (let i = 0; i < 400; i++) {
        writeFileSync(
          join(tests, `t${i}.spec.ts`),
          `import { test } from '@playwright/test';\ntest('t${i}', async ({ page }) => {\n  await page.waitForTimeout(1000);\n});\n`,
          'utf-8',
        );
      }
      const res = await runSlowReader(['flake-check', tests, '--json']);
      expect(() => JSON.parse(res.stdout)).not.toThrow();
    } finally {
      rmTmp(dir);
    }
  }, 60_000);
});
