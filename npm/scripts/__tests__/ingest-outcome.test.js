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

test("every status the reporter can emit is in the ingest result enum", () => {
  const allowed = new Set(["passed", "failed", "flaky", "skipped", "timed_out"]);
  for (const o of ["expected", "unexpected", "flaky", "skipped", "bogus"])
    for (const s of ["passed", "failed", "timedOut", "interrupted", "skipped", "bogus"])
      assert.ok(allowed.has(resolveTestStatus(o, s)), `${o}/${s} → ${resolveTestStatus(o, s)}`);
});
