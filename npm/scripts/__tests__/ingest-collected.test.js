const test = require("node:test");
const assert = require("node:assert/strict");
const { reporterModule, fakeTest, fakeResult, runReporter, CI_ENV, T } = require("./ingest-harness.js");
const { mapStatus, resolveTestStatus, runStatus, resolveConfig, buildPayload, shouldPush, dedupeByFullTitle, ingestOutcome, retryWaitMs, fitPayload } = reporterModule;

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
  const { payload } = await runReporter({ collected: [a, again], tests: [[a, fakeResult("passed")]] });
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

test("a malformed CANARY_INGEST_AREA_MAP warns and falls back to no areas — it never turns pushing off", async () => {
  const c = resolveConfig({ suite: "s" }, { CANARY_INGEST_AREA_MAP: "{nope" });
  assert.deepEqual(c.areaMap, {});
  assert.match(c.configWarnings.join("\n"), /CANARY_INGEST_AREA_MAP/);
  const t = fakeTest({ title: "a" });
  const { pushes, logs } = await runReporter({ tests: [[t, fakeResult("passed")]], env: { CANARY_INGEST_AREA_MAP: "{nope", GITHUB_ACTIONS: "true" } });
  assert.equal(pushes.length, 1);
  assert.ok(logs.some((l) => l.startsWith("::warning") && /CANARY_INGEST_AREA_MAP/.test(l)), logs.join("\n"));
});

test("an areaMap glob using {a,b} or [ab] is flagged, not silently matched as literal text", () => {
  const c = resolveConfig({ suite: "s", areaMap: { "tests/{rewards,shop}/**": "commerce" } }, {});
  assert.match(c.configWarnings.join("\n"), /\{a,b\}|unsupported/);
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

test("a token rejected at preflight is warned about, and the push still decides", async () => {
  // whoami may sit behind different auth or a WAF; a 401 there must not drop a
  // run the ingest endpoint would have accepted.
  const t = fakeTest({ title: "a" });
  const { pushes, logs } = await runReporter({ tests: [[t, fakeResult("passed")]], whoami: { status: 401, json: {} } });
  assert.equal(pushes.length, 1);
  assert.ok(logs.some((l) => /WARNING/.test(l) && /401/.test(l)), logs.join("\n"));
});

test("every request carries a timeout so a stalled dashboard cannot hang the job", async () => {
  const t = fakeTest({ title: "a" });
  const signals = [];
  const realFetch = global.fetch;
  const { requests } = await runReporter({ tests: [[t, fakeResult("passed")]], onRequest: (init) => signals.push(init.signal) });
  global.fetch = realFetch;
  assert.equal(requests.length, 2);
  assert.ok(signals.every((sig) => sig instanceof AbortSignal), "whoami and POST both need a signal");
});

test("Retry-After is honoured up to 65 s and never shortens the backoff", () => {
  assert.equal(retryWaitMs(1000, "60"), 60000);
  assert.equal(retryWaitMs(1000, "600"), 65000);
  assert.equal(retryWaitMs(4000, "1"), 4000);
  assert.equal(retryWaitMs(1000, null), 1000);
  assert.equal(retryWaitMs(1000, "Wed, 21 Oct 2026 07:28:00 GMT"), 1000);
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
