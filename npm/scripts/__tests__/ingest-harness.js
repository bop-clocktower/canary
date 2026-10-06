// Shared harness for the ingest reporter tests (not a test file itself).
const reporterModule = require("../../dist/reporters/ingest.js");
const { mapStatus, resolveTestStatus, runStatus, resolveConfig, buildPayload, shouldPush, dedupeByFullTitle, ingestOutcome, retryWaitMs, fitPayload } = reporterModule;
const IngestReporter = reporterModule.default;

// --- reporter harness ---------------------------------------------------------
// Drives the real reporter through Playwright's hooks with fake TestCase/Suite
// objects and a stubbed fetch, so tests assert what reaches the wire, not just
// what a helper returns.

const REPO = "/repo/";

/** A Playwright-shaped TestCase: root > project > file > describe* > test. */
function fakeTest({
  title,
  file = "tests/a.spec.ts",
  describes = [],
  project = "chromium",
  tags = [],
  annotations = [],
  outcome,
  expectedStatus = "passed",
  id,
}) {
  const projectSuite = { type: "project", title: project, project: () => ({ name: project }) };
  const root = { type: "root", title: "" };
  projectSuite.parent = root;
  let parent = { type: "file", title: file, parent: projectSuite };
  for (const d of describes) parent = { type: "describe", title: d, parent };
  const results = [];
  return {
    id: id ?? `${project}:${file}:${describes.join("/")}:${title}`,
    title,
    tags,
    annotations,
    parent,
    location: { file: REPO + file, line: 1, column: 1 },
    expectedStatus,
    results,
    // An explicit `outcome` pins it; otherwise it is derived from the attempts
    // seen so far, as Playwright does, so a fake cannot pair a failed attempt
    // with an outcome Playwright would never report (#1186).
    outcome: () => outcome ?? computeOutcome(results, expectedStatus),
    titlePath: () => ["", project, file, ...describes, title],
  };
}

/** Mirrors Playwright's computeTestCaseOutcome, which backs `test.outcome()`. */
function computeOutcome(results, expectedStatus) {
  // Interrupted attempts are ignored; a skip only counts when one was expected.
  const statuses = results.map((r) => r.status).filter((s) => s !== "interrupted");
  const ran = statuses.filter((s) => s !== "skipped");
  const expected = ran.filter((s) => s === expectedStatus).length;
  const unexpected = ran.length - expected;
  const skipped = expectedStatus === "skipped" ? statuses.length - ran.length : 0;
  if (ran.length === 0) return "skipped";
  if (unexpected === 0) return "expected";
  if (expected === 0 && skipped === 0) return "unexpected";
  return "flaky";
}

function fakeResult(status, extra = {}) {
  return { status, duration: 12, retry: 0, errors: [], ...extra };
}

/**
 * Runs one reporter lifecycle and returns every request it made and every line
 * it logged. `responses` is consumed in order per request; the default answer
 * is a fresh ingest that stored exactly what was sent.
 */
async function runReporter({
  options = {},
  config = { shard: null, projects: [] },
  collected,
  tests = [],
  fullResult = { status: "passed", startTime: new Date("2026-10-05T00:00:00Z"), duration: 60000 },
  responses = [],
  onRequest = () => {},
  whoami = { status: 200, json: { tenant: { slug: "acme", displayName: "Acme" }, token: { name: "ci", scopes: ["ingest:runs"] } } },
  env = {},
} = {}) {
  const requests = [];
  const logs = [];
  const realFetch = global.fetch;
  const realLog = console.log;
  const saved = {};
  const allEnv = { CANARY_INGEST_PUSH: "true", ...env };
  for (const k of Object.keys(allEnv)) {
    saved[k] = process.env[k];
    process.env[k] = allEnv[k];
  }
  global.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ url, method: init.method ?? "GET", body });
    onRequest(init);
    const isWhoami = String(url).endsWith("/api/ingest/whoami");
    const r = (isWhoami ? whoami : responses.shift()) ?? {
      status: 200,
      json: { id: 1, duplicate: false, result_count: body?.results?.length ?? 0, collected_count: body?.collected?.length ?? null },
    };
    if (r.throws) throw new Error(r.throws);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (h) => (r.headers ?? {})[h.toLowerCase()] ?? null },
      json: async () => r.json ?? {},
      text: async () => JSON.stringify(r.json ?? ""),
    };
  };
  console.log = (...args) => logs.push(args.join(" "));
  try {
    const reporter = new IngestReporter({ suite: "web", url: "https://dash.example", token: "tok", testFilePrefix: REPO, retryDelaysMs: [0, 0], ...options }); // default count (3 attempts), no waiting
    const all = collected ?? tests.map(([t]) => t);
    const projects = [...new Set(all.map((t) => t.titlePath()[1]))];
    const suite = { allTests: () => all, suites: projects.map((title) => ({ type: "project", title })) };
    reporter.onBegin(config, suite);
    for (const [t, r] of tests) {
      t.results?.push(r); // Playwright appends the attempt before onTestEnd
      reporter.onTestEnd(t, r);
    }
    await reporter.onEnd(fullResult);
  } finally {
    global.fetch = realFetch;
    console.log = realLog;
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
  const pushes = requests.filter((r) => r.method === "POST");
  return { requests, pushes, payload: pushes.at(-1)?.body, logs };
}

const CI_ENV = { GITHUB_RUN_ID: "42", GITHUB_RUN_ATTEMPT: "1" };
const T = { startedAt: "2026-10-05T00:00:00Z", finishedAt: "2026-10-05T00:01:00Z" };

module.exports = { reporterModule, IngestReporter, fakeTest, fakeResult, runReporter, REPO, CI_ENV, T };
