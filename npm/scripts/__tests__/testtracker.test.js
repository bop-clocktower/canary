const test = require("node:test");
const assert = require("node:assert/strict");
const { mapStatus, resolveConfig, buildPayload, shouldPush } = require("../../dist/reporters/testtracker.js");

test("mapStatus collapses PW statuses", () => {
  assert.equal(mapStatus("passed"), "passed");
  assert.equal(mapStatus("timedOut"), "failed");
  assert.equal(mapStatus("failed"), "failed");
  assert.equal(mapStatus("flaky"), "flaky");
  assert.equal(mapStatus("skipped"), "skipped");
  assert.equal(mapStatus("interrupted"), "skipped");
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
  const cfg = resolveConfig({ suite: "capwell-api" }, {});
  const results = [
    { full_title: "a", test_file: "a.spec.ts", status: "passed", retries: 0, tags: [] },
    { full_title: "b", test_file: "b.spec.ts", status: "failed", retries: 1, tags: ["smoke"] },
  ];
  const p = buildPayload(results, cfg, { startedAt: "2026-07-24T00:00:00Z", finishedAt: "2026-07-24T00:01:00Z" }, { GITHUB_RUN_ID: "42", GITHUB_RUN_ATTEMPT: "1" });
  assert.equal(p.suite, "capwell-api");
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

test("timedOut counts as failed in totals", () => {
  const cfg = resolveConfig({ suite: "s" }, {});
  const results = [
    { full_title: "t", test_file: "t.spec.ts", status: mapStatus("timedOut"), retries: 0, tags: [] },
  ];
  const p = buildPayload(results, cfg, { startedAt: "x", finishedAt: "y" }, {});
  assert.equal(p.totals.failed, 1);
  assert.equal(p.status, "failed");
});
