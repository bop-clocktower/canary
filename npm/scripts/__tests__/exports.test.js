const test = require("node:test");
const assert = require("node:assert/strict");

// Validates the package "exports" map: consumers load the reporter as
// `canary-test-cli/reporter`. Node self-referencing resolves the package's own
// name against its exports, so this exercises the real consumer resolution path.
test("canary-test-cli/reporter resolves via the exports map", () => {
  const resolved = require.resolve("canary-test-cli/reporter");
  assert.match(resolved, /dist[\\/]reporters[\\/]testtracker\.js$/);
  const mod = require(resolved);
  assert.equal(typeof mod.default, "function", "default export is the Reporter class");
  for (const name of ["mapStatus", "resolveConfig", "buildPayload", "shouldPush"]) {
    assert.equal(typeof mod[name], "function", `named export ${name}`);
  }
});
