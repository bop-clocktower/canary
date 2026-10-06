const test = require("node:test");
const assert = require("node:assert/strict");
const { reporterModule, fakeTest, fakeResult, runReporter, CI_ENV, T } = require("./ingest-harness.js");
const { mapStatus, resolveTestStatus, runStatus, resolveConfig, buildPayload, shouldPush, dedupeByFullTitle, ingestOutcome, retryWaitMs, fitPayload } = reporterModule;

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

test("a malformed Playwright config never throws out of onBegin", async () => {
  const t = fakeTest({ title: "a" });
  const { pushes } = await runReporter({ config: { shard: null, projects: 5 }, tests: [[t, fakeResult("passed")]] });
  assert.equal(pushes.length, 1);
});

test("a negative duration (a test that never started) is omitted, not sent", async () => {
  // The ingest schema requires a non-negative integer; -1 would reject the run.
  const t = fakeTest({ title: "a" }); // outcome derived: "skipped", as Playwright reports it
  const { payload } = await runReporter({ tests: [[t, fakeResult("interrupted", { duration: -1 })]] });
  assert.equal("duration_ms" in payload.results[0], false);
});

test("an interrupted retry does not stack interrupted: prefixes", async () => {
  const t = fakeTest({ title: "a" }); // outcome derived: "skipped", as Playwright reports it
  const { payload } = await runReporter({
    tests: [
      [t, fakeResult("interrupted", { retry: 0 })],
      [t, fakeResult("interrupted", { retry: 1 })],
    ],
  });
  assert.equal(payload.results[0].error_message, "interrupted: the run ended before this test finished");
});
