const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runCheck } = require("../../dist/doctor-manifest.js");

let clone;
beforeEach(() => (clone = fs.mkdtempSync(path.join(os.tmpdir(), "canary-run-"))));
afterEach(() => fs.rmSync(clone, { recursive: true, force: true }));

const ctx = (over = {}) => ({ cloneDir: clone, consentGranted: false, ...over });

describe("runCheck: file-exists", () => {
  it("passes when the file exists (relative to clone)", async () => {
    fs.writeFileSync(path.join(clone, "present.txt"), "x");
    const r = await runCheck({ id: "f", type: "file-exists", path: "present.txt", remedy: "add it" }, ctx());
    assert.equal(r.status, "pass");
  });
  it("fails with the manifest remedy when missing", async () => {
    const r = await runCheck({ id: "f", type: "file-exists", path: "nope.txt", remedy: "add it" }, ctx());
    assert.equal(r.status, "fail");
    assert.equal(r.remedy, "add it");
  });
});

describe("runCheck: url-reachable", () => {
  it("passes on a reachable URL (stubbed probe)", async () => {
    const r = await runCheck({ id: "u", type: "url-reachable", url: "https://e.com", remedy: "access" }, ctx({ probeUrl: async () => true }));
    assert.equal(r.status, "pass");
  });
  it("fails when the probe returns false (unreachable/timeout)", async () => {
    const r = await runCheck({ id: "u", type: "url-reachable", url: "https://e.com", remedy: "access" }, ctx({ probeUrl: async () => false }));
    assert.equal(r.status, "fail");
    assert.equal(r.remedy, "access");
  });
  it("honors the timeout value passed to the probe", async () => {
    let seen;
    await runCheck(
      { id: "u", type: "url-reachable", url: "https://e.com", remedy: "r" },
      ctx({ timeoutMs: 1234, probeUrl: async (_url, t) => ((seen = t), true) })
    );
    assert.equal(seen, 1234);
  });
});

describe("runCheck: command-succeeds", () => {
  const check = { id: "c", type: "command-succeeds", command: ["npm", "run", "x"], remedy: "install deps" };

  it("is SKIPPED (not failed) without consent, and never runs the command", async () => {
    let ran = false;
    const r = await runCheck(check, ctx({ consentGranted: false, runCommand: () => ((ran = true), { ok: true, timedOut: false }) }));
    assert.equal(r.status, "skip");
    assert.equal(ran, false);
  });
  it("passes when the command exits 0 (with consent)", async () => {
    const r = await runCheck(check, ctx({ consentGranted: true, runCommand: () => ({ ok: true, timedOut: false }) }));
    assert.equal(r.status, "pass");
  });
  it("fails on non-zero exit", async () => {
    const r = await runCheck(check, ctx({ consentGranted: true, runCommand: () => ({ ok: false, timedOut: false, detail: "exit 1" }) }));
    assert.equal(r.status, "fail");
    assert.equal(r.remedy, "install deps");
  });
  it("fails with a timeout label when the command is killed", async () => {
    const r = await runCheck(check, ctx({ consentGranted: true, timeoutMs: 50, runCommand: () => ({ ok: false, timedOut: true }) }));
    assert.equal(r.status, "fail");
    assert.match(r.label, /timed out after 50ms/);
  });
});
