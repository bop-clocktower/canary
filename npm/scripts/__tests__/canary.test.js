const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { getBinaryPath } = require("../../bin/canary.js");

describe("getBinaryPath", () => {
  it("returns path ending in canary on unix", () => {
    const p = getBinaryPath("linux");
    assert.ok(p.endsWith("canary"), `expected path to end with 'canary', got ${p}`);
  });
  it("returns path ending in canary.exe on windows", () => {
    const p = getBinaryPath("win32");
    assert.ok(p.endsWith("canary.exe"), `expected 'canary.exe', got ${p}`);
  });
  it("returned path is inside the bin/ directory", () => {
    const p = getBinaryPath("linux");
    assert.ok(p.includes(`${path.sep}bin${path.sep}`));
  });
});
