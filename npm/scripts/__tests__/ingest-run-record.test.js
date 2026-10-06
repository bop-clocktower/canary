const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { reporterModule, CI_ENV, T } = require("./ingest-harness.js");
const { toRunRecord, runFilePath } = require("../../dist/reporters/ingest/run-record.js");
const { buildPayload, resolveConfig } = reporterModule;

const VALIDATE = pathToFileURL(path.resolve(__dirname, "../../../agents/skills/lib/contracts/validate.mjs")).href;
const SCOPE = { id: "web-app", env: "staging" };
const cfg = resolveConfig({ suite: "web" }, {});
const row = (title, status, extra = {}) => ({
  full_title: title,
  test_file: "tests/a.spec.ts",
  status,
  retries: 0,
  tags: [],
  duration_ms: 5,
  ...extra,
});
const record = (results, { shard = null, collected, full = "passed", env = CI_ENV } = {}) =>
  toRunRecord(buildPayload(results, cfg, T, env, full, { shard, collected }), {
    scope: SCOPE,
    shard,
    fullResultStatus: full,
    env,
    version: "9.0.0",
  });

async function refusals(doc) {
  const { validateDocument } = await import(VALIDATE);
  return validateDocument(doc, { layer: "run" }).errors;
}

test("crit 5: shards of one workflow run get distinct run ids", () => {
  const a = record([row("a", "passed")], { shard: { current: 1, total: 2 } });
  const b = record([row("a", "passed")], { shard: { current: 2, total: 2 } });
  assert.equal(a.run.id, "42-1-s1of2");
  assert.equal(b.run.id, "42-1-s2of2");
  assert.deepEqual(b.run.shard, { index: 2, total: 2 });
});

test("crit 6: timed_out and interrupted keep their own status and bucket", () => {
  const r = record([
    row("t", "timed_out"),
    row("i", "failed", { tags: ["interrupted"], error_message: "interrupted: the run ended before this test finished" }),
    row("f", "failed"),
  ]);
  assert.deepEqual(
    r.results.map((x) => x.status),
    ["timed_out", "interrupted", "failed"],
  );
  assert.equal(r.totals.timed_out, 1);
  assert.equal(r.totals.interrupted, 1);
  assert.equal(r.totals.failed, 1);
});

test("crit 7: collected is the list, [] for an empty suite, null when not reported", () => {
  assert.deepEqual(
    record([row("a", "passed")], {
      collected: [{ full_title: "a", test_file: "tests/a.spec.ts", tags: [] }],
    }).collected,
    [{ title: "a", file: "tests/a.spec.ts" }],
  );
  assert.deepEqual(record([], { collected: [] }).collected, []);
  assert.equal(record([row("a", "passed")], { collected: null }).collected, null);
});

test("run status: flaky is passed, interrupted and timedout runs are cancelled", () => {
  assert.equal(record([row("a", "flaky")]).run.status, "passed");
  assert.equal(record([row("a", "passed")], { full: "interrupted" }).run.status, "cancelled");
  assert.equal(record([row("a", "passed")], { full: "timedout" }).run.status, "cancelled");
  assert.equal(record([row("a", "failed")], { full: "failed" }).run.status, "failed");
});

test("no invented values: unknown branch, sha and CI url are null; a never-started test is 0 ms", () => {
  const r = record([row("a", "skipped", { duration_ms: undefined })], { env: {} });
  assert.equal(r.run.branch, null);
  assert.equal(r.run.commit_sha, null);
  assert.equal(r.run.ci_url, null);
  assert.equal(r.results[0].duration_ms, 0);
  assert.equal(r.producer.channel, "local");
});

test("every emitted record passes the run contract", async () => {
  const env = {
    ...CI_ENV,
    CI: "true",
    GITHUB_REF_NAME: "main",
    GITHUB_SHA: "abc1234def",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "o/r",
  };
  const r = record([row("a", "failed", { error_message: "boom", area: "cart" }), row("b", "timed_out")], {
    shard: { current: 1, total: 2 },
    env,
    full: "failed",
  });
  assert.deepEqual(await refusals(r), []);
  assert.equal(r.run.ci_url, "https://github.com/o/r/actions/runs/42");
});

test("runFilePath suffixes a sharded run before the extension", () => {
  assert.equal(runFilePath("out/run.json", null), "out/run.json");
  assert.equal(runFilePath("out/run.json", { current: 2, total: 4 }), "out/run-s2of4.json");
  assert.equal(runFilePath("out/run", { current: 1, total: 2 }), "out/run-s1of2");
});

// --- Task 8: onEnd writes the run file ----------------------------------------
const fs = require("node:fs");
const os = require("node:os");
const { fakeTest, fakeResult, runReporter, IngestReporter, REPO } = require("./ingest-harness.js");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "canary-run-"));
}
const scopeOpts = (dir) => ({ runFile: path.join(dir, "run.json"), scopeId: "web-app", scopeEnv: "staging" });

test("onEnd writes a valid canary.run/1 file even when not pushing", async () => {
  const dir = tmp();
  const t = fakeTest({ title: "a" });
  const { pushes } = await runReporter({
    options: { ...scopeOpts(dir), url: "" },
    tests: [[t, fakeResult("passed")]],
  });
  assert.equal(pushes.length, 0);
  const doc = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8"));
  assert.deepEqual(await refusals(doc), []);
  assert.equal(doc.results[0].status, "passed");
});

test("crit 5 end to end: two shards write two files with distinct run ids", async () => {
  const dir = tmp();
  const t = fakeTest({ title: "a" });
  for (const current of [1, 2]) {
    await runReporter({
      options: scopeOpts(dir),
      env: CI_ENV,
      config: { shard: { current, total: 2 }, projects: [] },
      tests: [[t, fakeResult("passed")]],
    });
  }
  const ids = ["run-s1of2.json", "run-s2of2.json"].map(
    (f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).run.id,
  );
  assert.deepEqual(ids, ["42-1-s1of2", "42-1-s2of2"]);
});

test("runFile without a scope writes nothing and says why", async () => {
  const dir = tmp();
  const t = fakeTest({ title: "a" });
  const { logs } = await runReporter({
    options: { runFile: path.join(dir, "run.json") },
    tests: [[t, fakeResult("passed")]],
  });
  assert.equal(fs.existsSync(path.join(dir, "run.json")), false);
  assert.match(logs.join("\n"), /CANARY_SCOPE_ID/);
});

test("the ingest payload is unchanged by runFile", async () => {
  const t = fakeTest({ title: "a" });
  // CI_ENV pins canary_run_id; without GITHUB_RUN_ID it is a random UUID per run.
  const without = (await runReporter({ env: CI_ENV, tests: [[t, fakeResult("passed")]] })).payload;
  const withFile = (
    await runReporter({ env: CI_ENV, options: scopeOpts(tmp()), tests: [[t, fakeResult("passed")]] })
  ).payload;
  assert.deepEqual(withFile, without);
});

// --- security review: stale artifact, symlink write ---------------------------
// A run that writes nothing must not leave the previous run's record looking
// current, and a link planted at the run-file path (a PR can commit one) must
// never be written through.

test("a run that writes nothing removes the previous run's file (fails closed)", async () => {
  const dir = tmp();
  const file = path.join(dir, "run.json");
  fs.writeFileSync(file, '{"stale": true}');
  const t = fakeTest({ title: "a" });
  // Collected but never ran: onEnd returns before writing.
  await runReporter({ options: scopeOpts(dir), collected: [t], tests: [] });
  assert.equal(fs.existsSync(file), false);
});

// Driven hook by hook: onBegin's clearRunFile removes a link planted BEFORE
// the run, so the link must appear after onBegin for the write to meet it.
test("a symlink planted mid-run at the run-file path is replaced, never written through", async () => {
  const dir = tmp();
  const file = path.join(dir, "run.json");
  const target = path.join(dir, "victim.txt");
  fs.writeFileSync(target, "untouched");
  const t = fakeTest({ title: "a" });
  const reporter = new IngestReporter({ suite: "web", url: "", testFilePrefix: REPO, ...scopeOpts(dir) });
  const realLog = console.log;
  console.log = () => {};
  try {
    reporter.onBegin({ shard: null, projects: [] }, { allTests: () => [t], suites: [] });
    fs.symlinkSync(target, file);
    const result = fakeResult("passed");
    t.results.push(result);
    reporter.onTestEnd(t, result);
    await reporter.onEnd({ status: "passed", startTime: new Date("2026-10-05T00:00:00Z"), duration: 60000 });
  } finally {
    console.log = realLog;
  }
  assert.equal(fs.readFileSync(target, "utf8"), "untouched");
  assert.equal(fs.lstatSync(file).isFile(), true);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).contract, "canary.run/1");
});

test("a stale run file is removed even when config fails to resolve, with a warning", async () => {
  const dir = tmp();
  const file = path.join(dir, "run.json");
  fs.writeFileSync(file, '{"stale": true}');
  const t = fakeTest({ title: "a" });
  // CANARY_RUN_FILE set, suite unset, not pushing: resolveConfig throws.
  const { logs } = await runReporter({
    options: { suite: "", url: "" },
    env: { CANARY_RUN_FILE: file },
    tests: [[t, fakeResult("passed")]],
  });
  assert.equal(fs.existsSync(file), false);
  assert.match(logs.join("\n"), /WARNING — disabled — `suite` is required/);
});

test("a user tag `interrupted` does not make a passing test interrupted", () => {
  const r = record([row("p", "passed", { tags: ["interrupted"] }), row("f", "failed", { tags: ["interrupted"], error_message: "boom" })]);
  assert.deepEqual(
    r.results.map((x) => x.status),
    ["passed", "failed"],
  );
  assert.equal(r.totals.interrupted, 0);
});

test("end to end: a real interruption is interrupted, an @interrupted-tagged pass is passed", async () => {
  const dir = tmp();
  const cut = fakeTest({ title: "cut" });
  const tagged = fakeTest({ title: "tagged", tags: ["@interrupted"] });
  await runReporter({
    options: scopeOpts(dir),
    tests: [
      [cut, fakeResult("interrupted")],
      [tagged, fakeResult("passed")],
    ],
  });
  const doc = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8"));
  assert.deepEqual(
    doc.results.map((x) => [x.title.split(" > ").at(-1), x.status]),
    [
      ["cut", "interrupted"],
      ["tagged", "passed"],
    ],
  );
});
