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

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The `playwright test` file argument that selects exactly one spec. The CLI
 * reads a file argument as a regular expression over the spec's path, so the
 * file name is escaped and anchored at a path separator and at the end: a
 * flow `a` never also runs flow `xa`'s scenario (#608 P4).
 * @param {string} spec the spec file's path
 */
export function specFilter(spec) {
  const name = spec.split(/[\\/]/).pop();
  return `[\\\\/]${escapeRegex(name)}$`;
}

/**
 * Run `playwright test -c <config> [spec]`; resolves with its exit code and
 * the last 20 stderr lines (shown when it leaves no report).
 * @param {{cli: string, config: string, cwd: string,
 *   env: Record<string, string | undefined>, spec?: string}} run `spec` is
 *   a file argument (specFilter) selecting the one scenario to run
 */
export function runPlaywright({ cli, config, cwd, env, spec }) {
  const args = [cli, 'test', '-c', config, ...(spec ? [spec] : [])];
  return new Promise((done) => {
    const child = spawn(process.execPath, args, {
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
