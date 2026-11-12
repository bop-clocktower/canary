// #1321: the Playwright ingest reporter publishes quarantine state from the
// katana ledger (`quarantineLedger` / CANARY_INGEST_QUARANTINE_LEDGER).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fakeTest, fakeResult, runReporter } = require("./ingest-harness.js");

function ledger(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-ledger-"));
  const file = path.join(dir, "quarantine.json");
  fs.writeFileSync(file, JSON.stringify({ schema_version: 2, entries }));
  return file;
}

const quarantineTags = (r) => r.tags.filter((t) => t === "quarantined" || t.startsWith("quarantine:"));
const byTitle = (payload, title) => payload.results.find((r) => r.full_title.endsWith(title));

function skippedRun() {
  const skipped = fakeTest({ title: "checkout total", describes: ["cart"], expectedStatus: "skipped" });
  const other = fakeTest({ title: "checkout total", file: "tests/b.spec.ts", expectedStatus: "skipped" });
  const passed = fakeTest({ title: "adds" });
  return [
    [skipped, fakeResult("skipped")],
    [other, fakeResult("skipped")],
    [passed, fakeResult("passed")],
  ];
}

test("option: a skip with a matching ledger row is tagged; same title elsewhere is not", async () => {
  const file = ledger([{ test: "checkout total", file: "tests/a.spec.ts", kind: "skipped", issue: "#77" }]);
  const { payload, logs } = await runReporter({ options: { quarantineLedger: file }, tests: skippedRun() });
  assert.deepEqual(quarantineTags(byTitle(payload, "tests/a.spec.ts > cart > checkout total")), ["quarantined", "quarantine:#77"]);
  assert.deepEqual(quarantineTags(byTitle(payload, "tests/b.spec.ts > checkout total")), []);
  assert.deepEqual(quarantineTags(byTitle(payload, "adds")), []);
  assert.ok(logs.some((l) => /quarantine: 1 skipped result tagged from 1 ledger row/.test(l)), logs.join("\n"));
});

test("env: CANARY_INGEST_QUARANTINE_LEDGER works like the option, and unmatched rows are logged", async () => {
  const file = ledger([
    { test: "checkout total", file: "tests/a.spec.ts", kind: "skipped", issue: "#77" },
    { test: "vanished", file: "tests/a.spec.ts", kind: "skipped", issue: "#78" },
  ]);
  const { payload, logs } = await runReporter({ env: { CANARY_INGEST_QUARANTINE_LEDGER: file }, tests: skippedRun() });
  assert.equal(quarantineTags(byTitle(payload, "tests/a.spec.ts > cart > checkout total")).length, 2);
  assert.ok(logs.some((l) => /1 ledger row matched no skipped result: tests\/a\.spec\.ts › vanished/.test(l)), logs.join("\n"));
});

test("a missing ledger warns loudly and still pushes, untagged", async () => {
  const missing = path.join(os.tmpdir(), "no-such-dir-1321", "quarantine.json");
  const { pushes, payload, logs } = await runReporter({
    options: { quarantineLedger: missing },
    env: { GITHUB_ACTIONS: "true" },
    tests: skippedRun(),
  });
  assert.equal(pushes.length, 1);
  assert.ok(logs.some((l) => /::warning title=canary ingest::quarantine ledger .*not found/.test(l)), logs.join("\n"));
  assert.ok(payload.results.every((r) => quarantineTags(r).length === 0));
});

test("clean titles: skipped in one project, run in another, is not published as a quarantine", async () => {
  const file = ledger([{ test: "checkout total", file: "tests/a.spec.ts", kind: "skipped", issue: "#9" }]);
  const webkit = fakeTest({ title: "checkout total", project: "webkit", expectedStatus: "skipped" });
  const chromium = fakeTest({ title: "checkout total", project: "chromium" });
  const { payload, logs } = await runReporter({
    options: { quarantineLedger: file, titleFormat: "clean" },
    tests: [
      [webkit, fakeResult("skipped")],
      [chromium, fakeResult("passed")],
    ],
  });
  const merged = byTitle(payload, "checkout total");
  assert.equal(merged.status, "passed");
  assert.deepEqual(quarantineTags(merged), []);
  assert.ok(logs.some((l) => /1 ledger row matched no skipped result/.test(l)), logs.join("\n"));
});

test("the catalog carries no quarantine tags: only results do", async () => {
  const file = ledger([{ test: "checkout total", file: "tests/a.spec.ts", kind: "skipped", issue: "#77" }]);
  const { payload } = await runReporter({ options: { quarantineLedger: file }, tests: skippedRun() });
  assert.ok(payload.collected.every((c) => quarantineTags(c).length === 0));
});

// #1588: which katana reader the compiled module loads. The built ingest
// directory is copied into a temp layout beside a stub `ledger.mjs` whose
// row's issue names the copy it came from.
const LEDGER_PARTS = ["agents", "skills", "claude-code", "canary-katana", "scripts", "ledger.mjs"];

function stubReader(root, who) {
  const file = path.join(root, ...LEDGER_PARTS);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const row = { test: "t", file: "a.spec.ts", kind: "skipped", issue: who };
  fs.writeFileSync(file, `export function load() { return { entries: [${JSON.stringify(row)}] }; }\n`);
}

async function readerUsed(pkg) {
  const ingest = path.join(pkg, "dist", "reporters", "ingest");
  fs.cpSync(path.join(__dirname, "..", "..", "dist", "reporters", "ingest"), ingest, { recursive: true });
  const file = path.join(pkg, "quarantine.json");
  fs.writeFileSync(file, "{}");
  const { quarantineResults } = require(path.join(ingest, "quarantine.js"));
  const skip = { full_title: "a.spec.ts > t", test_file: "a.spec.ts", status: "skipped", retries: 0, tags: [] };
  const { results } = await quarantineResults(file, [skip]);
  return results[0].tags.find((t) => t.startsWith("quarantine:"));
}

test("checkout: the repo's agents/skills wins over a stale staged npm/agents copy", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-checkout-"));
  fs.mkdirSync(path.join(repo, ".git"));
  stubReader(repo, "repo");
  stubReader(path.join(repo, "npm"), "staged");
  assert.equal(await readerUsed(path.join(repo, "npm")), "quarantine:repo");
});

test("published package: the bundled <pkg>/agents/skills is used", async () => {
  const consumer = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-published-"));
  fs.mkdirSync(path.join(consumer, ".git"));
  const pkg = path.join(consumer, "node_modules", "canary-test-cli");
  stubReader(pkg, "bundled");
  stubReader(path.dirname(pkg), "decoy"); // no `.git` beside it: not a checkout
  assert.equal(await readerUsed(pkg), "quarantine:bundled");
});
