// canary-cry: the target project's Playwright, and the one target request
// made outside it (#608 P3; spec D2, "Failure modes").
//
// canary-cry adds no runtime dependency (D2). The generated specs are run by
// the TARGET's `@playwright/test`, resolved from the run dir exactly as the
// specs' own `import '@playwright/test'` resolves, and its CLI is launched
// with this Node -- the `npx playwright test` of the spec, minus any chance
// of npx fetching a package the project does not have.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const PREFLIGHT_TIMEOUT_MS = 10_000;
const STDERR_TAIL = 20;

/**
 * The target's Playwright CLI, or null when `@playwright/test` does not
 * resolve from `dir` (the run then reports ABSTAINED).
 */
export function resolvePlaywright(dir) {
  try {
    return createRequire(`${dir}/noop.js`).resolve('@playwright/test/cli');
  } catch {
    return null;
  }
}

/**
 * `GET baseURL` once, after confirm and before any scenario. A network error
 * or a 5xx is unreachable; any other status means something answered.
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
export async function preflight(baseURL, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(baseURL, {
      redirect: 'manual',
      signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
    });
    const detail = `HTTP ${res.status}`;
    return { ok: res.status < 500, detail };
  } catch (exc) {
    return { ok: false, detail: exc.cause?.code ?? exc.message };
  }
}

/**
 * Run `playwright test -c <config>`; resolves with its exit code and the
 * last 20 stderr lines (shown when it leaves no results.json).
 * @param {{cli: string, config: string, cwd: string,
 *   env: Record<string, string | undefined>}} run
 */
export function runPlaywright({ cli, config, cwd, env }) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [cli, 'test', '-c', config], {
      cwd,
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const finish = (code) => {
      const lines = stderr.split('\n').filter((l) => l.trim() !== '');
      done({ code, stderr: lines.slice(-STDERR_TAIL) });
    };
    child.on('error', (err) => {
      stderr += `\n${err.message}`;
      finish(null);
    });
    child.on('close', finish);
  });
}
