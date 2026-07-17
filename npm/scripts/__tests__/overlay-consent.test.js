const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { add } = require("../../dist/overlay-commands.js");
const registry = require("../../dist/overlays-registry.js");
const { commandSucceedsHash, loadManifest } = require("../../dist/doctor-manifest.js");

/**
 * A local bare-repo "source" whose working tree ships a doctor.json — so
 * `overlay add` clones it (no network) and reads the manifest for consent.
 */
function makeSourceRepo(manifest) {
  const { execFileSync } = require("node:child_process");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "canary-src-work-"));
  const run = (args) => execFileSync("git", args, { cwd: work, stdio: "pipe" });
  run(["init", "--quiet"]);
  run(["config", "user.email", "t@e.com"]);
  run(["config", "user.name", "t"]);
  fs.mkdirSync(path.join(work, ".canary"), { recursive: true });
  if (manifest !== null) {
    fs.writeFileSync(path.join(work, ".canary", "doctor.json"), JSON.stringify(manifest));
  }
  fs.writeFileSync(path.join(work, "README.md"), "x");
  run(["add", "-A"]);
  run(["commit", "--quiet", "-m", "init"]);
  return work;
}

let home, src;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "canary-consent-home-"));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  if (src) fs.rmSync(src, { recursive: true, force: true });
  src = null;
});

const CMD_MANIFEST = {
  checks: [{ id: "build", type: "command-succeeds", command: ["npm", "run", "build"], remedy: "install deps" }],
};

function addFrom(src, confirm) {
  return add(src, {}, { homeDir: home, out: { write() {} }, err: { write() {} }, now: () => "2026-07-17", confirm });
}

describe("overlay add — consent gate", () => {
  it("records consent:true + a hash when the user accepts command checks", () => {
    src = makeSourceRepo(CMD_MANIFEST);
    assert.equal(addFrom(src, () => true), 0);
    const entry = registry.read(home).overlays[0];
    assert.equal(entry.consent, true);
    assert.equal(typeof entry.consentCommandsHash, "string");
  });

  it("records consent:false when the user declines", () => {
    src = makeSourceRepo(CMD_MANIFEST);
    assert.equal(addFrom(src, () => false), 0);
    const entry = registry.read(home).overlays[0];
    assert.equal(entry.consent, false);
    assert.equal(typeof entry.consentCommandsHash, "string");
  });

  it("records consent:null when the overlay ships no command checks", () => {
    src = makeSourceRepo({ checks: [{ id: "f", type: "file-exists", path: "README.md", remedy: "r" }] });
    let prompted = false;
    assert.equal(addFrom(src, () => ((prompted = true), true)), 0);
    const entry = registry.read(home).overlays[0];
    assert.equal(entry.consent, null);
    assert.equal(entry.consentCommandsHash, null);
    assert.equal(prompted, false, "must not prompt when there are no command checks");
  });

  it("records consent:null when there is no manifest at all", () => {
    src = makeSourceRepo(null);
    assert.equal(addFrom(src, () => true), 0);
    const entry = registry.read(home).overlays[0];
    assert.equal(entry.consent, null);
    assert.equal(entry.consentCommandsHash, null);
  });
});

describe("consentGranted predicate", () => {
  const hash = commandSucceedsHash(CMD_MANIFEST.checks);

  it("is true only when consent granted AND the live hash matches", () => {
    const entry = { consent: true, consentCommandsHash: hash };
    assert.equal(registry.consentGranted(entry, hash), true);
  });
  it("is false when the manifest command set changed (hash mismatch)", () => {
    const entry = { consent: true, consentCommandsHash: hash };
    const changed = commandSucceedsHash([
      { id: "build", type: "command-succeeds", command: ["npm", "test"], remedy: "r" },
    ]);
    assert.equal(registry.consentGranted(entry, changed), false);
  });
  it("is false when consent was declined", () => {
    assert.equal(registry.consentGranted({ consent: false, consentCommandsHash: hash }, hash), false);
  });
});
