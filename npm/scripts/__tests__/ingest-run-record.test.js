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
  const r = record([row("t", "timed_out"), row("i", "failed", { tags: ["interrupted"] }), row("f", "failed")]);
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
