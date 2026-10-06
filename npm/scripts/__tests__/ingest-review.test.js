const test = require("node:test");
const assert = require("node:assert/strict");
const { reporterModule, fakeTest, fakeResult, runReporter, CI_ENV, T } = require("./ingest-harness.js");
const { mapStatus, resolveTestStatus, runStatus, resolveConfig, buildPayload, shouldPush, dedupeByFullTitle, ingestOutcome, retryWaitMs, fitPayload } = reporterModule;

// --- review follow-ups: silent abstention and the payload budget ---------------

test("an empty CANARY_INGEST_* var does not hide its legacy alias", () => {
  // GitHub Actions expands a not-yet-created secret to "".
  const c = resolveConfig({}, { CANARY_INGEST_SUITE: "", TESTTRACKER_SUITE: "old", CANARY_INGEST_TOKEN: "", TESTTRACKER_API_TOKEN: "t" });
  assert.equal(c.suite, "old");
  assert.equal(c.token, "t");
});

test("in CI with no url or token the reporter says what is missing instead of nothing", async () => {
  const t = fakeTest({ title: "a" });
  const { requests, logs } = await runReporter({
    options: { url: "", token: "" },
    tests: [[t, fakeResult("passed")]],
    env: { CANARY_INGEST_PUSH: "", CI: "true" },
  });
  assert.equal(requests.length, 0);
  assert.ok(logs.some((l) => /not pushing/.test(l) && /CANARY_INGEST_URL/.test(l) && /CANARY_INGEST_TOKEN/.test(l)), logs.join("\n"));
});

test("a missing suite with url and token set is a warning, not a quiet log line", async () => {
  const t = fakeTest({ title: "a" });
  const { logs } = await runReporter({ options: { suite: "" }, tests: [[t, fakeResult("passed")]], env: { GITHUB_ACTIONS: "true" } });
  assert.ok(logs.some((l) => l.startsWith("::warning") && /suite/.test(l)), logs.join("\n"));
});

test("error text is ANSI-stripped and capped so a bad night cannot blow the body limit", async () => {
  const t = fakeTest({ title: "a", outcome: "unexpected" });
  const huge = "\u001b[31mexpected\u001b[39m " + "y".repeat(50000);
  const { payload } = await runReporter({ tests: [[t, fakeResult("failed", { errors: [{ message: huge, stack: huge }] })]] });
  const row = payload.results[0];
  assert.equal(row.error_message.includes("\u001b"), false);
  assert.ok(row.error_message.length <= 4100, `${row.error_message.length}`);
  assert.ok(row.error_stack.length <= 8100, `${row.error_stack.length}`);
});

test("a payload over budget drops the catalog first and says so", () => {
  const big = Array.from({ length: 3 }, (_, i) => ({ full_title: `t${i}`, test_file: "x.spec.ts", tags: ["z".repeat(100)] }));
  const cfg = resolveConfig({ suite: "s" }, {});
  const p = buildPayload([], cfg, T, {}, "passed", { collected: big });
  const { payload, warnings } = fitPayload(p, 200);
  assert.equal("collected" in payload, false);
  assert.match(warnings.join("\n"), /collected/);
});

test("--list mode (nothing ran, tests collected) pushes nothing", async () => {
  const t = fakeTest({ title: "a" });
  const { pushes, logs } = await runReporter({ collected: [t], tests: [] });
  assert.equal(pushes.length, 0);
  assert.ok(logs.some((l) => /no test ran/.test(l)), logs.join("\n"));
});

// --- collected is the whole suite or nothing ---------------------------------

test("a grep-filtered run omits collected and says why", async () => {
  const t = fakeTest({ title: "a" });
  const { payload, logs } = await runReporter({ config: { shard: null, projects: [], grep: /@smoke/ }, tests: [[t, fakeResult("passed")]] });
  assert.equal("collected" in payload, false);
  assert.ok(logs.some((l) => /collected/.test(l) && /grep/.test(l)), logs.join("\n"));
});

test("a grepInvert run omits collected", async () => {
  const t = fakeTest({ title: "a" });
  const { payload } = await runReporter({ config: { shard: null, projects: [], grep: /.*/, grepInvert: /@slow/ }, tests: [[t, fakeResult("passed")]] });
  assert.equal("collected" in payload, false);
});

test("a run of a subset of the configured projects omits collected", async () => {
  const t = fakeTest({ title: "a", project: "chromium" });
  const { payload } = await runReporter({ config: { shard: null, projects: [{ name: "chromium" }, { name: "firefox" }] }, tests: [[t, fakeResult("passed")]] });
  assert.equal("collected" in payload, false);
});

test("a full run of every configured project sends collected", async () => {
  const a = fakeTest({ title: "a", project: "chromium" });
  const b = fakeTest({ title: "a", project: "firefox" });
  const { payload } = await runReporter({
    config: { shard: null, projects: [{ name: "chromium" }, { name: "firefox" }], grep: /.*/, grepInvert: null },
    tests: [[a, fakeResult("passed")], [b, fakeResult("passed")]],
  });
  assert.equal(payload.collected.length, 2);
});

test("collected: false (CANARY_INGEST_COLLECTED=false) opts a job out", async () => {
  const t = fakeTest({ title: "a" });
  assert.equal(resolveConfig({ suite: "s" }, { CANARY_INGEST_COLLECTED: "false" }).collected, false);
  const { payload } = await runReporter({ options: { collected: false }, tests: [[t, fakeResult("passed")]] });
  assert.equal("collected" in payload, false);
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

test("titleFormat clean drops only the project: file > describe > title, tags kept", async () => {
  // Deterministic per test: no collisions, and no identity that depends on
  // which other tests happen to be in this push.
  const t = fakeTest({ title: "does x @functional", describes: ["@functional foo"] });
  const { payload } = await runReporter({ options: { titleFormat: "clean" }, tests: [[t, fakeResult("passed")]] });
  assert.equal(payload.results[0].full_title, "tests/a.spec.ts > @functional foo > does x @functional");
  assert.equal(payload.collected[0].full_title, "tests/a.spec.ts > @functional foo > does x @functional");
});

test("under the clean format, tests differing only by tag stay separate rows", async () => {
  const smoke = fakeTest({ title: "works @smoke" });
  const regression = fakeTest({ title: "works @regression" });
  const { payload } = await runReporter({ options: { titleFormat: "clean" }, tests: [[smoke, fakeResult("passed")], [regression, fakeResult("failed")]] });
  assert.equal(payload.totals.total, 2);
});

test("a clean title is the same whether or not a same-named test is in the push", async () => {
  const a = fakeTest({ title: "works", describes: ["login"], file: "tests/api/login.spec.ts" });
  const b = fakeTest({ title: "works", describes: ["login"], file: "tests/web/login.spec.ts" });
  const alone = await runReporter({ options: { titleFormat: "clean" }, tests: [[a, fakeResult("passed")]] });
  const both = await runReporter({ options: { titleFormat: "clean" }, tests: [[a, fakeResult("passed")], [b, fakeResult("passed")]] });
  assert.equal(alone.payload.results[0].full_title, both.payload.results.find((r) => r.test_file === "tests/api/login.spec.ts").full_title);
  assert.equal(both.payload.totals.total, 2);
});

test("CANARY_INGEST_TITLE_FORMAT selects the format; an unknown value warns and stays legacy", () => {
  assert.equal(resolveConfig({ suite: "s" }, { CANARY_INGEST_TITLE_FORMAT: "clean" }).titleFormat, "clean");
  assert.equal(resolveConfig({ suite: "s" }, {}).titleFormat, "legacy");
  const bad = resolveConfig({ suite: "s" }, { CANARY_INGEST_TITLE_FORMAT: "Clean" });
  assert.equal(bad.titleFormat, "legacy");
  assert.match(bad.configWarnings.join("\n"), /legacy.*clean/);
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

test("dependency and teardown projects are tagged so a dashboard can choose to filter them", async () => {
  const setup = fakeTest({ title: "authenticate", project: "setup", file: "tests/auth.setup.ts" });
  const cleanup = fakeTest({ title: "drop db", project: "cleanup", file: "tests/db.teardown.ts" });
  const real = fakeTest({ title: "a", project: "chromium" });
  const { payload } = await runReporter({
    config: { shard: null, projects: [{ name: "setup", teardown: "cleanup" }, { name: "cleanup" }, { name: "chromium", dependencies: ["setup"] }] },
    tests: [[setup, fakeResult("passed")], [cleanup, fakeResult("passed")], [real, fakeResult("passed")]],
  });
  const tagsOf = (title) => payload.results.find((r) => r.full_title.endsWith(title)).tags;
  assert.ok(tagsOf("authenticate").includes("dependency"));
  assert.ok(tagsOf("drop db").includes("teardown"));
  assert.equal(tagsOf("> a").includes("dependency"), false);
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
  assert.equal(reason.length, "reason:".length + 100);
});
