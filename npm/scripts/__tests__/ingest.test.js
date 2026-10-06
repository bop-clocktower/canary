const test = require("node:test");
const assert = require("node:assert/strict");
const reporterModule = require("../../dist/reporters/ingest.js");
const { mapStatus, resolveTestStatus, runStatus, resolveConfig, buildPayload, shouldPush, dedupeByFullTitle, ingestOutcome } = reporterModule;
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
  outcome = "expected",
  id,
}) {
  const projectSuite = { type: "project", title: project, project: () => ({ name: project }) };
  const root = { type: "root", title: "" };
  projectSuite.parent = root;
  let parent = { type: "file", title: file, parent: projectSuite };
  for (const d of describes) parent = { type: "describe", title: d, parent };
  return {
    id: id ?? `${project}:${file}:${describes.join("/")}:${title}`,
    title,
    tags,
    annotations,
    parent,
    location: { file: REPO + file, line: 1, column: 1 },
    outcome: () => outcome,
    titlePath: () => ["", project, file, ...describes, title],
  };
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
    const suite = { allTests: () => collected ?? tests.map(([t]) => t) };
    reporter.onBegin(config, suite);
    for (const [t, r] of tests) reporter.onTestEnd(t, r);
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

test("mapStatus maps PW statuses onto the ingest result enum", () => {
  assert.equal(mapStatus("passed"), "passed");
  assert.equal(mapStatus("failed"), "failed");
  assert.equal(mapStatus("flaky"), "flaky");
  assert.equal(mapStatus("skipped"), "skipped");
});

// --- #1149: timedOut and interrupted must not lose their meaning --------------
// The ingest result enum is passed|failed|flaky|skipped|timed_out. A timeout is
// often an environment signal, so it keeps its own status. `interrupted` has no
// ingest status, and sending one would reject the whole run; it must also not
// become `skipped`, which drops the test out of the pass-rate denominator and
// makes a cut-short run look clean. It is sent as `failed`, tagged and explained.

test("mapStatus keeps timedOut distinct and never maps interrupted to skipped", () => {
  assert.equal(mapStatus("timedOut"), "timed_out");
  assert.equal(mapStatus("interrupted"), "failed");
});

test("resolveTestStatus passes a timed-out last attempt through as timed_out", () => {
  assert.equal(resolveTestStatus("unexpected", "timedOut"), "timed_out");
});

test("an interrupted test reaches the wire as failed, tagged and explained", async () => {
  const t = fakeTest({ title: "checkout", outcome: "unexpected" });
  const { payload } = await runReporter({
    tests: [[t, fakeResult("interrupted")]],
    fullResult: { status: "interrupted", startTime: new Date("2026-10-05T00:00:00Z"), duration: 1000 },
  });
  const row = payload.results[0];
  assert.equal(row.status, "failed");
  assert.ok(row.tags.includes("interrupted"));
  assert.match(row.error_message, /^interrupted: /);
  assert.equal(payload.totals.skipped, 0, "an interrupted test must not hide as a skip");
  assert.equal(payload.status, "cancelled");
});

test("a timed-out test reaches the wire as timed_out", async () => {
  const t = fakeTest({ title: "slow", outcome: "unexpected" });
  const { payload } = await runReporter({ tests: [[t, fakeResult("timedOut")]] });
  assert.equal(payload.results[0].status, "timed_out");
  assert.equal(payload.totals.failed, 1);
});

test("resolveConfig requires a suite", () => {
  assert.throws(() => resolveConfig({}, {}), /suite/);
  const c = resolveConfig({ suite: "x" }, {});
  assert.equal(c.suite, "x");
});

test("shouldPush gates on url+token and (CI or force)", () => {
  const base = { url: "u", token: "t" };
  assert.equal(shouldPush(base, { CI: "true" }), true);
  assert.equal(shouldPush(base, {}), false);
  assert.equal(shouldPush(base, { TESTTRACKER_PUSH: "true" }), true);
  assert.equal(shouldPush({ url: "", token: "t" }, { CI: "true" }), false);
});

test("buildPayload computes totals + stable run id", () => {
  const cfg = resolveConfig({ suite: "consumer-b-api" }, {});
  const results = [
    { full_title: "a", test_file: "a.spec.ts", status: "passed", retries: 0, tags: [] },
    { full_title: "b", test_file: "b.spec.ts", status: "failed", retries: 1, tags: ["smoke"] },
  ];
  const p = buildPayload(results, cfg, { startedAt: "2026-07-24T00:00:00Z", finishedAt: "2026-07-24T00:01:00Z" }, { GITHUB_RUN_ID: "42", GITHUB_RUN_ATTEMPT: "1" });
  assert.equal(p.suite, "consumer-b-api");
  assert.equal(p.canary_run_id, "42-1");
  assert.equal(p.status, "failed");
  assert.deepEqual(p.totals, { passed: 1, failed: 1, flaky: 0, skipped: 0, total: 2 });
  assert.equal(p.results.length, 2);
});

test("shouldPush is false without url or token", () => {
  assert.equal(shouldPush({ url: "u", token: "" }, { CI: "true" }), false);
  assert.equal(shouldPush({ url: "", token: "" }, { TESTTRACKER_PUSH: "true" }), false);
});

test("canary_run_id falls back to a local id when GITHUB_RUN_ID absent", () => {
  const cfg = resolveConfig({ suite: "s" }, {});
  const timing = { startedAt: "2026-07-24T00:00:00Z", finishedAt: "2026-07-24T00:00:01Z" };
  const withSha = buildPayload([], cfg, timing, { GITHUB_SHA: "abcdef1234567" });
  assert.match(withSha.canary_run_id, /^abcdef1-/);
  const local = buildPayload([], cfg, timing, {});
  assert.match(local.canary_run_id, /^local-/);
});

test("resolveConfig default testFilePrefix is <cwd>/", () => {
  const c = resolveConfig({ suite: "s" }, {});
  assert.equal(c.testFilePrefix, `${process.cwd()}/`);
});

test("a timed_out result is sent as timed_out but counted in the failed bucket", () => {
  // The ingest totals have no timed_out bucket; counting it as failed keeps
  // totals.total equal to the sum of the buckets and fails the run.
  const cfg = resolveConfig({ suite: "s" }, {});
  const results = [
    { full_title: "t", test_file: "t.spec.ts", status: mapStatus("timedOut"), retries: 0, tags: [] },
  ];
  const p = buildPayload(results, cfg, { startedAt: "x", finishedAt: "y" }, {});
  assert.equal(p.results[0].status, "timed_out");
  assert.equal(p.totals.failed, 1);
  assert.equal(p.totals.total, 1);
  assert.equal(p.status, "failed");
});

test("dedupeByFullTitle never lets a passing copy hide a timed_out one", () => {
  const out = dedupeByFullTitle([
    { full_title: "t", test_file: "t.spec.ts", status: "timed_out", retries: 0, tags: [] },
    { full_title: "t", test_file: "t.spec.ts", status: "passed", retries: 0, tags: [] },
  ]);
  assert.equal(out[0].status, "timed_out");
});

test("resolveTestStatus reports a recovered flake as flaky, else the attempt status", () => {
  // outcome 'flaky' wins even though the last attempt passed
  assert.equal(resolveTestStatus("flaky", "passed"), "flaky");
  // non-flaky outcomes fall through to the last-attempt mapping
  assert.equal(resolveTestStatus("expected", "passed"), "passed");
  assert.equal(resolveTestStatus("unexpected", "failed"), "failed");
  assert.equal(resolveTestStatus("skipped", "skipped"), "skipped");
});

test("runStatus folds Playwright's FullResult status so an aborted run isn't green", () => {
  // A globally interrupted / timed-out run did not complete → never "passed".
  assert.equal(runStatus({ failed: 0, flaky: 0 }, "interrupted"), "cancelled");
  assert.equal(runStatus({ failed: 0, flaky: 0 }, "timedout"), "failed");
  assert.equal(runStatus({ failed: 0, flaky: 0 }, "failed"), "failed");
  // "passed"/undefined → trust the buckets.
  assert.equal(runStatus({ failed: 0, flaky: 0 }, "passed"), "passed");
  assert.equal(runStatus({ failed: 0, flaky: 1 }, "passed"), "flaky");
  assert.equal(runStatus({ failed: 2, flaky: 0 }, undefined), "failed");
});

test("buildPayload with a timed-out run reports failed even when buckets look green", () => {
  const cfg = resolveConfig({ suite: "s" }, {});
  const results = [
    { full_title: "a", test_file: "a.spec.ts", status: "passed", retries: 0, tags: [] },
  ];
  const p = buildPayload(results, cfg, { startedAt: "x", finishedAt: "y" }, {}, "timedout");
  assert.equal(p.totals.passed, 1);
  assert.equal(p.totals.failed, 0);
  assert.equal(p.status, "failed"); // FullResult.status wins over the buckets
});

test("a recovered flake is flaky per-test but does NOT fail the run", () => {
  const cfg = resolveConfig({ suite: "s" }, {});
  const results = [
    { full_title: "a", test_file: "a.spec.ts", status: "passed", retries: 0, tags: [] },
    { full_title: "b", test_file: "b.spec.ts", status: "flaky", retries: 1, tags: [] },
  ];
  const p = buildPayload(results, cfg, { startedAt: "x", finishedAt: "y" }, {});
  assert.equal(p.totals.flaky, 1);
  assert.equal(p.totals.failed, 0);
  // no hard failure → run is NOT "failed" (management sees a good run); the
  // flaky count carries the SDET signal.
  assert.equal(p.status, "flaky");
});

// --- duplicate full_title (canary#599) -------------------------------------
// A Playwright `dependencies:` setup project runs in full in EVERY shard, so a
// merge-reports payload over a sharded matrix carries the same setup title once
// per shard. TestTracker's ingest holds a unique index on
// (run_id, full_title) and rejects the WHOLE run on a collision — one
// consumer's sharded suite never ingested a single nightly because of this.

test("dedupeByFullTitle collapses repeated titles, worst status wins", () => {
  const out = dedupeByFullTitle([
    { full_title: "setup > auth.setup.ts > authenticate", test_file: "auth.setup.ts", status: "passed", duration_ms: 900, retries: 0, tags: ["setup"] },
    { full_title: "setup > auth.setup.ts > authenticate", test_file: "auth.setup.ts", status: "failed", duration_ms: 1500, retries: 2, tags: ["setup", "auth"], error_message: "boom", error_stack: "at x" },
    { full_title: "chromium > a.spec.ts > a", test_file: "a.spec.ts", status: "passed", duration_ms: 10, retries: 0, tags: [] },
  ]);
  assert.equal(out.length, 2);
  const setup = out.find((r) => r.full_title.startsWith("setup"));
  assert.equal(setup.status, "failed"); // worst wins — never look healthier than the parts
  assert.equal(setup.duration_ms, 1500); // max, not last-seen
  assert.equal(setup.retries, 2);
  assert.equal(setup.error_message, "boom"); // the SDET still sees why it failed
  assert.equal(setup.error_stack, "at x");
  assert.deepEqual(setup.tags, ["setup", "auth"]); // union, deduped
});

test("dedupeByFullTitle keeps the FIRST real error when both attempts errored", () => {
  const out = dedupeByFullTitle([
    { full_title: "t", test_file: "t.spec.ts", status: "failed", retries: 0, tags: [], error_message: "first", error_stack: "s1" },
    { full_title: "t", test_file: "t.spec.ts", status: "failed", retries: 0, tags: [], error_message: "second", error_stack: "s2" },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].error_message, "first");
  assert.equal(out[0].error_stack, "s1");
});

test("dedupeByFullTitle leaves duration undefined when no entry had one", () => {
  const out = dedupeByFullTitle([
    { full_title: "t", test_file: "t.spec.ts", status: "passed", retries: 0, tags: [] },
    { full_title: "t", test_file: "t.spec.ts", status: "passed", retries: 0, tags: [] },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].duration_ms, undefined);
});

test("dedupeByFullTitle is a no-op on already-unique results", () => {
  const rows = [
    { full_title: "a", test_file: "a.spec.ts", status: "passed", retries: 0, tags: [] },
    { full_title: "b", test_file: "b.spec.ts", status: "failed", retries: 1, tags: [] },
  ];
  assert.deepEqual(dedupeByFullTitle(rows), rows);
});

test("buildPayload dedupes, and totals agree with the rows actually sent", () => {
  const cfg = resolveConfig({ suite: "acme-web" }, {});
  // The real consumer shape: two chromium shards each ran the setup project.
  const results = [
    { full_title: "setup > auth.setup.ts > authenticate", test_file: "auth.setup.ts", status: "passed", retries: 0, tags: [] },
    { full_title: "setup > auth.setup.ts > authenticate", test_file: "auth.setup.ts", status: "passed", retries: 0, tags: [] },
    { full_title: "chromium > a.spec.ts > a", test_file: "a.spec.ts", status: "passed", retries: 0, tags: [] },
  ];
  const p = buildPayload(results, cfg, { startedAt: "x", finishedAt: "y" }, {});
  const titles = p.results.map((r) => r.full_title);
  assert.equal(new Set(titles).size, titles.length, "payload must not carry duplicate full_title");
  assert.equal(p.results.length, 2);
  assert.equal(p.totals.total, 2);
  assert.equal(p.totals.passed, 2);
  assert.equal(p.status, "passed");
});

test("a duplicated title that failed in one shard fails the run", () => {
  const cfg = resolveConfig({ suite: "s" }, {});
  const p = buildPayload(
    [
      { full_title: "setup > authenticate", test_file: "auth.setup.ts", status: "passed", retries: 0, tags: [] },
      { full_title: "setup > authenticate", test_file: "auth.setup.ts", status: "failed", retries: 0, tags: [] },
    ],
    cfg,
    { startedAt: "x", finishedAt: "y" },
    {},
  );
  assert.equal(p.totals.total, 1);
  assert.equal(p.totals.failed, 1);
  assert.equal(p.totals.passed, 0); // the passing shard must not mask the failure
  assert.equal(p.status, "failed");
});

// --- rename: TestTracker → ingest reporter ----------------------------------
// The reporter used to read TESTTRACKER_* env vars. Consumer CI still sets them,
// so the old names keep working for one release and are reported as deprecated.

test("resolveConfig reads CANARY_INGEST_* env vars", () => {
  const c = resolveConfig({}, {
    CANARY_INGEST_SUITE: "s",
    CANARY_INGEST_URL: "https://ingest.example",
    CANARY_INGEST_TOKEN: "tok",
    CANARY_INGEST_ENVIRONMENT: "stage",
    CANARY_INGEST_WORKFLOW: "wf",
    CANARY_INGEST_TEST_FILE_PREFIX: "/repo/",
  });
  assert.deepEqual(
    [c.suite, c.url, c.token, c.environment, c.workflow, c.testFilePrefix],
    ["s", "https://ingest.example", "tok", "stage", "wf", "/repo/"],
  );
  assert.deepEqual(c.deprecatedEnv, []);
});

test("legacy TESTTRACKER_* env vars still work and are reported as deprecated", () => {
  const c = resolveConfig({}, { TESTTRACKER_SUITE: "old", TESTTRACKER_API_TOKEN: "t" });
  assert.equal(c.suite, "old");
  assert.equal(c.token, "t");
  assert.deepEqual(c.deprecatedEnv.sort(), ["TESTTRACKER_API_TOKEN", "TESTTRACKER_SUITE"]);
});

test("a CANARY_INGEST_* var wins over its legacy alias", () => {
  const c = resolveConfig({}, { CANARY_INGEST_SUITE: "new", TESTTRACKER_SUITE: "old" });
  assert.equal(c.suite, "new");
  assert.deepEqual(c.deprecatedEnv, []);
});

test("shouldPush honours CANARY_INGEST_PUSH and the legacy TESTTRACKER_PUSH", () => {
  const base = { url: "u", token: "t" };
  assert.equal(shouldPush(base, { CANARY_INGEST_PUSH: "true" }), true);
  assert.equal(shouldPush(base, { TESTTRACKER_PUSH: "true" }), true);
});

// --- #1148: sharded pushes must not collide on canary_run_id ------------------
// Ingest is idempotent on (canary_run_id, suite). Every shard of one workflow
// run shares GITHUB_RUN_ID/ATTEMPT, so without a shard discriminator the first
// shard wins and every later shard's results are discarded as a "duplicate".

const CI_ENV = { GITHUB_RUN_ID: "42", GITHUB_RUN_ATTEMPT: "1" };
const T = { startedAt: "2026-10-05T00:00:00Z", finishedAt: "2026-10-05T00:01:00Z" };

test("two shards of one workflow run get distinct canary_run_id values", () => {
  const cfg = resolveConfig({ suite: "web" }, {});
  const s1 = buildPayload([], cfg, T, CI_ENV, "passed", { shard: { current: 1, total: 4 } });
  const s2 = buildPayload([], cfg, T, CI_ENV, "passed", { shard: { current: 2, total: 4 } });
  assert.equal(s1.canary_run_id, "42-1-s1of4");
  assert.equal(s2.canary_run_id, "42-1-s2of4");
});

test("an unsharded run (or a merge-reports push) keeps the plain run id", () => {
  const cfg = resolveConfig({ suite: "web" }, {});
  assert.equal(buildPayload([], cfg, T, CI_ENV, "passed", { shard: null }).canary_run_id, "42-1");
  assert.equal(buildPayload([], cfg, T, CI_ENV, "passed", { shard: { current: 1, total: 1 } }).canary_run_id, "42-1");
  assert.equal(buildPayload([], cfg, T, { GITHUB_RUN_ID: "42" }, "passed", { shard: { current: 3, total: 4 } }).canary_run_id, "42-s3of4");
});

test("a duplicate response whose row count differs from what was sent is a warning, not a success", () => {
  const out = ingestOutcome({ id: 7, duplicate: true, result_count: 120 }, { results: 95 });
  assert.equal(out.level, "warn");
  assert.match(out.message, /duplicate/);
  assert.match(out.message, /95/);
  assert.match(out.message, /120/);
  assert.match(out.message, /discarded/);
});

test("a duplicate response matching what was sent is a plain re-push", () => {
  const out = ingestOutcome({ id: 7, duplicate: true, result_count: 95 }, { results: 95 });
  assert.equal(out.level, "info");
  assert.match(out.message, /run 7 already ingested/);
});

test("a fresh ingest is reported as info", () => {
  const out = ingestOutcome({ id: 8, duplicate: false, result_count: 95 }, { results: 95 });
  assert.equal(out.level, "info");
  assert.match(out.message, /run 8 ingested/);
});

test("the reporter derives the shard suffix from Playwright's config", async () => {
  const t = fakeTest({ title: "a" });
  const { payload } = await runReporter({
    config: { shard: { current: 2, total: 3 }, projects: [] },
    tests: [[t, fakeResult("passed")]],
    env: { GITHUB_RUN_ID: "77", GITHUB_RUN_ATTEMPT: "2" },
  });
  assert.equal(payload.canary_run_id, "77-2-s2of3");
});

test("a duplicate push that stored fewer rows is announced as a warning", async () => {
  const t = fakeTest({ title: "a" });
  const { logs } = await runReporter({
    tests: [[t, fakeResult("passed")]],
    responses: [{ status: 200, json: { id: 3, duplicate: true, result_count: 40 } }],
    env: { GITHUB_ACTIONS: "true" },
  });
  assert.ok(logs.some((l) => l.startsWith("::warning")), logs.join("\n"));
  assert.ok(logs.some((l) => /discarded/.test(l)));
});

// --- #1176: tag duplication and merge-reports timing -------------------------

test("a tag written in both the describe and the test title is sent once", async () => {
  const t = fakeTest({ title: "does x @functional", describes: ["@functional foo"], tags: ["@functional", "@functional", "@smoke"] });
  const { payload } = await runReporter({ tests: [[t, fakeResult("passed")]] });
  const tags = payload.results[0].tags;
  assert.equal(tags.filter((x) => x === "functional").length, 1);
  assert.ok(tags.includes("smoke"));
});

test("run timing comes from FullResult, not the reporter's wall clock", async () => {
  // Under merge-reports the reporter lives for ~0.3 s; FullResult.startTime and
  // duration still describe the original run.
  const t = fakeTest({ title: "a" });
  const { payload } = await runReporter({
    tests: [[t, fakeResult("passed")]],
    fullResult: { status: "passed", startTime: new Date("2026-10-05T00:00:00Z"), duration: 754321.6 },
  });
  assert.equal(payload.started_at, "2026-10-05T00:00:00.000Z");
  assert.equal(payload.finished_at, "2026-10-05T00:12:34.321Z");
});

test("run timing falls back to the wall clock when FullResult has no startTime", async () => {
  const before = Date.now();
  const t = fakeTest({ title: "a" });
  const { payload } = await runReporter({ tests: [[t, fakeResult("passed")]], fullResult: { status: "passed" } });
  assert.ok(Date.parse(payload.started_at) >= before - 1000);
  assert.ok(Date.parse(payload.finished_at) >= Date.parse(payload.started_at));
});

test("a fractional test duration is sent as an integer (the ingest schema rejects floats)", async () => {
  const t = fakeTest({ title: "a" });
  const { payload } = await runReporter({ tests: [[t, fakeResult("passed", { duration: 12.7 })]] });
  assert.equal(payload.results[0].duration_ms, 13);
});

// --- #1150: collected catalog, area, retry, preflight -------------------------
// `collected` is the denominator that separates "not covered" from "did not
// run". The ingest API reads three states and they are not interchangeable:
// omitted = no catalog (unknown), [] = a measured zero, non-empty = the suite.

test("collected carries every collected test, including ones that never ran", async () => {
  const ran = fakeTest({ title: "ran" });
  const neverRan = fakeTest({ title: "never ran", file: "tests/b.spec.ts" });
  const { payload } = await runReporter({ collected: [ran, neverRan], tests: [[ran, fakeResult("passed")]] });
  assert.equal(payload.results.length, 1);
  assert.deepEqual(
    payload.collected.map((c) => [c.full_title, c.test_file]),
    [
      ["chromium > tests/a.spec.ts > ran", "tests/a.spec.ts"],
      ["chromium > tests/b.spec.ts > never ran", "tests/b.spec.ts"],
    ],
  );
});

test("an empty suite sends collected: [] — a measured zero, not an omission", async () => {
  const { payload } = await runReporter({ collected: [] });
  assert.deepEqual(payload.collected, []);
});

test("a shard run omits collected — one shard's tests are not the suite's denominator", async () => {
  const t = fakeTest({ title: "a" });
  const { payload } = await runReporter({ config: { shard: { current: 1, total: 2 }, projects: [] }, tests: [[t, fakeResult("passed")]] });
  assert.equal("collected" in payload, false);
});

test("collected rows are unique by full_title", async () => {
  const a = fakeTest({ title: "a", id: "1" });
  const again = fakeTest({ title: "a", id: "2" });
  const { payload } = await runReporter({ collected: [a, again] });
  assert.equal(payload.collected.length, 1);
});

test("an area annotation sets area on the result and the collected row", async () => {
  const t = fakeTest({ title: "redeem", annotations: [{ type: "area", description: "rewards" }] });
  const { payload } = await runReporter({ tests: [[t, fakeResult("passed")]] });
  assert.equal(payload.results[0].area, "rewards");
  assert.equal(payload.collected[0].area, "rewards");
});

test("areaMap globs name the area; an unmapped test sends no area at all", async () => {
  const mapped = fakeTest({ title: "redeem", file: "tests/functional/rewards/redeem.spec.ts" });
  const unmapped = fakeTest({ title: "x", file: "tests/smoke/x.spec.ts" });
  const { payload } = await runReporter({
    options: { areaMap: { "tests/**/rewards/**": "rewards", "tests/functional/*.spec.ts": "functional-root" } },
    tests: [[mapped, fakeResult("passed")], [unmapped, fakeResult("passed")]],
  });
  assert.equal(payload.results[0].area, "rewards");
  assert.equal("area" in payload.results[1], false, "never fall back to a folder name");
});

test("an area annotation wins over areaMap", async () => {
  const t = fakeTest({ title: "a", file: "tests/rewards/a.spec.ts", annotations: [{ type: "area", description: "checkout" }] });
  const { payload } = await runReporter({ options: { areaMap: { "tests/rewards/**": "rewards" } }, tests: [[t, fakeResult("passed")]] });
  assert.equal(payload.results[0].area, "checkout");
});

test("CANARY_INGEST_AREA_MAP supplies areaMap as JSON", () => {
  const c = resolveConfig({ suite: "s" }, { CANARY_INGEST_AREA_MAP: '{"tests/rewards/**":"rewards"}' });
  assert.deepEqual(c.areaMap, { "tests/rewards/**": "rewards" });
});

test("a malformed CANARY_INGEST_AREA_MAP is a config error, not a silent no-area run", () => {
  assert.throws(() => resolveConfig({ suite: "s" }, { CANARY_INGEST_AREA_MAP: "{nope" }), /CANARY_INGEST_AREA_MAP/);
});

test("a collected_count that differs from the catalog sent is a warning", async () => {
  const t = fakeTest({ title: "a" });
  const { logs } = await runReporter({
    tests: [[t, fakeResult("passed")]],
    responses: [{ status: 200, json: { id: 4, duplicate: false, result_count: 1, collected_count: 0 } }],
  });
  assert.ok(logs.some((l) => /WARNING/.test(l) && /collected/.test(l)), logs.join("\n"));
});

test("a 5xx is retried and the run lands", async () => {
  const t = fakeTest({ title: "a" });
  const { pushes, logs } = await runReporter({
    tests: [[t, fakeResult("passed")]],
    responses: [{ status: 503 }, { status: 502 }, { status: 200, json: { id: 9, duplicate: false, result_count: 1, collected_count: 1 } }],
  });
  assert.equal(pushes.length, 3);
  assert.ok(logs.some((l) => /run 9 ingested/.test(l)), logs.join("\n"));
});

test("a 429 and a network error are retried too", async () => {
  const t = fakeTest({ title: "a" });
  const { pushes } = await runReporter({
    tests: [[t, fakeResult("passed")]],
    responses: [{ status: 429 }, { throws: "ECONNRESET" }, { status: 200, json: { id: 9, result_count: 1, collected_count: 1 } }],
  });
  assert.equal(pushes.length, 3);
});

test("a 4xx is not retried — the payload, not the server, is wrong", async () => {
  const t = fakeTest({ title: "a" });
  const { pushes, logs } = await runReporter({ tests: [[t, fakeResult("passed")]], responses: [{ status: 422, json: { message: "duplicate full_title" } }] });
  assert.equal(pushes.length, 1);
  assert.ok(logs.some((l) => /WARNING/.test(l) && /422/.test(l)), logs.join("\n"));
});

test("the default retry schedule is two waits — three attempts in all", () => {
  assert.deepEqual(resolveConfig({ suite: "s" }, {}).retryDelaysMs, [1000, 4000]);
});

test("retries are bounded: three 5xx answers stop after three attempts with a warning", async () => {
  const t = fakeTest({ title: "a" });
  const { pushes, logs } = await runReporter({ tests: [[t, fakeResult("passed")]], responses: [{ status: 500 }, { status: 500 }, { status: 500 }, { status: 200 }] });
  assert.equal(pushes.length, 3);
  assert.ok(logs.some((l) => /WARNING/.test(l) && /not ingested/.test(l)), logs.join("\n"));
});

test("preflight names the tenant the token writes to before anything is pushed", async () => {
  const t = fakeTest({ title: "a" });
  const { requests, logs } = await runReporter({ tests: [[t, fakeResult("passed")]] });
  assert.equal(requests[0].method, "GET");
  assert.equal(requests[0].url, "https://dash.example/api/ingest/whoami");
  assert.ok(logs.some((l) => /tenant acme/.test(l)), logs.join("\n"));
});

test("a rejected token is reported at preflight and nothing is pushed", async () => {
  const t = fakeTest({ title: "a" });
  const { pushes, logs } = await runReporter({ tests: [[t, fakeResult("passed")]], whoami: { status: 401, json: {} } });
  assert.equal(pushes.length, 0);
  assert.ok(logs.some((l) => /WARNING/.test(l) && /401/.test(l)), logs.join("\n"));
});

test("an unreachable or older preflight endpoint does not block the push", async () => {
  const t = fakeTest({ title: "a" });
  const notFound = await runReporter({ tests: [[t, fakeResult("passed")]], whoami: { status: 404, json: {} } });
  assert.equal(notFound.pushes.length, 1);
  const down = await runReporter({ tests: [[t, fakeResult("passed")]], whoami: { throws: "ENOTFOUND" } });
  assert.equal(down.pushes.length, 1);
});

test("no preflight and no push when pushing is off", async () => {
  const t = fakeTest({ title: "a" });
  const { requests } = await runReporter({ tests: [[t, fakeResult("passed")]], env: { CANARY_INGEST_PUSH: "false", CI: "", GITHUB_ACTIONS: "" } });
  assert.equal(requests.length, 0);
});

// --- #1183: readable titles, project/setup dimension, skip reasons ------------
// full_title is the dashboard's test identity (quarantine entries and flake
// history key on it), so the clean format is opt-in until the dashboard
// re-keys history; legacy stays the default.

test("the legacy title format is the default and is unchanged", async () => {
  const t = fakeTest({ title: "does x @functional", describes: ["@functional foo"] });
  const { payload } = await runReporter({ tests: [[t, fakeResult("passed")]] });
  assert.equal(payload.results[0].full_title, "chromium > tests/a.spec.ts > @functional foo > does x @functional");
});

test("titleFormat clean sends the describe chain and title only, without inline @tags", async () => {
  const t = fakeTest({ title: "does x @functional", describes: ["@functional foo", "emails user@example.com"] });
  const { payload } = await runReporter({ options: { titleFormat: "clean" }, tests: [[t, fakeResult("passed")]] });
  assert.equal(payload.results[0].full_title, "foo > emails user@example.com > does x");
  assert.equal(payload.collected[0].full_title, "foo > emails user@example.com > does x");
});

test("CANARY_INGEST_TITLE_FORMAT selects the format; an unknown value is a config error", () => {
  assert.equal(resolveConfig({ suite: "s" }, { CANARY_INGEST_TITLE_FORMAT: "clean" }).titleFormat, "clean");
  assert.equal(resolveConfig({ suite: "s" }, {}).titleFormat, "legacy");
  assert.throws(() => resolveConfig({ suite: "s" }, { CANARY_INGEST_TITLE_FORMAT: "pretty" }), /legacy.*clean/);
});

test("every row carries its Playwright project as a project: tag", async () => {
  const t = fakeTest({ title: "a", project: "firefox" });
  const { payload } = await runReporter({ tests: [[t, fakeResult("passed")]] });
  assert.ok(payload.results[0].tags.includes("project:firefox"));
});

test("under the clean format a 3-browser suite reports each test once, worst status kept", async () => {
  const runs = ["chromium", "firefox", "webkit"].map((project) => fakeTest({ title: "a", project }));
  const { payload } = await runReporter({
    options: { titleFormat: "clean" },
    tests: [
      [runs[0], fakeResult("passed")],
      [runs[1], fakeResult("failed", { errors: [{ message: "boom" }] })],
      [runs[2], fakeResult("passed")],
    ],
  });
  assert.equal(payload.results.length, 1);
  assert.equal(payload.totals.total, 1);
  assert.equal(payload.results[0].status, "failed");
  for (const p of ["chromium", "firefox", "webkit"]) assert.ok(payload.results[0].tags.includes(`project:${p}`));
  assert.equal(payload.collected.length, 1);
});

test("under the clean format, same-named tests in different files are never merged", async () => {
  const api = fakeTest({ title: "works", describes: ["login"], file: "tests/api/login.spec.ts" });
  const web = fakeTest({ title: "works", describes: ["login"], file: "tests/web/login.spec.ts" });
  const lone = fakeTest({ title: "only once", file: "tests/web/login.spec.ts" });
  const { payload } = await runReporter({
    options: { titleFormat: "clean" },
    tests: [[api, fakeResult("passed")], [web, fakeResult("failed")], [lone, fakeResult("passed")]],
  });
  assert.deepEqual(
    payload.results.map((r) => r.full_title).sort(),
    ["only once", "tests/api/login.spec.ts > login > works", "tests/web/login.spec.ts > login > works"],
  );
  assert.equal(payload.totals.total, 3);
  assert.equal(payload.collected.length, 3);
});

test("setup and teardown projects are tagged so they can be filtered out of test counts", async () => {
  const setup = fakeTest({ title: "authenticate", project: "setup", file: "tests/auth.setup.ts" });
  const cleanup = fakeTest({ title: "drop db", project: "cleanup", file: "tests/db.teardown.ts" });
  const real = fakeTest({ title: "a", project: "chromium" });
  const { payload } = await runReporter({
    config: { shard: null, projects: [{ name: "setup", teardown: "cleanup" }, { name: "cleanup" }, { name: "chromium", dependencies: ["setup"] }] },
    tests: [[setup, fakeResult("passed")], [cleanup, fakeResult("passed")], [real, fakeResult("passed")]],
  });
  const tagsOf = (title) => payload.results.find((r) => r.full_title.endsWith(title)).tags;
  assert.ok(tagsOf("authenticate").includes("setup"));
  assert.ok(tagsOf("drop db").includes("teardown"));
  assert.equal(tagsOf("> a").includes("setup"), false);
});

test("a fixme is tagged fixme and its reason reaches the dashboard", async () => {
  const t = fakeTest({ title: "parked", outcome: "skipped", annotations: [{ type: "fixme", description: "  blocked by #123\n flaky upstream " }] });
  const { payload } = await runReporter({ tests: [[t, fakeResult("skipped")]] });
  const tags = payload.results[0].tags;
  assert.ok(tags.includes("fixme"));
  assert.ok(tags.includes("reason:blocked by #123 flaky upstream"), tags.join(","));
});

test("a skip with a reason forwards it; a bare skip adds no reason tag", async () => {
  const withReason = fakeTest({ title: "a", outcome: "skipped", annotations: [{ type: "skip", description: "not on webkit" }] });
  const bare = fakeTest({ title: "b", outcome: "skipped", annotations: [{ type: "skip" }] });
  const { payload } = await runReporter({ tests: [[withReason, fakeResult("skipped")], [bare, fakeResult("skipped")]] });
  assert.ok(payload.results[0].tags.includes("reason:not on webkit"));
  assert.equal(payload.results[1].tags.some((x) => x.startsWith("reason:")), false);
  assert.equal(payload.results[1].tags.includes("fixme"), false);
});

test("a very long skip reason is capped", async () => {
  const t = fakeTest({ title: "a", outcome: "skipped", annotations: [{ type: "skip", description: "x".repeat(500) }] });
  const { payload } = await runReporter({ tests: [[t, fakeResult("skipped")]] });
  const reason = payload.results[0].tags.find((x) => x.startsWith("reason:"));
  assert.ok(reason.length <= 120, `${reason.length}`);
});
