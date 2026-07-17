const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { route } = require("../../dist/router.js");
const registry = require("../../dist/overlays-registry.js");

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}
function initSourceRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "t@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
  fs.writeFileSync(path.join(dir, "README.md"), "x\n");
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "init"], dir);
}
function collector() {
  let t = "";
  return { write: (s) => (t += s), get: () => t };
}

let home, source;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "canary-route-home-"));
  source = fs.mkdtempSync(path.join(os.tmpdir(), "canary-route-src-"));
  initSourceRepo(source);
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(source, { recursive: true, force: true });
});

describe("route() overlay dispatch", () => {
  const deps = () => ({ homeDir: home, out: collector(), err: collector() });

  it("returns null for a non-TS command (falls through to the binary)", () => {
    assert.equal(route(["skills", "list"], deps()), null);
    assert.equal(route([], deps()), null);
  });

  it("dispatches 'overlay add --ref' and records the ref", () => {
    const d = deps();
    const code = route(["overlay", "add", source, "--ref", "main"], d);
    assert.equal(code, 0);
    const entry = registry.get(registry.read(home), path.basename(source));
    assert.equal(entry.ref, "main");
  });

  it("supports --ref=value syntax", () => {
    const code = route(["overlay", "add", source, "--ref=main"], deps());
    assert.equal(code, 0);
    assert.equal(registry.get(registry.read(home), path.basename(source)).ref, "main");
  });

  it("dispatches list / update / remove", () => {
    route(["overlay", "add", source], deps());
    assert.equal(route(["overlay", "list"], deps()), 0);
    assert.equal(route(["overlay", "update", path.basename(source)], deps()), 0);
    assert.equal(route(["overlay", "remove", path.basename(source)], deps()), 0);
  });

  it("errors on missing args and unknown subcommands", () => {
    assert.equal(route(["overlay"], deps()), 1);
    assert.equal(route(["overlay", "bogus"], deps()), 1);
    assert.equal(route(["overlay", "add"], deps()), 1);
    assert.equal(route(["overlay", "remove"], deps()), 1);
  });
});
