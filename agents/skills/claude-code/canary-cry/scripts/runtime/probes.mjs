// canary-cry runtime: state probes (#608 P3; spec "Inputs", "Failure modes").
// Copied into run dirs; node:child_process is its only import.
//
// An `http` probe goes through Playwright's APIRequestContext, so it carries
// the observer's session and can only reach the target's baseURL (its path
// starts with '/'). A `shell` probe is an argv array run with execFile, never
// a shell string, so a template value is never interpolated by a shell.
//
// Every way a probe can fail -- a non-2xx status, a timeout, a non-zero exit,
// an absent jsonPath -- is an error the verdict turns into
// `abstain: probe-failed@<invariant>`, never a quiet clean (SC21).

import { execFile } from 'node:child_process';

const PROBE_TIMEOUT_MS = 30_000;
const SEGMENT = /^(?:\.([A-Za-z_$][\w$-]*)|\[(\d+)\]|\["([^"]*)"\])/;

/**
 * A small JSONPath: `$`, `.name`, `[0]`, `["key"]`; `.length` of an array or a
 * string is its length.
 * @returns {{found: boolean, value?: unknown}}
 */
export function jsonPath(doc, path) {
  let rest = path.slice(1);
  let at = { found: true, value: doc };
  while (rest.length && at.found) {
    const m = SEGMENT.exec(rest);
    if (m === null) return { found: false };
    at = member(at.value, m[2] === undefined ? m[1] || m[3] : Number(m[2]));
    rest = rest.slice(m[0].length);
  }
  return at;
}

function member(value, key) {
  const sized = typeof value === 'string' || Array.isArray(value);
  if (key === 'length' && sized) return { found: true, value: value.length };
  if (value === null || typeof value !== 'object' || !(key in value)) {
    return { found: false };
  }
  return { found: true, value: value[key] };
}

/** A body or stdout as JSON when it parses, else the trimmed text. */
function parsed(text) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

async function httpProbe(http, request, resolve) {
  const res = await request.fetch(resolve(http.path), {
    method: http.method,
    timeout: PROBE_TIMEOUT_MS,
    failOnStatusCode: false,
  });
  if (!res.ok()) throw new Error(`HTTP ${res.status()}`);
  return parsed(await res.text());
}

function shellProbe(shell, resolve) {
  const [file, ...args] = shell.argv.map(resolve);
  return new Promise((done, fail) => {
    execFile(file, args, { timeout: PROBE_TIMEOUT_MS }, (err, stdout) => {
      if (err) {
        const why = err.killed ? 'timed out' : `exit ${err.code}`;
        fail(new Error(`shell ${why}`));
      } else done(parsed(stdout));
    });
  });
}

/**
 * Read one invariant's value: `{value}` or `{error}`, never a throw.
 * @param {{probe: object, expect: {jsonPath?: string, delta?: number,
 *   equals?: unknown}}} invariant
 * @param {object} request a Playwright APIRequestContext
 * @param {(text: string) => string} resolve template resolution
 */
export async function readProbe(invariant, request, resolve) {
  const { probe, expect } = invariant;
  try {
    const raw = probe.http
      ? await httpProbe(probe.http, request, resolve)
      : await shellProbe(probe.shell, resolve);
    if (expect.jsonPath === undefined) return { value: raw };
    const hit = jsonPath(raw, expect.jsonPath);
    return hit.found
      ? { value: hit.value }
      : { error: `jsonPath ${expect.jsonPath} is absent` };
  } catch (exc) {
    return { error: exc.message };
  }
}
