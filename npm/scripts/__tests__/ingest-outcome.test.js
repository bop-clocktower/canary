const test = require("node:test");
const assert = require("node:assert/strict");
const { reporterModule, fakeTest, fakeResult, runReporter } = require("./ingest-harness.js");
const { resolveTestStatus } = reporterModule;

// --- #1186: test.fail() — the outcome, not the raw attempt, decides ----------
// A test.fail() test expects to fail. Playwright reports it by test.outcome():
// failing as expected is a pass (the run is green); passing unexpectedly is a
// failure (the run is red). The raw attempt status says the opposite of both.

test("an expected failure (test.fail) reaches the wire as passed and the run is not failed", async () => {
  const t = fakeTest({ title: "known bug", expectedStatus: "failed" });
  const ok = fakeTest({ title: "other" });
  const { payload } = await runReporter({
    tests: [[t, fakeResult("failed", { errors: [{ message: "expected boom" }] })], [ok, fakeResult("passed")]],
  });
  assert.equal(payload.results.find((r) => r.full_title.endsWith("known bug")).status, "passed");
  assert.deepEqual(payload.totals, { passed: 2, failed: 0, flaky: 0, skipped: 0, total: 2 });
  assert.equal(payload.status, "passed", "Playwright reported this run passed; the headline must agree");
});

test("a test.fail() test that unexpectedly passes reaches the wire as failed", async () => {
  const t = fakeTest({ title: "fixed by accident", expectedStatus: "failed" });
  const { payload } = await runReporter({
    tests: [[t, fakeResult("passed")]],
    fullResult: { status: "failed", startTime: new Date("2026-10-05T00:00:00Z"), duration: 1000 },
  });
  assert.equal(payload.results[0].status, "failed");
  assert.equal(payload.totals.failed, 1, "a failed run must name the test that failed it");
  assert.equal(payload.totals.passed, 0);
  assert.equal(payload.status, "failed");
});

test("a test.fail() test that times out instead of failing stays timed_out", async () => {
  const t = fakeTest({ title: "hangs", expectedStatus: "failed" });
  const { payload } = await runReporter({ tests: [[t, fakeResult("timedOut")]] });
  assert.equal(payload.results[0].status, "timed_out");
  assert.equal(payload.totals.failed, 1);
});

// The error a row carries must explain its status. Playwright leaves
// result.errors empty for an unexpected pass ("Expected to fail, but passed."
// lives only in its formatter), and an expected failure's error is not a
// reason for anything: on a `passed` row it is noise, on a `flaky` row or a
// merged clean-title row it would be presented as the cause.
const UNEXPECTED_PASS = "Expected to fail, but passed.";
const knownBug = (extra = {}) => fakeResult("failed", { errors: [{ message: "known bug #12", stack: "at bug.ts:1" }], ...extra });

test("a test.fail() that passes says why it failed, in Playwright's words, and is tagged", async () => {
  const t = fakeTest({ title: "fixed by accident", expectedStatus: "failed" });
  const { payload } = await runReporter({ tests: [[t, fakeResult("passed")]] });
  const row = payload.results[0];
  assert.equal(row.error_message, UNEXPECTED_PASS);
  assert.ok(row.tags.includes("expected-failure"));
});

test("an expected failure is sent passed with no error fields and no expected-failure tag", async () => {
  const t = fakeTest({ title: "known bug", expectedStatus: "failed" });
  const { payload } = await runReporter({ tests: [[t, knownBug()]] });
  const row = payload.results[0];
  assert.equal(row.status, "passed");
  assert.equal(row.error_message, undefined);
  assert.equal(row.error_stack, undefined);
  assert.equal(row.tags.includes("expected-failure"), false);
});

test("a test.fail() that passed then failed as expected is flaky, and the expected error is not its reason", async () => {
  const t = fakeTest({ title: "wavers", expectedStatus: "failed" });
  const { payload } = await runReporter({ tests: [[t, fakeResult("passed")], [t, knownBug({ retry: 1 })]] });
  const row = payload.results[0];
  assert.equal(row.status, "flaky");
  assert.equal(row.error_message, UNEXPECTED_PASS);
  assert.equal(row.error_stack, undefined);
});

test("a flaky test.fail() row keeps the expected-failure tag from the attempt that passed", async () => {
  const t = fakeTest({ title: "wavers", expectedStatus: "failed" });
  const { payload } = await runReporter({ tests: [[t, fakeResult("passed")], [t, knownBug({ retry: 1 })]] });
  const row = payload.results[0];
  assert.equal(row.status, "flaky");
  assert.ok(row.tags.includes("expected-failure"), "a dashboard filtering on the tag must find this row");
});

test("a test.fail() that times out keeps its own error and is not tagged expected-failure", async () => {
  const t = fakeTest({ title: "hangs", expectedStatus: "failed" });
  const timeout = fakeResult("timedOut", { errors: [{ message: "Test timeout of 30000ms exceeded.", stack: "at hang.ts:3" }] });
  const { payload } = await runReporter({ tests: [[t, timeout]] });
  const row = payload.results[0];
  assert.equal(row.status, "timed_out");
  assert.equal(row.error_message, "Test timeout of 30000ms exceeded.");
  assert.equal(row.error_stack, "at hang.ts:3");
  assert.equal(row.tags.includes("expected-failure"), false);
});

test("an interrupted attempt with its own error keeps it, prefixed, with its stack", async () => {
  const t = fakeTest({ title: "cut short" });
  const { payload } = await runReporter({
    tests: [[t, fakeResult("interrupted", { errors: [{ message: "Target page closed", stack: "at page.ts:9" }] })]],
    fullResult: { status: "interrupted", startTime: new Date("2026-10-05T00:00:00Z"), duration: 1000 },
  });
  const row = payload.results[0];
  assert.equal(row.error_message, "interrupted: Target page closed");
  assert.equal(row.error_stack, "at page.ts:9");
});

test("a failed attempt then an interrupted retry reports the first real error, prefixed", async () => {
  const t = fakeTest({ title: "fails then cut" });
  const { payload } = await runReporter({
    tests: [
      [t, fakeResult("failed", { errors: [{ message: "expect(received).toBe(expected)", stack: "at a.ts:1" }] })],
      [t, fakeResult("interrupted", { retry: 1, errors: [{ message: "Target page closed", stack: "at page.ts:9" }] })],
    ],
    fullResult: { status: "interrupted", startTime: new Date("2026-10-05T00:00:00Z"), duration: 1000 },
  });
  const row = payload.results[0];
  assert.equal(row.status, "failed");
  assert.equal(row.error_message, "interrupted: expect(received).toBe(expected)");
  assert.equal(row.error_stack, "at a.ts:1");
});

test("a clean-title merge of an expected failure and an unexpected pass reports the real reason", async () => {
  const chromium = fakeTest({ title: "known bug", project: "chromium", expectedStatus: "failed" });
  const webkit = fakeTest({ title: "known bug", project: "webkit", expectedStatus: "failed" });
  const { payload } = await runReporter({
    options: { titleFormat: "clean" },
    tests: [[chromium, knownBug()], [webkit, fakeResult("passed")]],
  });
  assert.equal(payload.results.length, 1);
  const row = payload.results[0];
  assert.equal(row.status, "failed");
  assert.equal(row.error_message, UNEXPECTED_PASS);
  assert.equal(row.error_stack, undefined);
});

test("resolveTestStatus maps from the outcome first", () => {
  assert.equal(resolveTestStatus("expected", "failed"), "passed");
  assert.equal(resolveTestStatus("unexpected", "passed"), "failed");
  assert.equal(resolveTestStatus("unexpected", "timedOut"), "timed_out");
  assert.equal(resolveTestStatus("flaky", "passed"), "flaky");
  assert.equal(resolveTestStatus("skipped", "skipped"), "skipped");
  // Playwright's outcome() ignores interrupted attempts, so an interrupted-only
  // test reads "skipped"; it must still be sent as failed, never hidden (#1149).
  assert.equal(resolveTestStatus("skipped", "interrupted"), "failed");
});

test("an interrupted test whose outcome Playwright derives as skipped is still sent as failed", async () => {
  const t = fakeTest({ title: "cut short" }); // outcome derived, as Playwright would
  const { payload } = await runReporter({
    tests: [[t, fakeResult("interrupted")]],
    fullResult: { status: "interrupted", startTime: new Date("2026-10-05T00:00:00Z"), duration: 1000 },
  });
  assert.equal(t.outcome(), "skipped", "precondition: Playwright ignores interrupted attempts");
  assert.equal(payload.results[0].status, "failed");
  assert.ok(payload.results[0].tags.includes("interrupted"));
  assert.equal(payload.totals.skipped, 0);
});

test("a retried flake (failed then passed) is derived flaky end to end", async () => {
  const t = fakeTest({ title: "wobbly" });
  const { payload } = await runReporter({
    tests: [[t, fakeResult("failed", { errors: [{ message: "first try" }] })], [t, fakeResult("passed", { retry: 1 })]],
  });
  assert.equal(payload.results[0].status, "flaky");
  assert.equal(payload.status, "flaky");
});

test("harness: a fake reused across runs starts each run with no attempts", async () => {
  const t = fakeTest({ title: "reused" });
  await runReporter({ tests: [[t, fakeResult("failed")]] });
  const { payload } = await runReporter({ tests: [[t, fakeResult("passed")]] });
  assert.equal(payload.results[0].status, "passed", "the first run's failure must not make the second run flaky");
});

test("every status the reporter can emit is in the ingest result enum", () => {
  const allowed = new Set(["passed", "failed", "flaky", "skipped", "timed_out"]);
  for (const o of ["expected", "unexpected", "flaky", "skipped", "bogus"])
    for (const s of ["passed", "failed", "timedOut", "interrupted", "skipped", "bogus"])
      assert.ok(allowed.has(resolveTestStatus(o, s)), `${o}/${s} → ${resolveTestStatus(o, s)}`);
});
