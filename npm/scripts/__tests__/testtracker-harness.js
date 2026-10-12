// Shared harness for the testtracker push tests (not a test file itself).
/**
 * `canary testtracker push --junit <file…>` (#1320): JUnit XML from vitest,
 * `node --test`, Newman and Maestro reaches the same ingest payload the
 * Playwright reporter sends, through the reporter's own payload builder and
 * push. The HTTP push is stubbed; every assertion is on what reaches the wire.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { route } = require('../../dist/router.js');

const FIXTURES = path.join(__dirname, 'fixtures', 'junit');
const fixture = (name) => path.join(FIXTURES, name);
const PUSH_ENV = {
  CANARY_INGEST_URL: 'https://dash.example',
  CANARY_INGEST_TOKEN: 'tok',
  GITHUB_RUN_ID: '42',
  GITHUB_RUN_ATTEMPT: '1',
};

/** A JUnit report written to a temp file, for one-off shapes. */
function tempReport(xml) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-junit-'));
  const file = path.join(dir, 'report.xml');
  fs.writeFileSync(file, xml);
  return file;
}

/** Runs `canary testtracker <args>` through the router with fetch stubbed. */
async function runCli(args, { env = PUSH_ENV, responses = [] } = {}) {
  const requests = [];
  const logs = [];
  let out = '';
  let err = '';
  const realFetch = global.fetch;
  const realLog = console.log;
  global.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ url: String(url), method: init.method ?? 'GET', body });
    const r = responses.shift() ?? {
      status: 200,
      json: {
        id: 7,
        duplicate: false,
        result_count: body?.results?.length ?? 0,
        collected_count: body?.collected?.length ?? null,
      },
    };
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: () => null },
      json: async () => r.json ?? {},
      text: async () => JSON.stringify(r.json ?? ''),
    };
  };
  console.log = (...a) => logs.push(a.join(' '));
  let code;
  try {
    code = await route(['testtracker', ...args], {
      out: { write: (s) => (out += s) },
      err: { write: (s) => (err += s) },
      env,
      retryDelaysMs: [0, 0],
    });
  } finally {
    global.fetch = realFetch;
    console.log = realLog;
  }
  const pushes = requests.filter((r) => r.method === 'POST');
  return {
    code,
    out,
    err,
    logs,
    requests,
    pushes,
    payload: pushes.at(-1)?.body,
  };
}

const push = (files, extra = [], opts) =>
  runCli(
    [
      'push',
      ...files.flatMap((f) => ['--junit', f]),
      '--suite',
      'unit',
      ...extra,
    ],
    opts,
  );
const row = (payload, title) => {
  const found = payload.results.find((r) => r.full_title === title);
  assert.ok(
    found,
    `no row titled "${title}" in ${payload.results.map((r) => r.full_title).join(' | ')}`,
  );
  return found;
};

module.exports = { FIXTURES, PUSH_ENV, fixture, tempReport, runCli, push, row };
