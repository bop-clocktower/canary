const test = require("node:test");
const assert = require("node:assert/strict");
const { reporterModule, fakeTest, fakeResult, runReporter, CI_ENV, T } = require("./ingest-harness.js");
const { mapStatus, resolveTestStatus, runStatus, resolveConfig, buildPayload, shouldPush, dedupeByFullTitle, ingestOutcome, retryWaitMs, fitPayload } = reporterModule;

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
  const t = fakeTest({ title: "checkout" }); // outcome derived: "skipped", as Playwright reports it
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

test("resolveTestStatus reports a recovered flake as flaky, and ordinary outcomes plainly", () => {
  // outcome 'flaky' wins even though the last attempt passed
  assert.equal(resolveTestStatus("flaky", "passed"), "flaky");
  // for a test expected to pass, the outcome agrees with the attempt
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
