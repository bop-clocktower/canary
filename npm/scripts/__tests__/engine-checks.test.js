const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  isOlder,
  checkVersion,
  checkGit,
  checkOverlays,
  checkProjectConfig,
  checkMcpConfig,
} = require("../../dist/engine-checks.js");
const registry = require("../../dist/overlays-registry.js");

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("isOlder", () => {
  it("compares numeric semver components", () => {
    assert.equal(isOlder("5.8.0", "5.9.0"), true);
    assert.equal(isOlder("5.9.0", "5.8.0"), false);
    assert.equal(isOlder("5.8.0", "5.8.0"), false);
    assert.equal(isOlder("5.8.0", "5.8.1"), true);
    assert.equal(isOlder("4.0.0", "5.0.0"), true);
  });
});

describe("checkVersion", () => {
  it("passes when current equals latest", async () => {
    const r = await checkVersion({ currentVersion: "5.9.0", getLatestVersion: async () => "5.9.0" });
    assert.equal(r.status, "pass");
  });
  it("fails with an upgrade remedy when behind", async () => {
    const r = await checkVersion({ currentVersion: "5.8.0", getLatestVersion: async () => "5.9.0" });
    assert.equal(r.status, "fail");
    assert.match(r.remedy, /npm install -g canary-test-cli@latest/);
  });
  it("degrades to info (not fail) when latest is unknown/offline", async () => {
    const r = await checkVersion({ currentVersion: "5.9.0", getLatestVersion: async () => null });
    assert.equal(r.status, "info");
  });
});

describe("checkGit", () => {
  it("passes when git --version succeeds", () => {
    const r = checkGit({ git: () => ({ status: 0, stdout: "git version 2.44.0", stderr: "" }) });
    assert.equal(r.status, "pass");
  });
  it("fails when git is absent", () => {
    const r = checkGit({ git: () => ({ status: 127, stdout: "", stderr: "not found" }) });
    assert.equal(r.status, "fail");
    assert.match(r.remedy, /PATH/);
  });
});

describe("checkOverlays", () => {
  let home;
  beforeEach(() => {
    home = tmp("canary-eng-home-");
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  function gitStub({ behind = "0", porcelain = "" } = {}) {
    return (args) => {
      if (args[0] === "rev-list") return { status: 0, stdout: behind, stderr: "" };
      if (args[0] === "status") return { status: 0, stdout: porcelain, stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };
  }

  function register(name) {
    const clone = registry.clonePath(name, home);
    fs.mkdirSync(clone, { recursive: true });
    registry.write(
      registry.add(registry.emptyRegistry(), {
        name,
        source: `github:example-org/${name}`,
        ref: null,
        path: clone,
        addedDate: "2026-07-17",
        consent: null,
      }),
      home
    );
    return clone;
  }

  it("reports info when no overlays are registered", () => {
    const rs = checkOverlays({ homeDir: home, git: gitStub() });
    assert.equal(rs.length, 1);
    assert.equal(rs[0].status, "info");
  });

  it("passes a fresh, clean overlay", () => {
    register("example-overlay");
    const rs = checkOverlays({ homeDir: home, git: gitStub({ behind: "0", porcelain: "" }) });
    assert.ok(rs.every((r) => r.status === "pass"), JSON.stringify(rs));
  });

  it("fails freshness when behind and cleanliness when dirty", () => {
    register("example-overlay");
    const rs = checkOverlays({ homeDir: home, git: gitStub({ behind: "3", porcelain: " M SKILL.md" }) });
    const fresh = rs.find((r) => r.id.endsWith(":fresh"));
    const clean = rs.find((r) => r.id.endsWith(":clean"));
    assert.equal(fresh.status, "fail");
    assert.match(fresh.remedy, /overlay update/);
    assert.equal(clean.status, "fail");
  });

  it("fails when the clone dir is missing", () => {
    register("example-overlay");
    fs.rmSync(registry.clonePath("example-overlay", home), { recursive: true, force: true });
    const rs = checkOverlays({ homeDir: home, git: gitStub() });
    assert.ok(rs.some((r) => r.status === "fail" && r.id.endsWith(":present")));
  });
});

describe("checkProjectConfig", () => {
  let cwd;
  beforeEach(() => (cwd = tmp("canary-proj-")));
  afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

  it("skips when there is no .canary/ config", () => {
    assert.equal(checkProjectConfig({ cwd }).status, "skip");
  });
  it("passes on valid company.json", () => {
    fs.mkdirSync(path.join(cwd, ".canary"));
    fs.writeFileSync(path.join(cwd, ".canary", "company.json"), '{"a":1}');
    assert.equal(checkProjectConfig({ cwd }).status, "pass");
  });
  it("fails on malformed company.json", () => {
    fs.mkdirSync(path.join(cwd, ".canary"));
    fs.writeFileSync(path.join(cwd, ".canary", "company.json"), "{ not json");
    const r = checkProjectConfig({ cwd });
    assert.equal(r.status, "fail");
    assert.match(r.remedy, /company\.json/);
  });
});

describe("checkMcpConfig", () => {
  let cwd, home;
  beforeEach(() => {
    cwd = tmp("canary-mcp-cwd-");
    home = tmp("canary-mcp-home-");
  });
  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("skips when no .mcp.json is present", () => {
    assert.equal(checkMcpConfig({ cwd, homeDir: home }).status, "skip");
  });
  it("passes on a well-formed .mcp.json", () => {
    fs.writeFileSync(path.join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { harness: { command: "npx" } } }));
    assert.equal(checkMcpConfig({ cwd, homeDir: home }).status, "pass");
  });
  it("fails on malformed JSON", () => {
    fs.writeFileSync(path.join(cwd, ".mcp.json"), "{ nope");
    assert.equal(checkMcpConfig({ cwd, homeDir: home }).status, "fail");
  });
  it("fails when a server entry has neither command nor url", () => {
    fs.writeFileSync(path.join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { bad: {} } }));
    const r = checkMcpConfig({ cwd, homeDir: home });
    assert.equal(r.status, "fail");
    assert.match(r.remedy, /neither a command nor a url/);
  });
});
