// Uses Node.js built-in test runner (node --test), no extra deps.
const { describe, it, mock, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

// We test the pure functions extracted from install.js
const { getPlatformKey, getBinaryName, getDownloadUrl } = require("../install.js");

describe("getPlatformKey", () => {
  it("returns linux-x64 on linux x64", () => {
    assert.equal(getPlatformKey("linux", "x64"), "linux-x64");
  });
  it("returns darwin-arm64 on macOS arm64", () => {
    assert.equal(getPlatformKey("darwin", "arm64"), "darwin-arm64");
  });
  it("returns win32-x64 on Windows x64", () => {
    assert.equal(getPlatformKey("win32", "x64"), "win32-x64");
  });
  it("throws on unsupported platform", () => {
    assert.throws(
      () => getPlatformKey("freebsd", "x64"),
      /Unsupported platform/
    );
  });
});

describe("getBinaryName", () => {
  it("appends .exe on windows", () => {
    assert.equal(getBinaryName("win32-x64"), "canary-win32-x64.exe");
  });
  it("no extension on unix", () => {
    assert.equal(getBinaryName("linux-x64"), "canary-linux-x64");
  });
});

describe("getDownloadUrl", () => {
  it("builds the correct GitHub release asset URL", () => {
    const url = getDownloadUrl("5.0.0", "canary-linux-x64");
    assert.equal(
      url,
      "https://github.com/bop-clocktower/canary/releases/download/v5.0.0/canary-linux-x64"
    );
  });
});
