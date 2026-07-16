const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { parseSource, SourceSpecError } = require("../../dist/source-spec.js");

describe("parseSource — github: shorthand", () => {
  const cases = [
    ["github:example-org/example-overlay", "https://github.com/example-org/example-overlay.git", "example-org-example-overlay"],
    ["github:example-org/example-overlay.git", "https://github.com/example-org/example-overlay.git", "example-org-example-overlay"],
  ];
  for (const [input, cloneUrl, name] of cases) {
    it(`${input} → ${name}`, () => {
      assert.deepEqual(parseSource(input), { cloneUrl, name });
    });
  }
});

describe("parseSource — full URLs", () => {
  it("https URL passthrough, name from last two segments", () => {
    assert.deepEqual(parseSource("https://github.com/example-org/example-overlay.git"), {
      cloneUrl: "https://github.com/example-org/example-overlay.git",
      name: "example-org-example-overlay",
    });
  });
  it("scp-style git@ URL passthrough", () => {
    assert.deepEqual(parseSource("git@github.com:example-org/example-overlay.git"), {
      cloneUrl: "git@github.com:example-org/example-overlay.git",
      name: "example-org-example-overlay",
    });
  });
  it("ssh:// URL", () => {
    assert.deepEqual(parseSource("ssh://git@example.com/example-org/example-overlay"), {
      cloneUrl: "ssh://git@example.com/example-org/example-overlay",
      name: "example-org-example-overlay",
    });
  });
});

describe("parseSource — local paths", () => {
  it("absolute path → basename", () => {
    assert.deepEqual(parseSource("/tmp/example-overlay"), {
      cloneUrl: "/tmp/example-overlay",
      name: "example-overlay",
    });
  });
  it("relative path → basename", () => {
    assert.deepEqual(parseSource("./fixtures/example-overlay.git"), {
      cloneUrl: "./fixtures/example-overlay.git",
      name: "example-overlay",
    });
  });
});

describe("parseSource — rejections", () => {
  for (const bad of ["", "   ", "github:only-owner", "github:a/b/c", "not-a-source", "https://"]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      assert.throws(() => parseSource(bad), SourceSpecError);
    });
  }
});
